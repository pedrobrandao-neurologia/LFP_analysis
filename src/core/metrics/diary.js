/* metrics/diary.js — diário de estados ON/OFF, matriz hora × dia, e a mesma
   grade aplicada ao Timeline crônico.

   POR QUE ESTA FIGURA EXISTE. O desfecho primário de quase todo ensaio clínico
   em doença de Parkinson avançada é "horas OFF em vigília" — LCIG, apomorfina
   subcutânea, opicapona, safinamida, todos reportam isso. O número sai do
   diário de Hauser: o paciente registra, a cada 30 min, se está OFF, ON sem
   discinesia, ON com discinesia não incômoda, ON com discinesia incômoda, ou
   dormindo. E aí o número é publicado como barra empilhada — que é onde a
   informação clínica morre.

   O QUE A BARRA EMPILHADA DESTRÓI. "6,2 h OFF por dia" é compatível com pelo
   menos três quadros clínicos que pedem condutas opostas:
     · OFF matinal longo por delayed-on — a primeira dose demora a agir;
     · wearing-off vespertino progressivo — o intervalo entre doses é largo demais;
     · OFFs curtos e picados o dia inteiro — flutuação imprevisível.
   O total é o mesmo; a decisão terapêutica não é. A matriz hora × dia preserva
   ONDE no dia o OFF cai, e por isso é o formato que responde à pergunta clínica.

   POR QUE ISSO PERTENCE A UM SOFTWARE DE LFP. A matriz hora × dia é
   EXATAMENTE a estrutura do BrainSense Timeline: dias × bins de potência beta.
   Trocando a escala categórica (5 estados) por uma contínua (potência), o mesmo
   desenho serve para os dois. E sobrepor os dois na MESMA grade é o que torna
   visualmente auditável a concordância entre o estado autorreportado e o
   biomarcador — que é a pergunta de validação que a literatura de aDBS ainda
   não fechou.

   O QUE ESTE MÓDULO NÃO FAZ. Não converte potência beta em "OFF clínico". O
   limiar de beta que separaria ON de OFF não tem consenso: depende do par de
   contatos, da banda, do grupo de estimulação e do paciente. Aqui o limiar é
   um PARÂMETRO declarado, o estado derivado do LFP tem nome próprio
   (`LFP_high`/`LFP_low`, nunca `Off`/`On`), e a concordância com o diário é
   MEDIDA em vez de assumida.

   Unidades: hora local em horas decimais [0,24); duração em horas; potência na
   unidade do arquivo.

   Referências:
     Hauser RA, et al. Clin Neuropharmacol 2000;23:75-81 (diário de 30 min).
     Hauser RA, et al. Mov Disord 2004;19:1409-13 (validação e treinamento).
     Olanow CW, et al. Lancet Neurol 2014;13:141-9 (LCIG; desfecho em vigília).
     Ferreira JJ, et al. Lancet Neurol 2016;15:154-65 (opicapona; mesma métrica).
     Katzenschlager R, et al. Lancet Neurol 2018;17:749-59 (apomorfina).
     van Rheede JJ, et al. npj Parkinsons Dis 2022;8:88 (ritmo circadiano do beta).
     Neumann WJ, et al. Mov Disord 2017;32:148-52 (beta e estado motor).
     Cohen J. Educ Psychol Meas 1960;20:37-46 (kappa).                        */

import { median, mean, sd, quantile, rnd } from '../stats/descriptive.js';
import { localHour, localDayKey } from '../io/parse.js';
import { detectStates } from '../stats/states.js';
import { eventAligned, permutationTwoSample } from '../stats/events.js';
import { detectaDelimitador, numero } from '../io/external.js';

/* ---------------------------------------------------------- vocabulário -- */

/* Os cinco estados do diário de Hauser, na ordem em que a literatura os
   empilha (sono na base, depois OFF, depois os três graus de ON). As cores são
   as mesmas das versões em Python e R desta figura, para que a leitura seja
   transferível entre as três. */
export const DIARY_STATES = [
  { id: 'Asleep', label: 'sono', color: '#D5D8DE', awake: false, off: false },
  { id: 'Off', label: 'OFF', color: '#7D1128', awake: true, off: true },
  { id: 'On_NoDysk', label: 'ON sem discinesia', color: '#1B7F79', awake: true, off: false },
  { id: 'On_NonTroublesomeDysk', label: 'ON c/ discinesia não incômoda', color: '#F2B705', awake: true, off: false },
  { id: 'On_TroublesomeDysk', label: 'ON c/ discinesia incômoda', color: '#D95D39', awake: true, off: false }
];

/* Estados derivados do LFP. Nome DIFERENTE de propósito: o limiar de beta não
   é um diagnóstico de OFF, e misturar os dois vocabulários é o erro que este
   módulo existe para evitar. */
export const LFP_STATES = [
  { id: 'LFP_low', label: 'beta abaixo do limiar', color: '#1B7F79' },
  { id: 'LFP_high', label: 'beta acima do limiar', color: '#7D1128' },
  { id: 'LFP_none', label: 'sem dado no bin', color: '#EEF1F4' }
];

export const stateById = id => DIARY_STATES.find(s => s.id === id) || LFP_STATES.find(s => s.id === id) || null;

/* Sinônimos aceitos na importação. Um diário exportado de outra planilha
   raramente usa exatamente os rótulos do arquivo de referência. */
const SINONIMOS = {
  asleep: 'Asleep', sleep: 'Asleep', sono: 'Asleep', dormindo: 'Asleep', s: 'Asleep',
  off: 'Off', 'off_time': 'Off', 'tempo off': 'Off',
  on: 'On_NoDysk', 'on_nodysk': 'On_NoDysk', 'on sem discinesia': 'On_NoDysk',
  'on_no_dysk': 'On_NoDysk', 'on without dyskinesia': 'On_NoDysk',
  'on_nontroublesomedysk': 'On_NonTroublesomeDysk', 'on_non_troublesome_dysk': 'On_NonTroublesomeDysk',
  'on with non-troublesome dyskinesia': 'On_NonTroublesomeDysk', 'ontnd': 'On_NonTroublesomeDysk',
  'on_troublesomedysk': 'On_TroublesomeDysk', 'on_troublesome_dysk': 'On_TroublesomeDysk',
  'on with troublesome dyskinesia': 'On_TroublesomeDysk', 'ontd': 'On_TroublesomeDysk'
};

