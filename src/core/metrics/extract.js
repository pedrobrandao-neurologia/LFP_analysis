/* metrics/extract.js — extrator principal de métricas tidy (metrics)
   Gerado do refactor modular (Prompt 0.1). Ver docs/arquitetura.md. */

import { HEMIS, burstMetrics, doseResponse, pickSpectrum, spectralMetrics } from './acute.js';
import { T, localDayKey } from '../io/parse.js';
import { chronicMetrics, collectThresholds, mergeTrend } from './chronic.js';
import { streamOnOff } from '../stats/states.js';

export function daysSince(fromISO, toISO) {
  const a = T(fromISO), b = T(toISO);
  return (isFinite(a) && isFinite(b)) ? Math.round((b - a) / 864e5) : NaN;
}

/* Escolhe o melhor espectro disponível para um hemisfério, com prioridade:
   Signal Test (canal de sensing crônico) > Survey > Signal Check > Welch(bruto). */

export function extractMetrics(parsedList, offMin) {
  parsedList = (parsedList || []).slice();
  if (!parsedList.length) return null;
  if (offMin == null) { const pf = parsedList.find(p => p.meta && p.meta.utcOffsetMin != null); offMin = pf ? pf.meta.utcOffsetMin : -180; }
  const p0 = parsedList[0];
  const implant = p0.device.implantDate || null;
  const implantDay = implant ? String(implant).slice(0, 10) : null;
  const targetOf = h => { const l = (p0.leads || []).find(x => x.hemisphere === h); return l ? l.target : ''; };
  const subject = {
    id: p0.patient.idHash, diagnosis: p0.patient.diagnosis || null, sex: p0.patient.sex || null,
    implant_date: implantDay,
    device_model: p0.device.model || null, device_location: p0.device.location || null, firmware: p0.device.firmware || null,
    targets: (p0.leads || []).map(l => ({ hemisphere: l.hemisphere, target: l.target, model: l.model })),
    timezone_offset_min: offMin
  };
  const sessions = parsedList.map(p => ({
    file: p.fileName, session_start: p.meta.sessionStart || null,
    session_date_local: p.meta.sessionStart ? localDayKey(T(p.meta.sessionStart), offMin) : null,
    days_since_implant: (implant && p.meta.sessionStart) ? daysSince(implant, p.meta.sessionStart) : NaN,
    n_modalities: Object.keys(p.availability || {}).filter(k => p.availability[k] > 0).length
  }));
  const acute = [];
  parsedList.forEach(p => {
    const sdate = p.meta.sessionStart ? localDayKey(T(p.meta.sessionStart), offMin) : '';
    const dsi = (implant && p.meta.sessionStart) ? daysSince(implant, p.meta.sessionStart) : NaN;
    HEMIS.forEach(h => {
      const spec = pickSpectrum(p, h), bu = burstMetrics(p, h, {}), dr = doseResponse(p, h), so = streamOnOff(p, h);
      if (!spec && !bu && !dr && !so) return;
      const row = {
        subject_id: subject.id, diagnosis: subject.diagnosis, implant_date: implantDay,
        session_file: p.fileName, session_date_local: sdate, days_since_implant: dsi,
        hemisphere: h, target: targetOf(h)
      };
      if (spec) Object.assign(row, spectralMetrics(spec));
      if (bu) Object.assign(row, bu);
      if (dr) Object.assign(row, dr);
      if (so) Object.assign(row, so);
      acute.push(row);
    });
  });
  const merged = mergeTrend(parsedList), thr = collectThresholds(parsedList), chronic = [];
  Object.keys(merged).forEach(h => {
    if (!merged[h].length) return;
    const m = chronicMetrics(merged[h], offMin, thr[h]);
    chronic.push(Object.assign({
      subject_id: subject.id, diagnosis: subject.diagnosis, implant_date: implantDay,
      hemisphere: h, target: targetOf(h),
      days_since_implant_start: (implant && m.first_day_local) ? daysSince(implant, m.first_day_local) : NaN
    }, m));
  });
  return { subject, sessions, acute, chronic };
}

/* ======================================================================== */
