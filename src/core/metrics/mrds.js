/* metrics/mrds.js — MRDS: (des)sincronização relacionada ao movimento
   ------------------------------------------------------------------------
   O QUE É. MRDS (movement-related desynchronization or synchronization) é o
   contraste de potência entre uma época de MOVIMENTO e uma época de REPOUSO,
   normalizado pelo repouso:

       MRDS_x = (PM_x - PR_x) / PR_x

   onde x é o ritmo (β ou γ), PM é a potência sob movimento e PR a potência em
   repouso. Unidade: adimensional (razão). Valor negativo = dessincronização
   (a potência cai com o movimento); positivo = sincronização.

   REFERÊNCIA DO PROTOCOLO. Alves ALM, Simões JS, Trajano da Silva LR, Fim Neto
   A, Godinho F, Carra RB, et al. Transcutaneous Spinal Magnetic Stimulation
   Affects Subthalamic Activity in Parkinson's Disease. Mov Disord
   2025;40(11):2543-5. doi:10.1002/mds.70035. Parâmetros do artigo: 180 s a
   250 Hz, passa-banda 2-100 Hz, z-score por sessão, Welch com janela de 1000
   amostras (4 s), sobreposição de 500 e NFFT de 1000 — resolução de 0,25 Hz;
   β 13-35 Hz, γ 35-100 Hz.

   DOIS NÍVEIS, E É AQUI QUE ESTÁ A LÓGICA DO DESENHO.
   O MRDS por si NÃO remove artefato de movimento: ele É o contraste
   movimento-repouso, e artefato de movimento entra inteiro nesse contraste.
   O que cancela modulação motora estável é o SEGUNDO nível:

       ΔMRDS_x = MRDS_x(pós) - MRDS_x(basal)

   Qualquer efeito do movimento que esteja presente nos dois momentos — inclusive
   artefato, desde que reprodutível — subtrai. Por isso a figura calcula e
   apresenta os dois níveis separados, e nunca chama o primeiro de "controlado".

   DECOMPOSIÇÃO EXATA BANDA-LARGA vs ESPECÍFICA. Seja S_x = P_x / P_total a
   fração do espectro na banda x. Então, sem aproximação:

       1 + MRDS_abs = (1 + MRDS_rel) x (1 + MRDS_total)

   com MRDS_rel calculado sobre S_x e MRDS_total sobre a potência total da faixa
   de análise. O fator (1 + MRDS_total) é o que muda em TODO o espectro — escala
   global, ganho, artefato de banda larga. O fator (1 + MRDS_rel) é o que muda a
   FORMA do espectro, e é o único candidato a (des)sincronização específica de
   banda. A identidade é verificada em teste.                                 */

import { welchPSD, bandPower } from '../dsp/spectral.js';
import { mean, sd, rnd } from '../stats/descriptive.js';
import { tPValue } from '../stats/distributions.js';

export const MRDS_VERSION = '1.0';

export const MRDS_PROTOCOL = {
  source: 'Alves ALM et al., Mov Disord 2025;40(11):2543-5. doi:10.1002/mds.70035',
  fsHz: 250, durationS: 180,
  bandpass: [2, 100], welchWindowSamples: 1000, welchOverlapSamples: 500,
  nfft: 1000, resolutionHz: 0.25,
  note: 'os parâmetros abaixo reproduzem o protocolo publicado; todos são editáveis, ' +
    'e o valor efetivamente usado sai em toda exportação'
};

/* Bandas do protocolo. β e γ são as do artigo; a faixa total é a de análise, e
   existe para a decomposição banda-larga vs específica. */
export const MRDS_BANDS = [
  { key: 'beta', label: 'β', lo: 13, hi: 35 },
  { key: 'gamma', label: 'γ', lo: 35, hi: 100 }
];
export const MRDS_TOTAL_BAND = { key: 'total', label: 'total', lo: 2, hi: 100 };

