/* stats/changepoint.js — pontos de mudança na série crônica.

   POR QUE ESTE MÓDULO EXISTE. Olhar um Timeline de seis semanas e dizer "o beta
   caiu" é, na maior parte das vezes, descrever ruído. A pergunta correta não é
   se a média do fim é menor que a do começo — é se houve uma MUDANÇA DE NÍVEL
   num instante identificável. É essa distinção que separa evento clínico (troca
   de medicação, reprogramação, intercorrência) de deriva lenta, e as duas coisas
   pedem condutas diferentes.

   O QUE TORNA ISSO DIFÍCIL AQUI. A série de dez minutos do Timeline é
   fortemente autocorrelacionada: valores vizinhos se parecem porque o processo
   é lento, não porque haja estrutura. Um teste de mudança de média aplicado
   ingenuamente a ruído AR(1) puro encontra pontos de mudança com facilidade
   embaraçosa — e eles não existem. Por isso:

     · a permutação padrão em `changePointsInTime` é POR BLOCOS, que preserva a
       autocorrelação dentro do bloco e só destrói a posição dele na série;
     · a agregação padrão é por dia, o que reduz a autocorrelação de dez minutos
       a uma escala em que ela é fraca;
     · a permutação simples continua disponível, e a saída declara qual foi
       usada e por quê ela é anticonservadora.

   O QUE O MÓDULO NÃO FAZ. Não estabelece causa. Um ponto de mudança que cai no
   mesmo dia de uma reprogramação é compatível com a reprogramação tê-lo causado,
   com ela ter sido feita POR CAUSA de uma piora já em curso, e com coincidência.
   `annotateChangePoints` associa e diz exatamente isso.

   Unidades: entrada na unidade de potência do arquivo; `t` em epoch ms;
   `delta` na unidade de entrada; `pctChange` em porcento.

   Referências:
     Page ES. Continuous inspection schemes. Biometrika 1954;41:100-15 (CUSUM).
     Killick R, Fearnhead P, Eckley IA. Optimal detection of changepoints with a
       linear computational cost. J Am Stat Assoc 2012;107:1590-8 (PELT, e a
       discussão de penalização que a segmentação binária aqui aproxima).      */

import { median, mean } from './descriptive.js';
import { localDayKey } from '../io/parse.js';

/* Estatística de mudança de média no ponto k: diferença padronizada entre os
   dois lados, ponderada pelos tamanhos. É a forma do CUSUM de duas amostras. */
function cpEstatistica(v, a, b) {
  const n = b - a;
  if (n < 4) return { k: -1, stat: 0 };
  let melhor = -1, melhorStat = 0;
  const total = v.slice(a, b).reduce((x, y) => x + y, 0);
  let esq = 0;
  for (let k = a; k < b - 1; k++) {
    esq += v[k];
    const nE = k - a + 1, nD = b - (k + 1);
    if (nE < 2 || nD < 2) continue;
    const mE = esq / nE, mD = (total - esq) / nD;
    /* variância combinada dos dois lados, para não premiar o corte que cai num
       trecho quieto só porque ali a escala é menor */
    let sE = 0, sD = 0;
    for (let i = a; i <= k; i++) sE += (v[i] - mE) * (v[i] - mE);
    for (let i = k + 1; i < b; i++) sD += (v[i] - mD) * (v[i] - mD);
    const pooled = Math.sqrt((sE + sD) / Math.max(1, n - 2));
    if (!(pooled > 0)) continue;
    const stat = Math.abs(mE - mD) / (pooled * Math.sqrt(1 / nE + 1 / nD));
    if (stat > melhorStat) { melhorStat = stat; melhor = k; }
  }
  return { k: melhor, stat: melhorStat };
}

const cpPrng = semente => {
  let s = (isFinite(semente) ? semente : 20240517) >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
};

/* Embaralha a série. `tamBloco > 1` embaralha BLOCOS contíguos, o que preserva
   a autocorrelação dentro do bloco — é o nulo correto para série suave. */
