#!/usr/bin/env node
/* ==========================================================================
   Gera um Session Report SINTÉTICO no formato do Medtronic Percept PC.
   Nenhum dado de paciente real é usado. Serve para testes automatizados,
   integração contínua e para demonstrar a aplicação sem expor dados clínicos.

       node tools/gerar_exemplo.mjs [pasta_de_saida]
   ========================================================================== */
import fs from 'fs';
import path from 'path';

const OUT = process.argv[2] || 'examples';
fs.mkdirSync(OUT, { recursive: true });

/* --- gerador pseudoaleatório determinístico (Mulberry32) ----------------- */
let _s = 20250104;
const rnd = () => { _s |= 0; _s = _s + 0x6D2B79F5 | 0;
  let t = Math.imul(_s ^ _s >>> 15, 1 | _s);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const FS = 250;
const IMPLANTE = Date.UTC(2024, 8, 12, 14, 0, 0);
const T0 = Date.UTC(2025, 0, 6, 12, 0, 0);         // referência da sessão
const OFFSET_MIN = -180;                            // UTC−03
const PICO = { Left: 17.6, Right: 15.6 };           // pico beta por hemisfério

/* --------------------------------------------------- espectro sintético -- */
function espectro(picoHz, amp, nBins = 100) {
  const df = FS / 256;
  const f = Array.from({ length: nBins }, (_, i) => +(i * df).toFixed(2));
  const p = f.map(x => {
    const aper = 3.2 / Math.pow(Math.max(x, 0.9), 0.85);       // componente 1/f
    const beta = amp * Math.exp(-((x - picoHz) ** 2) / (2 * 1.7 ** 2));
    const teta = 0.35 * amp * Math.exp(-((x - 6.5) ** 2) / (2 * 2.2 ** 2));
    return +Math.max(0.01, aper + beta + teta + 0.06 * Math.abs(gauss())).toFixed(5);
  });
  const iMax = p.reduce((b, v, i) => (f[i] > 6 && v > p[b] ? i : b), 0);
  return { f, p, peakF: f[iMax], peakV: p[iMax] };
}

/* --------------------------------------------- sinal bruto no tempo (µV) -- */
function sinalBruto(segundos, picoHz, ampBeta, comEcg = true) {
  const n = Math.round(segundos * FS);
  const x = new Float64Array(n);
  let r1 = 0, r2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    r1 = 0.985 * r1 + gauss();                                  // ruído 1/f aproximado
    r2 = 0.80 * r2 + gauss();
    /* envelope de burst: beta modulado lentamente, gerando rajadas */
    const env = Math.max(0, 0.55 + 0.9 * Math.sin(2 * Math.PI * 0.7 * t + 1.3)
      * Math.sin(2 * Math.PI * 0.17 * t));
    x[i] = 0.9 * r1 + 0.5 * r2 + ampBeta * env * Math.sin(2 * Math.PI * picoHz * t)
      + 0.35 * Math.sin(2 * Math.PI * 6.4 * t + 0.7);
    if (comEcg) {                                               // artefato QRS ~62 bpm
      const fase = (t % 0.97) - 0.02;
      if (Math.abs(fase) < 0.05) x[i] += 5.5 * Math.exp(-(fase ** 2) / (2 * 0.008 ** 2));
    }
  }
  return Array.from(x, v => +v.toFixed(4));
}

/* ------------------------------------------------------- tomadas de dose --
   O paciente sintético toma levodopa quatro vezes ao dia, com o atraso e o
   esquecimento que existem na vida real. As MESMAS marcas alimentam o Timeline
   (efeito farmacodinâmico sobre o beta) e os eventos registrados no aparelho —
   sem isso, a figura de resposta à levodopa não teria dado com que ser testada,
   e o exemplo mostraria "sem resposta demonstrável" por construção. */
const DIAS_TIMELINE = 21;
const INICIO_TIMELINE = T0 - DIAS_TIMELINE * 864e5;
const TOMADAS = (() => {
  const out = [];
  for (let d = 0; d < DIAS_TIMELINE; d++) {
    [7, 11, 15, 19].forEach(h => {
      if (rnd() < 0.06) return;                       // dose esquecida
      const hora = h + (rnd() - 0.5) * 2.6;           // atraso/adiantamento real
      out.push(INICIO_TIMELINE + d * 864e5 + (hora - OFFSET_MIN / 60) * 36e5);
    });
  }
  return out.sort((a, b) => a - b);
})();