/* Células do desenho. O eixo basal/pós é OPCIONAL: sem ele a figura entrega o
   MRDS de um único momento, que é uma medida legítima e mais fraca. */
export const MRDS_CELLS = [
  { key: 'rest_baseline', moment: 'baseline', condition: 'rest', label: 'repouso · basal' },
  { key: 'move_baseline', moment: 'baseline', condition: 'move', label: 'movimento · basal' },
  { key: 'rest_post', moment: 'post', condition: 'rest', label: 'repouso · pós' },
  { key: 'move_post', moment: 'post', condition: 'move', label: 'movimento · pós' }
];

export const MRDS_LIMITACOES = [
  'O MRDS é o contraste movimento-repouso, não um contraste corrigido para artefato de ' +
  'movimento. Artefato reprodutível só cancela no segundo nível, ΔMRDS = pós - basal.',
  'A banda γ do protocolo (35-100 Hz) é medida através dos dois passa-baixas de 100 Hz do ' +
  'próprio aparelho, que atenuam de forma crescente ao longo da banda: a metade superior de γ ' +
  'chega ao arquivo já reduzida por projeto [Medtronic UC202012929cEN FY24, p. 11].',
  'Com o passa-alta configurável em 10 Hz, a borda inferior de β (13 Hz) cai na transição do ' +
  'filtro e a potência ali medida é o joelho do filtro, não atividade neural.',
  'O JSON do Percept não carrega rótulo de tarefa: qual gravação é repouso e qual é movimento ' +
  'é declarado por quem analisa, e essa declaração entra na proveniência.',
  'Dois hemisférios do mesmo paciente não são observações independentes. O teste pareado sobre ' +
  'hemisférios responde a uma pergunta sobre hemisférios, não sobre indivíduos.'
];

/* ------------------------------------------------------------------------ */
/*  Normalização                                                            */
/* ------------------------------------------------------------------------ */

/* zscoreEpochs(epochs, scope)
   scope 'record'  — cada época pela própria média e DP;
         'session' — uma única média e DP para todas as épocas da unidade;
         'none'    — sem normalização, potência em µV²/Hz.

   POR QUE O ESCOPO É UMA ESCOLHA DECLARADA. O artigo diz "z-scored for each
   recording session" sem definir se a sessão é a visita inteira ou cada
   gravação. A diferença não é cosmética: com z-score POR GRAVAÇÃO a variância
   de cada época vira 1 por construção, a razão de variâncias entre movimento e
   repouso vira exatamente 1, e o MRDS deixa de medir mudança de potência para
   medir apenas redistribuição espectral. Com escopo de sessão, o MRDS mantém
   sentido absoluto dentro da sessão. As duas leituras são defensáveis; o que
   não é defensável é não dizer qual foi usada.                              */
export function zscoreEpochs(epochs, scope) {
  const modo = scope === 'session' || scope === 'none' ? scope : 'record';
  const finitos = a => Array.prototype.filter.call(a, isFinite);
  let mu = NaN, sigma = NaN;
  if (modo === 'session') {
    const todos = [];
    epochs.forEach(e => { finitos(e.x).forEach(v => todos.push(v)); });
    mu = mean(todos); sigma = sd(todos);
  }
  const out = epochs.map(e => {
    if (modo === 'none') return Object.assign({}, e, { scale: 1, offset: 0 });
    const m = modo === 'session' ? mu : mean(finitos(e.x));
    const s = modo === 'session' ? sigma : sd(finitos(e.x));
    const ok = isFinite(s) && s > 0;
    const y = new Float64Array(e.x.length);
    for (let i = 0; i < e.x.length; i++) y[i] = ok ? (e.x[i] - m) / s : NaN;
    return Object.assign({}, e, { x: y, scale: ok ? 1 / s : NaN, offset: m });
  });
  return {
    epochs: out, scope: modo,
    unit: modo === 'none' ? 'µV²/Hz' : 'adimensional (ad.)',
    /* a consequência algébrica do escopo, escrita para não ser esquecida */
    forcesUnitVariance: modo === 'record',
    note: modo === 'record'
      ? 'z-score por gravação: a variância de cada época é 1 por construção, então a razão de ' +
        'variâncias movimento/repouso é exatamente 1 e o MRDS mede redistribuição espectral, ' +
        'não mudança de potência'
      : modo === 'session'
        ? 'z-score por sessão: uma única escala para todas as épocas da unidade, então o MRDS ' +
          'mantém sentido de mudança de potência dentro da sessão'
        : 'sem normalização: potência em µV²/Hz, comparável apenas dentro de um mesmo bloco de ' +
          'configuração de sensing'
  };
}

