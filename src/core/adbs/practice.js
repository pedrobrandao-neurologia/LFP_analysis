/* adbs/practice.js — armadilhas do duplo limiar e vigilância pós-configuração

   O que a prática real de aDBS ensinou e a simulação básica não mostra,
   catalogado do ADAPT-START (Cascino et al., npj Parkinsons Dis 2026;12:85,
   doi:10.1038/s41531-026-01269-z) e das recomendações de mitigação de
   van Rheede 2022 (doi:10.1038/s41531-022-00350-7):

   1. A ARMADILHA DO CONGELAMENTO. No modo de duplo limiar, sinal ENTRE os
      limiares mantém a última amplitude. Se o paciente atingiu o teto por
      beta alto e o sinal recua para a faixa intermediária sem cruzar o limiar
      inferior, a estimulação FICA NO MÁXIMO. Cascino observou pacientes cuja
      amplitude alternava entre os dois limites poucas vezes por dia —
      funcionalmente uma cDBS de dois níveis, não uma aDBS.

   2. A META DE ≥0,7 mA. Janela de amplitude (iMax − iMin) menor que ~0,7 mA
      dá ao controlador pouco espaço para trabalhar (meta empírica do
      ADAPT-START; teto de 1,5 mA naquele estudo).

   3. A DERIVA DE DISTRIBUIÇÃO. Limiar fixado numa janela de dias vale para a
      distribuição daquela janela. Se artefato ou progressão empurrar a
      distribuição, a estimulação encosta cronicamente num dos limites —
      reproduzindo a cDBS e anulando o benefício. van Rheede recomenda
      inspeção REGULAR da distribuição como vigilância; Cascino acrescenta que
      ajustar limiares pelas médias de 10 min mostrou-se pouco confiável, e a
      própria variação da amplitude ao longo do tempo é o melhor indicador.

   4. O CUSTO DE BATERIA DO STREAMING (Percept PC): ~1 dia de longevidade
      perdido por hora de streaming; streaming contínuo máximo ~4 h
      (Saengphatrachai & Jimenez-Shahed, Neurodegener Dis Manag 2024;14:
      131–147, doi:10.1080/17582024.2024.2404386).

   Estas funções ficam FORA do namespace TIDAL de propósito: o TIDAL-DT tem
   espelho 1:1 em R para validação cruzada, e estes utilitários de vigilância
   são camada de leitura clínica, não do método de limiares.                 */

import { localDayKey } from '../io/parse.js';
import { quantile } from '../stats/descriptive.js';

export const PRACTICE_VERSION = '1.0';

export const PRACTICE_REFS = [
  { key: 'cascino2026', doi: '10.1038/s41531-026-01269-z', note: 'ADAPT-START: congelamento entre limiares, meta ≥0,7 mA, médias de 10 min pouco confiáveis para ajustar limiares' },
  { key: 'vanrheede2022', doi: '10.1038/s41531-022-00350-7', note: 'mitigação: inspeção regular da distribuição; artefato crônico acima do limiar reproduz a cDBS no teto' },
  { key: 'saengphatrachai2024', doi: '10.1080/17582024.2024.2404386', note: 'custo de bateria do streaming no Percept PC' },
  { key: 'khawaldeh2022', doi: '10.1093/brain/awab264', note: 'bursts beta sozinhos explicam 16% da variância motora; todos os estados espectrais, 50% — controlador só-beta descarta a maior parte da informação' }
];

export const PRACTICE_DEFAULTS = {
  minWindowMa: 0.7,            /* meta empírica do ADAPT-START */
  fewSwingsPerDay: 2,          /* abaixo disso, com ocupação alta dos limites: cDBS de dois níveis */
  pinnedFracForCdbs: 0.5,      /* fração do tempo encostado nos limites */
  driftLastDays: 7,
  driftWarnPct: 15             /* deslocamento do P50 que dispara o aviso */
};

/* dualThresholdTrap(trajectory, opts) — lê a TRAJETÓRIA simulada de corrente
   (saída de TIDAL.simulateDualThreshold) e mede o comportamento que Cascino
   descreveu: quanto tempo encostado em cada limite e quantas travessias
   completas entre os limites por dia. Não altera a função espelhada em R —
   só a interpreta.                                                          */
