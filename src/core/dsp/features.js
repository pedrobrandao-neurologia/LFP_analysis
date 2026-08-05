/* dsp/features.js — features por janela deslizante (camada dsp).

   PRIMITIVAS PURAS: sinal entra, números saem. Nenhum conhecimento de
   hemisfério, de arquivo ou de dispositivo — quem sabe disso é `metrics`.
   Todas tolerantes a NaN, e NaN aqui significa AUSÊNCIA, nunca zero.

   As três features desta onda vêm de Habets JGV, Merk T, Mathiopoulou V, et al.
   Movement dependent neural substates within levodopa-induced dyskinesia in
   Parkinson's disease. Brain 2026 (doi:10.1093/brain/awag256): potência por
   banda, variação espectral do envelope e coerência inter-hemisférica, todas
   em janelas curtas.

   O QUE ESTE ARQUIVO NÃO FAZ, E POR QUÊ. O protocolo de origem otimiza a razão
   sinal-ruído por SSD (spatio-spectral decomposition) sobre vários canais por
   eletrodo. O Percept entrega UM par bipolar por hemisfério. SSD não é
   implementável aqui, e a perda de sensibilidade — sobretudo em gama — é real.
   Isso é declarado na saída dos módulos de `metrics` que consomem estas
   funções, não escondido num comentário.

   Unidades: x em µV, fs em Hz, frequências em Hz, janelas em segundos.
   CV e coerência são adimensionais.                                          */

import { bandpassFFT, hilbertEnvelope } from './filters.js';
import { welchPSD, bandPower } from './spectral.js';
import { coherence, coherenceBand } from './coherence.js';
import { nanMean, nanVariance, nanStats } from './nan.js';

/* ------------------------------------------------------------ utilidades -- */

/* Índices de início de cada janela. `windowS` e `overlap` viram amostras aqui,
   uma vez só, e o passo efetivo sai na saída porque arredondamento muda o
   número de janelas e o leitor precisa poder reconstruir a grade. */
export function windowGrid(n, fs, windowS, overlap) {
  const nper = Math.max(2, Math.round(windowS * fs));
  const ov = isFinite(overlap) ? Math.min(0.95, Math.max(0, overlap)) : 0;
  const passo = Math.max(1, Math.round(nper * (1 - ov)));
  const starts = [];
  for (let s = 0; s + nper <= n; s += passo) starts.push(s);
  return {
    starts, nperseg: nper, step: passo, overlap: ov,
    windowS: +(nper / fs).toFixed(6), stepS: +(passo / fs).toFixed(6), nWindows: starts.length
  };
}

const fx = (v, k) => isFinite(v) ? +v.toFixed(k == null ? 6 : k) : NaN;

/* Fração de amostras não finitas num trecho. */
function pctNaNDe(x, ini, fim) {
  let n = 0;
  for (let i = ini; i < fim; i++) if (!isFinite(x[i])) n++;
  return 100 * n / Math.max(1, fim - ini);
}

/* ========================================================================= */
/*  1. spectralVariation — coeficiente de variação do envelope                */
/* ========================================================================= */

/* spectralVariation(x, fs, lo, hi, opts)

   CV = DP(envelope) / média(envelope), sobre o envelope de Hilbert do sinal
   filtrado na banda [lo, hi]. É a feature de segunda ordem do artigo: mede o
   quanto a amplitude da oscilação FLUTUA dentro da janela, e não o quanto ela
   vale.

   A DECISÃO QUE MAIS MUDA O RESULTADO. Por padrão o sinal é filtrado e o
   envelope calculado UMA VEZ sobre o registro inteiro, e só depois fatiado por
   janela. Filtrar dentro de cada janela de 10 s introduz transiente de borda em
   cada uma delas, e o transiente enviesa o CV de forma sistemática — não
   aleatória, e por isso não desaparece na média. O modo por janela isolada fica
   disponível em `opts.perWindow`; nele as bordas equivalentes a `edgeCycles`
   ciclos da frequência inferior são descartadas, o que troca o viés do
   transiente por outro efeito de sinal oposto — a janela efetiva encolhe, e
   janela menor devolve CV MENOR. Os dois modos não são intercambiáveis, a
   política usada sai em `edgePolicy`, e a suíte de testes mede a diferença
   entre eles para que ela não seja descoberta depois por alguém interpretando
   um resultado.

   O CV DEPENDE DO COMPRIMENTO DA JANELA. Janela maior alcança mais da flutuação
   lenta do envelope e devolve CV maior. Comparar CV de janelas diferentes é
   erro, e por isso `windowS` sai em toda saída — para que a comparação indevida
   seja verificável em vez de invisível.

   GUARDA DE ESTABILIDADE. O CV é indefinido quando a média do envelope tende a
   zero. Abaixo de `minMeanFrac` × (mediana das médias de janela) o valor sai
   NaN com motivo, em vez de um número grande sem significado.

   Entrada em µV; saída adimensional.                                        */
