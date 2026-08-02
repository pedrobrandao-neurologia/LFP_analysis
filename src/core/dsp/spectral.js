/* dsp/spectral.js — PSD de Welch, espectrograma e bandas (dsp)
   Gerado do refactor modular (Prompt 0.1). Ver docs/arquitetura.md. */

import { detrendLinear, fft, hann, nextPow2 } from './fft.js';

export function welchPSD(x, fs, opts) {
  opts = opts || {};
  const nper = opts.nperseg || Math.min(nextPow2(Math.floor(fs)), nextPow2(x.length));
  const nfft = nextPow2(nper);
  const overlap = opts.overlap == null ? 0.5 : opts.overlap;
  const step = Math.max(1, Math.floor(nper * (1 - overlap)));
  const w = hann(nper);
  let U = 0; for (let i = 0; i < nper; i++) U += w[i] * w[i];
  U *= fs;
  const nBins = nfft / 2 + 1;
  const acc = new Float64Array(nBins);
  let segs = 0;
  for (let s = 0; s + nper <= x.length; s += step) {
    const seg = detrendLinear(x.subarray ? x.subarray(s, s + nper) : x.slice(s, s + nper));
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    for (let i = 0; i < nper; i++) re[i] = seg[i] * w[i];
    fft(re, im, false);
    for (let k = 0; k < nBins; k++) {
      const mag = (re[k] * re[k] + im[k] * im[k]) / U;
      acc[k] += (k === 0 || k === nBins - 1) ? mag : 2 * mag;
    }
    segs++;
  }
  if (!segs) return { f: [], p: [], segments: 0 };
  const f = new Float64Array(nBins), p = new Float64Array(nBins);
  for (let k = 0; k < nBins; k++) { f[k] = k * fs / nfft; p[k] = acc[k] / segs; }
  return { f, p, segments: segs, nperseg: nper, df: fs / nfft };
}

/* Espectrograma (STFT) */

export function spectrogram(x, fs, opts) {
  opts = opts || {};
  const win = opts.window || nextPow2(fs);            // ~1 s
  const hop = opts.hop || Math.floor(win / 4);
  const fmax = opts.fmax || 100;
  const w = hann(win);
  let U = 0; for (let i = 0; i < win; i++) U += w[i] * w[i]; U *= fs;
  const nBins = win / 2 + 1;
  const kMax = Math.min(nBins - 1, Math.floor(fmax * win / fs));
  const cols = [], times = [];
  for (let s = 0; s + win <= x.length; s += hop) {
    const seg = detrendLinear(x.subarray ? x.subarray(s, s + win) : x.slice(s, s + win));
    const re = new Float64Array(win), im = new Float64Array(win);
    for (let i = 0; i < win; i++) re[i] = seg[i] * w[i];
    fft(re, im, false);
    const col = new Float64Array(kMax + 1);
    for (let k = 0; k <= kMax; k++) col[k] = 2 * (re[k] * re[k] + im[k] * im[k]) / U;
    cols.push(col); times.push((s + win / 2) / fs);
  }
  const f = new Float64Array(kMax + 1);
  for (let k = 0; k <= kMax; k++) f[k] = k * fs / win;
  return { t: times, f, S: cols };
}

/* Filtro passa-banda de fase zero via FFT */

export const BANDS = [
  { key: 'delta', label: 'δ', lo: 1, hi: 4, color: '#3B3F73' },
  { key: 'theta', label: 'θ', lo: 4, hi: 8, color: '#2F6E8E' },
  { key: 'alpha', label: 'α', lo: 8, hi: 13, color: '#2E8B7A' },
  { key: 'lowbeta', label: 'β↓', lo: 13, hi: 20, color: '#B8912A' },
  { key: 'highbeta', label: 'β↑', lo: 20, hi: 35, color: '#C4652B' },
  { key: 'gamma', label: 'γ', lo: 35, hi: 100, color: '#8E3B4E' }
];

export function bandOf(f) { const b = BANDS.find(b => f >= b.lo && f < b.hi); return b ? b.key : '—'; }

export function bandPower(f, p, lo, hi) {
  let s = 0, n = 0;
  for (let i = 0; i < f.length; i++) if (f[i] >= lo && f[i] <= hi) { s += p[i]; n++; }
  return n ? s * (f[1] - f[0]) : NaN;
}

export function bandTable(f, p) {
  const tot = bandPower(f, p, 1, 100);
  return BANDS.map(b => {
    const abs = bandPower(f, p, b.lo, b.hi);
    let peakF = NaN, peakV = -Infinity;
    for (let i = 0; i < f.length; i++) if (f[i] >= b.lo && f[i] <= b.hi && p[i] > peakV) { peakV = p[i]; peakF = f[i]; }
    return { ...b, absolute: abs, relative: 100 * abs / tot, peakF, peakV };
  });
}

/* ======================================================================== */
/*  3. ESTATÍSTICA                                                           */
/* ======================================================================== */