export function normalizeState(bruto) {
  if (bruto == null) return null;
  const s = String(bruto).trim().replace(/^"|"$/g, '');
  if (!s) return null;
  if (DIARY_STATES.some(d => d.id === s)) return s;
  const chave = s.toLowerCase().replace(/\s+/g, ' ');
  if (SINONIMOS[chave]) return SINONIMOS[chave];
  const semSep = chave.replace(/[\s_-]/g, '');
  const achado = DIARY_STATES.find(d => d.id.toLowerCase().replace(/[\s_-]/g, '') === semSep);
  return achado ? achado.id : null;
}

/* ------------------------------------------------------------- leitura --- */

const limpa = s => String(s == null ? '' : s).trim().replace(/^"|"$/g, '');
/* "07:30", "7:30:00" ou "7,5" → horas decimais */
function horaDe(txt) {
  const t = limpa(txt);
  if (!t) return NaN;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (m) return (+m[1]) + (+m[2]) / 60 + (m[3] ? +m[3] / 3600 : 0);
  const iso = /[T ](\d{2}):(\d{2})/.exec(t);
  if (iso) return (+iso[1]) + (+iso[2]) / 60;
  const v = numero(t);
  return isFinite(v) && v >= 0 && v < 24 ? v : NaN;
}

/* parseDiaryCsv(texto) — lê o diário no esquema de colunas
     patient_id, condition, day, bin_index, time, hour_decimal, state
   Nenhuma coluna além de `state` e de uma referência de hora é obrigatória.
   Linha malformada é CONTADA, não descartada em silêncio.                   */
export function parseDiaryCsv(texto, opts) {
  opts = opts || {};
  const linhas = String(texto || '').split(/\r?\n/).filter(l => l.trim().length);
  if (linhas.length < 2) return { ok: false, reason: 'arquivo vazio ou só com cabeçalho' };
  const delim = detectaDelimitador(linhas);
  const cab = linhas[0].split(delim).map(s => limpa(s).toLowerCase());
  const idx = nomes => { for (const n of nomes) { const i = cab.indexOf(n); if (i >= 0) return i; } return -1; };
  const iEstado = idx(['state', 'estado', 'status']);
  const iHora = idx(['hour_decimal', 'hora_decimal', 'hour', 'hora']);
  const iTempo = idx(['time', 'tempo', 'horario', 'horário', 'timestamp']);
  const iBin = idx(['bin_index', 'bin', 'indice_bin']);
  const iDia = idx(['day', 'dia', 'date', 'data']);
  const iCond = idx(['condition', 'condicao', 'condição', 'grupo', 'group']);
  const iPac = idx(['patient_id', 'patient', 'paciente', 'subject', 'subject_id', 'id']);
  if (iEstado < 0) return {
    ok: false,
    reason: `não há coluna de estado. O cabeçalho lido foi: ${cab.join(delim)}. ` +
      'É necessária ao menos uma coluna chamada "state" (ou "estado")'
  };
  if (iHora < 0 && iTempo < 0 && iBin < 0) return {
    ok: false,
    reason: 'não há coluna de hora: é necessária "hour_decimal", "time" ou "bin_index"'
  };

  const brutas = [];
  let nMalformadas = 0, nSemHora = 0;
  const desconhecidos = {};
  for (let i = 1; i < linhas.length; i++) {
    const c = linhas[i].split(delim);
    if (c.length <= iEstado) { nMalformadas++; continue; }
    const bruto = limpa(c[iEstado]);
    const estado = normalizeState(bruto);
    if (!estado) { desconhecidos[bruto || '(vazio)'] = (desconhecidos[bruto || '(vazio)'] || 0) + 1; nMalformadas++; continue; }
    let hora = iHora >= 0 ? numero(c[iHora]) : NaN;
    if (!isFinite(hora) && iTempo >= 0) hora = horaDe(c[iTempo]);
    const bin = iBin >= 0 ? numero(c[iBin]) : NaN;
    brutas.push({
      patient: iPac >= 0 ? limpa(c[iPac]) : 'único',
      condition: iCond >= 0 ? limpa(c[iCond]) || 'única' : 'única',
      day: iDia >= 0 ? limpa(c[iDia]) : '1',
      bin, hora, state: estado
    });
  }
  if (!brutas.length) return {
    ok: false,
    reason: `nenhuma das ${linhas.length - 1} linhas de dado tem estado reconhecível. ` +
      `Valores encontrados: ${Object.keys(desconhecidos).slice(0, 6).join(', ')}. ` +
      `Esperado um de: ${DIARY_STATES.map(s => s.id).join(', ')}`
  };

  /* tamanho do bin: passo típico entre horas distintas; se só houver
     bin_index, deduz do número de bins por dia */
  let binMin = opts.binMin;
  if (!binMin) {
    const horas = Array.from(new Set(brutas.map(r => r.hora).filter(isFinite))).sort((a, b) => a - b);
    const dif = [];
    for (let i = 1; i < horas.length; i++) { const d = horas[i] - horas[i - 1]; if (d > 1e-6) dif.push(d); }
    const passo = dif.length ? median(dif) : NaN;
    if (isFinite(passo) && passo > 0) binMin = Math.round(passo * 60);
    else {
      const bins = new Set(brutas.map(r => r.bin).filter(isFinite));
      binMin = bins.size > 1 ? Math.round(24 * 60 / bins.size) : 30;
    }
  }
  binMin = Math.max(1, Math.min(240, Math.round(binMin)));

  /* completa a hora a partir do bin_index quando ela faltou */
  const rows = [];
  brutas.forEach(r => {
    let h = r.hora;
    if (!isFinite(h) && isFinite(r.bin)) h = r.bin * binMin / 60;
    if (!isFinite(h) || h < 0 || h >= 24) { nSemHora++; return; }
    rows.push({ patient: r.patient, condition: r.condition, day: r.day, hour: h, state: r.state });
  });
  if (!rows.length) return { ok: false, reason: 'nenhuma linha com hora do dia utilizável' };

  return {
    ok: true, rows, binMin, delimiter: delim === '\t' ? 'tabulação' : delim,
    columns: { state: cab[iEstado], hour: iHora >= 0 ? cab[iHora] : (iTempo >= 0 ? cab[iTempo] : cab[iBin]), day: iDia >= 0 ? cab[iDia] : null },
    patients: Array.from(new Set(rows.map(r => r.patient))),
    conditions: Array.from(new Set(rows.map(r => r.condition))),
    nRows: rows.length, nLines: linhas.length - 1,
    nMalformed: nMalformadas, nWithoutHour: nSemHora,
    unknownStates: Object.keys(desconhecidos).map(k => ({ value: k, n: desconhecidos[k] })),
    note: `bin de ${binMin} min inferido do espaçamento das horas` +
      (nMalformadas ? ` · ${nMalformadas} linha(s) descartada(s) por estado não reconhecido` : '') +
      (nSemHora ? ` · ${nSemHora} linha(s) sem hora utilizável` : '')
  };
}

