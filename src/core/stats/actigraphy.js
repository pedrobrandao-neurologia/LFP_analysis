/* stats/actigraphy.js — métricas NÃO PARAMÉTRICAS de ritmo, emprestadas da
   cronobiologia da actigrafia.

   POR QUE ESTE MÓDULO EXISTE. O cosinor pressupõe forma senoidal. O ritmo do
   beta subtalâmico frequentemente não é senoidal: sobe rápido ao acordar, tem
   platô, cai por degraus com as tomadas de levodopa e despenca no sono. Ajustar
   uma senoide a isso não erra o sinal de existir ritmo — erra a AMPLITUDE, e
   erra para baixo, porque a senoide não consegue seguir os cantos.

   As métricas não paramétricas que a cronobiologia usa há trinta anos sobre
   actigrafia não fazem essa suposição. Elas se aplicam quase diretamente à
   série de potência do Timeline, porque o objeto é o mesmo: uma variável
   escalar amostrada regularmente ao longo de muitos dias.

   AS QUATRO MEDIDAS, E O QUE CADA UMA RESPONDE
     IS  (interdaily stability)   — o ritmo se repete de um dia para o outro?
                                    Vai de 0 (nenhuma repetição) a 1 (dias idênticos).
     IV  (intradaily variability) — o ritmo é liso ou picado dentro do dia?
                                    Perto de 0 é liso; acima de 1 é fragmentado.
     M10 / L5                     — as 10 h de maior média e as 5 h de menor,
                                    com o horário em que começam.
     RA  (relative amplitude)     — (M10 − L5)/(M10 + L5), a amplitude do ritmo
                                    numa escala que não depende da unidade.

   O QUE ELAS NÃO RESOLVEM. Nenhuma delas testa significância. IS = 0,42 não vem
   com p, e comparar dois pacientes por IS exige um desenho que este módulo não
   provê. Elas descrevem a forma do ritmo; o cosinor (stats/circadian.js) é que
   testa se ele existe.

   Unidades: entrada em ms (t) e na unidade de potência do arquivo (lfp); IS, IV
   e RA são adimensionais; M10 e L5 na unidade de entrada; horários em horas
   locais decimais.

   Referências:
     Witting W, Kwa IH, Eikelenboom P, Mirmiran M, Swaab DF. Alterations in the
       circadian rest-activity rhythm in aging and Alzheimer's disease. Biol
       Psychiatry 1990;27:563-72 (definição de IS e IV).
     Van Someren EJW, Swaab DF, Colenda CC, Cohen W, McCall WV, Rosenquist PB.
       Bright light therapy: improved sensitivity to its effects on rest-activity
       rhythms in Alzheimer patients by application of nonparametric methods.
       Chronobiol Int 1999;16:505-18 (M10, L5 e amplitude relativa).           */

import { localHour, localDayKey } from '../io/parse.js';
import { mean } from './descriptive.js';

/* ------------------------------------------------------------ utilidades -- */

/* Perfil dia × bin, com bins sem amostra ficando NaN. A média de cada bin é a
   estatística de resumo — declarada, porque um resumo não linear (mediana,
   percentil) muda IV, que é uma medida de diferenças de primeira ordem. */
function actGrade(rows, offMin, binMin, minCoverage) {
  const nBins = Math.round(24 * 60 / binMin);
  const porDia = {};
  let nIgnoradas = 0;
  (rows || []).forEach(r => {
    if (!r || !isFinite(r.t) || !isFinite(r.lfp)) { nIgnoradas++; return; }
    const d = localDayKey(r.t, offMin);
    if (!porDia[d]) porDia[d] = Array.from({ length: nBins }, () => []);
    porDia[d][Math.min(nBins - 1, Math.floor(localHour(r.t, offMin) * 60 / binMin))].push(r.lfp);
  });
  const todosDias = Object.keys(porDia).sort();
  const dias = [], matriz = [], cobertura = [];
  const excluidos = [];
  todosDias.forEach(d => {
    const linha = porDia[d].map(b => b.length ? mean(b) : NaN);
    const cob = linha.filter(isFinite).length / nBins;
    if (cob < minCoverage) { excluidos.push({ day: d, coverage: +cob.toFixed(3) }); return; }
    dias.push(d); matriz.push(linha); cobertura.push(cob);
  });
  return { nBins, dias, matriz, cobertura, excluidos, nIgnoradas, nDiasBrutos: todosDias.length };
}

