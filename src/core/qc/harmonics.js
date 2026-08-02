/* qc/harmonics.js — harmônicos como critério de artefato, e aliasing da
   frequência de estimulação.

   Referência: Swinnen et al., J Neural Eng 2025;22:014001 (checklist).

   A ideia: uma oscilação neural genuína é aproximadamente senoidal e não
   costuma trazer uma escada de harmônicos acima do fundo aperiódico. Um pico
   que TEM harmônicos é suspeito de origem não oscilatória — tipicamente um
   transiente periódico (estimulação, artefato mecânico) disfarçado de ritmo. */

import { fitAperiodic } from '../dsp/aperiodic.js';

/* Valor do espectro na frequência mais próxima de `alvo`. */
function em(f, p, alvo, tol) {
  let melhor = -1, dist = Infinity;
  for (let i = 0; i < f.length; i++) {
    const d = Math.abs(f[i] - alvo);
    if (d < dist && d <= (tol || 1.5)) { dist = d; melhor = i; }
  }
  return melhor >= 0 ? { f: f[melhor], v: p[melhor], idx: melhor } : null;
}

/* checkHarmonics(f, psd, peakHz, {stimRateHz, fs})
   → { isSuspect, harmonicsFound, ratio, verdict, aliasing }                  */
export function checkHarmonics(f, psd, peakHz, opts) {
  opts = opts || {};
  if (!isFinite(peakHz) || !f || !f.length)
    return { isSuspect: false, harmonicsFound: [], ratio: NaN, verdict: 'não avaliável', reason: 'sem pico informado' };

  /* fundo aperiódico como referência: harmônico só conta se estiver ACIMA dele */
  const ap = fitAperiodic(f, psd, { fmin: 2, fmax: 95 });
  const fundoEm = alvo => {
    if (!ap) return 0;
    const i = ap.f.findIndex(x => Math.abs(x - alvo) <= 1.5);
    return i >= 0 ? ap.aperiodic[i] : 0;
  };
  const base = em(f, psd, peakHz, 1.5);
  if (!base) return { isSuspect: false, harmonicsFound: [], ratio: NaN, verdict: 'não avaliável', reason: 'pico não localizado no espectro' };

  const candidatos = [
    { nome: 'subharmônico ½', hz: peakHz / 2 },
    { nome: 'subharmônico ⅓', hz: peakHz / 3 },
    { nome: '2º harmônico', hz: 2 * peakHz },
    { nome: '3º harmônico', hz: 3 * peakHz }
  ];
  const achados = [];
  candidatos.forEach(c => {
    if (c.hz < (f[1] || 1) || c.hz > f[f.length - 1]) return;
    const pt = em(f, psd, c.hz, 1.5);
    if (!pt) return;
    const fundo = fundoEm(c.hz);
    const excesso = fundo > 0 ? pt.v / fundo : NaN;
    /* duas condições, e ambas importam: o harmônico precisa estar acima do
       fundo aperiódico E ser uma fração relevante do fundamental. Só a primeira
       não basta — num espectro de oscilação quase pura o fundo ajustado fica
       ínfimo, e até vazamento numérico o ultrapassa. */
    const fracao = base.v > 0 ? pt.v / base.v : NaN;
    if (isFinite(excesso) && excesso > 1.5 && isFinite(fracao) && fracao > 0.01)
      achados.push({
        nome: c.nome, hz: +pt.f.toFixed(2),
        excessoSobreFundo: +excesso.toFixed(2), fracaoDoFundamental: +fracao.toFixed(4)
      });
  });

  const razao = achados.length ? achados.reduce((a, h) => a + h.excessoSobreFundo, 0) / achados.length : 0;
  const suspeito = achados.length >= 2;

  /* aliasing: com estimulação a fstim e Nyquist em fs/2, as frequências de
     dobra caem em |fstim − k·fs| — picos sobre elas são suspeitos. */
  let aliasing = null;
  if (isFinite(opts.stimRateHz) && isFinite(opts.fs)) {
    const nyq = opts.fs / 2;
    const dobras = [];
    for (let k = 0; k <= 6; k++) {
      const d = Math.abs(opts.stimRateHz - k * opts.fs);
      if (d > 0 && d <= nyq) dobras.push(+d.toFixed(2));
      const d2 = Math.abs(k * opts.fs - opts.stimRateHz);
      if (d2 > 0 && d2 <= nyq && !dobras.includes(+d2.toFixed(2))) dobras.push(+d2.toFixed(2));
    }
    const proximo = dobras.filter(d => Math.abs(d - peakHz) <= 2);
    aliasing = {
      stimRateHz: opts.stimRateHz, foldingFrequencies: dobras,
      peakNearFolding: proximo.length > 0,
      note: proximo.length
        ? `o pico em ${peakHz.toFixed(1)} Hz coincide com uma frequência de dobra do aliasing da estimulação (${proximo.join(', ')} Hz)`
        : null
    };
  }

  const verdict = suspeito ? 'artefato provável'
    : achados.length === 1 ? 'inconclusivo — um harmônico acima do fundo'
      : 'oscilatório provável';
  return {
    peakHz: +peakHz.toFixed(2), isSuspect: suspeito || !!(aliasing && aliasing.peakNearFolding),
    harmonicsFound: achados, nHarmonics: achados.length, ratio: +razao.toFixed(2),
    verdict, aliasing,
    reason: suspeito
      ? `${achados.length} harmônicos acima do fundo aperiódico (${achados.map(h => h.nome).join(', ')}) — pico provavelmente não oscilatório`
      : (aliasing && aliasing.peakNearFolding ? aliasing.note : null)
  };
}
