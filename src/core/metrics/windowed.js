/* metrics/windowed.js — coerência inter-STN por janela, tabela tidy e CSV.

   Complementa `metrics/odr.js`. Aqui moram as duas peças que precisam dos DOIS
   hemisférios ao mesmo tempo: a coerência entre eles e a tabela de uma linha por
   janela × hemisfério que alimenta figura, CSV e os scripts em R.

   ═══════════════════════════════════════════════════════════════════════════
   COERÊNCIA INTER-STN: A GUARDA VEM ANTES DO CÁLCULO
   ═══════════════════════════════════════════════════════════════════════════

   Só faz sentido calcular quando os dois canais vierem do MESMO registro:
   mesmo `FirstPacketDateTime`, mesma fs efetiva, mesmo comprimento, mesma base
   de ticks. Canais de sessões diferentes não têm base de tempo comum, e a
   coerência entre eles é ficção — não é "coerência baixa", é um número sem
   referente. A função recusa, dizendo quais valores não bateram.

   ═══════════════════════════════════════════════════════════════════════════
   TRÊS CONFUNDIDORES QUE PRODUZEM COERÊNCIA ALTA SEM INTERAÇÃO NENHUMA
   ═══════════════════════════════════════════════════════════════════════════

   1. ARTEFATO DE ESTIMULAÇÃO COMPARTILHADO. Os dois hemisférios recebem o
      artefato do MESMO gerador. Chega simultaneamente aos dois: fase zero.
   2. ARTEFATO CARDÍACO COMPARTILHADO. O QRS aparece nos dois lados, e o
      batimento e seus harmônicos caem em delta, teta e alfa — exatamente onde
      o artigo relata aumento de coerência. `detectRPeaks` roda nos dois canais
      e as bandas afetadas saem marcadas.
   3. CONDUÇÃO DE VOLUME. Também de fase zero.

   O DISCRIMINANTE É A PARTE IMAGINÁRIA DA COERÊNCIA. Ela é insensível a
   mistura instantânea: só sobrevive o que tem defasagem, isto é, o que levou
   tempo para propagar. Coerência alta com parte imaginária praticamente nula é
   compatível com os três confundidores acima e NÃO deve ser reportada como
   acoplamento inter-hemisférico. O veredito de `coherenceBand` é propagado
   para cada janela e para o resumo.

   O QUE O ARTIGO MOSTROU. Coerência inter-subtalâmica aumentou em teta e
   diminuiu em beta baixo durante períodos discinéticos sem movimento — o mesmo
   sentido dos padrões locais de cada STN. Gama de pico mostrou aumento pequeno
   mas significativo; alfa e gama larga não diferiram.
   (Habets et al., Brain 2026, doi:10.1093/brain/awag256.)

   Unidades: coerência e parte imaginária adimensionais; fase em graus; tempo
   em segundos; frequência em Hz.                                             */

import { windowedCoherence } from '../dsp/features.js';
import { detectRPeaks } from '../artifact/rpeaks.js';
import { ODR_BANDS, ODR_LIMITACOES, ODR_EXPECTATIVA } from './odr.js';

const wn = (v, k) => isFinite(v) ? +v.toFixed(k == null ? 4 : k) : NaN;
const wcsv = v => (v == null || (typeof v === 'number' && !isFinite(v))) ? '' : String(v);

/* ========================================================================= */
/*  1. Pareamento — a guarda                                                  */
/* ========================================================================= */

/* pairableRecords(a, b, opts) — os dois canais vieram do mesmo registro?

   Devolve { ok, reason, mismatches } sem calcular nada. Chamada separada para
   que a figura possa explicar a recusa antes de tentar desenhar.            */