/* Variância populacional de valores finitos; devolve NaN com menos de 2 pontos. */
function actVar(v) {
  const ok = v.filter(isFinite);
  if (ok.length < 2) return NaN;
  const m = mean(ok);
  return ok.reduce((a, x) => a + (x - m) * (x - m), 0) / ok.length;
}

const actOpts = opts => ({
  binMin: (opts && opts.binMin) || 60,
  minCoverage: (opts && isFinite(opts.minCoverage)) ? opts.minCoverage : 0.66,
  minDays: (opts && isFinite(opts.minDays)) ? opts.minDays : 3
});

const actParams = (o, g) => ({
  binMin: o.binMin, minCoverage: o.minCoverage, minDays: o.minDays,
  binStatistic: 'média dos pontos do bin',
  nDaysUsed: g.dias.length, nDaysExcluded: g.excluidos.length,
  excludedDays: g.excluidos, nPointsIgnored: g.nIgnoradas
});

/* -------------------------------------------------- IS — estabilidade ----- */

/* interdailyStability(rows, offMin, opts)

   IS = [ N · Σₕ (x̄ₕ − x̄)² ] / [ P · Σᵢ (xᵢ − x̄)² ]

   onde x̄ₕ é a média do bin h no perfil médio de 24 h, P é o número de bins do
   dia e N o número total de observações. Lê-se: quanto da variância total é
   explicada pelo perfil médio de 24 h. 0 = nenhuma repetição entre dias;
   1 = todos os dias idênticos.                                              */
export function interdailyStability(rows, offMin, opts) {
  const o = actOpts(opts);
  const g = actGrade(rows, offMin, o.binMin, o.minCoverage);
  if (g.dias.length < o.minDays) return {
    ok: false, params: actParams(o, g),
    reason: `só ${g.dias.length} dia(s) com cobertura ≥ ${(o.minCoverage * 100).toFixed(0)}% dos bins — ` +
      `a estabilidade interdiária precisa de ao menos ${o.minDays} dias para significar alguma coisa`
  };
  const todos = g.matriz.flat().filter(isFinite);
  const N = todos.length;
  const media = mean(todos);
  /* perfil médio de 24 h, bin a bin, sobre os dias com dado naquele bin */
  const perfil = [];
  for (let b = 0; b < g.nBins; b++) {
    const col = g.matriz.map(l => l[b]).filter(isFinite);
    perfil.push(col.length ? mean(col) : NaN);
  }
  const perfilOk = perfil.filter(isFinite);
  const P = perfilOk.length;
  const num = N * perfilOk.reduce((a, x) => a + (x - media) * (x - media), 0);
  const den = P * todos.reduce((a, x) => a + (x - media) * (x - media), 0);
  const IS = den > 0 ? num / den : NaN;
  return {
    ok: isFinite(IS), IS: isFinite(IS) ? +IS.toFixed(4) : NaN,
    nDays: g.dias.length, nBinsUsed: P, nObs: N,
    profile: perfil.map(v => isFinite(v) ? +v.toFixed(4) : NaN),
    params: actParams(o, g),
    interpretation: !isFinite(IS) ? 'não estimável'
      : IS >= 0.6 ? 'o perfil de 24 h se repete de forma consistente entre os dias'
        : IS >= 0.3 ? 'há um perfil de 24 h reconhecível, mas com variação apreciável entre dias'
          : 'o perfil muda muito de um dia para o outro — a média de 24 h descreve mal qualquer dia individual',
    caveat: 'IS não vem com valor de p: é descritiva. Ela também sobe artificialmente quando faltam dados de forma ' +
      'sistemática no mesmo horário todo dia, porque a variância total cai',
    reason: ''
  };
}

/* -------------------------------------------------- IV — fragmentação ----- */

