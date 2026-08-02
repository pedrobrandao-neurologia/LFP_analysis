/* ==========================================================================
   PERCEPT LFP STUDIO — núcleo de parsing, processamento de sinal e estatística
   Sem dependências externas. Funciona em browser e em Node.
   ========================================================================== */
(function (root) {
'use strict';

/* ---------------------------------------------------------------- helpers */
const tail = s => (typeof s === 'string' && s.includes('.')) ? s.split('.').pop() : s;
const num  = v => (typeof v === 'number' && isFinite(v)) ? v : NaN;
const isArr = Array.isArray;

function parseUtcOffsetMin(str) {           // "-02:00" -> -120
  if (!str) return null;
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(String(str).trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}
const T = s => { const d = new Date(s); return isFinite(d.getTime()) ? d.getTime() : NaN; };

/* Hora decimal local (0–24) a partir de epoch ms e offset em minutos */
function localHour(ms, offMin) {
  const d = new Date(ms + offMin * 60000);
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}
function localDayKey(ms, offMin) {
  return new Date(ms + offMin * 60000).toISOString().slice(0, 10);
}

/* ======================================================================== */
/*  1. PARSER                                                                */
/* ======================================================================== */

const MODALITIES = [
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

function parsePercept(json, fileName) {
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
    dst.push({
      pass: r.Pass || '', channel: tail(r.Channel), label: prettyChannel(tail(r.Channel)),
      hemisphere: /LEFT|_L$/i.test(String(r.Channel)) ? 'Left' : (/RIGHT|_R$/i.test(String(r.Channel)) ? 'Right' : '?'),
      fs: num(r.SampleRateInHz) || 250, gain: num(r.Gain),
      t0: r.FirstPacketDateTime || null,
      data: Float64Array.from(r.TimeDomainData, num)
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
    return {
      channel: tail(r.Channel), fs: num(r.SampleRateInHz) || 2, t0,
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

function hashId(a, b) {                       // pseudonimização determinística leve
  const s = String(a || '') + '|' + String(b || '');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return 'sub-' + ('00000000' + h.toString(16)).slice(-8);
}
function normElec(e) {
  const t = String(tail(e) || '').replace(/^Sen[Ss]ight_?/i, '');
  return t === 'Case' ? 'Case' : t;
}
const CH_MAP = { ZERO: '0', ONE: '1', TWO: '2', THREE: '3' };
function prettyChannel(c) {
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

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

/* FFT radix-2 in-place (Cooley–Tukey) */
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function hann(n) { const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)); return w; }
function detrendLinear(x) {
  const n = x.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += x[i]; sxx += i * i; sxy += i * x[i]; }
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a = (sy - b * sx) / n;
  const o = new Float64Array(n); for (let i = 0; i < n; i++) o[i] = x[i] - (a + b * i);
  return o;
}

/* PSD de Welch — retorna densidade em unidade²/Hz */
function welchPSD(x, fs, opts) {
  opts = opts || {};
  const nper = opts.nperseg || Math.min(nextPow2(Math.floor(fs)), nextPow2(x.length));
  const nfft = nextPow2(nper);
  const overlap = opts.overlap == null ? 0.5 : opts.overlap;
  const step = Math.max(1, Math.floor(nper * (1 - overlap)));
  const w = hann(nper);
  let U = 0; for (let i = 0; i < nper; i++) U += w[i] * w[i];
  U *= fs;
  const nBins = nfft / 2 + 1;
  const acc = new Float64Array(nBins);
  let segs = 0;
  for (let s = 0; s + nper <= x.length; s += step) {
    const seg = detrendLinear(x.subarray ? x.subarray(s, s + nper) : x.slice(s, s + nper));
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    for (let i = 0; i < nper; i++) re[i] = seg[i] * w[i];
    fft(re, im, false);
    for (let k = 0; k < nBins; k++) {
      const mag = (re[k] * re[k] + im[k] * im[k]) / U;
      acc[k] += (k === 0 || k === nBins - 1) ? mag : 2 * mag;
    }
    segs++;
  }
  if (!segs) return { f: [], p: [], segments: 0 };
  const f = new Float64Array(nBins), p = new Float64Array(nBins);
  for (let k = 0; k < nBins; k++) { f[k] = k * fs / nfft; p[k] = acc[k] / segs; }
  return { f, p, segments: segs, nperseg: nper, df: fs / nfft };
}

/* Espectrograma (STFT) */
function spectrogram(x, fs, opts) {
  opts = opts || {};
  const win = opts.window || nextPow2(fs);            // ~1 s
  const hop = opts.hop || Math.floor(win / 4);
  const fmax = opts.fmax || 100;
  const w = hann(win);
  let U = 0; for (let i = 0; i < win; i++) U += w[i] * w[i]; U *= fs;
  const nBins = win / 2 + 1;
  const kMax = Math.min(nBins - 1, Math.floor(fmax * win / fs));
  const cols = [], times = [];
  for (let s = 0; s + win <= x.length; s += hop) {
    const seg = detrendLinear(x.subarray ? x.subarray(s, s + win) : x.slice(s, s + win));
    const re = new Float64Array(win), im = new Float64Array(win);
    for (let i = 0; i < win; i++) re[i] = seg[i] * w[i];
    fft(re, im, false);
    const col = new Float64Array(kMax + 1);
    for (let k = 0; k <= kMax; k++) col[k] = 2 * (re[k] * re[k] + im[k] * im[k]) / U;
    cols.push(col); times.push((s + win / 2) / fs);
  }
  const f = new Float64Array(kMax + 1);
  for (let k = 0; k <= kMax; k++) f[k] = k * fs / win;
  return { t: times, f, S: cols };
}

/* Filtro passa-banda de fase zero via FFT */
function bandpassFFT(x, fs, lo, hi) {
  const n = nextPow2(x.length);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < x.length; i++) re[i] = x[i];
  fft(re, im, false);
  const df = fs / n;
  for (let k = 0; k <= n / 2; k++) {
    const f = k * df;
    if (f < lo || f > hi) {
      re[k] = im[k] = 0;
      if (k > 0 && k < n / 2) { re[n - k] = im[n - k] = 0; }
    }
  }
  fft(re, im, true);
  return re.slice(0, x.length);
}

/* Envelope de Hilbert */
function hilbertEnvelope(x) {
  const n = nextPow2(x.length);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < x.length; i++) re[i] = x[i];
  fft(re, im, false);
  for (let k = 1; k < n / 2; k++) { re[k] *= 2; im[k] *= 2; }
  for (let k = n / 2 + 1; k < n; k++) { re[k] = 0; im[k] = 0; }
  fft(re, im, true);
  const env = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) env[i] = Math.hypot(re[i], im[i]);
  return env;
}

/* Detecção de bursts sobre o envelope */
function detectBursts(env, fs, opts) {
  opts = opts || {};
  const pct = opts.percentile == null ? 75 : opts.percentile;
  const minMs = opts.minDurationMs == null ? 100 : opts.minDurationMs;
  const thr = (opts.threshold != null && isFinite(opts.threshold)) ? opts.threshold : quantile(Array.from(env), pct / 100);
  const minN = Math.round(minMs * fs / 1000);
  const bursts = []; let i = 0;
  while (i < env.length) {
    if (env[i] > thr) {
      const s = i; let peak = env[i];
      while (i < env.length && env[i] > thr) { if (env[i] > peak) peak = env[i]; i++; }
      const n = i - s;
      if (n >= minN) {
        let sum = 0; for (let k = s; k < i; k++) sum += env[k];
        bursts.push({ start: s / fs, end: i / fs, durationMs: n * 1000 / fs, peak, mean: sum / n });
      }
    } else i++;
  }
  const total = env.length / fs;
  return {
    threshold: thr, bursts,
    n: bursts.length,
    rate: bursts.length / total,
    meanDurationMs: mean(bursts.map(b => b.durationMs)),
    medianDurationMs: median(bursts.map(b => b.durationMs)),
    meanAmplitude: mean(bursts.map(b => b.mean)),
    probability: bursts.reduce((a, b) => a + (b.end - b.start), 0) / total,
    durationHistogram: burstHistogram(bursts)
  };
}
function burstHistogram(bursts) {
  const edges = [200, 350, 500, 650, 800, Infinity];
  const labels = ['<200', '200–350', '350–500', '500–650', '650–800', '>800'];
  const counts = new Array(labels.length).fill(0);
  bursts.forEach(b => {
    for (let i = 0; i < edges.length; i++) if (b.durationMs < edges[i]) { counts[i]++; break; }
  });
  const tot = counts.reduce((a, b) => a + b, 0) || 1;
  return { labels, counts, pct: counts.map(c => 100 * c / tot) };
}

/* Parametrização espectral (aproximação de specparam/FOOOF) */
function fitAperiodic(f, p, opts) {
  opts = opts || {};
  const fmin = opts.fmin || 2, fmax = opts.fmax || 95;
  const idx = [];
  for (let i = 0; i < f.length; i++)
    if (f[i] >= fmin && f[i] <= fmax && p[i] > 0 && isFinite(p[i])) idx.push(i);
  if (idx.length < 8) return null;
  let lx = idx.map(i => Math.log10(f[i])), ly = idx.map(i => Math.log10(p[i]));
  let keep = idx.map(() => true);
  let a = 0, b = 0;
  for (let it = 0; it < 6; it++) {                    // ajuste robusto iterativo
    const X = [], Y = [];
    for (let i = 0; i < lx.length; i++) if (keep[i]) { X.push(lx[i]); Y.push(ly[i]); }
    const r = linreg(X, Y); a = r.intercept; b = r.slope;
    const res = lx.map((v, i) => ly[i] - (a + b * v));
    const kept = res.filter((_, i) => keep[i]);
    const sd = Math.sqrt(variance(kept)) || 1e-9;
    let changed = false;
    for (let i = 0; i < res.length; i++) {
      const k = res[i] < 1.0 * sd;                    // remove picos (resíduo positivo)
      if (k !== keep[i]) changed = true;
      keep[i] = k;
    }
    if (!changed) break;
  }
  const model = idx.map((i, k) => Math.pow(10, a + b * lx[k]));
  const resid = idx.map((i, k) => p[i] - model[k]);
  const peaks = findPeaks(idx.map(i => f[i]), resid, opts.minPeakHeight || 0);
  const ss = idx.map((i, k) => Math.pow(ly[k] - (a + b * lx[k]), 2)).reduce((x, y) => x + y, 0);
  const st = variance(ly) * ly.length;
  return {
    offset: a, exponent: -b, r2: 1 - ss / (st || 1),
    f: idx.map(i => f[i]), observed: idx.map(i => p[i]), aperiodic: model, periodic: resid, peaks
  };
}
function findPeaks(f, y, minH) {
  const out = [];
  for (let i = 1; i < y.length - 1; i++) {
    if (y[i] > y[i - 1] && y[i] >= y[i + 1] && y[i] > minH) {
      let l = i; while (l > 0 && y[l] > y[i] / 2) l--;
      let r = i; while (r < y.length - 1 && y[r] > y[i] / 2) r++;
      out.push({ cf: f[i], power: y[i], bw: f[r] - f[l], band: bandOf(f[i]) });
    }
  }
  return out.sort((a, b) => b.power - a.power).slice(0, 6);
}

/* Remoção de artefato cardíaco por subtração de template (QRS) */
function ecgTemplateSubtract(x, fs) {
  const bp = bandpassFFT(x, fs, 5, 30);
  const env = hilbertEnvelope(bp);
  const thr = quantile(Array.from(env), 0.98);
  const refractory = Math.round(0.4 * fs);
  const peaks = [];
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i] > thr && env[i] >= env[i - 1] && env[i] > env[i + 1]) {
      if (!peaks.length || i - peaks[peaks.length - 1] > refractory) peaks.push(i);
    }
  }
  const half = Math.round(0.25 * fs);
  const usable = peaks.filter(p => p - half >= 0 && p + half < x.length);
  if (usable.length < 8) return { cleaned: Float64Array.from(x), nBeats: usable.length, bpm: NaN, applied: false };
  const tpl = new Float64Array(2 * half + 1);
  usable.forEach(p => { for (let k = -half; k <= half; k++) tpl[k + half] += x[p + k]; });
  for (let k = 0; k < tpl.length; k++) tpl[k] /= usable.length;
  const m = mean(Array.from(tpl)); for (let k = 0; k < tpl.length; k++) tpl[k] -= m;
  const out = Float64Array.from(x);
  usable.forEach(p => { for (let k = -half; k <= half; k++) out[p + k] -= tpl[k + half]; });
  const rr = []; for (let i = 1; i < usable.length; i++) rr.push((usable[i] - usable[i - 1]) / fs);
  return { cleaned: out, nBeats: usable.length, bpm: 60 / (median(rr) || NaN), template: tpl, peaks: usable, applied: true };
}

