/* dsp/spectral.js — PSD de Welch, espectrograma e bandas (dsp)
   Gerado do refactor modular (Prompt 0.1). Ver docs/arquitetura.md. */

import { fft, hann, nextPow2 } from './fft.js';
import { fftAny } from './bluestein.js';
import { detrendLinearNaN, segmentsWithoutNan, nanStats } from './nan.js';

/* PSD de Welch (Hann, sobreposição 50%, detrend linear por segmento).
   Entrada em µV, saída em µV²/Hz.

   Tolerância a NaN (Onda 1): segmentos cuja fração de NaN excede maxNanPct
   (default 0 — qualquer NaN descarta o segmento) são DESCARTADOS, nunca
   preenchidos. Se sobrarem menos de 3 segmentos válidos, `p` volta como null
   com um motivo legível, em vez de um espectro que parece válido e não é.

   Nota sobre maxNanPct > 0: nesse caso o segmento é aceito e as posições
   faltantes entram como zero após o detrend, o que é uma imputação implícita —
   por isso o default é 0. Use tolerância apenas de forma deliberada, e leia
   `pctNan` e `pctDataUsed` junto com o resultado. Perda de pacote real é
   contígua (pacotes inteiros), então o descarte estrito costuma preservar a
   maior parte dos segmentos.

   opts.nfft (Onda 13): força o comprimento da transformada. Por padrão o NFFT
   é arredondado para a próxima potência de 2 — mais rápido, e a diferença de
   resolução é irrelevante para leitura por banda. Quando um protocolo publicado
   especifica um NFFT que não é potência de 2 (por exemplo 1000 pontos a 250 Hz,
   que dá exatamente 0,25 Hz), passar `nfft` reproduz o número publicado usando
   a transformada de Bluestein, que aceita qualquer comprimento.               */
export function welchPSD(x, fs, opts) {
  opts = opts || {};
  const nper = opts.nperseg || Math.min(nextPow2(Math.floor(fs)), nextPow2(x.length));
  const nfft = opts.nfft ? Math.max(nper, Math.round(opts.nfft)) : nextPow2(nper);
  const potencia2 = (nfft & (nfft - 1)) === 0;
  const overlap = opts.overlap == null ? 0.5 : opts.overlap;
  const step = Math.max(1, Math.floor(nper * (1 - overlap)));
  const maxNanPct = isFinite(opts.maxNanPct) ? opts.maxNanPct : 0;
  const w = hann(nper);
  let U = 0; for (let i = 0; i < nper; i++) U += w[i] * w[i];
  U *= fs;
  const nBins = Math.floor(nfft / 2) + 1;
  const acc = new Float64Array(nBins);

  const sel = segmentsWithoutNan(x, nper, step, maxNanPct);
  const est = nanStats(x);
  let segs = 0;
  for (const s of sel.starts) {
    const seg = detrendLinearNaN(x.subarray ? x.subarray(s, s + nper) : x.slice(s, s + nper));
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    for (let i = 0; i < nper; i++) re[i] = isFinite(seg[i]) ? seg[i] * w[i] : 0;
    if (potencia2) fft(re, im, false); else fftAny(re, im, false);
    /* o bin 0 e — só quando NFFT é par — o bin de Nyquist não têm par
       espelhado; com NFFT ímpar o último bin TEM par e também dobra */
    const nyq = nfft % 2 === 0 ? nfft / 2 : -1;
    for (let k = 0; k < nBins; k++) {
      const mag = (re[k] * re[k] + im[k] * im[k]) / U;
      acc[k] += (k === 0 || k === nyq) ? mag : 2 * mag;
    }
    segs++;
  }
  const meta = {
    segments: segs, nSegments: segs, nSegmentsDropped: sel.dropped,
    nperseg: nper, nfft, df: fs / nfft,
    pctDataUsed: sel.total ? 100 * segs / sel.total : 0,
    pctNan: est.pctNan
  };
  if (segs < 3) return Object.assign({
    f: [], p: null,
    reason: sel.total === 0
      ? 'registro curto demais para um único segmento de Welch'
      : `apenas ${segs} de ${sel.total} segmentos sem lacuna (${est.pctNan.toFixed(1)}% de dados faltantes) — insuficiente para estimar o espectro`
  }, meta);
  const f = new Float64Array(nBins), p = new Float64Array(nBins);
  for (let k = 0; k < nBins; k++) { f[k] = k * fs / nfft; p[k] = acc[k] / segs; }
  return Object.assign({ f, p, reason: null }, meta);
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
  let nColsNaN = 0;
  for (let s = 0; s + win <= x.length; s += hop) {
    /* coluna que contém lacuna vira NaN (não zero): a plotagem mostra o buraco
       como buraco, e não como silêncio espectral */
    let temNaN = false;
    for (let i = s; i < s + win; i++) if (!isFinite(x[i])) { temNaN = true; break; }
    const col = new Float64Array(kMax + 1);
    if (temNaN) {
      col.fill(NaN); nColsNaN++;
    } else {
      const seg = detrendLinearNaN(x.subarray ? x.subarray(s, s + win) : x.slice(s, s + win));
      const re = new Float64Array(win), im = new Float64Array(win);
      for (let i = 0; i < win; i++) re[i] = seg[i] * w[i];
      fft(re, im, false);
      for (let k = 0; k <= kMax; k++) col[k] = 2 * (re[k] * re[k] + im[k] * im[k]) / U;
    }
    cols.push(col); times.push((s + win / 2) / fs);
  }
  const f = new Float64Array(kMax + 1);
  for (let k = 0; k <= kMax; k++) f[k] = k * fs / win;
  return { t: times, f, S: cols, nColumns: cols.length, nColumnsNaN: nColsNaN };
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
