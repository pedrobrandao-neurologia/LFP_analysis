/* metrics/odr.js — Oscillatory Dynamics Ratio, por janela.

   O QUE É. Um número por janela que combina três ritmos do STN:

       ODR = (θ × γpico) / β_baixo

   com θ = 4–8 Hz, β baixo = 12–20 Hz e γpico = pico individual de gama ± 2,5 Hz.
   Sobe quando teta e gama sobem e quando beta cai — o padrão descrito nos
   períodos de discinesia induzida por levodopa em Habets JGV, Merk T,
   Mathiopoulou V, et al. Movement dependent neural substates within
   levodopa-induced dyskinesia in Parkinson's disease. Brain 2026
   (doi:10.1093/brain/awag256).

   ═══════════════════════════════════════════════════════════════════════════
   O PROBLEMA NUMÉRICO DA FÓRMULA LITERAL — resolvido, não contornado
   ═══════════════════════════════════════════════════════════════════════════

   A fórmula original é uma razão de POTÊNCIAS. O artigo, porém, z-score cada
   banda ao longo do registro antes de combinar. Um valor z-scored cruza zero
   POR CONSTRUÇÃO — a média de um z-score é zero —, e portanto o denominador
   z(β) passa perto de zero necessariamente, e várias vezes, em qualquer
   registro. A razão explode nessas janelas, e o sinal do ODR se inverte quando
   z(β) muda de sinal.

   As duas formulações são implementadas:

     odrLog (PADRÃO):  z(log θ) + z(log γ) − z(log β)
     odrLiteral:       (z(θ) × z(γ)) / z(β), exatamente como escrita

   ÁLGEBRA. log[(θ·γ)/β] = log θ + log γ − log β. A razão em domínio
   logarítmico vira soma e subtração, sem divisão — a MESMA quantidade,
   monotonicamente transformada, e numericamente estável porque não há
   denominador que cruze zero. O z-score é aplicado sobre a potência EM LOG, ao
   longo do registro inteiro. É por isso que `odrLog` é o padrão, e o motivo
   está dito na interface, não só aqui.

   A DIVERGÊNCIA ENTRE AS DUAS É PROPRIEDADE DA FÓRMULA, NÃO ERRO DE
   IMPLEMENTAÇÃO. Por isso saem as duas séries, a correlação de Spearman entre
   elas e a fração de janelas em que a versão literal escapa de um intervalo
   declarado — que é a assinatura direta do cruzamento de zero no denominador.

   ═══════════════════════════════════════════════════════════════════════════
   LIMITAÇÕES DO PERCEPT EM RELAÇÃO AO PROTOCOLO DE ORIGEM
   ═══════════════════════════════════════════════════════════════════════════

     SSD          o artigo otimiza SNR por decomposição espectro-espacial sobre
                  vários canais por eletrodo. O Percept dá UM par bipolar por
                  hemisfério: SSD não é implementável, e a sensibilidade cai,
                  sobretudo em gama.
     Estimulação  o protocolo original correu com estimulação DESLIGADA. Aqui
                  ela tipicamente está ligada, e a gama entrained em f_stim/2
                  cairia dentro do numerador. Ver a guarda de entrainment.
     Condição     eletrodos externalizados em janela perioperatória lá; gerador
                  implantado e registro crônico aqui. O efeito de lesão
                  subtalâmica agudo do artigo está ausente neste dado.
     Referência   o ODR do artigo é calculado sobre componentes SSD; aqui, sobre
                  o bipolar bruto. Os valores ABSOLUTOS não são comparáveis.

   O QUE ESPERAR. No artigo, o ODR como preditor univariado atingiu acurácia
   balanceada média de 0,61 (DP 0,14), com detecção significativa em 8 de 21
   sujeitos — e isso com SSD, estimulação desligada e rótulo clínico validado
   por vídeo. É marcador EXPLORATÓRIO. Uma série suave e crescente sugere uma
   confiabilidade que ele não tem, e por isso o número aparece na figura.

   Unidades: potência em µV²; z-scores adimensionais; tempo em segundos.      */

import { windowedBandPower, spectralVariation } from '../dsp/features.js';
import { welchPSD } from '../dsp/spectral.js';
import { detectGamma } from '../dsp/gamma.js';
import { nanStats } from '../dsp/nan.js';
import { inferDeviceState } from '../io/devicestate.js';
import { mean, sd, median } from '../stats/descriptive.js';