/* --------------------------------------------------------- grade dia×bin - */

const ordenaDias = ds => ds.slice().sort((a, b) => {
  const na = Number(a), nb = Number(b);
  if (isFinite(na) && isFinite(nb)) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
});

/* diaryGrid(rows, opts) → matriz dias × bins de estado.
   Célula sem registro fica `null` — nunca preenchida por vizinho.           */
export function diaryGrid(rows, opts) {
  opts = opts || {};
  const binMin = opts.binMin || 30;
  const nBins = Math.round(24 * 60 / binMin);
  const sel = (rows || []).filter(r =>
    (!opts.condition || r.condition === opts.condition) &&
    (!opts.patient || r.patient === opts.patient));
  if (!sel.length) return { ok: false, reason: 'nenhuma linha para esta condição' };
  const dias = ordenaDias(Array.from(new Set(sel.map(r => String(r.day)))));
  const iDia = {}; dias.forEach((d, i) => { iDia[d] = i; });
  const cells = dias.map(() => new Array(nBins).fill(null));
  let nConflitos = 0;
  sel.forEach(r => {
    const b = Math.min(nBins - 1, Math.max(0, Math.floor(r.hour * 60 / binMin)));
    const linha = cells[iDia[String(r.day)]];
    if (linha[b] === null) linha[b] = r.state;
    else if (linha[b] !== r.state) nConflitos++;
  });
  const nCel = dias.length * nBins;
  let nPreenchidas = 0;
  cells.forEach(l => l.forEach(v => { if (v) nPreenchidas++; }));
  return {
    ok: true, kind: 'diary', condition: opts.condition || null, patient: opts.patient || null,
    binMin, nBins, days: dias, cells,
    nCells: nCel, nFilled: nPreenchidas, nMissing: nCel - nPreenchidas,
    pctMissing: +(100 * (nCel - nPreenchidas) / nCel).toFixed(2),
    nConflicts: nConflitos,
    note: nConflitos ? `${nConflitos} célula(s) com mais de um estado declarado — mantido o primeiro, e a discordância é contada` : ''
  };
}

/* ------------------------------------------------------- composição diária */

/* dailyComposition(grid, opts) → horas por estado, dia a dia, e a média.

   `awakeOnly` retira os bins de sono do numerador E do total: é o recorte de
   desfecho primário dos ensaios (horas OFF em VIGÍLIA). O total de vigília
   varia entre dias, e é isso mesmo — quem dorme 10 h tem 14 h de vigília para
   distribuir, e normalizar isso para 24 h inventaria tempo.

   Dia com cobertura abaixo de `minCoverage` NÃO entra na média: metade de um
   dia diz metade de uma história, e a média silenciosa sobre dias incompletos
   é a forma mais comum de subestimar tempo OFF.                             */
export function dailyComposition(grid, opts) {
  opts = opts || {};
  if (!grid || !grid.ok) return { ok: false, reason: (grid && grid.reason) || 'grade inválida' };
  const soVigilia = !!opts.awakeOnly;
  const minCob = opts.minCoverage == null ? 0.8 : opts.minCoverage;
  const hBin = grid.binMin / 60;
  const ids = DIARY_STATES.filter(s => !soVigilia || s.awake).map(s => s.id);

  const perDay = grid.days.map((dia, i) => {
    const linha = grid.cells[i];
    const horas = {}; ids.forEach(k => { horas[k] = 0; });
    let nValidos = 0, nSono = 0;
    linha.forEach(v => {
      if (v == null) return;
      nValidos++;
      if (v === 'Asleep') { nSono++; if (soVigilia) return; }
      if (horas[v] !== undefined) horas[v] += hBin;
    });
    const nBase = soVigilia ? (nValidos - nSono) : nValidos;
    const cobertura = grid.nBins ? nValidos / grid.nBins : 0;
    return {
      day: dia, hours: horas, total: +(nBase * hBin).toFixed(3),
      nValid: nValidos, nMissing: grid.nBins - nValidos,
      coverage: +cobertura.toFixed(3), complete: cobertura >= minCob
    };
  });

  const usados = perDay.filter(d => d.complete);
  const excluidos = perDay.length - usados.length;
  const byState = {};
  ids.forEach(k => {
    const v = usados.map(d => d.hours[k]);
    const m = v.length ? mean(v) : NaN;
    const s = v.length > 1 ? sd(v) : NaN;
    byState[k] = {
      mean: isFinite(m) ? +m.toFixed(3) : NaN,
      sd: isFinite(s) ? +s.toFixed(3) : NaN,
      sem: isFinite(s) && v.length > 1 ? +(s / Math.sqrt(v.length)).toFixed(3) : NaN,
      n: v.length, values: v.map(x => +x.toFixed(3))
    };
  });
  return {
    ok: usados.length > 0,
    reason: usados.length ? '' : `nenhum dia com cobertura ≥ ${(minCob * 100).toFixed(0)}% dos bins — ` +
      'com dado tão esparso não é possível estimar horas por estado',
    awakeOnly: soVigilia, binMin: grid.binMin, minCoverage: minCob,
    order: ids, perDay, byState,
    nDays: perDay.length, nDaysUsed: usados.length, nDaysExcluded: excluidos,
    off: byState.Off || null,
    meanTotal: usados.length ? +mean(usados.map(d => d.total)).toFixed(2) : NaN,
    note: (soVigilia
      ? 'recorte de vigília: os bins de sono saem do numerador e do total, que é o desfecho reportado nos ensaios'
      : 'recorte de 24 h: inclui o sono, e por isso todo dia soma 24 h') +
      (excluidos ? ` · ${excluidos} dia(s) fora da média por cobertura < ${(minCob * 100).toFixed(0)}%` : '')
  };
}

