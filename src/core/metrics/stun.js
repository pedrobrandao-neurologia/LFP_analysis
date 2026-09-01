/* metrics/stun.js — janela de estabilização pós-operatória (stun effect)

   Pergunta clínica: A PARTIR DE QUANDO o registro crônico é confiável para
   decisões de programação (seleção de contato, limiares de aDBS)?

   Duas metodologias independentes convergem para ~1 mês:
   • de Neeling et al., Mov Disord 2026;41:222–227 (doi:10.1002/mds.70042):
     análise de change-point sobre a MEDIANA DIÁRIA de potência beta em 32
     pacientes → mudança de regime em 24–40 dias; o beta não cai com a
     ativação da DBS, continua subindo.
   • Feldmann et al., Brain Stimul 2025;18:1579–1586
     (doi:10.1016/j.brs.2025.08.002): taxa de variação diária + quantificação
     de recorrência (RQA: estados de recorrência e laminaridade) em 14
     pacientes → estabilização em 22–29 dias.

   Nuance de interpretação (Darmani et al., Mov Disord 2023;38:232–243,
   doi:10.1002/mds.29276): parte do "aumento de beta" pós-implante pode ser
   deslocamento do componente aperiódico (1/f), não oscilação — e o Timeline,
   que entrega potência em banda de 5 Hz sem espectro, não permite separar os
   dois. A leitura declara essa ambiguidade.

   O que este módulo faz: change-point sobre medianas diárias (reutiliza
   stats/changepoint.js, permutação embutida), taxa de variação diária
   normalizada, RQA simples e determinística sobre a série diária
   (taxa de recorrência, determinismo, laminaridade; ε = 0,2·DP, linha mínima
   2 — parâmetros declarados), e um VEREDITO com data de implante quando
   disponível no JSON (DeviceInformation.ImplantDate).                       */

import { localDayKey } from '../io/parse.js';
import { mean, median } from '../stats/descriptive.js';
import { changePointsInTime } from '../stats/changepoint.js';

export const STUN_VERSION = '1.0';

export const STUN_REFS = [
  { key: 'deneeling2026', doi: '10.1002/mds.70042', note: 'change-point da mediana diária: regime muda em 24–40 dias pós-implante (n=32)' },
  { key: 'feldmann2025', doi: '10.1016/j.brs.2025.08.002', note: 'taxa de variação + RQA: estabilização em 22–29 dias (n=14)' },
  { key: 'darmani2023', doi: '10.1002/mds.29276', note: 'expoente e offset aperiódicos sobem após o implante — parte do "aumento de beta" pode ser 1/f' }
];

export const STUN_DEFAULTS = {
  literatureWindow: [22, 40],   /* união das duas janelas publicadas, em dias */
  safeDay: 42,                  /* ~6 semanas: fora de ambas as janelas com margem */
  rqaEpsilonSd: 0.2,            /* ε da matriz de recorrência, em DP da série */
  rqaMinLine: 2
};

/* rqa(series, opts) — quantificação de recorrência determinística sobre uma
   série curta (dias). Recorrência: |z_i − z_j| < ε (série normalizada).
   Métricas: recurrenceRate (fração de pares recorrentes), determinism
   (fração dos pontos recorrentes em diagonais ≥ minLine) e laminarity
   (idem em linhas verticais ≥ minLine — tendência a PERMANECER em estados). */
export function rqa(series, opts) {
  const o = opts || {};
  const eps = isFinite(o.epsilonSd) ? o.epsilonSd : STUN_DEFAULTS.rqaEpsilonSd;
  const minL = isFinite(o.minLine) ? o.minLine : STUN_DEFAULTS.rqaMinLine;
  const v = Array.from(series).filter(isFinite);
  const n = v.length;
  if (n < 8) return { ok: false, reason: `apenas ${n} pontos — RQA exige ≥8` };
  const mu = mean(v);
  const sd = Math.sqrt(v.reduce((a, x) => a + (x - mu) * (x - mu), 0) / n);
  if (!(sd > 0)) return { ok: false, reason: 'série constante' };
  const z = v.map(x => (x - mu) / sd);
  const R = [];
  for (let i = 0; i < n; i++) { R.push(new Uint8Array(n)); }
  let nRec = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j) continue;
    if (Math.abs(z[i] - z[j]) < eps) { R[i][j] = 1; nRec++; }
  }
  if (!nRec) return { ok: true, recurrenceRate: 0, determinism: NaN, laminarity: NaN, n, params: { epsilonSd: eps, minLine: minL } };
  /* diagonais (determinismo) */
  let recDiag = 0;
  for (let d = 1; d < n; d++) {
    let run = 0;
    for (let i = 0; i + d < n; i++) {
      if (R[i][i + d]) run++;
      else { if (run >= minL) recDiag += 2 * run; run = 0; }
    }
    if (run >= minL) recDiag += 2 * run;
  }
  /* verticais (laminaridade) */
  let recVert = 0;
  for (let j = 0; j < n; j++) {
    let run = 0;
    for (let i = 0; i < n; i++) {
      if (i !== j && R[i][j]) run++;
      else { if (run >= minL) recVert += run; run = 0; }
    }
    if (run >= minL) recVert += run;
  }
  return {
    ok: true, n,
    recurrenceRate: +(nRec / (n * (n - 1))).toFixed(4),
    determinism: +(Math.min(1, recDiag / nRec)).toFixed(4),
    laminarity: +(Math.min(1, recVert / nRec)).toFixed(4),
    params: { epsilonSd: eps, minLine: minL }
  };
}

