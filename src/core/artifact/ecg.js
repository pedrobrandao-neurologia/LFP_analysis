/* artifact/ecg.js — remoção de artefato cardíaco (artifact)
   Gerado do refactor modular (Prompt 0.1). Ver docs/arquitetura.md. */

import { bandpassFFT, hilbertEnvelope } from '../dsp/filters.js';
import { mean, median, quantile } from '../stats/descriptive.js';

export function ecgTemplateSubtract(x, fs) {
  const bp = bandpassFFT(x, fs, 5, 30);
  const env = hilbertEnvelope(bp);
  const thr = quantile(Array.from(env), 0.98);
  const refractory = Math.round(0.4 * fs);
  const peaks = [];
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i] > thr && env[i] >= env[i - 1] && env[i] > env[i + 1]) {
      if (!peaks.length || i - peaks[peaks.length - 1] > refractory) peaks.push(i);
    }
  }
  const half = Math.round(0.25 * fs);
  const usable = peaks.filter(p => p - half >= 0 && p + half < x.length);
  if (usable.length < 8) return { cleaned: Float64Array.from(x), nBeats: usable.length, bpm: NaN, applied: false };
  const tpl = new Float64Array(2 * half + 1);
  usable.forEach(p => { for (let k = -half; k <= half; k++) tpl[k + half] += x[p + k]; });
  for (let k = 0; k < tpl.length; k++) tpl[k] /= usable.length;
  const m = mean(Array.from(tpl)); for (let k = 0; k < tpl.length; k++) tpl[k] -= m;
  const out = Float64Array.from(x);
  usable.forEach(p => { for (let k = -half; k <= half; k++) out[p + k] -= tpl[k + half]; });
  const rr = []; for (let i = 1; i < usable.length; i++) rr.push((usable[i] - usable[i - 1]) / fs);
  return { cleaned: out, nBeats: usable.length, bpm: 60 / (median(rr) || NaN), template: tpl, peaks: usable, applied: true };
}