/* ------------------------------------------------------------------------ */
/*  PSD de uma época, com os parâmetros do protocolo                        */
/* ------------------------------------------------------------------------ */

/* mrdsEpochPSD(x, fs, opts) — Welch nos parâmetros do artigo.
   Entrada: sinal (µV ou z), fs em Hz. Saída: {f, p, ...qualidade}.
   `exactNfft` reproduz o NFFT de 1000 pontos (0,25 Hz exatos) via Bluestein;
   sem ele o NFFT vai para 1024 e a resolução fica 0,244 Hz — diferença sem
   consequência para leitura por banda, mas que muda o número publicado.     */
export function mrdsEpochPSD(x, fs, opts) {
  const o = opts || {};
  const janela = o.windowSamples || Math.round(4 * fs);
  const sobrep = o.overlap == null ? 0.5 : o.overlap;
  const nfft = o.exactNfft === false ? null : (o.nfft || janela);
  const r = welchPSD(x, fs, {
    nperseg: janela, overlap: sobrep,
    nfft: nfft || undefined,
    maxNanPct: 0
  });
  return Object.assign({}, r, {
    windowSamples: janela, windowSeconds: janela / fs, overlap: sobrep,
    fs
  });
}

/* ------------------------------------------------------------------------ */
/*  MRDS de um par repouso / movimento                                      */
/* ------------------------------------------------------------------------ */

const razao = (pm, pr) => (isFinite(pm) && isFinite(pr) && pr > 0) ? (pm - pr) / pr : NaN;

/* mrdsPair(restPSD, movePSD, opts) → MRDS por banda, com a decomposição.
   Devolve, por banda: PR, PM, mrds (absoluto), share em cada condição,
   mrdsRelative (sobre a fração do espectro) e mrdsTotal (comum a todas as
   bandas). A identidade 1+abs = (1+rel)(1+total) vale exatamente.           */
export function mrdsPair(restPSD, movePSD, opts) {
  const o = opts || {};
  const bandas = o.bands || MRDS_BANDS;
  const total = o.totalBand || MRDS_TOTAL_BAND;
  if (!restPSD || !restPSD.p || !movePSD || !movePSD.p) {
    return { ok: false, reason: (restPSD && restPSD.reason) || (movePSD && movePSD.reason) || 'espectro indisponível em uma das condições', bands: [] };
  }
  const PRt = bandPower(restPSD.f, restPSD.p, total.lo, total.hi);
  const PMt = bandPower(movePSD.f, movePSD.p, total.lo, total.hi);
  const mrdsTotal = razao(PMt, PRt);

  const bands = bandas.map(b => {
    const PR = bandPower(restPSD.f, restPSD.p, b.lo, b.hi);
    const PM = bandPower(movePSD.f, movePSD.p, b.lo, b.hi);
    const shareR = PRt > 0 ? PR / PRt : NaN;
    const shareM = PMt > 0 ? PM / PMt : NaN;
    return {
      key: b.key, label: b.label, lo: b.lo, hi: b.hi,
      PR, PM, mrds: razao(PM, PR),
      shareRest: shareR, shareMove: shareM,
      mrdsRelative: razao(shareM, shareR)
    };
  });
  return {
    ok: true, bands, mrdsTotal, PRtotal: PRt, PMtotal: PMt,
    totalBand: total,
    nSegmentsRest: restPSD.nSegments, nSegmentsMove: movePSD.nSegments,
    df: restPSD.df, nfft: restPSD.nfft
  };
}

