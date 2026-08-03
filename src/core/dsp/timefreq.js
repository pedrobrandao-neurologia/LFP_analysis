/* dsp/timefreq.js — análise tempo-frequência no padrão do BRAVO.

   O QUE É E DE ONDE VEM. O BRAVO (Fixel Institute, v3.1.0-alpha) calcula os
   espectrogramas em Python com `scipy`, num servidor, e desenha com Plotly.
   Este módulo porta o mesmo conjunto de métodos para JavaScript de navegador
   puro — sem servidor, sem rede, sem `scipy` — mantendo os parâmetros e as
   convenções de escala para que a comparação entre os dois softwares seja
   ponto a ponto, e não "parecida".

   OS CINCO MÉTODOS, E A PERGUNTA QUE CADA UM RESPONDE
     · welch    — periodograma de Welch por época. Padrão do BRAVO. Estimador
                  de menor variância; é o que se usa quando a pergunta é
                  "quanta potência há nesta banda ao longo do tempo".
     · stft     — equivalente a `scipy.signal.spectrogram` com janela Hamming.
                  Menos suavizado que o Welch, preserva melhor transientes.
     · percept  — emulação do cálculo que o próprio neuroestimulador faz a
                  bordo. É o único modo que permite conferir o que o aparelho
                  reportou contra o que o sinal bruto diz.
     · wavelet  — CWT de Morlet: resolução temporal que acompanha a
                  frequência, apropriada para rajadas curtas de beta.
     · ar       — modelo autorregressivo (Yule-Walker) com ordem por BIC.
                  Espectro liso e picos estreitos com janelas curtas; a
                  contrapartida é que a forma do espectro é imposta pelo
                  modelo, não medida.

   ESCALA. Todos os métodos paramétricos de FFT devolvem DENSIDADE espectral de
   potência unilateral na convenção do `scipy.signal.welch`:

       PSD[k] = |X[k]|² / (fs · Σₙ w[n]²)      × 2 para k ∉ {0, Nyquist}

   O fator 2 recolhe a energia da frequência negativa; DC e Nyquist não têm par
   e ficam sem ele. A soma dos quadrados da janela é sobre a JANELA (nperseg),
   não sobre o comprimento com zeros — completar com zeros aumenta a resolução
   aparente, não a energia.

   JANELA PERIÓDICA vs SIMÉTRICA. O `scipy.signal.get_window` devolve janela
   PERIÓDICA (`sym=False`) por padrão, que é a correta para análise espectral:
   w[n] = 0,5 − 0,5·cos(2πn/N). A simétrica, w[n] = 0,5 − 0,5·cos(2πn/(N−1)),
   é a do `numpy.hanning` e a que a Medtronic usa na emulação de bordo. As duas
   estão aqui com nomes diferentes de propósito: trocar uma pela outra muda a
   potência estimada em fração de porcento, o suficiente para uma comparação
   entre softwares não fechar e ninguém descobrir por quê.

   DADOS FALTANTES. Época que contém amostra faltante acima da tolerância NÃO é
   calculada: sai NaN, marcada, e a fração faltante vai junto. Preencher a
   lacuna com zero e desenhar o resultado como potência válida seria inventar
   um número — e é justamente nas perdas de pacote que o espectro mente mais.

   Unidades: entrada em µV; PSD em µV²/Hz; `percept` em magnitude (µV), não
   potência, porque é o que o aparelho reporta.

   Referências:
     Welch PD. IEEE Trans Audio Electroacoust 1967;15:70-3.
     Harris FJ. Proc IEEE 1978;66:51-83 (janelas e ganhos coerente/incoerente).
     Kay SM. Modern Spectral Estimation, Prentice Hall 1988 (Yule-Walker, BIC).
     Fixel Institute. BRAVO v3.1.0-alpha, SignalProcessingUtility.py.          */

import { fft, nextPow2 } from './fft.js';
import { fftAny } from './bluestein.js';
import { morletCWT } from './wavelet.js';
import { median, mean, quantile } from '../stats/descriptive.js';

/* ------------------------------------------------------------- janelas --- */