/* Resposta do beta a uma tomada: latência de ~30 min, nadir por volta de 75 min,
   retorno à linha de base perto de 210 min (wearing-off). Fator multiplicativo. */
function efeitoDose(minutos) {
  if (minutos < 0 || minutos > 260) return 1;
  const lat = 30, dur = 190;
  if (minutos < lat) return 1 - 0.05 * (minutos / lat);
  const u = (minutos - lat) / dur;
  if (u > 1) return 1;
  return 1 - 0.30 * Math.sin(Math.PI * Math.pow(u, 0.75));
}

/* ------------------------------------------------ Timeline (LFPTrendLogs) -- */
function timeline(dias, hemi) {
  const base = hemi === 'Left' ? 42 : 37;
  const porDia = {};
  const inicio = T0 - dias * 864e5;
  let ar = 0;                              // ruído AR(1): amostras a cada 10 min são
  const PHI = 0.92;                        // fortemente correlacionadas, como no real
  for (let d = 0; d < dias; d++) {
    const chave = iso(inicio + d * 864e5 + 18 * 36e5);
    const linhas = [];
    const derivaDia = 1 + 0.06 * Math.sin(d / 6.3);             // deriva lenta entre dias
    for (let k = 0; k < 144; k++) {
      const t = inicio + d * 864e5 + k * 6e5;
      const horaLocal = ((t + OFFSET_MIN * 60000) / 36e5) % 24;
      /* ritmo circadiano: pico ~09h30, vale noturno; harmônico de 12 h leve */
      const circ = 1 + 0.17 * Math.cos(2 * Math.PI * (horaLocal - 9.5) / 24)
        + 0.05 * Math.cos(2 * Math.PI * (horaLocal - 14) / 12);
      ar = PHI * ar + Math.sqrt(1 - PHI * PHI) * gauss();
      /* farmacodinâmica: a tomada mais recente que ainda faz efeito */
      let dose = 1;
      for (let k = TOMADAS.length - 1; k >= 0; k--) {
        if (TOMADAS[k] > t) continue;
        dose = efeitoDose((t - TOMADAS[k]) / 60000);
        break;
      }
      let v = base * derivaDia * circ * dose + 2.6 * ar;
      if (rnd() < 0.004) v *= 2.6 + rnd() * 3;                   // outliers de movimento
      linhas.push({ DateTime: iso(t), LFP: Math.max(1, Math.round(v)),
        AmplitudeInMilliAmps: hemi === 'Left' ? 2.9 : 3.1 });
    }
    porDia[chave] = linhas;
  }
  return porDia;
}

/* ------------------------------------------------------ snapshots por evento */
function snapshots() {
  const eventos = [
    { id: 1, nome: 'Tomou medicação', ganho: 1.00 },
    { id: 2, nome: 'Discinesia', ganho: 0.55 },
    { id: 3, nome: 'Tempo "OFF"', ganho: 1.75 },
    { id: 4, nome: 'Caiu', ganho: 1.20 }
  ];
  const out = [];
  /* as marcas de "Tomou medicação" caem sobre as tomadas de verdade — é o que
     permite a F29 alinhar o Timeline às doses; os demais eventos são esparsos */
  const daMed = TOMADAS.filter((_, i) => i % Math.ceil(TOMADAS.length / 14) === 0);
  eventos.forEach(ev => {
    const n = ev.id === 1 ? daMed.length : 8;
    for (let k = 0; k < n; k++) {
      const t = ev.id === 1 ? daMed[k] : T0 - (rnd() * 20 + 1) * 864e5;
      const hemi = {};
      ['Right', 'Left'].forEach(h => {
        const e = espectro(PICO[h], 2.4 * ev.ganho * (0.9 + 0.2 * rnd()));
        hemi['HemisphereLocationDef.' + h] = {
          DateTime: iso(t), GroupId: 'GroupIdDef.GROUP_A',
          SenseID: 'SensingElectrodeConfigDef.ONE_AND_THREE',
          FFTBinData: e.p, Frequency: e.f
        };
      });
      out.push({ DateTime: iso(t), EventID: ev.id, EventName: ev.nome,
        LFP: true, Cycling: false, LfpFrequencySnapshotEvents: hemi });
    }
  });
  return out.sort((a, b) => new Date(a.DateTime) - new Date(b.DateTime));
}

