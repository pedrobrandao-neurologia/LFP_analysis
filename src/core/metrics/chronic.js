/* metrics/chronic.js — métricas crônicas do Timeline (metrics)
   Gerado do refactor modular (Prompt 0.1). Ver docs/arquitetura.md. */

import { cosinor, diurnalProfile, rayleigh, varianceByHour } from '../stats/circadian.js';
import { detectStates } from '../stats/states.js';
import { localDayKey, localHour } from '../io/parse.js';
import { median, quantile, removeOutliersMAD, rnd } from '../stats/descriptive.js';
import { detectWakeWindow, inWake } from './tidal.js';

export function thresholdSummary(vals, lower, upper) {
  const v = vals.filter(isFinite);
  const below = v.filter(x => x < lower).length, above = v.filter(x => x > upper).length;
  return {
    n: v.length,
    belowPct: 100 * below / v.length,
    betweenPct: 100 * (v.length - below - above) / v.length,
    abovePct: 100 * above / v.length,
    median: median(v), q1: quantile(v, 0.25), q3: quantile(v, 0.75),
    p10: quantile(v, 0.1), p90: quantile(v, 0.9)
  };
}

/* censoringSummary(parsedList) — contabilidade da CENSURA do aparelho, somada
   entre arquivos e separada por hemisfério.

   Censura NÃO é perda de pacote. Perda de pacote é falha de telemetria; censura
   é o aparelho decidindo que aquela amostra tinha artefato e marcando-a com
   sinal negativo (UC202012929cEN FY24, p. 24). Somar as duas esconderia a única
   coisa que as distingue — e a censura tem interpretação clínica própria, já que
   ela se concentra onde há movimento e onde há ECG.                          */
export function censoringSummary(parsedList) {
  const porHemi = {};
  let n = 0, cens = 0;
  (parsedList || []).forEach(p => {
    const c = (p && p.trendCensoring) || {};
    Object.keys(c).forEach(h => {
      const a = porHemi[h] || (porHemi[h] = { n: 0, nCensoredLfp: 0, nCensoredMa: 0, nCensored: 0 });
      a.n += c[h].n || 0;
      a.nCensoredLfp += c[h].nCensoredLfp || 0;
      a.nCensoredMa += c[h].nCensoredMa || 0;
      a.nCensored += c[h].nCensored || 0;
    });
  });
  Object.keys(porHemi).forEach(h => {
    const a = porHemi[h];
    a.pctCensoredLfp = a.n ? +(100 * a.nCensoredLfp / a.n).toFixed(3) : 0;
    a.pctCensoredMa = a.n ? +(100 * a.nCensoredMa / a.n).toFixed(3) : 0;
    a.pctCensored = a.n ? +(100 * a.nCensored / a.n).toFixed(3) : 0;
    n += a.n; cens += a.nCensored;
  });
  const hemis = Object.keys(porHemi);
  return {
    ok: hemis.length > 0,
    byHemisphere: porHemi,
    n, nCensored: cens,
    pctCensored: n ? +(100 * cens / n).toFixed(3) : 0,
    rule: 'valor negativo no LfpTrendLogs = amostra censurada pelo aparelho para evitar artefato ' +
      '(Medtronic UC202012929cEN FY24, p. 24). Vira NaN e é contada aqui.',
    separateFromPacketLoss: 'esta contagem é INDEPENDENTE da perda de pacotes: uma é decisão do aparelho sobre a ' +
      'qualidade do sinal, a outra é falha de telemetria',
    reading: !hemis.length ? 'nenhum Timeline neste conjunto de arquivos'
      : cens === 0 ? `nenhuma das ${n} amostras do Timeline foi censurada pelo aparelho`
        : `${cens} de ${n} amostras (${(100 * cens / n).toFixed(2)}%) foram censuradas pelo aparelho e não entram em ` +
          'nenhuma estatística. A censura não é aleatória: ela se concentra onde o aparelho suspeitou de artefato, ' +
          'o que costuma coincidir com movimento — e movimento correlaciona com estado motor'
  };
}

export function mergeTrend(parsedList) {
  const out = {};
  parsedList.forEach(p => Object.keys(p.trend || {}).forEach(h => { out[h] = (out[h] || []).concat(p.trend[h]); }));
  Object.keys(out).forEach(h => {
    const seen = new Set(), rows = [];
    out[h].sort((a, b) => a.t - b.t).forEach(r => { if (!seen.has(r.t)) { seen.add(r.t); rows.push(r); } });
    out[h] = rows;
  });
  return out;
}

