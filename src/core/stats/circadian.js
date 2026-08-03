/* stats/circadian.js — cosinor, bootstrap e ritmo circadiano (stats)
   Gerado do refactor modular (Prompt 0.1). Ver docs/arquitetura.md. */

import { fPValue } from './distributions.js';
import { localDayKey, localHour } from '../io/parse.js';
import { mean, median, quantile, sum } from './descriptive.js';

export function cosinor(tHours, y, periods) {
  periods = periods || [24];
  const n = y.length;
  const k = 1 + 2 * periods.length;
  if (n <= k + 2) return null;
  const X = [];
  for (let i = 0; i < n; i++) {
    const row = [1];
    periods.forEach(tau => {
      row.push(Math.cos(2 * Math.PI * tHours[i] / tau));
      row.push(Math.sin(2 * Math.PI * tHours[i] / tau));
    });
    X.push(row);
  }
  const beta = olsSolve(X, y);
  if (!beta) return null;
  const fitted = X.map(r => r.reduce((a, v, j) => a + v * beta[j], 0));
  const resid = y.map((v, i) => v - fitted[i]);
  const sse = sum(resid.map(r => r * r));
  const my = mean(y);
  const sst = sum(y.map(v => (v - my) ** 2));
  const r2 = 1 - sse / sst;
  const df1 = k - 1, df2 = n - k;
  const F = (sst - sse) / df1 / (sse / df2);
  const comps = periods.map((tau, i) => {
    const b = beta[1 + 2 * i], g = beta[2 + 2 * i];
    let acro = Math.atan2(-g, b);                  // rad, convenção cosinor
    if (acro > 0) acro -= 2 * Math.PI;
    const acroH = (-acro / (2 * Math.PI)) * tau;
    return { period: tau, amplitude: Math.hypot(b, g), acrophaseRad: acro, acrophaseHours: acroH % tau, beta: b, gamma: g };
  });
  // autocorrelação AR(1) dos resíduos e n efetivo
  let numr = 0, den = 0;
  for (let i = 1; i < n; i++) numr += resid[i] * resid[i - 1];
  for (let i = 0; i < n; i++) den += resid[i] * resid[i];
  const rho = den ? numr / den : 0;
  const nEff = n * (1 - rho) / (1 + rho);
  const Fadj = F * Math.max(0.02, nEff / n);
  return {
    n, mesor: beta[0], components: comps, r2, F, p: fPValue(F, df1, df2),
    residualSD: Math.sqrt(sse / df2), rhoAR1: rho, nEffective: nEff,
    pAdjustedAR1: fPValue(Fadj, df1, Math.max(2, Math.round(nEff) - k)),
    fitted, resid,
    predict: h => beta[0] + periods.reduce((a, tau, i) =>
      a + beta[1 + 2 * i] * Math.cos(2 * Math.PI * h / tau) + beta[2 + 2 * i] * Math.sin(2 * Math.PI * h / tau), 0)
  };
}

/* Resolve as equações normais (XᵀX)β = Xᵀy por Gauss-Jordan com pivoteamento
   parcial. Entrada: matriz k×k simétrica e vetor k. Saída: β (k) ou null se o
   sistema for singular. Unidades: as de y por unidade de cada coluna de X.   */
export function solveNormalEq(XtX, Xty) {
  const k = Xty.length;
  const A = Array.from({ length: k }, (_, i) => {
    const linha = new Float64Array(k + 1);
    for (let j = 0; j < k; j++) linha[j] = XtX[i][j];
    linha[k] = Xty[i];
    return linha;
  });
  for (let c = 0; c < k; c++) {
    let piv = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    const d = A[c][c];
    for (let j = c; j <= k; j++) A[c][j] /= d;
    for (let r = 0; r < k; r++) if (r !== c) { const f = A[r][c]; for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j]; }
  }
  return Array.from({ length: k }, (_, i) => A[i][k]);
}

export function olsSolve(X, y) {                        // normal equations + Gauss-Jordan
  const k = X[0].length, n = X.length;
  const XtX = Array.from({ length: k }, () => new Float64Array(k));
  const Xty = new Float64Array(k);
  for (let r = 0; r < n; r++) {
    const linha = X[r], yr = y[r];
    for (let i = 0; i < k; i++) {
      const v = linha[i];
      Xty[i] += v * yr;
      for (let j = i; j < k; j++) XtX[i][j] += v * linha[j];
    }
  }
  for (let i = 0; i < k; i++) for (let j = 0; j < i; j++) XtX[i][j] = XtX[j][i];
  return solveNormalEq(XtX, Xty);
}

