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
  ['bsTimeDomain',  'BrainSense Streaming — sinal bruto'],
  ['bsLfp',         'BrainSense Streaming — potência + estimulação'],
  ['trend',         'BrainSense Timeline (LFPTrendLogs)'],
  ['snapshots',     'Snapshots por evento (LfpFrequencySnapshotEvents)'],
  ['patientEvents', 'Eventos do paciente / EventSummary'],
  ['impedance',     'Impedâncias'],
  ['eventLogs',     'Log de eventos da sessão'],
  ['annotations',   'Anotações / histórico de programação']
];

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
      abnormalEnd: !!d.AbnormalEnd
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
    impedance: {}, montage: [], montageTD: [], bsTimeDomain: [], bsLfp: [],
    trend: {}, snapshots: [], patientEvents: [], eventSummary: null,
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
    const grp = {
      id: tail(g.GroupId), active: !!g.ActiveGroup, name: g.GroupName || '',
      programs: [], sensing: [],
      settings: g.GroupSettings || {}
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
  const td = (arr, dst) => (isArr(arr) ? arr : []).forEach(r => {
    if (!isArr(r.TimeDomainData) || !r.TimeDomainData.length) return;
    const fs = num(r.SampleRateInHz) || 250;
    /* campos de sequência: até aqui eram ignorados, e sem eles a perda de
       pacotes passa silenciosamente (ver io/packets.js) */
    const packetSizes = parseIntList(r.GlobalPacketSizes);
    const ticksMs = parseIntList(r.TicksInMses);
    const sequences = parseIntList(r.GlobalSequences);
    const bruto = Float64Array.from(r.TimeDomainData, num);
    const packets = analyzePackets({ data: bruto, fs, packetSizes, ticksMs, sequences });
    const preenchido = packets.nMissing
      ? insertNaNGaps(bruto, packets.gaps)
      : { data: bruto, missingMask: new Uint8Array(bruto.length) };
    const timing = effectiveFs({ ticksMs, nSamples: packets.nExpected, nominalFs: fs, packetSizes });
    dst.push({
      pass: r.Pass || '', channel: tail(r.Channel), label: prettyChannel(tail(r.Channel)),
      hemisphere: /LEFT|_L$/i.test(String(r.Channel)) ? 'Left' : (/RIGHT|_R$/i.test(String(r.Channel)) ? 'Right' : '?'),
      fs, gain: num(r.Gain),
      /* fs efetiva medida pelos ticks; cai para a nominal quando não verificável */
      fsEff: isFinite(timing.fsEff) ? timing.fsEff : fs,
      t0: r.FirstPacketDateTime || null,
      data: preenchido.data, missingMask: preenchido.missingMask,
      packets, timing
    });
  });
  td(d.LfpMontageTimeDomain, out.montageTD);
  td(d.BrainSenseTimeDomain, out.bsTimeDomain);
  td(d.SenseChannelTests, out.senseChannelTests = []);
  td(d.CalibrationTests, out.calibrationTests = []);

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

  /* --- Timeline (LFPTrendLogs) ----------------------------------------- */
  const dd = d.DiagnosticData || {};
  if (dd.LFPTrendLogs && typeof dd.LFPTrendLogs === 'object') {
    Object.keys(dd.LFPTrendLogs).forEach(hk => {
      const hemi = tail(hk);
      const byDay = dd.LFPTrendLogs[hk] || {};
      const seen = new Set(); const rows = [];
      Object.keys(byDay).forEach(day => {
        (byDay[day] || []).forEach(r => {
          const t = T(r.DateTime);
          if (!isFinite(t) || seen.has(t)) return;
          seen.add(t);
          rows.push({ t, lfp: num(r.LFP), ma: num(r.AmplitudeInMilliAmps) });
        });
      });
      rows.sort((a, b) => a.t - b.t);
      if (rows.length) out.trend[hemi] = rows;
    });
  }

  /* --- snapshots por evento -------------------------------------------- */
  if (isArr(dd.LfpFrequencySnapshotEvents)) out.snapshots = dd.LfpFrequencySnapshotEvents.map(ev => {
    const per = {};
    const sub = ev.LfpFrequencySnapshotEvents || {};
    Object.keys(sub).forEach(hk => {
      const h = sub[hk];
      if (h && isArr(h.FFTBinData)) per[tail(hk)] = {
        f: (h.Frequency || []).map(num), p: h.FFTBinData.map(num),
        groupId: tail(h.GroupId), senseId: tail(h.SenseID)
      };
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
