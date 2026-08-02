/* metrics/survey.js — ranking dos pares bipolares do BrainSense Survey.

   O PROBLEMA PRÁTICO. Um Survey de eletrodo anelar rende 6 pares bipolares por
   hemisfério; com eletrodo direcional passa de 15. Inspecionar um a um num menu
   suspenso para descobrir onde o beta é mais forte é trabalhoso e, pior, é
   sujeito a erro: o olho compara mal duas curvas vistas em momentos diferentes.
   Este módulo ordena todos os pares de uma vez, por hemisfério, com o mesmo
   critério aplicado a todos.

   CRITÉRIO DE ORDENAÇÃO — e por que ele não é óbvio. A magnitude bruta na banda
   soma a oscilação COM o fundo aperiódico. Um par com impedância diferente, ou
   mais ruído, sobe em potência bruta sem ter mais oscilação. Por isso o padrão
   aqui é a ÁREA ACIMA DO FUNDO APERIÓDICO dentro da banda: é o que resta depois
   de descontar o 1/f. Os três critérios ficam disponíveis e o usado sai
   declarado:
     • 'aperiodic'  — área do resíduo positivo acima do fundo 1/f (padrão);
     • 'raw'        — área bruta sob a curva de magnitude na banda;
     • 'peak'       — magnitude do maior pico dentro da banda.

   Quando o ajuste aperiódico não converge ou explica pouco (R² < 0,5), o canal
   NÃO é ordenado junto com os demais: as duas grandezas estão em escalas
   diferentes e compará-las produziria uma ordem inventada. Ele vai para o fim
   da lista, marcado `rankable: false`, com o valor bruto disponível para quem
   quiser olhar. Ordenar o incomparável seria pior do que dizer que não dá.

   REPETIÇÕES. Se o mesmo par aparece em mais de um registro (várias sessões
   carregadas juntas), o espectro usado é a MEDIANA ponto a ponto entre os
   registros e `nRecords` informa quantos entraram. Mediana, não média, porque
   um registro contaminado por artefato não deve puxar o ranking.

   Unidades: f em Hz; magnitude na unidade do arquivo (µVp/√Hz no Percept); as
   áreas ficam em magnitude×Hz.

   Referências: Neumann W-J, et al. Brain Stimul 2021;14:1301-1306 (escolha do
   contato de sensing pelo beta); Thenaisie Y, et al. J Neural Eng 2021;18:042002
   (contatos 0-3 no GPi); Donoghue T, et al. Nat Neurosci 2020;23:1655 (por que
   descontar o aperiódico antes de comparar bandas).                          */

import { fitAperiodic } from '../dsp/aperiodic.js';
import { peakInBand } from './acute.js';
import { median } from '../stats/descriptive.js';

/* Área sob a curva entre lo e hi (regra do trapézio, ignorando NaN). */
function area(f, y, lo, hi) {
  let s = 0;
  for (let i = 1; i < f.length; i++) {
    if (f[i] < lo || f[i - 1] > hi) continue;
    const a = y[i - 1], b = y[i];
    if (!isFinite(a) || !isFinite(b)) continue;
    s += 0.5 * (a + b) * (f[i] - f[i - 1]);
  }
  return s;
}

/* Mediana ponto a ponto entre espectros que compartilham o eixo de frequência. */
function medianaEspectros(lista) {
  const base = lista[0];
  if (lista.length === 1) return base.mag.slice();
  const mesmoEixo = lista.every(m => m.f.length === base.f.length &&
    m.f.every((v, i) => Math.abs(v - base.f[i]) < 1e-6));
  if (!mesmoEixo) return base.mag.slice();
  return base.f.map((_, i) => {
    const v = lista.map(m => m.mag[i]).filter(isFinite);
    return v.length ? median(v) : NaN;
  });
}

/* rankSurveyChannels(montage, opts)
   opts: { lo, hi, criterion: 'aperiodic'|'raw'|'peak', topN }                */