/* mrdsBroadbandVerdict(par, opts) — o discriminador honesto.
   Se (1 + MRDS_total) explica quase todo o (1 + MRDS_abs), a mudança é de
   escala em todo o espectro: compatível com artefato de movimento, com ganho
   e com qualquer coisa que multiplique o sinal — e NÃO é evidência de
   (des)sincronização específica de banda.                                   */
export function mrdsBroadbandVerdict(par, opts) {
  const o = opts || {};
  const piso = isFinite(o.relativeFloor) ? o.relativeFloor : 0.05;
  if (!par || !par.ok) return { ok: false };
  const esp = par.bands.filter(b => isFinite(b.mrdsRelative) && Math.abs(b.mrdsRelative) >= piso);
  const bandaLarga = isFinite(par.mrdsTotal) && Math.abs(par.mrdsTotal) >= piso;
  return {
    ok: true, relativeFloor: piso,
    broadband: bandaLarga, bandSpecific: esp.map(b => b.key),
    verdict: !esp.length && bandaLarga
      ? 'mudança de banda larga: a potência muda em todo o espectro e nenhuma banda muda de fração — ' +
        'compatível com artefato de movimento ou mudança de escala, não com dessincronização específica'
      : esp.length && !bandaLarga
        ? `mudança específica de banda (${esp.map(b => b.label).join(', ')}): a forma do espectro muda ` +
          'sem mudança proporcional no total'
        : esp.length && bandaLarga
          ? `mudança mista: o espectro inteiro se desloca (${rnd(100 * par.mrdsTotal, 1)}%) e além disso ` +
            `${esp.map(b => b.label).join(', ')} muda de fração`
          : 'nenhuma mudança acima do piso declarado, nem em banda larga nem em fração de banda'
  };
}

/* ------------------------------------------------------------------------ */
/*  Desenho completo: unidades x momentos                                   */
/* ------------------------------------------------------------------------ */

/* mrdsDesign(units, opts)
   units: [{ id, subject, hemisphere, cells: { rest_baseline: Float64Array, ... }, fs }]
   Cada unidade é tipicamente um hemisfério. `subject` existe para separar o n
   de hemisférios do n de indivíduos no relato estatístico.

   Devolve por unidade: baseline, post e delta (ΔMRDS por banda); e no grupo,
   o teste pareado sobre ΔMRDS quando há dois momentos.                      */