/* ------------------------------------------------------ comparar condições */

/* compareConditions(rows, opts) → média por condição e diferença do tempo OFF.

   PAREAMENTO. Dia 1 do basal e dia 1 do pós-otimização não são a mesma
   observação — são dias distintos do mesmo paciente. Tratá-los como par
   estreita o intervalo de confiança sem justificativa. O padrão aqui é NÃO
   pareado; `opts.paired` existe para quem tem desenho pareado de verdade, e a
   escolha sai declarada no resultado.                                        */
export function compareConditions(rows, opts) {
  opts = opts || {};
  const binMin = opts.binMin || 30;
  const conds = opts.conditions || ordenaDias(Array.from(new Set((rows || []).map(r => r.condition))));
  if (conds.length < 2) return { ok: false, reason: `há só ${conds.length} condição no arquivo — não há o que comparar` };
  const comps = conds.map(c => {
    const g = diaryGrid(rows, { condition: c, binMin, patient: opts.patient });
    return { condition: c, grid: g, comp: dailyComposition(g, { awakeOnly: opts.awakeOnly, minCoverage: opts.minCoverage }) };
  }).filter(x => x.comp.ok);
  if (comps.length < 2) return { ok: false, reason: 'menos de duas condições com dias completos o bastante' };

  const a = comps[0], b = comps[comps.length - 1];
  const va = a.comp.byState.Off ? a.comp.byState.Off.values : [];
  const vb = b.comp.byState.Off ? b.comp.byState.Off.values : [];
  const pareado = !!opts.paired && va.length === vb.length && va.length > 1;
  const delta = mean(vb) - mean(va);
  let teste = null;
  if (pareado) {
    const dif = va.map((x, i) => vb[i] - x);
    const s = sd(dif), n = dif.length;
    teste = {
      method: 'pareado (diferença dia a dia)', n,
      mean: +mean(dif).toFixed(3), sem: n > 1 ? +(s / Math.sqrt(n)).toFixed(3) : NaN,
      ci95: n > 1 ? [+(mean(dif) - 1.96 * s / Math.sqrt(n)).toFixed(3), +(mean(dif) + 1.96 * s / Math.sqrt(n)).toFixed(3)] : null
    };
  } else if (va.length > 1 && vb.length > 1) {
    const p = permutationTwoSample(va, vb, { seed: opts.seed, nPermutations: opts.nPermutations || 10000 });
    const se = Math.sqrt(sd(va) ** 2 / va.length + sd(vb) ** 2 / vb.length);
    teste = {
      method: p.exact ? `permutação exata (${p.nPermutations} partições)` : `permutação (${p.nPermutations} sorteios, semente ${p.seed})`,
      exact: p.exact, p: p.p, nPermutations: p.nPermutations, seed: p.seed,
      sem: +se.toFixed(3), ci95: [+(delta - 1.96 * se).toFixed(3), +(delta + 1.96 * se).toFixed(3)]
    };
  }
  return {
    ok: true, awakeOnly: !!opts.awakeOnly, paired: pareado, binMin,
    conditions: comps.map(c => ({
      condition: c.condition, nDays: c.comp.nDaysUsed, nDaysExcluded: c.comp.nDaysExcluded,
      byState: c.comp.byState, meanTotal: c.comp.meanTotal
    })),
    deltaOff: +delta.toFixed(3), from: a.condition, to: b.condition, test: teste,
    interpretation: !teste ? 'poucos dias para estimar a diferença com incerteza'
      : `${delta < 0 ? 'redução' : 'aumento'} de ${Math.abs(delta).toFixed(1)} h no tempo OFF` +
        (opts.awakeOnly ? ' em vigília' : ' em 24 h') +
        ` entre ${a.condition} e ${b.condition}` +
        (teste.ci95 ? ` (IC 95% ${teste.ci95[0].toFixed(1)} a ${teste.ci95[1].toFixed(1)} h)` : '') +
        (teste.p != null ? `, p = ${teste.p < 0.001 ? '<0,001' : teste.p.toFixed(3).replace('.', ',')}` : ''),
    caveat: pareado
      ? 'diferença tratada como pareada por escolha explícita — só é válido se cada dia de uma condição corresponder ao mesmo dia da outra'
      : 'dias de condições diferentes não são pares: a comparação é não pareada, que é o pressuposto conservador. ' +
        'O gráfico de linhas ligando dia a dia é recurso visual, não teste pareado'
  };
}

/* --------------------------------------------------- perfil circadiano ---- */

/* circadianStateProfile(grid) → em cada bin do dia, a proporção de dias em cada
   estado. É a área empilhada de 100% que mostra ONDE no dia o OFF se concentra. */