/* Spearman escrito aqui, e não importado de `profiles`, para não criar
   dependência de `metrics` numa camada de configuração de doença: é só a
   correlação de Pearson sobre os postos, e empates recebem o posto médio.  */
function odrSpearman(a, b) {
  const pares = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (isFinite(a[i]) && isFinite(b[i])) pares.push([a[i], b[i]]);
  if (pares.length < 4) return NaN;
  const posto = v => {
    const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(v.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const medio = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = medio;
      i = j + 1;
    }
    return r;
  };
  const ra = posto(pares.map(p => p[0])), rb = posto(pares.map(p => p[1]));
  const ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) * (ra[i] - ma);
    db += (rb[i] - mb) * (rb[i] - mb);
  }
  return (da > 0 && db > 0) ? num / Math.sqrt(da * db) : NaN;
}

/* ------------------------------------------------------------ constantes -- */

export const ODR_BANDS = {
  theta: { id: 'theta', lo: 4, hi: 8, label: 'θ 4–8 Hz' },
  alpha: { id: 'alpha', lo: 8, hi: 12, label: 'α 8–12 Hz' },
  lowBeta: { id: 'lowBeta', lo: 12, hi: 20, label: 'β↓ 12–20 Hz' },
  highBeta: { id: 'highBeta', lo: 20, hi: 35, label: 'β↑ 20–35 Hz' },
  gammaBroad: { id: 'gammaBroad', lo: 60, hi: 90, label: 'γ larga 60–90 Hz' }
};

const ODR_PADRAO = {
  windowS: 10,
  overlap: 0,
  gammaHalfWidthHz: 2.5,
  gammaSearch: [60, 90],
  entrainToleranceHz: 2.5,
  gammaSource: 'peak',          /* 'peak' | 'broad' */
  formulation: 'log',           /* 'log' | 'literal' */
  allowWithoutGamma: false,     /* variante odrSemGama, só quando pedida */
  literalClip: 10,              /* |odrLiteral| acima disto conta como escape  */
  maxNanPct: 5,
  minSegments: 3
};

const on = (v, k) => isFinite(v) ? +v.toFixed(k == null ? 4 : k) : NaN;

/* z-score de um vetor com NaN, ignorando os ausentes e devolvendo NaN neles.
   A média e o DP saem junto porque são o parâmetro que produziu o número.   */
function odrZ(v) {
  const ok = v.filter(isFinite);
  if (ok.length < 3) return { z: v.map(() => NaN), mean: NaN, sd: NaN, n: ok.length };
  const m = mean(ok), s = sd(ok);
  if (!(s > 0)) return { z: v.map(() => NaN), mean: m, sd: s, n: ok.length };
  return { z: v.map(x => isFinite(x) ? (x - m) / s : NaN), mean: m, sd: s, n: ok.length };
}

const odrLog10 = x => (isFinite(x) && x > 0) ? Math.log10(x) : NaN;

/* Frequência de estimulação do hemisfério, com fontes em ordem de força.

   `inferDeviceState` recebe um registro do domínio do TEMPO, que não carrega
   TherapySnapshot — o snapshot vive no BrainSenseLfp da mesma sessão. Sem esta
   varredura, f_stim volta NaN e a guarda de entrainment fica inerte, o que é o
   pior desfecho possível: nem verifica, nem avisa que não verificou.        */
function odrStimRate(parsed, hemi, estado) {
  if (estado && isFinite(estado.rateHz) && estado.rateHz > 0)
    return { hz: estado.rateHz, source: 'inferDeviceState (' + (estado.evidence || []).join('; ') + ')' };
  const p = parsed || {};
  for (const b of (p.bsLfp || [])) {
    const per = b && b.therapy && b.therapy.perHemi;
    const x = per && (per[hemi] || per.Left || per.Right);
    if (x && isFinite(x.rate) && x.rate > 0) return { hz: x.rate, source: 'BrainSenseLfp.TherapySnapshot' };
  }
  const g = (p.groups || []).find(x => x && x.active) || (p.groups || [])[0];
  const pr = g && (g.programs || []).find(x => x && isFinite(x.rate) && x.rate > 0);
  if (pr) return { hz: pr.rate, source: `programa do grupo ${g.id || ''}`.trim() };
  return { hz: NaN, source: null };
}

/* ========================================================================= */
/*  1. Pico individual de gama                                                */
/* ========================================================================= */