export function mrdsDesign(units, opts) {
  const o = opts || {};
  const escopo = o.zscoreScope || 'session';
  const bandas = o.bands || MRDS_BANDS;

  const resultados = (units || []).map(u => {
    const chaves = MRDS_CELLS.map(c => c.key).filter(k => u.cells && u.cells[k] && u.cells[k].length);
    const norm = zscoreEpochs(chaves.map(k => ({ key: k, x: u.cells[k] })), escopo);
    const psd = {};
    norm.epochs.forEach(e => { psd[e.key] = mrdsEpochPSD(e.x, u.fs, o); });

    const varDe = k => {
      const e = norm.epochs.find(z => z.key === k);
      if (!e) return NaN;
      const v = Array.prototype.filter.call(e.x, isFinite);
      return v.length > 1 ? sd(v) * sd(v) : NaN;
    };

    const momento = (r, m) => {
      if (!psd[r] || !psd[m]) return null;
      const par = mrdsPair(psd[r], psd[m], o);
      return Object.assign(par, {
        verdict: mrdsBroadbandVerdict(par, o),
        varianceRatio: varDe(m) / varDe(r)
      });
    };
    const basal = momento('rest_baseline', 'move_baseline');
    const pos = momento('rest_post', 'move_post');

    const delta = (basal && basal.ok && pos && pos.ok) ? bandas.map(b => {
      const a = basal.bands.find(x => x.key === b.key), c = pos.bands.find(x => x.key === b.key);
      return {
        key: b.key, label: b.label,
        baseline: a ? a.mrds : NaN, post: c ? c.mrds : NaN,
        delta: (a && c) ? c.mrds - a.mrds : NaN,
        baselineRelative: a ? a.mrdsRelative : NaN, postRelative: c ? c.mrdsRelative : NaN,
        deltaRelative: (a && c) ? c.mrdsRelative - a.mrdsRelative : NaN
      };
    }) : null;

    return {
      id: u.id, subject: u.subject || u.id, hemisphere: u.hemisphere || '?',
      cellsPresent: chaves, normalization: norm, psd,
      baseline: basal, post: pos, delta,
      quality: u.quality || null
    };
  });

  /* estatística de grupo sobre ΔMRDS, só quando há os dois momentos */
  const comDelta = resultados.filter(r => r.delta);
  const testes = {};
  if (comDelta.length >= 2) bandas.forEach(b => {
    const vals = comDelta.map(r => (r.delta.find(x => x.key === b.key) || {}).delta).filter(isFinite);
    testes[b.key] = mrdsSignFlipTest(vals, {
      nUnits: vals.length,
      nSubjects: new Set(comDelta.map(r => r.subject)).size
    });
  });

  return {
    version: MRDS_VERSION, units: resultados,
    zscoreScope: escopo, unit: (resultados[0] && resultados[0].normalization.unit) || null,
    bands: bandas, tests: testes,
    nUnits: resultados.length,
    nSubjects: new Set(resultados.map(r => r.subject)).size,
    hasBothMoments: comDelta.length > 0,
    protocol: MRDS_PROTOCOL, limitations: MRDS_LIMITACOES
  };
}

/* ------------------------------------------------------------------------ */
/*  Teste pareado por troca de sinal                                        */
/* ------------------------------------------------------------------------ */

/* mrdsSignFlipTest(diffs, meta) — permutação pareada por troca de sinal.
   Com n pequeno (o caso desta análise: 2 pacientes, 4 hemisférios) o espaço de
   permutações tem 2^n elementos e é ENUMERADO por inteiro: o p é exato e
   determinístico, sem semente e sem Monte Carlo. Acima de 20 unidades cai para
   amostragem determinística por varredura de bits.

   O p mínimo alcançável com n unidades é 2/2^n (bicaudal, incluindo a
   observação). Com n = 4 isso é 0,125: NENHUM resultado pode ser significativo
   a 0,05, e o teste diz isso em vez de devolver um número que parece uma
   resposta.                                                                  */