/* intradailyVariability(rows, offMin, opts)

   IV = [ n · Σᵢ₌₂ⁿ (xᵢ − xᵢ₋₁)² ] / [ (n − 1) · Σᵢ (xᵢ − x̄)² ]

   Razão entre a variância das diferenças de bins consecutivos e a variância
   total. Perto de 0 o sinal é liso; valores acima de ~1 indicam alternância
   rápida — ritmo fragmentado. A soma percorre a série CONCATENADA em ordem
   temporal, e pares que atravessam uma lacuna são descartados e contados: uma
   diferença calculada por cima de um buraco de seis horas não é uma diferença
   de primeira ordem.                                                        */
export function intradailyVariability(rows, offMin, opts) {
  const o = actOpts(opts);
  const g = actGrade(rows, offMin, o.binMin, o.minCoverage);
  if (g.dias.length < o.minDays) return {
    ok: false, params: actParams(o, g),
    reason: `só ${g.dias.length} dia(s) com cobertura suficiente — a variabilidade intradiária precisa de ao menos ${o.minDays}`
  };
  const serie = g.matriz.flat();
  const todos = serie.filter(isFinite);
  const n = todos.length;
  let somaDif = 0, nPares = 0, nPulados = 0;
  for (let i = 1; i < serie.length; i++) {
    if (!isFinite(serie[i]) || !isFinite(serie[i - 1])) { nPulados++; continue; }
    const d = serie[i] - serie[i - 1];
    somaDif += d * d; nPares++;
  }
  const media = mean(todos);
  const somaVar = todos.reduce((a, x) => a + (x - media) * (x - media), 0);
  /* o denominador usa (n−1) na definição original; com pares descartados por
     lacuna, o numerador é reescalado pelo número de pares realmente somados */
  const IV = (somaVar > 0 && nPares > 0)
    ? (n * (somaDif * (serie.length - 1) / nPares)) / ((n - 1) * somaVar) : NaN;
  return {
    ok: isFinite(IV), IV: isFinite(IV) ? +IV.toFixed(4) : NaN,
    nDays: g.dias.length, nPairs: nPares, nPairsSkipped: nPulados,
    params: actParams(o, g),
    interpretation: !isFinite(IV) ? 'não estimável'
      : IV < 0.5 ? 'a série é lisa dentro do dia — transições graduais'
        : IV < 1 ? 'fragmentação moderada dentro do dia'
          : 'série muito picada: alternância rápida entre valores altos e baixos dentro do mesmo dia',
    caveat: `${nPulados} par(es) de bins consecutivos foram descartados por atravessarem lacuna, e o numerador foi ` +
      'reescalado pelo número de pares efetivamente somados — IV calculado por cima de buracos superestima a fragmentação',
    reason: ''
  };
}

/* ---------------------------------------------- M10, L5 e amplitude ------- */

/* m10l5(rows, offMin, opts)

   M10 é a média da janela CONTÍNUA de 10 h com maior média; L5, a de 5 h com
   menor. RA = (M10 − L5)/(M10 + L5). As janelas são circulares (podem
   atravessar a meia-noite), porque o vale do ritmo humano frequentemente
   atravessa.

   Calculado sobre o perfil médio de 24 h por padrão. Com `perDay`, também dia a
   dia — o que permite ver se a amplitude está caindo ao longo das semanas, que
   é a leitura de habituação.                                                */
