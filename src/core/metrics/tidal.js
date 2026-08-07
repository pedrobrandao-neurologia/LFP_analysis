/* metrics/tidal.js — TIDAL-DT: Timeline-Derived Automated Limits for Dual Threshold
   ------------------------------------------------------------------------------
   O QUE CALCULA. Propõe, de forma auditável, os limiares inferior e superior de
   LFP para o modo dual threshold do aDBS BrainSense (Percept PC/RC), derivados
   do BrainSense Timeline (DiagnosticData.LFPTrendLogs — médias de 10 min em
   unidades LFP nativas). Pipeline: (1) limpeza robusta (Hampel + exclusão de
   dias), (2) segmentação vigília/sono sem actigrafia (cosinor 24+12 h +
   change-point), (3) decomposição de estados por mistura gaussiana com seleção
   por BIC e d de Ashman, (4) simulação offline do controlador dual threshold.

   REFERÊNCIAS (citadas na UI e no relatório):
   - Busch et al., npj Parkinsons Dis 2025, doi:10.1038/s41531-025-01124-7 —
     método de referência manual: percentis 25/75 do beta diurno do Timeline;
     streaming de consultório NÃO representa o beta de longo prazo.
   - van Rheede et al., npj Parkinsons Dis 2022, doi:10.1038/s41531-022-00350-7
     e Yin et al., Nat Commun 2023, doi:10.1038/s41467-023-41128-6 — a hora do
     dia explica ~41% da variância do beta; o histograma deve excluir o sono.
   - ADAPT-START, npj Parkinsons Dis 2026, doi:10.1038/s41531-026-01269-z —
     dias não representativos devem ser excluídos; mínimo de 3–5 dias.
   - Stanslaski et al., npj Parkinsons Dis 2024, doi:10.1038/s41531-024-00772-5
     — dinâmica do controlador (incremento >1,2 s acima do limiar, rampas de
     ~2,5/5 min, passos 0,1 mA PC / 0,01 mA RC). Como o Timeline tem resolução
     de 10 min, a simulação opera nessa granularidade e DECLARA a limitação.

   UNIDADES. Entrada em LFP nativo; todo o processamento em x = log10(LFP+1);
   os limiares voltam para unidades nativas por 10^x − 1, arredondados a
   inteiro. Ferramenta de apoio à decisão — não é dispositivo médico.        */

import { cosinor } from '../stats/circadian.js';
import { mean, median, quantile, rnd } from '../stats/descriptive.js';
import { localHour, localDayKey } from '../io/parse.js';

export const TIDAL_VERSION = '1.0';

export const TIDAL_REFS = [
  { key: 'busch2025', doi: '10.1038/s41531-025-01124-7', note: 'manual 25/75 diurnal percentile method; in-clinic streaming is not representative of chronic beta' },
  { key: 'vanrheede2022', doi: '10.1038/s41531-022-00350-7', note: 'time of day explains ~41% of beta variance; exclude sleep' },
  { key: 'yin2023', doi: '10.1038/s41467-023-41128-6', note: 'sleep-related beta decrease in chronic recordings' },
  { key: 'adaptstart2026', doi: '10.1038/s41531-026-01269-z', note: 'exclude non-representative days; ≥3–5 days of Timeline' },
  { key: 'stanslaski2024', doi: '10.1038/s41531-024-00772-5', note: 'controller dynamics: >1.2 s trigger, ~2.5/5 min ramps, 0.1/0.01 mA steps' }
];

export const TIDAL_DISCLAIMER =
  'Decision-support tool. Proposed thresholds require clinician review, in-clinic confirmation and ' +
  'iterative refinement based on clinical response. Not a medical device.';

export const TIDAL_DEFAULTS = {
  hampelWindow: 12,          /* amostras (~2 h a 10 min) */
  hampelK: 3,                /* limiar em múltiplos de 1,4826·MAD */
  minValidDayFrac: 0.70,     /* dia com <70% das 144 amostras é excluído */
  maxRejectedDayFrac: 0.20,  /* dia com >20% de pontos rejeitados é excluído */
  minDays: 3,                /* ADAPT-START: <3 dias bloqueia a proposta */
  cosinorR2Floor: 0.10,      /* abaixo disso, janela fixa 08:00–22:00 */
  fallbackWake: [8, 22],
  ashmanMin: 2,              /* d de Ashman mínimo para aceitar bimodalidade */
  fallbackPercentiles: [30, 70],
  targets: { below: 20, within: 60, above: 20 },
  accept: { below: [10, 35], within: [45, 75], above: [10, 35] },
  stepPC: 0.1, stepRC: 0.01, /* mA por passo do controlador */
  autoTuneSpanPct: 15, autoTuneStepPct: 1
};

/* ========================================================================= */
/*  Etapa 1 — pré-processamento robusto                                      */
/* ========================================================================= */

