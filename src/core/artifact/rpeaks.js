/* artifact/rpeaks.js — detecção de picos R em duas passagens por correlação de
   template, com e sem canal de ECG externo.

   POR QUE ISTO EXISTE. A detecção anterior era de passagem única por limiar de
   percentil no envelope 5–30 Hz. O padrão do campo, formalizado por Stam et al.
   (Clin Neurophysiol 2023;146:147-161) e por Vivien et al. (npj Parkinsons Dis
   2026), é a detecção em DUAS PASSAGENS por correlação de template, com
   desempenho reportado de 97,2% de verdadeiros positivos, 0,4% de falsos
   positivos e 2,4% de picos perdidos.

   Implementação de referência (conceitual): DBSsync/functions/ecg_cleaning.py
   (find_r_peaks_in_lfp_channel, find_r_peaks_based_on_ext_ecg).

   Unidades: x em µV, fs em Hz, saídas de tempo em amostras (peaks) e em ms
   (rrIntervals, hrvSdnn).                                                    */

import { bandpassFFT } from '../dsp/filters.js';
import { quantile, mean, sd } from '../stats/descriptive.js';

/* Picos locais acima de `height`, respeitando distância mínima. */
function findPeaksAbove(x, from, to, height, minDist) {
  const peaks = [];
  for (let i = from + 1; i < to - 1; i++) {
    if (!isFinite(x[i])) continue;
    if (x[i] >= x[i - 1] && x[i] > x[i + 1] && x[i] >= height) {
      const ult = peaks[peaks.length - 1];
      if (ult == null || i - ult >= minDist) peaks.push(i);
      else if (x[i] > x[ult]) peaks[peaks.length - 1] = i;
    }
  }
  return peaks;
}

/* Passagem grosseira: janelas de 1 s, limiar em percentis decrescentes
   (estratégia de Stam/DBSsync: 80 → 70 → 60 → 50).

   Detalhe que importa: dentro de cada janela ficam apenas os DOIS candidatos de
   maior amplitude, não todos os que cruzam o limiar. Com beta forte, o percentil
   80 é ultrapassado por dezenas de máximos locais da própria oscilação, e o
   template acabaria sendo montado sobre posições erradas — o QRS é, por
   construção, o evento de maior amplitude da janela.                        */
function coarseDetect(x, fs) {
  const win = Math.max(8, Math.round(fs));
  const minDist = Math.max(1, Math.round(fs / 3));
  for (const pct of [80, 70, 60, 50]) {
    const peaks = [];
    for (let s = 0; s + win <= x.length; s += win) {
      const seg = [];
      for (let i = s; i < s + win; i++) if (isFinite(x[i])) seg.push(x[i]);
      if (seg.length < win * 0.5) continue;
      const h = quantile(seg, pct / 100);
      const cand = findPeaksAbove(x, s, s + win, h, minDist)
        .sort((a, b) => x[b] - x[a]).slice(0, 2);
      cand.forEach(i => peaks.push(i));
    }
    const limpos = [];
    peaks.sort((a, b) => a - b).forEach(p => {
      if (!limpos.length || p - limpos[limpos.length - 1] >= minDist) limpos.push(p);
    });
    if (limpos.length >= 3) return { peaks: limpos, percentile: pct };
  }
  return { peaks: [], percentile: null };
}

/* Template médio das épocas centradas nos picos. */
function buildTemplate(x, peaks, half) {
  const tpl = new Float64Array(2 * half + 1);
  let n = 0;
  for (const p of peaks) {
    if (p - half < 0 || p + half >= x.length) continue;
    let ok = true;
    for (let k = -half; k <= half; k++) if (!isFinite(x[p + k])) { ok = false; break; }
    if (!ok) continue;
    for (let k = -half; k <= half; k++) tpl[k + half] += x[p + k];
    n++;
  }
  if (!n) return null;
  for (let k = 0; k < tpl.length; k++) tpl[k] /= n;
  const m = mean(Array.from(tpl));
  for (let k = 0; k < tpl.length; k++) tpl[k] -= m;      // template de média zero
  return { template: tpl, nUsed: n };
}