export function pairableRecords(a, b, opts) {
  opts = opts || {};
  const tolFs = isFinite(opts.fsToleranceHz) ? opts.fsToleranceHz : 0.01;
  const divergencias = [];
  if (!a || !b) return {
    ok: false, mismatches: [],
    reason: 'faltam os dois hemisférios: a coerência inter-STN exige sinal bruto simultâneo dos dois lados'
  };

  const t0a = a.t0 || (a.record && a.record.t0) || null;
  const t0b = b.t0 || (b.record && b.record.t0) || null;
  if (String(t0a || '') !== String(t0b || '')) divergencias.push({
    field: 'FirstPacketDateTime', left: t0a || '(ausente)', right: t0b || '(ausente)'
  });

  const fsa = a.fs, fsb = b.fs;
  if (!isFinite(fsa) || !isFinite(fsb) || Math.abs(fsa - fsb) > tolFs) divergencias.push({
    field: 'fs efetiva', left: isFinite(fsa) ? +fsa.toFixed(4) : '(ausente)', right: isFinite(fsb) ? +fsb.toFixed(4) : '(ausente)'
  });

  const na = a.x ? a.x.length : 0, nb = b.x ? b.x.length : 0;
  if (na !== nb) divergencias.push({ field: 'comprimento (amostras)', left: na, right: nb });

  const ta = a.record && a.record.packets && a.record.packets.tickBase;
  const tb = b.record && b.record.packets && b.record.packets.tickBase;
  if (ta != null && tb != null && ta !== tb) divergencias.push({ field: 'base de ticks', left: ta, right: tb });

  if (divergencias.length) return {
    ok: false, mismatches: divergencias,
    reason: 'os dois canais NÃO vêm do mesmo registro (' +
      divergencias.map(d => `${d.field}: ${d.left} vs ${d.right}`).join('; ') +
      '). Sem base de tempo comum, a coerência entre eles não é baixa nem alta — é um número sem referente, e por ' +
      'isso não é calculada.'
  };
  return { ok: true, mismatches: [], reason: null, n: na, fs: fsa, t0: t0a };
}

/* ========================================================================= */
/*  2. Contaminação cardíaca compartilhada                                    */
/* ========================================================================= */

/* Detecta QRS nos DOIS canais e marca as bandas em que o batimento e seus
   harmônicos caem. Não remove nada: marca, para que a coerência daquelas
   bandas seja lida com a explicação alternativa à vista.                    */
function wecgCompartilhado(a, b, fs, bandas) {
  const roda = x => {
    try {
      const nMax = Math.min(x.length, Math.round(60 * fs));
      const trecho = Float64Array.from(x.subarray ? x.subarray(0, nMax) : x.slice(0, nMax), v => isFinite(v) ? v : 0);
      const d = detectRPeaks(trecho, fs, {});
      if (!d || !d.peaks || d.peaks.length < 8) return { ok: false, bpm: NaN, nPeaks: d && d.peaks ? d.peaks.length : 0 };
      const dur = trecho.length / fs;
      const bpm = 60 * d.peaks.length / Math.max(1e-6, dur);
      return { ok: bpm >= 40 && bpm <= 140, bpm: wn(bpm, 1), nPeaks: d.peaks.length };
    } catch (e) { return { ok: false, bpm: NaN, nPeaks: 0, error: String(e && e.message || e) }; }
  };
  const A = roda(a), B = roda(b);
  const compartilhado = A.ok && B.ok && isFinite(A.bpm) && isFinite(B.bpm) && Math.abs(A.bpm - B.bpm) < 10;
  const fFund = compartilhado ? (A.bpm + B.bpm) / 120 : NaN;   /* Hz */
  const afetadas = [];
  if (compartilhado) bandas.forEach(bd => {
    for (let h = 1; h <= 8; h++) {
      const f = h * fFund;
      if (f >= bd.lo && f <= bd.hi) { afetadas.push({ band: bd.id, harmonic: h, hz: wn(f, 2) }); break; }
    }
  });
  return {
    detected: compartilhado,
    left: A, right: B,
    fundamentalHz: wn(fFund, 3),
    affectedBands: afetadas,
    note: compartilhado
      ? `QRS detectado nos dois canais em frequências compatíveis (${A.bpm} e ${B.bpm} bpm). O batimento e seus ` +
        `harmônicos caem em ${afetadas.map(x => x.band).join(', ') || 'nenhuma banda avaliada'} e produzem coerência ` +
        'com fase praticamente zero, sem interação nenhuma entre os hemisférios'
      : 'nenhuma contaminação cardíaca compartilhada foi detectada nos dois canais (o que não é o mesmo que não haver)'
  };
}

/* ========================================================================= */
/*  3. interSTNCoherence                                                      */
/* ========================================================================= */

/* interSTNCoherence(left, right, opts)

   `left` e `right`: { x, fs, t0, record }. `opts.gammaBand` permite usar a
   banda do pico individual de gama vinda de `metrics/odr.js`.               */
