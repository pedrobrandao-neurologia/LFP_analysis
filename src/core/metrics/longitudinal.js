/* metrics/longitudinal.js — o que muda entre sessões: impedância, uso, bateria
   e a confiabilidade das próprias métricas.

   POR QUE ISTO EXISTE. Comparar o beta de hoje com o de seis meses atrás só faz
   sentido se o que mudou for o cérebro, e não a medida. Três coisas mudam a
   medida sem que ninguém perceba:
     • IMPEDÂNCIA do contato — sobe com encapsulamento glial, muda o divisor de
       tensão e portanto a amplitude registrada. Uma queda de 30% no beta com um
       salto de impedância no mesmo contato não é achado clínico;
     • TROCA DE CONTATO DE SENSING entre sessões — muda o que se mede;
     • deriva de FIRMWARE e de escala do Timeline entre versões.
   E uma terceira pergunta, anterior a todas: a métrica é reprodutível o
   bastante para que a comparação signifique algo? É o que o ICC responde.

   Unidades: impedância em ohms; tempo de terapia em horas; bateria em %.

   Referências:
     Lempka SF, et al. J Neural Eng 2009;6:046001 (impedância e encapsulamento).
     Swinnen BEKS, et al. J Neural Eng 2025;22:014001 (checklist de reporte).  */

import { median, linreg, quantile } from '../stats/descriptive.js';
import { icc } from '../stats/icc.js';
import { daysSince } from './extract.js';

const quando = s => s ? Date.parse(s) : NaN;

/* impedanceDrift(parsedList) — por hemisfério e contato, ao longo das sessões. */
export function impedanceDrift(parsedList, opts) {
  opts = opts || {};
  const limiarPct = isFinite(opts.changePct) ? opts.changePct : 25;
  const lista = (parsedList || []).filter(p => p && p.impedance && Object.keys(p.impedance).length);
  if (lista.length < 2) return {
    ok: false, nSessions: lista.length,
    reason: `impedância presente em ${lista.length} sessão(ões) — a deriva só é observável com pelo menos 2`
  };

  const implante = lista[0].device && lista[0].device.implantDate ? lista[0].device.implantDate : null;
  const sessoes = lista.map(p => ({
    file: p.fileName,
    t: quando(p.meta && p.meta.sessionStart),
    days: implante && p.meta && p.meta.sessionStart ? daysSince(implante, p.meta.sessionStart) : NaN,
    imp: p.impedance
  })).filter(s => isFinite(s.t)).sort((a, b) => a.t - b.t);
  if (sessoes.length < 2) return { ok: false, reason: 'sessões sem data utilizável' };

  /* série por contato monopolar (Case × eletrodo), que é o mais comparável */
  const porContato = new Map();
  sessoes.forEach((s, is) => {
    Object.keys(s.imp).forEach(hemi => {
      (s.imp[hemi].mono || []).forEach(e => {
        const chave = `${hemi}|${e.a}-${e.b}`;
        if (!porContato.has(chave)) porContato.set(chave, { hemisphere: hemi, contact: `${e.a}-${e.b}`, pontos: [] });
        if (isFinite(e.ohm)) porContato.get(chave).pontos.push({ i: is, days: s.days, ohm: e.ohm, t: s.t });
      });
    });
  });

  const contatos = [];
  porContato.forEach(c => {
    if (c.pontos.length < 2) return;
    const primeiro = c.pontos[0].ohm, ultimo = c.pontos[c.pontos.length - 1].ohm;
    const varPct = primeiro > 0 ? 100 * (ultimo - primeiro) / primeiro : NaN;
    const x = c.pontos.map(p => isFinite(p.days) ? p.days : p.i);
    const y = c.pontos.map(p => p.ohm);
    const reg = c.pontos.length >= 3 ? linreg(x, y) : null;
    contatos.push({
      hemisphere: c.hemisphere, contact: c.contact, n: c.pontos.length,
      firstOhm: primeiro, lastOhm: ultimo,
      changePct: isFinite(varPct) ? +varPct.toFixed(1) : NaN,
      slopeOhmPerDay: reg && isFinite(reg.slope) ? +reg.slope.toFixed(3) : NaN,
      r2: reg && isFinite(reg.r2) ? +reg.r2.toFixed(3) : NaN,
      series: c.pontos.map(p => ({ days: p.days, ohm: p.ohm })),
      flagged: isFinite(varPct) && Math.abs(varPct) >= limiarPct
    });
  });
  if (!contatos.length) return { ok: false, reason: 'nenhum contato com impedância medida em mais de uma sessão' };

  const marcados = contatos.filter(c => c.flagged);
  const variacoes = contatos.map(c => c.changePct).filter(isFinite);
  return {
    ok: true, nSessions: sessoes.length, nContacts: contatos.length,
    changeThresholdPct: limiarPct,
    contacts: contatos.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)),
    medianChangePct: variacoes.length ? +median(variacoes).toFixed(1) : NaN,
    nFlagged: marcados.length,
    spanDays: isFinite(sessoes[0].days) && isFinite(sessoes[sessoes.length - 1].days)
      ? sessoes[sessoes.length - 1].days - sessoes[0].days : NaN,
    interpretation: marcados.length
      ? `${marcados.length} contato(s) mudaram mais de ${limiarPct}% de impedância entre a primeira e a última sessão ` +
        `(${marcados.slice(0, 4).map(c => `${c.hemisphere === 'Left' ? 'E' : c.hemisphere === 'Right' ? 'D' : c.hemisphere}:${c.contact} ${c.changePct > 0 ? '+' : ''}${c.changePct}%`).join(', ')}). ` +
        'Mudança de impedância altera o divisor de tensão e portanto a AMPLITUDE registrada: uma variação de potência ' +
        'no mesmo contato, no mesmo período, não pode ser lida como mudança neural sem considerar isto.'
      : `nenhum contato variou mais de ${limiarPct}%; a amplitude registrada é comparável entre estas sessões ` +
        'no que depende da impedância'
  };
}

