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

export function olsSolve(X, y) {                        // normal equations + Gauss-Jordan
  const k = X[0].length, n = X.length;
  const A = Array.from({ length: k }, () => new Float64Array(k + 1));
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) { let s = 0; for (let r = 0; r < n; r++) s += X[r][i] * X[r][j]; A[i][j] = s; }
    let s = 0; for (let r = 0; r < n; r++) s += X[r][i] * y[r]; A[i][k] = s;
  }
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

/* Bootstrap por blocos (dia) para IC dos parâmetros do cosinor */

export function cosinorBootstrap(rows, periods, nBoot, offMin) {
  nBoot = nBoot || 400;
  const byDay = {};
  rows.forEach(r => { const d = localDayKey(r.t, offMin); (byDay[d] = byDay[d] || []).push(r); });
  const days = Object.keys(byDay);
  if (days.length < 3) return null;
  const mesor = [], amp = [], acro = [];
  for (let b = 0; b < nBoot; b++) {
    const samp = [];
    for (let i = 0; i < days.length; i++) samp.push(...byDay[days[(Math.random() * days.length) | 0]]);
    const c = cosinor(samp.map(r => localHour(r.t, offMin)), samp.map(r => r.lfp), periods);
    if (!c) continue;
    mesor.push(c.mesor); amp.push(c.components[0].amplitude); acro.push(c.components[0].acrophaseHours);
  }
  const ci = a => [quantile(a, 0.025), quantile(a, 0.975)];
  return { nBoot: mesor.length, nDays: days.length, mesorCI: ci(mesor), amplitudeCI: ci(amp), acrophaseCI: circCI(acro) };
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

export function diurnalProfile(rows, offMin, binMin, detrendDaily) {
  binMin = binMin || 30;
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
    buckets.forEach((b, i) => { if (b.length) arr[i] = detrendDaily ? 100 * median(b) / dayMed : median(b); });
    matrix.push({ day, values: arr, dayMedian: dayMed, n: byDay[day].length });
  });
  const profile = [], q1 = [], q3 = [];
  for (let i = 0; i < nBins; i++) {
    const col = matrix.map(m => m.values[i]).filter(isFinite);
    profile.push(col.length ? median(col) : NaN);
    q1.push(col.length ? quantile(col, 0.25) : NaN);
    q3.push(col.length ? quantile(col, 0.75) : NaN);
  }
  return { binMin, nBins, days, matrix, profile, q1, q3, hours: Array.from({ length: nBins }, (_, i) => (i + 0.5) * binMin / 60) };
}

/* Média alinhada a evento */