const BANDS = [
  { key: 'delta', label: 'δ', lo: 1, hi: 4, color: '#3B3F73' },
  { key: 'theta', label: 'θ', lo: 4, hi: 8, color: '#2F6E8E' },
  { key: 'alpha', label: 'α', lo: 8, hi: 13, color: '#2E8B7A' },
  { key: 'lowbeta', label: 'β↓', lo: 13, hi: 20, color: '#B8912A' },
  { key: 'highbeta', label: 'β↑', lo: 20, hi: 35, color: '#C4652B' },
  { key: 'gamma', label: 'γ', lo: 35, hi: 100, color: '#8E3B4E' }
];
function bandOf(f) { const b = BANDS.find(b => f >= b.lo && f < b.hi); return b ? b.key : '—'; }
function bandPower(f, p, lo, hi) {
  let s = 0, n = 0;
  for (let i = 0; i < f.length; i++) if (f[i] >= lo && f[i] <= hi) { s += p[i]; n++; }
  return n ? s * (f[1] - f[0]) : NaN;
}
function bandTable(f, p) {
  const tot = bandPower(f, p, 1, 100);
  return BANDS.map(b => {
    const abs = bandPower(f, p, b.lo, b.hi);
    let peakF = NaN, peakV = -Infinity;
    for (let i = 0; i < f.length; i++) if (f[i] >= b.lo && f[i] <= b.hi && p[i] > peakV) { peakV = p[i]; peakF = f[i]; }
    return { ...b, absolute: abs, relative: 100 * abs / tot, peakF, peakV };
  });
}

