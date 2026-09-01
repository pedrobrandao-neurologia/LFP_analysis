/* metrics/chronotype.js — o pipeline de referência do cronotipo do beta (metrics)

   Implementação passo a passo do procedimento de van Rheede et al., npj
   Parkinsons Dis 2022;8:88 (doi:10.1038/s41531-022-00350-7) — o padrão
   informal da área para responder "existe ritmo diurno do biomarcador sob DBS
   contínua?" com o Timeline crônico. A toolbox original é a Circa Diem
   (MATLAB, doi:10.5281/zenodo.5961105); aqui os mesmos passos rodam no
   navegador, sem dependências, com semente determinística.

   Os passos (numeração do artigo):
     3. Outliers: |z| > 6 substituídos por interpolação linear entre vizinhos,
        ITERATIVAMENTE, até nenhum exceder. A interpolação é do método
        publicado; a contagem e as posições são exportadas — nada é silencioso.
     4. Detrending: cada valor dividido pela MEDIANA do próprio dia (mediana
        diária vira 1). Remove deriva de semanas, preserva o padrão intradiário.
     5. Ajuste por hora do dia: bins de 30 min; média por bin; valores entre
        centros por interpolação linear circular.
     6. Variância explicada: VE = (VarTot − VarResid)/VarTot.
     7. Permutação circular por dia (1000×): cada dia recebe um deslocamento
        circular aleatório de 0–24 h — preserva a autocorrelação intradiária,
        destrói só o alinhamento entre dias. p = (1+#nulos≥obs)/(1+n).
     8. Especificidade de banda: correlação entre as séries destendidas dos
        dois hemisférios — correlação alta sugere artefato de banda larga
        comum (no artigo original: −0,24 a 0,61, média 0,18 ± 0,36).
     9. VE dentro da vigília (08–20 h) e dentro do sono (00–06 h), separadas
        (no artigo: 0,13 ± 0,11 e 0,14 ± 0,13).

   Extensão recomendada pelo próprio artigo (§4.2 da revisão): inspecionar a
   DISTRIBUIÇÃO diurna — bimodalidade forte é assinatura de contaminação por
   discinesia (movimento sustentado dentro da janela de 10 min).

   Unidades: entrada em potência LFP nativa; saída em frações (VE 0–1) e na
   escala destendida (mediana diária = 1).                                   */

import { localHour, localDayKey } from '../io/parse.js';
import { mean, median, variance, bimodalityCoefficient, pearson } from '../stats/descriptive.js';
import { tidalRng, fitGMM1D, ashmanD } from './tidal.js';

export const CHRONOTYPE_VERSION = '1.0';

export const CHRONOTYPE_REFS = [
  { key: 'vanrheede2022', doi: '10.1038/s41531-022-00350-7', note: 'pipeline-fonte: VE da hora do dia 41±9%; permutação circular por dia; especificidade beta vs teta; alerta de bimodalidade por discinesia' },
  { key: 'circadiem', doi: '10.5281/zenodo.5961105', note: 'Circa Diem — toolbox MATLAB original do pipeline' },
  { key: 'yin2023', doi: '10.1038/s41467-023-41128-6', note: 'no GPi o beta se sustenta no sono — o cronotipo é dependente de alvo' }
];

export const CHRONOTYPE_DEFAULTS = {
  zThreshold: 6,        /* |z| do passo 3 */
  maxIterations: 20,    /* trava do laço iterativo */
  binMinutes: 30,       /* passo 5 */
  nPermutations: 1000,  /* passo 7 */
  seed: 42,
  wakeWindow: [8, 20],  /* passo 9 — as janelas do artigo */
  sleepWindow: [0, 6],
  highCorrWarn: 0.7     /* passo 8: acima disso, suspeita de artefato comum */
};

/* iterativeOutlierClean(values, opts) — passo 3.
   Substitui |z|>6 por interpolação linear entre os vizinhos FINITOS mais
   próximos e repete até estabilizar. NaN pré-existente (perda/censura) NÃO é
   tocado — perda continua perda. Devolve contagem, posições e iterações.    */