/* Periódicas — convenção do scipy.signal.get_window(sym=False) */
export function hannPeriodic(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  return w;
}
export function hammingPeriodic(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / n);
  return w;
}
/* Simétrica — convenção do numpy.hanning, usada na emulação Medtronic */
export function hannSymmetric(n) {
  const w = new Float64Array(n);
  if (n === 1) { w[0] = 1; return w; }
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  return w;
}
export const WINDOWS = {
  'hann-periodic': hannPeriodic, 'hamming-periodic': hammingPeriodic,
  'hann-symmetric': hannSymmetric
};

/* ----------------------------------------------------- utilidades base --- */

const contaFaltantes = (x, a, b) => {
  let n = 0;
  for (let i = a; i < b; i++) if (!isFinite(x[i])) n++;
  return n / Math.max(1, b - a);
};

/* remove média e tendência linear ignorando não-finitos */
function detrendEpoca(x, a, b, modo) {
  const n = b - a;
  const out = new Float64Array(n);
  if (modo === 'none') { for (let i = 0; i < n; i++) out[i] = isFinite(x[a + i]) ? x[a + i] : 0; return out; }
  let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
  for (let i = 0; i < n; i++) {
    const v = x[a + i];
    if (!isFinite(v)) continue;
    sx += i; sy += v; sxx += i * i; sxy += i * v; m++;
  }
  if (m < 2) return out;
  if (modo === 'constant') {
    const mu = sy / m;
    for (let i = 0; i < n; i++) out[i] = isFinite(x[a + i]) ? x[a + i] - mu : 0;
    return out;
  }
  const den = m * sxx - sx * sx;
  const inc = den ? (m * sxy - sx * sy) / den : 0;
  const b0 = (sy - inc * sx) / m;
  for (let i = 0; i < n; i++) out[i] = isFinite(x[a + i]) ? x[a + i] - (b0 + inc * i) : 0;
  return out;
}

/* Periodograma de UMA época com escala de densidade do scipy. */
function periodograma(seg, w, nfft, fs, U) {
  const nper = seg.length;
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  for (let i = 0; i < nper; i++) re[i] = seg[i] * w[i];
  fftAny(re, im, false);
  const nBins = Math.floor(nfft / 2) + 1;
  const p = new Float64Array(nBins);
  const par = nfft % 2 === 0;
  for (let k = 0; k < nBins; k++) {
    const mag = (re[k] * re[k] + im[k] * im[k]) / U;
    const ultimo = par && k === nBins - 1;
    p[k] = (k === 0 || ultimo) ? mag : 2 * mag;
  }
  return p;
}

const eixoFreq = (nfft, fs) => {
  const nBins = Math.floor(nfft / 2) + 1;
  const f = new Float64Array(nBins);
  for (let k = 0; k < nBins; k++) f[k] = k * fs / nfft;
  return f;
};

/* Resolve os parâmetros comuns e devolve a grade de épocas. */
function grade(x, fs, opts) {
  const janelaS = opts.windowS == null ? 1.0 : opts.windowS;
  const sobrepS = opts.overlapS == null ? 0.5 : opts.overlapS;
  const resHz = opts.freqRes == null ? 0.5 : opts.freqRes;
  const nper = Math.max(8, Math.round(janelaS * fs));
  const passo = Math.max(1, Math.round((janelaS - sobrepS) * fs));
  /* NFFT = round(fs / resolução), como no BRAVO — nunca menor que a janela,
     porque completar com zeros interpola, mas truncar perderia amostra */
  const nfft = Math.max(nper, Math.round(fs / resHz));
  const inicios = [];
  for (let s = 0; s + nper <= x.length; s += passo) inicios.push(s);
  return { janelaS, sobrepS, resHz, nper, passo, nfft, inicios };
}

/* --------------------------------------------------- 1. Welch por época --- */

/* Welch dentro de cada época: a época é subdividida em segmentos de
   `subWindowS` com 50% de sobreposição e as PSDs são promediadas. Com o padrão
   do BRAVO (subjanela = janela) sobra um único segmento e o método degenera no
   periodograma — que é exatamente o que o BRAVO faz. Subjanela menor troca
   resolução de frequência por variância menor.                              */