function cpEmbaralha(v, prox, tamBloco) {
  if (!(tamBloco > 1)) {
    const s = v.slice();
    for (let i = s.length - 1; i > 0; i--) { const j = (prox() * (i + 1)) | 0; const tmp = s[i]; s[i] = s[j]; s[j] = tmp; }
    return s;
  }
  const blocos = [];
  for (let i = 0; i < v.length; i += tamBloco) blocos.push(v.slice(i, i + tamBloco));
  for (let i = blocos.length - 1; i > 0; i--) { const j = (prox() * (i + 1)) | 0; const t = blocos[i]; blocos[i] = blocos[j]; blocos[j] = t; }
  return blocos.flat();
}

/* changePoints(y, opts) — segmentação binária recursiva com significância por
   permutação. Devolve os pontos em ordem de posição.                         */
export function changePoints(y, opts) {
  opts = opts || {};
  const minSeg = isFinite(opts.minSegment) ? opts.minSegment : 5;
  const nPerm = isFinite(opts.nPermutations) ? opts.nPermutations : 500;
  const alfa = isFinite(opts.alpha) ? opts.alpha : 0.05;
  const semente = isFinite(opts.seed) ? (opts.seed >>> 0) : 20240517;
  const tamBloco = isFinite(opts.blockPermutation) ? opts.blockPermutation : 0;
  const maxPontos = isFinite(opts.maxPoints) ? opts.maxPoints : 8;

  const bruto = Array.from(y || []);
  const idx = [], v = [];
  bruto.forEach((x, i) => { if (isFinite(x)) { idx.push(i); v.push(x); } });
  const nNaN = bruto.length - v.length;
  const base = {
    penalty: null, minSegment: minSeg, method: 'segmentação binária + CUSUM de duas amostras',
    nPermutations: nPerm, seed: semente, alpha: alfa,
    blockPermutation: tamBloco || null, nValid: v.length, nNaN
  };
  if (v.length < 2 * minSeg + 2) return Object.assign({
    ok: false, points: [], nPoints: 0,
    reason: `só ${v.length} ponto(s) finito(s) — são necessários ao menos ${2 * minSeg + 2} para procurar mudança de nível`
  }, base);

  const prox = cpPrng(semente);
  const pontos = [];
  const fila = [[0, v.length]];
  while (fila.length && pontos.length < maxPontos) {
    const [a, b] = fila.shift();
    if (b - a < 2 * minSeg) continue;
    const { k, stat } = cpEstatistica(v, a, b);
    if (k < 0 || k - a + 1 < minSeg || b - (k + 1) < minSeg) continue;
    /* nulo: a MESMA janela embaralhada, para que o teste responda "este corte é
       melhor do que o melhor corte que o acaso produziria NESTE trecho" */
    const janela = v.slice(a, b);
    let piores = 0;
    for (let p = 0; p < nPerm; p++) {
      const s = cpEmbaralha(janela, prox, tamBloco);
      if (cpEstatistica(s, 0, s.length).stat >= stat) piores++;
    }
    const pval = (piores + 1) / (nPerm + 1);
    if (pval > alfa) continue;
    const mE = mean(v.slice(a, k + 1)), mD = mean(v.slice(k + 1, b));
    pontos.push({
      index: idx[k], indexValid: k, statistic: +stat.toFixed(4), p: +pval.toFixed(4),
      meanBefore: +mE.toFixed(4), meanAfter: +mD.toFixed(4), delta: +(mD - mE).toFixed(4),
      pctChange: mE !== 0 ? +(100 * (mD - mE) / Math.abs(mE)).toFixed(2) : NaN,
      nBefore: k - a + 1, nAfter: b - (k + 1)
    });
    fila.push([a, k + 1]); fila.push([k + 1, b]);
  }
  pontos.sort((x, z) => x.index - z.index);
  return Object.assign({
    ok: true, points: pontos, nPoints: pontos.length, reason: '',
    caveat: tamBloco > 1
      ? `a permutação embaralha blocos de ${tamBloco} pontos, o que preserva a autocorrelação dentro do bloco — é o nulo ` +
        'apropriado para série suave'
      : 'a permutação simples destrói a autocorrelação da série, e por isso é ANTICONSERVADORA em dado suave como o ' +
        'Timeline: ela acha ponto de mudança em ruído AR(1) puro. Use permutação em blocos quando a série não for agregada por dia'
  }, base);
}

/* changePointsInTime(rows, opts) — envelope que agrega o Timeline por dia antes
   de procurar mudança. Agregar reduz a autocorrelação de dez minutos a uma
   escala em que ela é fraca, e é por isso que este é o caminho recomendado.  */