export function dualThresholdTrap(trajectory, opts) {
  const o = opts || {};
  const iMin = o.iMin, iMax = o.iMax;
  if (!isFinite(iMin) || !isFinite(iMax) || !(iMax > iMin)) return { ok: false, reason: 'limites de corrente ausentes' };
  const eps = (iMax - iMin) * 1e-6 + 1e-9;
  const fewSwings = isFinite(o.fewSwingsPerDay) ? o.fewSwingsPerDay : PRACTICE_DEFAULTS.fewSwingsPerDay;
  const pinFrac = isFinite(o.pinnedFracForCdbs) ? o.pinnedFracForCdbs : PRACTICE_DEFAULTS.pinnedFracForCdbs;
  let n = 0, pinHigh = 0, pinLow = 0, swings = 0;
  let estado = 0;                      /* −1 tocou o piso, +1 tocou o teto */
  const dias = new Set();
  for (let i = 0; i < trajectory.length; i++) {
    const I = trajectory[i];
    if (!isFinite(I)) continue;
    n++;
    if (o.dayKeys) dias.add(o.dayKeys[i]);
    const tocaTeto = I >= iMax - eps, tocaPiso = I <= iMin + eps;
    if (tocaTeto) pinHigh++;
    if (tocaPiso) pinLow++;
    if (tocaTeto && estado === -1) swings++;
    if (tocaPiso && estado === 1) swings++;
    if (tocaTeto) estado = 1;
    else if (tocaPiso) estado = -1;
  }
  const nd = Math.max(1, dias.size || Math.ceil(n / 144));
  const pctHigh = 100 * pinHigh / Math.max(1, n);
  const pctLow = 100 * pinLow / Math.max(1, n);
  const swingsDay = +(swings / nd).toFixed(2);
  const cdbsFuncional = (pctHigh + pctLow) / 100 >= pinFrac && swingsDay < fewSwings;
  return {
    ok: true, n, nDays: nd,
    pctPinnedHigh: +pctHigh.toFixed(1), pctPinnedLow: +pctLow.toFixed(1),
    fullSwingsPerDay: swingsDay, functionallyCdbs: cdbsFuncional,
    params: { fewSwingsPerDay: fewSwings, pinnedFracForCdbs: pinFrac },
    reading: cdbsFuncional
      ? `a corrente simulada passa ${(pctHigh + pctLow).toFixed(0)}% do tempo encostada nos limites e cruza de um limite ao ` +
        `outro só ${swingsDay}×/dia — funcionalmente uma cDBS de dois níveis, o comportamento que o ADAPT-START descreveu; ` +
        'reveja a largura da janela de limiares e lembre o congelamento: entre os limiares a amplitude NÃO desce'
      : `corrente encostada nos limites ${(pctHigh + pctLow).toFixed(0)}% do tempo, ${swingsDay} travessias completas/dia — ` +
        'o controlador está de fato modulando',
    freezeNote: 'entre os limiares a amplitude mantém o último valor: recuo do sinal para a faixa intermediária SEM cruzar ' +
      'o limiar inferior deixa a estimulação presa no teto (Cascino 2026, §programming principles)'
  };
}

/* amplitudeWindowCheck(iMin, iMax) — meta empírica de ≥0,7 mA de janela. */
export function amplitudeWindowCheck(iMin, iMax) {
  if (!isFinite(iMin) || !isFinite(iMax)) return { ok: false, reason: 'limites de corrente não informados (entrada do clínico)' };
  if (iMax <= iMin) return { ok: false, reason: 'iMax deve exceder iMin' };
  const w = +(iMax - iMin).toFixed(2);
  const meets = w >= PRACTICE_DEFAULTS.minWindowMa;
  return {
    ok: true, widthMa: w, meetsTarget: meets, targetMa: PRACTICE_DEFAULTS.minWindowMa,
    reading: meets
      ? `janela de ${w} mA ≥ meta empírica de ${PRACTICE_DEFAULTS.minWindowMa} mA (ADAPT-START)`
      : `janela de ${w} mA abaixo da meta empírica de ≥${PRACTICE_DEFAULTS.minWindowMa} mA do ADAPT-START — pouco espaço ` +
        'para o controlador trabalhar; considere reavaliar os limites com o teste de monopolar'
  };
}

/* distributionDrift(wakeRows, offMin, opts) — vigilância pós-configuração:
   compara os percentis 25/50/75 dos ÚLTIMOS `lastDays` dias de vigília com a
   janela de referência (todos os dias anteriores). wakeRows: [{t, x}] já em
   escala de limiar (log ou nativa, a mesma da proposta).                    */