export function iterativeOutlierClean(values, opts) {
  const o = opts || {};
  const zThr = isFinite(o.zThreshold) ? o.zThreshold : CHRONOTYPE_DEFAULTS.zThreshold;
  const maxIt = isFinite(o.maxIterations) ? o.maxIterations : CHRONOTYPE_DEFAULTS.maxIterations;
  const x = Array.from(values, v => isFinite(v) ? v : NaN);
  const replaced = new Set();
  let iterations = 0;
  for (let it = 0; it < maxIt; it++) {
    iterations = it;
    const fin = x.filter(isFinite);
    if (fin.length < 4) break;
    const mu = mean(fin);
    const sd = Math.sqrt(variance(fin));
    if (!(sd > 0)) break;
    const maus = [];
    x.forEach((v, i) => { if (isFinite(v) && Math.abs((v - mu) / sd) > zThr) maus.push(i); });
    if (!maus.length) break;
    maus.forEach(i => {
      let a = i - 1; while (a >= 0 && (!isFinite(x[a]) || maus.indexOf(a) >= 0)) a--;
      let b = i + 1; while (b < x.length && (!isFinite(x[b]) || maus.indexOf(b) >= 0)) b++;
      const va = a >= 0 ? x[a] : NaN, vb = b < x.length ? x[b] : NaN;
      x[i] = isFinite(va) && isFinite(vb) ? va + (vb - va) * (i - a) / (b - a)
        : isFinite(va) ? va : isFinite(vb) ? vb : NaN;
      replaced.add(i);
    });
    iterations = it + 1;
  }
  return {
    x, nReplaced: replaced.size, positions: Array.from(replaced).sort((a, b) => a - b),
    iterations, params: { zThreshold: zThr, method: 'van Rheede 2022 step 3 — iterative |z|>6 with linear interpolation (published method; count exported)' }
  };
}

/* detrendDailyMedian(rows, x, offMin) — passo 4. */
export function detrendDailyMedian(rows, x, offMin) {
  const porDia = new Map();
  rows.forEach((r, i) => {
    if (!isFinite(x[i])) return;
    const dk = localDayKey(r.t, offMin);
    if (!porDia.has(dk)) porDia.set(dk, []);
    porDia.get(dk).push(x[i]);
  });
  const medDia = new Map();
  porDia.forEach((vs, dk) => medDia.set(dk, median(vs)));
  const det = rows.map((r, i) => {
    if (!isFinite(x[i])) return NaN;
    const m = medDia.get(localDayKey(r.t, offMin));
    return m > 0 ? x[i] / m : NaN;
  });
  return { x: det, dayMedians: medDia, nDays: medDia.size };
}

/* binProfile(hours, x, binMin) — passo 5: média por bin de 30 min + ajuste
   por interpolação linear circular entre centros de bins.                   */
export function binProfile(hours, x, binMin) {
  const bm = isFinite(binMin) && binMin > 0 ? binMin : CHRONOTYPE_DEFAULTS.binMinutes;
  const nb = Math.round(1440 / bm);
  const soma = new Float64Array(nb), cont = new Float64Array(nb);
  hours.forEach((h, i) => {
    if (!isFinite(x[i]) || !isFinite(h)) return;
    const b = Math.min(nb - 1, Math.floor(((h % 24) + 24) % 24 * 60 / bm));
    soma[b] += x[i]; cont[b]++;
  });
  const prof = Array.from(soma, (v, b) => cont[b] ? v / cont[b] : NaN);
  const centro = b => (b + 0.5) * bm / 60;
  const at = h => {
    const hh = ((h % 24) + 24) % 24;
    let b0 = Math.floor(hh * 60 / bm - 0.5);
    const b1 = ((b0 + 1) % nb + nb) % nb;
    b0 = ((b0 % nb) + nb) % nb;
    const p0 = prof[b0], p1 = prof[b1];
    if (!isFinite(p0) && !isFinite(p1)) return NaN;
    if (!isFinite(p0)) return p1;
    if (!isFinite(p1)) return p0;
    let c0 = centro(b0);
    let frac = (hh - c0) / (bm / 60);
    frac = ((frac % 1) + 1) % 1;
    return p0 + (p1 - p0) * frac;
  };
  return { profile: prof, counts: Array.from(cont), binMinutes: bm, nBins: nb, at };
}

/* varianceExplained(x, adj) — passo 6. */
export function varianceExplained(x, adj) {
  const pares = [];
  for (let i = 0; i < x.length; i++) if (isFinite(x[i]) && isFinite(adj[i])) pares.push(i);
  if (pares.length < 10) return { ok: false, reason: `apenas ${pares.length} pares válidos` };
  const xv = pares.map(i => x[i]);
  const res = pares.map(i => x[i] - adj[i]);
  const vt = variance(xv), vr = variance(res);
  return { ok: true, ve: vt > 0 ? (vt - vr) / vt : NaN, varTotal: vt, varResidual: vr, n: pares.length };
}

const veDe = (hours, x, binMin) => {
  const bp = binProfile(hours, x, binMin);
  const adj = hours.map(h => bp.at(h));
  return varianceExplained(x, adj);
};