/* Limiares de sensing/aDBS declarados no dispositivo, por hemisfério. */

export function collectThresholds(parsedList) {
  const t = {};
  parsedList.forEach(p => (p.sensingSetup || []).forEach(s => { if (isFinite(s.lowerThr)) t[s.hemisphere] = { lower: s.lowerThr, upper: s.upperThr, centerFreq: s.centerFreq }; }));
  parsedList.forEach(p => (p.bsLfp || []).forEach(b => Object.keys(b.therapy.perHemi || {}).forEach(h => {
    const x = b.therapy.perHemi[h]; if (isFinite(x.lowerThr) && !t[h]) t[h] = { lower: x.lowerThr, upper: x.upperThr, centerFreq: x.centerFreq };
  })));
  return t;
}

/* Métricas crônicas (circadiano + distribuição para aDBS) de um hemisfério. */

export function chronicMetrics(rows, offMin, thr) {
  const clean = removeOutliersMAD(rows, 'lfp', 4).kept;
  const vals = clean.map(r => r.lfp);
  const dayset = {}; clean.forEach(r => dayset[localDayKey(r.t, offMin)] = 1);
  const days = Object.keys(dayset).sort();
  const out = {
    n_points: clean.length, n_removed: rows.length - clean.length, n_days: days.length,
    first_day_local: days[0] || '', last_day_local: days[days.length - 1] || '',
    lfp_median: rnd(median(vals)), lfp_iqr_low: rnd(quantile(vals, .25)), lfp_iqr_high: rnd(quantile(vals, .75))
  };
  if (clean.length >= 12) {
    const cos = cosinor(clean.map(r => localHour(r.t, offMin)), vals, [24, 12]);
    const vh = varianceByHour(clean, offMin);
    if (cos) Object.assign(out, {
      mesor: rnd(cos.mesor), amp_24h: rnd(cos.components[0].amplitude),
      acrophase_24h: rnd(((cos.components[0].acrophaseHours % 24) + 24) % 24, 2),
      amp_12h: cos.components[1] ? rnd(cos.components[1].amplitude) : NaN,
      cosinor_r2: rnd(cos.r2, 3), cosinor_F: rnd(cos.F, 2), cosinor_p: rnd(cos.p, 5),
      rho_ar1: rnd(cos.rhoAR1, 3), cosinor_p_adj_ar1: rnd(cos.pAdjustedAR1, 5)
    });
    if (vh) Object.assign(out, { eta2_hour_pct: rnd(100 * vh.eta2, 2), eta2_p: rnd(vh.p, 5) });
  }
  if (days.length >= 2) {
    const dp = diurnalProfile(clean, offMin, 30, true);
    const peaks = dp.matrix.map(m => { let bi = -1, bv = -Infinity; m.values.forEach((x, i) => { if (isFinite(x) && x > bv) { bv = x; bi = i; } }); return bi >= 0 ? dp.hours[bi] : NaN; }).filter(isFinite);
    const ray = rayleigh(peaks);
    if (ray) Object.assign(out, { rayleigh_R: rnd(ray.R, 3), rayleigh_p: rnd(ray.p, 5), rayleigh_mean_hour: rnd(ray.meanHour, 2) });
  }
  const lo = thr && isFinite(thr.lower) ? thr.lower : quantile(vals, .25);
  const hi = thr && isFinite(thr.upper) ? thr.upper : quantile(vals, .75);
  const sm = thresholdSummary(vals, lo, hi);
  Object.assign(out, {
    thr_source: thr && isFinite(thr.lower) ? 'device' : 'Q1/Q3',
    thr_lower: rnd(lo), thr_upper: rnd(hi),
    pct_below: rnd(sm.belowPct, 1), pct_between: rnd(sm.betweenPct, 1), pct_above: rnd(sm.abovePct, 1),
    p10: rnd(sm.p10), p90: rnd(sm.p90),
    sensing_center_hz: thr && isFinite(thr.centerFreq) ? rnd(thr.centerFreq, 1) : NaN
  });
  const st = detectStates(clean.map(r => ({ t: r.t, v: r.lfp })), { minDur: 30 * 60000 });
  if (st) Object.assign(out, {
    off_pct: rnd(100 * st.offFraction, 1), n_off_episodes: st.nOff,
    mean_off_min: rnd(st.meanOffDur / 60000, 0), mean_on_min: rnd(st.meanOnDur / 60000, 0),
    beta_low_state: rnd(st.betaLow), beta_high_state: rnd(st.betaHigh),
    beta_state_sep: rnd(st.separation, 2), beta_bimodality: rnd(st.bimodality, 3)
  });
  return out;
}