export function spectralVariation(x, fs, lo, hi, opts) {
  opts = opts || {};
  const windowS = isFinite(opts.windowS) ? opts.windowS : 10;
  const overlap = isFinite(opts.overlap) ? opts.overlap : 0;
  const maxNanPct = isFinite(opts.maxNanPct) ? opts.maxNanPct : 5;
  const minMeanFrac = isFinite(opts.minMeanFrac) ? opts.minMeanFrac : 0.02;
  const perWindow = !!opts.perWindow;
  const edgeCycles = isFinite(opts.edgeCycles) ? opts.edgeCycles : 2;

  const n = x ? x.length : 0;
  const g = windowGrid(n, fs, windowS, overlap);
  const base = {
    band: [lo, hi], windowS: g.windowS, stepS: g.stepS, overlap: g.overlap,
    nperseg: g.nperseg, maxNanPct, minMeanFrac,
    edgePolicy: perWindow
      ? `filtro por janela isolada, descartando ${edgeCycles} ciclos de ${lo} Hz em cada borda`
      : 'filtro e envelope sobre o registro inteiro, fatiados depois — sem transiente de borda por janela',
    perWindow,
    windowNote: 'o CV cresce com o comprimento da janela: comparar CVs de janelas diferentes é erro'
  };
  if (!n || g.nWindows === 0) return Object.assign({ ok: false, windows: [], nWindows: 0 }, base, {
    reason: !n ? 'sinal vazio' : `sinal curto demais para uma janela de ${windowS} s a ${fs} Hz`
  });

  let envelope = null, pctImputed = 0;
  const janelas = [];

  if (!perWindow) {
    const filtrado = bandpassFFT(x, fs, lo, hi);
    envelope = hilbertEnvelope(filtrado);
    pctImputed = Math.max(filtrado.pctImputed || 0, envelope.pctImputed || 0);
  }

  const descarteAmostras = perWindow ? Math.round(edgeCycles * fs / Math.max(0.5, lo)) : 0;

  g.starts.forEach((s, i) => {
    const fim = s + g.nperseg;
    const pn = pctNaNDe(x, s, fim);
    const comum = {
      index: i, tStartS: +(s / fs).toFixed(4), tCenterS: +((s + g.nperseg / 2) / fs).toFixed(4),
      pctNan: +pn.toFixed(3)
    };
    if (pn > maxNanPct) {
      janelas.push(Object.assign({ cv: NaN, meanEnv: NaN, sdEnv: NaN, nValid: 0, pctImputed: NaN }, comum, {
        reason: `${pn.toFixed(1)}% de amostras ausentes na janela, acima do máximo de ${maxNanPct}% — ` +
          'o CV não é calculado sobre o que sobrou'
      }));
      return;
    }
    let trecho, impJanela = pctImputed;
    if (perWindow) {
      const bruto = x.subarray ? x.subarray(s, fim) : x.slice(s, fim);
      const fl = bandpassFFT(bruto, fs, lo, hi);
      const env = hilbertEnvelope(fl);
      impJanela = Math.max(fl.pctImputed || 0, env.pctImputed || 0);
      if (2 * descarteAmostras >= env.length - 4) {
        janelas.push(Object.assign({ cv: NaN, meanEnv: NaN, sdEnv: NaN, nValid: 0, pctImputed: impJanela }, comum, {
          reason: `descartar ${edgeCycles} ciclos de ${lo} Hz em cada borda não deixa amostra suficiente numa ` +
            `janela de ${windowS} s — aumente a janela ou use o modo padrão`
        }));
        return;
      }
      trecho = env.slice(descarteAmostras, env.length - descarteAmostras);
    } else {
      trecho = envelope.subarray ? envelope.subarray(s, fim) : envelope.slice(s, fim);
    }
    const m = nanMean(trecho), v = nanVariance(trecho);
    const est = nanStats(trecho);
    janelas.push(Object.assign({
      cv: NaN, meanEnv: fx(m, 6), sdEnv: fx(Math.sqrt(v), 6),
      nValid: est.nValid, pctImputed: fx(impJanela, 3)
    }, comum, { _m: m, _v: v, reason: null }));
  });

  /* piso de estabilidade relativo à mediana das médias de janela: só é possível
     depois de conhecer todas elas, e por isso o CV é fechado num segundo passe */
  const medias = janelas.map(j => j._m).filter(isFinite).sort((a, b) => a - b);
  const mediana = medias.length ? medias[Math.floor(medias.length / 2)] : NaN;
  const piso = isFinite(mediana) ? minMeanFrac * mediana : NaN;

  janelas.forEach(j => {
    const m = j._m, v = j._v;
    delete j._m; delete j._v;
    if (!isFinite(m) || !isFinite(v)) { if (!j.reason) j.reason = 'janela sem amostras válidas suficientes'; return; }
    if (isFinite(piso) && m < piso) {
      j.reason = `média do envelope (${m.toExponential(2)}) abaixo do piso de estabilidade ` +
        `(${minMeanFrac} × mediana = ${piso.toExponential(2)}) — o CV explodiria sem significar nada`;
      return;
    }
    j.cv = fx(Math.sqrt(v) / m, 6);
  });

  const validos = janelas.filter(j => isFinite(j.cv));
  return Object.assign({
    ok: validos.length > 0,
    windows: janelas, nWindows: janelas.length, nValidWindows: validos.length,
    meanCv: validos.length ? fx(nanMean(validos.map(j => j.cv)), 6) : NaN,
    envelopeStabilityFloor: isFinite(piso) ? +piso.toExponential(4) : NaN,
    pctImputed: fx(pctImputed, 3)
  }, base, {
    reason: validos.length ? null : 'nenhuma janela produziu CV utilizável — veja `reason` de cada janela'
  });
}

