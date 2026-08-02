/* adbs/doseresponse.js — predição de parâmetros ótimos por ajuste dose-resposta.

   Até aqui a dose-resposta era regressão LINEAR, o que não descreve supressão
   que satura. Referência de implementação: BRAVO `extractPredictionModel`, que
   ajusta DOIS modelos e escolhe o de menor erro:
     • decaimento de potência:  y = L·exp(−k(x − x0)) + L0
     • sigmoide inversa:        y = L / (1 + exp(k(x − x0))) + L0

   Heurística de artefato, também do BRAVO: se a curva ajustada for CRESCENTE com
   a amplitude, a "resposta" é provavelmente artefato de estimulação, não
   supressão beta — e isso é sinalizado, não escondido.

   Unidades: x em mA, y em potência de LFP (u.a.).                            */

import { quantile, median } from '../stats/descriptive.js';
import { levenbergMarquardt } from '../stats/optimize.js';

/* Os dois modelos do BRAVO. */
export const MODELOS = {
  decay: {
    label: 'decaimento de potência',
    fn: (x, p) => p[0] * Math.exp(-p[1] * (x - p[2])) + p[3],
    formula: 'y = L·exp(−k(x − x₀)) + L₀'
  },
  inverseSigmoid: {
    label: 'sigmoide inversa',
    fn: (x, p) => p[0] / (1 + Math.exp(p[1] * (x - p[2]))) + p[3],
    formula: 'y = L / (1 + exp(k(x − x₀))) + L₀'
  }
};

/* fitDoseResponse(ma, power, opts) → melhor modelo, com IC por bootstrap. */
export function fitDoseResponse(ma, power, opts) {
  opts = opts || {};
  const pares = [];
  for (let i = 0; i < Math.min(ma.length, power.length); i++)
    if (isFinite(ma[i]) && isFinite(power[i])) pares.push([ma[i], power[i]]);
  if (pares.length < 4) return null;
  pares.sort((a, b) => a[0] - b[0]);
  const x = pares.map(p => p[0]), y = pares.map(p => p[1]);

  const yMax = Math.max(...y), yMin = Math.min(...y);
  const xMed = median(x);
  const chutes = {
    decay: [Math.max(1e-6, yMax - yMin), 1 / Math.max(0.1, (Math.max(...x) - Math.min(...x)) || 1), Math.min(...x), yMin],
    inverseSigmoid: [Math.max(1e-6, yMax - yMin), 2 / Math.max(0.1, (Math.max(...x) - Math.min(...x)) || 1), xMed, yMin]
  };

  const ajustes = {};
  Object.keys(MODELOS).forEach(k => {
    const r = levenbergMarquardt(x, y, MODELOS[k].fn, chutes[k]);
    ajustes[k] = Object.assign({ model: k, label: MODELOS[k].label, formula: MODELOS[k].formula }, r);
  });
  const melhorNome = Object.keys(ajustes).reduce((a, b) => ajustes[a].mse <= ajustes[b].mse ? a : b);
  const melhor = ajustes[melhorNome];
  const fn = MODELOS[melhorNome].fn;

  /* a curva ajustada é crescente com a amplitude? então é artefato provável */
  const xIni = Math.min(...x), xFim = Math.max(...x);
  const yIni = fn(xIni, melhor.params), yFim = fn(xFim, melhor.params);
  const artefato = yFim > yIni * 1.05;

  /* ponto de meia-supressão e supressão máxima */
  const supressaoMax = 100 * (yIni - yFim) / (yIni || 1);
  let meia = NaN;
  const alvo = (yIni + yFim) / 2;
  for (let s = 0; s <= 200; s++) {
    const xv = xIni + (xFim - xIni) * s / 200;
    if ((yIni > yFim && fn(xv, melhor.params) <= alvo) || (yIni < yFim && fn(xv, melhor.params) >= alvo)) { meia = xv; break; }
  }

  /* IC dos parâmetros por bootstrap determinístico de resíduos */
  let semente = 987654321;
  const prox = () => { semente = (semente * 1103515245 + 12345) & 0x7fffffff; return semente / 0x7fffffff; };
  const resid = x.map((xv, i) => y[i] - fn(xv, melhor.params));
  const amostras = [];
  for (let b = 0; b < (opts.nBoot || 200); b++) {
    const yb = x.map((xv, i) => fn(xv, melhor.params) + resid[Math.floor(prox() * resid.length)]);
    const r = levenbergMarquardt(x, yb, fn, melhor.params.slice(), { maxIter: 60 });
    if (r.converged || isFinite(r.mse)) amostras.push(r.params);
  }
  const ic = j => {
    const v = amostras.map(p => p[j]).filter(isFinite).sort((a, b) => a - b);
    return v.length ? [quantile(v, 0.025), quantile(v, 0.975)] : [NaN, NaN];
  };

  return {
    best: melhorNome, label: melhor.label, formula: melhor.formula,
    params: melhor.params.map(v => +v.toFixed(5)),
    paramNames: ['L', 'k', 'x0', 'L0'],
    paramCI: melhor.params.map((_, j) => ic(j).map(v => +v.toFixed(4))),
    r2: +melhor.r2.toFixed(4), mse: +melhor.mse.toFixed(6),
    fits: Object.keys(ajustes).map(k => ({ model: k, label: ajustes[k].label, mse: +ajustes[k].mse.toFixed(6), r2: +ajustes[k].r2.toFixed(4) })),
    halfSuppressionMa: isFinite(meia) ? +meia.toFixed(3) : NaN,
    maxSuppressionPct: +supressaoMax.toFixed(1),
    nLevels: pares.length,
    predict: xv => fn(xv, melhor.params),
    stimulationArtifactSuspected: artefato,
    reason: artefato
      ? 'a curva ajustada CRESCE com a amplitude — a "resposta" é provavelmente artefato de estimulação, não supressão beta (heurística do BRAVO)'
      : null
  };
}
