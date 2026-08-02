/* dsp/filters.js — passa-banda de fase zero e envelope de Hilbert (dsp)
   Gerado do refactor modular (Prompt 0.1). Ver docs/arquitetura.md. */

import { fft, nextPow2 } from './fft.js';
import { interpolateForFilter, restoreNaN } from './nan.js';

/* Passa-banda de fase zero por FFT. Entrada e saída em µV.

   Tolerância a NaN (Onda 1): a FFT não aceita lacuna, então as posições
   faltantes são preenchidas por interpolação linear APENAS para viabilizar a
   filtragem e recebem NaN de volta na saída. A imputação é temporária e
   declarada: o array devolvido carrega `pctImputed`.                        */
export function bandpassFFT(x, fs, lo, hi) {
  const { filled, mask, pctImputed } = interpolateForFilter(x);
  const n = nextPow2(filled.length);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < filled.length; i++) re[i] = filled[i];
  fft(re, im, false);
  const df = fs / n;
  for (let k = 0; k <= n / 2; k++) {
    const f = k * df;
    if (f < lo || f > hi) {
      re[k] = im[k] = 0;
      if (k > 0 && k < n / 2) { re[n - k] = im[n - k] = 0; }
    }
  }
  fft(re, im, true);
  const out = re.slice(0, x.length);
  if (pctImputed) restoreNaN(out, mask);
  out.pctImputed = pctImputed;
  return out;
}

/* Envelope de Hilbert. Entrada e saída em µV. Mesma estratégia de imputação
   temporária declarada; o array devolvido carrega `pctImputed`.             */
export function hilbertEnvelope(x) {
  const { filled, mask, pctImputed } = interpolateForFilter(x);
  const n = nextPow2(filled.length);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < filled.length; i++) re[i] = filled[i];
  fft(re, im, false);
  for (let k = 1; k < n / 2; k++) { re[k] *= 2; im[k] *= 2; }
  for (let k = n / 2 + 1; k < n; k++) { re[k] = 0; im[k] = 0; }
  fft(re, im, true);
  const env = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) env[i] = Math.hypot(re[i], im[i]);
  if (pctImputed) restoreNaN(env, mask);
  env.pctImputed = pctImputed;
  return env;
}

/* Detecção de bursts sobre o envelope */
