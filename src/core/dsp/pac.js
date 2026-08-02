/* dsp/pac.js — acoplamento fase-amplitude (PAC) e comodulograma.

   O QUE MEDE. Se a AMPLITUDE de uma oscilação rápida (por exemplo gama de
   50–150 Hz) depende da FASE de uma lenta (beta de 13–35 Hz), há acoplamento
   fase-amplitude. No STN de pacientes com Parkinson, o PAC beta-gama está
   elevado no estado OFF, cai com levodopa e cai com DBS eficaz — é um dos
   poucos marcadores que descreve a INTERAÇÃO entre ritmos, e não cada um
   isolado.

   POR QUE O CUIDADO METODOLÓGICO É MAIOR AQUI DO QUE EM QUALQUER OUTRA MÉTRICA
   DESTE SOFTWARE. PAC é notoriamente fácil de produzir por artefato:
     • uma forma de onda não senoidal (dente de serra, pico agudo) gera
       harmônicos que se acoplam à própria fundamental — PAC "espúrio" sem
       nenhuma interação entre redes distintas;
     • artefato de estimulação, transientes e mudanças bruscas de amplitude
       criam acoplamento aparente;
     • o valor bruto do índice de modulação depende de comprimento do registro,
       número de bins e largura das bandas.
   Por isso NADA aqui devolve MI cru sozinho: o resultado sempre traz o
   z-escore contra SURROGADOS e o p correspondente, e a checagem de
   não senoidalidade fica registrada. Referência do problema: Aru J, et al.
   Prog Neurobiol 2015;51:51-73; Cole SR, Voytek B. Trends Cogn Sci 2017;21:137.

   Método: índice de modulação de Tort — divergência de Kullback-Leibler entre
   a distribuição de amplitude por bin de fase e a uniforme, normalizada por
   log(nBins). MI = 0 significa amplitude independente da fase.

   Unidades: MI é adimensional em [0, 1]; z é em desvios do nulo.

   Referências:
     Tort ABL, et al. J Neurophysiol 2010;104:1195-1210.
     Canolty RT, et al. Science 2006;313:1626-1628.
     de Hemptinne C, et al. Nat Neurosci 2015;18:779-786 (PAC no córtex motor
       cai com DBS de STN).
     Swann NC, et al. J Neurosci 2015;35:5941-5949.                          */

import { bandpassFFT } from './filters.js';
import { fft, nextPow2 } from './fft.js';
import { mean, sd } from '../stats/descriptive.js';

/* Fase e amplitude analíticas por Hilbert (sem interpolar lacuna: NaN entra e
   NaN sai, e a máscara é devolvida). */
export function analytic(x) {
  const N = x.length, n = nextPow2(N);
  const re = new Float64Array(n), im = new Float64Array(n);
  const nan = new Uint8Array(N);
  for (let i = 0; i < N; i++) { if (isFinite(x[i])) re[i] = x[i]; else nan[i] = 1; }
  fft(re, im, false);
  const h = new Float64Array(n);
  h[0] = 1; if (n % 2 === 0) h[n / 2] = 1;
  for (let i = 1; i < n / 2; i++) h[i] = 2;
  for (let i = 0; i < n; i++) { re[i] *= h[i]; im[i] *= h[i]; }
  fft(re, im, true);
  const fase = new Float64Array(N), amp = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    if (nan[i]) { fase[i] = NaN; amp[i] = NaN; }
    else { fase[i] = Math.atan2(im[i], re[i]); amp[i] = Math.hypot(re[i], im[i]); }
  }
  return { phase: fase, amplitude: amp, nanMask: nan };
}

