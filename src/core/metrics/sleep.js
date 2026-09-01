/* metrics/sleep.js — arquitetura do sono estimada SÓ do LFP crônico (metrics)

   Reprodução adaptada do método de Averna et al., Mov Disord 2026
   (doi:10.1002/mds.70493): decodificação de estágios de sono (Vigília, REM,
   NREM leve "Core", NREM profundo "Deep") a partir do BrainSense Timeline
   (potência média por 10 min numa banda de ±2,5 Hz), usando os três
   biomarcadores do artigo — beta, atividade de baixa frequência (~8 Hz) e
   finely-tuned gamma (FTG, metade da frequência de estimulação).

   A DIFERENÇA DECLARADA em relação ao artigo: lá o estadiamento de referência
   vinha de um sensor vestível (Apple Watch), que (1) definia o intervalo de
   sono de cada noite e (2) rotulava as épocas para treinar um classificador
   supervisionado (RUSBoost). AQUI NÃO HÁ SENSOR. As duas funções são
   substituídas por alternativas locais e declaradas:
   (1) o intervalo de sono vem do detector circadiano do TIDAL-DT
       (cosinor 24+12 h + change-point) OU de horários habituais informados
       pelo usuário — que é exatamente o que o artigo usou para configurar o
       relógio (horários de cama auto-relatados);
   (2) a classificação é NÃO supervisionada por centróide mais próximo, usando
       como centróides os z-scores medianos por estágio PUBLICADOS no próprio
       artigo (Fig. 3C) — transferência de conhecimento de grupo, não ajuste
       ao indivíduo. O desempenho esperado é, por construção, INFERIOR ao dos
       modelos treinados do artigo; cada estágio carrega sua ressalva.

   Unidades: entrada em potência LFP nativa do Timeline (adimensional,
   LFP_POWER_UNIT); z-scores por intervalo de sono (como no artigo); tempos em
   ms de época (grade de 10 min) e horas locais decimais. */

import { localDayKey, localHour } from '../io/parse.js';
import { mean, median, quantile } from '../stats/descriptive.js';
import { hampelFilter, detectWakeWindow, tidalRng, TIDAL_DEFAULTS } from './tidal.js';

export const SLEEP_VERSION = '1.0';

export const SLEEP_REFS = [
  { key: 'averna2026', doi: '10.1002/mds.70493', note: 'método-fonte: 3 biomarcadores do Timeline (beta, low-freq, FTG), z-score por intervalo de sono, estágios Awake/Core/Deep/REM' },
  { key: 'colombo2025', doi: '10.1002/mds.30160', note: 'pipeline de pré-processamento ambulatorial do mesmo grupo (alinhamento, outliers)' },
  { key: 'christensen2019', doi: '10.1111/jsr.12806', note: 'inferência de estágio de sono a partir de LFP do STN (registros de alta resolução)' },
  { key: 'chen2019', ref: 'IEEE Trans Neural Syst Rehabil Eng 2019;27:118-128', note: 'classificação automática de estágios com LFP subtalâmico' },
  { key: 'yin2023', doi: '10.1038/s41467-023-41128-6', note: 'no GPi o beta patológico se SUSTENTA durante o sono — os centróides do STN não se transferem ao palidal' },
  { key: 'vanrheede2022', doi: '10.1038/s41531-022-00350-7', note: 'modulação diurna do beta subtalâmico em registros crônicos' },
  { key: 'baumgartner2025', doi: '10.1093/sleep/zsaf005', note: 'flutuação naturalística do LFP subtalâmico com o ciclo sono-vigília' }
];

export const SLEEP_DISCLAIMER =
  'Estimativa exploratória de pesquisa. NÃO é polissonografia, não diagnostica transtornos do sono e ' +
  'não substitui avaliação clínica. Sem sensor de referência, os estágios são inferidos por ' +
  'transferência de centróides de grupo (Averna 2026, Fig. 3C) e herdam as limitações declaradas.';

export const SLEEP_DEFAULTS = {
  epochMs: 600000,            /* grade de 10 min — a resolução nativa do Timeline */
  hampelWindow: TIDAL_DEFAULTS.hampelWindow,
  hampelK: TIDAL_DEFAULTS.hampelK,
  minValidEpochs: 12,         /* ≥2 h de épocas válidas para o z-score da noite ser estável */
  minNightCoverage: 0.70,     /* noite com <70% de épocas classificáveis não entra no agregado */
  minNights: 3,               /* menos que isso: agregado marcado como insuficiente */
  marginFloor: 0.15           /* z; margem 1º–2º centróide abaixo disso = baixa confiança */
};

