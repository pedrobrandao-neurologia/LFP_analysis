/* artifact/validate.js — métricas de validação da limpeza de ECG.

   SAÍDA OBRIGATÓRIA. Nenhuma limpeza pode ser aplicada sem reportar quanto
   removeu e se preservou o sinal — hoje era exatamente o que faltava: o app
   removia ECG sem informar nem uma coisa nem outra.

   Métricas exatamente como em Vivien et al., npj Parkinsons Dis 2026:
     • razão de supressão de ECG = 10·log10(P_bruto / P_limpo), com P = potência
       média em 0,5–40 Hz. Valores altos = mais supressão.
     • recuperação do pico beta = proeminência_limpo / proeminência_bruto, com
       proeminência calculada em janela de ±5 Hz ao redor da frequência de pico.
       Valor próximo de 1 indica preservação ótima, sem amplificação espúria.
     • preservação de potência beta/teta (BPP/TPP) contra referência não
       contaminada, quando houver.

   Unidades: sinais em µV, fs em Hz, razão de supressão em dB, demais em razão
   adimensional.                                                              */

import { welchPSD, bandPower } from '../dsp/spectral.js';
import { mean } from '../stats/descriptive.js';

const psdDe = (x, fs) => welchPSD(x, fs, { nperseg: Math.min(1024, 2 ** Math.floor(Math.log2(x.length))), overlap: .5 });

/* Potência média numa faixa (ignora bins não finitos). */
function meanPower(psd, lo, hi) {
  if (!psd || !psd.p) return NaN;
  const v = [];
  for (let i = 0; i < psd.f.length; i++)
    if (psd.f[i] >= lo && psd.f[i] <= hi && isFinite(psd.p[i])) v.push(psd.p[i]);
  return v.length ? mean(v) : NaN;
}

/* Razão de supressão de ECG, em dB, na banda 0,5–40 Hz. */
export function ecgSuppressionRatio(raw, clean, fs) {
  const pr = meanPower(psdDe(raw, fs), 0.5, 40);
  const pc = meanPower(psdDe(clean, fs), 0.5, 40);
  if (!isFinite(pr) || !isFinite(pc) || pc <= 0) return NaN;
  return 10 * Math.log10(pr / pc);
}

/* Proeminência do pico: valor no pico menos a linha de base das bordas da
   janela de ±halfBw Hz ao redor dele. */
function prominence(psd, peakHz, halfBw) {
  if (!psd || !psd.p) return NaN;
  let pico = -Infinity, borda = [];
  for (let i = 0; i < psd.f.length; i++) {
    const d = psd.f[i] - peakHz;
    if (!isFinite(psd.p[i])) continue;
    if (Math.abs(d) <= 1) pico = Math.max(pico, psd.p[i]);
    else if (Math.abs(d) >= halfBw - 1 && Math.abs(d) <= halfBw) borda.push(psd.p[i]);
  }
  if (!isFinite(pico) || !borda.length) return NaN;
  return pico - mean(borda);
}

/* Recuperação do pico beta: proeminência_limpo / proeminência_bruto. */
export function betaPeakRecovery(rawPsd, cleanPsd, peakHz, halfBw) {
  const bw = isFinite(halfBw) ? halfBw : 5;
  const pr = prominence(rawPsd, peakHz, bw), pc = prominence(cleanPsd, peakHz, bw);
  if (!isFinite(pr) || !isFinite(pc) || pr === 0) return NaN;
  return pc / pr;
}

/* Preservação de potência numa banda contra uma referência (BPP/TPP). */
export function bandPowerPreservation(cleanPsd, refPsd, lo, hi) {
  if (!cleanPsd || !cleanPsd.p || !refPsd || !refPsd.p) return NaN;
  const pc = bandPower(cleanPsd.f, cleanPsd.p, lo, hi);
  const pr = bandPower(refPsd.f, refPsd.p, lo, hi);
  if (!isFinite(pc) || !isFinite(pr) || pr === 0) return NaN;
  return pc / pr;
}

/* Correlação de Pearson entre dois sinais (para comparação com ground truth). */
export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  let sa = 0, sb = 0, k = 0;
  for (let i = 0; i < n; i++) if (isFinite(a[i]) && isFinite(b[i])) { sa += a[i]; sb += b[i]; k++; }
  if (k < 3) return NaN;
  const ma = sa / k, mb = sb / k;
  let num = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    if (!isFinite(a[i]) || !isFinite(b[i])) continue;
    const da = a[i] - ma, db = b[i] - mb;
    num += da * db; va += da * da; vb += db * db;
  }
  return (va > 0 && vb > 0) ? num / Math.sqrt(va * vb) : NaN;
}

/* validateEcgRemoval(raw, clean, fs, {peakHz, reference})
   → objeto `validation` anexado ao resultado da limpeza, exportado no CSV de
   métricas e exibido na UI.                                                   */
export function validateEcgRemoval(raw, clean, fs, opts) {
  opts = opts || {};
  const rawPsd = psdDe(raw, fs), cleanPsd = psdDe(clean, fs);
  /* frequência de pico: informada, ou o maior pico em 13–35 Hz do sinal limpo */
  let peakHz = opts.peakHz;
  if (!isFinite(peakHz) && cleanPsd.p) {
    let bv = -Infinity;
    for (let i = 0; i < cleanPsd.f.length; i++)
      if (cleanPsd.f[i] >= 13 && cleanPsd.f[i] <= 35 && cleanPsd.p[i] > bv) { bv = cleanPsd.p[i]; peakHz = cleanPsd.f[i]; }
  }
  const out = {
    suppressionRatioDb: ecgSuppressionRatio(raw, clean, fs),
    betaPeakRecovery: betaPeakRecovery(rawPsd, cleanPsd, peakHz),
    peakHz: isFinite(peakHz) ? peakHz : NaN,
    thetaPowerRatio: NaN, betaPowerRatio: NaN, correlationWithReference: NaN
  };
  if (opts.reference && opts.reference.length) {
    const refPsd = psdDe(opts.reference, fs);
    out.thetaPowerRatio = bandPowerPreservation(cleanPsd, refPsd, 4, 8);
    out.betaPowerRatio = bandPowerPreservation(cleanPsd, refPsd, 13, 30);
    out.correlationWithReference = correlation(clean, opts.reference);
  }
  /* leitura honesta do resultado */
  const pLimpo = meanPower(cleanPsd, 0.5, 40), pBruto = meanPower(rawPsd, 0.5, 40);
  const destruido = isFinite(pBruto) && pBruto > 0 && (!isFinite(pLimpo) || pLimpo < pBruto * 1e-6);
  out.verdict = destruido ? 'sinal destruído — a limpeza removeu também o sinal cerebral'
    : !isFinite(out.suppressionRatioDb) ? 'não avaliável'
    : (out.suppressionRatioDb > 0 && isFinite(out.betaPeakRecovery)
        && out.betaPeakRecovery >= 0.8 && out.betaPeakRecovery <= 1.2)
      ? 'supressão com preservação do pico'
      : (out.suppressionRatioDb <= 0 ? 'sem supressão detectável'
        : 'supressão com alteração do pico beta — inspecione antes de usar');
  return out;
}