/* Índice de modulação de Tort a partir de fase e amplitude já extraídas. */
export function tortMI(fase, amp, nBins) {
  nBins = nBins || 18;
  const soma = new Float64Array(nBins), cont = new Float64Array(nBins);
  let n = 0;
  for (let i = 0; i < fase.length; i++) {
    if (!isFinite(fase[i]) || !isFinite(amp[i])) continue;
    let b = Math.floor((fase[i] + Math.PI) / (2 * Math.PI) * nBins);
    if (b < 0) b = 0; if (b >= nBins) b = nBins - 1;
    soma[b] += amp[i]; cont[b]++; n++;
  }
  if (n < 200) return { mi: NaN, n, reason: 'amostras válidas insuficientes para o índice de modulação' };
  const media = new Float64Array(nBins);
  let total = 0;
  for (let b = 0; b < nBins; b++) { media[b] = cont[b] ? soma[b] / cont[b] : 0; total += media[b]; }
  if (!(total > 0)) return { mi: NaN, n, reason: 'amplitude nula' };
  let H = 0;
  const dist = new Float64Array(nBins);
  for (let b = 0; b < nBins; b++) {
    dist[b] = media[b] / total;
    if (dist[b] > 0) H -= dist[b] * Math.log(dist[b]);
  }
  const mi = (Math.log(nBins) - H) / Math.log(nBins);
  /* fase preferida: bin de maior amplitude média */
  let bi = 0; for (let b = 1; b < nBins; b++) if (dist[b] > dist[bi]) bi = b;
  return {
    mi, n, nBins,
    distribution: Array.from(dist).map(v => +v.toFixed(6)),
    preferredPhaseRad: +(-Math.PI + (bi + 0.5) * 2 * Math.PI / nBins).toFixed(4),
    modulationDepthPct: +(100 * (Math.max.apply(null, Array.from(dist)) - Math.min.apply(null, Array.from(dist)))
      / (1 / nBins)).toFixed(1),
    reason: null
  };
}

/* pacTort(x, fs, {phaseBand, ampBand, nBins, nSurrogates})
   → MI com z-escore contra surrogados por deslocamento temporal em bloco.   */
export function pacTort(x, fs, opts) {
  opts = opts || {};
  const fp = opts.phaseBand || [13, 30];
  const fa = opts.ampBand || [50, 150];
  const nBins = opts.nBins || 18;
  const nSur = opts.nSurrogates == null ? 200 : opts.nSurrogates;
  const nyq = fs / 2;
  if (fa[1] >= nyq) fa[1] = Math.max(fa[0] + 5, nyq - 1);
  if (fa[0] >= fa[1]) return null;
  /* a banda de amplitude precisa ser larga o bastante para conter as bandas
     laterais fp — sem isso o PAC não é detectável, e o software avisa em vez
     de devolver zero (Aru et al. 2015) */
  const larguraOk = (fa[1] - fa[0]) >= 2 * fp[1];

  const N = x.length;
  if (N < 4 * fs) return null;
  const xf = bandpassFFT(x, fs, fp[0], fp[1]);
  const xa = bandpassFFT(x, fs, fa[0], fa[1]);
  const A = analytic(xf), B = analytic(xa);
  const obs = tortMI(A.phase, B.amplitude, nBins);
  if (!isFinite(obs.mi)) return Object.assign({ phaseBand: fp, ampBand: fa }, obs);

  /* surrogados: desloca a série de amplitude em blocos, preservando a estrutura
     temporal de cada uma e destruindo apenas a relação entre elas. Semente fixa
     para reprodutibilidade. */
  let semente = (opts.seed >>> 0) || 13572468;
  const prox = () => { semente = (Math.imul(semente, 1664525) + 1013904223) >>> 0; return semente / 4294967296; };
  const minDesloc = Math.floor(fs);              /* ao menos 1 s de deslocamento */
  const nulos = [];
  const ampDesloc = new Float64Array(N);
  for (let s = 0; s < nSur; s++) {
    const d = minDesloc + Math.floor(prox() * (N - 2 * minDesloc));
    for (let i = 0; i < N; i++) ampDesloc[i] = B.amplitude[(i + d) % N];
    const m = tortMI(A.phase, ampDesloc, nBins);
    if (isFinite(m.mi)) nulos.push(m.mi);
  }
  const mu = nulos.length ? mean(nulos) : NaN;
  const s0 = nulos.length > 2 ? sd(nulos) : NaN;
  const z = isFinite(s0) && s0 > 0 ? (obs.mi - mu) / s0 : NaN;
  const maiores = nulos.filter(v => v >= obs.mi).length;
  const pEmp = nulos.length ? (maiores + 1) / (nulos.length + 1) : NaN;

  return Object.assign({}, obs, {
    phaseBand: fp, ampBand: fa, nSurrogates: nulos.length, seed: (opts.seed >>> 0) || 13572468,
    miSurrogateMean: isFinite(mu) ? +mu.toExponential(4) : NaN,
    z: isFinite(z) ? +z.toFixed(3) : NaN,
    pEmpirical: isFinite(pEmp) ? +pEmp.toFixed(4) : NaN,
    significant: isFinite(pEmp) && pEmp < 0.05,
    ampBandWideEnough: larguraOk,
    warning: larguraOk ? null
      : `a banda de amplitude (${fa[0]}–${fa[1]} Hz) é estreita demais para conter as bandas laterais de ` +
        `${fp[1]} Hz; PAC pode não ser detectável mesmo existindo (Aru et al. 2015) — alargue a banda de amplitude`,
    caveat: 'PAC é sensível a forma de onda não senoidal: um pico agudo gera harmônicos que se acoplam à ' +
      'própria fundamental sem nenhuma interação entre redes. Verifique a assimetria da onda (waveformAsymmetry) ' +
      'antes de interpretar acoplamento beta-gama como fisiológico.'
  });
}

