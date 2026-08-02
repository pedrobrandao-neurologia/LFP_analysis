/* artifact/ramp.js — artefato de rampa de estimulação e transientes polifásicos.

   Referência: Hammer et al., Stereotact Funct Neurosurg 2022;100:168-183 — três
   fontes de artefato removíveis por subtração de template: ECG (ver ecg.js),
   artefatos polifásicos não fisiológicos, e artefatos de RAMPA ao alterar a
   amplitude de estimulação.

   Detalhe de implementação do DBSsync, adotado aqui: no LFP intracraniano a
   4ª AMOSTRA após a mudança abrupta de amplitude é a que fornece melhor
   alinhamento (validado contra artefatos cardíacos endógenos).

   Default seguro: MASCARAR as janelas como NaN. Subtrair template é opção do
   usuário — mascarar nunca inventa sinal, subtrair pode errar.               */

import { mean } from '../stats/descriptive.js';
import { mad, median } from '../stats/descriptive.js';

const OFFSET_ALINHAMENTO = 4;      // 4ª amostra após o degrau (DBSsync)

/* detectRampArtifacts(lfp, fs, {maSeries, maFs, minStepMa})
   Identifica os instantes de mudança de amplitude — na série de mA quando ela
   existe, senão por detecção de degrau na própria série de potência.
   → { steps: [{idx, fromMa, toMa, deltaMa}], windows: [{start, end}], source } */
export function detectRampArtifacts(lfp, fs, opts) {
  opts = opts || {};
  const minStep = isFinite(opts.minStepMa) ? opts.minStepMa : 0.05;
  const janelaS = isFinite(opts.windowS) ? opts.windowS : 0.5;
  const steps = [];
  let fonte = 'nenhuma';

  if (opts.maSeries && opts.maSeries.length > 1) {
    fonte = 'série de amplitude (BrainSenseLfp)';
    const maFs = opts.maFs || 2;
    const escala = fs / maFs;               // converte índice de mA para índice de LFP
    for (let i = 1; i < opts.maSeries.length; i++) {
      const de = opts.maSeries[i - 1], para = opts.maSeries[i];
      if (isFinite(de) && isFinite(para) && Math.abs(para - de) >= minStep)
        steps.push({
          idx: Math.round(i * escala) + OFFSET_ALINHAMENTO,
          fromMa: +de.toFixed(3), toMa: +para.toFixed(3), deltaMa: +(para - de).toFixed(3)
        });
    }
  } else if (lfp && lfp.length > 8) {
    /* sem série de mA: degrau na potência — diferença robusta sobre janelas de 0,5 s */
    fonte = 'degrau detectado na série de potência';
    const w = Math.max(4, Math.round(0.5 * fs));
    const medias = [];
    for (let s = 0; s + w <= lfp.length; s += w) {
      const seg = [];
      for (let i = s; i < s + w; i++) if (isFinite(lfp[i])) seg.push(lfp[i]);
      medias.push({ idx: s, v: seg.length ? mean(seg) : NaN });
    }
    const difs = [];
    for (let i = 1; i < medias.length; i++) difs.push(Math.abs(medias[i].v - medias[i - 1].v));
    const escalaRobusta = mad(difs.filter(isFinite)) || 1e-9;
    const limiar = 5 * escalaRobusta;
    for (let i = 1; i < medias.length; i++) {
      if (isFinite(medias[i].v) && isFinite(medias[i - 1].v) && Math.abs(medias[i].v - medias[i - 1].v) > limiar)
        steps.push({ idx: medias[i].idx + OFFSET_ALINHAMENTO, fromMa: NaN, toMa: NaN, deltaMa: NaN });
    }
  }

  const half = Math.max(2, Math.round(janelaS * fs));
  const windows = steps.map(s => ({
    start: Math.max(0, s.idx - half), end: Math.min((lfp ? lfp.length : 0), s.idx + half)
  }));
  return {
    steps, windows, source: fonte,
    alignmentOffsetSamples: OFFSET_ALINHAMENTO,
    nSteps: steps.length,
    pctAffected: lfp && lfp.length ? 100 * windows.reduce((a, w) => a + (w.end - w.start), 0) / lfp.length : 0
  };
}

/* removeRampArtifact(x, fs, ramp, {mode})
   mode: 'mask' (default, seguro) → NaN nas janelas
         'template' → subtração do template médio dos transientes alinhados    */