/* ------------------------------------------------------------- impedâncias -- */
const CONTATOS = ['SenSight_0', 'SenSight_1a', 'Sensight_1b', 'Sensight_1c',
                  'SenSight_2a', 'Sensight_2b', 'Sensight_2c', 'SenSight_3'];
function impedancia(hemi) {
  const anel = c => /_(0|3)$/.test(c);
  const mono = CONTATOS.map(c => ({
    Electrode1: 'ElectrodeDef.Case', Electrode2: 'ElectrodeDef.' + c,
    ResultValue: Math.round((anel(c) ? 1500 : 4400) + 400 * gauss())
  }));
  const bip = [];
  for (let i = 0; i < CONTATOS.length; i++)
    for (let j = i + 1; j < CONTATOS.length; j++)
      bip.push({ Electrode1: 'ElectrodeDef.' + CONTATOS[i], Electrode2: 'ElectrodeDef.' + CONTATOS[j],
        ResultValue: Math.round((anel(CONTATOS[i]) && anel(CONTATOS[j]) ? 3200 : 5900) + 500 * gauss()) });
  return { Hemisphere: 'HemisphereLocationDef.' + hemi,
           SessionImpedance: { Monopolar: mono, Bipolar: bip } };
}

/* ------------------------------------------------------------ Survey (30 ch) */
const CANAIS_SURVEY = ['ZERO_AND_THREE', 'ONE_AND_THREE', 'ZERO_AND_TWO', 'ONE_AND_TWO',
  'ZERO_AND_ONE', 'TWO_AND_THREE', 'ONE_A_AND_ONE_B', 'ONE_B_AND_ONE_C', 'ONE_A_AND_ONE_C',
  'TWO_A_AND_TWO_B', 'TWO_B_AND_TWO_C', 'TWO_A_AND_TWO_C', 'ONE_A_AND_TWO_A',
  'ONE_B_AND_TWO_B', 'ONE_C_AND_TWO_C'];
function montagem() {
  const out = [];
  ['Left', 'Right'].forEach(h => CANAIS_SURVEY.forEach((c, i) => {
    /* canais que flanqueiam o alvo terapêutico têm pico maior */
    const ganho = /ONE_AND_THREE|ONE_C_AND_TWO_C|ZERO_AND_TWO/.test(c) ? 2.6 : 0.8 + rnd() * 0.9;
    const e = espectro(PICO[h] + gauss() * 0.4, ganho);
    out.push({ Hemisphere: 'HemisphereLocationDef.' + h,
      PeakFrequencyInHertz: e.peakF, PeakMagnitudeInMicroVolt: e.peakV,
      SensingElectrodes: 'SensingElectrodeConfigDef.' + c,
      ArtifactStatus: 'ArtifactStatusDef.ARTIFACT_NOT_PRESENT',
      LFPFrequency: e.f, LFPMagnitude: e.p });
  }));
  return out;
}
function montagemTempo() {
  const out = [];
  ['LEFT', 'RIGHT'].forEach(h => CANAIS_SURVEY.slice(0, 6).forEach(c => {
    const sufixo = /^(ZERO|ONE|TWO)_AND_(ONE|TWO|THREE)$/.test(c) ? '_RING' : '_SEGMENT';
    out.push({ Pass: 'FIRST_PASS', GlobalSequences: '', GlobalPacketSizes: '', TicksInMses: '',
      Channel: `${c}_${h}${sufixo}`, Gain: 228, FirstPacketDateTime: iso(T0 - 36e5),
      SampleRateInHz: FS,
      TimeDomainData: sinalBruto(20, PICO[h === 'LEFT' ? 'Left' : 'Right'], 1.6, false) });
  }));
  return out;
}

