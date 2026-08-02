/* dsp/aperiodic.js — parametrização aperiódica — specparam/FOOOF (dsp)
   Gerado do refactor modular (Prompt 0.1). Ver docs/arquitetura.md. */

import { bandOf } from './spectral.js';
import { linreg, sd, variance } from '../stats/descriptive.js';

export function fitAperiodic(f, p, opts) {
  opts = opts || {};
  const fmin = opts.fmin || 2, fmax = opts.fmax || 95;
  const idx = [];
  for (let i = 0; i < f.length; i++)
    if (f[i] >= fmin && f[i] <= fmax && p[i] > 0 && isFinite(p[i])) idx.push(i);
  if (idx.length < 8) return null;
  let lx = idx.map(i => Math.log10(f[i])), ly = idx.map(i => Math.log10(p[i]));
  let keep = idx.map(() => true);
  let a = 0, b = 0;
  for (let it = 0; it < 6; it++) {                    // ajuste robusto iterativo
    const X = [], Y = [];
    for (let i = 0; i < lx.length; i++) if (keep[i]) { X.push(lx[i]); Y.push(ly[i]); }
    const r = linreg(X, Y); a = r.intercept; b = r.slope;
    const res = lx.map((v, i) => ly[i] - (a + b * v));
    const kept = res.filter((_, i) => keep[i]);
    const sd = Math.sqrt(variance(kept)) || 1e-9;
    let changed = false;
    for (let i = 0; i < res.length; i++) {
      const k = res[i] < 1.0 * sd;                    // remove picos (resíduo positivo)
      if (k !== keep[i]) changed = true;
      keep[i] = k;
    }
    if (!changed) break;
  }
  const model = idx.map((i, k) => Math.pow(10, a + b * lx[k]));
  const resid = idx.map((i, k) => p[i] - model[k]);
  const peaks = findPeaks(idx.map(i => f[i]), resid, opts.minPeakHeight || 0);
  const ss = idx.map((i, k) => Math.pow(ly[k] - (a + b * lx[k]), 2)).reduce((x, y) => x + y, 0);
  const st = variance(ly) * ly.length;
  return {
    offset: a, exponent: -b, r2: 1 - ss / (st || 1),
    f: idx.map(i => f[i]), observed: idx.map(i => p[i]), aperiodic: model, periodic: resid, peaks
  };
}

export function findPeaks(f, y, minH) {
  const out = [];
  for (let i = 1; i < y.length - 1; i++) {
    if (y[i] > y[i - 1] && y[i] >= y[i + 1] && y[i] > minH) {
      let l = i; while (l > 0 && y[l] > y[i] / 2) l--;
      let r = i; while (r < y.length - 1 && y[r] > y[i] / 2) r++;
      out.push({ cf: f[i], power: y[i], bw: f[r] - f[l], band: bandOf(f[i]) });
    }
  }
  return out.sort((a, b) => b.power - a.power).slice(0, 6);
}

/* Remoção de artefato cardíaco por subtração de template (QRS) */