export function m10l5(rows, offMin, opts) {
  const o = actOpts(opts);
  const g = actGrade(rows, offMin, o.binMin, o.minCoverage);
  if (g.dias.length < o.minDays) return {
    ok: false, params: actParams(o, g),
    reason: `só ${g.dias.length} dia(s) com cobertura suficiente — M10/L5 precisa de ao menos ${o.minDays}`
  };
  const perfil = [];
  for (let b = 0; b < g.nBins; b++) {
    const col = g.matriz.map(l => l[b]).filter(isFinite);
    perfil.push(col.length ? mean(col) : NaN);
  }
  const janela = (v, horas, procurarMax) => {
    const w = Math.max(1, Math.round(horas * 60 / o.binMin));
    let melhor = NaN, iMelhor = -1;
    for (let i = 0; i < v.length; i++) {
      const seg = [];
      for (let k = 0; k < w; k++) seg.push(v[(i + k) % v.length]);
      const ok = seg.filter(isFinite);
      /* a janela precisa estar quase cheia: uma janela com 3 de 10 bins não é
         comparável com uma cheia, e escolher o máximo entre elas premia a lacuna */
      if (ok.length < w * 0.8) continue;
      const m = mean(ok);
      if (!isFinite(melhor) || (procurarMax ? m > melhor : m < melhor)) { melhor = m; iMelhor = i; }
    }
    return { valor: melhor, inicio: iMelhor >= 0 ? +(iMelhor * o.binMin / 60).toFixed(2) : NaN, nBins: w };
  };
  const M = janela(perfil, 10, true), L = janela(perfil, 5, false);
  const RA = (isFinite(M.valor) && isFinite(L.valor) && (M.valor + L.valor) !== 0)
    ? (M.valor - L.valor) / (M.valor + L.valor) : NaN;

  let porDia = null;
  if (opts && opts.perDay) {
    porDia = g.dias.map((d, i) => {
      const Mi = janela(g.matriz[i], 10, true), Li = janela(g.matriz[i], 5, false);
      const ra = (isFinite(Mi.valor) && isFinite(Li.valor) && (Mi.valor + Li.valor) !== 0)
        ? (Mi.valor - Li.valor) / (Mi.valor + Li.valor) : NaN;
      return {
        day: d, M10: isFinite(Mi.valor) ? +Mi.valor.toFixed(4) : NaN, M10startHour: Mi.inicio,
        L5: isFinite(Li.valor) ? +Li.valor.toFixed(4) : NaN, L5startHour: Li.inicio,
        RA: isFinite(ra) ? +ra.toFixed(4) : NaN
      };
    });
  }
  return {
    ok: isFinite(M.valor) && isFinite(L.valor),
    M10: isFinite(M.valor) ? +M.valor.toFixed(4) : NaN, M10startHour: M.inicio,
    L5: isFinite(L.valor) ? +L.valor.toFixed(4) : NaN, L5startHour: L.inicio,
    RA: isFinite(RA) ? +RA.toFixed(4) : NaN,
    nDays: g.dias.length, perDay: porDia,
    params: Object.assign(actParams(o, g), {
      windowM10Hours: 10, windowL5Hours: 5, circularWindows: true, minWindowFill: 0.8
    }),
    caveat: 'RA é razão entre diferença e soma, e por isso não depende da unidade — mas só é interpretável se a ' +
      'grandeza for estritamente positiva, o que vale para potência e não valeria para uma série já centrada em zero',
    reason: ''
  };
}

/* ---------------------------------------------------------- painel -------- */

export function actigraphyPanel(rows, offMin, opts) {
  const o = actOpts(opts);
  const is = interdailyStability(rows, offMin, opts);
  const iv = intradailyVariability(rows, offMin, opts);
  const ml = m10l5(rows, offMin, opts);
  const ok = is.ok || iv.ok || ml.ok;
  if (!ok) return { ok: false, params: (is.params || iv.params || ml.params), reason: is.reason || iv.reason || ml.reason };
  const partes = [];
  if (is.ok) partes.push(`IS = ${is.IS.toFixed(2)} (${is.interpretation})`);
  if (iv.ok) partes.push(`IV = ${iv.IV.toFixed(2)} (${iv.interpretation})`);
  if (ml.ok) partes.push(`M10 começa às ${ml.M10startHour}h, L5 às ${ml.L5startHour}h, RA = ${ml.RA.toFixed(2)}`);
  return {
    ok: true,
    IS: is.IS, IV: iv.IV, M10: ml.M10, M10startHour: ml.M10startHour,
    L5: ml.L5, L5startHour: ml.L5startHour, RA: ml.RA,
    detail: { interdailyStability: is, intradailyVariability: iv, m10l5: ml },
    params: Object.assign({}, ml.params || is.params || iv.params, { binMin: o.binMin }),
    quality: {
      nDaysUsed: (ml.params || is.params || iv.params).nDaysUsed,
      nDaysExcluded: (ml.params || is.params || iv.params).nDaysExcluded,
      minCoverage: o.minCoverage
    },
    reading: partes.join(' · '),
    caveat: 'estas quatro medidas são DESCRITIVAS: nenhuma delas testa se o ritmo existe. Quem testa é o cosinor, e as ' +
      'duas leituras devem ser reportadas juntas — o cosinor diz se há ritmo, estas dizem que forma ele tem',
    reason: ''
  };
}