/* circularShuffleTest(hours, dayKeys, x, opts) — passo 7. */
export function circularShuffleTest(hours, dayKeys, x, opts) {
  const o = opts || {};
  const nPerm = isFinite(o.nPermutations) ? Math.max(10, Math.round(o.nPermutations)) : CHRONOTYPE_DEFAULTS.nPermutations;
  const binMin = o.binMinutes || CHRONOTYPE_DEFAULTS.binMinutes;
  const rng = tidalRng(isFinite(o.seed) ? o.seed : CHRONOTYPE_DEFAULTS.seed);
  const obs = veDe(hours, x, binMin);
  if (!obs.ok) return { ok: false, reason: obs.reason };
  const dias = Array.from(new Set(dayKeys));
  let maiores = 0;
  const nulos = [];
  for (let p = 0; p < nPerm; p++) {
    const desloc = new Map();
    dias.forEach(d => desloc.set(d, rng.next() * 24));
    const hp = hours.map((h, i) => (h + desloc.get(dayKeys[i])) % 24);
    const nu = veDe(hp, x, binMin);
    const v = nu.ok ? nu.ve : 0;
    nulos.push(v);
    if (v >= obs.ve) maiores++;
  }
  return {
    ok: true, ve: +obs.ve.toFixed(4), p: +((1 + maiores) / (1 + nPerm)).toFixed(4),
    nPermutations: nPerm, nullMean: +mean(nulos).toFixed(4),
    null95: +nulos.slice().sort((a, b) => a - b)[Math.floor(0.95 * nulos.length)].toFixed(4),
    method: 'circular per-day shift, 0–24 h uniform (van Rheede 2022 step 7); deterministic seed'
  };
}

/* diurnalBimodalityFlag(hours, x, wakeWindow) — a inspeção de distribuição
   que o artigo recomenda: bimodalidade forte da distribuição de VIGÍLIA é a
   assinatura da contaminação por discinesia (movimento sustentado dentro da
   janela de 10 min). Critério: BC de Sarle > 0,555 E d de Ashman > 2 no GMM
   de 2 componentes — os dois limiares canônicos, declarados.                */
export function diurnalBimodalityFlag(hours, x, wakeWindow) {
  const w = wakeWindow || CHRONOTYPE_DEFAULTS.wakeWindow;
  const dia = [];
  hours.forEach((h, i) => { if (isFinite(x[i]) && h >= w[0] && h < w[1]) dia.push(x[i]); });
  if (dia.length < 50) return { ok: false, reason: `apenas ${dia.length} amostras de vigília` };
  const bc = bimodalityCoefficient(dia);
  const g = fitGMM1D(dia, 2);
  const d = ashmanD(g);
  const flag = isFinite(bc) && bc > 0.555 && isFinite(d) && d > 2;
  return {
    ok: true, flag, sarleBC: +bc.toFixed(3), ashmanD: isFinite(d) ? +d.toFixed(2) : NaN,
    n: dia.length, wakeWindow: w.slice(),
    reading: flag
      ? 'distribuição diurna FORTEMENTE BIMODAL — assinatura de contaminação por movimento sustentado ' +
        '(discinesia) dentro das janelas de 10 min (van Rheede 2022): o valor medido em consultório pode ficar ' +
        'abaixo da maioria dos valores domiciliares, e limiares de aDBS fixados nesta distribuição são suspeitos'
      : 'sem bimodalidade forte na distribuição diurna — sem assinatura de contaminação sustentada por movimento'
  };
}

/* bandSpecificityCheck(rowsA, xA, rowsB, xB) — passo 8: correlação das duas
   séries destendidas em timestamps coincidentes. Correlação alta sugere fonte
   comum de banda larga (artefato); no artigo original, série beta × teta
   contralateral correlacionou −0,24 a 0,61 (média 0,18 ± 0,36).             */
