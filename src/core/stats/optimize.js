/* stats/optimize.js — otimização não linear compartilhada.

   Estava dentro de `adbs/doseresponse.js`, mas o specparam completo (Onda 3)
   precisa do mesmo ajustador, e `dsp` não pode importar `adbs`. Vive aqui, na
   camada que ambos podem importar.

   Referência: Marquardt DW. J Soc Ind Appl Math 1963;11:431-441.            */

import { mean } from './descriptive.js';

/* Resolve A·δ = b por Gauss-Jordan com pivoteamento parcial (matrizes
   pequenas, ≤ ~12 parâmetros). Devolve null se singular.                    */
export function solveGaussJordan(A, b) {
  const n = b.length;
  const M = A.map((linha, i) => Array.prototype.slice.call(linha, 0, n).concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    for (let j = c; j <= n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) {
      const f = M[r][c];
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map(l => l[n]);
}

/* Levenberg-Marquardt com Jacobiano numérico por diferenças centrais.

   `modelo(x, p)` devolve o valor previsto. `opts.lower` e `opts.upper` são
   vetores opcionais de LIMITES por parâmetro — o specparam precisa deles para
   impedir que um pico "gaussiano" engula toda a banda. Os limites são aplicados
   por projeção após cada passo aceito.

   Saída: { params, sse, mse, r2, iterations, converged }.                    */
export function levenbergMarquardt(x, y, modelo, p0, opts) {
  opts = opts || {};
  const maxIter = opts.maxIter || 200;
  const tol = opts.tol || 1e-10;
  const lo = opts.lower || null, hi = opts.upper || null;
  const limita = p => {
    if (!lo && !hi) return p;
    return p.map((v, i) => {
      if (lo && isFinite(lo[i])) v = Math.max(lo[i], v);
      if (hi && isFinite(hi[i])) v = Math.min(hi[i], v);
      return v;
    });
  };
  let p = limita(p0.slice()), lambda = opts.lambda0 || 1e-3;
  const n = x.length, k = p.length;
  const sse = par => {
    let s = 0;
    for (let i = 0; i < n; i++) { const r = y[i] - modelo(x[i], par); s += r * r; }
    return s;
  };
  let erro = sse(p);
  let iter = 0, convergiu = false;
  for (; iter < maxIter; iter++) {
    const J = [];
    for (let i = 0; i < n; i++) {
      const linha = new Array(k);
      for (let j = 0; j < k; j++) {
        const h = Math.max(1e-7, Math.abs(p[j]) * 1e-6);
        const pm = p.slice(), pp = p.slice();
        pm[j] -= h; pp[j] += h;
        linha[j] = (modelo(x[i], pp) - modelo(x[i], pm)) / (2 * h);
      }
      J.push(linha);
    }
    const JtJ = Array.from({ length: k }, () => new Array(k).fill(0));
    const Jtr = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const r = y[i] - modelo(x[i], p);
      for (let a = 0; a < k; a++) {
        Jtr[a] += J[i][a] * r;
        for (let b = 0; b < k; b++) JtJ[a][b] += J[i][a] * J[i][b];
      }
    }
    const A = JtJ.map((l, i) => l.map((v, j) => i === j ? v * (1 + lambda) : v));
    const delta = solveGaussJordan(A, Jtr);
    if (!delta) break;
    const novo = limita(p.map((v, i) => v + delta[i]));
    const erroNovo = sse(novo);
    if (erroNovo < erro) {
      const ganho = (erro - erroNovo) / (erro || 1);
      p = novo; erro = erroNovo; lambda = Math.max(1e-9, lambda / 3);
      if (ganho < tol) { convergiu = true; break; }
    } else {
      lambda *= 4;
      if (lambda > 1e10) break;
    }
  }
  const my = mean(y);
  const sst = y.reduce((a, v) => a + (v - my) * (v - my), 0);
  return {
    params: p, sse: erro, mse: erro / n,
    r2: sst > 0 ? 1 - erro / sst : NaN,
    iterations: iter, converged: convergiu
  };
}