export function circadianStateProfile(grid) {
  if (!grid || !grid.ok) return { ok: false, reason: (grid && grid.reason) || 'grade inválida' };
  const ids = DIARY_STATES.map(s => s.id);
  const props = {}; ids.forEach(k => { props[k] = new Array(grid.nBins).fill(NaN); });
  const nPorBin = new Array(grid.nBins).fill(0);
  for (let b = 0; b < grid.nBins; b++) {
    const conta = {}; ids.forEach(k => { conta[k] = 0; });
    let n = 0;
    grid.cells.forEach(l => { const v = l[b]; if (v && conta[v] !== undefined) { conta[v]++; n++; } });
    nPorBin[b] = n;
    if (n) ids.forEach(k => { props[k][b] = 100 * conta[k] / n; });
  }
  const hours = Array.from({ length: grid.nBins }, (_, i) => +((i + 0.5) * grid.binMin / 60).toFixed(4));
  /* hora de maior proporção de OFF — a leitura clínica direta da figura */
  let iPico = -1, vPico = -Infinity;
  props.Off.forEach((v, i) => { if (isFinite(v) && nPorBin[i] >= Math.max(2, grid.days.length * 0.5) && v > vPico) { vPico = v; iPico = i; } });
  return {
    ok: true, hours, props, nPerBin: nPorBin, binMin: grid.binMin, nDays: grid.days.length, order: ids,
    peakOffHour: iPico >= 0 ? hours[iPico] : NaN, peakOffPct: iPico >= 0 ? +vPico.toFixed(1) : NaN,
    note: `proporção calculada sobre os dias COM registro em cada bin (${Math.min.apply(null, nPorBin)}–${Math.max.apply(null, nPorBin)} dias por bin) — ` +
      'bin sem registro fica vazio em vez de zero'
  };
}

/* ------------------------------------------------ a mesma grade no LFP ---- */

/* timelineGrid(rows, offMin, opts) → matriz dias × bins do Timeline crônico,
   na MESMA estrutura da matriz do diário: escala contínua (potência) e uma
   leitura categórica opcional por limiar.

   O limiar é escolha, não descoberta. Três métodos, e o usado sai declarado:
     'kmeans'     — k-médias de 2 grupos sobre a série inteira (o mesmo do F13);
     'percentile' — percentil `pct` da própria série;
     'fixed'      — valor absoluto informado.
   Nenhum deles é "o limiar de OFF": são partições da distribuição de beta.   */
export function timelineGrid(rows, offMin, opts) {
  opts = opts || {};
  const binMin = opts.binMin || 30;
  const nBins = Math.round(24 * 60 / binMin);
  const metodo = opts.thresholdMethod || 'kmeans';
  const validas = (rows || []).filter(r => r && isFinite(r.t) && isFinite(r.lfp));
  if (validas.length < nBins) return {
    ok: false,
    reason: `só ${validas.length} ponto(s) de Timeline — são necessários ao menos ${nBins} para preencher um dia de bins de ${binMin} min`
  };
  const porDia = {};
  validas.forEach(r => {
    const d = localDayKey(r.t, offMin);
    (porDia[d] = porDia[d] || []).push(r);
  });
  const dias = Object.keys(porDia).sort();
  const values = dias.map(() => new Array(nBins).fill(NaN));
  const nPorCel = dias.map(() => new Array(nBins).fill(0));
  dias.forEach((d, i) => {
    const baldes = Array.from({ length: nBins }, () => []);
    porDia[d].forEach(r => baldes[Math.min(nBins - 1, Math.floor(localHour(r.t, offMin) * 60 / binMin))].push(r.lfp));
    baldes.forEach((b, j) => { if (b.length) { values[i][j] = median(b); nPorCel[i][j] = b.length; } });
  });

  const planos = values.flat().filter(isFinite);
  let limiar = NaN, detalhe = '';
  if (metodo === 'fixed' && isFinite(opts.threshold)) { limiar = opts.threshold; detalhe = 'valor informado pelo usuário'; }
  else if (metodo === 'percentile') {
    const pct = opts.pct == null ? 50 : opts.pct;
    limiar = quantile(planos, pct / 100);
    detalhe = `percentil ${pct} da distribuição do próprio registro`;
  } else {
    const st = detectStates(validas.map(r => ({ t: r.t, v: r.lfp })), {});
    if (st) { limiar = st.threshold; detalhe = `k-médias de 2 grupos (separação ${st.separation.toFixed(2)} DP, bimodalidade ${st.bimodality.toFixed(3)})`; }
    else { limiar = median(planos); detalhe = 'mediana — k-médias não convergiu com este dado'; }
  }
  const states = values.map(l => l.map(v => !isFinite(v) ? null : (v > limiar ? 'LFP_high' : 'LFP_low')));
  const nCel = dias.length * nBins;
  const nPreenchidas = planos.length;

  return {
    ok: true, kind: 'lfp', binMin, nBins, days: dias, values, states, nPerCell: nPorCel,
    threshold: +limiar.toFixed(4), thresholdMethod: metodo, thresholdDetail: detalhe,
    thresholdParams: metodo === 'percentile' ? { pct: opts.pct == null ? 50 : opts.pct } : {},
    zmin: planos.length ? +quantile(planos, 0.02).toFixed(3) : NaN,
    zmax: planos.length ? +quantile(planos, 0.98).toFixed(3) : NaN,
    nCells: nCel, nFilled: nPreenchidas, nMissing: nCel - nPreenchidas,
    pctMissing: +(100 * (nCel - nPreenchidas) / nCel).toFixed(2),
    highFraction: +(states.flat().filter(v => v === 'LFP_high').length / Math.max(1, nPreenchidas)).toFixed(3),
    caveat: 'beta acima do limiar NÃO é OFF clínico. O limiar é uma partição da distribuição deste registro, ' +
      'depende do par de contatos e do grupo de estimulação, e não tem valor de corte validado entre pacientes'
  };
}

/* ------------------------------------------------------- marcas de dose --- */

/* doseMarkers(events, offMin, opts) → os ▼ da matriz.
   `events`: [{ t, name }] — eventos marcados pelo paciente no próprio aparelho. */
