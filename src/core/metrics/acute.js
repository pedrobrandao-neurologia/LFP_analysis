/* metrics/acute.js — métricas agudas por sessão × hemisfério (metrics)
   Gerado do refactor modular (Prompt 0.1). Ver docs/arquitetura.md. */

import { bandPower, bandTable, welchPSD } from '../dsp/spectral.js';
import { bandpassFFT, hilbertEnvelope } from '../dsp/filters.js';
import { detectBursts } from '../dsp/bursts.js';
import { fitAperiodic } from '../dsp/aperiodic.js';
import { linreg, median, rnd } from '../stats/descriptive.js';

export const HEMIS = ['Left', 'Right'];

export function peakInBand(f, p, lo, hi) {
  let pf = NaN, pv = -Infinity;
  for (let i = 0; i < f.length; i++)
    if (f[i] >= lo && f[i] <= hi && isFinite(p[i]) && p[i] > pv) { pv = p[i]; pf = f[i]; }
  return { f: pf, v: isFinite(pv) ? pv : NaN };
}

export function pickSpectrum(parsed, hemi) {
  const ss = (parsed.sensingSetup || []).filter(s => s.hemisphere === hemi && s.psd);
  if (ss.length) { const s = ss[0]; return { f: s.psd.f, p: s.psd.p, source: 'SignalTest', channel: s.channel, center: s.centerFreq, artifact: s.psd.artifact }; }
  const mo = (parsed.montage || []).filter(m => m.hemisphere === hemi && m.f && m.f.length);
  if (mo.length) {
    const best = mo.slice().sort((a, b) => peakInBand(b.f, b.mag, 13, 35).v - peakInBand(a.f, a.mag, 13, 35).v)[0];
    return { f: best.f, p: best.mag, source: 'Survey', channel: best.label, artifact: best.artifact };
  }
  const sc = (parsed.signalCheck || []).filter(s => (/LEFT|_L$/i.test(String(s.channel)) ? 'Left' : 'Right') === hemi);
  if (sc.length) { const s = sc[0]; return { f: s.f, p: s.p, source: 'SignalCheck', channel: s.channel, artifact: s.artifact }; }
  const td = (parsed.bsTimeDomain || []).filter(t => t.hemisphere === hemi);
  if (td.length) { const w = welchPSD(td[0].data, td[0].fs, { nperseg: 512, overlap: .5 }); return { f: Array.from(w.f), p: Array.from(w.p), source: 'Welch·streaming', channel: td[0].label }; }
  const mt = (parsed.montageTD || []).filter(t => t.hemisphere === hemi);
  if (mt.length) { const w = welchPSD(mt[0].data, mt[0].fs, { nperseg: 512, overlap: .5 }); return { f: Array.from(w.f), p: Array.from(w.p), source: 'Welch·survey', channel: mt[0].label }; }
  return null;
}

/* Métricas espectrais agudas a partir de um espectro (f, p). */

export function spectralMetrics(spec) {
  const { f, p } = spec;
  const ap = fitAperiodic(f, p, { fmin: 2, fmax: 95 });
  const bt = bandTable(f, p);
  const rel = k => { const b = bt.find(x => x.key === k); return b ? b.relative : NaN; };
  const beta = peakInBand(f, p, 13, 35), ta = peakInBand(f, p, 4, 12), gamma = peakInBand(f, p, 55, 95);
  const betaPeaks = ap ? ap.peaks.filter(pk => pk.band === 'lowbeta' || pk.band === 'highbeta') : [];
  const taPeaks = ap ? ap.peaks.filter(pk => pk.band === 'theta' || pk.band === 'alpha') : [];
  return {
    spectrum_source: spec.source, spectrum_channel: spec.channel || '',
    sensing_center_hz: isFinite(spec.center) ? rnd(spec.center, 1) : NaN,
    device_artifact: spec.artifact || '',
    beta_peak_hz: rnd(beta.f, 2), beta_peak_mag: rnd(beta.v),
    beta_rel_pct: rnd(rel('lowbeta') + rel('highbeta'), 2),
    low_beta_rel_pct: rnd(rel('lowbeta'), 2), high_beta_rel_pct: rnd(rel('highbeta'), 2),
    has_beta_peak: betaPeaks.length ? 1 : 0,
    theta_alpha_peak_hz: rnd(ta.f, 2), theta_alpha_peak_mag: rnd(ta.v),
    theta_alpha_rel_pct: rnd(rel('theta') + rel('alpha'), 2),
    has_theta_alpha_peak: taPeaks.length ? 1 : 0,
    gamma_peak_hz: rnd(gamma.f, 2),
    aperiodic_exponent: rnd(ap ? ap.exponent : NaN, 4),
    aperiodic_offset: rnd(ap ? ap.offset : NaN, 4),
    aperiodic_r2: rnd(ap ? ap.r2 : NaN, 4)
  };
}

/* Métricas de burst a partir do sinal bruto (streaming, senão survey). */

export function burstMetrics(parsed, hemi, opts) {
  opts = opts || {};
  const src = (parsed.bsTimeDomain || []).find(t => t.hemisphere === hemi);
  const td = src || (parsed.montageTD || []).find(t => t.hemisphere === hemi);
  if (!td) return null;
  const pct = opts.percentile || 75, lo = opts.blo || 13, hi = opts.bhi || 30, minMs = opts.minMs || 100;
  const bp = bandpassFFT(td.data, td.fs, lo, hi);
  const env = hilbertEnvelope(bp);
  const bu = detectBursts(env, td.fs, { percentile: pct, minDurationMs: minMs });
  const w = welchPSD(td.data, td.fs, { nperseg: 512, overlap: .5 });
  return {
    td_source: src ? 'streaming' : 'survey',
    td_duration_s: rnd(td.data.length / td.fs, 1),
    burst_band_hz: lo + '-' + hi, burst_percentile: pct,
    burst_rate_hz: rnd(bu.rate, 3), burst_mean_ms: rnd(bu.meanDurationMs, 1),
    burst_median_ms: rnd(bu.medianDurationMs, 1), burst_prob_pct: rnd(100 * bu.probability, 1),
    beta_power_welch: rnd(bandPower(w.f, w.p, 13, 30), 4)
  };
}

/* Curva dose-resposta (potência × amplitude de estimulação) do BrainSenseLfp. */

export function doseResponse(parsed, hemi) {
  const rows = (parsed.bsLfp || []).filter(b => b.series && b.series[hemi]);
  if (!rows.length) return null;
  const s = rows[0].series[hemi], levels = {};
  s.ma.forEach((m, i) => { const k = (+m).toFixed(2); (levels[k] = levels[k] || []).push(s.lfp[i]); });
  const keys = Object.keys(levels).map(parseFloat).sort((a, b) => a - b).filter(k => levels[k.toFixed(2)].length >= 4);
  if (keys.length < 3) return { stim_levels: keys.length };
  const meds = keys.map(k => median(levels[k.toFixed(2)]));
  const lr = linreg(keys, meds);
  return { stim_levels: keys.length, stim_min_ma: rnd(keys[0], 2), stim_max_ma: rnd(keys[keys.length - 1], 2), dose_slope: rnd(lr.slope, 3), dose_r2: rnd(lr.r2, 3) };
}

/* Concatena e desduplica o Timeline entre arquivos do mesmo sujeito. */