export function spectrogramWelch(x, fs, opts) {
  opts = opts || {};
  const g = grade(x, fs, opts);
  if (!g.inicios.length) return { ok: false, reason: `sinal curto demais: ${x.length} amostras para janela de ${g.nper}` };
  const subN = Math.max(8, Math.min(g.nper, Math.round((opts.subWindowS || opts.windowS || 1.0) * fs)));
  const subPasso = Math.max(1, Math.floor(subN / 2));
  const w = hannPeriodic(subN);
  let U = 0; for (let i = 0; i < subN; i++) U += w[i] * w[i];
  U *= fs;
  const f = eixoFreq(g.nfft, fs);
  const tol = opts.maxMissingFrac == null ? 0 : opts.maxMissingFrac;
  const cols = [], falta = new Float64Array(g.inicios.length), marca = new Uint8Array(g.inicios.length);
  g.inicios.forEach((s, ci) => {
    const fr = contaFaltantes(x, s, s + g.nper);
    falta[ci] = fr;
    if (fr > tol) { marca[ci] = 1; cols.push(new Float64Array(f.length).fill(NaN)); return; }
    const acc = new Float64Array(f.length);
    let nSeg = 0;
    for (let o = 0; o + subN <= g.nper; o += subPasso) {
      const seg = detrendEpoca(x, s + o, s + o + subN, opts.detrend || 'constant');
      const p = periodograma(seg, w, g.nfft, fs, U);
      for (let k = 0; k < p.length; k++) acc[k] += p[k];
      nSeg++;
    }
    if (!nSeg) { marca[ci] = 1; cols.push(new Float64Array(f.length).fill(NaN)); return; }
    for (let k = 0; k < acc.length; k++) acc[k] /= nSeg;
    cols.push(acc);
  });
  return {
    ok: true, method: 'welch', freqs: f, power: cols,
    times: g.inicios.map(s => (s + g.nper / 2) / fs),
    missing: falta, flagged: marca,
    params: {
      windowS: g.janelaS, overlapS: g.sobrepS, stepS: g.passo / fs, freqRes: fs / g.nfft,
      nperseg: g.nper, nfft: g.nfft, subWindowS: subN / fs, window: 'hann-periodic',
      scaling: 'density', detrend: opts.detrend || 'constant', maxMissingFrac: tol, fs
    },
    unit: 'µV²/Hz'
  };
}

/* --------------------------------------------- 2. STFT (scipy spectrogram) */

export function spectrogramSTFT(x, fs, opts) {
  opts = opts || {};
  const g = grade(x, fs, opts);
  if (!g.inicios.length) return { ok: false, reason: `sinal curto demais: ${x.length} amostras para janela de ${g.nper}` };
  const w = hammingPeriodic(g.nper);
  let U = 0; for (let i = 0; i < g.nper; i++) U += w[i] * w[i];
  U *= fs;
  const f = eixoFreq(g.nfft, fs);
  const tol = opts.maxMissingFrac == null ? 0 : opts.maxMissingFrac;
  const cols = [], falta = new Float64Array(g.inicios.length), marca = new Uint8Array(g.inicios.length);
  g.inicios.forEach((s, ci) => {
    const fr = contaFaltantes(x, s, s + g.nper);
    falta[ci] = fr;
    if (fr > tol) { marca[ci] = 1; cols.push(new Float64Array(f.length).fill(NaN)); return; }
    cols.push(periodograma(detrendEpoca(x, s, s + g.nper, opts.detrend || 'constant'), w, g.nfft, fs, U));
  });
  return {
    ok: true, method: 'stft', freqs: f, power: cols,
    times: g.inicios.map(s => (s + g.nper / 2) / fs),
    missing: falta, flagged: marca,
    params: {
      windowS: g.janelaS, overlapS: g.sobrepS, stepS: g.passo / fs, freqRes: fs / g.nfft,
      nperseg: g.nper, noverlap: g.nper - g.passo, nfft: g.nfft, window: 'hamming-periodic',
      scaling: 'density', detrend: opts.detrend || 'constant', maxMissingFrac: tol, fs
    },
    unit: 'µV²/Hz'
  };
}

/* ------------------------------------- 3. emulação do PSD do Percept ------ */