/* ======================================================================== */
/*  3. ESTATÍSTICA                                                           */
/* ======================================================================== */

const sum = a => a.reduce((x, y) => x + y, 0);
const mean = a => a.length ? sum(a) / a.length : NaN;
function variance(a) { if (a.length < 2) return NaN; const m = mean(a); return sum(a.map(v => (v - m) * (v - m))) / (a.length - 1); }
const sd = a => Math.sqrt(variance(a));
function median(a) { return quantile(a, 0.5); }
function quantile(a, q) {
  if (!a.length) return NaN;
  const s = Array.from(a).filter(isFinite).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const h = (s.length - 1) * q, lo = Math.floor(h), hi = Math.ceil(h);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}
function mad(a) { const m = median(a); return 1.4826 * median(a.map(v => Math.abs(v - m))); }
function removeOutliersMAD(rows, key, k) {
  k = k || 4;
  const vals = rows.map(r => r[key]).filter(isFinite);
  const m = median(vals), s = mad(vals) || 1e-9;
  const kept = rows.filter(r => isFinite(r[key]) && Math.abs(r[key] - m) <= k * s);
  return { kept, removed: rows.length - kept.length, median: m, mad: s, lo: m - k * s, hi: m + k * s };
}
function linreg(x, y) {
  const n = x.length; if (n < 2) return { slope: NaN, intercept: NaN, r2: NaN };
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  const b = sxy / sxx;
  return { slope: b, intercept: my - b * mx, r2: (sxy * sxy) / (sxx * syy), n };
}
function pearson(x, y) { const r = linreg(x, y); return Math.sign(r.slope) * Math.sqrt(Math.max(0, r.r2)); }