export function changePointsInTime(rows, opts) {
  opts = opts || {};
  const offMin = isFinite(opts.offMin) ? opts.offMin : 0;
  const agregacao = opts.aggregation === 'mean' ? 'mean' : 'median';
  const porDia = {};
  (rows || []).forEach(r => {
    if (!r || !isFinite(r.t) || !isFinite(r.lfp)) return;
    const d = localDayKey(r.t, offMin);
    (porDia[d] = porDia[d] || []).push(r);
  });
  const dias = Object.keys(porDia).sort();
  if (dias.length < 6) return {
    ok: false, points: [], nPoints: 0, aggregation: agregacao,
    reason: `só ${dias.length} dia(s) de registro — procurar mudança de nível em menos de 6 dias produz achado que não se sustenta`
  };
  const serie = dias.map(d => {
    const v = porDia[d].map(r => r.lfp);
    return agregacao === 'mean' ? mean(v) : median(v);
  });
  const cp = changePoints(serie, Object.assign({ blockPermutation: 0 }, opts, { minSegment: opts.minSegment || 3 }));
  if (!cp.ok) return Object.assign({}, cp, { aggregation: agregacao, days: dias });
  const pontos = cp.points.map(p => {
    /* o ponto de mudança fica ENTRE o dia p.index e o seguinte; o instante
       reportado é o início do dia seguinte, que é onde o nível novo começa */
    const diaDepois = dias[Math.min(dias.length - 1, p.index + 1)];
    const t = porDia[diaDepois][0].t;
    return Object.assign({}, p, { t, dayKey: diaDepois, dayBefore: dias[p.index] });
  });
  return Object.assign({}, cp, {
    points: pontos, aggregation: agregacao, days: dias, nDays: dias.length,
    dailyValues: serie.map(x => +x.toFixed(4)),
    binPerDay: dias.map(d => porDia[d].length),
    note: `um valor por dia (${agregacao === 'mean' ? 'média' : 'mediana'} dos pontos do dia); a agregação é declarada porque ` +
      'ela muda o resultado — a mediana resiste a outlier de movimento, a média não'
  });
}

/* annotateChangePoints(points, marcos, opts) — associa cada ponto ao marco
   conhecido mais próximo. Coincidência temporal NÃO estabelece causa, e a
   leitura devolvida diz isso com todas as letras.                           */
export function annotateChangePoints(points, marcos, opts) {
  opts = opts || {};
  const tolDias = isFinite(opts.toleranceDays) ? opts.toleranceDays : 2;
  const tolMs = tolDias * 86400000;
  const lista = (marcos || []).filter(m => m && isFinite(m.t));
  const anotados = (points || []).map(p => {
    let perto = null, dt = Infinity;
    lista.forEach(m => { const d = Math.abs(m.t - p.t); if (d < dt) { dt = d; perto = m; } });
    const explicado = !!perto && dt <= tolMs;
    return Object.assign({}, p, {
      nearestMarker: perto ? perto.label : null,
      nearestMarkerT: perto ? perto.t : NaN,
      deltaDays: perto ? +(( p.t - perto.t) / 86400000).toFixed(2) : NaN,
      explained: explicado
    });
  });
  const nExp = anotados.filter(a => a.explained).length;
  return {
    ok: true, annotated: anotados, nExplained: nExp, nUnexplained: anotados.length - nExp,
    toleranceDays: tolDias, nMarkers: lista.length,
    reading: !anotados.length ? 'nenhuma mudança de nível detectada no período'
      : `${nExp} de ${anotados.length} mudança(s) coincidem, dentro de ${tolDias} dia(s), com um marco conhecido. ` +
        (anotados.length - nExp > 0
          ? `As outras ${anotados.length - nExp} não têm marco correspondente e são as que merecem investigação.`
          : 'Nenhuma ficou sem marco correspondente.'),
    caveat: 'coincidência temporal não estabelece causa. Uma mudança que cai no dia de uma reprogramação é igualmente ' +
      'compatível com a reprogramação tê-la causado, com a reprogramação ter sido feita POR CAUSA de uma piora já em ' +
      'curso, e com acaso — e a ordem dos dois primeiros não é recuperável a partir desta série'
  };
}