/* ---- Detecção automática de estados ON/OFF pela amplitude do beta --------
   Ideia clínica: o beta subtalâmico é o "ritmo do freio" — costuma ficar ALTO
   quando a medicação está no fim (estado OFF) e CAI quando ela faz efeito
   (estado ON) ou sob estimulação eficaz. Aqui a série de potência de beta é
   separada em dois estados por agrupamento (k-médias, k=2): baixo beta = ON,
   alto beta = OFF, com um limiar entre eles e limpeza de duração mínima para
   não oscilar. É um CORRELATO, não a verdade clínica — artefato de movimento
   infla o beta e simula OFF, e a estimulação também altera o beta. --------- */
/* Coeficiente de bimodalidade de Sarle (0–1). BC > ~0,555 sugere distribuição
   com dois modos (ou achatada); BC baixo indica um único pico — nesse caso a
   divisão ON/OFF é arbitrária. É um indicador honesto de "há dois estados?",
   ao contrário da distância entre clusters, que o k-médias sempre infla. */

/* ------------------------------------------------------------------------ */
/*  Segmentação do Timeline em dias civis locais                            */
/* ------------------------------------------------------------------------ */

/* splitByLocalDay(rows, offMin, opts)
   O QUE CALCULA. Reparte uma série crônica (LFPTrendLogs, amostrada a cada
   ~10 min) em dias civis locais — 00:00:00 a 23:59:59,999 — de modo que cada
   dia possa ser plotado num painel próprio, todos sobre o mesmo eixo de horas.
   Dentro de cada dia, corta a série em segmentos contíguos sempre que a
   distância entre amostras vizinhas passa de `gapFactor` × o intervalo de
   amostragem observado.

   ENTRADA. rows: [{t: epoch ms, lfp, ma}]; offMin: offset local em minutos.
   Opções: {gapFactor = 3, fromDay, toDay} (fromDay/toDay em 'YYYY-MM-DD' local,
   para forçar a mesma lista de dias entre hemisférios).
   SAÍDA. {ok, days: [{dayKey, index, dayStart, rows, n, hours, values,
   segments, gaps, largestGapMin, coverage, empty}], samplingMs,
   gapThresholdMs, nDays, nEmptyDays, params}. Horas em h decimal local (0–24),
   lacunas em minutos, cobertura em fração de 0 a 1.

   DUAS REGRAS DE HONESTIDADE, e são o motivo de a função existir:
   1. Um dia sem nenhuma amostra dentro do intervalo do registro entra na saída
      com empty:true, em vez de sumir. A ausência de um dia é informação — pode
      ser desligamento do sensing, pode ser sobrescrita pelo limite de
      capacidade do aparelho (UC202012929cEN FY24, p. 7) — e encurtar o eixo
      para "pular" o buraco apagaria o que ele diz.
   2. O traçado nunca cruza uma lacuna. Ligar dois pontos separados por horas
      de silêncio desenha um dado que não foi medido; é imputação silenciosa
      feita com tinta em vez de número. Os segmentos existem para que a figura
      levante a caneta.

   Referência de intervalo: o Timeline grava uma média não sobreposta a cada
   10 min (UC202012929cEN FY24, p. 9), mas o intervalo é MEDIDO aqui, não
   assumido — registro com sensing interrompido tem outro passo efetivo.     */