/* --------------------------------- streaming com rampa de estimulação (F7) -- */
function streaming(segundos) {
  const n = segundos * 2;                                    // 2 Hz
  const dados = [];
  for (let i = 0; i < n; i++) {
    const passo = Math.floor(i / (n / 10));                  // 10 degraus de amplitude
    const mA = +(passo * 0.3).toFixed(1);
    /* supressão beta dose-dependente + ruído */
    const base = 3400 * Math.exp(-0.42 * mA) + 320 * gauss();
    dados.push({ Seq: 2 + (i >> 3), TicksInMs: 331250 + i * 500, StatusBytes: '00 00 00 00',
      Right: { LFP: Math.max(60, Math.round(base)), mA },
      Left: { LFP: 0, mA: 0 } });
  }
  return dados;
}

/* ============================================================ montagem final */
function canalSensing(hemi, amp) {
  const e = espectro(PICO[hemi], 3.1);
  return {
    HemisphereLocation: 'HemisphereLocationDef.' + hemi,
    ProgramId: 'ProgramIdDef.FIRST_' + hemi.toUpperCase(),
    ElectrodeState: ['2a', '2b', '2c'].map(c => ({
      Electrode: 'ElectrodeDef.Sensight_' + c, ElectrodeStateResult: 'ElectrodeStateDef.Negative',
      ElectrodeAmplitudeInMilliAmps: +(amp / 3).toFixed(2), ElectrodeFractionOf64: -21
    })).concat([{ Electrode: 'ElectrodeDef.Case', ElectrodeStateResult: 'ElectrodeStateDef.Positive' }]),
    PulseWidthInMicroSecond: 60, RateInHertz: 130,
    BrainSensingStatus: 'SensingStatusDef.ENABLED',
    Channel: 'SensingElectrodeConfigDef.ONE_AND_THREE',
    UpperLfpThreshold: hemi === 'Left' ? 48 : 43,
    LowerLfpThreshold: hemi === 'Left' ? 38 : 33,
    MeasuredUpperLfp: 0, MeasuredLowerLfp: 0, SuspendAmplitudeInMilliAmps: 1.0,
    SensingSetup: {
      FrequencyInHertz: PICO[hemi], AveragingDurationInMilliSeconds: 3000,
      ChannelSignalResult: {
        Channel: `SensingChannelDef.ONE_THREE_${hemi.toUpperCase()}`,
        ArtifactStatus: 'ArtifactStatusDef.ARTIFACT_NOT_PRESENT',
        SignalFrequencies: e.f, SignalPsdValues: e.p,
        PeakFrequencies: [Math.round(e.peakF)], PeakValues: [e.peakV]
      }
    }
  };
}

const grupo = {
  GroupId: 'GroupIdDef.GROUP_A', GroupName: '', ActiveGroup: true,
  Mode: 'LimitModeDef.AdvanceView', AdjustableParameter: 'LimitTypeDef.Amplitude',
  ProgramSettings: {
    AmplitudeControl: 'AmplitudeTypeDef.CURRENT',
    LeftHemisphere: { Programs: [{ ProgramId: 'ProgramIdDef.FIRST_LEFT',
      ElectrodeState: ['1a', '1b', '1c'].map(c => ({ Electrode: 'ElectrodeDef.Sensight_' + c,
        ElectrodeStateResult: 'ElectrodeStateDef.Negative',
        ElectrodeAmplitudeInMilliAmps: 0.97, ElectrodeFractionOf64: -21 }))
        .concat([{ Electrode: 'ElectrodeDef.Case', ElectrodeStateResult: 'ElectrodeStateDef.Positive' }]),
      AmplitudeInMilliAmps: 2.9, PulseWidthInMicroSecond: 60, RateInHertz: 130 }] },
    SensingChannel: [canalSensing('Left', 2.9), canalSensing('Right', 3.1)]
  },
  GroupSettings: { SoftStartStop: { Enabled: true, DurationInSeconds: 4 },
    Cycling: { Enabled: false }, HighPassFilterInHertz: 1,
    SensingBlankingDurationInMicroseconds: 2000 }
};