/* gammaPeakOf(x, fs, opts) — localiza o pico de gama UMA VEZ, sobre o espectro
   médio do registro inteiro.

   POR QUE NÃO POR JANELA. Numa janela de 10 s o espectro de gama é ruidoso, o
   pico salta de bin em bin e a banda γpico ± 2,5 Hz passaria a perseguir ruído.
   O artigo define o pico individual do sujeito, não da janela.

   Reaproveita `detectGamma`, que já separa gama endógena de gama *entrained*
   em f_stim/2 e já traz a ressalva de que as duas leituras clínicas são
   opostas.                                                                  */
export function gammaPeakOf(x, fs, opts) {
  opts = opts || {};
  const busca = Array.isArray(opts.gammaSearch) ? opts.gammaSearch : ODR_PADRAO.gammaSearch;
  const tol = isFinite(opts.entrainToleranceHz) ? opts.entrainToleranceHz : ODR_PADRAO.entrainToleranceHz;
  const halfW = isFinite(opts.gammaHalfWidthHz) ? opts.gammaHalfWidthHz : ODR_PADRAO.gammaHalfWidthHz;
  const fStim = isFinite(opts.stimRateHz) && opts.stimRateHz > 0 ? opts.stimRateHz : NaN;

  const w = welchPSD(x, fs, { nperseg: isFinite(opts.nperseg) ? opts.nperseg : Math.round(fs) });
  if (!w || !w.p) return {
    ok: false, source: 'none', peakHz: NaN, band: null,
    reason: (w && w.reason) || 'não foi possível estimar o espectro médio do registro'
  };

  const g = detectGamma(w.f, w.p, {
    stimRateHz: isFinite(fStim) ? fStim : undefined,
    lo: Math.max(30, busca[0] - 20), hi: Math.min(fs / 2 - 1, busca[1] + 10),
    tolHz: tol
  });

  const minProm = isFinite(opts.minGammaProminence) ? opts.minGammaProminence : 0.5;
  const dentroDaBusca = pk => pk && pk.hz >= busca[0] && pk.hz <= busca[1];
  const arrastado = g.entrained || null;

  /* DUAS PENEIRAS ANTES DE ACEITAR UM PICO COMO O γpico DO ARTIGO.

     (a) PROMINÊNCIA MÍNIMA. `detectGamma` aceita qualquer saliência acima de
         0,15 sobre o fundo aperiódico, o que é adequado para descrever um
         espectro mas frouxo demais para definir a banda de um biomarcador: uma
         ondulação de ruído passa. Aqui o piso é `minGammaProminence`,
         declarado na saída.

     (b) NÃO SER MIGALHA AO LADO DO PICO ENTRAINED. Quando gama endógena e gama
         entrained coexistem, aceitar a endógena só faz sentido se ela for
         comparável à outra. Um pico setenta mil vezes mais fraco que o
         subarmônico não é "gama finamente sintonizada coexistindo": é ruído ao
         lado de um artefato de estimulação enorme, e usá-lo como γpico faria o
         ODR medir ruído enquanto o espectro inteiro é dominado pelo engate 1:2.
         O critério é `minPeakRatioToEntrained` da potência do pico endógeno
         sobre a do entrained.                                                */
  const minRazao = isFinite(opts.minPeakRatioToEntrained) ? opts.minPeakRatioToEntrained : 0.1;
  const bruto = dentroDaBusca(g.ftg) ? g.ftg : null;
  const promOk = bruto && isFinite(bruto.prominenceOverAperiodic) && bruto.prominenceOverAperiodic >= minProm;
  const razao = (bruto && arrastado && isFinite(arrastado.power) && arrastado.power > 0)
    ? bruto.power / arrastado.power : Infinity;
  const naoEhMigalha = !arrastado || razao >= minRazao;
  const endogeno = (promOk && naoEhMigalha) ? bruto : null;

  /* O pico entrained DOMINA a faixa de gama? É esta a pergunta que decide a
     recusa do ODR, e não "existe algum pico endógeno em algum lugar". */
  const arrastadoDomina = !!(arrastado && dentroDaBusca(arrastado) && !endogeno);

  return {
    ok: !!endogeno,
    source: endogeno ? 'peak' : 'none',
    minProminence: minProm,
    minPeakRatioToEntrained: minRazao,
    rejectedCandidate: (bruto && !endogeno) ? {
      hz: bruto.hz, prominenceOverAperiodic: bruto.prominenceOverAperiodic,
      powerRatioToEntrained: isFinite(razao) ? +razao.toExponential(3) : null,
      why: !promOk
        ? `saliência de ${bruto.prominenceOverAperiodic} sobre o fundo aperiódico, abaixo do piso declarado de ${minProm}`
        : `potência ${isFinite(razao) ? razao.toExponential(2) : '—'}× a do pico entrained em ` +
          `${arrastado ? arrastado.hz.toFixed(1) : '—'} Hz, abaixo da razão mínima de ${minRazao} — é migalha ao lado ` +
          'do subarmônico, não gama endógena'
    } : null,
    entrainedDominant: arrastadoDomina,
    peakHz: endogeno ? endogeno.hz : NaN,
    band: endogeno ? [+(endogeno.hz - halfW).toFixed(3), +(endogeno.hz + halfW).toFixed(3)] : null,
    halfWidthHz: halfW,
    prominenceOverAperiodic: endogeno ? endogeno.prominenceOverAperiodic : NaN,
    bandwidthHz: endogeno ? endogeno.bandwidthHz : NaN,
    stimRateHz: isFinite(fStim) ? fStim : null,
    subharmonicHz: isFinite(fStim) ? +(fStim / 2).toFixed(2) : null,
    entrainToleranceHz: tol,
    entrained: arrastado,
    entrainedInSearchRange: !!(arrastado && dentroDaBusca(arrastado)),
    detectGammaVerdict: g.verdict,
    searchRange: busca,
    spectrumNperseg: w.nperseg,
    reason: endogeno ? null
      : arrastado
        ? `o pico dominante de gama está em ${arrastado.hz.toFixed(1)} Hz, dentro de ${tol} Hz de f_stim/2 ` +
          `(${(fStim / 2).toFixed(1)} Hz): é resposta subarmônica da rede à própria estimulação, não gama endógena` +
          (bruto ? `. Há um segundo pico em ${bruto.hz.toFixed(1)} Hz, mas ele foi recusado como γpico` : '')
        : `nenhum pico de gama se destaca do fundo aperiódico entre ${busca[0]} e ${busca[1]} Hz com saliência ` +
          `mínima de ${minProm}`
  };
}

