/* dsp/coherence.js — coerência espectral entre dois sinais.

   O QUE MEDE. A coerência de magnitude quadrática Cxy(f) ∈ [0,1] diz quanto da
   variação de um sinal numa frequência é explicada linearmente pelo outro, com
   relação de fase constante. É a ferramenta para perguntar: o pico de 5 Hz no
   GPi é o mesmo ritmo do tremor cefálico medido pelo IMU? A oscilação beta do
   STN acompanha a atividade do EMG?

   TRÊS ARMADILHAS, TODAS TRATADAS AQUI

   1. COERÊNCIA É INFLADA POR POUCOS SEGMENTOS. Com L segmentos independentes, a
      coerência esperada sob a hipótese nula NÃO é zero: é 1/L. Com 4 segmentos,
      dois ruídos independentes dão Cxy ≈ 0,25 — que parece "coerência
      moderada". Por isso todo resultado traz o LIMIAR de significância
      1 − α^(1/(L−1)) e o número de segmentos usados.

   2. CONDUÇÃO DE VOLUME E REFERÊNCIA COMUM produzem coerência de fase ZERO sem
      nenhuma interação. A parte IMAGINÁRIA da coerência (Nolte et al.) é
      insensível a isso: só sobrevive o que tem defasagem, ou seja, o que levou
      tempo para propagar. Ela vem junto, sempre.

   3. LACUNAS. Segmento com NaN é descartado, nunca preenchido, e a fração usada
      é reportada — igual ao Welch deste mesmo repositório.

   Unidades: f em Hz; Cxy adimensional; fase em radianos; atraso em ms.

   Referências:
     Halliday DM, et al. Prog Biophys Mol Biol 1995;64:237-278.
     Nolte G, et al. Clin Neurophysiol 2004;115:2292-2307 (coerência imaginária).
     Bortel R, Sovka P. Signal Processing 2007;87:1100-1117 (viés e limiar).   */

import { fft, hann, nextPow2 } from './fft.js';
import { detrendLinearNaN } from './nan.js';
import { median } from '../stats/descriptive.js';

/* coherence(x, y, fs, {nperseg, overlap, alpha})
   x e y precisam ter o MESMO comprimento e a mesma fs — reamostre antes.     */
export function coherence(x, y, fs, opts) {
  opts = opts || {};
  const n = Math.min(x.length, y.length);
  const nper = opts.nperseg || Math.min(nextPow2(Math.floor(fs)), nextPow2(n));
  const nfft = nextPow2(nper);
  const overlap = opts.overlap == null ? 0.5 : opts.overlap;
  const passo = Math.max(1, Math.floor(nper * (1 - overlap)));
  const alpha = isFinite(opts.alpha) ? opts.alpha : 0.05;
  if (n < nper * 2) return { f: [], cxy: null, reason: 'registro curto demais para dois segmentos' };

  const w = hann(nper);
  const nBins = nfft / 2 + 1;
  const Sxx = new Float64Array(nBins), Syy = new Float64Array(nBins);
  const SxyRe = new Float64Array(nBins), SxyIm = new Float64Array(nBins);
  let L = 0, descartados = 0;

  for (let s = 0; s + nper <= n; s += passo) {
    let temNaN = false;
    for (let i = s; i < s + nper; i++) if (!isFinite(x[i]) || !isFinite(y[i])) { temNaN = true; break; }
    if (temNaN) { descartados++; continue; }
    const sx = detrendLinearNaN(x.subarray ? x.subarray(s, s + nper) : x.slice(s, s + nper));
    const sy = detrendLinearNaN(y.subarray ? y.subarray(s, s + nper) : y.slice(s, s + nper));
    const xr = new Float64Array(nfft), xi = new Float64Array(nfft);
    const yr = new Float64Array(nfft), yi = new Float64Array(nfft);
    for (let i = 0; i < nper; i++) { xr[i] = sx[i] * w[i]; yr[i] = sy[i] * w[i]; }
    fft(xr, xi, false); fft(yr, yi, false);
    for (let k = 0; k < nBins; k++) {
      Sxx[k] += xr[k] * xr[k] + xi[k] * xi[k];
      Syy[k] += yr[k] * yr[k] + yi[k] * yi[k];
      /* Sxy = X · conj(Y) */
      SxyRe[k] += xr[k] * yr[k] + xi[k] * yi[k];
      SxyIm[k] += xi[k] * yr[k] - xr[k] * yi[k];
    }
    L++;
  }
  if (L < 3) return {
    f: [], cxy: null, nSegments: L, nSegmentsDropped: descartados,
    reason: `apenas ${L} segmento(s) sem lacuna — com menos de 3 a coerência não é estimável de forma útil`
  };

  const f = new Float64Array(nBins), cxy = new Float64Array(nBins);
  const fase = new Float64Array(nBins), imag = new Float64Array(nBins);
  for (let k = 0; k < nBins; k++) {
    f[k] = k * fs / nfft;
    const den = Sxx[k] * Syy[k];
    const num = SxyRe[k] * SxyRe[k] + SxyIm[k] * SxyIm[k];
    cxy[k] = den > 0 ? Math.min(1, num / den) : NaN;
    fase[k] = Math.atan2(SxyIm[k], SxyRe[k]);
    imag[k] = den > 0 ? SxyIm[k] / Math.sqrt(den) : NaN;
  }

  /* limiar de significância sob a nula, para L segmentos independentes.
     Segmentos com 50% de sobreposição NÃO são independentes: o L efetivo é
     menor, e usar L cheio deixa o limiar otimista. Correção conservadora de
     Welch: L_eff ≈ L / (1 + 2·overlap²) para janela de Hann. */
  const Lef = Math.max(2, Math.round(L / (1 + 2 * overlap * overlap)));
  const limiar = 1 - Math.pow(alpha, 1 / (Lef - 1));

  return {
    f, cxy, phaseRad: fase, imagCoherency: imag,
    nSegments: L, nSegmentsEffective: Lef, nSegmentsDropped: descartados,
    nperseg: nper, df: fs / nfft, overlap, alpha,
    significanceThreshold: +limiar.toFixed(5),
    expectedNullCoherence: +(1 / Lef).toFixed(5),
    reason: null,
    note: `com ${Lef} segmentos efetivos, dois ruídos independentes dariam coerência média de ` +
      `${(1 / Lef).toFixed(3)} — só acima de ${limiar.toFixed(3)} há evidência contra a nula (α = ${alpha})`
  };
}

