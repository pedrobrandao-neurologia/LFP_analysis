/* stats/cluster.js — teste de permutação por CLUSTER.

   O PROBLEMA QUE ELE RESOLVE. Comparar dois grupos ponto a ponto ao longo de
   uma série (48 bins de hora do dia, 24 janelas em torno de um evento, 100 bins
   de frequência) gera dezenas de testes. Corrigir cada um por Bonferroni destrói
   o poder; não corrigir produz "achados" onde só há ruído. O teste por cluster
   resolve isso trocando a unidade de inferência: em vez de perguntar "este bin
   difere?", pergunta "existe uma REGIÃO CONTÍGUA de diferença maior do que o
   acaso produziria?". É o padrão em eletrofisiologia desde Maris & Oostenveld.

   COMO FUNCIONA
     1. estatística ponto a ponto (t de Welch, ou t de uma amostra no caso
        pareado);
     2. limiar de formação de cluster — pontos acima dele viram candidatos;
     3. massa do cluster = soma das estatísticas dentro de cada região contígua;
     4. o rótulo de grupo é permutado (ou o sinal, no caso pareado) muitas vezes,
        e a MAIOR massa de cada permutação forma o nulo;
     5. p de cada cluster = fração de permutações cuja maior massa iguala ou
        supera a massa observada.

   O QUE ESTE TESTE NÃO DIZ — e a literatura erra isso o tempo todo: ele NÃO
   localiza o efeito. Um cluster significativo diz que existe diferença em algum
   lugar dentro dele, não que ela vale para cada ponto seu, nem que as bordas do
   cluster são as bordas do efeito. A saída registra essa ressalva junto do p.

   Reprodutibilidade: permutações com gerador de semente fixa.

   Referências:
     Maris E, Oostenveld R. J Neurosci Methods 2007;164:177-190.
     Sassenhagen J, Draschkow D. Psychophysiology 2019;56:e13335 (o que o
       teste NÃO permite concluir).                                          */

import { mean, variance } from './descriptive.js';

/* t de Welch entre dois vetores. */
function tWelch(a, b) {
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return NaN;
  const va = variance(a) / na, vb = variance(b) / nb;
  const den = Math.sqrt(va + vb);
  return den > 0 ? (mean(a) - mean(b)) / den : NaN;
}

/* t de uma amostra (caso pareado: diferenças). */
function tUmaAmostra(d) {
  const n = d.length;
  if (n < 2) return NaN;
  const s = Math.sqrt(variance(d) / n);
  return s > 0 ? mean(d) / s : NaN;
}

/* Junta pontos contíguos acima do limiar em clusters, com a massa somada. */
function agrupa(stat, limiar) {
  const clusters = [];
  let ini = -1, sinal = 0;
  for (let i = 0; i <= stat.length; i++) {
    const v = i < stat.length ? stat[i] : NaN;
    const acima = isFinite(v) && Math.abs(v) >= limiar;
    const s = acima ? Math.sign(v) : 0;
    if (ini < 0 && acima) { ini = i; sinal = s; }
    else if (ini >= 0 && (!acima || s !== sinal)) {
      let massa = 0;
      for (let k = ini; k < i; k++) massa += stat[k];
      clusters.push({ startIdx: ini, endIdx: i - 1, size: i - ini, mass: massa, direction: sinal > 0 ? 'maior' : 'menor' });
      ini = acima ? i : -1; sinal = s;
    }
  }
  return clusters;
}

/* clusterPermutation(A, B, opts)
   A e B: matrizes [n_ensaios][n_pontos]. Se `paired`, A e B têm o mesmo n e o
   teste é sobre as diferenças, permutando SINAIS.                            */