/* ========================================================================= */
/*  2. odrSeries — a série por janela                                         */
/* ========================================================================= */

/* odrSeries(entrada, opts)

   entrada = { hemispheres: { Left: {x, fs, record?}, Right: {...} }, parsed? }

   Calcula por hemisfério e depois promedia os dois por janela. Com um
   hemisfério só, calcula mesmo assim e devolve `nHemispheres: 1` — o artigo
   promedia bilateralmente, e uma série unilateral NÃO é a mesma quantidade.  */
export function odrSeries(entrada, opts) {
  const o = Object.assign({}, ODR_PADRAO, opts || {});
  const e = entrada || {};
  const hemis = e.hemispheres || {};
  const lados = ['Left', 'Right'].filter(h => hemis[h] && hemis[h].x && hemis[h].x.length);

  const comum = {
    params: {
      windowS: o.windowS, overlap: o.overlap,
      bands: { theta: [ODR_BANDS.theta.lo, ODR_BANDS.theta.hi], lowBeta: [ODR_BANDS.lowBeta.lo, ODR_BANDS.lowBeta.hi] },
      gammaSearch: o.gammaSearch, gammaHalfWidthHz: o.gammaHalfWidthHz,
      gammaSource: o.gammaSource, formulation: o.formulation,
      entrainToleranceHz: o.entrainToleranceHz,
      zPolicy: 'z-score de cada banda ao longo do registro inteiro; na formulação log, sobre log10 da potência',
      maxNanPct: o.maxNanPct, minSegments: o.minSegments,
      literalClip: o.literalClip
    },
    limitations: ODR_LIMITACOES,
    expectation: ODR_EXPECTATIVA
  };

  if (!lados.length) return Object.assign({ ok: false, nHemispheres: 0 }, comum, {
    reason: 'nenhum hemisfério com sinal bruto utilizável — o ODR precisa do BrainSenseTimeDomain'
  });

  const porHemi = {}, recusas = [];
  lados.forEach(h => {
    const r = odrHemisferio(hemis[h], e.parsed, o, h);
    porHemi[h] = r;
    if (!r.ok) recusas.push(`${h}: ${r.reason}`);
  });

  const usaveis = lados.filter(h => porHemi[h].ok);
  if (!usaveis.length) return Object.assign({ ok: false, nHemispheres: 0, byHemisphere: porHemi }, comum, {
    reason: recusas.join(' · ')
  });

  /* média bilateral por janela, sobre a grade do hemisfério com mais janelas.
     Janela sem valor em algum lado usa o lado que existe, e a saída diz quantos
     lados entraram — porque a média de um lado só não é a mesma quantidade. */
  const nJan = Math.max.apply(null, usaveis.map(h => porHemi[h].windows.length));
  const janelas = [];
  for (let i = 0; i < nJan; i++) {
    const partes = usaveis.map(h => porHemi[h].windows[i]).filter(w => w);
    const logs = partes.map(w => w.odrLog).filter(isFinite);
    const lits = partes.map(w => w.odrLiteral).filter(isFinite);
    const ref = partes[0];
    janelas.push({
      index: i,
      tStartS: ref ? ref.tStartS : NaN,
      tCenterS: ref ? ref.tCenterS : NaN,
      odrLog: logs.length ? on(mean(logs), 5) : NaN,
      odrLiteral: lits.length ? on(mean(lits), 5) : NaN,
      nHemispheresInWindow: logs.length,
      reason: logs.length ? null : (partes.map(w => w.reason).filter(Boolean)[0] || 'nenhum hemisfério válido nesta janela')
    });
  }

  /* divergência entre as duas formulações — propriedade da fórmula */
  const pares = janelas.filter(j => isFinite(j.odrLog) && isFinite(j.odrLiteral));
  const rho = pares.length >= 4 ? odrSpearman(pares.map(j => j.odrLog), pares.map(j => j.odrLiteral)) : NaN;
  const escapes = janelas.filter(j => isFinite(j.odrLiteral) && Math.abs(j.odrLiteral) > o.literalClip).length;
  const comLiteral = janelas.filter(j => isFinite(j.odrLiteral)).length;

  const serie = janelas.map(j => o.formulation === 'literal' ? j.odrLiteral : j.odrLog).filter(isFinite);

  return Object.assign({
    ok: true,
    nHemispheres: usaveis.length,
    hemispheres: usaveis,
    byHemisphere: porHemi,
    windows: janelas,
    nWindows: janelas.length,
    nValidWindows: janelas.filter(j => isFinite(j.odrLog)).length,
    formulationUsed: o.formulation,
    spearmanLogVsLiteral: isFinite(rho) ? on(rho, 4) : NaN,
    literalEscapeFraction: comLiteral ? on(escapes / comLiteral, 4) : NaN,
    literalEscapeCount: escapes,
    literalClip: o.literalClip,
    formulationNote:
      `A divergência entre \`odrLog\` e \`odrLiteral\` é propriedade da fórmula, não erro de implementação: ` +
      `a versão literal divide por um valor z-scored, que cruza zero por construção. ` +
      (comLiteral
        ? `Aqui ${escapes} de ${comLiteral} janela(s) (${(100 * escapes / comLiteral).toFixed(1)}%) têm |ODR literal| > ` +
          `${o.literalClip}, o que é a assinatura direta desse cruzamento. `
        : '') +
      `Correlação de Spearman entre as duas séries: ${isFinite(rho) ? rho.toFixed(3) : '—'}. ` +
      `O padrão é a formulação logarítmica, que é a MESMA razão sem divisão.`,
    mean: serie.length ? on(mean(serie), 5) : NaN,
    median: serie.length ? on(median(serie), 5) : NaN,
    trendPerWindow: odrTendencia(janelas, o.formulation),
    unilateralWarning: usaveis.length === 1
      ? 'apenas um hemisfério entrou no cálculo. O artigo promedia os dois lados, e uma série unilateral não é a ' +
        'mesma quantidade — não compare este valor com um bilateral'
      : null,
    refusals: recusas.length ? recusas : null
  }, comum, { reason: null });
}