export function mrdsSignFlipTest(diffs, meta) {
  const d = (diffs || []).filter(isFinite);
  const n = d.length;
  const m = meta || {};
  const base = {
    n, nUnits: m.nUnits == null ? n : m.nUnits, nSubjects: m.nSubjects == null ? null : m.nSubjects,
    mean: n ? mean(d) : NaN, sd: n > 1 ? sd(d) : NaN
  };
  if (n < 2) return Object.assign(base, { p: NaN, exact: false, reason: 'menos de 2 unidades pareadas' });
  const obs = Math.abs(mean(d));
  const total = Math.pow(2, n);
  let extremos = 0;
  if (n <= 20) {
    for (let mask = 0; mask < total; mask++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += (mask >> i & 1) ? -d[i] : d[i];
      if (Math.abs(s / n) >= obs - 1e-12) extremos++;
    }
  }
  const p = n <= 20 ? extremos / total : NaN;
  const pMin = 2 / total;

  /* t pareado, para deixar a discordância VISÍVEL em vez de escondida na
     escolha do teste. Com n pequeno o t pode descer abaixo de 0,05 onde a
     permutação exata não consegue: toda essa diferença é a suposição de
     normalidade que 4 pontos não sustentam nem refutam. Reportar os dois é a
     única forma honesta de apresentar um p com este n.                      */
  const dp = n > 1 ? sd(d) : NaN;
  const tObs = (isFinite(dp) && dp > 0) ? mean(d) / (dp / Math.sqrt(n)) : NaN;
  const tp = isFinite(tObs) ? tPValue(Math.abs(tObs), n - 1) : NaN;

  return Object.assign(base, {
    p, exact: n <= 20, nPermutations: n <= 20 ? total : 0,
    minAchievableP: pMin,
    tTest: { t: tObs, df: n - 1, p: tp },
    testsDisagree: isFinite(tp) && isFinite(p) && (tp < 0.05) !== (p < 0.05),
    underpowered: pMin > 0.05,
    reason: pMin > 0.05
      ? `com ${n} unidades pareadas o menor p possível é ${pMin.toFixed(3)}: nenhum resultado pode ` +
        'atingir 0,05, independentemente do tamanho do efeito'
      : null,
    /* o n que importa para inferência sobre pessoas */
    subjectNote: m.nSubjects != null && m.nSubjects < n
      ? `${n} unidades vêm de ${m.nSubjects} indivíduo(s): hemisférios do mesmo paciente não são ` +
        'independentes, e este p responde sobre hemisférios, não sobre pessoas'
      : null
  });
}

/* ------------------------------------------------------------------------ */
/*  Exportação                                                              */
/* ------------------------------------------------------------------------ */

export const MRDS_COLUMNS = [
  'unit_id', 'subject_id', 'hemisphere', 'moment', 'band', 'band_lo_hz', 'band_hi_hz',
  'power_rest', 'power_move', 'mrds', 'share_rest', 'share_move', 'mrds_relative',
  'mrds_total_band', 'variance_ratio_move_rest', 'mrds_delta_post_minus_baseline',
  'n_segments_rest', 'n_segments_move', 'zscore_scope', 'unit_of_power',
  'welch_window_samples', 'welch_overlap', 'nfft', 'resolution_hz',
  'n_units', 'n_subjects', 'paired_p_permutation', 'paired_p_exact',
  'min_achievable_p', 'paired_p_ttest'
];

/* mrdsTable(res) — uma linha por unidade x momento x banda. Cabeçalhos em
   inglês: a tabela é feita para entrar em script de R sem renomear coluna, e
   cada linha carrega os parâmetros que a produziram.                        */
export function mrdsTable(res) {
  if (!res || !res.units) return [];
  const linhas = [];
  res.units.forEach(u => {
    [['baseline', u.baseline], ['post', u.post]].forEach(([mom, par]) => {
      if (!par || !par.ok) return;
      par.bands.forEach(b => {
        const dl = u.delta ? u.delta.find(x => x.key === b.key) : null;
        const tst = res.tests[b.key] || {};
        linhas.push({
          unit_id: u.id, subject_id: u.subject, hemisphere: u.hemisphere,
          moment: mom, band: b.key, band_lo_hz: b.lo, band_hi_hz: b.hi,
          power_rest: rnd(b.PR, 6), power_move: rnd(b.PM, 6), mrds: rnd(b.mrds, 5),
          share_rest: rnd(b.shareRest, 5), share_move: rnd(b.shareMove, 5),
          mrds_relative: rnd(b.mrdsRelative, 5),
          mrds_total_band: rnd(par.mrdsTotal, 5),
          variance_ratio_move_rest: rnd(par.varianceRatio, 5),
          mrds_delta_post_minus_baseline: dl ? rnd(dl.delta, 5) : '',
          n_segments_rest: par.nSegmentsRest, n_segments_move: par.nSegmentsMove,
          zscore_scope: res.zscoreScope, unit_of_power: res.unit,
          welch_window_samples: (u.psd.rest_baseline || u.psd.rest_post || {}).windowSamples || '',
          welch_overlap: (u.psd.rest_baseline || u.psd.rest_post || {}).overlap || '',
          nfft: par.nfft, resolution_hz: rnd(par.df, 5),
          n_units: res.nUnits, n_subjects: res.nSubjects,
          paired_p_permutation: isFinite(tst.p) ? rnd(tst.p, 5) : '',
          paired_p_exact: tst.exact ? 1 : 0,
          min_achievable_p: isFinite(tst.minAchievableP) ? rnd(tst.minAchievableP, 5) : '',
          paired_p_ttest: (tst.tTest && isFinite(tst.tTest.p)) ? rnd(tst.tTest.p, 5) : ''
        });
      });
    });
  });
  return linhas;
}

