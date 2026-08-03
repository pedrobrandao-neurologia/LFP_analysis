/* stats/events.js — média alinhada a evento e permutação (stats)
   Gerado do refactor modular (Prompt 0.1). Ver docs/arquitetura.md. */

import { mean, median, quantile } from './descriptive.js';

export function eventAligned(rows, eventTimes, preMin, postMin, binMin, normalize) {
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

export function permutationTest(a, b, nPerm) {
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

/* permutationTwoSample(a, b, opts) — versão reprodutível de `permutationTest`.

   Duas diferenças que importam. Primeira: quando o número de partições
   possíveis é pequeno (poucos dias de diário, que é o caso típico), o teste é
   ENUMERADO por inteiro — o p é exato, não uma estimativa de Monte Carlo.
   Segunda: quando não é, o sorteio usa semente fixa, e a semente sai no
   resultado; sem isso o mesmo dado dá p diferente a cada abertura da página, e
   o manifesto de proveniência deixa de fechar.

   Referência: Ernst MD. Stat Sci 2004;19:676-85 (testes de permutação).     */
export function permutationTwoSample(a, b, opts) {
  opts = opts || {};
  const A = (a || []).filter(isFinite), B = (b || []).filter(isFinite);
  const n = A.length, m = B.length;
  if (n < 2 || m < 2) return { p: NaN, reason: 'menos de 2 observações em um dos grupos', nPermutations: 0, exact: false };
  const pool = A.concat(B), N = n + m;
  const obs = Math.abs(mean(A) - mean(B));
  const somaPool = pool.reduce((x, y) => x + y, 0);
  /* estatística a partir da soma do primeiro grupo: evita refazer as médias */
  const dif = sA => Math.abs(sA / n - (somaPool - sA) / m);
  const maxExato = opts.maxExact || 30000;
  let combos = 1;
  for (let i = 0; i < n && combos <= maxExato; i++) combos = combos * (N - i) / (i + 1);
  combos = Math.round(combos);

  if (combos <= maxExato) {
    let conta = 0, total = 0;
    const idx = new Array(n);
    const anda = (inicio, prof, soma) => {
      if (prof === n) { total++; if (dif(soma) >= obs - 1e-12) conta++; return; }
      for (let i = inicio; i <= N - (n - prof); i++) anda(i + 1, prof + 1, soma + pool[i]);
    };
    anda(0, 0, 0);
    return { observed: +obs.toFixed(6), p: +(conta / total).toFixed(6), nPermutations: total, exact: true, seed: null };
  }
  const nPerm = opts.nPermutations || 10000;
  let semente = isFinite(opts.seed) ? (opts.seed >>> 0) : 20240517;
  const prox = () => { semente = (Math.imul(semente, 1664525) + 1013904223) >>> 0; return semente / 4294967296; };
  const s = pool.slice();
  let conta = 0;
  for (let k = 0; k < nPerm; k++) {
    for (let j = N - 1; j > 0; j--) { const i = (prox() * (j + 1)) | 0; const tmp = s[j]; s[j] = s[i]; s[i] = tmp; }
    let soma = 0; for (let i = 0; i < n; i++) soma += s[i];
    if (dif(soma) >= obs - 1e-12) conta++;
  }
  return {
    observed: +obs.toFixed(6), p: +((conta + 1) / (nPerm + 1)).toFixed(6),
    nPermutations: nPerm, exact: false, seed: isFinite(opts.seed) ? (opts.seed >>> 0) : 20240517
  };
}

/* ECDF e proporções vs limiares de aDBS */