/* Ordem canônica dos estágios (a mesma do artigo). */
export const SLEEP_STAGES = ['awake', 'rem', 'core', 'deep'];

export const SLEEP_STAGE_LABELS = {
  awake: 'vigília noturna',
  rem: 'REM (estimado)',
  core: 'NREM leve (N1–N2, "Core")',
  deep: 'NREM profundo (N3, "Deep")'
};

/* Centróides por estágio: z-score mediano de grupo de cada biomarcador,
   digitalizado da Fig. 3C de Averna 2026 (aproximação visual declarada — o
   suplemento com a tabela numérica não é público). beta e FTG: altos na
   vigília noturna e no REM, baixos no Deep; low-frequency: o oposto, alta no
   Deep. É esse antagonismo que carrega a informação de estágio.             */
export const SLEEP_CENTROIDS = {
  awake: { beta: 0.85, ftg: 0.55, low: -0.10 },
  rem: { beta: 0.20, ftg: 0.55, low: -0.15 },
  core: { beta: -0.30, ftg: -0.30, low: 0.05 },
  deep: { beta: -0.55, ftg: -0.55, low: 0.65 }
};

export const SLEEP_CENTROID_SOURCE =
  'Averna et al., Mov Disord 2026 (doi:10.1002/mds.70493), Fig. 3C — z-scores medianos de grupo por estágio, digitalizados da figura (aproximação declarada)';

/* Valores de referência da coorte do artigo (18 pacientes DP, ~3140 h),
   para as linhas de comparação da figura: proporção média por estágio e
   tempo de sono derivado do vestível.                                       */
export const SLEEP_COHORT_REF = {
  awakePct: 19.5, corePct: 67.1, deepPct: 9.8, remPct: 9.5,
  tstH: 5.52,
  source: 'Averna 2026, Results (média da coorte; referência descritiva, não normativa)'
};

/* classifyBiomarker(centerHz) — tipa a banda de sensing do Timeline no vocabulário
   do artigo: low (<13 Hz — lá 7,81±2,5 ou pico alfa), beta [13–35), FTG (≥35 —
   lá 62,5 = metade da frequência de estimulação). Intervalo meio-aberto no 13 e
   no 35, coerente com bandPower. Sem frequência declarada no arquivo, assume
   beta E DIZ que assumiu — beta é a banda de sensing padrão do Percept, mas a
   suposição fica gravada em `assumed` e aparece na figura.                  */
export function classifyBiomarker(centerHz) {
  if (!isFinite(centerHz)) {
    return { type: 'beta', centerHz: NaN, assumed: true, label: 'banda de sensing não declarada no arquivo — tratada como beta (suposição declarada)' };
  }
  const type = centerHz < 13 ? 'low' : centerHz < 35 ? 'beta' : 'ftg';
  const nome = { low: 'baixa frequência', beta: 'beta', ftg: 'FTG (gama fino)' }[type];
  return { type, centerHz, assumed: false, label: `${nome} — sensing em ${centerHz.toFixed(2)} Hz` };
}

/* sleepWindowOf(wake) — o intervalo de sono é o complemento da vigília:
   [fim da vigília, início da vigília], circular nas 24 h.                   */
export function sleepWindowOf(wake) {
  return [wake[1], wake[0]];
}

/* nightIntervals(tMin, tMax, offMin, sleep, epochMs)
   Gera as noites do registro: a noite do dia local D começa em D às
   `sleep[0]` horas e dura ((sleep[1]−sleep[0]) mod 24) horas — atravessando a
   meia-noite quando preciso. Cada noite vira uma grade de épocas de
   `epochMs`. Noites totalmente fora do intervalo dos dados não entram.      */