/* O QUE ISTO REPRODUZ. O neuroestimulador não guarda o espectro; ele calcula
   uma FFT a bordo e reporta a potência de uma banda. A sequência abaixo é a
   que o BRAVO usa para reproduzir esse cálculo:

     janela de Hanning SIMÉTRICA de 250 amostras, multiplicada por 1/54;
     zero-pad de 250 para 256; MAGNITUDE |FFT| (não potência);
     avanço de 5 amostras por passo (tamanho do pacote no caminho de
     streaming); primeiras 100 bins do eixo (k/256)·fs.

   A CONSTANTE 1/54. É empírica: sai do ganho coerente da janela e da
   normalização de ponto fixo do firmware, e não está documentada pelo
   fabricante. Fica parametrizável e explícita porque é o número que faz esta
   emulação bater — ou não — com o que o aparelho reportou, e ninguém deveria
   descobrir depois que havia uma constante mágica escondida no meio.

   POR QUE MAGNITUDE E NÃO POTÊNCIA. Porque é o que o aparelho reporta. Elevar
   ao quadrado aqui tornaria a comparação com o valor do próprio Percept
   incomparável, que é justamente o uso deste modo.                          */
export function spectrogramPercept(x, fs, opts) {
  opts = opts || {};
  const nper = opts.nperseg || 250;
  const nfft = opts.nfft || 256;
  const ganho = opts.gain == null ? 1 / 54 : opts.gain;
  const passo = opts.packetSamples == null ? 5 : opts.packetSamples;
  const nBinsSaida = opts.nBins || 100;
  if (x.length < nper) return { ok: false, reason: `sinal curto demais: ${x.length} amostras para a janela de ${nper} do aparelho` };
  const w = hannSymmetric(nper);
  for (let i = 0; i < nper; i++) w[i] *= ganho;
  const f = new Float64Array(nBinsSaida);
  for (let k = 0; k < nBinsSaida; k++) f[k] = k * fs / nfft;
  const tol = opts.maxMissingFrac == null ? 0 : opts.maxMissingFrac;
  const cols = [], tempos = [], falta = [], marca = [];
  for (let s = 0; s + nper <= x.length; s += passo) {
    const fr = contaFaltantes(x, s, s + nper);
    falta.push(fr);
    if (fr > tol) { marca.push(1); cols.push(new Float64Array(nBinsSaida).fill(NaN)); tempos.push((s + nper / 2) / fs); continue; }
    marca.push(0);
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    for (let i = 0; i < nper; i++) re[i] = (isFinite(x[s + i]) ? x[s + i] : 0) * w[i];
    fft(re, im, false);                       /* 256 é potência de dois */
    const col = new Float64Array(nBinsSaida);
    for (let k = 0; k < nBinsSaida; k++) col[k] = Math.hypot(re[k], im[k]);
    cols.push(col); tempos.push((s + nper / 2) / fs);
  }
  if (!cols.length) return { ok: false, reason: 'nenhuma janela completa' };
  return {
    ok: true, method: 'percept', freqs: f, power: cols, times: tempos,
    missing: Float64Array.from(falta), flagged: Uint8Array.from(marca),
    params: {
      nperseg: nper, nfft, gain: ganho, packetSamples: passo, nBins: nBinsSaida,
      stepS: passo / fs, window: 'hann-symmetric', scaling: 'magnitude', fs,
      maxMissingFrac: tol
    },
    unit: 'µV (magnitude)',
    caveat: 'este modo reproduz a aritmética de bordo do aparelho, não é densidade espectral: ' +
      'a escala é magnitude |FFT| com ganho 1/54, e não deve ser comparada em dB com os outros métodos'
  };
}

/* --------------------------------------------------- 4. wavelet (Morlet) -- */

/* `widths = w·fs/(2·f·π)` do scipy.signal.morlet2 corresponde a uma wavelet de
   aproximadamente `w` oscilações dentro do envelope — o mesmo parâmetro que a
   nossa `morletCWT` chama de nCycles. A correspondência é declarada porque as
   duas parametrizações são fáceis de confundir.                              */