/* ========================================================================= */
/*  2. windowedBandPower — potência por banda por janela                      */
/* ========================================================================= */

/* windowedBandPower(x, fs, bands, opts)

   `bands`: [{ id, lo, hi }]. Devolve, por janela, a potência ABSOLUTA de cada
   banda (integral da densidade, em µV²), mais a contabilidade do Welch:
   quantos segmentos entraram e quantos foram descartados por lacuna. Janela com
   menos de `minSegments` segmentos válidos sai NaN com motivo, porque uma
   estimativa de Welch sobre um segmento só não é uma estimativa — é um
   periodograma, com variância que não decresce.                              */
export function windowedBandPower(x, fs, bands, opts) {
  opts = opts || {};
  const windowS = isFinite(opts.windowS) ? opts.windowS : 10;
  const overlap = isFinite(opts.overlap) ? opts.overlap : 0;
  const maxNanPct = isFinite(opts.maxNanPct) ? opts.maxNanPct : 5;
  const minSegments = isFinite(opts.minSegments) ? opts.minSegments : 3;
  const nperWelch = isFinite(opts.nperseg) ? opts.nperseg : Math.round(fs);
  const overlapWelch = isFinite(opts.welchOverlap) ? opts.welchOverlap : 0.5;
  const lista = (bands || []).filter(b => b && isFinite(b.lo) && isFinite(b.hi));

  const n = x ? x.length : 0;
  const g = windowGrid(n, fs, windowS, overlap);
  const base = {
    bands: lista.map(b => ({ id: b.id, lo: b.lo, hi: b.hi })),
    windowS: g.windowS, stepS: g.stepS, overlap: g.overlap,
    welch: { nperseg: nperWelch, overlap: overlapWelch, df: fs / nperWelch },
    maxNanPct, minSegments
  };
  if (!n || !g.nWindows || !lista.length) return Object.assign({ ok: false, windows: [], nWindows: 0 }, base, {
    reason: !lista.length ? 'nenhuma banda válida foi pedida'
      : !n ? 'sinal vazio' : `sinal curto demais para uma janela de ${windowS} s a ${fs} Hz`
  });

  const janelas = g.starts.map((s, i) => {
    const fim = s + g.nperseg;
    const pn = pctNaNDe(x, s, fim);
    const comum = {
      index: i, tStartS: +(s / fs).toFixed(4), tCenterS: +((s + g.nperseg / 2) / fs).toFixed(4),
      pctNan: +pn.toFixed(3)
    };
    const vazio = {};
    lista.forEach(b => { vazio[b.id] = NaN; });
    if (pn > maxNanPct) return Object.assign({ power: vazio, nSegmentsUsed: 0, nSegmentsDropped: 0, f: null, psd: null }, comum, {
      reason: `${pn.toFixed(1)}% de amostras ausentes na janela, acima do máximo de ${maxNanPct}%`
    });
    const trecho = x.subarray ? x.subarray(s, fim) : x.slice(s, fim);
    const w = welchPSD(trecho, fs, { nperseg: nperWelch, overlap: overlapWelch });
    /* welchPSD espalha os metadados no próprio objeto, não sob `meta` */
    const usados = w && isFinite(w.nSegments) ? w.nSegments : 0;
    const perdidos = w && isFinite(w.nSegmentsDropped) ? w.nSegmentsDropped : 0;
    if (!w || !w.p || usados < minSegments) return Object.assign({
      power: vazio, nSegmentsUsed: usados, nSegmentsDropped: perdidos, f: null, psd: null
    }, comum, {
      reason: `só ${usados} segmento(s) de Welch válido(s) na janela, abaixo do mínimo de ${minSegments} — ` +
        'com tão poucos segmentos a estimativa não tem variância aceitável e não é reportada'
    });
    const pot = {};
    lista.forEach(b => { pot[b.id] = fx(bandPower(w.f, w.p, b.lo, b.hi), 8); });
    return Object.assign({
      power: pot, nSegmentsUsed: usados, nSegmentsDropped: perdidos,
      f: w.f, psd: w.p, reason: null
    }, comum);
  });

  const validas = janelas.filter(j => !j.reason);
  return Object.assign({
    ok: validas.length > 0, windows: janelas, nWindows: janelas.length, nValidWindows: validas.length
  }, base, { reason: validas.length ? null : 'nenhuma janela produziu potência utilizável' });
}