export function interSTNCoherence(left, right, opts) {
  opts = opts || {};
  const windowS = isFinite(opts.windowS) ? opts.windowS : 10;
  const overlap = isFinite(opts.overlap) ? opts.overlap : 0;
  const alpha = isFinite(opts.alpha) ? opts.alpha : 0.05;

  const bandas = [
    { id: 'theta', lo: ODR_BANDS.theta.lo, hi: ODR_BANDS.theta.hi },
    { id: 'alpha', lo: ODR_BANDS.alpha.lo, hi: ODR_BANDS.alpha.hi },
    { id: 'lowBeta', lo: ODR_BANDS.lowBeta.lo, hi: ODR_BANDS.lowBeta.hi },
    { id: 'highBeta', lo: ODR_BANDS.highBeta.lo, hi: ODR_BANDS.highBeta.hi },
    { id: 'gammaBroad', lo: ODR_BANDS.gammaBroad.lo, hi: ODR_BANDS.gammaBroad.hi }
  ];
  if (Array.isArray(opts.gammaBand) && isFinite(opts.gammaBand[0]))
    bandas.push({ id: 'gammaPeak', lo: opts.gammaBand[0], hi: opts.gammaBand[1] });

  const par = pairableRecords(left, right, opts);
  if (!par.ok) return {
    ok: false, pairing: par, bands: bandas, windowS,
    reason: par.reason, confounders: null, windows: [], byBand: {}
  };

  const coh = windowedCoherence(left.x, right.x, par.fs, {
    windowS, overlap, alpha, bands: bandas,
    maxNanPct: isFinite(opts.maxNanPct) ? opts.maxNanPct : 5
  });
  if (!coh.ok) return {
    ok: false, pairing: par, bands: bandas, windowS,
    reason: coh.reason, confounders: null, windows: [], byBand: {}
  };

  const ecg = wecgCompartilhado(left.x, right.x, par.fs, bandas);
  const estim = {
    stimRateHz: isFinite(opts.stimRateHz) ? opts.stimRateHz : NaN,
    note: 'os dois hemisférios recebem o artefato do MESMO gerador, que chega simultaneamente aos dois lados e ' +
      'produz coerência de fase zero. É por isso que a parte imaginária, e não a magnitude, é o discriminante'
  };

  /* espectro médio de coerência ao longo das janelas — para o painel (c) */
  const validas = coh.windows.filter(w => w.f && w.cxy);
  let fMedia = null, cxyMedia = null, imagMedia = null;
  if (validas.length) {
    const nB = validas[0].cxy.length;
    fMedia = Array.from(validas[0].f);
    cxyMedia = new Array(nB).fill(0);
    imagMedia = new Array(nB).fill(0);
    validas.forEach(w => { for (let k = 0; k < nB; k++) { cxyMedia[k] += w.cxy[k]; imagMedia[k] += w.imagCoherency[k]; } });
    for (let k = 0; k < nB; k++) { cxyMedia[k] /= validas.length; imagMedia[k] /= validas.length; }
  }

  /* o resumo por banda ganha a marca de confundidor */
  const porBanda = {};
  Object.keys(coh.byBand).forEach(id => {
    const r = Object.assign({}, coh.byBand[id]);
    const cardiaca = ecg.affectedBands.find(x => x.band === id);
    r.sharedCardiacContamination = !!cardiaca;
    r.cardiacHarmonicHz = cardiaca ? cardiaca.hz : NaN;
    r.interpretable = r.fractionInterpretable > 0 && !cardiaca;
    r.confounderNote = cardiaca
      ? `o ${cardiaca.harmonic}º harmônico do batimento cai em ${cardiaca.hz} Hz, dentro desta banda: parte da ` +
        'coerência aqui pode ser o mesmo QRS aparecendo nos dois canais'
      : null;
    porBanda[id] = r;
  });

  return {
    ok: true,
    pairing: par,
    bands: bandas,
    windowS: coh.windowS, stepS: coh.stepS, overlap: coh.overlap,
    coherenceParams: coh.coherenceParams,
    windows: coh.windows.map(w => ({
      index: w.index, tStartS: w.tStartS, tCenterS: w.tCenterS, pctNan: w.pctNan,
      byBand: w.byBand,
      nSegments: w.nSegments, nSegmentsEffective: w.nSegmentsEffective,
      expectedNullCoherence: w.expectedNullCoherence,
      thresholdPerBin: w.thresholdPerBin,
      reason: w.reason
    })),
    nWindows: coh.nWindows, nValidWindows: coh.nValidWindows,
    byBand: porBanda,
    meanSpectrum: fMedia ? { f: fMedia, cxy: cxyMedia, imag: imagMedia, nWindows: validas.length } : null,
    confounders: { sharedStimulation: estim, sharedCardiac: ecg, volumeConduction: {
      note: 'condução de volume também produz fase zero; o veredito por banda vem de `coherenceBand` e está em ' +
        '`nVolumeConductionSuspected` e `fractionInterpretable`'
    } },
    nullNote: coh.nullNote, imagNote: coh.imagNote,
    articleNote:
      'No artigo (Habets et al., Brain 2026) a coerência inter-subtalâmica AUMENTOU em teta e DIMINUIU em beta baixo ' +
      'durante períodos discinéticos sem movimento — o mesmo sentido dos padrões locais de cada STN. Gama de pico ' +
      'mostrou aumento pequeno mas significativo; alfa e gama larga não diferiram. Aqui não há rótulo clínico: o que ' +
      'esta figura descreve é a dinâmica da coerência ao longo do tempo, não a presença de discinesia.',
    reason: null
  };
}