export function nightIntervals(tMin, tMax, offMin, sleep, epochMs) {
  const ep = isFinite(epochMs) && epochMs > 0 ? epochMs : SLEEP_DEFAULTS.epochMs;
  const durH = (((sleep[1] - sleep[0]) % 24) + 24) % 24;
  if (!(durH > 0)) return { ok: false, reason: 'janela de sono com duração nula', nights: [] };
  const DIA = 864e5;
  const inicioDoDia = chave => Date.parse(chave + 'T00:00:00Z') - offMin * 60000;
  const nights = [];
  const d0 = inicioDoDia(localDayKey(tMin, offMin)) - DIA;   /* a noite anterior pode invadir o 1º dia */
  for (let t = d0, guard = 0; t <= tMax + DIA / 2 && guard < 400; t += DIA, guard++) {
    const dayKey = localDayKey(t + DIA / 2, offMin);
    const t0 = inicioDoDia(dayKey) + sleep[0] * 36e5;
    const nEpochs = Math.max(1, Math.round(durH * 36e5 / ep));
    const t1 = t0 + nEpochs * ep;
    if (t1 <= tMin || t0 >= tMax) continue;
    nights.push({ nightKey: dayKey, t0, t1, nEpochs });
  }
  return { ok: nights.length > 0, nights, params: { epochMs: ep, sleep: sleep.slice(), durH } };
}

/* epochSeries(rows, night, epochMs) — média por época dos valores válidos de
   uma série [{t, v}] dentro da noite. Época sem amostra é NaN — perda de
   pacote continua perda, nunca interpolação.                                */
export function epochSeries(rows, night, epochMs) {
  const soma = new Float64Array(night.nEpochs);
  const cont = new Float64Array(night.nEpochs);
  rows.forEach(r => {
    if (!r || !isFinite(r.t) || !isFinite(r.v)) return;
    if (r.t < night.t0 || r.t >= night.t1) return;
    const e = Math.floor((r.t - night.t0) / epochMs);
    if (e >= 0 && e < night.nEpochs) { soma[e] += r.v; cont[e]++; }
  });
  const v = new Array(night.nEpochs);
  let nValid = 0;
  for (let e = 0; e < night.nEpochs; e++) {
    v[e] = cont[e] ? soma[e] / cont[e] : NaN;
    if (cont[e]) nValid++;
  }
  return { values: v, nValid };
}

/* zscoreInterval(values) — z-score DENTRO do intervalo de sono, exatamente a
   normalização do artigo ("power values were z-scored within every sleep
   interval"). Exige n mínimo e desvio-padrão positivo; caso contrário a noite
   é inutilizável para aquele biomarcador (e diz por quê).                   */
export function zscoreInterval(values, minValid) {
  const fin = values.filter(isFinite);
  const minN = isFinite(minValid) ? minValid : SLEEP_DEFAULTS.minValidEpochs;
  if (fin.length < minN) return { ok: false, reason: `apenas ${fin.length} épocas válidas (<${minN})`, z: values.map(() => NaN) };
  const mu = mean(fin);
  const sdv = Math.sqrt(fin.reduce((a, v) => a + (v - mu) * (v - mu), 0) / fin.length);
  if (!(sdv > 0)) return { ok: false, reason: 'desvio-padrão nulo no intervalo', z: values.map(() => NaN) };
  return { ok: true, mu, sd: sdv, nValid: fin.length, z: values.map(v => isFinite(v) ? (v - mu) / sdv : NaN) };
}

/* stageEpochs(zByType, opts) — o classificador: centróide mais próximo no
   espaço dos biomarcadores DISPONÍVEIS (distância euclidiana nos z).
   Época classificável = todos os tipos do combo com z válido. `margin` é a
   diferença de distância para o 2º centróide — margem pequena = época de
   baixa confiança, marcada e contada, nunca escondida.                      */
