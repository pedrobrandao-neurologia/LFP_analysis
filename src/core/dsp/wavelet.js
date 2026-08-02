/* dsp/wavelet.js — transformada contínua de Morlet e delimitação de bursts.

   POR QUE WAVELET E NÃO SÓ HILBERT. O envelope de Hilbert sobre um filtro de
   banda fixa responde a uma pergunta com a banda JÁ escolhida. A wavelet de
   Morlet varre frequências com resolução tempo-frequência que se adapta: mais
   ciclos = melhor resolução em frequência e pior no tempo, e vice-versa. Para
   burst de beta isso importa diretamente — a duração medida depende do número
   de ciclos da wavelet, e essa é uma escolha que precisa aparecer no resultado.

   A wavelet de Morlet complexa, normalizada em energia:
       ψ(t) = (σ_t √π)^(-1/2) · exp(−t²/(2σ_t²)) · exp(i2πf₀t)
   com σ_t = n_ciclos / (2πf₀). A convolução é feita por FFT (O(N log N) por
   frequência).

   DELIMITAÇÃO DE BURST POR WAVELET. O limiar define QUE existe um burst; a
   borda define QUANTO ele dura. Aqui as duas decisões são separadas, como em
   Tinkhauser et al.: o burst é DETECTADO por cruzar o limiar principal e é
   DELIMITADO por descer a uma fração desse limiar (padrão 0,5 — meia altura).
   Sem essa separação a duração é uma função do limiar, e comparações entre
   estudos com limiares diferentes deixam de significar coisa alguma.

   Lacunas (NaN): um burst NUNCA atravessa lacuna. As amostras faltantes entram
   como NaN na potência e interrompem qualquer episódio.

   Unidades: entrada em µV, potência em µV²; durações em ms.

   Referências:
     Torrence C, Compo GP. Bull Am Meteorol Soc 1998;79:61-78.
     Cohen MX. Analyzing Neural Time Series Data. MIT Press, 2014, cap. 12-13.
     Tinkhauser G, et al. Brain 2017;140:2968-2981 (bursts de beta e duração).
     Lofredi R, et al. eLife 2018;7:e31895 (relação com bradicinesia).       */

import { fft, nextPow2 } from './fft.js';
import { quantile, median } from '../stats/descriptive.js';

/* morletCWT(x, fs, freqs, {nCycles}) → { freqs, power: [Float64Array], nCycles }
   `power[k][i]` é a potência (|w|²) na frequência freqs[k], amostra i.       */
export function morletCWT(x, fs, freqs, opts) {
  opts = opts || {};
  const N = x.length;
  if (!(N > 8) || !freqs || !freqs.length) return null;
  /* nCycles pode ser um número ou uma função da frequência — variar com f é o
     que dá resolução comparável ao longo do espectro */
  const nc = opts.nCycles == null ? 7 : opts.nCycles;
  const ciclosDe = f => typeof nc === 'function' ? nc(f) : nc;

  const nfft = nextPow2(N * 2);
  /* sinal com NaN → 0 para a convolução; a máscara de NaN é reaplicada depois */
  const mascara = new Uint8Array(N);
  const xr = new Float64Array(nfft), xi = new Float64Array(nfft);
  for (let i = 0; i < N; i++) {
    if (isFinite(x[i])) xr[i] = x[i]; else { xr[i] = 0; mascara[i] = 1; }
  }
  fft(xr, xi, false);

  const power = [];
  const sigmas = [];
  for (const f0 of freqs) {
    const ciclos = ciclosDe(f0);
    const st = ciclos / (2 * Math.PI * f0);            /* σ_t em segundos */
    sigmas.push(st);
    const meia = Math.min(Math.floor(3.5 * st * fs), Math.floor(nfft / 2) - 1);
    const A = Math.pow(st * Math.sqrt(Math.PI), -0.5) / Math.sqrt(fs);
    const wr = new Float64Array(nfft), wi = new Float64Array(nfft);
    /* wavelet centrada em 0 com envolvimento circular (a FFT é circular) */
    for (let n = -meia; n <= meia; n++) {
      const t = n / fs;
      const env = A * Math.exp(-(t * t) / (2 * st * st));
      const idx = (n + nfft) % nfft;
      wr[idx] = env * Math.cos(2 * Math.PI * f0 * t);
      wi[idx] = env * Math.sin(2 * Math.PI * f0 * t);
    }
    fft(wr, wi, false);
    /* multiplicação no domínio da frequência */
    const cr = new Float64Array(nfft), ci = new Float64Array(nfft);
    for (let k = 0; k < nfft; k++) {
      cr[k] = xr[k] * wr[k] - xi[k] * wi[k];
      ci[k] = xr[k] * wi[k] + xi[k] * wr[k];
    }
    fft(cr, ci, true);
    const pw = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      /* borda de cone de influência: 2σ de cada lado ficam NaN, e as amostras
         que eram lacuna continuam lacuna */
      const borda = Math.floor(2 * st * fs);
      pw[i] = (mascara[i] || i < borda || i >= N - borda) ? NaN : cr[i] * cr[i] + ci[i] * ci[i];
    }
    power.push(pw);
  }
  return {
    freqs: Array.from(freqs), power, fs, n: N,
    nCycles: typeof nc === 'function' ? 'variável com a frequência' : nc,
    sigmasSec: sigmas.map(v => +v.toFixed(4)),
    coneOfInfluenceSec: sigmas.map(v => +(2 * v).toFixed(4)),
    note: 'as bordas dentro do cone de influência voltam como NaN — não são zero, são desconhecidas'
  };
}

