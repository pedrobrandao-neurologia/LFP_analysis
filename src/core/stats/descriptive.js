/* stats/descriptive.js — estatística descritiva e regressão (stats)
   Gerado do refactor modular (Prompt 0.1). Ver docs/arquitetura.md. */

export const sum = a => a.reduce((x, y) => x + y, 0);

/* Média e variância ignoram amostras não finitas (equivalente a na.rm = TRUE):
   com lacunas de pacote no sinal (Onda 1), propagar NaN para toda a estatística
   apagaria o dado válido. O n efetivamente usado é reportado por nanStats(). */
export const mean = a => {
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i++) if (isFinite(a[i])) { s += a[i]; n++; }
  return n ? s / n : NaN;
};

export function variance(a) {
  const m = mean(a);
  if (!isFinite(m)) return NaN;
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i++) if (isFinite(a[i])) { s += (a[i] - m) * (a[i] - m); n++; }
  return n > 1 ? s / (n - 1) : NaN;
}

export const sd = a => Math.sqrt(variance(a));

export function median(a) { return quantile(a, 0.5); }

export function quantile(a, q) {
  if (!a.length) return NaN;
  const s = Array.from(a).filter(isFinite).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const h = (s.length - 1) * q, lo = Math.floor(h), hi = Math.ceil(h);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}

export function mad(a) { const m = median(a); return 1.4826 * median(a.map(v => Math.abs(v - m))); }

export function removeOutliersMAD(rows, key, k) {
  k = k || 4;
  const vals = rows.map(r => r[key]).filter(isFinite);
  const m = median(vals), s = mad(vals) || 1e-9;
  const kept = rows.filter(r => isFinite(r[key]) && Math.abs(r[key] - m) <= k * s);
  return { kept, removed: rows.length - kept.length, median: m, mad: s, lo: m - k * s, hi: m + k * s };
}

export function linreg(x, y) {
  const n = x.length; if (n < 2) return { slope: NaN, intercept: NaN, r2: NaN };
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  const b = sxy / sxx;
  return { slope: b, intercept: my - b * mx, r2: (sxy * sxy) / (sxx * syy), n };
}

export function pearson(x, y) { const r = linreg(x, y); return Math.sign(r.slope) * Math.sqrt(Math.max(0, r.r2)); }

/* --- distribuições ----------------------------------------------------- */

export function histogram(vals, nBins) {
  const v = vals.filter(isFinite); if (!v.length) return null;
  nBins = nBins || 40;
  const lo = Math.min(...v), hi = Math.max(...v), w = (hi - lo) / nBins || 1;
  const counts = new Array(nBins).fill(0);
  v.forEach(x => counts[Math.min(nBins - 1, Math.floor((x - lo) / w))]++);
  return { lo, hi, width: w, counts, centers: counts.map((_, i) => lo + (i + 0.5) * w), n: v.length };
}

export function ecdf(vals) {
  const v = vals.filter(isFinite).sort((a, b) => a - b);
  return { x: v, y: v.map((_, i) => (i + 1) / v.length) };
}

/* ======================================================================== */
/*  4. EXTRAÇÃO DE MÉTRICAS-CHAVE  (relatório · CSV · JSON)                   */
/*                                                                           */
/*  Reúne, por SESSÃO × HEMISFÉRIO (medidas agudas) e por SUJEITO ×          */
/*  HEMISFÉRIO (medidas crônicas do Timeline), as variáveis que a literatura */
/*  usa como desfecho — pico beta, componente aperiódico (specparam),        */
/*  bursts, dose-resposta e ritmo circadiano — cada linha nomeada por        */
/*  paciente, sessão e data de implante (com dias desde o implante).         */
/*  Puro, sem DOM: alimenta o relatório, o CSV e o JSON e é testável.        */
/* ======================================================================== */

export const rnd = (x, n) => (typeof x === 'number' && isFinite(x)) ? +x.toFixed(n == null ? 4 : n) : NaN;

/* pico (freq, valor) da maior magnitude dentro de uma banda */

export function bimodalityCoefficient(a) {
  const v = (a || []).filter(isFinite), n = v.length;
  if (n < 4) return NaN;
  const m = mean(v), s = Math.sqrt(variance(v));
  if (!s || !isFinite(s)) return NaN;
  let m3 = 0, m4 = 0;
  for (const x of v) { const z = (x - m) / s; m3 += z * z * z; m4 += z * z * z * z; }
  m3 /= n; m4 /= n;
  const g1 = m3, g2 = m4 - 3;                       // assimetria e curtose (excesso)
  const denom = g2 + 3 * (n - 1) * (n - 1) / ((n - 2) * (n - 3));
  return denom ? (g1 * g1 + 1) / denom : NaN;
}
