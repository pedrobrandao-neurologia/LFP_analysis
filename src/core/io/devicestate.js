/* io/devicestate.js — estado do dispositivo como variável de primeira classe.

   POR QUE ISTO EXISTE. Hammer et al. (Stereotact Funct Neurosurg 2022;100:168-183)
   demonstraram que habilitar a estimulação MESMO A 0 mA já introduz artefatos
   ausentes no estado OFF. Comparar espectros entre estados diferentes sem
   declarar isso é erro metodológico — e até aqui o software tratava todos os
   espectros como comparáveis.

   `device_state` passa a ser coluna obrigatória em toda linha de métrica aguda,
   e a inferência SEMPRE registra de onde veio (campo `evidence`), porque uma
   inferência sem procedência não é melhor que um palpite.

   Estados: 'OFF' | 'ON_0mA' | 'ON_THERAPEUTIC' | 'UNKNOWN'.                  */

import { num } from './parse.js';

/* Amplitude somada dos programas de um grupo, por hemisfério. */
function amplitudeDoGrupo(parsed, hemi) {
  const ativo = (parsed.groups || []).find(g => g.active) || (parsed.groups || [])[0];
  if (!ativo) return { ma: NaN, rate: NaN, pw: NaN, groupId: null };
  const progs = (ativo.programs || []).filter(p => !hemi || p.hemisphere === hemi);
  if (!progs.length) return { ma: NaN, rate: NaN, pw: NaN, groupId: ativo.id };
  const ma = progs.reduce((a, p) => a + (isFinite(p.amplitude) ? p.amplitude : 0), 0);
  return { ma, rate: progs[0].rate, pw: progs[0].pulseWidth, groupId: ativo.id };
}

/* Último TherapyStatus registrado antes de um instante. */
function statusAntesDe(parsed, tMs) {
  const logs = (parsed.eventLogs || [])
    .filter(e => /TherapyStatus/i.test(e.kind || '') && isFinite(e.t) && (!isFinite(tMs) || e.t <= tMs))
    .sort((a, b) => a.t - b.t);
  if (!logs.length) return null;
  const ultimo = logs[logs.length - 1];
  return /ON/i.test(ultimo.detail || '') ? 'ON' : /OFF/i.test(ultimo.detail || '') ? 'OFF' : null;
}

/* inferDeviceState(record, parsed, opts)
   `record` é uma série bruta (bsTimeDomain / montageTD / indefiniteStreaming) ou
   uma entrada de bsLfp. `opts.modality` ajuda quando não há outra evidência.  */
export const DOC_FONTE = 'Medtronic UC202012929cEN FY24';

/* Tabela modalidade → estado de estimulação DOCUMENTADO.

   Substitui a expressão regular que classificava `CalibrationTests` como OFF.
   `state`: 'OFF' | 'ON' | 'USER' (definido pelo usuário) | 'ANY' | null.     */
export const DOCUMENTED_STIM_STATE = [
  { match: /LFPMontage|LfpMontageTimeDomain|survey/i, structure: 'BrainSense Survey', state: 'OFF',
    quote: 'Stimulation is off during the measurement', page: 4 },
  { match: /IndefiniteStreaming|record\s*streaming/i, structure: 'Record Streaming (IndefiniteStreaming)', state: 'OFF',
    quote: 'Stimulation will be off for the duration of data collection', page: 4 },
  { match: /MostRecentInSessionSignalCheck/i, structure: 'MostRecentInSessionSignalCheck', state: 'OFF',
    quote: 'stimulation is OFF', page: 15 },
  { match: /SenseChannelTests/i, structure: 'SenseChannelTests', state: 'OFF',
    quote: 'with stim OFF (3 channels per lead)', page: 15 },
  { match: /CalibrationTests/i, structure: 'CalibrationTests', state: 'ON',
    quote: 'with stim ON (2 channels per lead)', page: 15 },
  { match: /BrainSenseTimeDomain|BrainSenseLfp/i, structure: 'BrainSense Streaming', state: 'USER',
    quote: 'stimulation is in user defined state', page: 17 },
  { match: /trend|timeline|snapshot|event/i, structure: 'Timeline / Events', state: 'ANY',
    quote: 'Either (tabela Summary of Sensing Data)', page: 10 }
];

export function documentedStimState(modality) {
  const m = String(modality || '');
  /* CalibrationTests e SenseChannelTests contêm as palavras genéricas do Survey
     em algumas grafias; a tabela é percorrida na ordem de especificidade acima,
     e as entradas específicas vêm primeiro justamente por isso */
  const esp = DOCUMENTED_STIM_STATE.filter(x => /SenseChannelTests|CalibrationTests|MostRecentInSession|Indefinite/i.test(x.match.source));
  const resto = DOCUMENTED_STIM_STATE.filter(x => esp.indexOf(x) < 0);
  for (const x of esp.concat(resto)) if (x.match.test(m)) return {
    structure: x.structure, state: x.state, quote: x.quote, page: x.page, source: DOC_FONTE
  };
  return { structure: m || '(modalidade não informada)', state: null, quote: null, page: null, source: null };
}

