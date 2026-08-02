/* artifact/ecg.js — remoção de artefato cardíaco por três métodos comparáveis.

   Referências: Stam et al., Clin Neurophysiol 2023;146:147-161 (comparação
   formal dos três métodos em 9 pacientes com DP); Vivien et al., npj Parkinsons
   Dis 2026 (SVD recomendado, com mais de um componente quando a contaminação é
   alta); Hammer et al., Stereotact Funct Neurosurg 2022;100:168-183.
   Implementações de referência (conceituais): perceive (perceive_ecg.m,
   interpolação de QRS); DBSsync/functions/ecg_cleaning.py (clean_ecg_*).

   Nenhuma limpeza é aplicada sem reportar quanto removeu e se preservou o
   sinal: ver artifact/validate.js — as métricas de validação são saída
   obrigatória (contrato em CLAUDE.md).

   Unidades: x em µV, fs em Hz, janelas em segundos.                          */

import { bandpassFFT, hilbertEnvelope } from '../dsp/filters.js';
import { mean, median, quantile } from '../stats/descriptive.js';
import { detectRPeaks } from './rpeaks.js';
import { svdJacobi, lowRankApprox } from './svd.js';

/* Épocas válidas ao redor dos picos, como matriz (épocas × amostras). */
function buildEpochs(x, peaks, half) {
  const idx = [], linhas = [];
  for (const p of peaks) {
    if (p - half < 0 || p + half >= x.length) continue;
    const lin = new Float64Array(2 * half + 1);
    let ok = true;
    for (let k = -half; k <= half; k++) {
      const v = x[p + k];
      if (!isFinite(v)) { ok = false; break; }
      lin[k + half] = v;
    }
    if (!ok) continue;                       // época sobre lacuna não é usada
    idx.push(p); linhas.push(lin);
  }
  return { peaks: idx, epochs: linhas };
}

/* Ajuste de amplitude por mínimos quadrados: a = ⟨x, t⟩ / ⟨t, t⟩ */
function fitScale(alvo, base) {
  let num = 0, den = 0;
  for (let k = 0; k < base.length; k++) { num += alvo[k] * base[k]; den += base[k] * base[k]; }
  return den > 1e-300 ? num / den : 0;
}