/* --- distribuições ----------------------------------------------------- */
function logGamma(z) {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1; let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function betacf(a, b, x) {
  const MAXIT = 200, EPS = 3e-12, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d; let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function ibeta(a, b, x) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}
function fPValue(F, d1, d2) {
  if (!isFinite(F) || F <= 0) return 1;
  return 1 - ibeta(d1 / 2, d2 / 2, d1 * F / (d1 * F + d2));
}
function tPValue(t, df) {
  const x = df / (df + t * t);
  return ibeta(df / 2, 0.5, x);
}
function normCDF(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  return s * (1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
}

/* --- COSINOR ----------------------------------------------------------- */
/* y ~ M + Σ [ β_k cos(2πt/τ_k) + γ_k sin(2πt/τ_k) ]                        */
function cosinor(tHours, y, periods) {
  periods = periods || [24];
  const n = y.length;
  const k = 1 + 2 * periods.length;
  if (n <= k + 2) return null;
  const X = [];
  for (let i = 0; i < n; i++) {
    const row = [1];
    periods.forEach(tau => {
      row.push(Math.cos(2 * Math.PI * tHours[i] / tau));
      row.push(Math.sin(2 * Math.PI * tHours[i] / tau));
    });
    X.push(row);
  }
  const beta = olsSolve(X, y);
  if (!beta) return null;
  const fitted = X.map(r => r.reduce((a, v, j) => a + v * beta[j], 0));
  const resid = y.map((v, i) => v - fitted[i]);
  const sse = sum(resid.map(r => r * r));
  const my = mean(y);
  const sst = sum(y.map(v => (v - my) ** 2));
  const r2 = 1 - sse / sst;
  const df1 = k - 1, df2 = n - k;
  const F = (sst - sse) / df1 / (sse / df2);
  const comps = periods.map((tau, i) => {
    const b = beta[1 + 2 * i], g = beta[2 + 2 * i];
    let acro = Math.atan2(-g, b);                  // rad, convenção cosinor
    if (acro > 0) acro -= 2 * Math.PI;
    const acroH = (-acro / (2 * Math.PI)) * tau;
    return { period: tau, amplitude: Math.hypot(b, g), acrophaseRad: acro, acrophaseHours: acroH % tau, beta: b, gamma: g };
  });
  // autocorrelação AR(1) dos resíduos e n efetivo
  let numr = 0, den = 0;
  for (let i = 1; i < n; i++) numr += resid[i] * resid[i - 1];
  for (let i = 0; i < n; i++) den += resid[i] * resid[i];
  const rho = den ? numr / den : 0;
  const nEff = n * (1 - rho) / (1 + rho);
  const Fadj = F * Math.max(0.02, nEff / n);
  return {
    n, mesor: beta[0], components: comps, r2, F, p: fPValue(F, df1, df2),
    residualSD: Math.sqrt(sse / df2), rhoAR1: rho, nEffective: nEff,
    pAdjustedAR1: fPValue(Fadj, df1, Math.max(2, Math.round(nEff) - k)),
    fitted, resid,
    predict: h => beta[0] + periods.reduce((a, tau, i) =>
      a + beta[1 + 2 * i] * Math.cos(2 * Math.PI * h / tau) + beta[2 + 2 * i] * Math.sin(2 * Math.PI * h / tau), 0)
  };
}
function olsSolve(X, y) {                        // normal equations + Gauss-Jordan
  const k = X[0].length, n = X.length;
  const A = Array.from({ length: k }, () => new Float64Array(k + 1));
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) { let s = 0; for (let r = 0; r < n; r++) s += X[r][i] * X[r][j]; A[i][j] = s; }
    let s = 0; for (let r = 0; r < n; r++) s += X[r][i] * y[r]; A[i][k] = s;
  }
  for (let c = 0; c < k; c++) {
    let piv = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    const d = A[c][c];
    for (let j = c; j <= k; j++) A[c][j] /= d;
    for (let r = 0; r < k; r++) if (r !== c) { const f = A[r][c]; for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j]; }
  }
  return Array.from({ length: k }, (_, i) => A[i][k]);
}