/* ========================================================================= */
/*  3. windowedCoherence — coerência por janela                               */
/* ========================================================================= */

/* windowedCoherence(x, y, fs, opts)

   Reaproveita `coherence` e `coherenceBand` inteiros, inclusive a correção de
   segmentos efetivos (a sobreposição de Welch faz os segmentos não serem
   independentes) e a correção de Šidák pelo número de bins da banda.

   O ACOMPANHAMENTO OBRIGATÓRIO. Numa janela de 10 s a 250 Hz sobram poucos
   segmentos, e com L segmentos a coerência esperada sob a hipótese nula NÃO é
   zero: é 1/L. Com 4 segmentos, dois ruídos independentes dão Cxy ≈ 0,25, que
   parece "coerência moderada" para quem lê só o número. Por isso cada valor sai
   com três acompanhantes — segmentos efetivos, coerência sob a nula e limiar
   corrigido para a banda — e sem eles um valor é ininterpretável.

   A PARTE IMAGINÁRIA VEM SEMPRE. No Percept ela não é refinamento: é o
   discriminante principal. Artefato de estimulação compartilhado, artefato
   cardíaco compartilhado e condução de volume produzem, os três, coerência alta
   com fase praticamente zero. Coerência alta com parte imaginária nula NÃO deve
   ser reportada como acoplamento inter-hemisférico.                          */