/* hampelFilter(xs, opts) — filtro de Hampel deslizante sobre uma série (com
   NaN tolerado). Janela CENTRADA de `window` amostras (i−h .. i+h−1, h=w/2);
   ponto com |x − mediana| > k·1,4826·MAD é marcado artefato. MAD zero (trecho
   constante) não rejeita nada: sem dispersão local não há evidência de
   artefato, e rejeitar tudo seria o contrário do que o filtro promete.      */
export function hampelFilter(xs, opts) {
  const o = opts || {};
  const w = Math.max(4, Math.round(o.window || TIDAL_DEFAULTS.hampelWindow));
  const k = isFinite(o.k) && o.k > 0 ? o.k : TIDAL_DEFAULTS.hampelK;
  const h = Math.floor(w / 2);
  const n = xs.length;
  const artifact = new Uint8Array(n);
  const out = new Float64Array(n);
  let nRejected = 0, nFinite = 0;
  for (let i = 0; i < n; i++) {
    const v = xs[i];
    out[i] = v;
    if (!isFinite(v)) continue;
    nFinite++;
    const win = [];
    for (let j = Math.max(0, i - h); j < Math.min(n, i + h); j++) if (isFinite(xs[j])) win.push(xs[j]);
    if (win.length < 4) continue;
    const med = median(win);
    const madv = 1.4826 * median(win.map(x => Math.abs(x - med)));
    if (madv <= 1e-12) continue;
    if (Math.abs(v - med) > k * madv) { artifact[i] = 1; out[i] = NaN; nRejected++; }
  }
  return { x: out, artifact, nRejected, nFinite, params: { window: w, k } };
}

/* auditDays(rows, artifact, offMin, opts) — contabilidade por dia civil local.
   Exclui dias com poucas amostras válidas ou com rejeição alta; a lista de
   dias excluídos (com o motivo) vai para o relatório — exclusão silenciosa é
   proibida pelo contrato do projeto.                                        */
export function auditDays(rows, artifact, offMin, opts) {
  const o = opts || {};
  const minValid = isFinite(o.minValidDayFrac) ? o.minValidDayFrac : TIDAL_DEFAULTS.minValidDayFrac;
  const maxRej = isFinite(o.maxRejectedDayFrac) ? o.maxRejectedDayFrac : TIDAL_DEFAULTS.maxRejectedDayFrac;
  const porDia = new Map();
  rows.forEach((r, i) => {
    const dk = localDayKey(r.t, offMin);
    if (!porDia.has(dk)) porDia.set(dk, { present: 0, valid: 0, rejected: 0 });
    const d = porDia.get(dk);
    d.present++;
    if (isFinite(r.x0)) { d.valid++; if (artifact[i]) d.rejected++; }
  });
  const used = [], excluded = [];
  Array.from(porDia.keys()).sort().forEach(dk => {
    const d = porDia.get(dk);
    const fracValid = d.valid / 144;                       /* 144 = amostras de 10 min num dia */
    const fracRej = d.valid ? d.rejected / d.valid : 0;
    if (fracValid < minValid) excluded.push({ day: dk, reason: `only ${(100 * fracValid).toFixed(0)}% of samples present (<${100 * minValid}%)` });
    else if (fracRej > maxRej) excluded.push({ day: dk, reason: `${(100 * fracRej).toFixed(0)}% of samples rejected as artifact (>${100 * maxRej}%)` });
    else used.push(dk);
  });
  return { used, excluded, params: { minValidDayFrac: minValid, maxRejectedDayFrac: maxRej } };
}

/* ========================================================================= */
/*  Etapa 2 — vigília/sono sem actigrafia                                    */
/* ========================================================================= */

export function fitCosinor(hours, xs) {
  const fit = cosinor(hours, xs, [24, 12]);
  if (!fit) return null;
  const b = fit.components;
  const at = h => fit.mesor +
    b[0].beta * Math.cos(2 * Math.PI * h / 24) + b[0].gamma * Math.sin(2 * Math.PI * h / 24) +
    b[1].beta * Math.cos(2 * Math.PI * h / 12) + b[1].gamma * Math.sin(2 * Math.PI * h / 12);
  return { mesor: fit.mesor, r2: fit.r2, components: b, at };
}

/* change-point de um corte, custo de soma de quadrados, penalidade BIC.
   Devolve o índice do corte dentro do trecho, ou −1 se o corte não compensa. */
function changePoint1(seg) {
  const n = seg.length;
  if (n < 6) return -1;
  const m = mean(seg);
  const sse1 = seg.reduce((a, v) => a + (v - m) * (v - m), 0);
  let best = -1, bestSse = Infinity;
  for (let c = 2; c <= n - 2; c++) {
    const a = seg.slice(0, c), b = seg.slice(c);
    const ma = mean(a), mb = mean(b);
    const sse = a.reduce((s, v) => s + (v - ma) * (v - ma), 0) + b.reduce((s, v) => s + (v - mb) * (v - mb), 0);
    if (sse < bestSse) { bestSse = sse; best = c; }
  }
  /* aceita o corte só se o BIC melhorar (2 parâmetros extras: média e posição) */
  const bic1 = n * Math.log(Math.max(sse1, 1e-12) / n);
  const bic2 = n * Math.log(Math.max(bestSse, 1e-12) / n) + 2 * Math.log(n);
  return bic2 < bic1 ? best : -1;
}