export function bandSpecificityCheck(rowsA, xA, rowsB, xB, opts) {
  const o = opts || {};
  const warn = isFinite(o.highCorrWarn) ? o.highCorrWarn : CHRONOTYPE_DEFAULTS.highCorrWarn;
  const porT = new Map();
  rowsB.forEach((r, i) => { if (isFinite(xB[i])) porT.set(Math.round(r.t / 60000), xB[i]); });
  const a = [], b = [];
  rowsA.forEach((r, i) => {
    if (!isFinite(xA[i])) return;
    const v = porT.get(Math.round(r.t / 60000));
    if (v !== undefined) { a.push(xA[i]); b.push(v); }
  });
  if (a.length < 50) return { ok: false, reason: `apenas ${a.length} timestamps coincidentes` };
  const r = pearson(a, b);
  return {
    ok: true, r: +r.toFixed(3), n: a.length, suspicious: isFinite(r) && Math.abs(r) > warn,
    published: 'van Rheede 2022: −0,24 a 0,61 (média 0,18 ± 0,36) entre beta e teta contralateral',
    reading: Math.abs(r) > warn
      ? `correlação inter-hemisférica |r| = ${Math.abs(r).toFixed(2)} > ${warn} — as duas séries sobem e descem juntas, ` +
        'o que sugere fonte comum de banda larga (movimento/ECG) em vez de fisiologia específica da banda'
      : 'correlação inter-hemisférica dentro da faixa publicada — compatível com origem fisiológica específica da banda'
  };
}

/* chronotypePipeline(rows, offMin, opts) — o orquestrador dos passos 3–9.
   rows: [{t, lfp}] nativos (censura/perda já NaN).                          */
export function chronotypePipeline(rows, offMin, opts) {
  const o = Object.assign({}, CHRONOTYPE_DEFAULTS, opts || {});
  const src = (rows || []).filter(r => r && isFinite(r.t)).slice().sort((a, b) => a.t - b.t);
  if (src.length < 144) return { ok: false, reason: `apenas ${src.length} amostras — menos de um dia de Timeline` };
  const bruto = src.map(r => isFinite(r.lfp) && r.lfp >= 0 ? r.lfp : NaN);

  const cl = iterativeOutlierClean(bruto, o);                       /* passo 3 */
  const dt = detrendDailyMedian(src, cl.x, offMin);                 /* passo 4 */
  if (dt.nDays < 3) return { ok: false, reason: `apenas ${dt.nDays} dia(s) — o padrão intradiário exige ≥3` };
  const hours = src.map(r => localHour(r.t, offMin));
  const dayKeys = src.map(r => localDayKey(r.t, offMin));

  const bp = binProfile(hours, dt.x, o.binMinutes);                 /* passo 5 */
  const adj = hours.map(h => bp.at(h));
  const veTot = varianceExplained(dt.x, adj);                       /* passo 6 */
  const perm = circularShuffleTest(hours, dayKeys, dt.x, o);        /* passo 7 */

  const subVE = (win) => {                                          /* passo 9 */
    const hs = [], xs = [];
    hours.forEach((h, i) => { if (h >= win[0] && h < win[1]) { hs.push(h); xs.push(dt.x[i]); } });
    const r = veDe(hs, xs, o.binMinutes);
    return r.ok ? { ve: +r.ve.toFixed(4), n: r.n, window: win.slice() } : { ve: NaN, n: hs.length, window: win.slice(), reason: r.reason };
  };
  const veDia = subVE(o.wakeWindow);
  const veNoite = subVE(o.sleepWindow);

  const bimod = diurnalBimodalityFlag(hours, dt.x, o.wakeWindow);

  return {
    ok: true,
    outliers: { nReplaced: cl.nReplaced, iterations: cl.iterations, positions: cl.positions, params: cl.params },
    nDays: dt.nDays, nSamples: src.length,
    profile: { hours: Array.from({ length: bp.nBins }, (_, b) => +((b + 0.5) * bp.binMinutes / 60).toFixed(3)), values: bp.profile.map(v => isFinite(v) ? +v.toFixed(4) : NaN), counts: bp.counts, binMinutes: bp.binMinutes },
    ve: veTot.ok ? +veTot.ve.toFixed(4) : NaN,
    permutation: perm,
    veDay: veDia, veNight: veNoite,
    bimodality: bimod,
    detrended: dt.x, hours, dayKeys,
    published: 'van Rheede 2022 (n=6 bilateral): VE 41 ± 9% (p<0,001 em todos); VE só-dia 0,13 ± 0,11; só-noite 0,14 ± 0,13',
    params: {
      zThreshold: o.zThreshold, binMinutes: o.binMinutes, nPermutations: o.nPermutations,
      seed: o.seed, wakeWindow: o.wakeWindow.slice(), sleepWindow: o.sleepWindow.slice(), offMin
    },
    version: CHRONOTYPE_VERSION, refs: CHRONOTYPE_REFS
  };
}

export const CHRONOTYPE = {
  VERSION: CHRONOTYPE_VERSION, REFS: CHRONOTYPE_REFS, DEFAULTS: CHRONOTYPE_DEFAULTS,
  iterativeOutlierClean, detrendDailyMedian, binProfile, varianceExplained,
  circularShuffleTest, diurnalBimodalityFlag, bandSpecificityCheck, chronotypePipeline
};