/* Inclinação simples do ODR ao longo das janelas, só para a leitura clínica
   dizer "subiu" ou "não se moveu". Não é teste. */
function odrTendencia(janelas, formulacao) {
  const y = [], xs = [];
  janelas.forEach(j => {
    const v = formulacao === 'literal' ? j.odrLiteral : j.odrLog;
    if (isFinite(v)) { y.push(v); xs.push(j.index); }
  });
  if (y.length < 6) return { slope: NaN, n: y.length, note: 'poucas janelas para descrever tendência' };
  const mx = mean(xs), my = mean(y);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < y.length; i++) { sxy += (xs[i] - mx) * (y[i] - my); sxx += (xs[i] - mx) * (xs[i] - mx); }
  const b = sxx > 0 ? sxy / sxx : NaN;
  return {
    slope: on(b, 6), n: y.length,
    note: 'inclinação por janela, descritiva — não é teste de tendência'
  };
}

/* --------------------------------------------------------- por hemisfério - */

function odrHemisferio(lado, parsed, o, hemiId) {
  const x = lado.x, fs = lado.fs;
  const est = nanStats(x);

  /* 1. estado do dispositivo, que decide a guarda de entrainment */
  const estado = lado.record
    ? inferDeviceState(lado.record, parsed, { modality: 'BrainSenseTimeDomain' })
    : { state: 'UNKNOWN', amplitudeMa: NaN, rateHz: NaN, evidence: [], confidence: 'nenhuma' };
  const rate = isFinite(lado.stimRateHz)
    ? { hz: lado.stimRateHz, source: 'informada pelo chamador' }
    : odrStimRate(parsed, hemiId, estado);
  const fStim = rate.hz;

  /* 2. pico individual de gama, uma vez sobre o registro inteiro */
  const gama = gammaPeakOf(x, fs, Object.assign({}, o, { stimRateHz: fStim }));

  /* 3. as guardas, antes de qualquer conta */
  let bandaGama = null, fonteGama = 'none', motivoGama = gama.reason;
  if (o.gammaSource === 'broad') {
    bandaGama = [ODR_BANDS.gammaBroad.lo, ODR_BANDS.gammaBroad.hi];
    fonteGama = 'broad';
    motivoGama = 'banda larga pedida explicitamente pelo usuário — NÃO é o pico individual do artigo, e cada linha ' +
      'exportada sai marcada com gamma_source = broad';
  } else if (gama.ok) {
    bandaGama = gama.band;
    fonteGama = 'peak';
    motivoGama = null;
  }

  /* A guarda de entrainment SÓ É UMA GUARDA quando f_stim é conhecida. Sem ela
     não há como distinguir gama endógena de resposta subarmônica à própria
     estimulação — e as duas leituras clínicas são opostas. Aqui o cálculo
     prossegue, mas a não verificação é marcada e viaja até a linha exportada:
     verificação não feita não é verificação com resultado negativo. */
  const entrainmentChecked = isFinite(fStim) && fStim > 0;

  /* guarda 1: gama entrained em f_stim/2 domina a faixa.
     A condição NÃO é "existe algum pico endógeno em algum lugar" — é se o pico
     que seria usado no numerador é o subarmônico. */
  const arrastadoRelevante = gama.entrainedDominant && fonteGama !== 'broad';
  if (arrastadoRelevante && !o.allowWithoutGamma) return {
    ok: false, hemisphere: hemiId, deviceState: estado, gamma: gama,
    entrainmentRefusal: true,
    reason: `o pico de gama deste hemisfério cai a ${Math.abs(gama.entrained.deltaHz).toFixed(2)} Hz de f_stim/2 ` +
      `(${gama.subharmonicHz} Hz, tolerância ${o.entrainToleranceHz} Hz). O numerador do ODR estaria medindo a ` +
      'resposta subarmônica da rede à própria estimulação, e não gama endógena — e as duas leituras clínicas são ' +
      'OPOSTAS: gama finamente sintonizada é marcador pró-cinético, gama entrained é engate 1:2 da rede à ' +
      'estimulação. O ODR não é calculado. A variante odrSemGama = z(log θ) − z(log β) fica disponível como escolha ' +
      'explícita, com o aviso de que NÃO é o biomarcador do artigo e não tem a mesma sustentação'
  };

  /* guarda 2: sem pico individual e sem substituição pedida */
  const semGama = fonteGama === 'none';
  if (semGama && !o.allowWithoutGamma) return {
    ok: false, hemisphere: hemiId, deviceState: estado, gamma: gama,
    reason: `${motivoGama}. A substituição por gama de banda larga NÃO é feita em silêncio: peça-a em ` +
      '`gammaSource: "broad"` e ela sai marcada em cada linha exportada. Alternativamente, use a variante ' +
      'odrSemGama, que não é o biomarcador do artigo'
  };

  /* 4. potência por banda por janela */
  const bandas = [
    ODR_BANDS.theta, ODR_BANDS.alpha, ODR_BANDS.lowBeta, ODR_BANDS.highBeta, ODR_BANDS.gammaBroad
  ].map(b => ({ id: b.id, lo: b.lo, hi: b.hi }));
  if (bandaGama) bandas.push({ id: 'gammaPeak', lo: bandaGama[0], hi: bandaGama[1] });

  const pot = windowedBandPower(x, fs, bandas, {
    windowS: o.windowS, overlap: o.overlap, maxNanPct: o.maxNanPct, minSegments: o.minSegments
  });
  if (!pot.ok) return {
    ok: false, hemisphere: hemiId, deviceState: estado, gamma: gama,
    reason: pot.reason || 'não foi possível estimar potência por janela neste hemisfério'
  };

  /* 5. z-scores ao longo do registro — em log (padrão) e em potência (literal) */
  const serie = id => pot.windows.map(w => (w.power && isFinite(w.power[id])) ? w.power[id] : NaN);
  const gid = bandaGama ? (fonteGama === 'broad' ? 'gammaBroad' : 'gammaPeak') : null;

  const pTheta = serie('theta'), pBeta = serie('lowBeta');
  const pGamma = gid ? serie(gid) : pot.windows.map(() => NaN);

  const zLogTheta = odrZ(pTheta.map(odrLog10));
  const zLogBeta = odrZ(pBeta.map(odrLog10));
  const zLogGamma = odrZ(pGamma.map(odrLog10));
  const zTheta = odrZ(pTheta), zBeta = odrZ(pBeta), zGamma = odrZ(pGamma);

  const usarGama = !semGama;
  const janelas = pot.windows.map((w, i) => {
    const motivo = w.reason;
    const zlt = zLogTheta.z[i], zlb = zLogBeta.z[i], zlg = zLogGamma.z[i];
    const zt = zTheta.z[i], zb = zBeta.z[i], zg = zGamma.z[i];

    let logv = NaN, litv = NaN, razao = motivo;
    if (!motivo) {
      if (usarGama) {
        logv = (isFinite(zlt) && isFinite(zlg) && isFinite(zlb)) ? zlt + zlg - zlb : NaN;
        litv = (isFinite(zt) && isFinite(zg) && isFinite(zb) && Math.abs(zb) > 1e-12) ? (zt * zg) / zb : NaN;
      } else {
        /* variante declarada: sem o termo de gama */
        logv = (isFinite(zlt) && isFinite(zlb)) ? zlt - zlb : NaN;
        litv = (isFinite(zt) && isFinite(zb) && Math.abs(zb) > 1e-12) ? zt / zb : NaN;
      }
      if (!isFinite(logv)) razao = 'z-score indefinido nesta janela (banda sem variância ao longo do registro)';
    }

    return {
      index: i, tStartS: w.tStartS, tCenterS: w.tCenterS, pctNan: w.pctNan,
      power: w.power,
      nSegmentsUsed: w.nSegmentsUsed, nSegmentsDropped: w.nSegmentsDropped,
      zThetaLog: on(zlt, 5), zGammaLog: on(zlg, 5), zLowBetaLog: on(zlb, 5),
      zTheta: on(zt, 5), zGammaPeak: on(zg, 5), zLowBeta: on(zb, 5),
      odrLog: on(logv, 5), odrLiteral: on(litv, 5),
      reason: razao || null
    };
  });

  return {
    ok: true, hemisphere: hemiId,
    windows: janelas, nWindows: janelas.length,
    nValidWindows: janelas.filter(j => isFinite(j.odrLog)).length,
    gamma: gama, gammaSource: fonteGama, gammaBand: bandaGama, gammaNote: motivoGama,
    entrainmentChecked,
    entrainmentNote: entrainmentChecked
      ? `pico de gama conferido contra f_stim/2 = ${(fStim / 2).toFixed(1)} Hz (tolerância ${o.entrainToleranceHz} Hz): ` +
        (gama.entrainedInSearchRange ? 'CAI dentro da tolerância' : 'fora da tolerância, compatível com gama endógena')
      : 'a frequência de estimulação NÃO está declarada neste arquivo, então o pico de gama não pôde ser conferido ' +
        'contra f_stim/2. Não é o mesmo que dizer que não é entrained: é dizer que não foi possível verificar, e as ' +
        'duas leituras clínicas do achado são opostas',
    stimRateSource: rate.source,
    withoutGamma: semGama || arrastadoRelevante,
    withoutGammaNote: (semGama || arrastadoRelevante)
      ? 'esta série é a variante odrSemGama = z(log θ) − z(log β): NÃO é o biomarcador do artigo, porque o termo de ' +
        'gama — que é justamente o que liga o ODR a discinesia — está ausente'
      : null,
    deviceState: estado,
    stimRateHz: isFinite(fStim) ? fStim : NaN,
    zStats: {
      thetaLog: { mean: on(zLogTheta.mean, 6), sd: on(zLogTheta.sd, 6), n: zLogTheta.n },
      lowBetaLog: { mean: on(zLogBeta.mean, 6), sd: on(zLogBeta.sd, 6), n: zLogBeta.n },
      gammaLog: { mean: on(zLogGamma.mean, 6), sd: on(zLogGamma.sd, 6), n: zLogGamma.n }
    },
    quality: {
      pctNan: on(est.pctNan, 3), nValid: est.nValid,
      longestGapSamples: est.longestGapSamples,
      nWindowsDropped: janelas.filter(j => j.reason).length
    },
    reason: null
  };
}