/* Bootstrap por blocos (dia) para IC dos parâmetros do cosinor */
function cosinorBootstrap(rows, periods, nBoot, offMin) {
  nBoot = nBoot || 400;
  const byDay = {};
  rows.forEach(r => { const d = localDayKey(r.t, offMin); (byDay[d] = byDay[d] || []).push(r); });
  const days = Object.keys(byDay);
  if (days.length < 3) return null;
  const mesor = [], amp = [], acro = [];
  for (let b = 0; b < nBoot; b++) {
    const samp = [];
    for (let i = 0; i < days.length; i++) samp.push(...byDay[days[(Math.random() * days.length) | 0]]);
    const c = cosinor(samp.map(r => localHour(r.t, offMin)), samp.map(r => r.lfp), periods);
    if (!c) continue;
    mesor.push(c.mesor); amp.push(c.components[0].amplitude); acro.push(c.components[0].acrophaseHours);
  }
  const ci = a => [quantile(a, 0.025), quantile(a, 0.975)];
  return { nBoot: mesor.length, nDays: days.length, mesorCI: ci(mesor), amplitudeCI: ci(amp), acrophaseCI: circCI(acro) };
}
function circCI(hours) {
  const ang = hours.map(h => 2 * Math.PI * h / 24);
  const m = Math.atan2(mean(ang.map(Math.sin)), mean(ang.map(Math.cos)));
  const dev = ang.map(a => { let d = a - m; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; });
  const lo = quantile(dev, 0.025), hi = quantile(dev, 0.975);
  const w = x => ((x / (2 * Math.PI) * 24) % 24 + 24) % 24;
  return [w(m + lo), w(m + hi)];
}