export function inferDeviceState(record, parsed, opts) {
  opts = opts || {};
  const evidencia = [];
  let estado = 'UNKNOWN';
  let ma = NaN, rate = NaN, pw = NaN, groupId = null;
  const hemi = record && record.hemisphere;

  /* 1. TherapySnapshot do BrainSenseLfp é a evidência mais direta */
  const ts = record && record.therapy;
  if (ts && ts.perHemi) {
    const h = ts.perHemi[hemi] || ts.perHemi.Left || ts.perHemi.Right;
    if (h) {
      rate = num(h.rate); pw = num(h.pulseWidth); groupId = ts.group || null;
      evidencia.push('TherapySnapshot do BrainSenseLfp');
    }
  }
  /* amplitude efetivamente registrada na série de estimulação */
  if (record && record.series) {
    const s = record.series[hemi] || record.series.Left || record.series.Right;
    if (s && s.ma && s.ma.length) {
      const validos = s.ma.filter(isFinite);
      const maxMa = validos.length ? Math.max(...validos) : NaN;
      if (isFinite(maxMa)) {
        ma = maxMa;
        evidencia.push(`amplitude registrada na série (máx. ${maxMa.toFixed(2)} mA)`);
        estado = maxMa > 0.05 ? 'ON_THERAPEUTIC' : 'ON_0mA';
      }
    }
  }

  /* 2. amplitude somada do grupo ativo */
  if (!isFinite(ma)) {
    const g = amplitudeDoGrupo(parsed, hemi);
    if (isFinite(g.ma)) {
      ma = g.ma; groupId = groupId || g.groupId;
      if (!isFinite(rate)) rate = g.rate;
      if (!isFinite(pw)) pw = g.pw;
      evidencia.push(`amplitude somada do grupo ativo ${g.groupId} (${g.ma.toFixed(2)} mA)`);
    }
  }

  /* 3. TherapyStatus dos EventLogs */
  const status = statusAntesDe(parsed, opts.tMs);
  if (status) {
    evidencia.push(`TherapyStatus ${status} nos EventLogs`);
    if (estado === 'UNKNOWN') {
      if (status === 'OFF') estado = 'OFF';
      else if (status === 'ON') estado = isFinite(ma) && ma > 0.05 ? 'ON_THERAPEUTIC' : 'ON_0mA';
    }
  }

  /* 4. a modalidade, pela TABELA DOCUMENTADA do fabricante.

     Isto era uma expressão regular, e ela tinha `calibration` no ramo do OFF —
     que é exatamente o oposto do documentado. `CalibrationTests` é o segundo
     passo da verificação de qualidade de sinal e roda com estimulação LIGADA;
     `SenseChannelTests` é o primeiro e roda com ela desligada. Os dois são o
     par OFF/ON do MESMO paciente na MESMA sessão, e classificá-los como dois
     OFF fazia `statesComparable` deixar de disparar exatamente onde deveria.

     Fonte de cada linha: Medtronic UC202012929cEN FY24, p. 15 (SenseChannelTests,
     CalibrationTests, MostRecentInSessionSignalCheck), p. 4 (Survey e Record
     Streaming), p. 16–17 (LfpMontageTimeDomain, IndefiniteStreaming,
     BrainSenseTimeDomain, BrainSenseLfp) e p. 10 (tabela "Summary of Sensing
     Data").                                                                  */
  if (estado === 'UNKNOWN' && opts.modality) {
    const doc = documentedStimState(opts.modality);
    if (doc.state === 'OFF') {
      estado = 'OFF';
      evidencia.push(`${doc.structure}: estimulação DESLIGADA (${doc.quote}; ${DOC_FONTE})`);
    } else if (doc.state === 'ON') {
      estado = isFinite(ma) && ma > 0.05 ? 'ON_THERAPEUTIC' : 'ON_0mA';
      evidencia.push(`${doc.structure}: estimulação LIGADA (${doc.quote}; ${DOC_FONTE})`);
    } else if (doc.state === 'USER') {
      estado = isFinite(ma) && ma > 0.05 ? 'ON_THERAPEUTIC' : 'ON_0mA';
      evidencia.push(`${doc.structure}: estimulação em estado definido pelo usuário (${doc.quote}; ${DOC_FONTE}) — ` +
        'a modalidade NÃO determina o estado, e o valor acima vem da amplitude registrada');
    }
  }
  /* consistência: se há amplitude terapêutica, não pode estar OFF */
  if (isFinite(ma) && ma > 0.05 && estado === 'OFF') {
    estado = 'ON_THERAPEUTIC';
    evidencia.push('corrigido para ON: amplitude > 0 contradiz o estado OFF');
  }

  return {
    state: estado,
    amplitudeMa: isFinite(ma) ? +ma.toFixed(3) : NaN,
    rateHz: isFinite(rate) ? rate : NaN,
    pulseWidthUs: isFinite(pw) ? pw : NaN,
    groupId,
    evidence: evidencia,
    /* a confiança deixa de ser 'fraca' quando a fonte é o próprio fabricante */
    confidence: evidencia.length === 0 ? 'nenhuma'
      : evidencia.some(e => new RegExp(DOC_FONTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(e)) ? 'documentada'
        : evidencia.some(e => /inferência fraca/.test(e)) ? 'fraca' : 'boa',
    documentedState: opts.modality ? documentedStimState(opts.modality) : null
  };
}

/* Dois espectros de estados diferentes não são diretamente comparáveis. */
export function statesComparable(a, b) {
  /* aceita tanto a string do estado quanto o objeto de inferDeviceState — os
     dois circulam no software, e exigir um deles só produziria "[object Object]"
     no meio de uma frase que existe para ser lida */
  const nome = x => (x && typeof x === 'object') ? (x.state || 'UNKNOWN') : x;
  a = nome(a); b = nome(b);
  if (!a || !b || a === 'UNKNOWN' || b === 'UNKNOWN')
    return { comparable: false, reason: 'estado do dispositivo desconhecido em pelo menos um dos registros' };
  if (a === b) return { comparable: true, reason: null };
  return {
    comparable: false,
    reason: `espectros de estados de estimulação diferentes (${a} vs ${b}) não são diretamente comparáveis — ` +
      'habilitar a estimulação mesmo a 0 mA já introduz artefato ausente no estado OFF (Hammer et al. 2022)'
  };
}
