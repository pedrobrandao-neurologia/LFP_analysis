/* dsp/gamma.js — gama finamente sintonizada e gama entrained em fstim/2.

   DOIS FENÔMENOS DIFERENTES QUE CAEM NA MESMA FAIXA, e confundi-los inverte a
   conclusão clínica:

   1. GAMA FINAMENTE SINTONIZADA (finely-tuned gamma, FTG). Pico estreito,
      tipicamente 60–90 Hz, endógeno. Aparece no estado ON de levodopa e
      acompanha discinesia; é considerado marcador pró-cinético. Não tem
      relação aritmética com a frequência de estimulação.

   2. GAMA ENTRAINED. Sob estimulação a f_stim, a rede pode se enganchar
      exatamente em f_stim/2 — a resposta subarmônica 1:2. O pico aparece
      travado em f_stim/2 (por exemplo 65 Hz com 130 Hz de estimulação), move-se
      quando a frequência de estimulação muda, e NÃO é o mesmo fenômeno que a
      FTG. Reportar entrained como FTG produziria a conclusão errada sobre
      discinesia.

   O discriminador implementado aqui é aritmético e explícito:
     • proximidade a f_stim/2 dentro de uma tolerância;
     • estreiteza do pico (o entrained é muito estreito, Q alto);
     • coincidência com frequências de dobra do aliasing, já tratada em
       qc/harmonics.js.
   Quando a frequência de estimulação é desconhecida, o módulo diz que NÃO É
   POSSÍVEL DISTINGUIR — em vez de escolher a interpretação mais interessante.

   Unidades: f em Hz, potência na unidade do espectro de entrada.

   Referências:
     Swann NC, et al. J Neural Eng 2018;15:046006 (gama entrained a fstim/2).
     Wiest C, et al. Neurobiol Dis 2021;152:105280 (FTG no STN humano).
     Olaru M, et al. eLife 2024;13:e92135 (FTG, discinesia e aDBS).
     Mathiopoulou V, et al. Nat Commun 2025;16:2956.                          */

import { fitAperiodic } from './aperiodic.js';

/* Largura a meia altura de um pico, em Hz, sobre o espectro achatado. */
function larguraMeiaAltura(f, resid, idx) {
  const alvo = resid[idx] / 2;
  let e = idx, d = idx;
  while (e > 0 && resid[e] > alvo) e--;
  while (d < resid.length - 1 && resid[d] > alvo) d++;
  return Math.max(f[1] - f[0], f[d] - f[e]);
}

/* detectGamma(f, p, {stimRateHz, lo, hi, tolHz})
   → { peaks: [...], ftg, entrained, verdict }                               */