const relatorio = {
  AbnormalEnd: false, FullyReadForSession: true, FeatureInformationCode: 'SINTETICO',
  SessionDate: iso(T0), SessionEndDate: iso(T0 + 42 * 60000),
  ProgrammerTimezone: 'Horário Padrão de Brasília', ProgrammerUtcOffset: '-03:00',
  ProgrammerLocale: 'pt_BR', ProgrammerVersion: '3.0.1098',
  PatientInformation: { Initial: {}, Final: {
    PatientFirstName: 'EXEMPLO', PatientLastName: 'SINTETICO',
    PatientGender: 'PatientGenderDef.MALE',
    PatientDateOfBirth: '1960-01-01T03:00:00Z', PatientId: 'DEMO-0000',
    ClinicianNotes: 'Dados inteiramente sintéticos. Não corresponde a nenhuma pessoa.',
    Diagnosis: 'DiagnosisTypeDef.ParkinsonsDisease' } },
  DeviceInformation: { Initial: {}, Final: {
    Neurostimulator: 'Percept PC', NeurostimulatorModel: 'B35200',
    NeurostimulatorSerialNumber: 'SINTETICO-0000',
    NeurostimulatorLocation: 'InsLocation.CHEST_LEFT', ImplantDate: iso(IMPLANTE),
    DeviceDateTime: iso(T0), ProductVersion: '07.05.05',
    AccumulatedTherapyOnTimeSinceImplant: 2712, AccumulatedTherapyOnTimeSinceFollowup: 640 } },
  BatteryInformation: { BatteryPercentage: 88, EstimatedBatteryLifeMonths: 41,
    TTEData: '00000000', BatteryStatus: 'DeviceStateDef.OK' },
  GroupUsagePercentage: [{ GroupId: 'GroupIdDef.GROUP_A', UsagePercentage: 100.0 }, {}, {}, {}],
  LeadConfiguration: { Initial: [], Final: ['Left', 'Right'].map((h, i) => ({
    Hemisphere: 'HemisphereLocationDef.' + h, Model: 'LeadModelDef.LEAD_B33005',
    LeadLocation: 'LeadLocationDef.Stn',
    ElectrodeNumber: i ? 'InsPort.EIGHT_FIFTEEN' : 'InsPort.ZERO_SEVEN',
    TipOffset: i ? 'TipOffsetDef.EIGHT' : 'TipOffsetDef.ZERO', OrientationInDegrees: '' })) },
  Stimulation: { InitialStimStatus: 'StimStatusDef.ON', FinalStimStatus: 'StimStatusDef.ON' },
  Groups: { Initial: [grupo], Final: [grupo] },
  BatteryReminder: { Enabled: false },
  Impedance: [{ ImpedanceStatus: 'ImpedanceStateDef.OK', TestCurrentMA: 'Automatic increase',
    Hemisphere: [impedancia('Left'), impedancia('Right')] }],
  GroupHistory: [{ SessionDate: iso(T0), Groups: [grupo, { GroupId: 'GroupIdDef.GROUP_B' },
    { GroupId: 'GroupIdDef.GROUP_C' }, { GroupId: 'GroupIdDef.GROUP_D' }] }],
  LFPMontage: montagem(),
  LfpMontageTimeDomain: montagemTempo(),
  BrainSenseTimeDomain: [{ Pass: '', GlobalSequences: '', GlobalPacketSizes: '', TicksInMses: '',
    Channel: 'ONE_THREE_RIGHT', Gain: 225, FirstPacketDateTime: iso(T0 - 20 * 60000),
    SampleRateInHz: FS, TimeDomainData: sinalBruto(120, PICO.Right, 2.2, true) }],
  BrainSenseLfp: [{ Channel: 'ONE_THREE_RIGHT', FirstPacketDateTime: iso(T0 - 20 * 60000),
    SampleRateInHz: 2,
    TherapySnapshot: { ActiveGroup: 'GroupIdDef.GROUP_A', HighPassFilterInHertz: 1,
      SensingBlankingDurationInMicroseconds: 2000,
      Right: { SensingChannel: 'SensingChannelDef.ONE_THREE_RIGHT', ElectrodeState: [],
        PulseWidthInMicroSecond: 60, RateInHertz: 130, FrequencyInHertz: PICO.Right,
        FrequencyIndex: 16, UpperLfpThreshold: 43, LowerLfpThreshold: 33,
        AveragingDurationInMilliSeconds: 3000, DetectionBlankingDurationInMilliSeconds: 2000 } },
    LfpData: streaming(300) }],
  MostRecentInSessionSignalCheck: ['Left', 'Right'].map(h => {
    const e = espectro(PICO[h], 2.9);
    return { Channel: `SensingChannelDef.ONE_THREE_${h.toUpperCase()}`,
      ArtifactStatus: 'ArtifactStatusDef.ARTIFACT_NOT_PRESENT',
      SignalFrequencies: e.f, SignalPsdValues: e.p,
      PeakFrequencies: [Math.round(e.peakF)], PeakValues: [e.peakV] };
  }),
  PatientEvents: { Initial: [], Final: [
    { EventName: 'Tomou medicação', 'Additional Behavior': 'LFP' },
    { EventName: 'Discinesia', 'Additional Behavior': 'LFP' },
    { EventName: 'Tempo "OFF"', 'Additional Behavior': 'LFP' },
    { EventName: 'Caiu' }] },
  EventSummary: { SessionStartDate: iso(T0 - 21 * 864e5), SessionEndDate: iso(T0),
    Eventos: [{ EventName: 'Tomou medicação', EventCount: TOMADAS.filter((_, i) => i % Math.ceil(TOMADAS.length / 14) === 0).length },
      { EventName: 'Discinesia', EventCount: 8 },
      { EventName: 'Tempo "OFF"', EventCount: 8 }, { EventName: 'Caiu', EventCount: 8 }],
    LfpAndAmplitudeSummary: ['Left', 'Right'].map(h => ({ GroupId: 'GroupIdDef.GROUP_A',
      Hemisphere: 'HemisphereLocationDef.' + h, LeadLocation: 'LeadLocationDef.Stn',
      AboveThresholdPercent: 22, BetweenThresholdPercent: 51, BelowThresholdPercent: 27,
      AverageAmplitude: h === 'Left' ? 2.9 : 3.1 })) },
  DiagnosticData: {
    LFPTrendLogs: { 'HemisphereLocationDef.Left': timeline(21, 'Left'),
                    'HemisphereLocationDef.Right': timeline(21, 'Right') },
    LfpFrequencySnapshotEvents: snapshots(),
    EventLogs: [
      { DateTime: iso(IMPLANTE), SessionType: 'SessionStateDef.SessionStart' },
      { DateTime: iso(T0 - 30 * 60000), SessionType: 'SessionStateDef.SessionStart' },
      { DateTime: iso(T0 - 25 * 60000), ParameterTrendId: 'ParameterTrendIdDef.LeadIntegrityPerformed' },
      { DateTime: iso(T0 - 20 * 60000), ParameterTrendId: 'ParameterTrendIdDef.TherapyStatus',
        TherapyStatus: 'TherapyChangeStatusDef.OFF' },
      { DateTime: iso(T0 - 10 * 60000), ParameterTrendId: 'ParameterTrendIdDef.TherapyStatus',
        TherapyStatus: 'TherapyChangeStatusDef.ON' },
      { DateTime: iso(T0 + 42 * 60000), SessionType: 'SessionStateDef.SessionEnd' }]
  }
};

const destino = path.join(OUT, 'exemplo_sintetico.json');
fs.writeFileSync(destino, JSON.stringify(relatorio));
const kb = (fs.statSync(destino).size / 1024).toFixed(0);
console.log(`Gerado: ${destino} (${kb} KB)`);
console.log(`  Timeline .......... 21 dias × 144 pontos × 2 hemisférios`);
console.log(`  Sinal bruto ....... 120 s a ${FS} Hz (com artefato cardíaco)`);
console.log(`  Streaming ......... 300 s a 2 Hz, rampa de 0 a 2,7 mA`);
console.log(`  Survey ............ 30 espectros + 12 séries brutas`);
console.log(`  Snapshots ......... 32 eventos em 4 categorias`);