export function stageEpochs(zByType, opts) {
  const o = opts || {};
  const marginFloor = isFinite(o.marginFloor) ? o.marginFloor : SLEEP_DEFAULTS.marginFloor;
  const types = Object.keys(zByType).filter(t => SLEEP_CENTROIDS.awake[t] !== undefined);
  if (!types.length) return { ok: false, reason: 'nenhum biomarcador tipado disponível' };
  const n = zByType[types[0]].length;
  const stages = new Array(n).fill(null);
  const margins = new Array(n).fill(NaN);
  const lowConf = new Array(n).fill(false);
  let nClassified = 0, nLow = 0;
  for (let e = 0; e < n; e++) {
    let okEp = true;
    for (const t of types) if (!isFinite(zByType[t][e])) { okEp = false; break; }
    if (!okEp) continue;
    let best = null, bestD = Infinity, secondD = Infinity;
    for (const st of SLEEP_STAGES) {
      let d2 = 0;
      for (const t of types) { const d = zByType[t][e] - SLEEP_CENTROIDS[st][t]; d2 += d * d; }
      const dist = Math.sqrt(d2);
      if (dist < bestD) { secondD = bestD; bestD = dist; best = st; }
      else if (dist < secondD) secondD = dist;
    }
    stages[e] = best;
    margins[e] = secondD - bestD;
    if (margins[e] < marginFloor) { lowConf[e] = true; nLow++; }
    nClassified++;
  }
  return { ok: nClassified > 0, stages, margins, lowConfidence: lowConf, nClassified, nLowConfidence: nLow, types, params: { marginFloor } };
}

/* nightArchitecture(stages, epochMs) — métricas de arquitetura de UMA noite,
   sobre as épocas classificadas: proporção por estágio, latência de início de
   sono (1ª época não-vigília), TST, WASO, nº de despertares e transições por
   hora (fragmentação). Convenções da polissonografia aplicadas à grade de
   10 min — declarado: uma época aqui são 10 min, não 30 s, e microdespertares
   somem por construção.                                                     */
export function nightArchitecture(stages, epochMs) {
  const ep = isFinite(epochMs) && epochMs > 0 ? epochMs : SLEEP_DEFAULTS.epochMs;
  const idx = [];
  stages.forEach((s, i) => { if (s) idx.push(i); });
  if (!idx.length) return { ok: false, reason: 'nenhuma época classificada' };
  const count = { awake: 0, rem: 0, core: 0, deep: 0 };
  idx.forEach(i => count[stages[i]]++);
  const n = idx.length;
  const onsetPos = idx.find(i => stages[i] !== 'awake');
  const onset = onsetPos === undefined ? null : onsetPos;
  let waso = 0, awakenings = 0, transitions = 0;
  let prev = null, prevI = -10, emVigilia = false;
  idx.forEach(i => {
    const s = stages[i];
    if (onset !== null && i > onset && s === 'awake') {
      waso++;
      if (!emVigilia) awakenings++;
      emVigilia = true;
    } else emVigilia = false;
    if (prev !== null && i === prevI + 1 && s !== prev) transitions++;  /* só entre épocas contíguas */
    prev = s; prevI = i;
  });
  const horasClass = n * ep / 36e5;
  return {
    ok: true,
    nEpochsClassified: n,
    pct: {
      awake: +(100 * count.awake / n).toFixed(1), rem: +(100 * count.rem / n).toFixed(1),
      core: +(100 * count.core / n).toFixed(1), deep: +(100 * count.deep / n).toFixed(1)
    },
    counts: count,
    tstH: +((n - count.awake) * ep / 36e5).toFixed(2),
    solMin: onset === null ? NaN : +(onset * ep / 60000).toFixed(0),
    wasoMin: +(waso * ep / 60000).toFixed(0),
    nAwakenings: awakenings,
    transitionsPerH: horasClass > 0 ? +(transitions / horasClass).toFixed(2) : NaN
  };
}

/* stageCaveats(types) — as ressalvas POR COMBINAÇÃO de biomarcadores, tiradas
   dos resultados do artigo. São elas que impedem a figura de prometer mais do
   que o dado sustenta.                                                      */
export function stageCaveats(types) {
  const tem = t => types.indexOf(t) >= 0;
  const avisos = [];
  avisos.push('classificação por centróides de GRUPO (Averna 2026, Fig. 3C), sem treinamento no indivíduo: ' +
    'desempenho esperado abaixo dos modelos personalizados do artigo (LOPO ≈ sensibilidade 56–75% conforme o estágio)');
  if (!tem('low') && !tem('ftg')) {
    avisos.push('apenas beta disponível: REM e vigília noturna são pouco separáveis (beta elevado em ambos — Fig. 3C), ' +
      'e Core vs Deep distam só ~0,25 z; leia o hipnograma como tendência vigília/sono-profundo, não como estadiamento pleno');
  }
  if (tem('low')) avisos.push('low-frequency presente: é o biomarcador que melhor identifica sono profundo (Deep) no artigo');
  if (tem('ftg')) avisos.push('FTG presente: ajuda vigília/REM, mas REM e vigília têm FTG igualmente alto — a separação REM×vigília continua frágil');
  if (!tem('beta')) avisos.push('sem beta: a detecção de vigília noturna (o estágio mais bem decodificado pelo beta no artigo) fica enfraquecida');
  avisos.push('épocas de 10 min: microdespertares e transições curtas são invisíveis por construção (limite do Timeline)');
  return avisos;
}