/* detectWakeWindow(rows, offMin, opts)
   rows: [{t, x}] já limpos. Vigília provisória = maior trecho circular em que
   a curva circadiana ajustada fica acima da mesor; bordas refinadas por
   change-point no perfil médio por bin de 10 min, em ±3 h de cada transição.
   Fallback declarado (R² < 0,1): janela fixa 08:00–22:00.                   */
export function detectWakeWindow(rows, offMin, opts) {
  const o = opts || {};
  const floorR2 = isFinite(o.cosinorR2Floor) ? o.cosinorR2Floor : TIDAL_DEFAULTS.cosinorR2Floor;
  const fb = o.fallbackWake || TIDAL_DEFAULTS.fallbackWake;
  const hs = rows.map(r => localHour(r.t, offMin));
  const xs = rows.map(r => r.x);
  const fit = fitCosinor(hs, xs);
  if (!fit || !isFinite(fit.r2) || fit.r2 < floorR2) {
    return { wake: fb.slice(), method: 'fallback fixed 08:00-22:00 (weak circadian fit)', r2: fit ? fit.r2 : NaN, refined: false };
  }
  /* maior trecho circular acima da mesor, avaliado a cada 10 min */
  const nb = 144;
  const above = [];
  for (let i = 0; i < nb; i++) above.push(fit.at(i / 6 + 1 / 12) > fit.mesor ? 1 : 0);
  let bestStart = -1, bestLen = 0;
  for (let s = 0; s < nb; s++) {
    if (!above[s] || above[(s + nb - 1) % nb]) continue;   /* início de trecho */
    let len = 0; while (len < nb && above[(s + len) % nb]) len++;
    if (len > bestLen) { bestLen = len; bestStart = s; }
  }
  if (bestStart < 0 || bestLen === 0 || bestLen === nb) {
    return { wake: fb.slice(), method: 'fallback fixed 08:00-22:00 (no circadian trough)', r2: fit.r2, refined: false };
  }
  let wakeStart = bestStart / 6, wakeEnd = ((bestStart + bestLen) % nb) / 6;

  /* refino por change-point sobre o perfil médio por bin */
  const prof = new Float64Array(nb), cnt = new Float64Array(nb);
  rows.forEach(r => {
    if (!isFinite(r.x)) return;
    const b = Math.min(nb - 1, Math.floor(localHour(r.t, offMin) * 6));
    prof[b] += r.x; cnt[b]++;
  });
  const p = Array.from(prof, (v, i) => cnt[i] ? v / cnt[i] : NaN);
  const refina = (horaProv) => {
    const c0 = Math.round(horaProv * 6);
    const seg = [];
    for (let j = c0 - 18; j <= c0 + 18; j++) {           /* ±3 h */
      const v = p[((j % nb) + nb) % nb];
      if (isFinite(v)) seg.push(v);
    }
    const cp = changePoint1(seg);
    if (cp < 0) return horaProv;
    return ((((c0 - 18 + cp) % nb) + nb) % nb) / 6;
  };
  wakeStart = refina(wakeStart);
  wakeEnd = refina(wakeEnd);
  return { wake: [+wakeStart.toFixed(2), +wakeEnd.toFixed(2)], method: 'cosinor (24+12 h) + change-point refinement', r2: fit.r2, mesor: fit.mesor, refined: true, fit };
}

export function inWake(h, wake) {
  const [a, b] = wake;
  return a < b ? (h >= a && h < b) : (h >= a || h < b);
}

/* ========================================================================= */
/*  Etapa 3 — GMM univariada (EM) e proposta de limiares                     */
/* ========================================================================= */

const LN2PI = Math.log(2 * Math.PI);
const logNorm = (x, mu, s2) => -0.5 * (LN2PI + Math.log(s2) + (x - mu) * (x - mu) / s2);

/* fitGMM1D(xs, k) — mistura gaussiana univariada via EM, inicialização
   DETERMINÍSTICA por k-means 1D com centros nos quartis. Sem sorteio: o mesmo
   dado produz sempre o mesmo ajuste, que é o que a auditoria exige.         */