/* Média da potência da CWT dentro de uma banda → envelope por wavelet. */
export function waveletBandEnvelope(cwt, lo, hi) {
  if (!cwt) return null;
  const idx = [];
  cwt.freqs.forEach((f, k) => { if (f >= lo && f <= hi) idx.push(k); });
  if (!idx.length) return null;
  const N = cwt.n;
  const env = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let acc = 0, n = 0;
    for (const k of idx) { const v = cwt.power[k][i]; if (isFinite(v)) { acc += v; n++; } }
    env[i] = n === idx.length ? acc / n : NaN;
  }
  return { env, band: [lo, hi], nFreqs: idx.length };
}

/* waveletBursts(env, fs, {percentile|threshold, edgeFraction, minDurationMs})

   `edgeFraction` separa DETECÇÃO de DELIMITAÇÃO: o burst começa a existir ao
   cruzar `threshold` e é medido de onde cruza `edgeFraction × threshold`.   */
export function waveletBursts(env, fs, opts) {
  opts = opts || {};
  const pct = opts.percentile == null ? 75 : opts.percentile;
  const minMs = opts.minDurationMs == null ? 100 : opts.minDurationMs;
  const fracao = isFinite(opts.edgeFraction) ? opts.edgeFraction : 0.5;
  const validos = [];
  for (let i = 0; i < env.length; i++) if (isFinite(env[i])) validos.push(env[i]);
  if (validos.length < 32) return null;
  const thr = isFinite(opts.threshold) ? opts.threshold : quantile(validos, pct / 100);
  const thrBorda = thr * fracao;
  const minN = Math.round(minMs * fs / 1000);

  const bursts = [];
  let i = 0;
  while (i < env.length) {
    if (isFinite(env[i]) && env[i] > thr) {
      /* recua até a borda, sem atravessar lacuna */
      let a = i;
      while (a > 0 && isFinite(env[a - 1]) && env[a - 1] > thrBorda) a--;
      let b = i, pico = env[i], picoIdx = i;
      while (b < env.length && isFinite(env[b]) && env[b] > thrBorda) {
        if (env[b] > pico) { pico = env[b]; picoIdx = b; }
        b++;
      }
      const n = b - a;
      if (n >= minN) bursts.push({
        startIdx: a, endIdx: b, nSamples: n,
        startSec: +(a / fs).toFixed(4), durationMs: +(1000 * n / fs).toFixed(1),
        peak: pico, peakSec: +(picoIdx / fs).toFixed(4),
        area: (() => { let s = 0; for (let k = a; k < b; k++) if (isFinite(env[k])) s += env[k]; return s / fs; })()
      });
      i = Math.max(b, i + 1);
    } else i++;
  }
  const dur = bursts.map(b => b.durationMs);
  let nNaN = 0; for (let k = 0; k < env.length; k++) if (!isFinite(env[k])) nNaN++;
  const segundosValidos = (env.length - nNaN) / fs;
  return {
    bursts, n: bursts.length,
    threshold: thr, edgeThreshold: thrBorda, edgeFraction: fracao,
    percentile: isFinite(opts.threshold) ? null : pct,
    minDurationMs: minMs,
    rateHz: segundosValidos > 0 ? +(bursts.length / segundosValidos).toFixed(4) : NaN,
    meanDurationMs: dur.length ? +(dur.reduce((a, b) => a + b, 0) / dur.length).toFixed(1) : NaN,
    medianDurationMs: dur.length ? +median(dur).toFixed(1) : NaN,
    occupancyPct: segundosValidos > 0
      ? +(100 * bursts.reduce((a, b) => a + b.nSamples, 0) / (env.length - nNaN)).toFixed(2) : NaN,
    validSeconds: +segundosValidos.toFixed(2), nNaN,
    method: `envelope por wavelet de Morlet; detecção no limiar, delimitação em ${(100 * fracao).toFixed(0)}% do limiar`
  };
}