/* ========================================================================= */
/*  3. Variação espectral por banda — envelope do artigo                      */
/* ========================================================================= */

/* odrSpectralVariation(lado, opts) — CV do envelope nas três bandas do ODR,
   sobre a MESMA grade de janelas, para que as colunas se alinhem na tabela. */
export function odrSpectralVariation(lado, opts) {
  const o = Object.assign({}, ODR_PADRAO, opts || {});
  const x = lado && lado.x, fs = lado && lado.fs;
  if (!x || !x.length) return { ok: false, reason: 'sinal vazio', byBand: {} };
  const bandas = { theta: [4, 8], lowBeta: [12, 20] };
  if (o.gammaBand) bandas.gammaPeak = o.gammaBand;
  const saida = {};
  Object.keys(bandas).forEach(id => {
    saida[id] = spectralVariation(x, fs, bandas[id][0], bandas[id][1], {
      windowS: o.windowS, overlap: o.overlap, maxNanPct: o.maxNanPct,
      perWindow: !!o.cvPerWindow, minMeanFrac: o.minMeanFrac
    });
  });
  const alguma = Object.keys(saida).some(k => saida[k].ok);
  return {
    ok: alguma, byBand: saida,
    bands: bandas,
    windowS: o.windowS,
    note: 'o CV depende do comprimento da janela: comparar CVs de janelas diferentes é erro',
    reason: alguma ? null : 'nenhuma banda produziu CV utilizável'
  };
}