/* Correlação cruzada normalizada do template com o sinal. */
function xcorr(x, tpl) {
  const L = tpl.length, half = (L - 1) / 2;
  const out = new Float64Array(x.length);
  let normT = 0; for (let k = 0; k < L; k++) normT += tpl[k] * tpl[k];
  normT = Math.sqrt(normT) || 1;
  for (let i = half; i < x.length - half; i++) {
    let dot = 0, normX = 0, ok = true;
    for (let k = 0; k < L; k++) {
      const v = x[i - half + k];
      if (!isFinite(v)) { ok = false; break; }
      dot += v * tpl[k]; normX += v * v;
    }
    out[i] = ok && normX > 0 ? dot / (Math.sqrt(normX) * normT) : 0;
  }
  return out;
}

/* detectRPeaks(x, fs, {threshold, externalEcg, externalFs})
   → { peaks, polarity, template, bpm, rrIntervals, hrvSdnn, nDetected,
       confidence, reason, method }                                          */
export function detectRPeaks(x, fs, opts) {
  opts = opts || {};
  const minDistR = Math.max(1, Math.round(0.5 * fs));   // 0,5 s entre picos R

  /* --- caminho com ECG externo (mais confiável; resolve o caso em que o pico
     R é pequeno demais no LFP) ------------------------------------------- */
  if (opts.externalEcg && opts.externalEcg.length) {
    const fsE = opts.externalFs || fs;
    const bp = bandpassFFT(opts.externalEcg, fsE, 0.5, 60);
    const vals = Array.from(bp).filter(isFinite);
    const h = quantile(vals, 0.95);
    const picosE = findPeaksAbove(bp, 0, bp.length, h, Math.max(1, Math.round(0.5 * fsE)));
    /* casar no LFP: máximo absoluto em janela de −80 a +80 ms ao redor de cada R */
    const jan = Math.round(0.08 * fs);
    const peaks = [];
    for (const pe of picosE) {
      const centro = Math.round(pe * fs / fsE);
      let melhor = -1, val = -Infinity;
      for (let i = Math.max(0, centro - jan); i <= Math.min(x.length - 1, centro + jan); i++) {
        if (isFinite(x[i]) && Math.abs(x[i]) > val) { val = Math.abs(x[i]); melhor = i; }
      }
      if (melhor >= 0 && (!peaks.length || melhor - peaks[peaks.length - 1] >= minDistR)) peaks.push(melhor);
    }
    const t = buildTemplate(x, peaks, Math.round(0.25 * fs));
    return finalize(x, fs, peaks, 1, t && t.template, 'ecg-externo');
  }

  /* --- 1–3. passagem grosseira nas duas polaridades --------------------- */
  const neg = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) neg[i] = -x[i];
  const cPos = coarseDetect(x, fs), cNeg = coarseDetect(neg, fs);
  const polarity = cNeg.peaks.length > cPos.peaks.length ? -1 : 1;
  const sinal = polarity === 1 ? x : neg;
  const grosso = polarity === 1 ? cPos : cNeg;
  if (grosso.peaks.length < 5)
    return finalize(x, fs, [], polarity, null, 'template-2-passagens',
      'picos R de amplitude pequena demais em relação ao sinal cerebral — recomenda-se canal de ECG externo');

  /* --- 4. primeiro template --------------------------------------------
     A referência usa épocas de −0,5 a +0,5 s. Aqui a meia-largura é limitada a
     40% do RR mediano: se o template abranger um intervalo RR inteiro (ritmos
     lentos, ou RR muito regular), ele passa a conter os batimentos vizinhos e a
     correlação ganha lóbulos laterais que geram picos espúrios a meio RR.   */
  const rrGrosso = [];
  for (let i = 1; i < grosso.peaks.length; i++) rrGrosso.push(grosso.peaks[i] - grosso.peaks[i - 1]);
  const rrMediano = rrGrosso.length ? quantile(rrGrosso, 0.5) : fs;
  const half = Math.max(4, Math.min(Math.round(0.5 * fs), Math.round(0.4 * rrMediano)));
  /* distância mínima entre picos R guiada pelo RR observado: o piso fisiológico
     de 0,5 s sozinho deixa passar dois picos por batimento quando o RR é maior */
  const minDist = Math.max(minDistR, Math.round(0.6 * rrMediano));
  const t1 = buildTemplate(sinal, grosso.peaks, half);
  if (!t1) return finalize(x, fs, [], polarity, null, 'template-2-passagens', 'não foi possível formar o template do QRS');

  /* --- 5. primeira passagem por correlação ------------------------------ */
  const cc1 = xcorr(sinal, t1.template);
  const lim1 = isFinite(opts.threshold) ? opts.threshold
    : quantile(Array.from(cc1).filter(isFinite), 0.95);
  const p1 = findPeaksAbove(cc1, 0, cc1.length, lim1, minDist);

  /* --- 6. refino do template e segunda passagem ------------------------- */
  const t2 = buildTemplate(sinal, p1, half) || t1;
  const cc2 = xcorr(sinal, t2.template);
  const lim2 = isFinite(opts.threshold) ? opts.threshold
    : quantile(Array.from(cc2).filter(isFinite), 0.95);
  let peaks = findPeaksAbove(cc2, 0, cc2.length, lim2, minDist);

  /* filtro de qualidade do casamento: candidatos cuja correlação fica muito
     abaixo da mediana dos aceitos são casamentos fracos (tipicamente nas bordas
     do registro, onde não há QRS) e viram falso positivo se mantidos */
  if (peaks.length >= 5) {
    const vals = peaks.map(p => cc2[p]).filter(isFinite);
    const medCc = quantile(vals, 0.5);
    if (isFinite(medCc) && medCc > 0) peaks = peaks.filter(p => cc2[p] >= 0.6 * medCc);
  }

  /* reposiciona no máximo local do sinal (a correlação pode deslocar 1–2 amostras) */
  const ajuste = Math.max(1, Math.round(0.02 * fs));
  peaks = peaks.map(p => {
    let melhor = p, val = -Infinity;
    for (let i = Math.max(0, p - ajuste); i <= Math.min(sinal.length - 1, p + ajuste); i++)
      if (isFinite(sinal[i]) && sinal[i] > val) { val = sinal[i]; melhor = i; }
    return melhor;
  });

  return finalize(x, fs, peaks, polarity, t2.template, 'template-2-passagens');
}

