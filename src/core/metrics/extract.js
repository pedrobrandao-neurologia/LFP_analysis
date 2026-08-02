/* metrics/extract.js — extrator principal de métricas tidy (metrics)
   Gerado do refactor modular (Prompt 0.1). Ver docs/arquitetura.md. */

import { pickSpectrum, spectralMetrics, burstMetrics, doseResponse, ecgMetrics, deviceStateMetrics, HEMIS } from './acute.js';
import { T, localDayKey } from '../io/parse.js';
import { chronicMetrics, collectThresholds, mergeTrend } from './chronic.js';
import { streamOnOff } from '../stats/states.js';
import { suggestProfile, getProfile } from '../profiles/index.js';

export function daysSince(fromISO, toISO) {
  const a = T(fromISO), b = T(toISO);
  return (isFinite(a) && isFinite(b)) ? Math.round((b - a) / 864e5) : NaN;
}

/* Escolhe o melhor espectro disponível para um hemisfério, com prioridade:
   Signal Test (canal de sensing crônico) > Survey > Signal Check > Welch(bruto). */

export function extractMetrics(parsedList, offMin, opts) {
  opts = opts || {};
  parsedList = (parsedList || []).slice();
  if (!parsedList.length) return null;
  if (offMin == null) { const pf = parsedList.find(p => p.meta && p.meta.utcOffsetMin != null); offMin = pf ? pf.meta.utcOffsetMin : -180; }
  const p0 = parsedList[0];
  /* perfil de doença ativo: sugerido do Diagnosis/LeadLocation, ou o informado */
  const perfilId = opts.profileId || suggestProfile(p0);
  const implant = p0.device.implantDate || null;
  const implantDay = implant ? String(implant).slice(0, 10) : null;
  const targetOf = h => { const l = (p0.leads || []).find(x => x.hemisphere === h); return l ? l.target : ''; };
  const subject = {
    id: p0.patient.idHash, diagnosis: p0.patient.diagnosis || null, sex: p0.patient.sex || null,
    implant_date: implantDay,
    device_model: p0.device.model || null, device_location: p0.device.location || null, firmware: p0.device.firmware || null,
    targets: (p0.leads || []).map(l => ({ hemisphere: l.hemisphere, target: l.target, model: l.model })),
    timezone_offset_min: offMin,
    profile_id: perfilId, profile_label: getProfile(perfilId).label
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
      const spec = pickSpectrum(p, h), bu = burstMetrics(p, h, {}), dr = doseResponse(p, h), so = streamOnOff(p, h), eq = ecgMetrics(p, h), dv = deviceStateMetrics(p, h);
      if (!spec && !bu && !dr && !so && !eq) return;
      const row = {
        subject_id: subject.id, diagnosis: subject.diagnosis, implant_date: implantDay,
        session_file: p.fileName, session_date_local: sdate, days_since_implant: dsi,
        hemisphere: h, target: targetOf(h)
      };
      if (spec) Object.assign(row, spectralMetrics(spec, perfilId));
      if (bu) Object.assign(row, bu);
      if (dr) Object.assign(row, dr);
      if (so) Object.assign(row, so);
      if (eq) Object.assign(row, eq);
      if (dv) Object.assign(row, dv);
      acute.push(row);
    });
  });
  const merged = mergeTrend(parsedList), thr = collectThresholds(parsedList), chronic = [];
  Object.keys(merged).forEach(h => {
    if (!merged[h].length) return;
    const m = chronicMetrics(merged[h], offMin, thr[h]);
    chronic.push(Object.assign({
      subject_id: subject.id, diagnosis: subject.diagnosis, implant_date: implantDay,
      profile_id: perfilId,
      hemisphere: h, target: targetOf(h),
      days_since_implant_start: (implant && m.first_day_local) ? daysSince(implant, m.first_day_local) : NaN
    }, m));
  });
  return { subject, sessions, acute, chronic };
}

/* ======================================================================== */