export function windowedCoherence(x, y, fs, opts) {
  opts = opts || {};
  const windowS = isFinite(opts.windowS) ? opts.windowS : 10;
  const overlap = isFinite(opts.overlap) ? opts.overlap : 0;
  const maxNanPct = isFinite(opts.maxNanPct) ? opts.maxNanPct : 5;
  const alpha = isFinite(opts.alpha) ? opts.alpha : 0.05;
  const nperCoh = isFinite(opts.nperseg) ? opts.nperseg : Math.round(fs);
  const overlapCoh = isFinite(opts.cohOverlap) ? opts.cohOverlap : 0.5;
  const lista = (opts.bands || []).filter(b => b && isFinite(b.lo) && isFinite(b.hi));

  const n = Math.min(x ? x.length : 0, y ? y.length : 0);
  const g = windowGrid(n, fs, windowS, overlap);
  const base = {
    bands: lista.map(b => ({ id: b.id, lo: b.lo, hi: b.hi })),
    windowS: g.windowS, stepS: g.stepS, overlap: g.overlap,
    coherenceParams: { nperseg: nperCoh, overlap: overlapCoh, alpha, df: fs / nperCoh },
    maxNanPct,
    nullNote: 'com L segmentos efetivos a coerência esperada sob a nula é 1/L, não zero — o limiar por banda ' +
      'já corrige para os bins da banda (Šidák)',
    imagNote: 'coerência alta com parte imaginária praticamente nula é compatível com artefato compartilhado, ' +
      'referência comum e condução de volume, e não deve ser lida como acoplamento'
  };
  if (!n || !g.nWindows) return Object.assign({ ok: false, windows: [], nWindows: 0 }, base, {
    reason: !n ? 'um dos sinais está vazio' : `sinais curtos demais para uma janela de ${windowS} s a ${fs} Hz`
  });

  const janelas = g.starts.map((s, i) => {
    const fim = s + g.nperseg;
    const pnx = pctNaNDe(x, s, fim), pny = pctNaNDe(y, s, fim);
    const pn = Math.max(pnx, pny);
    const comum = {
      index: i, tStartS: +(s / fs).toFixed(4), tCenterS: +((s + g.nperseg / 2) / fs).toFixed(4),
      pctNan: +pn.toFixed(3)
    };
    const vazio = {};
    lista.forEach(b => { vazio[b.id] = null; });
    if (pn > maxNanPct) return Object.assign({ byBand: vazio, nSegmentsEffective: 0 }, comum, {
      reason: `${pn.toFixed(1)}% de amostras ausentes na janela, acima do máximo de ${maxNanPct}%`
    });
    const sx = x.subarray ? x.subarray(s, fim) : x.slice(s, fim);
    const sy = y.subarray ? y.subarray(s, fim) : y.slice(s, fim);
    const c = coherence(sx, sy, fs, { nperseg: nperCoh, overlap: overlapCoh, alpha });
    if (!c || !c.cxy) return Object.assign({ byBand: vazio, nSegmentsEffective: 0 }, comum, {
      reason: (c && c.reason) || 'coerência não calculável nesta janela'
    });
    const porBanda = {};
    lista.forEach(b => {
      const cb = coherenceBand(c, b.lo, b.hi);
      porBanda[b.id] = cb ? {
        coherence: cb.peakCoherence, meanCoherence: cb.meanCoherence,
        imag: cb.imagAtPeak, phaseDeg: cb.phaseAtPeakDeg, peakHz: cb.peakHz,
        threshold: cb.thresholdBandCorrected, significant: cb.significant,
        volumeConductionSuspected: cb.volumeConductionSuspected,
        nBins: cb.nBins
      } : null;
    });
    return Object.assign({
      byBand: porBanda,
      nSegments: c.nSegments, nSegmentsEffective: c.nSegmentsEffective,
      nSegmentsDropped: c.nSegmentsDropped,
      expectedNullCoherence: c.expectedNullCoherence,
      thresholdPerBin: c.significanceThreshold,
      f: c.f, cxy: c.cxy, imagCoherency: c.imagCoherency,
      reason: null
    }, comum);
  });

  /* resumo: fração de janelas acima do limiar CORRIGIDO por banda, e quantas
     dessas têm parte imaginária praticamente nula — porque essas últimas não
     sustentam a leitura de acoplamento */
  const resumo = {};
  lista.forEach(b => {
    const vals = janelas.map(j => j.byBand && j.byBand[b.id]).filter(Boolean);
    const acima = vals.filter(v => v.significant);
    const conduzidas = acima.filter(v => v.volumeConductionSuspected);
    resumo[b.id] = {
      nWindows: vals.length,
      nAboveThreshold: acima.length,
      fractionAboveThreshold: vals.length ? +(acima.length / vals.length).toFixed(4) : NaN,
      nVolumeConductionSuspected: conduzidas.length,
      fractionInterpretable: vals.length ? +((acima.length - conduzidas.length) / vals.length).toFixed(4) : NaN,
      /* média dos PICOS da banda: enviesada para cima por ser um máximo sobre
         bins, e é a que o olho vê no gráfico */
      meanCoherence: vals.length ? fx(nanMean(vals.map(v => v.coherence)), 4) : NaN,
      /* média da coerência MÉDIA da banda: é esta que, sob a nula, deve ficar
         perto de 1/L_eff — e não perto de zero */
      meanBandCoherence: vals.length ? fx(nanMean(vals.map(v => v.meanCoherence)), 4) : NaN,
      meanImag: vals.length ? fx(nanMean(vals.map(v => v.imag)), 4) : NaN,
      verdict: !vals.length ? 'nenhuma janela avaliável'
        : !acima.length ? 'nenhuma janela passa do limiar corrigido nesta banda'
          : conduzidas.length >= acima.length * 0.5
            ? 'a maior parte das janelas acima do limiar tem fase praticamente zero — compatível com artefato ' +
              'compartilhado ou condução de volume, não com acoplamento'
            : `${acima.length - conduzidas.length} de ${vals.length} janelas têm coerência acima do limiar COM ` +
              'defasagem, o que é incompatível com mistura instantânea'
    };
  });

  const validas = janelas.filter(j => !j.reason);
  return Object.assign({
    ok: validas.length > 0, windows: janelas, nWindows: janelas.length, nValidWindows: validas.length,
    byBand: resumo
  }, base, { reason: validas.length ? null : 'nenhuma janela produziu coerência utilizável' });
}
