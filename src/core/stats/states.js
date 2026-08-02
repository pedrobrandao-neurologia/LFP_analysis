/* stats/states.js — estados ON/OFF pela amplitude do beta (stats)
   Gerado do refactor modular (Prompt 0.1). Ver docs/arquitetura.md. */

import { bandpassFFT, hilbertEnvelope } from '../dsp/filters.js';
import { bimodalityCoefficient, mean, quantile, rnd, sum, variance } from './descriptive.js';

export function enforceMinDur(pts, lab, minDur) {
  lab = lab.slice();
  let changed = true, guard = 0;
  while (changed && guard++ < 2000) {
    changed = false;
    let i = 0;
    while (i < pts.length) {
      let j = i; while (j < pts.length && lab[j] === lab[i]) j++;
      const dur = pts[j - 1].t - pts[i].t;
      if (dur < minDur && !(i === 0 && j === pts.length)) {   // corre curta demais → funde no vizinho
        const nl = i > 0 ? lab[i - 1] : lab[j];
        if (nl !== lab[i]) { for (let k = i; k < j; k++) lab[k] = nl; changed = true; }
      }
      i = j;
    }
  }
  return lab;
}

export function detectStates(series, opts) {
  opts = opts || {};
  const pts = (series || []).filter(s => s && isFinite(s.v)).sort((a, b) => a.t - b.t);
  if (pts.length < 8) return null;
  const vals = pts.map(s => s.v);
  let cLow = quantile(vals, 0.25), cHigh = quantile(vals, 0.75);      // init determinístico (sem random)
  if (!(cHigh > cLow)) return null;
  for (let it = 0; it < 60; it++) {                                   // k-médias (k=2) 1-D
    let sL = 0, nL = 0, sH = 0, nH = 0;
    for (const v of vals) { if (Math.abs(v - cLow) <= Math.abs(v - cHigh)) { sL += v; nL++; } else { sH += v; nH++; } }
    const nlo = nL ? sL / nL : cLow, nhi = nH ? sH / nH : cHigh;
    if (Math.abs(nlo - cLow) < 1e-9 && Math.abs(nhi - cHigh) < 1e-9) { cLow = nlo; cHigh = nhi; break; }
    cLow = nlo; cHigh = nhi;
  }
  const thr = (cLow + cHigh) / 2;
  const lo = vals.filter(v => v <= thr), hi = vals.filter(v => v > thr);
  const pooled = Math.sqrt((Math.max(1, lo.length - 1) * (variance(lo) || 0) + Math.max(1, hi.length - 1) * (variance(hi) || 0)) / Math.max(1, lo.length + hi.length - 2));
  const separation = pooled ? (cHigh - cLow) / pooled : NaN;         // distância padronizada (tipo d de Cohen)
  let lab = pts.map(s => s.v > thr ? 1 : 0);                         // 1 = OFF (alto beta), 0 = ON (baixo beta)
  if (opts.minDur) lab = enforceMinDur(pts, lab, opts.minDur);
  const episodes = []; let i = 0;
  while (i < pts.length) {
    const stt = lab[i]; let j = i; while (j < pts.length && lab[j] === stt) j++;
    episodes.push({ state: stt ? 'OFF' : 'ON', startT: pts[i].t, endT: pts[j - 1].t, n: j - i, dur: pts[j - 1].t - pts[i].t, meanV: mean(vals.slice(i, j)) });
    i = j;
  }
  const offEp = episodes.filter(e => e.state === 'OFF'), onEp = episodes.filter(e => e.state === 'ON');
  const dur = eps => eps.map(e => e.dur).filter(v => isFinite(v) && v > 0);
  return {
    threshold: thr, betaLow: cLow, betaHigh: cHigh, separation, bimodality: bimodalityCoefficient(vals),
    labels: lab, points: pts, episodes, span: pts[pts.length - 1].t - pts[0].t,
    offFraction: lab.reduce((a, b) => a + b, 0) / lab.length,
    nOff: offEp.length, nOn: onEp.length,
    meanOffDur: mean(dur(offEp)), meanOnDur: mean(dur(onEp))
  };
}
/* Série de amplitude de beta ao longo do tempo, a partir do sinal bruto:
   passa-banda (13–30 Hz) → envelope de Hilbert → média móvel de winS s. */

export function betaEnvelopeSeries(td, opts) {
  opts = opts || {};
  const lo = opts.lo || 13, hi = opts.hi || 30, winS = opts.winS || 1;
  const bp = bandpassFFT(td.data, td.fs, lo, hi);
  const env = hilbertEnvelope(bp);
  const w = Math.max(1, Math.round(winS * td.fs)), step = Math.max(1, Math.round(w / 2));
  const out = [];
  for (let s = 0; s + w <= env.length; s += step) {
    let sum = 0; for (let k = s; k < s + w; k++) sum += env[k];
    out.push({ t: (s + w / 2) / td.fs, v: sum / w });
  }
  return out;
}
/* ON/OFF resumido de um streaming bruto (BrainSense Streaming). */

export function streamOnOff(parsed, hemi, opts) {
  opts = opts || {};
  const td = (parsed.bsTimeDomain || []).find(t => t.hemisphere === hemi);
  if (!td || td.data.length < td.fs * 8) return null;
  const ser = betaEnvelopeSeries(td, { lo: opts.lo || 13, hi: opts.hi || 30, winS: opts.winS || 1 });
  const st = detectStates(ser, { minDur: opts.minDur || 2 });
  if (!st) return null;
  return { stream_off_pct: rnd(100 * st.offFraction, 1), stream_n_off_episodes: st.nOff, stream_beta_state_sep: rnd(st.separation, 2), stream_beta_bimodality: rnd(st.bimodality, 3) };
}

/* Extrator principal: lista de sessões (parsed) → pacote de métricas tidy. */