export function spectrogramWavelet(x, fs, opts) {
  opts = opts || {};
  const w0 = opts.w == null ? 6 : opts.w;
  const fMin = opts.fMin == null ? 1 : opts.fMin;
  const fMax = opts.fMax == null ? Math.min(100, fs / 2 - 1) : opts.fMax;
  const nF = opts.nFreqs || 80;
  const freqs = [];
  for (let i = 0; i < nF; i++) freqs.push(fMin + (fMax - fMin) * i / (nF - 1));
  const limpo = Float64Array.from(x, v => isFinite(v) ? v : 0);
  const cwt = morletCWT(limpo, fs, freqs, { nCycles: w0 });
  if (!cwt) return { ok: false, reason: 'sinal curto demais para a wavelet' };
  const passo = Math.max(1, Math.round((opts.stepS || 0.05) * fs));
  const tempos = [], cols = [], falta = [], marca = [];
  const suav = Math.max(1, Math.round((opts.smoothS || 0) * fs));
  for (let i = 0; i < cwt.n; i += passo) {
    const a = Math.max(0, i - Math.floor(suav / 2)), b = Math.min(cwt.n, a + suav);
    const col = new Float64Array(freqs.length);
    for (let k = 0; k < freqs.length; k++) {
      let acc = 0, m = 0;
      for (let j = a; j < b; j++) { const v = cwt.power[k][j]; if (isFinite(v)) { acc += v; m++; } }
      col[k] = m ? acc / m : NaN;
    }
    const fr = contaFaltantes(x, a, b);
    falta.push(fr); marca.push(fr > (opts.maxMissingFrac == null ? 0 : opts.maxMissingFrac) ? 1 : 0);
    if (marca[marca.length - 1]) col.fill(NaN);
    cols.push(col); tempos.push(i / fs);
  }
  return {
    ok: true, method: 'wavelet', freqs: Float64Array.from(freqs), power: cols, times: tempos,
    missing: Float64Array.from(falta), flagged: Uint8Array.from(marca),
    params: { w: w0, nCycles: w0, fMin, fMax, nFreqs: nF, stepS: passo / fs, smoothS: suav / fs, scaling: 'power', fs },
    unit: 'µV²',
    caveat: 'a wavelet troca resolução de frequência por resolução temporal conforme a frequência: ' +
      'a largura de banda cresce com f, então bandas altas ficam mais borradas em frequência e mais nítidas no tempo'
  };
}

/* ------------------------------------- 5. autorregressivo (Yule-Walker) --- */

/* Levinson-Durbin: resolve o sistema de Toeplitz das equações de Yule-Walker
   em O(p²) e devolve os coeficientes e a variância residual de cada ordem.   */
export function levinsonDurbin(r, ordem) {
  const a = new Float64Array(ordem + 1);
  const varRes = new Float64Array(ordem + 1);
  a[0] = 1; varRes[0] = r[0];
  if (!(r[0] > 0)) return null;
  let E = r[0];
  const tmp = new Float64Array(ordem + 1);
  for (let m = 1; m <= ordem; m++) {
    let acc = r[m];
    for (let i = 1; i < m; i++) acc -= a[i] * r[m - i];
    const k = acc / E;
    tmp.set(a);
    a[m] = k;
    for (let i = 1; i < m; i++) a[i] = tmp[i] - k * tmp[m - i];
    E *= (1 - k * k);
    if (!(E > 0)) { varRes[m] = E; return { a, varResidual: varRes, ordemMax: m - 1 }; }
    varRes[m] = E;
  }
  return { a, varResidual: varRes, ordemMax: ordem };
}

/* PSD do modelo AR: σ²/(fs·|A(e^{jω})|²), unilateral com ×2 fora de DC/Nyquist */
function psdAR(coef, sigma2, fs, freqs) {
  const p = coef.length - 1;
  const out = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    const w = 2 * Math.PI * freqs[i] / fs;
    let re = 1, im = 0;
    for (let k = 1; k <= p; k++) { re -= coef[k] * Math.cos(w * k); im += coef[k] * Math.sin(w * k); }
    const den = re * re + im * im;
    const dobro = (freqs[i] > 0 && freqs[i] < fs / 2) ? 2 : 1;
    out[i] = den > 0 ? dobro * sigma2 / (fs * den) : NaN;
  }
  return out;
}

