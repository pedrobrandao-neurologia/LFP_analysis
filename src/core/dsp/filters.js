/* dsp/filters.js — passa-banda de fase zero e envelope de Hilbert (dsp)
   Gerado do refactor modular (Prompt 0.1). Ver docs/arquitetura.md. */

import { fft, nextPow2 } from './fft.js';

export function bandpassFFT(x, fs, lo, hi) {
  const n = nextPow2(x.length);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < x.length; i++) re[i] = x[i];
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
  return re.slice(0, x.length);
}

/* Envelope de Hilbert */

export function hilbertEnvelope(x) {
  const n = nextPow2(x.length);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < x.length; i++) re[i] = x[i];
  fft(re, im, false);
  for (let k = 1; k < n / 2; k++) { re[k] *= 2; im[k] *= 2; }
  for (let k = n / 2 + 1; k < n; k++) { re[k] = 0; im[k] = 0; }
  fft(re, im, true);
  const env = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) env[i] = Math.hypot(re[i], im[i]);
  return env;
}

/* Detecção de bursts sobre o envelope */