export function fitGMM1D(xs, k) {
  const x = Array.prototype.filter.call(xs, isFinite);
  const n = x.length;
  if (n < 10) return null;
  if (k === 1) {
    const mu = mean(x);
    const s2 = Math.max(1e-8, x.reduce((a, v) => a + (v - mu) * (v - mu), 0) / n);
    const ll = x.reduce((a, v) => a + logNorm(v, mu, s2), 0);
    return { k: 1, weights: [1], means: [mu], sigmas: [Math.sqrt(s2)], logLik: ll, bic: -2 * ll + 2 * Math.log(n), converged: true, iters: 0 };
  }
  /* k-means 1D determinístico */
  let c1 = quantile(x, 0.25), c2 = quantile(x, 0.75);
  if (!(c2 > c1)) c2 = c1 + 1e-6;
  for (let it = 0; it < 50; it++) {
    let s1 = 0, n1 = 0, s2s = 0, n2 = 0;
    for (const v of x) { if (Math.abs(v - c1) <= Math.abs(v - c2)) { s1 += v; n1++; } else { s2s += v; n2++; } }
    if (!n1 || !n2) break;
    const nc1 = s1 / n1, nc2 = s2s / n2;
    if (Math.abs(nc1 - c1) + Math.abs(nc2 - c2) < 1e-10) { c1 = nc1; c2 = nc2; break; }
    c1 = nc1; c2 = nc2;
  }
  /* EM */
  let w = [0.5, 0.5], mu = [Math.min(c1, c2), Math.max(c1, c2)];
  const v0 = Math.max(1e-6, Math.pow(quantile(x, 0.75) - quantile(x, 0.25), 2) / 8);
  let s2 = [v0, v0];
  let ll = -Infinity, iters = 0, converged = false;
  const r1 = new Float64Array(n);
  for (let it = 0; it < 300; it++) {
    iters = it + 1;
    let llNew = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.log(w[0]) + logNorm(x[i], mu[0], s2[0]);
      const b = Math.log(w[1]) + logNorm(x[i], mu[1], s2[1]);
      const m = Math.max(a, b);
      const den = m + Math.log(Math.exp(a - m) + Math.exp(b - m));
      r1[i] = Math.exp(a - den);
      llNew += den;
    }
    let n1 = 0, m1 = 0, m2 = 0;
    for (let i = 0; i < n; i++) { n1 += r1[i]; m1 += r1[i] * x[i]; m2 += (1 - r1[i]) * x[i]; }
    const n2 = n - n1;
    if (n1 < 1e-6 || n2 < 1e-6) break;
    mu = [m1 / n1, m2 / n2];
    let v1 = 0, v2 = 0;
    for (let i = 0; i < n; i++) {
      v1 += r1[i] * (x[i] - mu[0]) * (x[i] - mu[0]);
      v2 += (1 - r1[i]) * (x[i] - mu[1]) * (x[i] - mu[1]);
    }
    s2 = [Math.max(1e-8, v1 / n1), Math.max(1e-8, v2 / n2)];
    w = [n1 / n, n2 / n];
    if (Math.abs(llNew - ll) < 1e-9 * Math.abs(llNew)) { ll = llNew; converged = true; break; }
    ll = llNew;
  }
  /* componentes ordenadas pela média: componente 1 = estado de menor beta */
  if (mu[0] > mu[1]) { mu = [mu[1], mu[0]]; s2 = [s2[1], s2[0]]; w = [w[1], w[0]]; }
  return {
    k: 2, weights: w, means: mu, sigmas: [Math.sqrt(s2[0]), Math.sqrt(s2[1])],
    logLik: ll, bic: -2 * ll + 5 * Math.log(n), converged, iters
  };
}

export function ashmanD(g) {
  if (!g || g.k !== 2) return NaN;
  const [m1, m2] = g.means, [s1, s2] = g.sigmas;
  return Math.SQRT2 * Math.abs(m2 - m1) / Math.sqrt(s1 * s1 + s2 * s2);
}

/* cruzamento das densidades ponderadas w1·N1 = w2·N2 entre as duas médias —
   a fronteira de máxima verossimilhança entre os estados ON e OFF.          */
export function densityCrossing(g) {
  if (!g || g.k !== 2) return NaN;
  const [m1, m2] = g.means, [s1, s2] = g.sigmas, [w1, w2] = g.weights;
  const A = 1 / (2 * s1 * s1), B = 1 / (2 * s2 * s2);
  const a = B - A;
  const b = 2 * A * m1 - 2 * B * m2;
  const c = B * m2 * m2 - A * m1 * m1 + Math.log((w1 * s2) / (w2 * s1));
  const dentro = x => x > m1 && x < m2;
  if (Math.abs(a) < 1e-12) {
    const x = -c / b;
    return dentro(x) ? x : NaN;
  }
  const disc = b * b - 4 * a * c;
  if (disc >= 0) {
    const r1 = (-b + Math.sqrt(disc)) / (2 * a), r2 = (-b - Math.sqrt(disc)) / (2 * a);
    if (dentro(r1)) return r1;
    if (dentro(r2)) return r2;
  }
  /* bisseção de reserva sobre a diferença de log-densidades */
  const f = x => Math.log(w1) + logNorm(x, m1, s1 * s1) - Math.log(w2) - logNorm(x, m2, s2 * s2);
  let lo = m1, hi = m2;
  if (f(lo) * f(hi) > 0) return NaN;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; (f(lo) * f(mid) <= 0) ? hi = mid : lo = mid; }
  return (lo + hi) / 2;
}

const toNative = x => Math.max(0, Math.round(Math.pow(10, x) - 1));