/* sleepPipeline(trendByHemi, centerFreqByHemi, offMin, opts) — o orquestrador.

   ENTRADA. trendByHemi: {hemi: [{t, lfp}]} (censura já como NaN);
   centerFreqByHemi: {hemi: Hz} (frequência de sensing por hemisfério, se
   declarada); offMin: fuso em minutos. Opções: {sleepMode:'auto'|'manual',
   bedH, riseH, epochMs, hampelWindow, hampelK, minValidEpochs,
   minNightCoverage, minNights, marginFloor}.

   ETAPAS. (1) Hampel sobre log10(x+1) por hemisfério — a MESMA limpeza do
   TIDAL-DT; (2) janela de sono: automática (detector do TIDAL-DT sobre os
   dados combinados — uma única definição por paciente) ou manual (horários
   habituais, como o artigo configurava o vestível); (3) noites em grade de
   10 min; (4) z-score por intervalo de sono (normalização do artigo);
   (5) tipos iguais em hemisférios diferentes são promediados por época
   (média bilateral declarada); (6) centróide mais próximo por época;
   (7) arquitetura por noite e agregado com mediana e IQR.                   */
export function sleepPipeline(trendByHemi, centerFreqByHemi, offMin, opts) {
  const o = opts || {};
  const ep = isFinite(o.epochMs) && o.epochMs > 0 ? o.epochMs : SLEEP_DEFAULTS.epochMs;
  const minValidEpochs = isFinite(o.minValidEpochs) ? o.minValidEpochs : SLEEP_DEFAULTS.minValidEpochs;
  const minCov = isFinite(o.minNightCoverage) ? o.minNightCoverage : SLEEP_DEFAULTS.minNightCoverage;
  const minNights = isFinite(o.minNights) ? o.minNights : SLEEP_DEFAULTS.minNights;
  const hemis = Object.keys(trendByHemi || {}).filter(h => (trendByHemi[h] || []).length);
  if (!hemis.length) return { ok: false, reason: 'sem Timeline crônico neste conjunto de arquivos' };

  /* (1) limpeza Hampel por hemisfério, sobre log10(x+1) — como no TIDAL-DT */
  const limpos = {};
  const biomarkers = [];
  hemis.forEach(h => {
    const rows = (trendByHemi[h] || []).filter(r => r && isFinite(r.t)).slice().sort((a, b) => a.t - b.t);
    const logx = rows.map(r => isFinite(r.lfp) && r.lfp >= 0 ? Math.log10(r.lfp + 1) : NaN);
    const hf = hampelFilter(logx, { window: o.hampelWindow || SLEEP_DEFAULTS.hampelWindow, k: o.hampelK || SLEEP_DEFAULTS.hampelK });
    limpos[h] = rows.map((r, i) => ({ t: r.t, v: isFinite(hf.x[i]) ? r.lfp : NaN, log: hf.x[i] }));
    const bio = classifyBiomarker((centerFreqByHemi || {})[h]);
    biomarkers.push({ hemisphere: h, type: bio.type, centerHz: bio.centerHz, assumed: bio.assumed, label: bio.label, nRejected: hf.nRejected, nFinite: hf.nFinite });
  });

  /* (2) uma única janela de sono por paciente. A detecção automática NÃO
     mistura tipos: beta e FTG sobem na vigília, mas a baixa frequência sobe
     no sono profundo — somar os dois cancela o ritmo circadiano e derruba o
     cosinor. Usa-se o tipo de maior dinâmica circadiana disponível
     (beta > FTG > low, a ordem do próprio artigo); se só houver low, o sinal
     é INVERTIDO antes do ajuste (o vale dela é a vigília). */
  let wake;
  if (o.sleepMode === 'manual' && isFinite(o.bedH) && isFinite(o.riseH)) {
    wake = { wake: [o.riseH, o.bedH], method: 'user-declared habitual bed/rise times (as the wearable was configured in Averna 2026)', r2: NaN };
  } else {
    const ordem = ['beta', 'ftg', 'low'];
    const tipoRef = ordem.find(t => biomarkers.some(b => b.type === t));
    const inverte = tipoRef === 'low' ? -1 : 1;
    const pool = [];
    biomarkers.forEach(b => {
      if (b.type !== tipoRef) return;
      limpos[b.hemisphere].forEach(r => { if (isFinite(r.log)) pool.push({ t: r.t, x: inverte * r.log }); });
    });
    pool.sort((a, b) => a.t - b.t);
    wake = detectWakeWindow(pool, offMin, {});
    wake.method += ` [circadian anchor: ${tipoRef}${inverte < 0 ? ', inverted' : ''}]`;
  }
  const sleep = sleepWindowOf(wake.wake);

  /* (3) noites na grade de épocas */
  let tMin = Infinity, tMax = -Infinity;
  hemis.forEach(h => limpos[h].forEach(r => { if (r.t < tMin) tMin = r.t; if (r.t > tMax) tMax = r.t; }));
  const ni = nightIntervals(tMin, tMax, offMin, sleep, ep);
  if (!ni.ok) return { ok: false, reason: ni.reason || 'nenhuma noite dentro do registro', wake, sleep };

  /* combo de tipos disponíveis (tipos repetidos = média bilateral) */
  const typesAvailable = Array.from(new Set(biomarkers.map(b => b.type))).sort();
  const combo = typesAvailable.join('+');

  /* (4–6) por noite: épocas → z → média por tipo → estágio */
  const nights = [];
  const excluded = [];
  ni.nights.forEach(nt => {
    const porTipo = {};
    const qualidade = [];
    biomarkers.forEach(b => {
      const es = epochSeries(limpos[b.hemisphere], nt, ep);
      const zi = zscoreInterval(es.values, minValidEpochs);
      qualidade.push({ hemisphere: b.hemisphere, type: b.type, nValid: es.nValid, ok: zi.ok, reason: zi.reason || '' });
      if (!zi.ok) return;
      if (!porTipo[b.type]) porTipo[b.type] = [];
      porTipo[b.type].push(zi.z);
    });
    const zByType = {};
    Object.keys(porTipo).forEach(t => {
      const seriesT = porTipo[t];
      zByType[t] = new Array(nt.nEpochs).fill(NaN);
      for (let e = 0; e < nt.nEpochs; e++) {
        const vs = seriesT.map(z => z[e]).filter(isFinite);
        if (vs.length) zByType[t][e] = mean(vs);
      }
    });
    if (!Object.keys(zByType).length) {
      excluded.push({ night: nt.nightKey, reason: 'nenhum biomarcador com z-score estável nesta noite: ' + qualidade.map(q => `${q.hemisphere}:${q.reason || 'ok'}`).join('; ') });
      return;
    }
    const st = stageEpochs(zByType, { marginFloor: o.marginFloor });
    if (!st.ok) { excluded.push({ night: nt.nightKey, reason: st.reason || 'sem épocas classificáveis' }); return; }
    const cov = st.nClassified / nt.nEpochs;
    const arch = nightArchitecture(st.stages, ep);
    const okNight = cov >= minCov && arch.ok;
    if (!okNight) excluded.push({ night: nt.nightKey, reason: `cobertura de épocas ${(100 * cov).toFixed(0)}% (<${100 * minCov}%)` });
    nights.push({
      nightKey: nt.nightKey, t0: nt.t0, t1: nt.t1, nEpochs: nt.nEpochs,
      zByType: zByType, stages: st.stages, margins: st.margins, lowConfidence: st.lowConfidence,
      nClassified: st.nClassified, nLowConfidence: st.nLowConfidence, coverage: +cov.toFixed(3),
      architecture: arch.ok ? arch : null, ok: okNight, quality: qualidade
    });
  });

  /* (7) agregado sobre as noites OK */
  const okNights = nights.filter(n => n.ok);
  const agg = { ok: okNights.length >= minNights, nNights: nights.length, nNightsOk: okNights.length };
  if (okNights.length) {
    const met = (fn, dec) => {
      const vs = okNights.map(fn).filter(isFinite);
      return vs.length ? {
        median: +median(vs).toFixed(dec), q1: +quantile(vs, .25).toFixed(dec), q3: +quantile(vs, .75).toFixed(dec), n: vs.length
      } : null;
    };
    agg.pct = {
      awake: met(n => n.architecture.pct.awake, 1), rem: met(n => n.architecture.pct.rem, 1),
      core: met(n => n.architecture.pct.core, 1), deep: met(n => n.architecture.pct.deep, 1)
    };
    agg.tstH = met(n => n.architecture.tstH, 2);
    agg.wasoMin = met(n => n.architecture.wasoMin, 0);
    agg.solMin = met(n => n.architecture.solMin, 0);
    agg.nAwakenings = met(n => n.architecture.nAwakenings, 1);
    agg.transitionsPerH = met(n => n.architecture.transitionsPerH, 2);
    agg.lowConfidencePct = +(100 * okNights.reduce((a, n) => a + n.nLowConfidence, 0) /
      Math.max(1, okNights.reduce((a, n) => a + n.nClassified, 0))).toFixed(1);
  }
  if (!agg.ok) agg.reason = okNights.length < minNights
    ? `apenas ${okNights.length} noite(s) utilizável(is) (<${minNights}) — agregado marcado como insuficiente`
    : '';

  return {
    ok: true, nights, aggregate: agg, excluded,
    wake, sleep, biomarkers, combo, typesAvailable,
    caveats: stageCaveats(typesAvailable),
    cohortRef: SLEEP_COHORT_REF,
    centroids: SLEEP_CENTROIDS, centroidSource: SLEEP_CENTROID_SOURCE,
    params: {
      epochMs: ep, sleepMode: o.sleepMode === 'manual' ? 'manual' : 'auto',
      hampelWindow: o.hampelWindow || SLEEP_DEFAULTS.hampelWindow, hampelK: o.hampelK || SLEEP_DEFAULTS.hampelK,
      minValidEpochs, minNightCoverage: minCov, minNights,
      marginFloor: isFinite(o.marginFloor) ? o.marginFloor : SLEEP_DEFAULTS.marginFloor, offMin
    },
    version: SLEEP_VERSION, disclaimer: SLEEP_DISCLAIMER, refs: SLEEP_REFS
  };
}