export function removeRampArtifact(x, fs, ramp, opts) {
  opts = opts || {};
  const modo = opts.mode || 'mask';
  const out = Float64Array.from(x);
  if (!ramp || !ramp.windows.length)
    return { cleaned: out, applied: false, mode: modo, nSteps: 0, reason: 'nenhuma mudança de amplitude detectada' };

  if (modo === 'mask') {
    ramp.windows.forEach(w => { for (let i = w.start; i < w.end; i++) out[i] = NaN; });
    return {
      cleaned: out, applied: true, mode: 'mask', nSteps: ramp.nSteps,
      pctMasked: +ramp.pctAffected.toFixed(2),
      note: 'janelas mascaradas como NaN — a lacuna é propagada com contabilidade, nunca preenchida'
    };
  }

  /* template médio dos transientes, alinhado pela 4ª amostra após o degrau */
  const L = ramp.windows[0].end - ramp.windows[0].start;
  const validas = ramp.windows.filter(w => (w.end - w.start) === L &&
    Array.from({ length: L }, (_, k) => x[w.start + k]).every(isFinite));
  if (validas.length < 3)
    return { cleaned: out, applied: false, mode: 'template', nSteps: ramp.nSteps, reason: 'transientes válidos insuficientes para formar template' };
  const tpl = new Float64Array(L);
  validas.forEach(w => { for (let k = 0; k < L; k++) tpl[k] += x[w.start + k]; });
  for (let k = 0; k < L; k++) tpl[k] /= validas.length;
  const m = mean(Array.from(tpl));
  for (let k = 0; k < L; k++) tpl[k] -= m;
  validas.forEach(w => { for (let k = 0; k < L; k++) out[w.start + k] -= tpl[k]; });
  return { cleaned: out, applied: true, mode: 'template', nSteps: ramp.nSteps, nUsed: validas.length, template: tpl };
}

/* detectPolyphasic(x, fs, {k, maxDurationMs})
   Transientes de alta amplitude e forma não fisiológica: amplitude acima de
   k·MAD (default 6) com duração abaixo de 50 ms e cruzamentos de zero acima do
   esperado para a banda. Marca como época excluída — NUNCA corrige em silêncio. */
export function detectPolyphasic(x, fs, opts) {
  opts = opts || {};
  const k = isFinite(opts.k) ? opts.k : 6;
  const maxDurMs = isFinite(opts.maxDurationMs) ? opts.maxDurationMs : 50;
  const validos = [];
  for (let i = 0; i < x.length; i++) if (isFinite(x[i])) validos.push(x[i]);
  if (validos.length < 16) return { events: [], nEvents: 0, pctAffected: 0, threshold: NaN };
  const med = median(validos), escala = mad(validos) || 1e-9;
  const limiar = k * escala;
  const maxN = Math.round(maxDurMs * fs / 1000);

  /* Regiões acima do limiar, FUNDIDAS quando separadas por menos de 5 ms: um
     transiente polifásico oscila através da mediana, então ele aparece como
     vários trechos curtos — avaliá-los isoladamente perderia justamente a
     forma polifásica que se quer detectar. */
  const brutos = [];
  for (let j = 0; j < x.length; j++) {
    if (!isFinite(x[j]) || Math.abs(x[j] - med) <= limiar) continue;
    const ult = brutos[brutos.length - 1];
    if (ult && j - ult.end <= Math.max(1, Math.round(0.005 * fs))) ult.end = j + 1;
    else brutos.push({ start: j, end: j + 1 });
  }

  const eventos = [];
  let bi = 0;
  while (bi < brutos.length) {
    { const reg = brutos[bi++]; const s = reg.start; const i = reg.end;
      const n = i - s;
      if (n <= maxN) {
        /* cruzamentos de zero dentro do transiente: forma polifásica */
        let cruz = 0;
        for (let j = s + 1; j < i; j++)
          if (isFinite(x[j]) && isFinite(x[j - 1]) && (x[j] - med) * (x[j - 1] - med) < 0) cruz++;
        const durMs = n * 1000 / fs;
        /* "polifásico" quer dizer literalmente mais de duas fases: três ou mais
           inversões dentro de um transiente curto e de alta amplitude. Uma
           oscilação fisiológica dessa duração não inverte tantas vezes. */
        if (cruz >= 3) eventos.push({
          start: s, end: i, startS: +(s / fs).toFixed(4), durationMs: +durMs.toFixed(1),
          zeroCrossings: cruz, peak: +Math.max(...Array.from(x.slice(s, i)).map(v => Math.abs(v - med))).toFixed(3)
        });
      }
    }
  }
  const nAfetadas = eventos.reduce((a, e) => a + (e.end - e.start), 0);
  return {
    events: eventos, nEvents: eventos.length, threshold: +limiar.toFixed(4),
    k, maxDurationMs: maxDurMs,
    pctAffected: x.length ? +(100 * nAfetadas / x.length).toFixed(3) : 0,
    note: 'épocas marcadas para exclusão; o sinal NÃO é corrigido silenciosamente'
  };
}