/* ========================================================================= */
/*  4. Tabela tidy — uma linha por janela × hemisfério                        */
/* ========================================================================= */

/* windowedFeatureTable(entrada) — junta ODR, CV e coerência numa tabela longa.

   entrada = {
     odr:  saída de odrSeries
     cv:   { Left: saída de odrSpectralVariation, Right: ... }
     coh:  saída de interSTNCoherence (opcional)
     channels: { Left: 'label', Right: 'label' }
   }

   Cabeçalhos em INGLÊS, porque quem consome isso são scripts em R.          */
export function windowedFeatureTable(entrada) {
  const e = entrada || {};
  const odr = e.odr;
  if (!odr || !odr.ok) return { ok: false, rows: [], columns: WINDOWED_COLUMNS, reason: (odr && odr.reason) || 'sem ODR' };

  const linhas = [];
  (odr.hemispheres || []).forEach(h => {
    const bh = odr.byHemisphere[h];
    if (!bh || !bh.ok) return;
    const cv = (e.cv && e.cv[h]) || null;
    const canal = (e.channels && e.channels[h]) || '';
    const fsEff = (e.fs && e.fs[h]) || NaN;
    const estado = bh.deviceState || {};

    bh.windows.forEach((w, i) => {
      const global = odr.windows[i] || {};
      const cvBanda = id => {
        const b = cv && cv.byBand && cv.byBand[id];
        const j = b && b.windows && b.windows[i];
        return j && isFinite(j.cv) ? j.cv : NaN;
      };
      const cw = e.coh && e.coh.ok ? e.coh.windows[i] : null;
      const cb = id => (cw && cw.byBand && cw.byBand[id]) || null;

      linhas.push({
        window_index: w.index,
        t_start_s: w.tStartS,
        t_center_s: w.tCenterS,
        window_s: odr.params.windowS,
        hemisphere: h,
        channel: canal,
        fs_effective: isFinite(fsEff) ? wn(fsEff, 4) : NaN,
        pct_nan: w.pctNan,

        theta_power: w.power ? w.power.theta : NaN,
        alpha_power: w.power ? w.power.alpha : NaN,
        low_beta_power: w.power ? w.power.lowBeta : NaN,
        high_beta_power: w.power ? w.power.highBeta : NaN,
        gamma_peak_power: w.power ? (w.power.gammaPeak == null ? NaN : w.power.gammaPeak) : NaN,
        gamma_broad_power: w.power ? w.power.gammaBroad : NaN,
        gamma_peak_hz: isFinite(bh.gamma && bh.gamma.peakHz) ? bh.gamma.peakHz : NaN,

        theta_z: w.zThetaLog,
        low_beta_z: w.zLowBetaLog,
        gamma_peak_z: w.zGammaLog,

        odr_log: global.odrLog,
        odr_literal: global.odrLiteral,

        cv_theta: cvBanda('theta'),
        cv_low_beta: cvBanda('lowBeta'),
        cv_gamma_peak: cvBanda('gammaPeak'),

        coh_theta: cb('theta') ? cb('theta').coherence : NaN,
        coh_low_beta: cb('lowBeta') ? cb('lowBeta').coherence : NaN,
        coh_gamma_peak: cb('gammaPeak') ? cb('gammaPeak').coherence : NaN,
        imag_coh_theta: cb('theta') ? cb('theta').imag : NaN,
        imag_coh_low_beta: cb('lowBeta') ? cb('lowBeta').imag : NaN,
        imag_coh_gamma_peak: cb('gammaPeak') ? cb('gammaPeak').imag : NaN,
        coh_null_expected: cw ? cw.expectedNullCoherence : NaN,
        coh_threshold_band: cb('lowBeta') ? cb('lowBeta').threshold : NaN,

        device_state: estado.state || 'UNKNOWN',
        stim_rate_hz: isFinite(estado.rateHz) ? estado.rateHz : NaN,
        stim_amplitude_ma: isFinite(estado.amplitudeMa) ? estado.amplitudeMa : NaN,

        gamma_source: bh.gammaSource || 'none',
        /* fora da lista mínima da especificação, e de propósito: sem esta
           coluna, uma linha em que a conferência contra f_stim/2 NÃO foi
           possível é indistinguível de uma em que ela passou */
        entrainment_checked: bh.entrainmentChecked ? 1 : 0,
        odr_valid: isFinite(global.odrLog) ? 1 : 0,
        odr_reason: w.reason || global.reason || ''
      });
    });
  });

  return { ok: linhas.length > 0, rows: linhas, columns: WINDOWED_COLUMNS, nRows: linhas.length, reason: null };
}