export function rankSurveyChannels(montage, opts) {
  opts = opts || {};
  const lo = isFinite(opts.lo) ? opts.lo : 13;
  const hi = isFinite(opts.hi) ? opts.hi : 35;
  const criterio = ['aperiodic', 'raw', 'peak'].includes(opts.criterion) ? opts.criterion : 'aperiodic';
  const topN = isFinite(opts.topN) ? opts.topN : 3;
  const lista = (montage || []).filter(m => m && m.f && m.f.length && m.mag && m.mag.length);
  if (!lista.length) return null;

  /* agrupa por hemisfério + par de contatos */
  const grupos = new Map();
  lista.forEach(m => {
    const chave = (m.hemisphere || '?') + '|' + (m.electrodes || m.label || '?');
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(m);
  });

  const canais = [];
  grupos.forEach((registros, chave) => {
    const base = registros[0];
    const mag = medianaEspectros(registros);
    const f = base.f;
    const fmaxDisp = f[f.length - 1];

    const ap = fitAperiodic(f, mag, { fmin: 2, fmax: Math.min(95, fmaxDisp) });
    const r2 = ap && isFinite(ap.r2) ? ap.r2 : NaN;
    const ajusteUtil = !!ap && isFinite(r2) && r2 >= 0.5;

    /* área acima do fundo aperiódico: só o resíduo POSITIVO conta — resíduo
       negativo é o espectro abaixo do próprio fundo, não "oscilação negativa" */
    let areaCorrigida = NaN, picoCorrigidoHz = NaN;
    if (ap) {
      const pos = ap.periodic.map(v => Math.max(0, v));
      areaCorrigida = area(ap.f, pos, lo, hi);
      const dentro = ap.peaks.filter(pk => pk.cf >= lo && pk.cf <= hi);
      if (dentro.length) picoCorrigidoHz = dentro[0].cf;
    }
    const areaBruta = area(f, mag, lo, hi);
    const areaTotal = area(f, mag, 4, Math.min(45, fmaxDisp));
    const pk = peakInBand(f, mag, lo, hi);

    const ordenavel = criterio !== 'aperiodic' || ajusteUtil;
    const score = !ordenavel ? -Infinity
      : criterio === 'aperiodic' ? areaCorrigida
        : criterio === 'peak' ? pk.v : areaBruta;

    canais.push({
      hemisphere: base.hemisphere, electrodes: base.electrodes || '', label: base.label || '',
      key: chave, nRecords: registros.length,
      f, mag,
      peakHz: isFinite(pk.f) ? +pk.f.toFixed(2) : NaN,
      peakMag: isFinite(pk.v) ? +pk.v.toFixed(4) : NaN,
      peakCorrectedHz: isFinite(picoCorrigidoHz) ? +picoCorrigidoHz.toFixed(2) : NaN,
      hasDistinctPeak: !!(ap && ap.peaks.some(x => x.cf >= lo && x.cf <= hi)),
      bandArea: +areaBruta.toFixed(4),
      bandAreaCorrected: isFinite(areaCorrigida) ? +areaCorrigida.toFixed(4) : NaN,
      relPct: areaTotal > 0 ? +(100 * areaBruta / areaTotal).toFixed(2) : NaN,
      aperiodicExponent: ap ? +ap.exponent.toFixed(3) : NaN,
      aperiodicR2: isFinite(r2) ? +r2.toFixed(3) : NaN,
      criterionUsed: criterio,
      rankable: ordenavel,
      fallback: !ordenavel,
      artifact: base.artifact || '',
      score: isFinite(score) ? score : -Infinity
    });
  });

  const porHemi = {};
  ['Left', 'Right'].forEach(h => {
    const doLado = canais.filter(c => c.hemisphere === h).sort((a, b) => b.score - a.score);
    doLado.forEach((c, i) => { c.rank = i + 1; });
    if (doLado.length) porHemi[h] = doLado;
  });
  /* hemisférios fora do par esquerdo/direito (dado atípico) não são descartados */
  canais.filter(c => !['Left', 'Right'].includes(c.hemisphere)).forEach(c => {
    const h = c.hemisphere || 'Outro';
    (porHemi[h] = porHemi[h] || []).push(c);
  });
  Object.keys(porHemi).forEach(h => {
    if (!['Left', 'Right'].includes(h)) {
      porHemi[h].sort((a, b) => b.score - a.score).forEach((c, i) => { c.rank = i + 1; });
    }
  });

  /* os melhores são os melhores ENTRE OS COMPARÁVEIS: um canal sem ajuste
     aperiódico utilizável não pode aparecer como "top" de um critério que ele
     não pôde ser medido */
  const top = {};
  Object.keys(porHemi).forEach(h => { top[h] = porHemi[h].filter(c => c.rankable).slice(0, topN); });

  const comFallback = canais.filter(c => !c.rankable).length;
  return {
    band: [lo, hi], criterion: criterio, topN,
    hemispheres: porHemi, top,
    nChannels: canais.length,
    nFallback: comFallback,
    criterionLabel: criterio === 'aperiodic' ? 'área acima do fundo aperiódico na banda'
      : criterio === 'peak' ? 'magnitude do maior pico na banda'
        : 'área bruta sob a curva na banda',
    caveat: (comFallback
      ? `${comFallback} canal(is) não tiveram ajuste aperiódico utilizável (R² < 0,5) e por isso NÃO entraram na ordenação — ` +
        'aparecem no fim da lista, porque compará-los pela área bruta com os demais, ordenados acima do 1/f, ' +
        'produziria uma ordem sem significado. Para incluí-los, troque o critério para “área bruta na banda”. '
      : '') +
      'A ordenação descreve ONDE o marcador é mais forte no registro carregado. Não é, por si só, ' +
      'a escolha do contato de estimulação: proximidade ao alvo, efeitos colaterais e janela terapêutica ' +
      'entram na decisão e não estão neste dado.'
  };
}
