/* dsp/specparam.js — specparam/FOOOF completo.

   O QUE MUDA EM RELAÇÃO A `dsp/aperiodic.js`. Aquele módulo faz uma
   aproximação robusta e barata: reta em log-log e picos como resíduo. Serve
   para anotar uma figura, não para publicar um expoente. Aqui está o
   procedimento do artigo original, com o que ele exige:

     1. ajuste aperiódico inicial (robusto: reajusta só sobre os pontos abaixo
        da primeira reta, para que os picos não puxem a inclinação);
     2. espectro achatado = log10(P) − aperiódico;
     3. busca ITERATIVA de picos: o maior ponto do espectro achatado vira uma
        gaussiana ajustada e subtraída, e o processo repete até `maxNPeaks` ou
        até nenhum ponto passar do limiar;
     4. filtragem por altura mínima e por LARGURA — gaussiana larga demais é
        modelo ruim, não achado;
     5. reajuste SIMULTÂNEO de todas as gaussianas (Levenberg-Marquardt);
     6. reajuste do aperiódico sobre o espectro SEM os picos;
     7. R² e erro absoluto médio do modelo completo — sem eles o expoente não
        deve ser reportado.

   MODO COM JOELHO. `aperiodicMode: 'knee'` ajusta L(f) = b − log10(k + f^χ),
   que descreve o achatamento em baixas frequências. O modo é uma ESCOLHA e o
   ajuste devolve os dois, com R² de cada um, para que a escolha seja
   justificada em vez de silenciosa. Sem joelho: L(f) = b − χ·log10(f).

   Referência: Donoghue T, et al. Parameterizing neural power spectra into
   periodic and aperiodic components. Nat Neurosci 2020;23:1655-1665.

   Unidades: f em Hz, potência na unidade do espectro de entrada; `exponent` é
   adimensional; `knee` está na unidade de f^χ.                              */

import { levenbergMarquardt } from '../stats/optimize.js';
import { mean, sd, quantile } from '../stats/descriptive.js';

const gauss = (f, a, c, s) => a * Math.exp(-((f - c) * (f - c)) / (2 * s * s));

/* aperiódico em log10(potência): modo 'fixed' (2 parâmetros) ou 'knee' (3) */
function apFn(modo) {
  return modo === 'knee'
    ? (f, p) => p[0] - Math.log10(Math.max(1e-12, p[1] + Math.pow(f, p[2])))
    : (f, p) => p[0] - p[1] * Math.log10(Math.max(1e-12, f));
}

/* ajuste aperiódico robusto: ajusta, descarta o que ficou ACIMA da curva
   (isto é, os picos), reajusta. */
function ajustaAperiodico(f, logp, modo, chute) {
  const fn = apFn(modo);
  const lower = modo === 'knee' ? [-Infinity, 0, 0.05] : [-Infinity, 0.05];
  const upper = modo === 'knee' ? [Infinity, 1e6, 8] : [Infinity, 8];
  let r = levenbergMarquardt(f, logp, fn, chute, { lower, upper, maxIter: 120 });
  const res = f.map((x, i) => logp[i] - fn(x, r.params));
  const limiar = 0.025 * (Math.max.apply(null, logp) - Math.min.apply(null, logp)) + quantile(res, 0.5);
  const fi = [], li = [];
  f.forEach((x, i) => { if (res[i] <= limiar) { fi.push(x); li.push(logp[i]); } });
  if (fi.length >= chute.length + 3)
    r = levenbergMarquardt(fi, li, fn, r.params.slice(), { lower, upper, maxIter: 120 });
  return { params: r.params, fn, r2: r.r2, nUsed: fi.length };
}

