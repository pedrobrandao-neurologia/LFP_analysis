/* dsp/bursts.js — detecção de bursts (dsp)
   Gerado do refactor modular (Prompt 0.1). Ver docs/arquitetura.md. */

import { mean, median, quantile, sum } from '../stats/descriptive.js';

export function detectBursts(env, fs, opts) {
  opts = opts || {};
  const pct = opts.percentile == null ? 75 : opts.percentile;
  const minMs = opts.minDurationMs == null ? 100 : opts.minDurationMs;
  const thr = (opts.threshold != null && isFinite(opts.threshold)) ? opts.threshold : quantile(Array.from(env), pct / 100);
  const minN = Math.round(minMs * fs / 1000);
  const bursts = []; let i = 0;
  while (i < env.length) {
    if (env[i] > thr) {
      const s = i; let peak = env[i];
      while (i < env.length && env[i] > thr) { if (env[i] > peak) peak = env[i]; i++; }
      const n = i - s;
      if (n >= minN) {
        let sum = 0; for (let k = s; k < i; k++) sum += env[k];
        bursts.push({ start: s / fs, end: i / fs, durationMs: n * 1000 / fs, peak, mean: sum / n });
      }
    } else i++;
  }
  const total = env.length / fs;
  return {
    threshold: thr, bursts,
    n: bursts.length,
    rate: bursts.length / total,
    meanDurationMs: mean(bursts.map(b => b.durationMs)),
    medianDurationMs: median(bursts.map(b => b.durationMs)),
    meanAmplitude: mean(bursts.map(b => b.mean)),
    probability: bursts.reduce((a, b) => a + (b.end - b.start), 0) / total,
    durationHistogram: burstHistogram(bursts)
  };
}

export function burstHistogram(bursts) {
  const edges = [200, 350, 500, 650, 800, Infinity];
  const labels = ['<200', '200–350', '350–500', '500–650', '650–800', '>800'];
  const counts = new Array(labels.length).fill(0);
  bursts.forEach(b => {
    for (let i = 0; i < edges.length; i++) if (b.durationMs < edges[i]) { counts[i]++; break; }
  });
  const tot = counts.reduce((a, b) => a + b, 0) || 1;
  return { labels, counts, pct: counts.map(c => 100 * c / tot) };
}

/* Parametrização espectral (aproximação de specparam/FOOOF) */