/* proposeThresholds(wakeX, opts) — o coração do método.
   Bimodal (BIC prefere k=2 E d de Ashman > 2): limiar inferior = μ1 + 0,5σ1
   (borda alta do estado ON medicamentoso), superior = cruzamento das
   densidades. Unimodal: fallback percentis 30/70, ROTULADO como tal — um
   fallback sem rótulo viraria método sem quem o escolheu.                   */
export function proposeThresholds(wakeX, opts) {
  const o = opts || {};
  const ashMin = isFinite(o.ashmanMin) ? o.ashmanMin : TIDAL_DEFAULTS.ashmanMin;
  const pcts = o.fallbackPercentiles || TIDAL_DEFAULTS.fallbackPercentiles;
  const x = Array.prototype.filter.call(wakeX, isFinite);
  if (x.length < 30) return { ok: false, reason: `only ${x.length} wake samples — too few to characterise the distribution` };
  const g1 = fitGMM1D(x, 1), g2 = fitGMM1D(x, 2);
  const ash = ashmanD(g2);
  const bimodal = !!(g2 && g1 && g2.bic < g1.bic && ash > ashMin);
  let lowerLog, upperLog, method;
  if (bimodal) {
    lowerLog = g2.means[0] + 0.5 * g2.sigmas[0];
    upperLog = densityCrossing(g2);
    method = 'GMM dual-state (bimodal)';
    if (!isFinite(upperLog) || upperLog <= lowerLog) {
      lowerLog = quantile(x, pcts[0] / 100); upperLog = quantile(x, pcts[1] / 100);
      method = 'percentile fallback (degenerate density crossing)';
    }
  } else {
    lowerLog = quantile(x, pcts[0] / 100); upperLog = quantile(x, pcts[1] / 100);
    method = 'percentile fallback (unimodal distribution)';
  }
  let lower = toNative(lowerLog), upper = toNative(upperLog);
  if (upper <= lower) upper = lower + 1;
  return {
    ok: true, method, bimodal, lower, upper,
    lowerLog: +lowerLog.toFixed(5), upperLog: +upperLog.toFixed(5),
    ashman: isFinite(ash) ? +ash.toFixed(3) : NaN, gmm1: g1, gmm2: g2,
    nWake: x.length, fallbackPercentiles: pcts.slice()
  };
}

/* ========================================================================= */
/*  Etapa 4 — simulação offline do controlador dual threshold                */
/* ========================================================================= */

/* zoneStats(values, lower, upper, dayKeys) — %% por zona e transições/dia.
   Independe da corrente: é a parte da simulação que só depende dos limiares. */
export function zoneStats(values, lower, upper, dayKeys) {
  let below = 0, within = 0, above = 0, transitions = 0, prevZone = null, n = 0;
  const dias = new Set();
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isFinite(v)) continue;
    n++;
    if (dayKeys) dias.add(dayKeys[i]);
    const z = v < lower ? -1 : (v > upper ? 1 : 0);
    if (z < 0) below++; else if (z > 0) above++; else within++;
    if (prevZone !== null && z !== prevZone) transitions++;
    prevZone = z;
  }
  const nd = Math.max(1, dias.size);
  return {
    n, pctBelow: 100 * below / Math.max(1, n), pctWithin: 100 * within / Math.max(1, n),
    pctAbove: 100 * above / Math.max(1, n), transitions, transitionsPerDay: +(transitions / nd).toFixed(2),
    nDays: dias.size
  };
}

/* simulateDualThreshold(values, opts) — controlador na resolução de 10 min.
   LIMITAÇÃO DECLARADA: o dispositivo real dispara com >1,2 s acima do limiar
   e rampa em ~2,5/5 min (Stanslaski 2024); aqui cada amostra de 10 min vale
   um passo de corrente. A simulação estima OCUPAÇÃO das zonas e saturação,
   não a trajetória fina de corrente.
   Os limites de corrente (iMin/iMax, mA) são ENTRADA DO CLÍNICO — decisão de
   segurança que este módulo não automatiza.                                 */
export function simulateDualThreshold(values, opts) {
  const o = opts || {};
  const { lower, upper } = o;
  if (!isFinite(lower) || !isFinite(upper) || upper <= lower) return { ok: false, reason: 'invalid thresholds' };
  const zonas = zoneStats(values, lower, upper, o.dayKeys);
  if (!isFinite(o.iMin) || !isFinite(o.iMax) || !(o.iMax > o.iMin)) {
    return Object.assign({ ok: true, hasCurrent: false, reason: 'current limits not provided — zone occupancy only' }, zonas);
  }
  const step = isFinite(o.step) && o.step > 0 ? o.step : TIDAL_DEFAULTS.stepPC;
  let I = isFinite(o.startI) ? o.startI : +((o.iMin + o.iMax) / 2).toFixed(4);
  let satLow = 0, satHigh = 0, n = 0;
  const traj = new Float64Array(values.length).fill(NaN);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isFinite(v)) continue;
    n++;
    if (v > upper) I = Math.min(o.iMax, +(I + step).toFixed(4));
    else if (v < lower) I = Math.max(o.iMin, +(I - step).toFixed(4));
    traj[i] = I;
    if (I <= o.iMin + 1e-9) satLow++;
    else if (I >= o.iMax - 1e-9) satHigh++;
  }
  const acc = TIDAL_DEFAULTS.accept;
  const dentro = (v, [a, b]) => v >= a && v <= b;
  return Object.assign({
    ok: true, hasCurrent: true,
    pctSaturated: 100 * (satLow + satHigh) / Math.max(1, n),
    pctSatLow: 100 * satLow / Math.max(1, n), pctSatHigh: 100 * satHigh / Math.max(1, n),
    trajectory: traj, iMin: o.iMin, iMax: o.iMax, step,
    withinAcceptance: dentro(zonas.pctBelow, acc.below) && dentro(zonas.pctWithin, acc.within) && dentro(zonas.pctAbove, acc.above)
  }, zonas);
}