/* Teste de Rayleigh (uniformidade circular) */
function rayleigh(hours, period) {
  period = period || 24;
  const n = hours.length; if (n < 3) return null;
  const ang = hours.map(h => 2 * Math.PI * h / period);
  const C = mean(ang.map(Math.cos)), S = mean(ang.map(Math.sin));
  const R = Math.hypot(C, S);
  const z = n * R * R;
  const p = Math.exp(Math.sqrt(1 + 4 * n + 4 * (n * n - z * z)) - (1 + 2 * n));
  let mu = Math.atan2(S, C); if (mu < 0) mu += 2 * Math.PI;
  return { n, R, z, p: Math.min(1, p), meanHour: mu / (2 * Math.PI) * period };
}

/* Variância explicada pela hora do dia (ANOVA de 1 fator com bins) */
function varianceByHour(rows, offMin, nBins) {
  nBins = nBins || 24;
  const groups = Array.from({ length: nBins }, () => []);
  rows.forEach(r => groups[Math.min(nBins - 1, Math.floor(localHour(r.t, offMin) / 24 * nBins))].push(r.lfp));
  const all = rows.map(r => r.lfp), gm = mean(all);
  let ssb = 0, ssw = 0, k = 0;
  groups.forEach(g => { if (!g.length) return; k++; const m = mean(g); ssb += g.length * (m - gm) ** 2; g.forEach(v => ssw += (v - m) ** 2); });
  const n = all.length, df1 = k - 1, df2 = n - k;
  const F = (ssb / df1) / (ssw / df2);
  return { eta2: ssb / (ssb + ssw), F, df1, df2, p: fPValue(F, df1, df2), k, n };
}

/* Perfil diurno: mediana por bin dentro do dia, depois mediana entre dias */
function diurnalProfile(rows, offMin, binMin, detrendDaily) {
  binMin = binMin || 30;
  const nBins = Math.round(24 * 60 / binMin);
  const byDay = {};
  rows.forEach(r => { const d = localDayKey(r.t, offMin); (byDay[d] = byDay[d] || []).push(r); });
  const days = Object.keys(byDay).sort();
  const matrix = [];                                       // dias × bins
  days.forEach(day => {
    const arr = new Array(nBins).fill(NaN);
    const buckets = Array.from({ length: nBins }, () => []);
    byDay[day].forEach(r => buckets[Math.min(nBins - 1, Math.floor(localHour(r.t, offMin) * 60 / binMin))].push(r.lfp));
    const dayMed = median(byDay[day].map(r => r.lfp));
    buckets.forEach((b, i) => { if (b.length) arr[i] = detrendDaily ? 100 * median(b) / dayMed : median(b); });
    matrix.push({ day, values: arr, dayMedian: dayMed, n: byDay[day].length });
  });
  const profile = [], q1 = [], q3 = [];
  for (let i = 0; i < nBins; i++) {
    const col = matrix.map(m => m.values[i]).filter(isFinite);
    profile.push(col.length ? median(col) : NaN);
    q1.push(col.length ? quantile(col, 0.25) : NaN);
    q3.push(col.length ? quantile(col, 0.75) : NaN);
  }
  return { binMin, nBins, days, matrix, profile, q1, q3, hours: Array.from({ length: nBins }, (_, i) => (i + 0.5) * binMin / 60) };
}