export const WINDOWED_COLUMNS = [
  'window_index', 't_start_s', 't_center_s', 'window_s', 'hemisphere', 'channel',
  'fs_effective', 'pct_nan',
  'theta_power', 'alpha_power', 'low_beta_power', 'high_beta_power', 'gamma_peak_power',
  'gamma_broad_power', 'gamma_peak_hz',
  'theta_z', 'low_beta_z', 'gamma_peak_z',
  'odr_log', 'odr_literal',
  'cv_theta', 'cv_low_beta', 'cv_gamma_peak',
  'coh_theta', 'coh_low_beta', 'coh_gamma_peak',
  'imag_coh_theta', 'imag_coh_low_beta', 'imag_coh_gamma_peak',
  'coh_null_expected', 'coh_threshold_band',
  'device_state', 'stim_rate_hz', 'stim_amplitude_ma',
  'gamma_source', 'entrainment_checked', 'odr_valid', 'odr_reason'
];

/* ========================================================================= */
/*  5. CSV com bloco de metadados em comentário                               */
/* ========================================================================= */

/* windowedFeatureMeta(entrada, versao) — o bloco de comentário do topo do CSV,
   no mesmo padrão de `metaEspectrograma` da F30. Sem ele, o arquivo perde o
   que separa o número da opinião: janela, bandas, política de z-score,
   definição do pico de gama, verificação contra f_stim/2, estado da
   estimulação e a declaração de que o passo de SSD não foi aplicado.        */