/* Bootstrap por blocos (dia inteiro) para IC dos parâmetros do cosinor.

   O QUE CALCULA. IC de 95% de MESOR, amplitude e acrofase do componente de
   maior período, reamostrando DIAS INTEIROS com reposição — o que preserva a
   autocorrelação intradiária, forte na amostragem de 10 min do Timeline.

   COMO. O cosinor é mínimos quadrados, e as equações normais (XᵀX, Xᵀy) são
   ADITIVAS sobre blocos disjuntos. Então o Gram de cada dia é calculado UMA vez
   e cada reamostragem vira a soma de nDias matrizes k×k mais a solução de um
   sistema k×k, em vez de refazer o ajuste sobre as n amostras. O estimador é o
   MESMO (mesmos β, a menos de arredondamento de ponto flutuante); o custo cai
   de O(nBoot·n·k²) para O(nBoot·nDias·k²). Em 26 000 pontos com nBoot = 200 é a
   diferença entre ~5 s de tela congelada e alguns milissegundos.

   REPRODUTIBILIDADE. A reamostragem usa um gerador congruencial de semente
   fixa (`opts.seed`), portanto o IC é idêntico entre execuções — exigência do
   manifesto de proveniência. Amostras com LFP não finito são excluídas e
   contabilizadas em `nExcluded`, nunca imputadas.

   Entrada: rows [{t (ms), lfp}], periods (h), nBoot, offMin (min).
   Saída: IC nas unidades de `lfp`; acrofase em horas locais.
   Referência: Cornélissen G. Cosinor-based rhythmometry. Theor Biol Med Model
   2014;11:16. Bootstrap de blocos: Lahiri SN. Resampling Methods for Dependent
   Data, Springer 2003.                                                       */
export function cosinorBootstrap(rows, periods, nBoot, offMin, opts) {
  periods = periods && periods.length ? periods : [24];
  nBoot = nBoot || 400;
  opts = opts || {};
  const k = 1 + 2 * periods.length;
  const porDia = new Map();
  let nExcluidas = 0;
  (rows || []).forEach(r => {
    if (!r || !isFinite(r.lfp) || !isFinite(r.t)) { nExcluidas++; return; }
    const chave = localDayKey(r.t, offMin);
    let g = porDia.get(chave);
    if (!g) {
      g = { XtX: Array.from({ length: k }, () => new Float64Array(k)), Xty: new Float64Array(k), n: 0 };
      porDia.set(chave, g);
    }
    const h = localHour(r.t, offMin), y = r.lfp;
    const x = new Float64Array(k); x[0] = 1;
    for (let i = 0; i < periods.length; i++) {
      const w = 2 * Math.PI * h / periods[i];
      x[1 + 2 * i] = Math.cos(w); x[2 + 2 * i] = Math.sin(w);
    }
    for (let a = 0; a < k; a++) {
      g.Xty[a] += x[a] * y;
      for (let b = a; b < k; b++) g.XtX[a][b] += x[a] * x[b];
    }
    g.n++;
  });
  const dias = Array.from(porDia.values()).filter(g => g.n > 0);
  if (dias.length < 3) return null;
  dias.forEach(g => { for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) g.XtX[a][b] = g.XtX[b][a]; });

  const semente0 = isFinite(opts.seed) ? (opts.seed >>> 0) : 20240517;
  let semente = semente0;
  const prox = () => { semente = (Math.imul(semente, 1664525) + 1013904223) >>> 0; return semente / 4294967296; };

  const mesor = [], amp = [], acro = [];
  const XtX = Array.from({ length: k }, () => new Float64Array(k));
  const Xty = new Float64Array(k);
  const tau0 = periods[0];
  for (let b = 0; b < nBoot; b++) {
    for (let a = 0; a < k; a++) { Xty[a] = 0; XtX[a].fill(0); }
    for (let i = 0; i < dias.length; i++) {
      const g = dias[(prox() * dias.length) | 0];
      for (let a = 0; a < k; a++) {
        Xty[a] += g.Xty[a];
        const linha = XtX[a], gl = g.XtX[a];
        for (let c = 0; c < k; c++) linha[c] += gl[c];
      }
    }
    const beta = solveNormalEq(XtX, Xty);
    if (!beta) continue;
    const bc = beta[1], bs = beta[2];
    let ang = Math.atan2(-bs, bc);
    if (ang > 0) ang -= 2 * Math.PI;
    mesor.push(beta[0]);
    amp.push(Math.hypot(bc, bs));
    acro.push((-ang / (2 * Math.PI)) * tau0 % tau0);
  }
  if (!mesor.length) return null;
  const ci = a => [quantile(a, 0.025), quantile(a, 0.975)];
  return {
    nBoot: mesor.length, nBootRequested: nBoot, nDays: dias.length,
    nExcluded: nExcluidas, seed: semente0,
    method: 'bootstrap de blocos por dia inteiro sobre as equações normais (estimador idêntico ao reajuste completo)',
    mesorCI: ci(mesor), amplitudeCI: ci(amp), acrophaseCI: circCI(acro)
  };
}