export function splitByLocalDay(rows, offMin, opts) {
  const o = opts || {};
  const gapFactor = isFinite(o.gapFactor) && o.gapFactor > 0 ? o.gapFactor : 3;
  const src = (rows || []).filter(r => r && isFinite(r.t)).slice().sort((a, b) => a.t - b.t);
  const vazio = {
    ok: false, days: [], nDays: 0, nEmptyDays: 0, samplingMs: NaN,
    gapThresholdMs: NaN, params: { gapFactor, offMin }
  };
  if (!src.length) return vazio;

  /* intervalo de amostragem = mediana das diferenças positivas. Mediana, e não
     média, porque uma única lacuna de dois dias arrastaria a média e faria o
     limiar de lacuna engolir todas as lacunas reais. */
  const diffs = [];
  for (let i = 1; i < src.length; i++) { const dt = src[i].t - src[i - 1].t; if (dt > 0) diffs.push(dt); }
  const samplingMs = diffs.length ? median(diffs) : NaN;
  const gapThresholdMs = isFinite(samplingMs) && samplingMs > 0 ? samplingMs * gapFactor : Infinity;

  const DIA = 864e5;
  const inicioDoDia = chave => Date.parse(chave + 'T00:00:00Z') - offMin * 60000;

  const porDia = {};
  src.forEach(r => { const k = localDayKey(r.t, offMin); (porDia[k] = porDia[k] || []).push(r); });
  const observados = Object.keys(porDia).sort();

  /* lista de dias: do primeiro ao último, SEM pular os vazios */
  const primeiro = o.fromDay && o.fromDay < observados[0] ? o.fromDay : observados[0];
  const ultimo = o.toDay && o.toDay > observados[observados.length - 1] ? o.toDay : observados[observados.length - 1];
  const chaves = [];
  for (let t = inicioDoDia(primeiro); t <= inicioDoDia(ultimo) + DIA / 2; t += DIA) {
    chaves.push(localDayKey(t + DIA / 2, offMin));
    if (chaves.length > 400) break;   /* trava contra offset absurdo */
  }

  const days = chaves.map((chave, index) => {
    const rs = porDia[chave] || [];
    const dayStart = inicioDoDia(chave);
    const hours = rs.map(r => (r.t - dayStart) / 36e5);
    const values = rs.map(r => r.lfp);

    /* segmentos contíguos e lacunas internas */
    const segments = [];
    const gaps = [];
    let ini = 0;
    for (let i = 1; i < rs.length; i++) {
      const dt = rs[i].t - rs[i - 1].t;
      if (dt > gapThresholdMs) {
        segments.push({ from: ini, to: i - 1, n: i - ini });
        gaps.push({ fromHour: hours[i - 1], toHour: hours[i], minutes: dt / 60000 });
        ini = i;
      }
    }
    if (rs.length) segments.push({ from: ini, to: rs.length - 1, n: rs.length - ini });

    /* lacunas de borda: o silêncio antes da primeira e depois da última
       amostra do dia também é ausência, e conta na cobertura */
    if (rs.length) {
      const meio = isFinite(samplingMs) ? samplingMs / 2 / 36e5 : 0;
      if (hours[0] - meio > gapThresholdMs / 36e5) gaps.push({ fromHour: 0, toHour: hours[0], minutes: hours[0] * 60, edge: 'inicio' });
      const fim = hours[hours.length - 1];
      if (24 - fim - meio > gapThresholdMs / 36e5) gaps.push({ fromHour: fim, toHour: 24, minutes: (24 - fim) * 60, edge: 'fim' });
    }

    const coverage = isFinite(samplingMs) && samplingMs > 0
      ? Math.min(1, rs.length * samplingMs / DIA) : NaN;
    const maior = gaps.length ? Math.max.apply(null, gaps.map(g => g.minutes)) : 0;

    return {
      dayKey: chave, index, dayStart, rows: rs, n: rs.length, hours, values,
      segments, gaps, largestGapMin: maior, coverage, empty: rs.length === 0
    };
  });

  return {
    ok: true, days, nDays: days.length,
    nEmptyDays: days.filter(d => d.empty).length,
    samplingMs, gapThresholdMs,
    params: { gapFactor, offMin, expectedSamplesPerDay: isFinite(samplingMs) && samplingMs > 0 ? Math.round(DIA / samplingMs) : NaN }
  };
}

/* dayRangeOf(seriesList, offMin) — primeiro e último dia local vistos num
   conjunto de séries, para que os painéis de hemisférios diferentes cubram
   exatamente a mesma faixa de dias e fiquem comparáveis lado a lado.        */
export function dayRangeOf(seriesList, offMin) {
  let lo = null, hi = null;
  (seriesList || []).forEach(rows => (rows || []).forEach(r => {
    if (!r || !isFinite(r.t)) return;
    const k = localDayKey(r.t, offMin);
    if (lo === null || k < lo) lo = k;
    if (hi === null || k > hi) hi = k;
  }));
  return { fromDay: lo, toDay: hi };
}

/* ------------------------------------------------------------------------ */
/*  Percentis de vigília em escala clínica (7–14 dias)                      */
/* ------------------------------------------------------------------------ */