export function doseMarkers(events, offMin, opts) {
  opts = opts || {};
  const padrao = opts.pattern || /medica|levodopa|dose|carbidopa|prolopa|sinemet/i;
  const todos = (events || []).filter(e => e && isFinite(e.t));
  const nomes = Array.from(new Set(todos.map(e => e.name).filter(Boolean)));
  const sel = todos.filter(e => opts.eventName ? e.name === opts.eventName : padrao.test(String(e.name || '')));
  if (!sel.length) return {
    ok: false, availableNames: nomes,
    reason: nomes.length
      ? `nenhum evento corresponde a tomada de medicação. Eventos disponíveis: ${nomes.join(', ')}`
      : 'este arquivo não tem eventos marcados pelo paciente — as marcas de dose dependem do registro do evento no próprio aparelho'
  };
  const doses = sel.map(e => ({ t: e.t, name: e.name, day: localDayKey(e.t, offMin), hour: +localHour(e.t, offMin).toFixed(3) }))
    .sort((a, b) => a.t - b.t);
  const byDay = {};
  doses.forEach(d => { (byDay[d.day] = byDay[d.day] || []).push(d.hour); });
  const dias = Object.keys(byDay);
  const porDia = dias.map(d => byDay[d].length);
  /* intervalo entre doses consecutivas do MESMO dia — o resto é a noite */
  const intervalos = [];
  dias.forEach(d => { const h = byDay[d].slice().sort((a, b) => a - b); for (let i = 1; i < h.length; i++) intervalos.push(h[i] - h[i - 1]); });
  return {
    ok: true, doses, byDay, hours: doses.map(d => d.hour), n: doses.length,
    nDays: dias.length, dosesPerDay: porDia.length ? +median(porDia).toFixed(1) : NaN,
    medianIntervalH: intervalos.length ? +median(intervalos).toFixed(2) : NaN,
    eventName: opts.eventName || null, pattern: String(padrao), availableNames: nomes,
    note: 'as marcas vêm do evento registrado pelo paciente no aparelho — refletem quando ele APERTOU o botão, ' +
      'que não é necessariamente quando engoliu o comprimido'
  };
}

/* ------------------------------------ concordância entre diário e LFP ----- */

const modaDe = arr => {
  const c = {}; let melhor = null, n = 0;
  arr.forEach(v => { if (v == null) return; c[v] = (c[v] || 0) + 1; });
  Object.keys(c).forEach(k => { if (c[k] > n) { n = c[k]; melhor = k; } });
  const empate = Object.keys(c).filter(k => c[k] === n).length > 1;
  return empate ? null : melhor;      /* empate → sem decisão, não sorteio */
};

/* reamostra uma grade para um bin mais grosso pela MODA dos sub-bins */
function reamostra(grid, binMin) {
  if (grid.binMin === binMin) return { cells: grid.cells || grid.states, nBins: grid.nBins };
  const fator = Math.round(binMin / grid.binMin);
  const nBins = Math.round(24 * 60 / binMin);
  const src = grid.cells || grid.states;
  return {
    cells: src.map(l => Array.from({ length: nBins }, (_, j) => modaDe(l.slice(j * fator, (j + 1) * fator)))),
    nBins
  };
}

/* diaryVsLfpAgreement(diario, lfp, opts) → a concordância célula a célula.

   É a pergunta de validação: quando o paciente escreveu OFF, o beta estava
   alto? Comparação binária (OFF vs. ON no diário; acima vs. abaixo do limiar
   no LFP), só nos bins em que AMBOS existem, e por padrão só na vigília — o
   beta cai no sono por razões que não têm nada a ver com levodopa.

   O alinhamento dos dias é declarado: por chave de data quando os rótulos
   batem, por ordem quando não — e "por ordem" é suposição, não medida.      */