/* Bloco de metadados comentado, no mesmo formato das outras exportações:
   quem lê o CSV em R recebe junto o protocolo, o escopo e as limitações. */
export function mrdsMeta(res) {
  const L = [
    '# MRDS — (des)sincronização relacionada ao movimento',
    '# MRDS_x = (P_movimento_x - P_repouso_x) / P_repouso_x   [adimensional]',
    '# delta_MRDS = MRDS(pos) - MRDS(basal)   — é aqui que modulação motora estável cancela',
    `# protocolo: ${MRDS_PROTOCOL.source}`,
    `# z-score: ${res.zscoreScope} · unidade: ${res.unit}`,
    `# n unidades: ${res.nUnits} · n indivíduos: ${res.nSubjects}`,
    '# decomposicao exata: 1 + mrds = (1 + mrds_relative) * (1 + mrds_total_band)'
  ];
  MRDS_LIMITACOES.forEach(x => L.push('# limitacao: ' + x));
  return L.join('\n');
}

/* mrdsReading(res) — leitura em texto corrido, sem verbo de conduta. */
export function mrdsReading(res) {
  if (!res || !res.units || !res.units.length) return null;
  const partes = [];
  const b = res.bands[0] ? res.bands[0].key : 'beta';
  const comBasal = res.units.filter(u => u.baseline && u.baseline.ok);
  if (!comBasal.length) return null;
  const vals = comBasal.map(u => (u.baseline.bands.find(x => x.key === b) || {}).mrds).filter(isFinite);
  if (vals.length) partes.push(
    `MRDS de ${res.bands[0].label} em ${vals.length} unidade(s): mediana de ${rnd(100 * mean(vals), 1)}% ` +
    `(negativo = dessincronização com o movimento).`);
  const bl = comBasal.map(u => u.baseline.verdict).filter(v => v && v.ok);
  const larga = bl.filter(v => v.broadband && !v.bandSpecific.length).length;
  if (larga) partes.push(
    `${larga} de ${bl.length} unidade(s) mostram mudança de banda larga sem mudança de fração de banda — ` +
    'nessas, o contraste movimento-repouso é compatível com escala global ou artefato de movimento.');
  if (res.hasBothMoments) {
    const t = res.tests[b];
    if (t && isFinite(t.p)) partes.push(
      `ΔMRDS de ${res.bands[0].label}: média de ${rnd(t.mean, 3)} em ${t.n} unidade(s), p = ${rnd(t.p, 3)} ` +
      `(permutação pareada exata${t.underpowered ? `; menor p possível ${rnd(t.minAchievableP, 3)}` : ''}).`);
    if (t && t.testsDisagree) partes.push(
      `O t pareado dá p = ${rnd(t.tTest.p, 3)} para o mesmo dado: a discordância entre os dois testes é ` +
      'inteiramente a suposição de normalidade, que este n não sustenta nem refuta.');
    if (t && t.subjectNote) partes.push(t.subjectNote + '.');
  } else {
    partes.push('Sem o momento pós-intervenção, só o primeiro nível é calculável: o contraste ' +
      'movimento-repouso não separa efeito neural de artefato de movimento.');
  }
  return partes.join(' ');
}