export function spectrogramAR(x, fs, opts) {
  opts = opts || {};
  const g = grade(x, fs, opts);
  if (!g.inicios.length) return { ok: false, reason: `sinal curto demais: ${x.length} amostras para janela de ${g.nper}` };
  const ordemMax = Math.min(opts.maxOrder || 30, Math.floor(g.nper / 3));
  const f = eixoFreq(g.nfft, fs);
  const tol = opts.maxMissingFrac == null ? 0 : opts.maxMissingFrac;
  const cols = [], falta = new Float64Array(g.inicios.length), marca = new Uint8Array(g.inicios.length);
  const ordens = [];
  g.inicios.forEach((s, ci) => {
    const fr = contaFaltantes(x, s, s + g.nper);
    falta[ci] = fr;
    if (fr > tol) { marca[ci] = 1; cols.push(new Float64Array(f.length).fill(NaN)); return; }
    const seg = detrendEpoca(x, s, s + g.nper, opts.detrend || 'constant');
    const n = seg.length;
    /* autocorrelação enviesada (divisor n) — a que garante Toeplitz positiva */
    const r = new Float64Array(ordemMax + 1);
    for (let k = 0; k <= ordemMax; k++) {
      let acc = 0;
      for (let i = 0; i + k < n; i++) acc += seg[i] * seg[i + k];
      r[k] = acc / n;
    }
    const lev = levinsonDurbin(r, ordemMax);
    if (!lev) { marca[ci] = 1; cols.push(new Float64Array(f.length).fill(NaN)); return; }
    /* ordem por BIC: n·ln(σ²ₚ) + p·ln(n) — penaliza mais que o AIC e evita a
       ordem inflada que faz o espectro AR criar picos que não existem */
    let melhor = 1, bicMin = Infinity;
    for (let p = 1; p <= lev.ordemMax; p++) {
      const s2 = lev.varResidual[p];
      if (!(s2 > 0)) break;
      const bic = n * Math.log(s2) + p * Math.log(n);
      if (bic < bicMin) { bicMin = bic; melhor = p; }
    }
    const lev2 = levinsonDurbin(r, melhor);
    ordens.push(melhor);
    cols.push(psdAR(lev2.a, lev2.varResidual[melhor], fs, f));
  });
  return {
    ok: true, method: 'ar', freqs: f, power: cols,
    times: g.inicios.map(s => (s + g.nper / 2) / fs),
    missing: falta, flagged: marca,
    params: {
      windowS: g.janelaS, overlapS: g.sobrepS, stepS: g.passo / fs, freqRes: fs / g.nfft,
      nperseg: g.nper, nfft: g.nfft, maxOrder: ordemMax,
      medianOrder: ordens.length ? median(ordens) : NaN,
      orderCriterion: 'BIC', scaling: 'density', detrend: opts.detrend || 'constant', fs, maxMissingFrac: tol
    },
    unit: 'µV²/Hz',
    caveat: 'o espectro AR é IMPOSTO pelo modelo: a suavidade e a largura dos picos vêm da ordem escolhida, ' +
      'não da medida. Ordem alta demais cria picos que não existem; baixa demais funde picos vizinhos'
  };
}

/* ------------------------------------------------ normalização e 1/f ----- */

/* normalizeSpectrogram(spec, opts) → divide ou subtrai a média de uma janela
   de tempo de referência, por frequência. `log:true` opera em 10·log10.     */
export function normalizeSpectrogram(spec, opts) {
  opts = opts || {};
  const modo = opts.mode || 'divide';
  const [t0, t1] = opts.baseline || [spec.times[0], spec.times[Math.min(spec.times.length - 1, 4)]];
  const idx = [];
  spec.times.forEach((t, i) => { if (t >= t0 && t <= t1 && !spec.flagged[i]) idx.push(i); });
  if (idx.length < 1) return { ok: false, reason: `a janela de referência ${t0}–${t1} s não contém nenhuma época válida` };
  const nF = spec.freqs.length;
  const base = new Float64Array(nF);
  for (let k = 0; k < nF; k++) {
    let acc = 0, m = 0;
    idx.forEach(i => { const v = spec.power[i][k]; if (isFinite(v) && v > 0) { acc += opts.log ? 10 * Math.log10(v) : v; m++; } });
    base[k] = m ? acc / m : NaN;
  }
  const cols = spec.power.map(col => {
    const out = new Float64Array(nF);
    for (let k = 0; k < nF; k++) {
      const v = opts.log ? (col[k] > 0 ? 10 * Math.log10(col[k]) : NaN) : col[k];
      out[k] = !isFinite(v) || !isFinite(base[k]) ? NaN
        : modo === 'subtract' ? v - base[k] : (base[k] !== 0 ? v / base[k] : NaN);
    }
    return out;
  });
  return Object.assign({}, spec, {
    power: cols, baseline: Array.from(base),
    normalization: { mode: modo, baselineWindowS: [t0, t1], log: !!opts.log, nEpochs: idx.length },
    unit: modo === 'subtract' ? (opts.log ? 'dB vs. referência' : 'Δ vs. referência') : '× a referência'
  });
}