export function diaryVsLfpAgreement(diario, lfp, opts) {
  opts = opts || {};
  if (!diario || !diario.ok) return { ok: false, reason: 'sem grade de diário' };
  if (!lfp || !lfp.ok) return { ok: false, reason: 'sem grade de Timeline' };
  const binMin = Math.max(diario.binMin, lfp.binMin);
  const D = reamostra(diario, binMin), L = reamostra({ ...lfp, cells: lfp.states }, binMin);

  /* alinhamento por chave, se as chaves coincidirem */
  const comuns = diario.days.filter(d => lfp.days.indexOf(d) >= 0);
  let pares, alinhamento, confianca;
  if (comuns.length >= 2) {
    pares = comuns.map(d => [diario.days.indexOf(d), lfp.days.indexOf(d)]);
    alinhamento = `por data (${comuns.length} dia(s) com a mesma chave nos dois)`;
    confianca = 'alta';
  } else {
    const n = Math.min(diario.days.length, lfp.days.length);
    if (n < 2) return { ok: false, reason: 'menos de 2 dias em comum entre diário e Timeline' };
    pares = Array.from({ length: n }, (_, i) => [i, i]);
    alinhamento = `por ordem (dia ${diario.days[0]} do diário assumido como ${lfp.days[0]} do Timeline)`;
    confianca = 'baixa';
  }

  let a = 0, b = 0, c = 0, d = 0, nSono = 0, nSoUm = 0;
  pares.forEach(([i, j]) => {
    for (let k = 0; k < Math.min(D.nBins, L.nBins); k++) {
      const dv = D.cells[i][k], lv = L.cells[j][k];
      if (dv == null || lv == null) { nSoUm++; continue; }
      if (dv === 'Asleep') { nSono++; if (!opts.includeSleep) continue; }
      const diarioOff = dv === 'Off';
      const lfpAlto = lv === 'LFP_high';
      if (diarioOff && lfpAlto) a++;
      else if (diarioOff && !lfpAlto) b++;
      else if (!diarioOff && lfpAlto) c++;
      else d++;
    }
  });
  const n = a + b + c + d;
  if (n < 20) return { ok: false, reason: `só ${n} bin(s) com diário e Timeline ao mesmo tempo — insuficiente para medir concordância` };
  const po = (a + d) / n;
  const pe = ((a + b) * (a + c) + (c + d) * (b + d)) / (n * n);
  const kappa = pe < 1 ? (po - pe) / (1 - pe) : NaN;
  const seK = pe < 1 ? Math.sqrt(po * (1 - po) / (n * (1 - pe) * (1 - pe))) : NaN;
  const sens = (a + b) ? a / (a + b) : NaN;      /* P(beta alto | diário OFF) */
  const espec = (c + d) ? d / (c + d) : NaN;     /* P(beta baixo | diário ON) */
  const faixa = k => !isFinite(k) ? 'não estimável' : k < 0 ? 'pior que o acaso'
    : k < 0.2 ? 'desprezível' : k < 0.4 ? 'fraca' : k < 0.6 ? 'moderada' : k < 0.8 ? 'substancial' : 'quase perfeita';
  return {
    ok: true, binMin, nPairs: pares.length, alignment: alinhamento, alignmentConfidence: confianca,
    n, table: { offHigh: a, offLow: b, onHigh: c, onLow: d },
    agreement: +(100 * po).toFixed(1), expected: +(100 * pe).toFixed(1),
    kappa: isFinite(kappa) ? +kappa.toFixed(3) : NaN,
    kappaCI: isFinite(kappa) && isFinite(seK) ? [+(kappa - 1.96 * seK).toFixed(3), +(kappa + 1.96 * seK).toFixed(3)] : null,
    sensitivity: isFinite(sens) ? +(100 * sens).toFixed(1) : NaN,
    specificity: isFinite(espec) ? +(100 * espec).toFixed(1) : NaN,
    strength: faixa(kappa), includeSleep: !!opts.includeSleep, nSleepBins: nSono, nUnpaired: nSoUm,
    verdict: !isFinite(kappa) ? 'não estimável'
      : kappa < 0.2 ? 'o limiar de beta deste registro não reproduz o estado autorreportado'
        : kappa < 0.4 ? 'concordância fraca — o beta acompanha o diário em parte, mas não substitui o relato'
          : 'o beta acompanha o estado autorreportado acima do acaso neste registro',
    caveat: 'concordância não é validação. Kappa mede o quanto duas medidas coincidem NESTE registro, com ESTE limiar; ' +
      'não estabelece ponto de corte transferível para outro paciente, outro par de contatos ou outro grupo de estimulação' +
      (confianca === 'baixa' ? '. Além disso, o alinhamento dos dias foi por ordem, não por data — se ele estiver errado, a concordância medida não significa nada' : '')
  };
}

/* ----------------------------------------------- resposta à levodopa ------ */

/* levodopaResponse(rows, doseTimes, offMin, opts) → a curva de resposta medida,
   não modelada.

   Alinha o Timeline a cada tomada, normaliza pela linha de base pré-dose e
   mede quatro coisas com definição explícita: latência, tempo até o nadir,
   magnitude da queda e duração do efeito. A significância vem de SURROGADOS
   POR DESLOCAMENTO CIRCULAR das marcas de dose — o deslocamento preserva a
   autocorrelação do beta, que é justamente o que faz um teste ingênuo achar
   efeito onde não há.

   Se o teste não separa do acaso, os marcos NÃO são reportados. Uma latência
   medida sobre uma curva que não se distingue de ruído é um número frágil.   */