/* stunAnalysis(rows, offMin, opts{implantDate}) — o orquestrador. */
export function stunAnalysis(rows, offMin, opts) {
  const o = opts || {};
  const cp = changePointsInTime(rows, { offMin, aggregation: 'median' });
  if (!cp.ok) return { ok: false, reason: cp.reason };
  const dias = cp.days;
  const med = cp.dailyValues;
  const nD = dias.length;

  /* taxa de variação diária, normalizada pela mediana global (Feldmann) */
  const medGlobal = median(med.filter(isFinite));
  const rate = med.map((v, i) => i > 0 && isFinite(v) && isFinite(med[i - 1]) && medGlobal > 0
    ? +(Math.abs(v - med[i - 1]) / medGlobal).toFixed(4) : NaN);
  const meia = Math.floor(nD / 2);
  const rateEarly = mean(rate.slice(1, meia).filter(isFinite));
  const rateLate = mean(rate.slice(meia).filter(isFinite));

  /* RQA nas duas metades — a estabilização de Feldmann é queda e platô */
  const rqaEarly = rqa(med.slice(0, meia), o);
  const rqaLate = rqa(med.slice(meia), o);

  /* dias pós-implante, quando a data existe no JSON */
  const implantMs = o.implantDate ? Date.parse(String(o.implantDate).slice(0, 10) + 'T00:00:00Z') : NaN;
  const diaPosOp = dk => isFinite(implantMs) ? Math.round((Date.parse(dk + 'T00:00:00Z') - implantMs) / 864e5) : NaN;
  const startPostOp = diaPosOp(dias[0]);
  const endPostOp = diaPosOp(dias[nD - 1]);

  const pontos = (cp.points || []).map(p => ({
    dayKey: p.dayKey, index: p.index, p: p.p,
    postOpDay: diaPosOp(p.dayKey),
    levelBefore: +median(med.slice(Math.max(0, p.index - 6), p.index + 1).filter(isFinite)).toFixed(1),
    levelAfter: +median(med.slice(p.index + 1, Math.min(nD, p.index + 8)).filter(isFinite)).toFixed(1)
  }));
  const ultimoCp = pontos.length ? pontos[pontos.length - 1] : null;

  /* veredito */
  const lit = STUN_DEFAULTS.literatureWindow;
  const avisos = [];
  let verdict;
  if (isFinite(startPostOp)) {
    if (startPostOp >= STUN_DEFAULTS.safeDay && !pontos.length) {
      verdict = 'estável';
    } else if (endPostOp < lit[0]) {
      verdict = 'dentro da janela de instabilidade';
      avisos.push(`todo o registro cai antes do dia ${lit[0]} pós-implante — dentro da janela de instabilidade publicada ` +
        `(${lit[0]}–${lit[1]} dias); NÃO fixe contatos nem limiares com este trecho`);
    } else if (ultimoCp && isFinite(ultimoCp.postOpDay)) {
      verdict = ultimoCp.postOpDay <= lit[1] + 7 ? 'estabilização detectada' : 'mudança de regime tardia';
      if (verdict === 'estabilização detectada')
        avisos.push(`mudança de regime no dia ${ultimoCp.postOpDay} pós-implante — compatível com as janelas publicadas ` +
          `(24–40 dias, de Neeling 2026; 22–29, Feldmann 2025); prefira os dias APÓS o change-point para derivar limiares`);
      else avisos.push(`mudança de regime no dia ${ultimoCp.postOpDay} pós-implante, fora da janela do stun effect — ` +
        'procure outra causa (mudança de programação, medicação, evento clínico) antes de atribuir ao implante');
    } else {
      verdict = startPostOp < STUN_DEFAULTS.safeDay ? 'possivelmente instável' : 'estável';
      if (verdict === 'possivelmente instável')
        avisos.push(`o registro começa no dia ${startPostOp} pós-implante, dentro/da borda da janela de instabilidade, ` +
          'e nenhum change-point foi detectado — a estabilização pode ter ocorrido fora do trecho registrado');
    }
  } else {
    verdict = pontos.length ? 'mudança de regime detectada (data de implante desconhecida)' : 'sem mudança de regime detectada';
    avisos.push('sem data de implante no arquivo — informe-a para posicionar o registro em relação à janela de ' +
      'estabilização de 22–40 dias');
  }
  if (isFinite(rateEarly) && isFinite(rateLate) && rateLate < rateEarly * 0.7)
    avisos.push(`taxa de variação diária caiu de ${(100 * rateEarly).toFixed(1)}% para ${(100 * rateLate).toFixed(1)}% da mediana ` +
      'entre a primeira e a segunda metade — sinal convergente de estabilização (Feldmann 2025)');

  return {
    ok: true,
    days: dias, dailyMedians: med, nDays: nD,
    changePoints: pontos, changePointDetail: { method: cp.method, nPermutations: cp.nPermutations, alpha: cp.alpha, seed: cp.seed },
    rate: { series: rate, earlyMean: isFinite(rateEarly) ? +rateEarly.toFixed(4) : NaN, lateMean: isFinite(rateLate) ? +rateLate.toFixed(4) : NaN },
    rqa: { early: rqaEarly, late: rqaLate },
    implant: { date: o.implantDate || null, startPostOpDay: startPostOp, endPostOpDay: endPostOp },
    verdict, warnings: avisos,
    aperiodicCaveat: 'o Timeline entrega potência numa banda de 5 Hz sem o espectro: parte da subida pós-operatória pode ser ' +
      'deslocamento do componente aperiódico (1/f), não oscilação beta (Darmani 2023) — indistinguíveis neste dado',
    literature: { window: lit.slice(), safeDay: STUN_DEFAULTS.safeDay },
    version: STUN_VERSION, refs: STUN_REFS
  };
}

export const STUN = {
  VERSION: STUN_VERSION, REFS: STUN_REFS, DEFAULTS: STUN_DEFAULTS,
  rqa, stunAnalysis
};