export function detectGamma(f, p, opts) {
  opts = opts || {};
  const lo = isFinite(opts.lo) ? opts.lo : 40;
  const hi = isFinite(opts.hi) ? opts.hi : 100;
  const tol = isFinite(opts.tolHz) ? opts.tolHz : 2.5;
  const fstim = isFinite(opts.stimRateHz) && opts.stimRateHz > 0 ? opts.stimRateHz : NaN;
  const meia = isFinite(fstim) ? fstim / 2 : NaN;

  const ap = fitAperiodic(f, p, { fmin: Math.max(2, lo - 30), fmax: Math.min(hi + 20, f[f.length - 1]) });
  if (!ap) return { peaks: [], ftg: null, entrained: null, verdict: 'não avaliável', reason: 'ajuste aperiódico não convergiu' };

  /* picos locais do espectro achatado dentro da faixa */
  const F = ap.f, R = ap.periodic, A = ap.aperiodic;
  const picos = [];
  for (let i = 2; i < F.length - 2; i++) {
    if (F[i] < lo || F[i] > hi) continue;
    if (R[i] > R[i - 1] && R[i] > R[i + 1] && R[i] > R[i - 2] && R[i] > R[i + 2] && R[i] > 0) {
      const bw = larguraMeiaAltura(F, R, i);
      const prom = A[i] > 0 ? R[i] / A[i] : NaN;
      picos.push({
        hz: +F[i].toFixed(3),
        power: R[i],
        prominenceOverAperiodic: isFinite(prom) ? +prom.toFixed(3) : NaN,
        bandwidthHz: +bw.toFixed(3),
        q: bw > 0 ? +(F[i] / bw).toFixed(2) : NaN
      });
    }
  }
  picos.sort((a, b) => b.power - a.power);
  const relevantes = picos.filter(x => x.prominenceOverAperiodic > 0.15).slice(0, 6);

  /* classificação */
  let entrained = null, ftg = null;
  relevantes.forEach(pk => {
    const perto = isFinite(meia) && Math.abs(pk.hz - meia) <= tol;
    if (perto && !entrained) entrained = Object.assign({}, pk, {
      expectedHz: +meia.toFixed(2), deltaHz: +(pk.hz - meia).toFixed(3),
      stimRateHz: fstim
    });
    else if (!perto && !ftg && pk.hz >= 55 && pk.hz <= 95) ftg = Object.assign({}, pk);
  });

  const verdict = !isFinite(fstim)
    ? (relevantes.length
      ? 'indistinguível sem a frequência de estimulação'
      : 'nenhum pico de gama destacado')
    : entrained && ftg ? 'gama entrained e gama finamente sintonizada coexistem'
      : entrained ? 'gama entrained em f_stim/2'
        : ftg ? 'gama finamente sintonizada (endógena)'
          : 'nenhum pico de gama destacado';

  return {
    range: [lo, hi], stimRateHz: isFinite(fstim) ? fstim : null,
    subharmonicHz: isFinite(meia) ? +meia.toFixed(2) : null,
    toleranceHz: tol,
    peaks: relevantes, ftg, entrained, verdict,
    reason: !isFinite(fstim) && relevantes.length
      ? 'há pico(s) na faixa de gama, mas sem a frequência de estimulação no arquivo não é possível dizer se são ' +
        'endógenos ou entrained em f_stim/2 — as duas leituras clínicas são opostas, e por isso nenhuma é afirmada'
      : null,
    clinicalNote: ftg && !entrained
      ? 'gama finamente sintonizada é associada ao estado ON de levodopa e a discinesia; é marcador pró-cinético, ' +
        'não sinal de piora'
      : entrained
        ? 'gama entrained é resposta da rede à própria estimulação (engate 1:2), não ritmo endógeno — ' +
          'não deve ser lida como marcador de estado motor'
        : null
  };
}

/* Confirma o entrainment mudando a frequência de estimulação: se o pico
   ACOMPANHA f_stim/2 entre registros, é entrained; se fica parado, é endógeno.
   `registros`: [{ label, f, p, stimRateHz }].                                */
export function confirmEntrainment(registros, opts) {
  opts = opts || {};
  const lista = (registros || []).filter(r => r && r.f && r.p && isFinite(r.stimRateHz));
  if (lista.length < 2) return {
    conclusive: false,
    reason: 'é preciso ao menos dois registros com frequências de estimulação diferentes para separar ' +
      'gama entrained de gama endógena'
  };
  const taxas = Array.from(new Set(lista.map(r => r.stimRateHz)));
  if (taxas.length < 2) return {
    conclusive: false,
    reason: `os ${lista.length} registros usam a mesma frequência de estimulação (${taxas[0]} Hz) — ` +
      'sem variar f_stim o teste não é possível'
  };
  const linhas = lista.map(r => {
    const g = detectGamma(r.f, r.p, Object.assign({ stimRateHz: r.stimRateHz }, opts));
    const pk = (g.entrained || g.ftg || (g.peaks[0] || null));
    return {
      label: r.label || '', stimRateHz: r.stimRateHz,
      expectedHz: r.stimRateHz / 2,
      observedHz: pk ? pk.hz : NaN,
      deltaHz: pk ? +(pk.hz - r.stimRateHz / 2).toFixed(3) : NaN
    };
  }).filter(l => isFinite(l.observedHz));
  if (linhas.length < 2) return { conclusive: false, reason: 'nem todos os registros têm pico de gama detectável' };

  const desvios = linhas.map(l => Math.abs(l.deltaHz));
  const acompanha = desvios.every(d => d <= (opts.tolHz || 2.5));
  const obs = linhas.map(l => l.observedHz);
  const parado = (Math.max.apply(null, obs) - Math.min.apply(null, obs)) <= (opts.tolHz || 2.5);
  return {
    conclusive: acompanha || parado,
    rows: linhas,
    verdict: acompanha ? 'entrained — o pico acompanha f_stim/2 quando a estimulação muda'
      : parado ? 'endógeno — o pico permanece na mesma frequência apesar da mudança de f_stim'
        : 'inconclusivo — o pico se move, mas não acompanha f_stim/2',
    maxDeviationHz: +Math.max.apply(null, desvios).toFixed(3),
    peakSpreadHz: +(Math.max.apply(null, obs) - Math.min.apply(null, obs)).toFixed(3)
  };
}