export function distributionDrift(wakeRows, offMin, opts) {
  const o = opts || {};
  const lastDays = isFinite(o.lastDays) ? Math.max(2, Math.round(o.lastDays)) : PRACTICE_DEFAULTS.driftLastDays;
  const warnPct = isFinite(o.warnPct) ? o.warnPct : PRACTICE_DEFAULTS.driftWarnPct;
  const porDia = new Map();
  (wakeRows || []).forEach(r => {
    if (!r || !isFinite(r.t) || !isFinite(r.x)) return;
    const dk = localDayKey(r.t, offMin);
    if (!porDia.has(dk)) porDia.set(dk, []);
    porDia.get(dk).push(r.x);
  });
  const dias = Array.from(porDia.keys()).sort();
  if (dias.length < lastDays + 5) return {
    ok: false,
    reason: `são precisos ≥${lastDays + 5} dias (referência ≥5 + janela recente de ${lastDays}); há ${dias.length}`
  };
  const ref = dias.slice(0, dias.length - lastDays).flatMap(d => porDia.get(d));
  const rec = dias.slice(-lastDays).flatMap(d => porDia.get(d));
  const q = (v, p) => quantile(v, p);
  const shift = p => {
    const a = q(ref, p), b = q(rec, p);
    return a !== 0 ? +(100 * (b - a) / Math.abs(a)).toFixed(1) : NaN;
  };
  const s25 = shift(0.25), s50 = shift(0.5), s75 = shift(0.75);
  const drift = [s25, s50, s75].some(s => isFinite(s) && Math.abs(s) > warnPct);
  return {
    ok: true, drift,
    reference: { p25: +q(ref, .25).toFixed(3), p50: +q(ref, .5).toFixed(3), p75: +q(ref, .75).toFixed(3), n: ref.length, nDays: dias.length - lastDays },
    recent: { p25: +q(rec, .25).toFixed(3), p50: +q(rec, .5).toFixed(3), p75: +q(rec, .75).toFixed(3), n: rec.length, nDays: lastDays },
    shiftPct: { p25: s25, p50: s50, p75: s75 },
    params: { lastDays, warnPct },
    reading: drift
      ? `a distribuição de vigília dos últimos ${lastDays} dias deslocou-se ` +
        `(P25 ${s25 > 0 ? '+' : ''}${s25}% · P50 ${s50 > 0 ? '+' : ''}${s50}% · P75 ${s75 > 0 ? '+' : ''}${s75}%) em relação à janela de referência — ` +
        'limiares fixados na referência podem estar ocupando outra zona hoje: reavalie antes de interpretar a adaptação, ' +
        'e lembre o cenário de falha de van Rheede (artefato crônico acima do limiar = estimulação contínua no teto). ' +
        'Cascino: a variação da AMPLITUDE ao longo do tempo é indicador mais confiável que as médias de 10 min'
      : `distribuição recente estável em relação à referência (deslocamentos ≤ ${warnPct}%) — sem sinal de maladaptação por deriva`
  };
}

/* streamingBatteryCost(totalSeconds, model) — Percept PC: ~1 dia de
   longevidade por hora de streaming; streaming contínuo máximo ~4 h. No RC
   (recarregável) o custo é carga, não longevidade — a nota diz isso.        */
export function streamingBatteryCost(totalSeconds, model) {
  const h = (totalSeconds || 0) / 3600;
  /* \brc\b — "Percept" contém "rc" e não pode disparar o ramo recarregável */
  const isRC = /(^|[^a-z0-9])rc([^a-z0-9]|$)/i.test(String(model || ''));
  return {
    hoursStreamed: +h.toFixed(2),
    estimatedLongevityDaysLost: isRC ? 0 : +h.toFixed(1),
    model: isRC ? 'RC (recarregável)' : 'PC (não recarregável)',
    reading: isRC
      ? `${h.toFixed(1)} h de streaming neste conjunto — no Percept RC o custo é de recarga, não de longevidade`
      : `${h.toFixed(1)} h de streaming neste conjunto ≈ ${h.toFixed(1)} dia(s) de longevidade de bateria no Percept PC ` +
        '(≈1 dia/h; streaming contínuo máximo ~4 h — Saengphatrachai 2024). Planeje sessões de pesquisa com esse orçamento',
    source: 'doi:10.1080/17582024.2024.2404386'
  };
}

export const PRACTICE = {
  VERSION: PRACTICE_VERSION, REFS: PRACTICE_REFS, DEFAULTS: PRACTICE_DEFAULTS,
  dualThresholdTrap, amplitudeWindowCheck, distributionDrift, streamingBatteryCost
};