function finalize(x, fs, peaks, polarity, template, method, motivo) {
  const rr = [];
  for (let i = 1; i < peaks.length; i++) rr.push((peaks[i] - peaks[i - 1]) / fs * 1000);
  const rrMed = rr.length ? rr.slice().sort((a, b) => a - b)[Math.floor(rr.length / 2)] : NaN;
  const cv = rr.length > 2 ? sd(rr) / mean(rr) : NaN;

  /* confiança: n de batimentos, regularidade do RR e destaque do QRS sobre o
     sinal cerebral. Baixa confiança recomenda explicitamente ECG externo.   */
  let confidence = 'baixa', razao = motivo || null;
  const amostras = Array.from(x).filter(isFinite);
  const sdSinal = amostras.length ? sd(amostras) : NaN;
  const ampTpl = template ? Math.max(...template) - Math.min(...template) : NaN;
  const destaque = isFinite(ampTpl) && isFinite(sdSinal) && sdSinal > 0 ? ampTpl / sdSinal : NaN;
  if (peaks.length >= 10 && isFinite(cv) && cv < 0.25 && destaque > 0.5) confidence = 'alta';
  else if (peaks.length >= 5) confidence = 'média';
  if (confidence !== 'alta' && !razao) {
    /* dizer POR QUE a confiança não é alta é o que permite ao usuário decidir
       entre aceitar, inspecionar visualmente ou registrar ECG externo */
    const causas = [];
    if (peaks.length < 10) causas.push('poucos batimentos detectados');
    if (!(destaque > 0.5)) causas.push('pico R pouco destacado do sinal cerebral');
    if (isFinite(cv) && cv >= 0.25) causas.push('intervalos RR muito irregulares');
    razao = (causas.length ? causas.join('; ') : 'casamento de template pouco consistente') +
      ' — inspecione visualmente e considere registrar ECG externo na próxima sessão';
  }

  return {
    peaks, polarity, template, method,
    nDetected: peaks.length,
    rrIntervals: rr,
    bpm: isFinite(rrMed) && rrMed > 0 ? 60000 / rrMed : NaN,
    hrvSdnn: rr.length > 2 ? sd(rr) : NaN,
    rrCv: cv, qrsProminence: destaque,
    confidence, reason: razao
  };
}
