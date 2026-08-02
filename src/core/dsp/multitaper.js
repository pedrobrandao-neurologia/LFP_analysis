/* dsp/multitaper.js — estimador multitaper com sequências de Slepian (DPSS).

   POR QUE ISTO EXISTE. O Welch reduz variância dividindo o registro em
   segmentos e mediando — ao custo de resolução em frequência e de vazamento
   espectral controlado só pela janela. O multitaper resolve o mesmo problema
   sem picar o registro: aplica K janelas ORTOGONAIS ao MESMO trecho e media os
   K periodogramas. Cada janela é uma sequência de Slepian, a família que
   maximiza a concentração de energia dentro de uma banda ±W — é a escolha ótima
   no sentido de mínimo vazamento para uma dada resolução.

   ONDE ISSO MUDA A CONCLUSÃO em LFP do Percept:
     • trechos curtos (streaming de 20–60 s) rendem poucos segmentos de Welch;
       o multitaper usa o trecho inteiro e ainda assim reduz variância;
     • picos beta estreitos vizinhos a artefato de estimulação sofrem menos
       vazamento, o que muda a frequência de pico estimada;
     • o intervalo de confiança por jackknife entre tapers dá uma medida de
       incerteza que o Welch, sem repetições independentes, não oferece.

   COMO AS DPSS SÃO CALCULADAS AQUI (do zero, sem dependência). As DPSS de
   ordem k são autovetores da matriz tridiagonal simétrica de Percival & Walden:
       d[i] = ((N-1-2i)/2)² · cos(2πW),          i = 0 … N-1
       e[i] = i(N-i)/2,                          i = 1 … N-1
   cujos autovalores em ordem DECRESCENTE correspondem às ordens 0, 1, 2, …
   Encontramos os K maiores autovalores por BISSECÇÃO usando a sequência de
   Sturm (contagem de autovalores abaixo de um ponto pela recorrência LDLᵀ) e,
   para cada um, o autovetor por ITERAÇÃO INVERSA com o algoritmo de Thomas,
   ortogonalizando contra os já obtidos. Tudo O(N) por iteração.

   A razão de concentração λ_k (quanta energia da janela cai dentro de ±W) sai
   por Parseval, integrando |V(f)|² dentro de ±W — O(M log M) em vez dos O(N²)
   da forma quadrática vᵀSv com a matriz sinc, que inviabilizaria janelas de
   dezenas de milhares de amostras. λ é REPORTADO, não escondido: tapers de λ
   baixo vazam e o usuário precisa saber quantos entraram.

   Unidades: entrada em µV, saída em µV²/Hz. Lacunas (NaN) NÃO são interpoladas:
   o estimador roda no maior trecho contíguo sem NaN, e a fração usada é
   reportada.

   Referências:
     Slepian D. Bell Syst Tech J 1978;57:1371-1430.
     Thomson DJ. Proc IEEE 1982;70:1055-1096.
     Percival DB, Walden AT. Spectral Analysis for Physical Applications.
       Cambridge, 1993 — cap. 8 (tridiagonal), eq. 8.16.
     Babadi B, Brown EN. IEEE Trans Biomed Eng 2014;61:1555-1564 (revisão em
       neurociência).                                                         */

import { fft, nextPow2 } from './fft.js';
import { detrendLinearNaN, nanStats } from './nan.js';
import { quantile } from '../stats/descriptive.js';

/* Conta autovalores da tridiagonal (d, e) estritamente menores que `x`.
   Recorrência LDLᵀ; o número de pivôs negativos é a contagem de Sturm.      */
function contaSturm(d, e2, x) {
  const n = d.length;
  let q = d[0] - x, cont = q < 0 ? 1 : 0;
  for (let i = 1; i < n; i++) {
    if (q === 0) q = 1e-300;
    q = d[i] - x - e2[i] / q;
    if (q < 0) cont++;
  }
  return cont;
}

