/* dsp/notch.js — filtro notch de rede, de fase zero, no domínio da frequência.

   Coerente com bandpassFFT: mesma estratégia (FFT → zerar faixa → IFFT), mesmo
   tratamento de lacunas (imputação temporária declarada, NaN reposto na saída).

   Referência do item: Swinnen et al., J Neural Eng 2025 (checklist).
   Unidades: x em µV, fs em Hz, saída em µV.                                  */

import { fft, nextPow2 } from './fft.js';
import { interpolateForFilter, restoreNaN } from './nan.js';
import { welchPSD } from './spectral.js';

/* notchFFT(x, fs, {freq, harmonics, halfWidth})
   Remove `freq` e seus harmônicos até Nyquist.                                */
export function notchFFT(x, fs, opts) {
  opts = opts || {};
  const f0 = isFinite(opts.freq) ? opts.freq : 60;
  const nHarm = isFinite(opts.harmonics) ? opts.harmonics : 4;
  const hw = isFinite(opts.halfWidth) ? opts.halfWidth : 1.0;   // ±1 Hz
  const { filled, mask, pctImputed } = interpolateForFilter(x);
  const n = nextPow2(filled.length);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < filled.length; i++) re[i] = filled[i];
  fft(re, im, false);
  const df = fs / n;
  const alvos = [];
  for (let h = 1; h <= nHarm; h++) { const f = h * f0; if (f < fs / 2) alvos.push(f); }
  for (let k = 0; k <= n / 2; k++) {
    const f = k * df;
    if (alvos.some(a => Math.abs(f - a) <= hw)) {
      re[k] = im[k] = 0;
      if (k > 0 && k < n / 2) { re[n - k] = im[n - k] = 0; }
    }
  }
  fft(re, im, true);
  const out = re.slice(0, x.length);
  if (pctImputed) restoreNaN(out, mask);
  out.pctImputed = pctImputed;
  out.notchedFrequencies = alvos;
  return out;
}

/* suggestLineFrequency(x, fs) — compara a potência em 50 e 60 Hz e sugere a
   frequência de rede. Reporta as duas, para o usuário decidir com evidência. */
export function suggestLineFrequency(x, fs) {
  const w = welchPSD(x, fs, { nperseg: Math.min(2048, nextPow2(x.length)), overlap: .5 });
  if (!w.p) return { suggestion: null, reason: w.reason || 'espectro não estimável' };
  const potEm = alvo => {
    let s = 0, n = 0;
    for (let i = 0; i < w.f.length; i++)
      if (Math.abs(w.f[i] - alvo) <= 1 && isFinite(w.p[i])) { s += w.p[i]; n++; }
    return n ? s / n : NaN;
  };
  const vizinhanca = alvo => {
    let s = 0, n = 0;
    for (let i = 0; i < w.f.length; i++) {
      const d = Math.abs(w.f[i] - alvo);
      if (d >= 3 && d <= 8 && isFinite(w.p[i])) { s += w.p[i]; n++; }
    }
    return n ? s / n : NaN;
  };
  const r50 = potEm(50) / (vizinhanca(50) || NaN);
  const r60 = potEm(60) / (vizinhanca(60) || NaN);
  const claro = (r, outro) => isFinite(r) && r > 2 && (!isFinite(outro) || r > outro * 1.5);
  const sugestao = claro(r50, r60) ? 50 : claro(r60, r50) ? 60 : null;
  return {
    suggestion: sugestao,
    ratio50: isFinite(r50) ? +r50.toFixed(2) : NaN,
    ratio60: isFinite(r60) ? +r60.toFixed(2) : NaN,
    reason: sugestao
      ? `pico de rede em ${sugestao} Hz destacado ${(sugestao === 50 ? r50 : r60).toFixed(1)}× sobre a vizinhança`
      : 'nenhum pico de rede claramente destacado — o notch pode ser desnecessário'
  };
}