/* Resumo por banda: coerência média, pico, e se passa do limiar. O atraso vem
   da INCLINAÇÃO da fase dentro da banda (dφ/dω), não da fase num ponto — fase
   num ponto só é interpretável a menos de múltiplos de 2π. */
export function coherenceBand(coh, lo, hi) {
  if (!coh || !coh.cxy) return null;
  const idx = [];
  for (let i = 0; i < coh.f.length; i++) if (coh.f[i] >= lo && coh.f[i] <= hi && isFinite(coh.cxy[i])) idx.push(i);
  if (idx.length < 3) return null;
  const vals = idx.map(i => coh.cxy[i]);
  let bi = idx[0];
  idx.forEach(i => { if (coh.cxy[i] > coh.cxy[bi]) bi = i; });

  /* Atraso pela INCLINAÇÃO da fase, com dois cuidados que mudam o número:

     (a) só entram os bins em que há coerência de verdade. Onde Cxy é ruído, a
         fase também é, e incluir esses pontos numa reta comum arrasta a
         inclinação para qualquer lugar;
     (b) o ajuste é PONDERADO por Cxy, porque bins mais coerentes têm fase
         menos incerta.

     Convenção: Sxy = X·conj(Y). Se y(t) = x(t − τ), então Y = X·e^(−iωτ) e
     Sxy = |X|²·e^(+iωτ), ou seja φ = +ωτ e τ = +dφ/dω. Positivo significa que
     o SEGUNDO sinal está atrasado em relação ao primeiro. */
  const usados = idx.filter(i => coh.cxy[i] > coh.significanceThreshold);
  const paraFase = usados.length >= 4 ? usados : idx;
  const w = paraFase.map(i => 2 * Math.PI * coh.f[i]);
  const peso = paraFase.map(i => Math.max(0, coh.cxy[i]));
  const ph = [];
  let acc = coh.phaseRad[paraFase[0]];
  ph.push(acc);
  for (let k = 1; k < paraFase.length; k++) {
    let d = coh.phaseRad[paraFase[k]] - coh.phaseRad[paraFase[k - 1]];
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    acc += d; ph.push(acc);
  }
  const sw = peso.reduce((a, v) => a + v, 0) || 1;
  const mw = w.reduce((a, v, k) => a + v * peso[k], 0) / sw;
  const mp = ph.reduce((a, v, k) => a + v * peso[k], 0) / sw;
  let sxy = 0, sxx = 0;
  for (let k = 0; k < w.length; k++) {
    sxy += peso[k] * (w[k] - mw) * (ph[k] - mp);
    sxx += peso[k] * (w[k] - mw) * (w[k] - mw);
  }
  const b = sxx > 0 ? sxy / sxx : NaN;
  const atrasoMs = isFinite(b) ? b * 1000 : NaN;
  const nBinsFase = paraFase.length;
  const imMax = idx.reduce((m, i) => Math.abs(coh.imagCoherency[i]) > Math.abs(coh.imagCoherency[m]) ? i : m, idx[0]);
  /* A decisão sobre condução de volume tem de ser tomada NA FREQUÊNCIA EM QUE
     HÁ COERÊNCIA, não no máximo da parte imaginária ao longo da banda: onde a
     coerência é ruído, a parte imaginária também é, e o máximo dela sobre
     vários bins chega a 0,2 por acaso. No pico, a parte imaginária é
     √Cxy·sen(φ) — perto de zero significa fase zero, que é a assinatura de
     mistura instantânea. */
  const imagPico = coh.imagCoherency[bi];
  const faseGrau = coh.phaseRad[bi] * 180 / Math.PI;

  /* Para acoplamento de banda ESTREITA (tremor), a inclinação da fase é
     estimada sobre poucos bins e fica ruidosa. A fase NO PICO dá um número
     melhor — ao custo de ser ambígua a menos de múltiplos de 2π, o que só é
     inofensivo quando |τ| < 1/(2·f_pico). Os dois saem, com a ressalva. */
  const tauPicoMs = isFinite(coh.phaseRad[bi]) && coh.f[bi] > 0
    ? 1000 * coh.phaseRad[bi] / (2 * Math.PI * coh.f[bi]) : NaN;
  const ambiguidadeMs = coh.f[bi] > 0 ? 1000 / coh.f[bi] : NaN;
  const larguraSig = usados.length ? (coh.f[usados[usados.length - 1]] - coh.f[usados[0]]) : 0;
  const estreita = larguraSig < 3;

  const media = vals.reduce((a, v) => a + v, 0) / vals.length;
  /* O limiar de `coherence()` vale PARA UM BIN. Tomar o MÁXIMO sobre os bins da
     banda é uma comparação múltipla disfarçada: com 11 bins e α = 0,05, ruído
     puro ultrapassa o limiar por bin quase metade das vezes. Correção de Šidák
     sobre o número de bins da banda. */
  const nBins = idx.length;
  const alfaCorr = 1 - Math.pow(1 - coh.alpha, 1 / nBins);
  const limiarBanda = 1 - Math.pow(alfaCorr, 1 / (coh.nSegmentsEffective - 1));
  const significativo = coh.cxy[bi] > limiarBanda;
  return {
    band: [lo, hi], nBins,
    meanCoherence: +media.toFixed(4),
    medianCoherence: +median(vals).toFixed(4),
    peakCoherence: +coh.cxy[bi].toFixed(4), peakHz: +coh.f[bi].toFixed(3),
    threshold: coh.significanceThreshold,
    thresholdBandCorrected: +limiarBanda.toFixed(5),
    significant: significativo,
    phaseAtPeakRad: +coh.phaseRad[bi].toFixed(4),
    lagMs: isFinite(atrasoMs) ? +atrasoMs.toFixed(2) : NaN,
    lagFromNBins: nBinsFase,
    lagAtPeakMs: isFinite(tauPicoMs) ? +tauPicoMs.toFixed(2) : NaN,
    lagAmbiguityMs: isFinite(ambiguidadeMs) ? +ambiguidadeMs.toFixed(2) : NaN,
    significantBandwidthHz: +larguraSig.toFixed(2),
    preferredLagMs: estreita && isFinite(tauPicoMs) ? +tauPicoMs.toFixed(2)
      : (isFinite(atrasoMs) ? +atrasoMs.toFixed(2) : NaN),
    preferredLagSource: estreita ? 'fase no pico (banda estreita)' : 'inclinação da fase na banda',
    maxImagCoherency: +coh.imagCoherency[imMax].toFixed(4),
    maxImagHz: +coh.f[imMax].toFixed(3),
    imagAtPeak: +imagPico.toFixed(4),
    phaseAtPeakDeg: +faseGrau.toFixed(1),
    /* limiar relativo: 0,1·√Cxy corresponde a |φ| ≲ 6° no pico */
    volumeConductionSuspected: significativo && Math.abs(imagPico) < 0.1 * Math.sqrt(Math.max(0, coh.cxy[bi])),
    interpretation: !significativo
      ? `nenhuma frequência da banda passa do limiar de ${limiarBanda.toFixed(3)} ` +
        `(limiar por bin ${coh.significanceThreshold.toFixed(3)}, corrigido para os ${nBins} bins da banda) — ` +
        'não há evidência de acoplamento linear entre os dois sinais nesta banda'
      : Math.abs(imagPico) < 0.1 * Math.sqrt(Math.max(0, coh.cxy[bi]))
        ? `há coerência (pico ${coh.cxy[bi].toFixed(2)} em ${coh.f[bi].toFixed(1)} Hz), mas no pico a fase é de ` +
          `${faseGrau.toFixed(0)}° e a parte imaginária é ${imagPico.toFixed(3)} — praticamente nula. O padrão é ` +
          'compatível com condução de volume ou referência comum, não com interação com atraso de propagação'
        : `coerência de ${coh.cxy[bi].toFixed(2)} em ${coh.f[bi].toFixed(1)} Hz, com fase de ${faseGrau.toFixed(0)}° e ` +
          `parte imaginária de ${imagPico.toFixed(2)} no pico — há defasagem, o que é incompatível com mistura instantânea` +
          (estreita && isFinite(tauPicoMs)
            ? `. O acoplamento é de banda estreita (${larguraSig.toFixed(1)} Hz), então o atraso vem da fase no pico: ` +
              `${tauPicoMs.toFixed(1)} ms — ambíguo a menos de múltiplos de ${ambiguidadeMs.toFixed(0)} ms`
            : isFinite(atrasoMs)
              ? `; atraso pela inclinação da fase sobre ${nBinsFase} bins: ${atrasoMs.toFixed(1)} ms` : '')
  };
}