/* Média alinhada a evento */
function eventAligned(rows, eventTimes, preMin, postMin, binMin, normalize) {
  preMin = preMin || 60; postMin = postMin || 180; binMin = binMin || 10;
  const nBins = Math.round((preMin + postMin) / binMin) + 1;
  const offsets = Array.from({ length: nBins }, (_, i) => -preMin + i * binMin);
  const trials = [];
  eventTimes.forEach(et => {
    const arr = new Array(nBins).fill(NaN);
    rows.forEach(r => {
      const dm = (r.t - et) / 60000;
      if (dm < -preMin - binMin / 2 || dm > postMin + binMin / 2) return;
      const i = Math.round((dm + preMin) / binMin);
      if (i >= 0 && i < nBins) arr[i] = r.lfp;
    });
    if (arr.filter(isFinite).length >= nBins * 0.4) {
      if (normalize) {
        const base = arr.slice(0, Math.round(preMin / binMin)).filter(isFinite);
        const bm = median(base);
        if (isFinite(bm) && bm !== 0) for (let i = 0; i < nBins; i++) arr[i] = 100 * arr[i] / bm;
      }
      trials.push({ t: et, values: arr });
    }
  });
  const m = [], lo = [], hi = [];
  for (let i = 0; i < nBins; i++) {
    const col = trials.map(t => t.values[i]).filter(isFinite);
    m.push(col.length ? median(col) : NaN);
    lo.push(col.length ? quantile(col, 0.25) : NaN);
    hi.push(col.length ? quantile(col, 0.75) : NaN);
  }
  return { offsets, trials, median: m, q1: lo, q3: hi, nTrials: trials.length };
}

/* Teste de permutação para comparar duas curvas/amostras */
function permutationTest(a, b, nPerm) {
  nPerm = nPerm || 5000;
  const obs = Math.abs(mean(a) - mean(b));
  const pool = a.concat(b); let count = 0;
  for (let i = 0; i < nPerm; i++) {
    const s = pool.slice();
    for (let j = s.length - 1; j > 0; j--) { const k = (Math.random() * (j + 1)) | 0;[s[j], s[k]] = [s[k], s[j]]; }
    if (Math.abs(mean(s.slice(0, a.length)) - mean(s.slice(a.length))) >= obs) count++;
  }
  return { observed: obs, p: (count + 1) / (nPerm + 1), nPerm };
}

/* ECDF e proporções vs limiares de aDBS */
function thresholdSummary(vals, lower, upper) {
  const v = vals.filter(isFinite);
  const below = v.filter(x => x < lower).length, above = v.filter(x => x > upper).length;
  return {
    n: v.length,
    belowPct: 100 * below / v.length,
    betweenPct: 100 * (v.length - below - above) / v.length,
    abovePct: 100 * above / v.length,
    median: median(v), q1: quantile(v, 0.25), q3: quantile(v, 0.75),
    p10: quantile(v, 0.1), p90: quantile(v, 0.9)
  };
}
function histogram(vals, nBins) {
  const v = vals.filter(isFinite); if (!v.length) return null;
  nBins = nBins || 40;
  const lo = Math.min(...v), hi = Math.max(...v), w = (hi - lo) / nBins || 1;
  const counts = new Array(nBins).fill(0);
  v.forEach(x => counts[Math.min(nBins - 1, Math.floor((x - lo) / w))]++);
  return { lo, hi, width: w, counts, centers: counts.map((_, i) => lo + (i + 0.5) * w), n: v.length };
}
function ecdf(vals) {
  const v = vals.filter(isFinite).sort((a, b) => a - b);
  return { x: v, y: v.map((_, i) => (i + 1) / v.length) };
}

/* ======================================================================== */
const API = {
  parsePercept, MODALITIES, BANDS, prettyChannel, parseUtcOffsetMin, localHour, localDayKey, hashId,
  fft, nextPow2, welchPSD, spectrogram, bandpassFFT, hilbertEnvelope, detectBursts, fitAperiodic,
  ecgTemplateSubtract, bandPower, bandTable, bandOf,
  mean, median, sd, variance, quantile, mad, removeOutliersMAD, linreg, pearson,
  cosinor, cosinorBootstrap, rayleigh, varianceByHour, diurnalProfile, eventAligned,
  permutationTest, thresholdSummary, histogram, ecdf, fPValue, tPValue, normCDF
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.PerceptCore = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