export function clusterPermutation(A, B, opts) {
  opts = opts || {};
  const nPerm = opts.nPermutations == null ? 2000 : opts.nPermutations;
  const pareado = !!opts.paired;
  const alpha = isFinite(opts.alpha) ? opts.alpha : 0.05;
  const limiar = isFinite(opts.clusterThreshold) ? opts.clusterThreshold : 2.0;
  if (!A || !A.length || !B || !B.length) return null;
  const nPontos = A[0].length;
  if (!nPontos || B[0].length !== nPontos) return null;
  if (pareado && A.length !== B.length) return null;

  const estatistica = (grupoA, grupoB) => {
    const out = new Float64Array(nPontos);
    for (let p = 0; p < nPontos; p++) {
      if (pareado) {
        const d = [];
        for (let i = 0; i < grupoA.length; i++) {
          const x = grupoA[i][p], y = grupoB[i][p];
          if (isFinite(x) && isFinite(y)) d.push(x - y);
        }
        out[p] = d.length >= 2 ? tUmaAmostra(d) : NaN;
      } else {
        const a = [], b = [];
        for (let i = 0; i < grupoA.length; i++) if (isFinite(grupoA[i][p])) a.push(grupoA[i][p]);
        for (let i = 0; i < grupoB.length; i++) if (isFinite(grupoB[i][p])) b.push(grupoB[i][p]);
        out[p] = (a.length >= 2 && b.length >= 2) ? tWelch(a, b) : NaN;
      }
    }
    return out;
  };

  const obsStat = estatistica(A, B);
  const obsClusters = agrupa(obsStat, limiar);
  if (!obsClusters.length) return {
    clusters: [], stat: Array.from(obsStat), nPermutations: 0,
    clusterThreshold: limiar, alpha, paired: pareado,
    anySignificant: false,
    reason: `nenhum ponto atingiu o limiar de formação de cluster (|t| ≥ ${limiar}) — ` +
      'sem cluster candidato não há o que testar'
  };

  let semente = isFinite(opts.seed) ? (opts.seed >>> 0) : 19730321;
  const prox = () => { semente = (Math.imul(semente, 1664525) + 1013904223) >>> 0; return semente / 4294967296; };

  const nulo = [];
  const todos = pareado ? null : A.concat(B);
  for (let perm = 0; perm < nPerm; perm++) {
    let sa, sb;
    if (pareado) {
      sa = []; sb = [];
      for (let i = 0; i < A.length; i++) {
        if (prox() < 0.5) { sa.push(A[i]); sb.push(B[i]); } else { sa.push(B[i]); sb.push(A[i]); }
      }
    } else {
      const idx = todos.map((_, i) => i);
      for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(prox() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      sa = idx.slice(0, A.length).map(i => todos[i]);
      sb = idx.slice(A.length).map(i => todos[i]);
    }
    const cl = agrupa(estatistica(sa, sb), limiar);
    nulo.push(cl.length ? Math.max.apply(null, cl.map(c => Math.abs(c.mass))) : 0);
  }

  const clusters = obsClusters.map(c => {
    const p = (nulo.filter(v => v >= Math.abs(c.mass)).length + 1) / (nulo.length + 1);
    return Object.assign({}, c, {
      mass: +c.mass.toFixed(4),
      p: +p.toFixed(4), significant: p < alpha
    });
  }).sort((a, b) => Math.abs(b.mass) - Math.abs(a.mass));

  return {
    clusters, stat: Array.from(obsStat).map(v => isFinite(v) ? +v.toFixed(4) : NaN),
    nPermutations: nulo.length, clusterThreshold: limiar, alpha, paired: pareado,
    seed: isFinite(opts.seed) ? (opts.seed >>> 0) : 19730321,
    nullMaxMassP95: +(nulo.slice().sort((a, b) => a - b)[Math.floor(nulo.length * 0.95)] || 0).toFixed(4),
    anySignificant: clusters.some(c => c.significant),
    caveat: 'um cluster significativo indica que existe diferença EM ALGUM LUGAR dentro dele. Não ' +
      'autoriza afirmar que a diferença vale para cada ponto do cluster, nem que as bordas do cluster ' +
      'são as bordas do efeito (Sassenhagen & Draschkow 2019).'
  };
}