/* Limiar de burst a partir da LINHA DE BASE FISIOLÓGICA 1/f.

   O percentil do próprio registro é circular: se o paciente estiver todo em
   beta alto, o percentil 75 sobe junto e "não há mais bursts". Um limiar
   ancorado no componente APERIÓDICO do espectro é uma referência que não se
   move com a atividade oscilatória — é o que permite comparar visitas e
   pacientes. O preço é depender do ajuste aperiódico, e por isso o R² desse
   ajuste sai junto.

   `aperiodicFit` é a saída de fitAperiodic ou specparam; `bandLo/Hi` a banda do
   envelope. O limiar é k × (potência aperiódica integrada na banda).        */
export function aperiodicBurstThreshold(aperiodicFit, bandLo, bandHi, opts) {
  opts = opts || {};
  const k = isFinite(opts.k) ? opts.k : 2;
  if (!aperiodicFit || !aperiodicFit.f || !aperiodicFit.f.length) return null;
  const f = aperiodicFit.f;
  const ap = aperiodicFit.aperiodicLinear || aperiodicFit.aperiodic;
  if (!ap) return null;
  let soma = 0, n = 0, df = f.length > 1 ? f[1] - f[0] : 1;
  for (let i = 0; i < f.length; i++) if (f[i] >= bandLo && f[i] <= bandHi && isFinite(ap[i])) { soma += ap[i] * df; n++; }
  if (!n) return null;
  const r2 = isFinite(aperiodicFit.r2) ? aperiodicFit.r2 : NaN;
  return {
    threshold: k * soma,
    baselinePower: soma, k, band: [bandLo, bandHi],
    aperiodicR2: isFinite(r2) ? +r2.toFixed(4) : NaN,
    usable: !isFinite(r2) || r2 >= 0.8,
    rationale: `limiar = ${k}× a potência do componente aperiódico integrada em ${bandLo}–${bandHi} Hz`,
    caveat: isFinite(r2) && r2 < 0.8
      ? `o ajuste aperiódico tem R² = ${r2.toFixed(2)}; com esse ajuste o limiar fisiológico é frágil — ` +
        `prefira o percentil e declare-o`
      : 'diferente do percentil, este limiar não se move quando o paciente passa mais tempo em beta alto — ' +
        'é o que torna comparável entre visitas e entre pacientes'
  };
}

/* Sensibilidade da duração ao número de ciclos da wavelet: o mesmo sinal,
   várias escolhas. Se a duração muda muito, ela é do método, não do cérebro. */
export function burstDurationSensitivity(x, fs, band, ciclos, opts) {
  opts = opts || {};
  const lista = ciclos && ciclos.length ? ciclos : [3, 5, 7, 10];
  const freqs = [];
  for (let f = band[0]; f <= band[1]; f += Math.max(0.5, (band[1] - band[0]) / 12)) freqs.push(f);
  const linhas = lista.map(nc => {
    const cwt = morletCWT(x, fs, freqs, { nCycles: nc });
    const env = cwt && waveletBandEnvelope(cwt, band[0], band[1]);
    const bu = env && waveletBursts(env.env, fs, opts);
    return {
      nCycles: nc,
      meanDurationMs: bu ? bu.meanDurationMs : NaN,
      rateHz: bu ? bu.rateHz : NaN,
      occupancyPct: bu ? bu.occupancyPct : NaN
    };
  });
  const durs = linhas.map(l => l.meanDurationMs).filter(isFinite);
  const disp = durs.length > 1 ? (Math.max.apply(null, durs) - Math.min.apply(null, durs)) / (median(durs) || 1) : NaN;
  return {
    rows: linhas, band,
    spreadRelative: isFinite(disp) ? +disp.toFixed(3) : NaN,
    verdict: !isFinite(disp) ? 'não avaliável'
      : disp < 0.25 ? 'duração estável entre escolhas de resolução'
        : 'a duração média muda mais de 25% conforme o número de ciclos — reporte o parâmetro junto do valor'
  };
}