/* removeAperiodicTrend(spec, opts) → divide cada coluna pelo componente
   aperiódico 1/f.

   DIFERENÇA DECLARADA EM RELAÇÃO AO FOOOF. O FOOOF ajusta simultaneamente o
   componente aperiódico e gaussianas de pico, iterando para que os picos não
   contaminem o ajuste do fundo. Aqui o ajuste é uma regressão linear ROBUSTA
   em log-log (log10 P = a − b·log10 f), com poda dos resíduos positivos — que
   são justamente os picos. É mais simples, mais rápido e suficiente para
   remover a inclinação; NÃO é FOOOF, e não estima largura nem altura de pico.

   O ajuste é feito sobre o espectro MÉDIO no tempo, não coluna a coluna: com
   uma época de 1 s o espectro individual é ruidoso demais para estimar uma
   inclinação estável, e uma inclinação instável vira artefato temporal.     */
export function removeAperiodicTrend(spec, opts) {
  opts = opts || {};
  const lo = opts.fitLo == null ? 2 : opts.fitLo;
  const hi = opts.fitHi == null ? Math.min(45, spec.freqs[spec.freqs.length - 1]) : opts.fitHi;
  const nF = spec.freqs.length;
  const medio = new Float64Array(nF);
  for (let k = 0; k < nF; k++) {
    const v = [];
    spec.power.forEach(col => { if (isFinite(col[k]) && col[k] > 0) v.push(col[k]); });
    medio[k] = v.length ? median(v) : NaN;
  }
  const X = [], Y = [], K = [];
  for (let k = 0; k < nF; k++) {
    const f = spec.freqs[k];
    if (f < Math.max(lo, 1e-6) || f > hi || !isFinite(medio[k]) || !(medio[k] > 0)) continue;
    X.push(Math.log10(f)); Y.push(Math.log10(medio[k])); K.push(k);
  }
  if (X.length < 6) return { ok: false, reason: `só ${X.length} bins entre ${lo} e ${hi} Hz — insuficiente para ajustar a inclinação 1/f` };
  let usar = X.map((_, i) => i);
  let a = 0, b = 0;
  for (let it = 0; it < 4; it++) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    usar.forEach(i => { sx += X[i]; sy += Y[i]; sxx += X[i] * X[i]; sxy += X[i] * Y[i]; });
    const n = usar.length, den = n * sxx - sx * sx;
    if (!den) break;
    b = (n * sxy - sx * sy) / den; a = (sy - b * sx) / n;
    /* poda: resíduo positivo é pico, e pico não é fundo. O piso de 50% impede
       a poda de encolher a amostra até a regressão degenerar. */
    const res = X.map((x, i) => Y[i] - (a + b * x));
    const corte = quantile(usar.map(i => res[i]), 0.75);
    const novo = X.map((_, i) => i).filter(i => res[i] <= corte);
    if (novo.length < Math.max(6, X.length * 0.5)) break;
    usar = novo;
  }
  const r2 = (() => {
    const yy = usar.map(i => Y[i]);
    const mu = mean(yy);
    let sse = 0, sst = 0;
    usar.forEach(i => { const e = Y[i] - (a + b * X[i]); sse += e * e; sst += (Y[i] - mu) ** 2; });
    return sst > 0 ? 1 - sse / sst : NaN;
  })();
  const fundo = new Float64Array(nF);
  for (let k = 0; k < nF; k++) {
    const f = spec.freqs[k];
    fundo[k] = f > 0 ? Math.pow(10, a + b * Math.log10(f)) : NaN;
  }
  const cols = spec.power.map(col => {
    const out = new Float64Array(nF);
    for (let k = 0; k < nF; k++) out[k] = (isFinite(col[k]) && isFinite(fundo[k]) && fundo[k] > 0) ? col[k] / fundo[k] : NaN;
    return out;
  });
  return Object.assign({}, spec, {
    power: cols, aperiodic: { exponent: -b, offset: a, r2, fitLo: lo, fitHi: hi, nBins: usar.length, method: 'regressão log-log robusta (não é FOOOF)' },
    unit: '× o fundo 1/f',
    caveat: 'o fundo aperiódico foi ajustado por regressão log-log robusta sobre o espectro médio no tempo, ' +
      'não pelo FOOOF completo — remove a inclinação, mas não separa picos do fundo com o mesmo rigor'
  });
}

