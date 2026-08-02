/* artifact/svd.js — decomposição em valores singulares por Jacobi de um lado.

   Escrita do zero (invariante do projeto: zero dependência). O método de Jacobi
   unilateral ortogonaliza pares de colunas por rotações sucessivas até
   convergir; é numericamente estável e adequado às matrizes pequenas deste uso
   (épocas de QRS: algumas centenas de linhas × ~100 colunas).

   Referência do uso: Stam et al., Clin Neurophysiol 2023;146:147-161;
   Vivien et al., npj Parkinsons Dis 2026 (SVD é o método recomendado, com mais
   de um componente quando a contaminação é alta).                            */

/* svdJacobi(rows) → { U, S, V, m, n }
   `rows` é um array de m arrays de comprimento n (matriz densa).
   A = U · diag(S) · Vᵀ, com S em ordem decrescente.                          */
export function svdJacobi(rows, opts) {
  opts = opts || {};
  const maxSweeps = opts.maxSweeps || 30;
  const eps = opts.eps || 1e-12;
  const m0 = rows.length, n0 = rows[0] ? rows[0].length : 0;
  if (!m0 || !n0) return null;

  /* Jacobi unilateral exige m ≥ n; se não for o caso, decompõe a transposta e
     troca os papéis de U e V no final. */
  const transposta = m0 < n0;
  const m = transposta ? n0 : m0, n = transposta ? m0 : n0;
  const U = [];
  for (let i = 0; i < m; i++) {
    const lin = new Float64Array(n);
    for (let j = 0; j < n; j++) lin[j] = transposta ? rows[j][i] : rows[i][j];
    U.push(lin);
  }
  const V = [];
  for (let i = 0; i < n; i++) { const l = new Float64Array(n); l[i] = 1; V.push(l); }

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        let alpha = 0, beta = 0, gamma = 0;
        for (let k = 0; k < m; k++) {
          alpha += U[k][i] * U[k][i];
          beta += U[k][j] * U[k][j];
          gamma += U[k][i] * U[k][j];
        }
        if (Math.abs(gamma) <= eps * Math.sqrt(alpha * beta) || gamma === 0) continue;
        off += gamma * gamma;
        const zeta = (beta - alpha) / (2 * gamma);
        const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t), s = c * t;
        for (let k = 0; k < m; k++) {
          const a = U[k][i], b = U[k][j];
          U[k][i] = c * a - s * b; U[k][j] = s * a + c * b;
        }
        for (let k = 0; k < n; k++) {
          const a = V[k][i], b = V[k][j];
          V[k][i] = c * a - s * b; V[k][j] = s * a + c * b;
        }
      }
    }
    if (off < eps) break;
  }

  /* valores singulares = normas das colunas; normaliza U */
  const S = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    let sq = 0; for (let k = 0; k < m; k++) sq += U[k][j] * U[k][j];
    S[j] = Math.sqrt(sq);
  }
  const ordem = Array.from({ length: n }, (_, j) => j).sort((a, b) => S[b] - S[a]);
  const Ur = [], Vr = [], Sr = new Float64Array(n);
  for (let k = 0; k < m; k++) Ur.push(new Float64Array(n));
  for (let k = 0; k < n; k++) Vr.push(new Float64Array(n));
  ordem.forEach((j, novo) => {
    Sr[novo] = S[j];
    const inv = S[j] > 1e-300 ? 1 / S[j] : 0;
    for (let k = 0; k < m; k++) Ur[k][novo] = U[k][j] * inv;
    for (let k = 0; k < n; k++) Vr[k][novo] = V[k][j];
  });
  return transposta ? { U: Vr, S: Sr, V: Ur, m: m0, n: n0 } : { U: Ur, S: Sr, V: Vr, m: m0, n: n0 };
}

/* Aproximação de posto k: Aₖ = Σ_{i<k} σᵢ · uᵢ · vᵢᵀ.
   É a reconstrução do artefato a partir dos primeiros k componentes.         */
export function lowRankApprox(svd, k) {
  const { U, S, V, m, n } = svd;
  const kk = Math.max(1, Math.min(k, S.length));
  const out = [];
  for (let i = 0; i < m; i++) {
    const lin = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      let acc = 0;
      for (let c = 0; c < kk; c++) acc += U[i][c] * S[c] * V[j][c];
      lin[j] = acc;
    }
    out.push(lin);
  }
  return out;
}
