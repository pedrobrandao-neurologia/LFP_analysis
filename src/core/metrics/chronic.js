/* metrics/chronic.js — métricas crônicas do Timeline (metrics)
   Gerado do refactor modular (Prompt 0.1). Ver docs/arquitetura.md. */

import { cosinor, diurnalProfile, rayleigh, varianceByHour } from '../stats/circadian.js';
import { detectStates } from '../stats/states.js';
import { localDayKey, localHour } from '../io/parse.js';
import { median, quantile, removeOutliersMAD, rnd } from '../stats/descriptive.js';

export function thresholdSummary(vals, lower, upper) {
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

export function mergeTrend(parsedList) {
  const out = {};
  parsedList.forEach(p => Object.keys(p.trend || {}).forEach(h => { out[h] = (out[h] || []).concat(p.trend[h]); }));
  Object.keys(out).forEach(h => {
    const seen = new Set(), rows = [];
    out[h].sort((a, b) => a.t - b.t).forEach(r => { if (!seen.has(r.t)) { seen.add(r.t); rows.push(r); } });
    out[h] = rows;
  });
  return out;
}

/* Limiares de sensing/aDBS declarados no dispositivo, por hemisfério. */

export function collectThresholds(parsedList) {
  const t = {};
  parsedList.forEach(p => (p.sensingSetup || []).forEach(s => { if (isFinite(s.lowerThr)) t[s.hemisphere] = { lower: s.lowerThr, upper: s.upperThr, centerFreq: s.centerFreq }; }));
  parsedList.forEach(p => (p.bsLfp || []).forEach(b => Object.keys(b.therapy.perHemi || {}).forEach(h => {
    const x = b.therapy.perHemi[h]; if (isFinite(x.lowerThr) && !t[h]) t[h] = { lower: x.lowerThr, upper: x.upperThr, centerFreq: x.centerFreq };
  })));
  return t;
}

/* Métricas crônicas (circadiano + distribuição para aDBS) de um hemisfério. */

export function chronicMetrics(rows, offMin, thr) {
  const clean = removeOutliersMAD(rows, 'lfp', 4).kept;
  const vals = clean.map(r => r.lfp);
  const dayset = {}; clean.forEach(r => dayset[localDayKey(r.t, offMin)] = 1);
  const days = Object.keys(dayset).sort();
  const out = {
    n_points: clean.length, n_removed: rows.length - clean.length, n_days: days.length,
    first_day_local: days[0] || '', last_day_local: days[days.length - 1] || '',
    lfp_median: rnd(median(vals)), lfp_iqr_low: rnd(quantile(vals, .25)), lfp_iqr_high: rnd(quantile(vals, .75))
  };
  if (clean.length >= 12) {
    const cos = cosinor(clean.map(r => localHour(r.t, offMin)), vals, [24, 12]);
    const vh = varianceByHour(clean, offMin);
    if (cos) Object.assign(out, {
      mesor: rnd(cos.mesor), amp_24h: rnd(cos.components[0].amplitude),
      acrophase_24h: rnd(((cos.components[0].acrophaseHours % 24) + 24) % 24, 2),
      amp_12h: cos.components[1] ? rnd(cos.components[1].amplitude) : NaN,
      cosinor_r2: rnd(cos.r2, 3), cosinor_F: rnd(cos.F, 2), cosinor_p: rnd(cos.p, 5),
      rho_ar1: rnd(cos.rhoAR1, 3), cosinor_p_adj_ar1: rnd(cos.pAdjustedAR1, 5)
    });
    if (vh) Object.assign(out, { eta2_hour_pct: rnd(100 * vh.eta2, 2), eta2_p: rnd(vh.p, 5) });
  }
  if (days.length >= 2) {
    const dp = diurnalProfile(clean, offMin, 30, true);
    const peaks = dp.matrix.map(m => { let bi = -1, bv = -Infinity; m.values.forEach((x, i) => { if (isFinite(x) && x > bv) { bv = x; bi = i; } }); return bi >= 0 ? dp.hours[bi] : NaN; }).filter(isFinite);
    const ray = rayleigh(peaks);
    if (ray) Object.assign(out, { rayleigh_R: rnd(ray.R, 3), rayleigh_p: rnd(ray.p, 5), rayleigh_mean_hour: rnd(ray.meanHour, 2) });
  }
  const lo = thr && isFinite(thr.lower) ? thr.lower : quantile(vals, .25);
  const hi = thr && isFinite(thr.upper) ? thr.upper : quantile(vals, .75);
  const sm = thresholdSummary(vals, lo, hi);
  Object.assign(out, {
    thr_source: thr && isFinite(thr.lower) ? 'device' : 'Q1/Q3',
    thr_lower: rnd(lo), thr_upper: rnd(hi),
    pct_below: rnd(sm.belowPct, 1), pct_between: rnd(sm.betweenPct, 1), pct_above: rnd(sm.abovePct, 1),
    p10: rnd(sm.p10), p90: rnd(sm.p90),
    sensing_center_hz: thr && isFinite(thr.centerFreq) ? rnd(thr.centerFreq, 1) : NaN
  });
  const st = detectStates(clean.map(r => ({ t: r.t, v: r.lfp })), { minDur: 30 * 60000 });
  if (st) Object.assign(out, {
    off_pct: rnd(100 * st.offFraction, 1), n_off_episodes: st.nOff,
    mean_off_min: rnd(st.meanOffDur / 60000, 0), mean_on_min: rnd(st.meanOnDur / 60000, 0),
    beta_low_state: rnd(st.betaLow), beta_high_state: rnd(st.betaHigh),
    beta_state_sep: rnd(st.separation, 2), beta_bimodality: rnd(st.bimodality, 3)
  });
  return out;
}

/* ---- Detecção automática de estados ON/OFF pela amplitude do beta --------
   Ideia clínica: o beta subtalâmico é o "ritmo do freio" — costuma ficar ALTO
   quando a medicação está no fim (estado OFF) e CAI quando ela faz efeito
   (estado ON) ou sob estimulação eficaz. Aqui a série de potência de beta é
   separada em dois estados por agrupamento (k-médias, k=2): baixo beta = ON,
   alto beta = OFF, com um limiar entre eles e limpeza de duração mínima para
   não oscilar. É um CORRELATO, não a verdade clínica — artefato de movimento
   infla o beta e simula OFF, e a estimulação também altera o beta. --------- */
/* Coeficiente de bimodalidade de Sarle (0–1). BC > ~0,555 sugere distribuição
   com dois modos (ou achatada); BC baixo indica um único pico — nesse caso a
   divisão ON/OFF é arbitrária. É um indicador honesto de "há dois estados?",
   ao contrário da distância entre clusters, que o k-médias sempre infla. */