/* Comodulograma: grade de bandas de fase × bandas de amplitude.
   Os surrogados rodam apenas nas células que passam de um MI mínimo, senão o
   custo explode — e a política fica declarada em `surrogatePolicy`.         */
export function comodulogram(x, fs, opts) {
  opts = opts || {};
  const fase0 = opts.phaseRange || [4, 40], faseW = opts.phaseWidth || 4, faseStep = opts.phaseStep || 2;
  const amp0 = opts.ampRange || [30, 150], ampStep = opts.ampStep || 10;
  const nBins = opts.nBins || 18;
  const nSur = opts.nSurrogates == null ? 100 : opts.nSurrogates;
  const nyq = fs / 2;

  const fasesC = [], ampsC = [];
  for (let c = fase0[0]; c + faseW <= fase0[1]; c += faseStep) fasesC.push(c + faseW / 2);
  for (let c = amp0[0]; c + ampStep <= Math.min(amp0[1], nyq - 2); c += ampStep) ampsC.push(c + ampStep / 2);
  if (!fasesC.length || !ampsC.length) return null;

  /* pré-computa fases e amplitudes uma única vez por banda */
  const fases = fasesC.map(c => analytic(bandpassFFT(x, fs, c - faseW / 2, c + faseW / 2)).phase);
  const amps = ampsC.map(c => {
    /* a banda de amplitude acompanha a maior frequência de fase, para conter as
       bandas laterais — largura mínima de 2×fmax da fase */
    const meia = Math.max(ampStep / 2, fase0[1]);
    return analytic(bandpassFFT(x, fs, Math.max(1, c - meia), Math.min(nyq - 1, c + meia))).amplitude;
  });

  const grade = [];
  let maxMi = 0;
  for (let i = 0; i < fasesC.length; i++)
    for (let j = 0; j < ampsC.length; j++) {
      const m = tortMI(fases[i], amps[j], nBins);
      const mi = isFinite(m.mi) ? m.mi : NaN;
      if (isFinite(mi) && mi > maxMi) maxMi = mi;
      grade.push({ i, j, phaseHz: +fasesC[i].toFixed(2), ampHz: +ampsC[j].toFixed(2), mi, z: NaN, p: NaN });
    }

  /* surrogados só onde vale a pena */
  const corte = opts.surrogateMinMi == null ? 0.3 * maxMi : opts.surrogateMinMi;
  let semente = (opts.seed >>> 0) || 24681357;
  const prox = () => { semente = (Math.imul(semente, 1664525) + 1013904223) >>> 0; return semente / 4294967296; };
  const N = x.length, minDesloc = Math.floor(fs);
  let nTestadas = 0;
  const desloc = new Float64Array(N);
  grade.forEach(c => {
    if (!(isFinite(c.mi) && c.mi >= corte) || nSur < 10) return;
    const fase = fases[c.i], amp = amps[c.j];
    const nulos = [];
    for (let s = 0; s < nSur; s++) {
      const d = minDesloc + Math.floor(prox() * (N - 2 * minDesloc));
      for (let k = 0; k < N; k++) desloc[k] = amp[(k + d) % N];
      const m = tortMI(fase, desloc, nBins);
      if (isFinite(m.mi)) nulos.push(m.mi);
    }
    if (nulos.length > 2) {
      const mu = mean(nulos), s0 = sd(nulos);
      c.z = s0 > 0 ? +((c.mi - mu) / s0).toFixed(3) : NaN;
      c.p = +((nulos.filter(v => v >= c.mi).length + 1) / (nulos.length + 1)).toFixed(4);
      nTestadas++;
    }
  });

  const melhor = grade.filter(c => isFinite(c.mi)).sort((a, b) => b.mi - a.mi)[0] || null;
  return {
    phaseCenters: fasesC, ampCenters: ampsC, grid: grade,
    phaseWidth: faseW, nBins, nSurrogates: nSur,
    maxMi: +maxMi.toExponential(4),
    peak: melhor ? {
      phaseHz: melhor.phaseHz, ampHz: melhor.ampHz,
      mi: +melhor.mi.toExponential(4), z: melhor.z, p: melhor.p
    } : null,
    surrogatePolicy: `surrogados calculados apenas nas células com MI ≥ ${(corte).toExponential(2)} ` +
      `(${nTestadas} de ${grade.length} células); as demais aparecem sem z e sem p — ausência de teste, não ausência de efeito`,
    caveat: 'valores de MI não são comparáveis entre registros de durações diferentes; compare z, não MI.'
  };
}