/* k-ésimo maior autovalor (k = 0 é o maior) por bissecção. */
function autovalorKesimo(d, e2, k, lo, hi) {
  const n = d.length;
  /* queremos o autovalor de índice (n-1-k) em ordem crescente */
  const alvo = n - 1 - k;
  for (let it = 0; it < 200; it++) {
    const meio = (lo + hi) / 2;
    if (contaSturm(d, e2, meio) <= alvo) lo = meio; else hi = meio;
    if (hi - lo < 1e-12 * Math.max(1, Math.abs(hi))) break;
  }
  return (lo + hi) / 2;
}

/* Resolve (T - λI)v = b, T tridiagonal simétrica, pelo algoritmo de Thomas. */
function resolveTridiagonal(d, e, lambda, b) {
  const n = d.length;
  const c = new Float64Array(n), y = new Float64Array(n), v = new Float64Array(n);
  let beta = d[0] - lambda;
  if (Math.abs(beta) < 1e-300) beta = 1e-300;
  c[0] = e[1] / beta; y[0] = b[0] / beta;
  for (let i = 1; i < n; i++) {
    beta = (d[i] - lambda) - e[i] * c[i - 1];
    if (Math.abs(beta) < 1e-300) beta = 1e-300;
    c[i] = (i + 1 < n ? e[i + 1] : 0) / beta;
    y[i] = (b[i] - e[i] * y[i - 1]) / beta;
  }
  v[n - 1] = y[n - 1];
  for (let i = n - 2; i >= 0; i--) v[i] = y[i] - c[i] * v[i + 1];
  return v;
}

function normaliza(v) {
  let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= s;
  return v;
}

/* dpss(N, NW, K) → { tapers: [Float64Array], concentrations: [λ_k] } */
export function dpss(N, NW, K) {
  N = Math.floor(N);
  if (!(N > 4) || !(NW > 0.5)) return null;
  K = Math.max(1, Math.min(Math.floor(K || Math.floor(2 * NW - 1)), N - 1));
  const W = NW / N;
  const cos2piW = Math.cos(2 * Math.PI * W);
  const d = new Float64Array(N), e = new Float64Array(N), e2 = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t = (N - 1 - 2 * i) / 2;
    d[i] = t * t * cos2piW;
  }
  for (let i = 1; i < N; i++) { e[i] = i * (N - i) / 2; e2[i] = e[i] * e[i]; }

  /* limites de Gershgorin para a bissecção */
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < N; i++) {
    const raio = (i > 0 ? e[i] : 0) + (i + 1 < N ? e[i + 1] : 0);
    lo = Math.min(lo, d[i] - raio); hi = Math.max(hi, d[i] + raio);
  }
  const margem = 1e-6 * Math.max(1, hi - lo);
  lo -= margem; hi += margem;

  const tapers = [];
  for (let k = 0; k < K; k++) {
    const lam = autovalorKesimo(d, e2, k, lo, hi);
    /* iteração inversa: partida determinística (não pode depender de random,
       a análise precisa ser reprodutível) */
    let v = new Float64Array(N);
    for (let i = 0; i < N; i++) v[i] = Math.sin(Math.PI * (k + 1) * (i + 0.5) / N);
    normaliza(v);
    const desloc = lam * (1 + 1e-10) + 1e-9 * Math.max(1, Math.abs(lam));
    for (let it = 0; it < 6; it++) {
      v = resolveTridiagonal(d, e, desloc, v);
      /* ortogonaliza contra os tapers já encontrados (Gram-Schmidt modificado) */
      for (const u of tapers) {
        let dot = 0; for (let i = 0; i < N; i++) dot += u[i] * v[i];
        for (let i = 0; i < N; i++) v[i] -= dot * u[i];
      }
      normaliza(v);
    }
    /* convenção de polaridade de Percival & Walden: ordem par com soma
       positiva; ordem ímpar com primeira metade positiva */
    if (k % 2 === 0) {
      let s = 0; for (let i = 0; i < N; i++) s += v[i];
      if (s < 0) for (let i = 0; i < N; i++) v[i] = -v[i];
    } else {
      let s = 0; for (let i = 0; i < Math.floor(N / 2); i++) s += v[i];
      if (s < 0) for (let i = 0; i < N; i++) v[i] = -v[i];
    }
    tapers.push(v);
  }

  /* Concentração λ_k = fração da energia da janela dentro de |f| ≤ W.
     A forma quadrática vᵀSv com a matriz sinc é O(N²) e inviabiliza janelas de
     dezenas de milhares de amostras. A identidade de Parseval dá o mesmo número
     em O(M log M): com ‖v‖ = 1, ∫|V(f)|²df = 1 sobre toda a banda, então basta
     integrar |V(f)|² dentro de ±W. */
  const M = Math.max(nextPow2(4 * N), 1024);
  const concentrations = tapers.map(v => {
    const re = new Float64Array(M), im = new Float64Array(M);
    for (let i = 0; i < N; i++) re[i] = v[i];
    fft(re, im, false);
    const kMax = Math.floor(W * M);
    let dentro = 0, total = 0;
    for (let k = 0; k < M; k++) {
      const e = re[k] * re[k] + im[k] * im[k];
      total += e;
      const kk = k <= M / 2 ? k : M - k;              /* frequência dobrada */
      if (kk <= kMax) dentro += e;
    }
    return total > 0 ? dentro / total : NaN;
  });

  return { N, NW, K, W, tapers, concentrations };
}

