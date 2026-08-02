/* dsp/nan.js — contabilidade de dados faltantes (dsp)

   POR QUE ISTO EXISTE. A partir da Onda 1 a perda de pacotes vira NaN na série
   (ver io/packets.js). Um único NaN propaga pela FFT e destrói o espectro
   inteiro. Este módulo dá às funções de DSP as utilidades para trabalhar com
   lacunas SEM imputar dado em silêncio: cada função declara quanto descartou,
   quanto usou e — quando precisa preencher para poder filtrar — quanto imputou
   temporariamente, repondo NaN na saída.

   Contrato do projeto (CLAUDE.md): perda de pacote é NaN, e NaN é propagado com
   contabilidade explícita.                                                   */

/* nanStats(x) → { n, nValid, nNan, pctNan, longestGapSamples }
   Unidades: amostras. Serve de base para os selos de qualidade da UI.       */
export function nanStats(x) {
  const n = x ? x.length : 0;
  let nNan = 0, atual = 0, maior = 0;
  for (let i = 0; i < n; i++) {
    if (!isFinite(x[i])) { nNan++; atual++; if (atual > maior) maior = atual; }
    else atual = 0;
  }
  return {
    n, nValid: n - nNan, nNan,
    pctNan: n ? 100 * nNan / n : 0,
    longestGapSamples: maior
  };
}

/* segmentsWithoutNan(x, nper, step) → índices de início dos segmentos cuja
   fração de NaN não excede maxNanPct (default 0: qualquer NaN descarta).    */
export function segmentsWithoutNan(x, nper, step, maxNanPct) {
  const lim = isFinite(maxNanPct) ? maxNanPct : 0;
  const bons = [], maus = [];
  for (let s = 0; s + nper <= x.length; s += step) {
    let nan = 0;
    for (let i = s; i < s + nper; i++) if (!isFinite(x[i])) nan++;
    ((100 * nan / nper) <= lim ? bons : maus).push(s);
  }
  return { starts: bons, dropped: maus.length, total: bons.length + maus.length };
}

/* interpolateForFilter(x) → { filled, mask, pctImputed }
   Preenchimento linear APENAS para viabilizar a filtragem (a FFT não aceita
   NaN). A máscara permite repor NaN nas posições originais na saída — a
   imputação é temporária e declarada, nunca silenciosa. Bordas faltantes são
   preenchidas com o primeiro/último valor válido (extensão constante).      */
export function interpolateForFilter(x) {
  const n = x.length;
  const filled = Float64Array.from(x);
  const mask = new Uint8Array(n);
  let nNan = 0;
  for (let i = 0; i < n; i++) if (!isFinite(x[i])) { mask[i] = 1; nNan++; }
  if (!nNan) return { filled, mask, pctImputed: 0 };
  if (nNan === n) { filled.fill(0); return { filled, mask, pctImputed: 100 }; }

  let i = 0;
  while (i < n) {
    if (!mask[i]) { i++; continue; }
    let j = i; while (j < n && mask[j]) j++;
    const antes = i - 1, depois = j;
    const vA = antes >= 0 ? filled[antes] : NaN;
    const vD = depois < n ? x[depois] : NaN;
    for (let k = i; k < j; k++) {
      if (isFinite(vA) && isFinite(vD)) {
        const t = (k - antes) / (depois - antes);
        filled[k] = vA + t * (vD - vA);
      } else if (isFinite(vA)) filled[k] = vA;          // lacuna no fim
      else if (isFinite(vD)) filled[k] = vD;            // lacuna no início
      else filled[k] = 0;
    }
    i = j;
  }
  return { filled, mask, pctImputed: 100 * nNan / n };
}

/* Repõe NaN nas posições originalmente faltantes. */
export function restoreNaN(y, mask) {
  for (let i = 0; i < y.length && i < mask.length; i++) if (mask[i]) y[i] = NaN;
  return y;
}

/* --------- versões tolerantes a NaN das estatísticas de apoio do DSP ----- */
/* Ignoram amostras não finitas (equivalente a na.rm = TRUE) e reportam n por
   meio de nanStats — nunca inventam valor para a posição faltante.          */
export function nanMean(a) {
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i++) if (isFinite(a[i])) { s += a[i]; n++; }
  return n ? s / n : NaN;
}
export function nanVariance(a) {
  const m = nanMean(a);
  if (!isFinite(m)) return NaN;
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i++) if (isFinite(a[i])) { s += (a[i] - m) * (a[i] - m); n++; }
  return n > 1 ? s / (n - 1) : NaN;
}

/* Detrend linear ignorando NaN no ajuste e preservando NaN na saída.
   Entrada e saída na mesma unidade do sinal (µV).                          */
export function detrendLinearNaN(x) {
  const n = x.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, k = 0;
  for (let i = 0; i < n; i++) {
    if (!isFinite(x[i])) continue;
    sx += i; sy += x[i]; sxx += i * i; sxy += i * x[i]; k++;
  }
  const o = new Float64Array(n);
  if (k < 2) { for (let i = 0; i < n; i++) o[i] = x[i]; return o; }
  const den = k * sxx - sx * sx;
  const b = den ? (k * sxy - sx * sy) / den : 0;
  const a = (sy - b * sx) / k;
  for (let i = 0; i < n; i++) o[i] = isFinite(x[i]) ? x[i] - (a + b * i) : NaN;
  return o;
}