/* usageAndBattery(parsedList) — uso por grupo, horas de terapia e bateria. */
export function usageAndBattery(parsedList) {
  const lista = (parsedList || []).filter(Boolean);
  if (!lista.length) return { ok: false, reason: 'nenhum arquivo' };
  const linhas = lista.map(p => ({
    file: p.fileName,
    sessionStart: p.meta && p.meta.sessionStart || null,
    batteryPct: p.device ? p.device.batteryPct : NaN,
    batteryMonths: p.device ? p.device.batteryMonths : NaN,
    therapyHoursTotal: p.device ? p.device.therapyHoursTotal : NaN,
    therapyHoursSinceFU: p.device ? p.device.therapyHoursSinceFU : NaN,
    groupUsage: (p.groupUsage || []).slice()
  })).sort((a, b) => quando(a.sessionStart) - quando(b.sessionStart));

  const comBateria = linhas.filter(l => isFinite(l.batteryPct));
  let quedaPorMes = NaN;
  if (comBateria.length >= 2) {
    const a = comBateria[0], b = comBateria[comBateria.length - 1];
    const meses = (quando(b.sessionStart) - quando(a.sessionStart)) / (1000 * 3600 * 24 * 30.44);
    if (meses > 0.5) quedaPorMes = (a.batteryPct - b.batteryPct) / meses;
  }
  const comTerapia = linhas.filter(l => isFinite(l.therapyHoursTotal));
  let horasPorDia = NaN;
  if (comTerapia.length >= 2) {
    const a = comTerapia[0], b = comTerapia[comTerapia.length - 1];
    const dias = (quando(b.sessionStart) - quando(a.sessionStart)) / (1000 * 3600 * 24);
    if (dias > 1) horasPorDia = (b.therapyHoursTotal - a.therapyHoursTotal) / dias;
  }

  return {
    ok: true, rows: linhas, nSessions: linhas.length,
    batteryDropPctPerMonth: isFinite(quedaPorMes) ? +quedaPorMes.toFixed(2) : NaN,
    therapyHoursPerDay: isFinite(horasPorDia) ? +horasPorDia.toFixed(2) : NaN,
    adherenceNote: !isFinite(horasPorDia) ? 'consumo de terapia não estimável com estas sessões'
      : horasPorDia > 26 ? `${horasPorDia.toFixed(1)} h de terapia por dia de calendário — acima de 24 h, o que indica ` +
        'contagem em mais de um canal ou período de sessão mal definido; trate como não interpretável'
        : horasPorDia < 12 ? `${horasPorDia.toFixed(1)} h de terapia por dia — o estimulador passou parte do tempo desligado`
          : `${horasPorDia.toFixed(1)} h de terapia por dia de calendário`,
    caveat: 'estes números vêm de contadores acumulados do dispositivo. Eles descrevem o APARELHO, não a adesão do ' +
      'paciente ao tratamento como um todo, e não substituem a anamnese.'
  };
}

/* longitudinalReliability(bundles, campos) — ICC das métricas entre sessões.

   `bundles`: um por SUJEITO, cada um com `acute` (linhas por sessão × hemisfério).
   A matriz é sujeitos × sessões, uma por métrica.                            */
export function longitudinalReliability(bundles, opts) {
  opts = opts || {};
  const campos = opts.fields || [
    { key: 'beta_peak_hz', label: 'frequência do pico beta (Hz)' },
    { key: 'aperiodic_exponent', label: 'expoente aperiódico' },
    { key: 'burst_rate_hz', label: 'taxa de bursts (/s)' },
    { key: 'burst_mean_ms', label: 'duração média de burst (ms)' }
  ];
  const hemi = opts.hemisphere || 'Left';
  const lista = (bundles || []).filter(b => b && b.acute && b.acute.length);
  if (lista.length < 3) return {
    ok: false, nSubjects: lista.length,
    reason: `confiabilidade entre sessões exige ao menos 3 sujeitos; há ${lista.length}. ` +
      'Com um sujeito só é possível descrever a variação entre sessões, não estimar o ICC — ' +
      'porque não existe variância ENTRE sujeitos para comparar com o ruído de medida.'
  };

  const resultados = campos.map(c => {
    const matriz = lista.map(b => {
      const linhas = b.acute.filter(r => r.hemisphere === hemi && isFinite(r[c.key]))
        .sort((x, y) => String(x.session_date_local || '').localeCompare(String(y.session_date_local || '')));
      return linhas.map(r => r[c.key]);
    });
    const k = Math.min.apply(null, matriz.map(l => l.length));
    if (!(k >= 2)) return { field: c.key, label: c.label, ok: false, reason: 'nem todos os sujeitos têm 2+ sessões com esta métrica' };
    const cortada = matriz.map(l => l.slice(0, k));
    const r = icc(cortada, {});
    return Object.assign({ field: c.key, label: c.label }, r || { ok: false, reason: 'ICC não calculável' });
  });

  return {
    ok: true, hemisphere: hemi, nSubjects: lista.length,
    fields: resultados,
    note: 'ICC(2,1) é o pertinente para test-retest: ele penaliza diferença sistemática entre sessões, que é ' +
      'exatamente o que uma mudança de calibração ou de contato produz.'
  };
}