/* multitaperPSD(x, fs, {NW, K, nfft, minConcentration, jackknife})
   → { f, p, K, KUsed, concentrations, ciLow, ciHigh, df, ... }              */
export function multitaperPSD(x, fs, opts) {
  opts = opts || {};
  const NW = isFinite(opts.NW) ? opts.NW : 3;
  const minConc = isFinite(opts.minConcentration) ? opts.minConcentration : 0.9;
  const est = nanStats(x);

  /* maior trecho contíguo sem NaN — não interpolamos lacuna para "poder rodar" */
  let melhorIni = 0, melhorLen = 0, ini = -1;
  for (let i = 0; i <= x.length; i++) {
    const ok = i < x.length && isFinite(x[i]);
    if (ok && ini < 0) ini = i;
    if (!ok && ini >= 0) { if (i - ini > melhorLen) { melhorLen = i - ini; melhorIni = ini; } ini = -1; }
  }
  const N = melhorLen;
  const base = {
    NW, minConcentration: minConc,
    nUsed: N, nTotal: x.length,
    pctDataUsed: x.length ? +(100 * N / x.length).toFixed(2) : 0,
    pctNan: est.pctNan
  };
  if (N < 32 || !(fs > 0))
    return Object.assign({ f: [], p: null, reason: 'nenhum trecho contíguo longo o bastante para o multitaper' }, base);

  const KPedido = Math.max(1, Math.min(Math.floor(opts.K || Math.floor(2 * NW - 1)), N - 1));
  const sl = dpss(N, NW, KPedido);
  if (!sl) return Object.assign({ f: [], p: null, reason: 'não foi possível construir as sequências de Slepian' }, base);

  /* tapers pouco concentrados vazam; são descartados e isso é reportado */
  const usados = [];
  sl.tapers.forEach((v, k) => { if (sl.concentrations[k] >= minConc || k === 0) usados.push(k); });

  const nfft = Math.max(nextPow2(N), nextPow2(opts.nfft || N));
  const nBins = nfft / 2 + 1;
  const seg = detrendLinearNaN(x.subarray ? x.subarray(melhorIni, melhorIni + N) : x.slice(melhorIni, melhorIni + N));

  const porTaper = [];
  for (const k of usados) {
    const v = sl.tapers[k];
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    for (let i = 0; i < N; i++) re[i] = (isFinite(seg[i]) ? seg[i] : 0) * v[i];
    fft(re, im, false);
    const s = new Float64Array(nBins);
    for (let b = 0; b < nBins; b++) {
      const mag = (re[b] * re[b] + im[b] * im[b]) / fs;
      s[b] = (b === 0 || b === nBins - 1) ? mag : 2 * mag;
    }
    porTaper.push(s);
  }

  const K = porTaper.length;
  const f = new Float64Array(nBins), p = new Float64Array(nBins);
  for (let b = 0; b < nBins; b++) {
    let acc = 0; for (let k = 0; k < K; k++) acc += porTaper[k][b];
    f[b] = b * fs / nfft; p[b] = acc / K;
  }

  /* IC por jackknife entre tapers, em escala log (Thomson & Chave 1991).
     Só faz sentido com K ≥ 3 — abaixo disso devolvemos null em vez de um
     intervalo que parece informativo e não é. */
  let ciLow = null, ciHigh = null;
  if (K >= 3 && opts.jackknife !== false) {
    ciLow = new Float64Array(nBins); ciHigh = new Float64Array(nBins);
    const t = 2.0;                                   /* ≈ t_{0.975} para gl ≥ 8 */
    for (let b = 0; b < nBins; b++) {
      const logs = new Array(K);
      for (let j = 0; j < K; j++) {
        let acc = 0;
        for (let k = 0; k < K; k++) if (k !== j) acc += porTaper[k][b];
        logs[j] = Math.log(Math.max(acc / (K - 1), 1e-300));
      }
      const m = logs.reduce((a, v) => a + v, 0) / K;
      let s2 = 0; for (let j = 0; j < K; j++) s2 += (logs[j] - m) * (logs[j] - m);
      const se = Math.sqrt((K - 1) / K * s2);
      const lp = Math.log(Math.max(p[b], 1e-300));
      ciLow[b] = Math.exp(lp - t * se);
      ciHigh[b] = Math.exp(lp + t * se);
    }
  }

  return Object.assign({
    f, p, reason: null,
    K, KRequested: KPedido, KDropped: KPedido - K,
    concentrations: sl.concentrations.map(v => +v.toFixed(6)),
    minConcentrationUsed: usados.length ? +Math.min.apply(null, usados.map(k => sl.concentrations[k])).toFixed(6) : NaN,
    df: fs / nfft,
    resolutionHz: +(2 * NW * fs / N).toFixed(4),
    dofApprox: 2 * K,
    ciLow, ciHigh,
    method: `multitaper de Slepian, NW = ${NW}, K = ${K} taper(s)`
  }, base);
}

