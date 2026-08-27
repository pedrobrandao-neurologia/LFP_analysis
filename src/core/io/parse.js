/* io/parse.js — parsing do JSON e pseudonimização (io)
   Gerado do refactor modular (Prompt 0.1). Ver docs/arquitetura.md.
   Integridade do sinal bruto (perda de pacotes, NaN, fs efetiva) em ./packets.js. */

import { parseIntList, analyzePackets, insertNaNGaps, effectiveFs } from './packets.js';

export const tail = s => (typeof s === 'string' && s.includes('.')) ? s.split('.').pop() : s;

export const num  = v => (typeof v === 'number' && isFinite(v)) ? v : NaN;

export const isArr = Array.isArray;

export function parseUtcOffsetMin(str) {           // "-02:00" -> -120
  if (!str) return null;
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(String(str).trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

export const T = s => { const d = new Date(s); return isFinite(d.getTime()) ? d.getTime() : NaN; };

/* Hora decimal local (0–24) a partir de epoch ms e offset em minutos */

export function localHour(ms, offMin) {
  const d = new Date(ms + offMin * 60000);
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}

export function localDayKey(ms, offMin) {
  return new Date(ms + offMin * 60000).toISOString().slice(0, 10);
}

/* ======================================================================== */
/*  1. PARSER                                                                */
/* ======================================================================== */

export const MODALITIES = [
  ['sensingSetup',  'Signal Test (PSD do canal de sensing)'],
  ['signalCheck',   'MostRecentInSessionSignalCheck'],
  ['montage',       'BrainSense Survey — espectros (LFPMontage)'],
  ['montageTD',     'BrainSense Survey — sinal bruto (LfpMontageTimeDomain)'],
  ['indefiniteStreaming', 'Record Streaming — sinal bruto sem estimulação (IndefiniteStreaming)'],
  ['electrodeIdentifier', 'Electrode Identifier — gravação referenciada ao outro hemisfério'],
  ['bsTimeDomain',  'BrainSense Streaming — sinal bruto'],
  ['bsLfp',         'BrainSense Streaming — potência + estimulação'],
  ['thresholdRuns',  'Captura de limiares — domínio de potência (Thresholds)'],
  ['trend',         'BrainSense Timeline (LFPTrendLogs)'],
  ['snapshots',     'Snapshots por evento (LfpFrequencySnapshotEvents)'],
  ['patientEvents', 'Eventos do paciente / EventSummary'],
  ['impedance',     'Impedâncias'],
  ['eventLogs',     'Log de eventos da sessão'],
  ['annotations',   'Anotações / histórico de programação']
];

/* Variante que recebe o TEXTO do arquivo e faz o JSON.parse aqui dentro.

   Existe para o trabalhador de segundo plano (Web Worker): enviar uma string
   para o worker custa uma cópia barata, enquanto enviar o objeto já parseado
   custa uma clonagem estruturada de milhões de nós. Com esta função, tanto o
   JSON.parse quanto a extração saem da thread principal. */
export function parsePerceptText(texto, nomeArquivo) {
  try {
    return parsePercept(JSON.parse(texto), nomeArquivo);
  } catch (e) {
    /* JSON inválido: antes de recusar, tenta SALVAR o prefixo íntegro. Uma
       exportação interrompida no tablet perde o fim do arquivo, e o resto —
       que costuma ser quase tudo — continua sendo dado bom. Ver salvageJson. */
    const s = salvageJson(texto);
    if (!s.ok) throw e;
    const out = parsePercept(s.value, nomeArquivo);
    out.truncated = s.report;
    out.meta.truncated = s.report;
    return out;
  }
}

/* ------------------------------------------------------------------------ */
/*  Salvamento de JSON truncado                                             */
/* ------------------------------------------------------------------------ */

/* salvageJson(texto) — recupera o maior prefixo VÁLIDO de um JSON cortado.

   POR QUE EXISTE. Um Session Report interrompido (transferência cortada,
   exportação abortada no tablet) termina no meio de um número e o
   `JSON.parse` recusa o arquivo inteiro. Mas um arquivo de 1,8 MB cortado no
   último registro ainda contém dezenas de gravações completas: recusar tudo
   por causa do fim é jogar fora dado bom.

   A REGRA QUE TORNA ISSO HONESTO, e não um remendo: só sobrevive o que foi
   ESCRITO POR INTEIRO. O registro que estava sendo escrito no instante do
   corte é DESCARTADO, mesmo que já tivesse milhares de amostras — meia
   gravação com metade das amostras parece uma gravação curta legítima, e
   entraria em toda análise como se fosse. Preferimos perder o registro
   incompleto a deixá-lo passar disfarçado de completo.

   Implementação: uma varredura registra, para cada contêiner aberto, a posição
   logo após o último FILHO COMPLETO. O corte acontece no array que contém o
   objeto incompleto (regra `[` seguido de `{` mais profunda), descartando esse
   objeto; sem esse padrão, corta no contêiner mais profundo com filho
   completo. Depois fecha os contêineres restantes.

   Devolve {ok, value, text, report}. `report` traz a contabilidade que a
   interface precisa mostrar: bytes perdidos, percentual e o que foi
   descartado.                                                              */
export function salvageJson(texto) {
  const txt = typeof texto === 'string' ? texto : String(texto == null ? '' : texto);
  const falha = motivo => ({ ok: false, reason: motivo });
  if (txt.trim().charAt(0) !== '{' && txt.trim().charAt(0) !== '[') return falha('não começa como objeto ou lista JSON');

  const pilha = [];             /* {ch, safe, esperaChave} */
  let emString = false, escape = false, numIni = -1;
  const fecharValor = fim => {
    const topo = pilha[pilha.length - 1];
    if (!topo) return;
    /* numa string de OBJETO, só um valor move o ponto seguro — a chave não */
    if (topo.ch === '{' && topo.esperaChave) return;
    topo.safe = fim;
    if (topo.ch === '{') topo.esperaChave = true;
  };
  const fimDoNumero = (ini, fim) => { let j = fim; while (j > ini && !/[0-9]/.test(txt[j - 1])) j--; return j; };

  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (escape) { escape = false; continue; }
    if (emString) {
      if (c === '\\') escape = true;
      else if (c === '"') { emString = false; fecharValor(i + 1); }
      continue;
    }
    if (numIni >= 0 && !/[0-9eE+\-.]/.test(c)) { fecharValor(fimDoNumero(numIni, i)); numIni = -1; }
    if (c === '"') { emString = true; continue; }
    if (c === ':') { const t = pilha[pilha.length - 1]; if (t && t.ch === '{') t.esperaChave = false; continue; }
    if (c === '{' || c === '[') { pilha.push({ ch: c, safe: -1, esperaChave: c === '{' }); continue; }
    if (c === '}' || c === ']') { pilha.pop(); fecharValor(i + 1); continue; }
    if (/[-0-9]/.test(c) && numIni < 0) { numIni = i; continue; }
    if (c === 't' || c === 'f' || c === 'n') {
      const m = /^(true|false|null)/.exec(txt.slice(i, i + 5));
      if (m) { i += m[1].length - 1; fecharValor(i + 1); }
    }
  }
  if (!pilha.length) return falha('o JSON está fechado — o erro não é de truncamento');

  /* onde cortar: o array que segura o objeto incompleto */
  let k = -1;
  for (let i = pilha.length - 2; i >= 0; i--) {
    if (pilha[i].ch === '[' && pilha[i + 1].ch === '{') { k = i; break; }
  }
  if (k < 0) { k = pilha.length - 1; while (k >= 0 && pilha[k].safe < 0) k--; }
  if (k < 0 || pilha[k].safe < 0) return falha('nenhum elemento completo antes do corte');

  const corte = pilha[k].safe;
  const fechos = pilha.slice(0, k + 1).map(p => (p.ch === '{' ? '}' : ']')).reverse().join('');
  const recuperado = txt.slice(0, corte) + fechos;
  let value;
  try { value = JSON.parse(recuperado); }
  catch (e) { return falha('o prefixo recuperado ainda não é JSON válido: ' + e.message); }

  const perdidos = txt.length - corte;
  const registroDescartado = pilha.length > k + 1 && pilha[k + 1].ch === '{';
  return {
    ok: true, value, text: recuperado,
    report: {
      salvaged: true,
      bytesTotal: txt.length, bytesKept: corte, bytesLost: perdidos,
      pctLost: +(100 * perdidos / txt.length).toFixed(3),
      depthAtCut: pilha.length,
      droppedIncompleteRecord: registroDescartado,
      topLevelKeys: value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : null,
      reason: 'o arquivo termina no meio de um valor — a exportação foi interrompida',
      rule: 'só sobreviveu o que foi escrito por inteiro' +
        (registroDescartado ? '; o registro que estava sendo gravado no instante do corte foi DESCARTADO' : ''),
      advice: 'reexporte o Session Report no programador para obter o arquivo completo; ' +
        'o que está aqui é o prefixo íntegro e pode ser analisado, com a perda declarada em toda exportação'
    }
  };
}

/* Cadeia de filtros de hardware do Percept, DOCUMENTADA.

   "All recorded data is sampled at 250Hz. The data is passed through several
    filters. This includes 2 low pass filters at 100Hz, and two high pass
    filters. One high pass filter at 1Hz, and a second high pass filter at a
    user configurable 1Hz or 10Hz."  — Medtronic UC202012929cEN FY24, p. 11.

   AS DUAS CONSEQUÊNCIAS QUE MUDAM LEITURA, e não são detalhe de documentação:

   1. DOIS passa-baixas em 100 Hz atenuam JÁ DENTRO da banda de gama de
      60–90 Hz, de forma crescente com a frequência, e derrubam tudo acima de
      100 Hz. Toda figura que lê gama — gama endógena vs entrained, o ODR, o
      espectrograma acima de 90 Hz — está lendo sinal atenuado por projeto.
   2. O segundo passa-alta é CONFIGURÁVEL em 1 ou 10 Hz. Com 10 Hz, teta e
      delta são eliminados: o termo teta do ODR e a leitura de banda lenta da
      distonia passam a medir o joelho do filtro, não o cérebro. Isso é alarme,
      não nota de rodapé — ver qc/alarm.js.                                   */
export const HARDWARE_FILTERS = {
  source: 'Medtronic UC202012929cEN FY24, p. 11',
  sampleRateHz: 250,
  lowPass: { n: 2, cutoffHz: 100 },
  highPassFixed: { n: 1, cutoffHz: 1 },
  highPassConfigurable: { n: 1, options: [1, 10], where: 'Advanced Settings do BrainSense Setup; ' +
    'valor efetivo em Groups → GroupSettings → highpassfilter' },
  gammaCaveat: 'os dois passa-baixas em 100 Hz atenuam dentro da banda de gama de 60–90 Hz, de forma crescente com ' +
    'a frequência — potência de gama medida aqui é subestimada por projeto do aparelho, e a comparação entre ' +
    'frequências dentro da banda é enviesada',
  highPass10Caveat: 'com o passa-alta configurável em 10 Hz, delta e teta são eliminados pelo hardware: qualquer ' +
    'métrica dessas bandas mede o joelho do filtro, não atividade neural'
};

/* Descrição textual da cadeia, com o valor efetivo quando ele é conhecido. */
export function hardwareFilterDescription(highpassHz) {
  const hp = isFinite(highpassHz) ? highpassHz : null;
  return 'passa-baixa 2× 100 Hz; passa-alta 1 Hz fixo' +
    (hp == null
      ? '; segundo passa-alta configurável em 1 ou 10 Hz — valor não declarado neste arquivo'
      : `; segundo passa-alta em ${hp} Hz (declarado em GroupSettings)`) +
    ` [${HARDWARE_FILTERS.source}]`;
}

/* D2 — limiares de impedância DO FABRICANTE, e o que a ausência de um canal
   no Survey significa.

   "Sense channels with potential shorts (<250 ohms for 1x4 leads, <350 ohms for
    SenSight Leads) or opens (>10 Kohms) are excluded."
   "Screening for artifacts (cardiac, motion) is performed. Sense channels with
    potential artifacts are excluded. The artifact screening can be turned off."
   — Medtronic UC202012929cEN FY24, p. 4.

   Duas consequências. (1) Os limiares de alarme do software eram 500 Ω, número
   de referência de leitura e não critério do aparelho. (2) Um par AUSENTE do
   Survey pode ter sido excluído pelo próprio dispositivo — por impedância ou
   por artefato — e não estar sem sinal. As duas leituras são opostas.        */
export const IMPEDANCE_LIMITS = {
  source: 'Medtronic UC202012929cEN FY24, p. 4',
  shortOhms: { '1x4': 250, sensight: 350 },
  openOhms: 10000,
  usualRange: [500, 2000],
  usualRangeNote: 'faixa habitual de leitura, NÃO é critério do dispositivo — os critérios são os de curto e aberto acima',
  exclusionNote: 'o dispositivo EXCLUI do Survey os canais com suspeita de curto, de aberto ou de artefato (cardíaco ' +
    'ou de movimento). Um par ausente do arquivo pode ter sido excluído por qualquer um desses motivos, e não por ' +
    'não ter sinal. A triagem de artefato pode ser desligada nas Advanced Settings'
};

/* Limiar de curto para o modelo de eletrodo declarado. */
export function shortThresholdOhms(leadModel) {
  return /B330\d\d|sensight/i.test(String(leadModel || '')) ? IMPEDANCE_LIMITS.shortOhms.sensight : IMPEDANCE_LIMITS.shortOhms['1x4'];
}

export function parsePercept(json, fileName) {
  const d = json || {};
  const offMin = parseUtcOffsetMin(d.ProgrammerUtcOffset);
  const piRaw = (d.PatientInformation && (d.PatientInformation.Final || d.PatientInformation.Initial)) || {};
  const diRaw = (d.DeviceInformation && (d.DeviceInformation.Final || d.DeviceInformation.Initial)) || {};

  const out = {
    fileName: fileName || '(sem nome)',
    meta: {
      sessionStart: d.SessionDate || null,
      sessionEnd: d.SessionEndDate || null,
      tz: d.ProgrammerTimezone || null,
      utcOffsetMin: offMin,
      locale: d.ProgrammerLocale || null,
      programmerVersion: d.ProgrammerVersion || null,
      abnormalEnd: !!d.AbnormalEnd,
      /* B5 — a ausência de uma modalidade pode ser da LEITURA, não do registro.

         "This field indicates if that background loading was completed during
          the session (marked 'true') or if the data was not fully read during
          the session (marked 'false'). If false, some structures may be MISSING
          from the JSON file."  — Medtronic UC202012929cEN FY24, p. 18.

         Com `false`, dizer "sem dados" é afirmação sem base: a modalidade pode
         existir no aparelho e não estar neste arquivo. É a mesma distinção entre
         ausência de achado e ausência de verificação que o software sustenta em
         toda parte — e que estava sendo violada por omissão de um campo. */
      fullyRead: d.FullyReadForSession == null ? null : !!d.FullyReadForSession,
      fullyReadNote: d.FullyReadForSession === false
        ? 'a leitura do dispositivo NÃO foi concluída nesta sessão (FullyReadForSession = false): estruturas podem ' +
          'estar faltando no arquivo. Uma modalidade ausente aqui pode existir no aparelho e não ter sido lida — ' +
          'não conclua ausência de registro a partir deste arquivo (UC202012929cEN FY24, p. 18)'
        : d.FullyReadForSession === true
          ? 'a leitura do dispositivo foi concluída nesta sessão: uma modalidade ausente é de fato ausente do aparelho ' +
            'até onde este arquivo permite afirmar'
          : 'o arquivo não declara FullyReadForSession — não é possível saber se a leitura do dispositivo foi concluída'
    },
    patient: {
      idHash: hashId(piRaw.PatientId, piRaw.PatientDateOfBirth),
      sex: tail(piRaw.PatientGender),
      dob: piRaw.PatientDateOfBirth || null,
      diagnosis: tail(piRaw.Diagnosis),
      notes: piRaw.ClinicianNotes || ''
    },
    device: {
      model: diRaw.Neurostimulator || null,
      modelNumber: diRaw.NeurostimulatorModel || null,
      snHash: hashId(diRaw.NeurostimulatorSerialNumber, ''),
      location: tail(diRaw.NeurostimulatorLocation),
      implantDate: diRaw.ImplantDate || null,
      firmware: diRaw.ProductVersion || null,
      therapyHoursTotal: num(diRaw.AccumulatedTherapyOnTimeSinceImplant),
      therapyHoursSinceFU: num(diRaw.AccumulatedTherapyOnTimeSinceFollowup),
      batteryPct: d.BatteryInformation ? num(d.BatteryInformation.BatteryPercentage) : NaN,
      batteryMonths: d.BatteryInformation ? num(d.BatteryInformation.EstimatedBatteryLifeMonths) : NaN
    },
    leads: [], groups: [], sensingSetup: [], signalCheck: [],
    impedance: {}, montage: [], montageTD: [], bsTimeDomain: [], bsLfp: [], indefiniteStreaming: [], thresholdRuns: [],
    trend: {}, trendCensoring: {}, snapshots: [], patientEvents: [], eventSummary: null,
    eventLogs: [], annotations: [], groupUsage: []
  };

  /* --- eletrodos ------------------------------------------------------- */
  const lc = d.LeadConfiguration && (d.LeadConfiguration.Final || d.LeadConfiguration.Initial);
  if (isArr(lc)) out.leads = lc.map(l => ({
    hemisphere: tail(l.Hemisphere), model: tail(l.Model),
    target: tail(l.LeadLocation), port: tail(l.ElectrodeNumber)
  }));

  /* --- grupos e sensing ------------------------------------------------ */
  const groupsFinal = (d.Groups && (d.Groups.Final || d.Groups.Initial)) || [];
  (isArr(groupsFinal) ? groupsFinal : []).forEach(g => {
    const ps = g.ProgramSettings || {};
    /* B1/B4 — o passa-alta e o blanking ESTÃO no JSON, em GroupSettings.

       "GroupSettings – contains group level stimulation and sensing parameters.
        SoftStart, Cycling, highpassfilter, sense blanking duration."
       — Medtronic UC202012929cEN FY24, p. 26.

       O software escrevia "passa-alta do dispositivo (não exposta no JSON)" em
       três lugares — EDF, BIDS e o PERCEPT-REPORT — enquanto guardava o objeto
       inteiro em `settings` sem nunca extrair o campo.                        */
    const gs = g.GroupSettings || {};
    const achaCampo = (obj, re) => {
      for (const k of Object.keys(obj || {})) if (re.test(k)) return obj[k];
      return undefined;
    };
    const grp = {
      id: tail(g.GroupId), active: !!g.ActiveGroup, name: g.GroupName || '',
      programs: [], sensing: [],
      /* o nome do campo varia de capitalização entre versões do programador */
      highpassFilterHz: num(achaCampo(gs, /^high\s*pass\s*filter/i)),
      senseBlankingUs: num(achaCampo(gs, /blank/i)),
      settings: gs
    };
    ['LeftHemisphere', 'RightHemisphere'].forEach(hk => {
      const h = ps[hk]; if (!h || !isArr(h.Programs)) return;
      h.Programs.forEach(p => grp.programs.push({
        hemisphere: hk.replace('Hemisphere', ''),
        amplitude: num(p.AmplitudeInMilliAmps),
        pulseWidth: num(p.PulseWidthInMicroSecond),
        rate: num(p.RateInHertz),
        contacts: (p.ElectrodeState || []).filter(e => tail(e.ElectrodeStateResult) === 'Negative')
          .map(e => tail(e.Electrode).replace(/^Sen[Ss]ight_/, '')),
        anode: (p.ElectrodeState || []).filter(e => tail(e.ElectrodeStateResult) === 'Positive')
          .map(e => tail(e.Electrode))
      }));
    });
    (ps.SensingChannel || []).forEach(sc => {
      const ss = sc.SensingSetup || {};
      const cr = ss.ChannelSignalResult || null;
      const rec = {
        hemisphere: tail(sc.HemisphereLocation),
        channel: tail(sc.Channel),
        centerFreq: num(ss.FrequencyInHertz),
        averagingMs: num(ss.AveragingDurationInMilliSeconds),
        lowerThr: num(sc.LowerLfpThreshold), upperThr: num(sc.UpperLfpThreshold),
        measuredLower: num(sc.MeasuredLowerLfp), measuredUpper: num(sc.MeasuredUpperLfp),
        suspendMa: num(sc.SuspendAmplitudeInMilliAmps),
        rate: num(sc.RateInHertz), pulseWidth: num(sc.PulseWidthInMicroSecond),
        status: tail(sc.BrainSensingStatus),
        amplitude: (sc.ElectrodeState || []).reduce((a, e) => a + (num(e.ElectrodeAmplitudeInMilliAmps) || 0), 0),
        psd: null, groupId: grp.id
      };
      if (cr && isArr(cr.SignalFrequencies)) rec.psd = {
        f: cr.SignalFrequencies.map(num), p: (cr.SignalPsdValues || []).map(num),
        peakF: (cr.PeakFrequencies || [])[0], peakV: (cr.PeakValues || [])[0],
        artifact: tail(cr.ArtifactStatus), channel: tail(cr.Channel)
      };
      grp.sensing.push(rec);
      if (rec.psd) out.sensingSetup.push(rec);
    });
    out.groups.push(grp);
  });
  if (isArr(d.GroupUsagePercentage))
    out.groupUsage = d.GroupUsagePercentage.filter(x => x && x.GroupId)
      .map(x => ({ id: tail(x.GroupId), pct: num(x.UsagePercentage) }));

  /* --- signal check ---------------------------------------------------- */
  if (isArr(d.MostRecentInSessionSignalCheck))
    out.signalCheck = d.MostRecentInSessionSignalCheck.filter(x => isArr(x.SignalFrequencies)).map(x => ({
      channel: tail(x.Channel), artifact: tail(x.ArtifactStatus),
      f: x.SignalFrequencies.map(num), p: (x.SignalPsdValues || []).map(num),
      peakF: (x.PeakFrequencies || [])[0], peakV: (x.PeakValues || [])[0]
    }));

  /* --- impedância ------------------------------------------------------ */
  const imp = isArr(d.Impedance) ? d.Impedance[0] : null;
  if (imp && isArr(imp.Hemisphere)) {
    out.impedanceStatus = tail(imp.ImpedanceStatus);
    imp.Hemisphere.forEach(h => {
      const key = tail(h.Hemisphere);
      const si = h.SessionImpedance || {};
      out.impedance[key] = {
        mono: (si.Monopolar || []).map(e => ({
          a: normElec(e.Electrode1), b: normElec(e.Electrode2), ohm: num(e.ResultValue)
        })),
        bipolar: (si.Bipolar || []).map(e => ({
          a: normElec(e.Electrode1), b: normElec(e.Electrode2), ohm: num(e.ResultValue)
        }))
      };
    });
  }

  /* --- survey: espectros ----------------------------------------------- */
  if (isArr(d.LFPMontage)) out.montage = d.LFPMontage.map(m => ({
    hemisphere: tail(m.Hemisphere),
    electrodes: tail(m.SensingElectrodes),
    label: prettyChannel(tail(m.SensingElectrodes)),
    peakF: num(m.PeakFrequencyInHertz), peakMag: num(m.PeakMagnitudeInMicroVolt),
    artifact: tail(m.ArtifactStatus),
    f: (m.LFPFrequency || []).map(num), mag: (m.LFPMagnitude || []).map(num)
  })).filter(m => m.f.length);

  /* --- séries no domínio do tempo -------------------------------------- */
  /* Apelidos de campo do DataVersion 1.3. O bloco novo de Survey grava
     `TimeDomainDatainMicroVolts` e `TicksInMs`, enquanto SenseChannelTests e
     CalibrationTests, NO MESMO ARQUIVO, seguem com `TimeDomainData` e
     `TicksInMses`. Ler só os nomes antigos faz um Survey inteiro sumir sem
     erro nenhum — a modalidade aparece como ausente, que é o pior modo de
     falhar. Aceitar os dois nomes é o conserto. */
  const amostrasDe = r => (isArr(r.TimeDomainData) ? r.TimeDomainData
    : isArr(r.TimeDomainDatainMicroVolts) ? r.TimeDomainDatainMicroVolts : null);
  const ticksDe = r => (r.TicksInMses !== undefined ? r.TicksInMses : r.TicksInMs);

  const td = (arr, dst, streamName, extra) => (isArr(arr) ? arr : []).forEach(r => {
    const amostras = amostrasDe(r);
    if (!amostras || !amostras.length) return;
    const fs = num(r.SampleRateInHz) || 250;
    /* campos de sequência: até aqui eram ignorados, e sem eles a perda de
       pacotes passa silenciosamente (ver io/packets.js) */
    const packetSizes = parseIntList(r.GlobalPacketSizes);
    const ticksMs = parseIntList(ticksDe(r));
    const sequences = parseIntList(r.GlobalSequences);
    const bruto = Float64Array.from(amostras, num);
    /* `stream` e `deviceModel` decidem se as sequências são utilizáveis e com
       que cap — ver io/packets.js e docs/auditoria-whitepaper.md (A2, A3) */
    const packets = analyzePackets({
      data: bruto, fs, packetSizes, ticksMs, sequences,
      stream: streamName,
      deviceModel: [(out.device && out.device.model) || '', (out.device && out.device.modelNumber) || ''].join(' ')
    });
    const preenchido = packets.nMissing
      ? insertNaNGaps(bruto, packets.gaps)
      : { data: bruto, missingMask: new Uint8Array(bruto.length) };
    const timing = effectiveFs({ ticksMs, nSamples: packets.nExpected, nominalFs: fs, packetSizes });
    dst.push(Object.assign({
      pass: r.Pass || '', channel: tail(r.Channel), label: prettyChannel(tail(r.Channel)),
      /* o bloco novo de Survey traz `Hemisphere` explícito; o antigo só deixa
         o lado no nome do canal */
      hemisphere: r.Hemisphere ? tail(r.Hemisphere)
        : (/LEFT|_L$/i.test(String(r.Channel)) ? 'Left' : (/RIGHT|_R$/i.test(String(r.Channel)) ? 'Right' : '?')),
      fs, gain: num(r.Gain),
      /* fs efetiva medida pelos ticks; cai para a nominal quando não verificável */
      fsEff: isFinite(timing.fsEff) ? timing.fsEff : fs,
      t0: r.FirstPacketDateTime || null,
      data: preenchido.data, missingMask: preenchido.missingMask,
      packets, timing
    }, extra ? extra(r) : null));
  });
  td(d.LfpMontageTimeDomain, out.montageTD, 'LfpMontageTimeDomain');
  td(d.BrainSenseTimeDomain, out.bsTimeDomain, 'BrainSenseTimeDomain');
  td(d.SenseChannelTests, out.senseChannelTests = [], 'SenseChannelTests');
  td(d.CalibrationTests, out.calibrationTests = [], 'CalibrationTests');
  /* C1 — Record Streaming: 3 canais por lead, estimulação DESLIGADA, registro
     longo. É o único modo que dá minutos de sinal sem estimulação e com três
     canais simultâneos por hemisfério (UC202012929cEN FY24, p. 16 e 23). */
  td(d.IndefiniteStreaming, out.indefiniteStreaming = [], 'IndefiniteStreaming');

  /* --- BrainSenseSurveysTimeDomain (DataVersion 1.3) --------------------
     O Survey deixou de ser uma lista plana e passou a ser uma lista de grupos
     por MODO. Dois modos aparecem:

       ElectrodeSurvey     — a varredura bipolar de sempre, que alimenta as
                             mesmas figuras do LfpMontageTimeDomain.
       ElectrodeIdentifier — gravação REFERENCIADA a um eletrodo do outro
                             hemisfério (ReferenceHemisphere/ReferenceElectrode
                             e TipOffset). NÃO é um par bipolar comum, e por
                             isso entra numa lista própria em vez de se
                             misturar ao Survey: tratar o canal referenciado
                             como bipolar produziria amplitude e topografia
                             sem sentido.

     Canais listados com zero amostras existem no arquivo (o modo foi
     configurado) mas não trazem sinal — são contados e declarados em vez de
     sumirem em silêncio.                                                   */
  out.electrodeIdentifier = [];
  out.surveyModes = [];
  if (isArr(d.BrainSenseSurveysTimeDomain)) d.BrainSenseSurveysTimeDomain.forEach(g => {
    if (!g || typeof g !== 'object') return;
    const modo = tail(g.SurveyMode) || '';
    const lista = isArr(g.ElectrodeSurvey) ? g.ElectrodeSurvey
      : isArr(g.ElectrodeIdentifier) ? g.ElectrodeIdentifier
        : (isArr(g.Records) ? g.Records : []);
    const comDados = lista.filter(r => { const a = amostrasDe(r); return a && a.length; }).length;
    out.surveyModes.push({ mode: modo || '(sem modo declarado)', nChannels: lista.length, nWithData: comDados });
    if (/ElectrodeIdentifier/i.test(modo)) {
      td(lista, out.electrodeIdentifier, 'BrainSenseSurveysTimeDomain', r => ({
        surveyMode: modo,
        referenceHemisphere: tail(r.ReferenceHemisphere) || null,
        referenceElectrode: tail(r.ReferenceElectrode) || null,
        tipOffset: num(r.TipOffset),
        referenced: true
      }));
    } else {
      td(lista, out.montageTD, 'BrainSenseSurveysTimeDomain', r => ({ surveyMode: modo || 'ElectrodeSurvey' }));
    }
  });

  /* --- streaming de potência ------------------------------------------- */
  if (isArr(d.BrainSenseLfp)) out.bsLfp = d.BrainSenseLfp.map(r => {
    const rows = isArr(r.LfpData) ? r.LfpData : [];
    const t0 = T(r.FirstPacketDateTime);
    const tick0 = rows.length ? num(rows[0].TicksInMs) : 0;
    const series = {};
    ['Left', 'Right'].forEach(h => {
      const has = rows.some(x => x[h] && isFinite(x[h].LFP) && (x[h].LFP !== 0 || x[h].mA !== 0));
      if (!has) return;
      series[h] = {
        t: rows.map(x => (num(x.TicksInMs) - tick0) / 1000),
        lfp: rows.map(x => num(x[h] && x[h].LFP)),
        ma: rows.map(x => num(x[h] && x[h].mA))
      };
    });
    const ts = r.TherapySnapshot || {};
    /* fs efetiva também na série de potência (2 Hz nominais), a partir dos ticks
       de cada amostra — relevante para alinhamento com dado externo */
    const fsBs = num(r.SampleRateInHz) || 2;
    const timing = effectiveFs({
      ticksMs: rows.map(x => num(x.TicksInMs)).filter(isFinite),
      nSamples: rows.length, nominalFs: fsBs
    });
    return {
      channel: tail(r.Channel), fs: fsBs, t0,
      fsEff: isFinite(timing.fsEff) ? timing.fsEff : fsBs, timing,
      startISO: r.FirstPacketDateTime, series,
      therapy: {
        group: tail(ts.ActiveGroup), hpf: num(ts.HighPassFilterInHertz),
        blanking: num(ts.SensingBlankingDurationInMicroseconds),
        perHemi: ['Left', 'Right'].reduce((acc, h) => {
          if (ts[h]) acc[h] = {
            channel: tail(ts[h].SensingChannel), centerFreq: num(ts[h].FrequencyInHertz),
            lowerThr: num(ts[h].LowerLfpThreshold), upperThr: num(ts[h].UpperLfpThreshold),
            rate: num(ts[h].RateInHertz), pulseWidth: num(ts[h].PulseWidthInMicroSecond),
            averagingMs: num(ts[h].AveragingDurationInMilliSeconds)
          };
          return acc;
        }, {})
      }
    };
  });

  /* --- C2: Thresholds (domínio de POTÊNCIA) ----------------------------

     "Thresholds — This section contains the power domain data used to compute
      any sensing thresholds set in this session."
     — Medtronic UC202012929cEN FY24, p. 16 e 21.

     O software lia os VALORES de limiar dos SensingChannel e ignorava a série
     que os originou. Ela documenta COMO cada limiar foi capturado, e o
     procedimento está descrito na p. 6: amplitude BAIXA de estimulação para
     capturar o limiar SUPERIOR (sinal maior), amplitude ALTA para o INFERIOR
     (sinal menor). Sem essa série, um limiar aparece como número solto.      */
  if (isArr(d.Thresholds)) out.thresholdRuns = d.Thresholds.map((r, i) => {
    const fs = num(r.SampleRateInHz) || 2;
    const per = {};
    ['Left', 'Right'].forEach(h => {
      const bloco = r['LFPData' + h] || (r.LFPData && r.LFPData[h]) || null;
      const arr = isArr(bloco) ? bloco : (bloco && isArr(bloco.LFP) ? bloco.LFP : null);
      if (!arr || !arr.length) return;
      let nCens = 0;
      const v = arr.map(x => {
        const y = num(typeof x === 'object' && x !== null ? (x.LFP != null ? x.LFP : x.Value) : x);
        if (isFinite(y) && y < 0) { nCens++; return NaN; }
        return y;
      });
      per[h] = { lfp: v, n: v.length, nCensored: nCens, fs, durationS: +(v.length / fs).toFixed(2) };
    });
    return {
      index: i,
      hemisphere: tail(r.Hemisphere) || (Object.keys(per)[0] || null),
      fs, byHemisphere: per,
      firstPacketISO: r.FirstPacketDateTime || null,
      t: r.FirstPacketDateTime ? T(r.FirstPacketDateTime) : NaN,
      unit: 'soma do quadrado da magnitude na banda (≈ AUC)',
      procedure: 'amplitude de estimulação BAIXA para capturar o limiar superior (sinal maior) e ALTA para o ' +
        'inferior (sinal menor) — Medtronic UC202012929cEN FY24, p. 6',
      source: 'Thresholds (UC202012929cEN FY24, p. 16 e 21)'
    };
  }).filter(x => Object.keys(x.byHemisphere).length);

  /* --- Timeline (LFPTrendLogs) -----------------------------------------

     DADO CENSURADO É NEGATIVO, E NÃO É POTÊNCIA.

     "Data may be censored to avoid artifacts, censored data is negative."
     — Medtronic, UC202012929cEN FY24, p. 24 (LfpTrendLogs) e p. 25
       (LfpFrequencySnapshotEvents).

     O aparelho marca com sinal negativo as amostras que ele próprio decidiu não
     entregar por suspeita de artefato. Lidas como número, elas puxam mediana,
     cosinor, limiares de aDBS e tudo o mais para baixo — e o fazem de forma
     convincente, porque a série continua parecendo contínua.

     Censura NÃO é perda de pacote, e por isso a contabilidade é SEPARADA: uma é
     decisão do aparelho sobre a qualidade do sinal, a outra é falha de
     telemetria. Somá-las esconderia justamente o que distingue as duas.

     A leitura tipográfica do documento é ambígua quanto a a frase governar só
     `AmplitudeInMilliAmps` ou todo o bloco. A decisão aqui — tratar negativo
     como censura nos DOIS campos — se sustenta sem depender dessa leitura: a
     potência do Timeline é definida como SOMA DE QUADRADOS (p. 21, 24) e a
     amplitude é uma corrente entregue; nenhuma das duas pode ser negativa por
     construção. Ver docs/auditoria-whitepaper.md.                            */
  const dd = d.DiagnosticData || {};
  if (dd.LFPTrendLogs && typeof dd.LFPTrendLogs === 'object') {
    Object.keys(dd.LFPTrendLogs).forEach(hk => {
      const hemi = tail(hk);
      const byDay = dd.LFPTrendLogs[hk] || {};
      const seen = new Set(); const rows = [];
      let nCensLfp = 0, nCensMa = 0;
      Object.keys(byDay).forEach(day => {
        (byDay[day] || []).forEach(r => {
          const t = T(r.DateTime);
          if (!isFinite(t) || seen.has(t)) return;
          seen.add(t);
          let lfp = num(r.LFP), ma = num(r.AmplitudeInMilliAmps);
          const cLfp = isFinite(lfp) && lfp < 0;
          const cMa = isFinite(ma) && ma < 0;
          if (cLfp) { nCensLfp++; lfp = NaN; }
          if (cMa) { nCensMa++; ma = NaN; }
          rows.push({ t, lfp, ma, censored: (cLfp || cMa) ? 1 : 0 });
        });
      });
      rows.sort((a, b) => a.t - b.t);
      if (rows.length) {
        out.trend[hemi] = rows;
        out.trendCensoring[hemi] = {
          n: rows.length,
          nCensoredLfp: nCensLfp, nCensoredMa: nCensMa,
          nCensored: rows.reduce((a, x) => a + x.censored, 0),
          pctCensoredLfp: +(100 * nCensLfp / rows.length).toFixed(3),
          pctCensoredMa: +(100 * nCensMa / rows.length).toFixed(3),
          rule: 'valor negativo = amostra censurada pelo aparelho para evitar artefato ' +
            '(UC202012929cEN FY24, p. 24); vira NaN e é contada aqui, nunca somada à perda de pacote'
        };
      }
    });
  }

  /* --- snapshots por evento -------------------------------------------- */
  if (isArr(dd.LfpFrequencySnapshotEvents)) out.snapshots = dd.LfpFrequencySnapshotEvents.map(ev => {
    const per = {};
    const sub = ev.LfpFrequencySnapshotEvents || {};
    Object.keys(sub).forEach(hk => {
      const h = sub[hk];
      if (h && isArr(h.FFTBinData)) {
        /* mesmo critério do Timeline: negativo é censura, não magnitude
           (UC202012929cEN FY24, p. 25) */
        let nCens = 0;
        const pot = h.FFTBinData.map(v => {
          const x = num(v);
          if (isFinite(x) && x < 0) { nCens++; return NaN; }
          return x;
        });
        per[tail(hk)] = {
          f: (h.Frequency || []).map(num), p: pot,
          nCensored: nCens,
          pctCensored: pot.length ? +(100 * nCens / pot.length).toFixed(3) : 0,
          groupId: tail(h.GroupId), senseId: tail(h.SenseID)
        };
      }
    });
    return { t: T(ev.DateTime), iso: ev.DateTime, eventId: ev.EventID, name: ev.EventName, hemi: per };
  }).filter(s => Object.keys(s.hemi).length);

  /* --- eventos e logs --------------------------------------------------- */
  const pe = d.PatientEvents && (d.PatientEvents.Final || d.PatientEvents.Initial);
  if (isArr(pe)) out.patientEvents = pe.map(x => ({ name: x.EventName, lfp: x['Additional Behavior'] === 'LFP' }));
  if (d.EventSummary) out.eventSummary = {
    start: d.EventSummary.SessionStartDate, end: d.EventSummary.SessionEndDate,
    counts: (d.EventSummary.Eventos || d.EventSummary.Events || []).map(x => ({ name: x.EventName, n: num(x.EventCount) })),
    lfpAmp: (d.EventSummary.LfpAndAmplitudeSummary || []).map(x => ({
      group: tail(x.GroupId), hemisphere: tail(x.Hemisphere),
      above: num(x.AboveThresholdPercent), between: num(x.BetweenThresholdPercent),
      below: num(x.BelowThresholdPercent), avgMa: num(x.AverageAmplitude)
    }))
  };
  if (isArr(dd.EventLogs)) out.eventLogs = dd.EventLogs.map(e => ({
    t: T(e.DateTime), iso: e.DateTime,
    kind: tail(e.SessionType) || tail(e.ParameterTrendId) || 'Evento',
    detail: [e.TherapyStatus, e.NewGroupId, e.OldGroupId].filter(Boolean).map(tail).join(' ← ')
  })).sort((a, b) => a.t - b.t);
  if (isArr(d.Annotations)) out.annotations = d.Annotations.map(a => ({
    t: T(a.Date), hemisphere: tail(a.Hemisphere), rate: num(a.RateInHertz),
    programs: (a.Program || []).length
  }));

  /* filtros efetivos: do grupo ATIVO, com precedência declarada */
  {
    const gAtivo = (out.groups || []).find(g => g.active) || (out.groups || [])[0] || null;
    const hp = gAtivo && isFinite(gAtivo.highpassFilterHz) ? gAtivo.highpassFilterHz : NaN;
    const blkGrupo = gAtivo && isFinite(gAtivo.senseBlankingUs) ? gAtivo.senseBlankingUs : NaN;
    const blkSnap = (out.bsLfp || []).map(b => b.therapy && b.therapy.blanking).filter(isFinite)[0];
    out.filters = {
      sampleRateHz: 250,
      highPassConfigurableHz: isFinite(hp) ? hp : NaN,
      highPassSource: isFinite(hp) ? 'Groups → GroupSettings → highpassfilter' : null,
      lowPassHz: 100, nLowPass: 2, highPassFixedHz: 1,
      /* precedência: GroupSettings é do grupo e vale para o registro crônico;
         o TherapySnapshot é da amostra de streaming e pode ser mais específico */
      senseBlankingUs: isFinite(blkGrupo) ? blkGrupo : (isFinite(blkSnap) ? blkSnap : NaN),
      senseBlankingSource: isFinite(blkGrupo) ? 'Groups → GroupSettings (grupo ativo)'
        : (isFinite(blkSnap) ? 'BrainSenseLfp → TherapySnapshot (amostra de streaming)' : null),
      description: hardwareFilterDescription(hp),
      lowBandUsable: !(isFinite(hp) && hp >= 10),
      spec: HARDWARE_FILTERS
    };
  }

  /* --- inventário ------------------------------------------------------- */
  out.availability = {};
  MODALITIES.forEach(([k]) => {
    const v = out[k];
    out.availability[k] = isArr(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 0);
  });
  return out;
}

export function hashId(a, b) {                       // pseudonimização determinística leve
  const s = String(a || '') + '|' + String(b || '');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return 'sub-' + ('00000000' + h.toString(16)).slice(-8);
}

export function normElec(e) {
  const t = String(tail(e) || '').replace(/^Sen[Ss]ight_?/i, '');
  return t === 'Case' ? 'Case' : t;
}

export const CH_MAP = { ZERO: '0', ONE: '1', TWO: '2', THREE: '3' };

export function prettyChannel(c) {
  if (!c) return '';
  let s = String(c).replace(/_(LEFT|RIGHT)(_RING|_SEGMENT)?$/i, '').replace(/_(LEFT|RIGHT)$/i, '');
  s = s.replace(/_AND_/g, '-').replace(/_/g, '');
  s = s.replace(/ZERO/g, '0').replace(/ONE/g, '1').replace(/TWO/g, '2').replace(/THREE/g, '3');
  s = s.replace(/([0-3])([ABC])/g, (m, a, b) => a + b.toLowerCase());
  return s;
}

/* ======================================================================== */
/*  2. DSP                                                                   */
/* ======================================================================== */