/* specparam(f, p, opts) */
export function specparam(f, p, opts) {
  opts = opts || {};
  const fmin = isFinite(opts.fmin) ? opts.fmin : 2;
  const fmax = isFinite(opts.fmax) ? opts.fmax : 95;
  const maxN = isFinite(opts.maxNPeaks) ? opts.maxNPeaks : 6;
  const minAlt = isFinite(opts.minPeakHeight) ? opts.minPeakHeight : 0.05;   /* log10 */
  const limiarSD = isFinite(opts.peakThreshold) ? opts.peakThreshold : 2.0;  /* em SD */
  const larguraLim = opts.peakWidthLimits || [1, 12];                        /* Hz, largura total */
  const modo = opts.aperiodicMode === 'knee' ? 'knee' : 'fixed';

  const F = [], LP = [];
  for (let i = 0; i < f.length; i++)
    if (f[i] >= fmin && f[i] <= fmax && isFinite(p[i]) && p[i] > 0) { F.push(f[i]); LP.push(Math.log10(p[i])); }
  if (F.length < 12) return null;

  const chute = modo === 'knee'
    ? [LP[0], 1, 1]
    : [LP[0], 1];
  let ap = ajustaAperiodico(F, LP, modo, chute);

  /* --- busca iterativa de picos sobre o espectro achatado ----------------- */
  let achatado = F.map((x, i) => LP[i] - ap.fn(x, ap.params));
  const sigmaMin = larguraLim[0] / 2, sigmaMax = larguraLim[1] / 2;
  const candidatos = [];
  const trabalho = achatado.slice();
  for (let it = 0; it < maxN; it++) {
    let bi = -1, bv = -Infinity;
    for (let i = 0; i < trabalho.length; i++) if (trabalho[i] > bv) { bv = trabalho[i]; bi = i; }
    if (bi < 0) break;
    const desvio = sd(trabalho) || 1e-9;
    if (bv < limiarSD * desvio || bv < minAlt) break;

    /* estimativa da largura pela meia altura, limitada pelos limites */
    const meia = bv / 2;
    let e = bi, d = bi;
    while (e > 0 && trabalho[e] > meia) e--;
    while (d < trabalho.length - 1 && trabalho[d] > meia) d++;
    const fwhm = Math.max(F[d] - F[e], larguraLim[0]);
    let s0 = Math.min(Math.max(fwhm / 2.355, sigmaMin), sigmaMax);

    const g = levenbergMarquardt(F, trabalho, (x, q) => gauss(x, q[0], q[1], q[2]),
      [bv, F[bi], s0],
      { lower: [0, F[0], sigmaMin], upper: [Infinity, F[F.length - 1], sigmaMax], maxIter: 80 });
    const [a, c, s] = g.params;
    if (!(a > 0) || !isFinite(c) || !(s > 0)) break;
    candidatos.push([a, c, s]);
    for (let i = 0; i < trabalho.length; i++) trabalho[i] -= gauss(F[i], a, c, s);
  }

  /* --- filtragem: altura mínima e largura dentro dos limites -------------- */
  let picos = candidatos.filter(([a, c, s]) => a >= minAlt && 2 * s >= larguraLim[0] && 2 * s <= larguraLim[1]);
  const descartados = candidatos.length - picos.length;

  /* --- reajuste simultâneo de todas as gaussianas ------------------------- */
  if (picos.length) {
    const flat = F.map((x, i) => LP[i] - ap.fn(x, ap.params));
    const plano = picos.flat();
    const modelo = (x, q) => {
      let v = 0;
      for (let k = 0; k < q.length; k += 3) v += gauss(x, q[k], q[k + 1], q[k + 2]);
      return v;
    };
    const lower = [], upper = [];
    picos.forEach(([, c]) => {
      lower.push(0, Math.max(F[0], c - 3), sigmaMin);
      upper.push(Infinity, Math.min(F[F.length - 1], c + 3), sigmaMax);
    });
    const r = levenbergMarquardt(F, flat, modelo, plano, { lower, upper, maxIter: 150 });
    picos = [];
    for (let k = 0; k < r.params.length; k += 3) picos.push([r.params[k], r.params[k + 1], r.params[k + 2]]);
    picos = picos.filter(([a, c, s]) => a >= minAlt && s > 0);
  }

  /* --- reajuste do aperiódico sobre o espectro SEM os picos --------------- */
  const semPicos = F.map((x, i) => {
    let v = LP[i];
    picos.forEach(([a, c, s]) => { v -= gauss(x, a, c, s); });
    return v;
  });
  ap = ajustaAperiodico(F, semPicos, modo, ap.params.slice());

  /* --- modelo completo, R² e erro ---------------------------------------- */
  const aperiodic = F.map(x => ap.fn(x, ap.params));
  const periodic = F.map(x => { let v = 0; picos.forEach(([a, c, s]) => { v += gauss(x, a, c, s); }); return v; });
  const modeloLog = F.map((x, i) => aperiodic[i] + periodic[i]);
  const resid = F.map((x, i) => LP[i] - modeloLog[i]);
  const mLP = mean(LP);
  const sst = LP.reduce((acc, v) => acc + (v - mLP) * (v - mLP), 0);
  const sse = resid.reduce((acc, v) => acc + v * v, 0);
  const r2 = sst > 0 ? 1 - sse / sst : NaN;
  const mae = mean(resid.map(Math.abs));

  const saida = {
    fmin, fmax, aperiodicMode: modo,
    offset: +ap.params[0].toFixed(5),
    knee: modo === 'knee' ? +ap.params[1].toFixed(5) : null,
    exponent: +(modo === 'knee' ? ap.params[2] : ap.params[1]).toFixed(5),
    kneeFrequencyHz: modo === 'knee' && ap.params[1] > 0
      ? +Math.pow(ap.params[1], 1 / Math.max(0.05, ap.params[2])).toFixed(3) : null,
    r2: +r2.toFixed(5), error: +mae.toFixed(5),
    nPeaks: picos.length, nPeaksDiscarded: descartados,
    peaks: picos
      .map(([a, c, s]) => ({
        cf: +c.toFixed(3), pw: +a.toFixed(4), bw: +(2 * s).toFixed(3),
        sigma: +s.toFixed(4)
      }))
      .sort((x, y) => x.cf - y.cf),
    params: { maxNPeaks: maxN, minPeakHeight: minAlt, peakThreshold: limiarSD, peakWidthLimits: larguraLim },
    f: F, logPower: LP, aperiodicLog: aperiodic, periodicLog: periodic, modelLog: modeloLog,
    /* em unidade linear, para sobrepor ao espectro */
    aperiodicLinear: aperiodic.map(v => Math.pow(10, v)),
    modelLinear: modeloLog.map(v => Math.pow(10, v)),
    quality: r2 >= 0.9 && mae <= 0.1 ? 'bom'
      : r2 >= 0.8 ? 'aceitável' : 'ruim',
    warning: r2 < 0.8
      ? `R² = ${r2.toFixed(2)} — o modelo não descreve este espectro; não reporte o expoente sem inspecionar a figura`
      : null
  };
  return saida;
}