/* ---- exportação CSV (cabeçalhos em inglês, R-compatível) ---------------- */

export const SLEEP_CSV_COLUMNS = [
  'night_local', 'epoch_index', 'epoch_utc', 'epoch_local_hour',
  'z_beta', 'z_low', 'z_ftg', 'stage', 'margin_z', 'low_confidence',
  'combo', 'sleep_window_local', 'sleep_window_method', 'epoch_min',
  'centroid_source', 'version'
];

export function sleepCsvRows(res) {
  if (!res || !res.ok) return [];
  const rows = [];
  const sw = `${res.sleep[0]}-${res.sleep[1]}`;
  res.nights.forEach(n => {
    for (let e = 0; e < n.nEpochs; e++) {
      const t = n.t0 + e * res.params.epochMs;
      rows.push({
        night_local: n.nightKey, epoch_index: e,
        epoch_utc: new Date(t).toISOString(),
        epoch_local_hour: +localHour(t, res.params.offMin).toFixed(2),
        z_beta: n.zByType.beta && isFinite(n.zByType.beta[e]) ? +n.zByType.beta[e].toFixed(3) : NaN,
        z_low: n.zByType.low && isFinite(n.zByType.low[e]) ? +n.zByType.low[e].toFixed(3) : NaN,
        z_ftg: n.zByType.ftg && isFinite(n.zByType.ftg[e]) ? +n.zByType.ftg[e].toFixed(3) : NaN,
        stage: n.stages[e] || 'unclassified',
        margin_z: isFinite(n.margins[e]) ? +n.margins[e].toFixed(3) : NaN,
        low_confidence: n.lowConfidence[e] ? 1 : 0,
        combo: res.combo, sleep_window_local: sw, sleep_window_method: res.wake.method,
        epoch_min: res.params.epochMs / 60000,
        centroid_source: 'Averna2026_Fig3C_digitized', version: SLEEP_VERSION
      });
    }
  });
  return rows;
}