/* ------------------------------------------------------- orquestrador ---- */

export const TF_METHODS = [
  { id: 'welch', label: 'Welch por época', unit: 'µV²/Hz', db: true },
  { id: 'stft', label: 'STFT (Hamming)', unit: 'µV²/Hz', db: true },
  { id: 'percept', label: 'PSD do Percept (emulação de bordo)', unit: 'µV', db: false },
  { id: 'wavelet', label: 'Wavelet de Morlet', unit: 'µV²', db: true },
  { id: 'ar', label: 'Autorregressivo (Yule-Walker)', unit: 'µV²/Hz', db: true }
];

/* timeFrequency(x, fs, opts) → espectrograma pronto para desenhar.
   Aplica, na ordem declarada: método → normalização → remoção de 1/f.       */
export function timeFrequency(x, fs, opts) {
  opts = opts || {};
  const metodo = opts.method || 'welch';
  const fn = { welch: spectrogramWelch, stft: spectrogramSTFT, percept: spectrogramPercept, wavelet: spectrogramWavelet, ar: spectrogramAR }[metodo];
  if (!fn) return { ok: false, reason: `método desconhecido: ${metodo}` };
  let spec = fn(x, fs, opts);
  if (!spec.ok) return spec;
  const passos = [metodo];
  if (opts.detrendAperiodic) {
    const r = removeAperiodicTrend(spec, opts);
    if (r.ok !== false) { spec = r; passos.push('remoção de 1/f'); }
    else spec = Object.assign({}, spec, { aperiodicReason: r.reason });
  }
  if (opts.normalize) {
    const r = normalizeSpectrogram(spec, opts);
    if (r.ok !== false) { spec = r; passos.push(`normalização ${opts.mode || 'divide'}`); }
    else spec = Object.assign({}, spec, { normalizeReason: r.reason });
  }
  /* estatísticas do que sobrou, para a figura poder declarar cobertura */
  const validas = spec.flagged ? Array.from(spec.flagged).filter(v => !v).length : spec.times.length;
  return Object.assign({}, spec, {
    pipeline: passos,
    nEpochs: spec.times.length, nEpochsValid: validas,
    pctEpochsFlagged: spec.times.length ? +(100 * (spec.times.length - validas) / spec.times.length).toFixed(2) : 0
  });
}

/* matrizParaHeat(spec, opts) → matriz [frequência][tempo] em dB (ou linear),
   já recortada em fMax, pronta para `Chart.heat` com origin 'bottom'.       */
export function tfMatrix(spec, opts) {
  opts = opts || {};
  const fMax = opts.fMax == null ? Infinity : opts.fMax;
  const dB = opts.dB !== false;
  const ks = [];
  for (let k = 0; k < spec.freqs.length; k++) if (spec.freqs[k] <= fMax) ks.push(k);
  const M = ks.map(k => {
    const linha = new Float64Array(spec.times.length);
    for (let i = 0; i < spec.times.length; i++) {
      const v = spec.power[i][k];
      linha[i] = !isFinite(v) ? NaN : dB ? (v > 0 ? 10 * Math.log10(v) : NaN) : v;
    }
    return linha;
  });
  return { matrix: M, freqs: ks.map(k => spec.freqs[k]), times: spec.times, dB };
}
