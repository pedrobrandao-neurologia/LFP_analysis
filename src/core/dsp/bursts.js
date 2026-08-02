/* dsp/bursts.js — detecção de bursts (dsp)
   Gerado do refactor modular (Prompt 0.1). Ver docs/arquitetura.md. */

import { mean, median, quantile, sum } from '../stats/descriptive.js';

/* Detecção de bursts sobre o envelope. Entrada em µV, durações em ms.

   Tolerância a NaN (Onda 1): nenhum burst pode começar, terminar ou ATRAVESSAR
   uma lacuna. Um burst encostado numa lacuna recebe `truncated: true` — sua
   duração real é desconhecida, então ele entra na contagem mas fica FORA das
   estatísticas de duração e de amplitude, com o n de truncados reportado.   */
export function detectBursts(env, fs, opts) {
  opts = opts || {};
  const pct = opts.percentile == null ? 75 : opts.percentile;
  const minMs = opts.minDurationMs == null ? 100 : opts.minDurationMs;
  const thr = (opts.threshold != null && isFinite(opts.threshold)) ? opts.threshold : quantile(Array.from(env), pct / 100);
  const minN = Math.round(minMs * fs / 1000);
  const bursts = []; let i = 0, nNaN = 0;
  for (let k = 0; k < env.length; k++) if (!isFinite(env[k])) nNaN++;
  while (i < env.length) {
    if (isFinite(env[i]) && env[i] > thr) {
      const s = i; let peak = env[i];
      /* a lacuna interrompe o burst: a varredura para no primeiro NaN */
      while (i < env.length && isFinite(env[i]) && env[i] > thr) { if (env[i] > peak) peak = env[i]; i++; }
      const n = i - s;
      /* encostou numa lacuna (antes ou depois)? então a duração é incerta */
      const truncated = (s > 0 && !isFinite(env[s - 1])) || (i < env.length && !isFinite(env[i]));
      if (n >= minN) {
        let soma = 0; for (let k = s; k < i; k++) soma += env[k];
        bursts.push({ start: s / fs, end: i / fs, durationMs: n * 1000 / fs, peak, mean: soma / n, truncated });
      }
    } else i++;
  }
  /* tempo analisável exclui as lacunas — usar o total infla a taxa e a
     probabilidade de burst justamente nos registros mais degradados */
  const totalAnalisavel = (env.length - nNaN) / fs;
  const total = env.length / fs;
  const bons = bursts.filter(b => !b.truncated);
  const nTruncados = bursts.length - bons.length;
  return {
    threshold: thr, bursts,
    n: bursts.length,
    rate: totalAnalisavel > 0 ? bursts.length / totalAnalisavel : NaN,
    meanDurationMs: mean(bons.map(b => b.durationMs)),
    medianDurationMs: median(bons.map(b => b.durationMs)),
    meanAmplitude: mean(bons.map(b => b.mean)),
    probability: totalAnalisavel > 0
      ? bons.reduce((a, b) => a + (b.end - b.start), 0) / totalAnalisavel : NaN,
    durationHistogram: burstHistogram(bons),
    nTruncatedByGap: nTruncados,
    pctNan: env.length ? 100 * nNaN / env.length : 0,
    analyzableSeconds: totalAnalisavel, totalSeconds: total
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