/* autoTune(values, base, opts) — busca em grade ±15% (passos de 1%) em torno
   dos limiares propostos, minimizando distância às proporções-alvo 20/60/20 +
   penalidade por saturação. Nunca sai da vizinhança: o método continua sendo
   o proposto, o auto-tune só o acomoda à ocupação alvo.                     */
export function autoTune(values, base, opts) {
  const o = opts || {};
  const span = (isFinite(o.spanPct) ? o.spanPct : TIDAL_DEFAULTS.autoTuneSpanPct) / 100;
  const stepPct = (isFinite(o.stepPct) ? o.stepPct : TIDAL_DEFAULTS.autoTuneStepPct) / 100;
  const alvo = TIDAL_DEFAULTS.targets;
  const custo = m => Math.abs(m.pctBelow - alvo.below) + Math.abs(m.pctWithin - alvo.within) +
    Math.abs(m.pctAbove - alvo.above) + (isFinite(m.pctSaturated) ? 0.5 * m.pctSaturated : 0);
  const simDe = (lo, hi) => simulateDualThreshold(values, Object.assign({}, o, { lower: lo, upper: hi }));
  const m0 = simDe(base.lower, base.upper);
  let best = { lower: base.lower, upper: base.upper, metrics: m0, cost: custo(m0) };
  const baseCost = best.cost;
  for (let fl = 1 - span; fl <= 1 + span + 1e-9; fl += stepPct) {
    for (let fu = 1 - span; fu <= 1 + span + 1e-9; fu += stepPct) {
      const lo = Math.round(base.lower * fl), hi = Math.round(base.upper * fu);
      if (hi <= lo) continue;
      const m = simDe(lo, hi);
      const c = custo(m);
      if (c < best.cost - 1e-9) best = { lower: lo, upper: hi, metrics: m, cost: c };
    }
  }
  return Object.assign(best, { baseCost, improved: best.cost < baseCost - 1e-9, spanPct: span * 100, stepPct: stepPct * 100 });
}

/* ========================================================================= */
/*  Pipeline completo por hemisfério                                         */
/* ========================================================================= */

/* runPipeline(rows, offMin, opts)
   rows: [{t, lfp}] em unidades nativas (censura/perda já como NaN).
   Devolve tudo o que a UI, o CSV e o relatório precisam, com cada decisão
   rotulada (dias excluídos, método de vigília, método de limiar).           */
export function runPipeline(rows, offMin, opts) {
  const o = Object.assign({}, TIDAL_DEFAULTS, opts || {});
  const src = (rows || []).filter(r => r && isFinite(r.t)).slice().sort((a, b) => a.t - b.t);
  if (!src.length) return { ok: false, reason: 'no Timeline samples' };

  /* Etapa 1 */
  const x0 = src.map(r => isFinite(r.lfp) && r.lfp >= 0 ? Math.log10(r.lfp + 1) : NaN);
  const ham = hampelFilter(x0, { window: o.hampelWindow, k: o.hampelK });
  const marcados = src.map((r, i) => ({ t: r.t, lfp: r.lfp, x0: x0[i], x: ham.x[i], artifact: !!ham.artifact[i] }));
  const dias = auditDays(marcados, ham.artifact, offMin, o);
  if (dias.used.length < o.minDays) {
    return {
      ok: false, blockedByDays: true, days: dias,
      reason: `${dias.used.length} usable day(s) after cleaning — ADAPT-START recommends ≥3–5 days of Timeline ` +
        `before proposing thresholds [doi:10.1038/s41531-026-01269-z]`
    };
  }
  const usados = new Set(dias.used);
  const clean = marcados.filter(r => isFinite(r.x) && usados.has(localDayKey(r.t, offMin)));

  /* Etapa 2 */
  const wake = detectWakeWindow(clean, offMin, o);
  const wakeRows = clean.filter(r => inWake(localHour(r.t, offMin), wake.wake));

  /* Etapa 3 */
  const prop = proposeThresholds(wakeRows.map(r => r.x), o);
  if (!prop.ok) return { ok: false, reason: prop.reason, days: dias, wake };

  /* Etapa 4 — zonas sempre; corrente só com limites do clínico */
  const nat = wakeRows.map(r => r.lfp);
  const dayKeys = wakeRows.map(r => localDayKey(r.t, offMin));
  const sim = simulateDualThreshold(nat, {
    lower: prop.lower, upper: prop.upper, dayKeys,
    iMin: o.iMin, iMax: o.iMax, step: o.step
  });

  return {
    ok: true, version: TIDAL_VERSION,
    nRaw: src.length, nArtifacts: ham.nRejected, hampel: ham.params,
    days: dias, wake, proposal: prop, sim,
    wakeRows, cleanRows: clean, allRows: marcados,
    offMin, params: {
      hampelWindow: o.hampelWindow, hampelK: o.hampelK,
      minValidDayFrac: o.minValidDayFrac, maxRejectedDayFrac: o.maxRejectedDayFrac,
      cosinorR2Floor: o.cosinorR2Floor, ashmanMin: o.ashmanMin,
      fallbackPercentiles: (o.fallbackPercentiles || TIDAL_DEFAULTS.fallbackPercentiles).slice()
    },
    limitation10min: 'Timeline resolution is 10 min; the real controller triggers on >1.2 s epochs with ' +
      '~2.5/5 min ramps (Stanslaski 2024). This simulation estimates zone occupancy and saturation, not the fine current trajectory.'
  };
}