/* Ajusta os DOIS modos e devolve a comparação — a escolha entre reta e joelho
   passa a ser justificada por número, não por hábito. O critério é o AIC com
   o número de parâmetros de cada modelo. */
export function specparamCompare(f, p, opts) {
  opts = opts || {};
  const fixo = specparam(f, p, Object.assign({}, opts, { aperiodicMode: 'fixed' }));
  const joelho = specparam(f, p, Object.assign({}, opts, { aperiodicMode: 'knee' }));
  if (!fixo && !joelho) return null;
  const aic = m => {
    if (!m) return Infinity;
    const n = m.f.length;
    const k = (m.aperiodicMode === 'knee' ? 3 : 2) + 3 * m.nPeaks;
    const sse = m.f.reduce((a, x, i) => { const r = m.logPower[i] - m.modelLog[i]; return a + r * r; }, 0);
    return n * Math.log(sse / n) + 2 * k;
  };
  const aFixo = aic(fixo), aJoelho = aic(joelho);
  const melhor = aJoelho + 2 < aFixo ? 'knee' : 'fixed';
  return {
    fixed: fixo, knee: joelho,
    aicFixed: isFinite(aFixo) ? +aFixo.toFixed(2) : null,
    aicKnee: isFinite(aJoelho) ? +aJoelho.toFixed(2) : null,
    best: melhor,
    deltaAic: isFinite(aFixo) && isFinite(aJoelho) ? +(aFixo - aJoelho).toFixed(2) : null,
    note: melhor === 'knee'
      ? 'o modelo com joelho descreve melhor este espectro (ΔAIC > 2) — há achatamento em baixas frequências'
      : 'a reta em log-log basta; incluir joelho não melhora o ajuste o suficiente para justificar o parâmetro extra'
  };
}
