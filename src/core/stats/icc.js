/* stats/icc.js — coeficiente de correlação intraclasse (ICC).

   PARA QUE SERVE AQUI. "O pico beta desta pessoa é 21 Hz" só é uma frase útil
   se, medido de novo em outra sessão, der 21 Hz de novo. O ICC responde
   exatamente isso: da variância total observada, quanto é diferença ENTRE
   pessoas e quanto é ruído de medida. Sem ele, uma métrica com boa aparência
   pode não distinguir paciente nenhum.

   QUAL ICC — a escolha muda o número e precisa ser declarada (McGraw & Wong,
   nomenclatura de Shrout & Fleiss):
     • ICC(2,1), concordância absoluta, medida única — as sessões são amostra de
       uma população de sessões possíveis. É o que se quer para test-retest;
     • ICC(3,1), consistência, medida única — trata as sessões como fixas e
       IGNORA diferença sistemática entre elas. Dá número maior; use apenas se a
       calibração entre sessões for irrelevante para a pergunta.
   Os dois saem, para que a escolha fique visível.

   IC de 95% pelo método F clássico. Faixas de interpretação de Koo & Li 2016:
   < 0,5 ruim; 0,5–0,75 moderado; 0,75–0,9 bom; > 0,9 excelente — e o IC importa
   mais que o ponto: com 5 sujeitos o IC costuma ir de "ruim" a "excelente", e
   nesse caso a resposta honesta é "não dá para dizer".

   Entrada: matriz [n sujeitos][k sessões], sem faltantes (linhas incompletas
   são descartadas e contadas).

   Referências:
     Shrout PE, Fleiss JL. Psychol Bull 1979;86:420-428.
     McGraw KO, Wong SP. Psychol Methods 1996;1:30-46.
     Koo TK, Li MY. J Chiropr Med 2016;15:155-163.                            */

import { mean } from './descriptive.js';
import { fPValue } from './distributions.js';

/* Quantil da F por bissecção sobre a cauda — evitamos tabela e dependência. */
function fQuantile(p, df1, df2) {
  if (!(df1 > 0 && df2 > 0)) return NaN;
  let lo = 1e-6, hi = 1e6;
  for (let i = 0; i < 200; i++) {
    const m = Math.sqrt(lo * hi);
    /* fPValue devolve P(F > m); queremos P(F > m) = 1 - p */
    if (fPValue(m, df1, df2) > 1 - p) lo = m; else hi = m;
    if (hi / lo < 1 + 1e-9) break;
  }
  return Math.sqrt(lo * hi);
}

export function icc(matriz, opts) {
  opts = opts || {};
  const alpha = isFinite(opts.alpha) ? opts.alpha : 0.05;
  const bruta = (matriz || []).filter(l => Array.isArray(l) && l.length);
  if (!bruta.length) return null;
  const k = bruta[0].length;
  const linhas = bruta.filter(l => l.length === k && l.every(isFinite));
  const descartadas = bruta.length - linhas.length;
  const n = linhas.length;
  if (n < 3 || k < 2) return {
    ok: false, n, k, nDropped: descartadas,
    reason: `são necessários ao menos 3 sujeitos e 2 sessões completas; há ${n} × ${k}` +
      (descartadas ? ` (${descartadas} linha(s) incompleta(s) descartada(s))` : '')
  };

  const grande = mean(linhas.flat());
  const mediaLinha = linhas.map(l => mean(l));
  const mediaCol = Array.from({ length: k }, (_, j) => mean(linhas.map(l => l[j])));

  let SSR = 0, SSC = 0, SSE = 0;
  for (let i = 0; i < n; i++) SSR += k * (mediaLinha[i] - grande) ** 2;
  for (let j = 0; j < k; j++) SSC += n * (mediaCol[j] - grande) ** 2;
  for (let i = 0; i < n; i++) for (let j = 0; j < k; j++)
    SSE += (linhas[i][j] - mediaLinha[i] - mediaCol[j] + grande) ** 2;

  const MSR = SSR / (n - 1);
  const MSC = k > 1 ? SSC / (k - 1) : 0;
  const MSE = SSE / ((n - 1) * (k - 1));

  /* ICC(2,1): concordância absoluta, efeitos aleatórios */
  const icc21 = (MSR - MSE) / (MSR + (k - 1) * MSE + (k / n) * (MSC - MSE));
  /* ICC(3,1): consistência, efeitos mistos */
  const icc31 = (MSR - MSE) / (MSR + (k - 1) * MSE);

  /* IC do ICC(3,1) — fórmula clássica; usada também como IC de referência do
     (2,1), cuja fórmula exata é mais complexa e cuja diferença é pequena
     quando MSC ≈ MSE. Isso fica DECLARADO. */
  const F = MSR / MSE;
  const fSup = fQuantile(1 - alpha / 2, n - 1, (n - 1) * (k - 1));
  const fInf = fQuantile(1 - alpha / 2, (n - 1) * (k - 1), n - 1);
  const Fl = F / fSup, Fu = F * fInf;
  const lo = (Fl - 1) / (Fl + (k - 1));
  const hi = (Fu - 1) / (Fu + (k - 1));

  const faixa = v => !isFinite(v) ? 'não avaliável'
    : v < 0.5 ? 'ruim' : v < 0.75 ? 'moderado' : v < 0.9 ? 'bom' : 'excelente';
  const larguraIC = hi - lo;

  return {
    ok: true, n, k, nDropped: descartadas,
    icc21: +icc21.toFixed(4), icc31: +icc31.toFixed(4),
    ci95: [+lo.toFixed(4), +hi.toFixed(4)],
    ciMethod: 'F clássico sobre o ICC(3,1); aplicado também como referência ao (2,1)',
    F: +F.toFixed(3), df1: n - 1, df2: (n - 1) * (k - 1),
    p: +fPValue(F, n - 1, (n - 1) * (k - 1)).toExponential(3),
    MSR: +MSR.toFixed(6), MSC: +MSC.toFixed(6), MSE: +MSE.toFixed(6),
    interpretation: faixa(icc21),
    ciSpansCategories: larguraIC > 0.35,
    caveat: larguraIC > 0.35
      ? `o IC de 95% vai de ${lo.toFixed(2)} (${faixa(lo)}) a ${hi.toFixed(2)} (${faixa(hi)}) — com ${n} sujeitos e ` +
        `${k} sessões, o dado NÃO distingue confiabilidade ruim de excelente. Reporte o intervalo, não o ponto`
      : `IC de 95% entre ${lo.toFixed(2)} e ${hi.toFixed(2)}; a estimativa é informativa nesta amostra`,
    note: 'ICC(2,1) trata as sessões como amostra e penaliza diferença sistemática entre elas; ICC(3,1) ' +
      'ignora essa diferença e por isso dá número maior. Para test-retest, o (2,1) é o pertinente.'
  };
}