/* wakePercentiles(rows, offMin, opts)
   O QUE CALCULA. Os percentis 25/50/75 da potência do Timeline DURANTE A
   VIGÍLIA, dia a dia e agregados sobre uma janela de escala clínica (últimos
   7, 14 dias, ou o registro inteiro). É a leitura visual do método manual de
   configuração de limiares de aDBS — percentis 25/75 do beta diurno
   (Busch et al., npj Parkinsons Dis 2025;11:264, doi:10.1038/s41531-025-01124-7)
   — que o programador do fabricante não mostra: lá se vê cada dia, não a
   distribuição acumulada da vigília.

   A vigília vem do MESMO detector do TIDAL-DT (cosinor 24+12 h + change-point,
   com fallback declarado 08:00–22:00), porque dois módulos com duas definições
   de vigília produziriam dois pares de percentis para o mesmo paciente. A
   exclusão do sono é obrigatória: a hora do dia explica grande parte da
   variância do beta crônico (van Rheede 2022; Yin 2023).

   ENTRADA. rows: [{t, lfp}] em unidades nativas (censura já como NaN);
   offMin: fuso local em minutos. Opções: {kMad=4, lastDays=14 (0 = tudo),
   wake: null (auto) | [iniH, fimH] fixo}.
   SAÍDA. {ok, days:[{dayKey, p25, p50, p75, n}], aggregate:{p25,p50,p75,n,
   nDays, from, to}, wake:{window, method, r2}, stability, params}. Percentis
   em unidades LFP nativas — a unidade em que os limiares são digitados.     */
export function wakePercentiles(rows, offMin, opts) {
  const o = opts || {};
  const kMad = isFinite(o.kMad) && o.kMad > 0 ? o.kMad : 4;
  const lastDays = isFinite(o.lastDays) ? Math.max(0, Math.round(o.lastDays)) : 14;

  const limpos = removeOutliersMAD((rows || []).filter(r => r && isFinite(r.t)), 'lfp', kMad).kept
    .filter(r => isFinite(r.lfp) && r.lfp >= 0)
    .sort((a, b) => a.t - b.t);
  if (limpos.length < 50) return { ok: false, reason: `apenas ${limpos.length} amostras válidas após a limpeza` };

  /* vigília: o mesmo detector do TIDAL-DT, sobre log10(lfp+1) */
  let wake;
  if (Array.isArray(o.wake) && o.wake.length === 2 && isFinite(o.wake[0]) && isFinite(o.wake[1])) {
    wake = { wake: [o.wake[0], o.wake[1]], method: 'fixed window (user-set)', r2: NaN };
  } else {
    wake = detectWakeWindow(limpos.map(r => ({ t: r.t, x: Math.log10(r.lfp + 1) })), offMin, {});
  }

  const porDia = new Map();
  limpos.forEach(r => {
    if (!inWake(localHour(r.t, offMin), wake.wake)) return;
    const dk = localDayKey(r.t, offMin);
    if (!porDia.has(dk)) porDia.set(dk, []);
    porDia.get(dk).push(r.lfp);
  });
  let chaves = Array.from(porDia.keys()).sort();
  if (lastDays > 0 && chaves.length > lastDays) chaves = chaves.slice(-lastDays);
  if (chaves.length < 2) return { ok: false, reason: `apenas ${chaves.length} dia(s) com amostras de vigília na janela`, wake };

  const days = chaves.map(dk => {
    const v = porDia.get(dk);
    return {
      dayKey: dk, n: v.length,
      p25: rnd(quantile(v, .25), 1), p50: rnd(quantile(v, .5), 1), p75: rnd(quantile(v, .75), 1)
    };
  });
  const pool = chaves.flatMap(dk => porDia.get(dk));
  const aggregate = {
    p25: rnd(quantile(pool, .25), 1), p50: rnd(quantile(pool, .5), 1), p75: rnd(quantile(pool, .75), 1),
    n: pool.length, nDays: chaves.length, from: chaves[0], to: chaves[chaves.length - 1]
  };

  /* estabilidade: quanto os percentis diários oscilam em torno do agregado.
     Percentis instáveis dia a dia avisam que um limiar fixado neles vai
     ocupar zonas diferentes conforme o dia — informação que decide se vale
     esperar mais dias antes de configurar. */
  const desvio = (arr, ref) => ref > 0 ? rnd(100 * Math.sqrt(arr.reduce((a, v) => a + (v - ref) * (v - ref), 0) / arr.length) / ref, 1) : NaN;
  const stability = {
    p25CvPct: desvio(days.map(d => d.p25), aggregate.p25),
    p75CvPct: desvio(days.map(d => d.p75), aggregate.p75),
    note: 'desvio dos percentis diários em torno do agregado, em % do agregado — instabilidade alta sugere esperar mais dias antes de fixar limiares'
  };

  return {
    ok: true, days, aggregate, wake, stability,
    params: { kMad, lastDays: lastDays || 'all', wakeSource: wake.method, offMin },
    source: 'Busch et al., npj Parkinsons Dis 2025;11:264 (percentis 25/75 do beta diurno como método manual de limiares)'
  };
}