export function windowedFeatureMeta(entrada, versao) {
  const e = entrada || {};
  const odr = e.odr || {};
  const p = odr.params || {};
  const L = [];
  const add = (k, v) => L.push(`# ${k}: ${v}`);

  add('software', `Percept LFP Studio ${versao || ''}`.trim());
  add('generated_at', new Date().toISOString());
  add('feature_set', 'ODR, spectral variation and inter-STN coherence (Habets et al., Brain 2026, doi:10.1093/brain/awag256)');
  add('window_s', p.windowS);
  add('overlap', p.overlap);
  add('bands_hz', `theta ${ODR_BANDS.theta.lo}-${ODR_BANDS.theta.hi}, alpha ${ODR_BANDS.alpha.lo}-${ODR_BANDS.alpha.hi}, ` +
    `low_beta ${ODR_BANDS.lowBeta.lo}-${ODR_BANDS.lowBeta.hi}, high_beta ${ODR_BANDS.highBeta.lo}-${ODR_BANDS.highBeta.hi}, ` +
    `gamma_broad ${ODR_BANDS.gammaBroad.lo}-${ODR_BANDS.gammaBroad.hi}`);
  add('gamma_peak_definition', `individual peak in ${(p.gammaSearch || [])[0]}-${(p.gammaSearch || [])[1]} Hz ` +
    `+/- ${p.gammaHalfWidthHz} Hz, located once over the mean spectrum of the whole recording`);
  add('gamma_source', p.gammaSource);
  add('z_score_policy', p.zPolicy);
  add('odr_formulation_used', odr.formulationUsed);
  add('odr_formulation_note', 'odr_log = z(log theta) + z(log gamma) - z(log low_beta); odr_literal = ' +
    '(z(theta) * z(gamma)) / z(low_beta). Divergence between the two is a property of the formula: the literal ' +
    'version divides by a z-scored value, which crosses zero by construction');
  add('odr_log_vs_literal_spearman', odr.spearmanLogVsLiteral);
  add('odr_literal_escape_fraction', `${odr.literalEscapeFraction} (|odr_literal| > ${odr.literalClip})`);
  add('entrainment_check', `gamma peak tested against f_stim/2 with tolerance ${p.entrainToleranceHz} Hz`);
  (odr.hemispheres || []).forEach(h => {
    const bh = odr.byHemisphere[h] || {};
    add(`hemisphere_${h.toLowerCase()}_entrainment_checked`, bh.entrainmentChecked ? 'yes' : 'NO - stimulation rate not declared in this file');
  });

  (odr.hemispheres || []).forEach(h => {
    const bh = odr.byHemisphere[h] || {};
    const ds = bh.deviceState || {};
    add(`hemisphere_${h.toLowerCase()}_gamma_peak_hz`, (bh.gamma && bh.gamma.peakHz) || 'not found');
    add(`hemisphere_${h.toLowerCase()}_gamma_source`, bh.gammaSource || 'none');
    add(`hemisphere_${h.toLowerCase()}_device_state`, `${ds.state || 'UNKNOWN'} (confidence: ${ds.confidence || 'none'})`);
    add(`hemisphere_${h.toLowerCase()}_stim_rate_hz`, isFinite(ds.rateHz) ? ds.rateHz : 'not declared');
    add(`hemisphere_${h.toLowerCase()}_stim_amplitude_ma`, isFinite(ds.amplitudeMa) ? ds.amplitudeMa : 'not declared');
  });

  if (e.coh) {
    add('coherence_pairing', e.coh.ok ? 'both channels from the same recording' : `refused: ${e.coh.reason}`);
    if (e.coh.ok) {
      add('coherence_nperseg', e.coh.coherenceParams.nperseg);
      add('coherence_alpha', e.coh.coherenceParams.alpha);
      add('coherence_null_note', 'with L effective segments the null coherence is 1/L, not zero; the band threshold ' +
        'is Sidak-corrected for the number of bins in the band');
      add('coherence_imag_note', 'high coherence with near-zero imaginary part is compatible with shared stimulation ' +
        'artefact, shared cardiac artefact and volume conduction, and is NOT reported as coupling');
      const ecg = e.coh.confounders && e.coh.confounders.sharedCardiac;
      add('shared_cardiac_contamination', ecg && ecg.detected
        ? `detected (${ecg.fundamentalHz} Hz fundamental), affecting: ${(ecg.affectedBands || []).map(b => b.band).join(', ') || 'none of the analysed bands'}`
        : 'not detected (which is not the same as absent)');
    }
  }

  add('ssd_not_applied', 'the source protocol optimises SNR by spatio-spectral decomposition over several channels ' +
    'per electrode. The Percept exposes ONE bipolar pair per hemisphere: SSD is not implementable here, sensitivity ' +
    'is lower (especially in gamma), and absolute values are NOT comparable with the published ones');
  add('stimulation_difference', 'the source protocol ran with stimulation OFF and externalised electrodes; this ' +
    'recording typically has stimulation ON with an implanted generator');
  add('expected_performance', 'in the original study the ODR reached a mean balanced accuracy of 0.61 (SD 0.14) as a ' +
    'univariate predictor, with significant detection in 8 of 21 subjects');
  add('not_a_medical_device', 'research and decision-support tool; no clinical label is used or produced here');

  return L.join('\n');
}

/* windowedFeatureCsv(entrada, versao) — CSV completo, metadados no topo. */
export function windowedFeatureCsv(entrada, versao) {
  const t = windowedFeatureTable(entrada);
  const cab = windowedFeatureMeta(entrada, versao);
  const linhas = [cab, WINDOWED_COLUMNS.join(',')];
  (t.rows || []).forEach(r => linhas.push(WINDOWED_COLUMNS.map(c => {
    const v = r[c];
    const s = wcsv(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')));
  return linhas.join('\n');
}

/* Reexportados para que a figura precise importar de um lugar só. */
export { ODR_LIMITACOES, ODR_EXPECTATIVA };