/* ---- auto-teste determinístico ------------------------------------------ */

/* selfTestSleep(opts) — resposta conhecida: planta um hipnograma sintético
   (ciclos NREM–REM com Deep no início e REM no fim da noite, como Fig. 2E do
   artigo), gera z = centróide + ruído gaussiano (rng determinístico do
   TIDAL), e verifica que o estadiamento recupera as épocas plantadas.
   Critérios: acurácia ≥80% com beta+low e ≥85% com beta+low+ftg; com beta
   sozinho, exige-se apenas que vigília seja separada de sono profundo (≥70%
   nas épocas awake vs deep) — a promessa honesta do modo unimodal.          */
export function selfTestSleep(opts) {
  const o = opts || {};
  const seed = isFinite(o.seed) ? o.seed : 42;
  const noise = isFinite(o.noise) ? o.noise : 0.20;
  const rng = tidalRng(seed);
  const gauss = rng.gauss;
  /* hipnograma de 54 épocas (9 h): 3 ciclos com Deep decrescente e REM crescente */
  const plan = [];
  const push = (st, k) => { for (let i = 0; i < k; i++) plan.push(st); };
  push('awake', 3);
  push('core', 8); push('deep', 7); push('core', 4); push('rem', 2);
  push('core', 7); push('deep', 4); push('core', 4); push('rem', 3);
  push('awake', 2);
  push('core', 6); push('deep', 1); push('rem', 3);
  const n = plan.length;
  const z = { beta: [], low: [], ftg: [] };
  for (let e = 0; e < n; e++) {
    const c = SLEEP_CENTROIDS[plan[e]];
    z.beta.push(c.beta + noise * gauss());
    z.low.push(c.low + noise * gauss());
    z.ftg.push(c.ftg + noise * gauss());
  }
  const acc = tipos => {
    const sub = {};
    tipos.forEach(t => sub[t] = z[t]);
    const st = stageEpochs(sub, {});
    let hit = 0;
    for (let e = 0; e < n; e++) if (st.stages[e] === plan[e]) hit++;
    return { accuracy: hit / n, staged: st };
  };
  const full = acc(['beta', 'low', 'ftg']);
  const dois = acc(['beta', 'low']);
  const soBeta = acc(['beta']);
  /* modo unimodal: só cobramos vigília × sono profundo */
  let awDeepOk = 0, awDeepN = 0;
  for (let e = 0; e < n; e++) {
    if (plan[e] !== 'awake' && plan[e] !== 'deep') continue;
    awDeepN++;
    const previsto = soBeta.staged.stages[e];
    if (plan[e] === 'awake' && (previsto === 'awake' || previsto === 'rem')) awDeepOk++;
    if (plan[e] === 'deep' && (previsto === 'deep' || previsto === 'core')) awDeepOk++;
  }
  const arch = nightArchitecture(full.staged.stages, SLEEP_DEFAULTS.epochMs);
  const pass = full.accuracy >= 0.85 && dois.accuracy >= 0.80 && (awDeepOk / awDeepN) >= 0.70 && arch.ok;
  return {
    pass,
    accuracyFull: +full.accuracy.toFixed(3),
    accuracyBetaLow: +dois.accuracy.toFixed(3),
    accuracyBetaOnly: +soBeta.accuracy.toFixed(3),
    awakeVsDeepBetaOnly: +(awDeepOk / awDeepN).toFixed(3),
    architecture: arch,
    planted: { nEpochs: n, awake: plan.filter(s => s === 'awake').length, rem: plan.filter(s => s === 'rem').length, core: plan.filter(s => s === 'core').length, deep: plan.filter(s => s === 'deep').length },
    params: { seed, noise }
  };
}

export const SLEEP = {
  VERSION: SLEEP_VERSION, REFS: SLEEP_REFS, DISCLAIMER: SLEEP_DISCLAIMER,
  DEFAULTS: SLEEP_DEFAULTS, STAGES: SLEEP_STAGES, STAGE_LABELS: SLEEP_STAGE_LABELS,
  CENTROIDS: SLEEP_CENTROIDS, CENTROID_SOURCE: SLEEP_CENTROID_SOURCE, COHORT_REF: SLEEP_COHORT_REF,
  CSV_COLUMNS: SLEEP_CSV_COLUMNS,
  classifyBiomarker, sleepWindowOf, nightIntervals, epochSeries, zscoreInterval,
  stageEpochs, nightArchitecture, stageCaveats, sleepPipeline, sleepCsvRows,
  selfTest: selfTestSleep
};