export function circCI(hours) {
  const ang = hours.map(h => 2 * Math.PI * h / 24);
  const m = Math.atan2(mean(ang.map(Math.sin)), mean(ang.map(Math.cos)));
  const dev = ang.map(a => { let d = a - m; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; });
  const lo = quantile(dev, 0.025), hi = quantile(dev, 0.975);
  const w = x => ((x / (2 * Math.PI) * 24) % 24 + 24) % 24;
  return [w(m + lo), w(m + hi)];
}

/* Teste de Rayleigh (uniformidade circular) */

export function rayleigh(hours, period) {
  period = period || 24;
  const n = hours.length; if (n < 3) return null;
  const ang = hours.map(h => 2 * Math.PI * h / period);
  const C = mean(ang.map(Math.cos)), S = mean(ang.map(Math.sin));
  const R = Math.hypot(C, S);
  const z = n * R * R;
  const p = Math.exp(Math.sqrt(1 + 4 * n + 4 * (n * n - z * z)) - (1 + 2 * n));
  let mu = Math.atan2(S, C); if (mu < 0) mu += 2 * Math.PI;
  return { n, R, z, p: Math.min(1, p), meanHour: mu / (2 * Math.PI) * period };
}

/* Variância explicada pela hora do dia (ANOVA de 1 fator com bins) */

export function varianceByHour(rows, offMin, nBins) {
  nBins = nBins || 24;
  const groups = Array.from({ length: nBins }, () => []);
  rows.forEach(r => groups[Math.min(nBins - 1, Math.floor(localHour(r.t, offMin) / 24 * nBins))].push(r.lfp));
  const all = rows.map(r => r.lfp), gm = mean(all);
  let ssb = 0, ssw = 0, k = 0;
  groups.forEach(g => { if (!g.length) return; k++; const m = mean(g); ssb += g.length * (m - gm) ** 2; g.forEach(v => ssw += (v - m) ** 2); });
  const n = all.length, df1 = k - 1, df2 = n - k;
  const F = (ssb / df1) / (ssw / df2);
  return { eta2: ssb / (ssb + ssw), F, df1, df2, p: fPValue(F, df1, df2), k, n };
}

/* Perfil diurno: mediana por bin dentro do dia, depois mediana entre dias */

/* diurnalProfile(rows, offMin, binMin, detrendDaily)

   O 4º argumento aceita a forma antiga (booleano de detrending) ou um objeto
   `{ detrend, unit }`. A unidade do detrending é escolha de apresentação com
   consequência de leitura: `'percent'` põe a mediana do dia em 100 e é o que o
   clínico lê sem converter; `'ratio'` põe a mediana em 1, que é a convenção da
   literatura de ritmo circadiano de beta (van Rheede JJ, et al. npj Parkinsons
   Dis 2022;8:88, onde a barra de cor vai de 1 a 2). São o MESMO número em
   escalas diferentes, e a unidade usada sai no resultado para que a exportação
   não fique ambígua.                                                          */
export function diurnalProfile(rows, offMin, binMin, detrendDaily) {
  binMin = binMin || 30;
  const opts = (detrendDaily && typeof detrendDaily === 'object') ? detrendDaily : { detrend: !!detrendDaily };
  detrendDaily = !!opts.detrend;
  const escala = opts.unit === 'ratio' ? 1 : 100;
  const nBins = Math.round(24 * 60 / binMin);
  const byDay = {};
  rows.forEach(r => { const d = localDayKey(r.t, offMin); (byDay[d] = byDay[d] || []).push(r); });
  const days = Object.keys(byDay).sort();
  const matrix = [];                                       // dias × bins
  days.forEach(day => {
    const arr = new Array(nBins).fill(NaN);
    const buckets = Array.from({ length: nBins }, () => []);
    byDay[day].forEach(r => buckets[Math.min(nBins - 1, Math.floor(localHour(r.t, offMin) * 60 / binMin))].push(r.lfp));
    const dayMed = median(byDay[day].map(r => r.lfp));
    buckets.forEach((b, i) => { if (b.length) arr[i] = detrendDaily ? escala * median(b) / dayMed : median(b); });
    matrix.push({ day, values: arr, dayMedian: dayMed, n: byDay[day].length });
  });
  const profile = [], q1 = [], q3 = [];
  for (let i = 0; i < nBins; i++) {
    const col = matrix.map(m => m.values[i]).filter(isFinite);
    profile.push(col.length ? median(col) : NaN);
    q1.push(col.length ? quantile(col, 0.25) : NaN);
    q3.push(col.length ? quantile(col, 0.75) : NaN);
  }
  return {
    binMin, nBins, days, matrix, profile, q1, q3,
    detrended: detrendDaily, unit: detrendDaily ? (escala === 1 ? 'ratio' : 'percent') : 'raw',
    baseline: detrendDaily ? escala : NaN,
    hours: Array.from({ length: nBins }, (_, i) => (i + 0.5) * binMin / 60)
  };
}

/* Média alinhada a evento */