export function levodopaResponse(rows, doseTimes, offMin, opts) {
  opts = opts || {};
  const preMin = opts.preMin || 60, postMin = opts.postMin || 240, binMin = opts.binMin || 10;
  const nSurr = opts.nSurrogates || 500;
  const semente0 = isFinite(opts.seed) ? (opts.seed >>> 0) : 20240517;
  const validas = (rows || []).filter(r => r && isFinite(r.t) && isFinite(r.lfp));
  const doses = (doseTimes || []).filter(isFinite).sort((a, b) => a - b);
  if (validas.length < 24) return { ok: false, reason: 'Timeline curto demais para alinhar a doses' };
  if (doses.length < 3) return { ok: false, reason: `só ${doses.length} tomada(s) marcada(s) — são necessárias ao menos 3 para uma curva média` };

  const al = eventAligned(validas, doses, preMin, postMin, binMin, true);
  if (al.nTrials < 3) return {
    ok: false,
    reason: `só ${al.nTrials} tomada(s) com cobertura suficiente de Timeline na janela de −${preMin}/+${postMin} min`
  };

  let semente = semente0;
  const prox = () => { semente = (Math.imul(semente, 1664525) + 1013904223) >>> 0; return semente / 4294967296; };

  /* IC da curva por bootstrap sobre os ensaios */
  const nBoot = opts.nBootstrap || 1000;
  const lo = new Array(al.offsets.length).fill(NaN), hi = new Array(al.offsets.length).fill(NaN);
  const amostras = Array.from({ length: al.offsets.length }, () => []);
  for (let b = 0; b < nBoot; b++) {
    const idx = Array.from({ length: al.nTrials }, () => (prox() * al.nTrials) | 0);
    for (let k = 0; k < al.offsets.length; k++) {
      const col = idx.map(i => al.trials[i].values[k]).filter(isFinite);
      if (col.length) amostras[k].push(median(col));
    }
  }
  amostras.forEach((s, k) => { if (s.length > 20) { lo[k] = +quantile(s, 0.025).toFixed(2); hi[k] = +quantile(s, 0.975).toFixed(2); } });

  /* observado: menor valor da curva mediana depois da dose */
  const iZero = al.offsets.indexOf(0) >= 0 ? al.offsets.indexOf(0) : Math.round(preMin / binMin);
  const pos = al.median.map((v, i) => i >= iZero ? v : NaN);
  const posOk = pos.filter(isFinite);
  if (!posOk.length) return { ok: false, reason: 'nenhum bin válido depois da dose' };
  const nadir = Math.min.apply(null, posOk);
  const iNadir = pos.indexOf(nadir);

  /* surrogados: desloca TODAS as marcas pelo mesmo lag circular no intervalo
     coberto pelo registro — preserva a estrutura temporal do beta */
  const t0 = validas[0].t, t1 = validas[validas.length - 1].t, span = t1 - t0;
  let piores = 0, nValidosSurr = 0;
  const minsSurr = [];
  for (let s = 0; s < nSurr; s++) {
    const lag = prox() * span;
    const desl = doses.map(t => t0 + ((t - t0 + lag) % span));
    const a2 = eventAligned(validas, desl, preMin, postMin, binMin, true);
    if (a2.nTrials < 3) continue;
    const p2 = a2.median.filter((v, i) => i >= iZero && isFinite(v));
    if (!p2.length) continue;
    nValidosSurr++;
    const m = Math.min.apply(null, p2);
    minsSurr.push(m);
    if (m <= nadir) piores++;
  }
  const p = nValidosSurr ? (piores + 1) / (nValidosSurr + 1) : NaN;
  const detectado = isFinite(p) && p < 0.05;
  /* Quanto o RITMO DIURNO sozinho já produz de queda aparente nesta janela.
     É o número que dá escala ao efeito: se deslocar as marcas ao acaso já
     rende 15% de queda, uma queda observada de 18% não diz muita coisa. */
  const quedaSurrogada = minsSurr.length ? 100 - median(minsSurr) : NaN;

  /* critério dos marcos: a dispersão da PRÓPRIA curva antes da dose diz o que
     é ruído. O limiar de resposta é 100 − 2·DP(pré) — declarado, não oculto. */
  const pre = al.median.filter((v, i) => i < iZero && isFinite(v));
  const dpPre = pre.length > 2 ? sd(pre) : NaN;
  const limiar = isFinite(dpPre) ? 100 - 2 * dpPre : NaN;

  let latencia = NaN, duracao = NaN, retorno = NaN, censurado = false;
  if (detectado && isFinite(limiar)) {
    for (let i = iZero; i < al.median.length - 1; i++) {
      if (isFinite(al.median[i]) && al.median[i] < limiar && isFinite(al.median[i + 1]) && al.median[i + 1] < limiar) { latencia = al.offsets[i]; break; }
    }
    if (isFinite(latencia)) {
      let j = iNadir;
      while (j + 1 < al.median.length && isFinite(al.median[j + 1]) && al.median[j + 1] < limiar) j++;
      if (j >= al.median.length - 1) { censurado = true; retorno = NaN; duracao = al.offsets[al.offsets.length - 1] - latencia; }
      else { retorno = al.offsets[j + 1]; duracao = retorno - latencia; }
    }
  }
  const cobertura = al.trials.map(t => t.values.filter(isFinite).length / t.values.length);

  return {
    ok: true, preMin, postMin, binMin, offsets: al.offsets,
    curve: al.median.map(v => isFinite(v) ? +v.toFixed(2) : NaN),
    q1: al.q1, q3: al.q3, ciLow: lo, ciHigh: hi, trials: al.trials,
    nDoses: doses.length, nTrials: al.nTrials,
    coverage: +(100 * mean(cobertura)).toFixed(1),
    baselinePct: 100, baselineSD: isFinite(dpPre) ? +dpPre.toFixed(2) : NaN,
    responseThresholdPct: isFinite(limiar) ? +limiar.toFixed(2) : NaN,
    nadirPct: +nadir.toFixed(2), dropPct: +(100 - nadir).toFixed(2),
    timeToNadirMin: al.offsets[iNadir],
    latencyMin: latencia, durationMin: duracao, returnMin: retorno, censored: censurado,
    detected: detectado, p: isFinite(p) ? +p.toFixed(4) : NaN,
    surrogateDropPct: isFinite(quedaSurrogada) ? +quedaSurrogada.toFixed(2) : NaN,
    nSurrogates: nValidosSurr, surrogateMethod: 'deslocamento circular das marcas de dose (preserva a autocorrelação do beta)',
    nBootstrap: nBoot, seed: semente0,
    criterion: 'latência = primeiro bin ≥ 0 min em que a curva mediana fica abaixo de 100 − 2·DP(pré-dose) por dois bins seguidos; ' +
      'duração = trecho contíguo abaixo desse limiar que contém o nadir',
    interpretation: !detectado
      ? `a queda máxima observada (${(100 - nadir).toFixed(1)}% da linha de base) não se separa do que aparece ao deslocar ` +
        `as marcas de dose ao acaso (p = ${isFinite(p) ? p.toFixed(3).replace('.', ',') : '—'}). ` +
        'Com este dado não é possível afirmar resposta do beta à levodopa — e os marcos de latência e duração não são reportados'
      : `queda de ${(100 - nadir).toFixed(1)}% da linha de base, nadir em ${al.offsets[iNadir]} min` +
        (isFinite(latencia) ? `, latência de ${latencia} min` : '') +
        (isFinite(duracao) ? `, efeito por ${duracao} min${censurado ? ' (censurado: ainda abaixo do limiar no fim da janela)' : ''}` : '') +
        ` (p = ${p < 0.001 ? '<0,001' : p.toFixed(3).replace('.', ',')} contra ${nValidosSurr} surrogados)`,
    caveat: 'o alinhamento é ao momento em que o paciente marcou o evento, não à ingestão nem à absorção. ' +
      'A latência medida aqui inclui o atraso do registro e não é a latência farmacocinética',
    /* O ponto de método que mais engana nesta figura: com horário de tomada
       rígido, "efeito da dose" e "hora do dia" são a mesma coluna do desenho. */
    confound: `deslocar as marcas ao acaso já produz, sozinho, uma queda mediana de ` +
      `${isFinite(quedaSurrogada) ? quedaSurrogada.toFixed(1) + '%' : '—'} nesta janela — é o que o ritmo diurno do beta ` +
      `explica sem nenhuma dose. A queda observada foi de ${(100 - nadir).toFixed(1)}%. ` +
      'Quando o esquema de tomadas é rígido, hora do dia e efeito da dose ocupam a mesma coluna do desenho experimental, ' +
      'e nenhum teste separa as duas: um resultado não significativo aqui quer dizer "não separável", não "sem efeito"'
  };
}