/* Interpolação cúbica de Hermite entre as bordas da janela contaminada. */
function cubicSpan(out, i0, i1) {
  const n = i1 - i0;
  if (n <= 0) return;
  const p0 = out[i0 - 1], p1 = out[i1];
  if (!isFinite(p0) || !isFinite(p1)) return;
  const m0 = isFinite(out[i0 - 2]) ? p0 - out[i0 - 2] : 0;
  const m1 = isFinite(out[i1 + 1]) ? out[i1 + 1] - p1 : 0;
  for (let k = 0; k < n; k++) {
    const t = (k + 1) / (n + 1), t2 = t * t, t3 = t2 * t;
    out[i0 + k] = (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 +
                  (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1;
  }
}

/* removeEcg(x, fs, peaks, {method, svdComponents, window})
   method ∈ 'interpolation' | 'template' | 'svd'                              */
export function removeEcg(x, fs, peaks, opts) {
  opts = opts || {};
  const method = opts.method || 'svd';
  /* Janela default de ±0,06 s (≈ largura do QRS), e não os ±0,2 s citados na
     referência. Medimos as duas em sinal sintético com HRV e SNR de −10 a
     +10 dB (ver tests/run.mjs): a janela larga piora a preservação do pico beta
     em todos os três métodos — no SVD a recuperação cai de 0,86 para 0,56 —
     porque a época passa a conter sinal cerebral além do artefato. A
     interpolação, que SUBSTITUI o trecho em vez de subtrair, é ainda mais
     sensível: a ±0,2 s ela apagaria 40% de um registro a 60 bpm.            */
  const winS = isFinite(opts.window) ? opts.window : 0.06;
  const half = Math.max(2, Math.round(winS * fs));
  /* k = 2 por default: Vivien et al. recomendam mais de um componente quando a
     contaminação é alta, e é o que rende melhor correlação com o ground truth
     na nossa varredura de SNR (0,97 contra 0,83 com k = 1).                 */
  const k = Math.max(1, Math.min(5, opts.svdComponents || 2));
  const out = Float64Array.from(x);
  const params = { method, windowS: winS, svdComponents: method === 'svd' ? k : null };

  if (!peaks || peaks.length < 3)
    return { cleaned: out, applied: false, nBeats: peaks ? peaks.length : 0, params,
      reason: 'picos R insuficientes para remover o artefato' };

  if (method === 'interpolation') {
    /* perceive: interpola o segmento contaminado */
    for (const p of peaks) {
      const i0 = Math.max(1, p - half), i1 = Math.min(out.length - 1, p + half);
      cubicSpan(out, i0, i1);
    }
    return { cleaned: out, applied: true, nBeats: peaks.length, params };
  }

  const { peaks: usados, epochs } = buildEpochs(x, peaks, half);
  if (epochs.length < 3)
    return { cleaned: out, applied: false, nBeats: usados.length, params,
      reason: 'épocas válidas insuficientes (lacunas ou bordas)' };

  if (method === 'template') {
    /* Hammer et al. / DBSsync: template médio ajustado em amplitude por
       mínimos quadrados a CADA artefato individualmente e subtraído */
    const L = 2 * half + 1;
    const tpl = new Float64Array(L);
    epochs.forEach(e => { for (let k2 = 0; k2 < L; k2++) tpl[k2] += e[k2]; });
    for (let k2 = 0; k2 < L; k2++) tpl[k2] /= epochs.length;
    const m = mean(Array.from(tpl));
    for (let k2 = 0; k2 < L; k2++) tpl[k2] -= m;
    usados.forEach((p, i) => {
      const a = fitScale(epochs[i], tpl);
      for (let k2 = -half; k2 <= half; k2++) out[p + k2] -= a * tpl[k2 + half];
    });
    return { cleaned: out, applied: true, nBeats: usados.length, template: tpl, params };
  }

  /* método SVD (recomendado): empilha as épocas, decompõe, reconstrói o
     artefato com os k primeiros componentes e subtrai ajustado em cada pico */
  const svd = svdJacobi(epochs);
  if (!svd) return { cleaned: out, applied: false, nBeats: usados.length, params, reason: 'SVD não convergiu' };
  const artefato = lowRankApprox(svd, k);
  usados.forEach((p, i) => {
    const base = artefato[i];
    const a = fitScale(epochs[i], base);
    for (let k2 = -half; k2 <= half; k2++) out[p + k2] -= a * base[k2 + half];
  });
  const total = Array.from(svd.S).reduce((s, v) => s + v * v, 0) || 1;
  let expl = 0; for (let i = 0; i < k && i < svd.S.length; i++) expl += svd.S[i] * svd.S[i];
  return {
    cleaned: out, applied: true, nBeats: usados.length, params,
    singularValues: Array.from(svd.S), varianceExplained: 100 * expl / total,
    template: artefato[0]
  };
}

/* Pipeline completo: detectar → remover → (o chamador valida).
   Mantido separado de removeEcg para permitir comparar os três métodos sobre
   exatamente o mesmo conjunto de picos.                                      */
export function cleanEcg(x, fs, opts) {
  opts = opts || {};
  const det = detectRPeaks(x, fs, opts);
  const rem = removeEcg(x, fs, det.peaks, opts);
  return Object.assign({ detection: det }, rem);
}

/* --------------------------------------------------------------------------
   Compatibilidade: assinatura e forma de retorno originais preservadas, agora
   servidas pela detecção em duas passagens e pela subtração de template com
   ajuste de amplitude. Código existente (F6, métricas agudas) segue funcionando.
   -------------------------------------------------------------------------- */
export function ecgTemplateSubtract(x, fs) {
  const det = detectRPeaks(x, fs, {});
  if (det.peaks.length < 8) {
    /* caminho legado: envelope 5–30 Hz com limiar de percentil 98 */
    const bp = bandpassFFT(x, fs, 5, 30);
    const env = hilbertEnvelope(bp);
    const thr = quantile(Array.from(env), 0.98);
    const refractory = Math.round(0.4 * fs);
    const peaks = [];
    for (let i = 1; i < env.length - 1; i++) {
      if (env[i] > thr && env[i] >= env[i - 1] && env[i] > env[i + 1]) {
        if (!peaks.length || i - peaks[peaks.length - 1] > refractory) peaks.push(i);
      }
    }
    const half = Math.round(0.25 * fs);
    const usable = peaks.filter(p => p - half >= 0 && p + half < x.length);
    if (usable.length < 8)
      return { cleaned: Float64Array.from(x), nBeats: usable.length, bpm: NaN, applied: false, detection: det };
    const tpl = new Float64Array(2 * half + 1);
    usable.forEach(p => { for (let k = -half; k <= half; k++) tpl[k + half] += x[p + k]; });
    for (let k = 0; k < tpl.length; k++) tpl[k] /= usable.length;
    const m = mean(Array.from(tpl)); for (let k = 0; k < tpl.length; k++) tpl[k] -= m;
    const out = Float64Array.from(x);
    usable.forEach(p => { for (let k = -half; k <= half; k++) out[p + k] -= tpl[k + half]; });
    const rr = []; for (let i = 1; i < usable.length; i++) rr.push((usable[i] - usable[i - 1]) / fs);
    return { cleaned: out, nBeats: usable.length, bpm: 60 / (median(rr) || NaN), template: tpl, peaks: usable, applied: true, detection: det };
  }
  const rem = removeEcg(x, fs, det.peaks, { method: 'template', window: 0.25 });
  return {
    cleaned: rem.cleaned, nBeats: rem.nBeats, bpm: det.bpm, template: rem.template,
    peaks: det.peaks, applied: rem.applied, detection: det
  };
}