/* ========================================================================= */
/*  Linha de exportação (CSV) — cabeçalhos EXATOS da especificação           */
/* ========================================================================= */

export const TIDAL_CSV_COLUMNS = [
  'hemisphere', 'method', 'lower_threshold_lfp', 'upper_threshold_lfp',
  'mu1_log', 'sigma1_log', 'mu2_log', 'sigma2_log', 'ashman_d', 'bic_k1', 'bic_k2',
  'pct_below', 'pct_within', 'pct_above', 'transitions_per_day',
  'days_used', 'days_excluded', 'wake_window'
];

export function tidalCsvRow(hemi, res) {
  const p = res.proposal, g = p.gmm2, s = res.sim;
  const fmtH = h => (h < 10 ? '0' : '') + h.toFixed(1);
  return {
    hemisphere: hemi, method: p.method,
    lower_threshold_lfp: p.lower, upper_threshold_lfp: p.upper,
    mu1_log: g ? rnd(g.means[0], 5) : '', sigma1_log: g ? rnd(g.sigmas[0], 5) : '',
    mu2_log: g ? rnd(g.means[1], 5) : '', sigma2_log: g ? rnd(g.sigmas[1], 5) : '',
    ashman_d: isFinite(p.ashman) ? p.ashman : '',
    bic_k1: p.gmm1 ? rnd(p.gmm1.bic, 2) : '', bic_k2: g ? rnd(g.bic, 2) : '',
    pct_below: rnd(s.pctBelow, 2), pct_within: rnd(s.pctWithin, 2), pct_above: rnd(s.pctAbove, 2),
    transitions_per_day: s.transitionsPerDay,
    days_used: res.days.used.length, days_excluded: res.days.excluded.length,
    wake_window: `${fmtH(res.wake.wake[0])}-${fmtH(res.wake.wake[1])}`
  };
}

/* ========================================================================= */
/*  Verificação de ciclo de medicação (Etapa 3.5)                            */
/* ========================================================================= */

/* medicationCycleCheck(cleanRows, doseTimes, proposal) — trajetória média do
   log-beta em ±90 min ao redor das tomadas; passa se a média pós migra na
   direção do componente baixo (queda ≥ 25% da separação μ2−μ1).             */
export function medicationCycleCheck(cleanRows, doseTimes, proposal) {
  if (!doseTimes || !doseTimes.length) return { ok: false, reason: 'no medication-intake events in this recording' };
  const bins = 19;                                        /* −90..+90 min em passos de 10 */
  const soma = new Float64Array(bins), cnt = new Float64Array(bins);
  doseTimes.forEach(t0 => cleanRows.forEach(r => {
    const dtMin = (r.t - t0) / 60000;
    if (dtMin < -95 || dtMin > 95 || !isFinite(r.x)) return;
    const b = Math.min(bins - 1, Math.max(0, Math.round((dtMin + 90) / 10)));
    soma[b] += r.x; cnt[b]++;
  }));
  const curva = Array.from(soma, (v, i) => cnt[i] ? v / cnt[i] : NaN);
  const pre = curva.slice(0, 9).filter(isFinite), pos = curva.slice(10).filter(isFinite);
  if (pre.length < 3 || pos.length < 3) return { ok: false, reason: 'too few Timeline samples around the events' };
  const delta = mean(pos) - mean(pre);
  const sep = proposal && proposal.bimodal ? proposal.gmm2.means[1] - proposal.gmm2.means[0] : NaN;
  const pass = isFinite(sep) ? delta <= -0.25 * sep : delta < 0;
  return {
    ok: true, nEvents: doseTimes.length, deltaLog: +delta.toFixed(4), curve: curva,
    separationLog: isFinite(sep) ? +sep.toFixed(4) : NaN,
    verdict: pass ? 'pass' : 'warn',
    note: pass
      ? 'mean beta migrates toward the low-state component after intake — thresholds separate medication states'
      : 'no clear high→low migration around intakes — thresholds may reflect something other than the medication cycle'
  };
}