/* Comparação honesta entre Welch e multitaper no mesmo trecho: onde os dois
   concordam, a estimativa é robusta; onde divergem, o vazamento importa. */
export function compareEstimators(welch, mt, lo, hi) {
  if (!welch || !welch.p || !mt || !mt.p) return null;
  const pico = (f, p) => {
    let bf = NaN, bv = -Infinity;
    for (let i = 0; i < f.length; i++) if (f[i] >= lo && f[i] <= hi && p[i] > bv) { bv = p[i]; bf = f[i]; }
    return { f: bf, v: bv };
  };
  const a = pico(welch.f, welch.p), b = pico(mt.f, mt.p);
  const dif = Math.abs(a.f - b.f);
  return {
    band: [lo, hi],
    welchPeakHz: +a.f.toFixed(3), multitaperPeakHz: +b.f.toFixed(3),
    deltaHz: +dif.toFixed(3),
    agree: dif <= Math.max(welch.df, mt.df) * 1.5,
    note: dif <= Math.max(welch.df, mt.df) * 1.5
      ? 'os dois estimadores encontram o mesmo pico — a estimativa não depende da escolha do método'
      : `os estimadores discordam em ${dif.toFixed(2)} Hz; com vazamento espectral relevante o multitaper ` +
        `costuma ser o mais confiável, mas a divergência precisa ser reportada`
  };
}

/* Utilitário para a interface: a mediana da razão IC alto/IC baixo resume a
   incerteza do espectro inteiro num número. */
export function spectralUncertainty(mt) {
  if (!mt || !mt.ciLow || !mt.ciHigh) return NaN;
  const r = [];
  for (let i = 1; i < mt.p.length; i++) if (mt.ciLow[i] > 0) r.push(mt.ciHigh[i] / mt.ciLow[i]);
  return r.length ? +quantile(r, 0.5).toFixed(3) : NaN;
}