/* Assimetria da forma de onda — o teste que separa PAC fisiológico de PAC por
   harmônico. Razão pico-vale (sharpness ratio) e razão de inclinação
   (steepness ratio) de Cole & Voytek. Valores longe de 1 indicam onda não
   senoidal, e nesse caso o PAC pode ser artefato de forma de onda.          */
export function waveformAsymmetry(x, fs, lo, hi) {
  const banda = bandpassFFT(x, fs, lo, hi);
  const N = x.length;
  /* cruzamentos de zero da banda definem os ciclos */
  const subidas = [], descidas = [];
  for (let i = 1; i < N; i++) {
    if (!isFinite(banda[i]) || !isFinite(banda[i - 1])) continue;
    if (banda[i - 1] <= 0 && banda[i] > 0) subidas.push(i);
    if (banda[i - 1] >= 0 && banda[i] < 0) descidas.push(i);
  }
  if (subidas.length < 5 || descidas.length < 5) return null;
  const jan = Math.max(1, Math.round(fs / (4 * hi)));
  const agudez = (idx, sinal) => {
    /* agudez local do extremo: média das diferenças para os vizinhos */
    const a = idx - jan >= 0 ? x[idx - jan] : NaN, b = idx + jan < N ? x[idx + jan] : NaN;
    if (!isFinite(a) || !isFinite(b) || !isFinite(x[idx])) return NaN;
    return sinal * ((x[idx] - a) + (x[idx] - b)) / 2;
  };
  const extremo = (ini, fim, maior) => {
    let bi = -1, bv = maior ? -Infinity : Infinity;
    for (let i = ini; i < fim && i < N; i++) {
      if (!isFinite(banda[i])) continue;
      if (maior ? banda[i] > bv : banda[i] < bv) { bv = banda[i]; bi = i; }
    }
    return bi;
  };
  const picos = [], vales = [];
  for (let k = 0; k + 1 < subidas.length; k++) {
    const d = descidas.find(v => v > subidas[k] && v < subidas[k + 1]);
    if (d == null) continue;
    const ip = extremo(subidas[k], d, true);
    const iv = extremo(d, subidas[k + 1], false);
    if (ip >= 0) { const v = agudez(ip, 1); if (isFinite(v)) picos.push(v); }
    if (iv >= 0) { const v = agudez(iv, -1); if (isFinite(v)) vales.push(v); }
  }
  if (picos.length < 3 || vales.length < 3) return null;
  const mp = Math.max(0, mean(picos)), mv = Math.max(0, mean(vales));
  /* índice limitado em [0,1] (Cole & Voytek): 0,5 é simetria perfeita. A razão
     bruta explode quando um dos lados tende a zero — é reportada só como
     referência, com teto, e a DECISÃO usa o índice limitado. */
  const simetria = (mp + mv) > 0 ? mp / (mp + mv) : 0.5;
  const razao = Math.min(999, Math.max(mp, mv) / Math.max(1e-9, Math.min(mp, mv)));

  /* razão de inclinação: subida vs. descida do sinal bruto dentro dos ciclos */
  let subida = 0, descida = 0, ns = 0;
  for (let i = 1; i < N; i++) {
    if (!isFinite(x[i]) || !isFinite(x[i - 1])) continue;
    const d = x[i] - x[i - 1];
    if (d > 0) subida += d; else descida -= d;
    ns++;
  }
  const razaoInc = Math.max(subida, descida) / Math.max(1e-12, Math.min(subida, descida));

  const assimetrico = Math.abs(simetria - 0.5) > 0.045 || razaoInc > 1.2;
  return {
    band: [lo, hi], nCycles: Math.min(picos.length, vales.length),
    peakTroughSymmetry: +simetria.toFixed(4),
    sharpnessRatio: +razao.toFixed(3),
    sharpnessRatioCapped: razao >= 999,
    steepnessRatio: +razaoInc.toFixed(3),
    nonSinusoidal: assimetrico,
    interpretation: assimetrico
      ? 'a onda é claramente não senoidal — parte do PAC medido pode ser harmônico da própria banda de fase, ' +
        'não interação entre ritmos distintos (Cole & Voytek 2017)'
      : 'a onda é aproximadamente senoidal nesta banda; o PAC medido não é explicado por assimetria de forma de onda'
  };
}