/* ------------------------------------------------------------------------- */

export const ODR_LIMITACOES = [
  {
    item: 'Otimização de SNR',
    artigo: 'SSD (decomposição espectro-espacial) por banda, por eletrodo',
    percept: 'um par bipolar por hemisfério',
    consequencia: 'SSD não é implementável. A sensibilidade cai, sobretudo em gama.'
  },
  {
    item: 'Estimulação',
    artigo: 'desligada durante todo o protocolo',
    percept: 'tipicamente ligada',
    consequencia: 'gama entrained em f_stim/2 cairia dentro do numerador do ODR — há guarda que recusa o cálculo.'
  },
  {
    item: 'Condição de registro',
    artigo: 'eletrodos externalizados, janela perioperatória',
    percept: 'gerador implantado, registro crônico',
    consequencia: 'o efeito de lesão subtalâmica agudo presente no artigo está ausente aqui.'
  },
  {
    item: 'Referência do ODR',
    artigo: 'calculado sobre componentes SSD',
    percept: 'calculado sobre o bipolar bruto',
    consequencia: 'os valores absolutos NÃO são comparáveis com os do artigo.'
  }
];

export const ODR_EXPECTATIVA =
  'No estudo que propôs o ODR (Habets et al., Brain 2026), ele atingiu como preditor univariado acurácia balanceada ' +
  'média de 0,61 (DP 0,14), com detecção significativa em 8 de 21 sujeitos — e isso com SSD, estimulação desligada e ' +
  'rótulo clínico validado por vídeo. É um marcador exploratório: uma série suave e crescente sugere uma ' +
  'confiabilidade que ele não tem.';