/* ========================================================================= */
/*  Gerador sintético + self-test (determinístico, espelhado no R)           */
/* ========================================================================= */

/* LCG minstd (Lehmer): produto ≤ 48271·(2³¹−2) ≈ 1,04e14 < 2⁵³ — exato em
   dupla precisão, logo REPRODUTÍVEL bit a bit em JavaScript e em R.         */
export function tidalRng(seed) {
  let s = (seed >>> 0) % 2147483647; if (s <= 0) s += 2147483646;
  const next = () => { s = (s * 48271) % 2147483647; return s / 2147483647; };
  /* Box–Muller sem cache: 2 uniformes por normal, na mesma ordem no R */
  const gauss = () => Math.sqrt(-2 * Math.log(next())) * Math.cos(2 * Math.PI * next());
  return { next, gauss };
}

/* syntheticTimeline(opts) — Timeline com ciclo circadiano (sono baixo),
   ciclos de medicação de 4 h em vigília (estado baixo pós-dose → alto no fim
   de dose) e 1% de outliers. A verdade de campo dos limiares sai DA MESMA
   fórmula usada na proposta, aplicada aos parâmetros geradores.             */
export function syntheticTimeline(opts) {
  const o = Object.assign({
    days: 7, seed: 42, sleepMu: 1.10, sleepSd: 0.05,
    lowMu: 1.45, lowSd: 0.06, highMu: 1.75, highSd: 0.07,
    wakeStart: 8, wakeEnd: 23, outlierP: 0.01, outlierShift: 1.0
  }, opts || {});
  const rng = tidalRng(o.seed);
  const t0 = 1736121600000;                                /* 2025-01-06T00:00Z, fixo */
  const rows = [];
  for (let d = 0; d < o.days; d++) for (let b = 0; b < 144; b++) {
    const h = b / 6;
    const z = rng.gauss();
    const uo = rng.next();
    let x;
    if (h >= o.wakeStart && h < o.wakeEnd) {
      const cyc = (h - o.wakeStart) % 4;                   /* tomada a cada 4 h */
      x = cyc < 2 ? o.lowMu + o.lowSd * z : o.highMu + o.highSd * z;
    } else x = o.sleepMu + o.sleepSd * z;
    if (uo < o.outlierP) x += o.outlierShift;
    rows.push({ t: t0 + (d * 144 + b) * 600000, lfp: Math.pow(10, x) - 1 });
  }
  /* verdade de campo: mesma regra da proposta sobre os parâmetros geradores */
  const gTrue = { k: 2, weights: [0.5, 0.5], means: [o.lowMu, o.highMu], sigmas: [o.lowSd, o.highSd] };
  const truth = {
    lowerLog: o.lowMu + 0.5 * o.lowSd, upperLog: densityCrossing(gTrue),
    lower: toNative(o.lowMu + 0.5 * o.lowSd), upper: toNative(densityCrossing(gTrue)),
    wake: [o.wakeStart, o.wakeEnd]
  };
  return { rows, truth, offMin: 0, params: o };
}

/* selfTest() — critério: erro < 10% nos dois limiares, com método GMM.      */
export function selfTest(opts) {
  const syn = syntheticTimeline(opts);
  const res = runPipeline(syn.rows, syn.offMin, { iMin: 0, iMax: 5, step: 0.1 });
  if (!res.ok) return { pass: false, reason: res.reason, truth: syn.truth };
  const errLower = 100 * Math.abs(res.proposal.lower - syn.truth.lower) / syn.truth.lower;
  const errUpper = 100 * Math.abs(res.proposal.upper - syn.truth.upper) / syn.truth.upper;
  return {
    pass: errLower < 10 && errUpper < 10 && res.proposal.bimodal,
    errLowerPct: +errLower.toFixed(2), errUpperPct: +errUpper.toFixed(2),
    proposed: { lower: res.proposal.lower, upper: res.proposal.upper, method: res.proposal.method },
    truth: syn.truth, wake: res.wake.wake, result: res
  };
}

/* namespace público — é o contrato com a UI, os testes e o espelho em R */
export const TIDAL = {
  VERSION: TIDAL_VERSION, REFS: TIDAL_REFS, DEFAULTS: TIDAL_DEFAULTS,
  DISCLAIMER: TIDAL_DISCLAIMER, CSV_COLUMNS: TIDAL_CSV_COLUMNS,
  hampelFilter, auditDays, fitCosinor, detectWakeWindow, inWake,
  fitGMM1D, ashmanD, densityCrossing, proposeThresholds,
  zoneStats, simulateDualThreshold, autoTune,
  runPipeline, tidalCsvRow, medicationCycleCheck,
  tidalRng, syntheticTimeline, selfTest
};
