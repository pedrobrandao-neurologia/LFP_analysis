/* stats/events.js — média alinhada a evento e permutação (stats)
   Gerado do refactor modular (Prompt 0.1). Ver docs/arquitetura.md. */

import { mean, median, quantile } from './descriptive.js';

export function eventAligned(rows, eventTimes, preMin, postMin, binMin, normalize) {
  preMin = preMin || 60; postMin = postMin || 180; binMin = binMin || 10;
  const nBins = Math.round((preMin + postMin) / binMin) + 1;
  const offsets = Array.from({ length: nBins }, (_, i) => -preMin + i * binMin);
  const trials = [];
  eventTimes.forEach(et => {
    const arr = new Array(nBins).fill(NaN);
    rows.forEach(r => {
      const dm = (r.t - et) / 60000;
      if (dm < -preMin - binMin / 2 || dm > postMin + binMin / 2) return;
      const i = Math.round((dm + preMin) / binMin);
      if (i >= 0 && i < nBins) arr[i] = r.lfp;
    });
    if (arr.filter(isFinite).length >= nBins * 0.4) {
      if (normalize) {
        const base = arr.slice(0, Math.round(preMin / binMin)).filter(isFinite);
        const bm = median(base);
        if (isFinite(bm) && bm !== 0) for (let i = 0; i < nBins; i++) arr[i] = 100 * arr[i] / bm;
      }
      trials.push({ t: et, values: arr });
    }
  });
  const m = [], lo = [], hi = [];
  for (let i = 0; i < nBins; i++) {
    const col = trials.map(t => t.values[i]).filter(isFinite);
    m.push(col.length ? median(col) : NaN);
    lo.push(col.length ? quantile(col, 0.25) : NaN);
    hi.push(col.length ? quantile(col, 0.75) : NaN);
  }
  return { offsets, trials, median: m, q1: lo, q3: hi, nTrials: trials.length };
}

/* Teste de permutação para comparar duas curvas/amostras */

export function permutationTest(a, b, nPerm) {
  nPerm = nPerm || 5000;
  const obs = Math.abs(mean(a) - mean(b));
  const pool = a.concat(b); let count = 0;
  for (let i = 0; i < nPerm; i++) {
    const s = pool.slice();
    for (let j = s.length - 1; j > 0; j--) { const k = (Math.random() * (j + 1)) | 0;[s[j], s[k]] = [s[k], s[j]]; }
    if (Math.abs(mean(s.slice(0, a.length)) - mean(s.slice(a.length))) >= obs) count++;
  }
  return { observed: obs, p: (count + 1) / (nPerm + 1), nPerm };
}

/* ECDF e proporções vs limiares de aDBS */
