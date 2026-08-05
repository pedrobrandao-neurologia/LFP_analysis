/* io/packets.js — integridade do sinal bruto: perda de pacotes, lacunas em NaN,
   frequência de amostragem efetiva e costura de streams consecutivos.

   POR QUE ISTO EXISTE. Interrupções de Bluetooth criam descontinuidades
   silenciosas no JSON do Percept. Concatenar as amostras por cima da lacuna
   produz uma série que parece contínua e não é — e todo resultado a jusante
   (espectro, burst, análise alinhada a evento) fica errado sem aviso. Todos os
   grupos publicados tratam isso da mesma forma: inserir NaN, NUNCA interpolar
   nem concatenar.

   Referências de método: Thenaisie et al., J Neural Eng 2021;18:042002;
   Vivien et al., npj Parkinsons Dis 2026;12:151 (fs efetiva entre 249,985 e
   250,024 Hz, média 249,997 ± 0,008 → deriva de até ~65 ms em ~11 min);
   Swinnen et al., J Neural Eng 2025;22:014001.
   Implementações de referência (conceituais): perceive
   (perceive_check_and_correct_lfp_missingData_in_json.m), PerceptToolbox
   (correct4MissingSamples.m), BRAVO (checkMissingPackage), DBSsync
   (check_and_correct_missing_packets, compute_eff_sf).

   Esta camada é `io` e por contrato não importa `dsp` nem `stats` — as poucas
   utilidades numéricas de que precisa estão definidas aqui mesmo.           */

/* ------------------------------------------------------------- utilidades */

/* "63,63,63" → [63,63,63]. Aceita array já pronto. Entrada ausente → null. */
export function parseIntList(v) {
  if (v == null) return null;
  if (Array.isArray(v)) {
    const a = v.map(Number).filter(x => isFinite(x));
    return a.length ? a : null;
  }
  const a = String(v).split(/[,;\s]+/).map(s => parseFloat(s)).filter(x => isFinite(x));
  return a.length ? a : null;
}

function medianOf(a) {
  const s = a.filter(x => isFinite(x)).slice().sort((x, y) => x - y);
  if (!s.length) return NaN;
  const h = (s.length - 1) / 2, lo = Math.floor(h), hi = Math.ceil(h);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}
/* valor modal (mais frequente) — usado para o intervalo nominal por pacote */
function modeOf(a) {
  const c = new Map();
  a.forEach(v => c.set(v, (c.get(v) || 0) + 1));
  let best = NaN, n = -1;
  c.forEach((k, v) => { if (k > n) { n = k; best = v; } });
  return best;
}

/* Desenrola um contador cíclico (wraparound). GlobalSequences vai de 0 a 255,
   portanto cap = 256. Uma queda de valor indica que o contador deu a volta.
   Perdas grandes que ultrapassam a volta continuam corretas: 250 → 4 com
   cap 256 vira 260, isto é, um salto de 10 (9 pacotes perdidos).            */
export function unwrapCounter(values, cap) {
  const out = new Array(values.length);
  let offset = 0;
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[i - 1]) offset += cap;
    out[i] = values[i] + offset;
  }
  return out;
}

/* Período de volta de TicksInMses, DOCUMENTADO pelo fabricante.

   "TicksInMs normally roll over every 2^16 ticks, or once every 54.61 minutes
    (65535 ticks * 50 ms per tick = 3,276,750 ms). However, during streaming,
    TicksInMs will NOT roll over and will continue increasing until streaming is
    stopped."  — Medtronic UC202012929cEN FY24, p. 24.

   O campo é gravado em MILISSEGUNDOS e a volta é a cada 2^16 TICKS de 50 ms:
   o período é 65 536 × 50 ms. A heurística anterior testava também 65 536 ms —
   valor que o documento não sustenta — e podia escolher o errado num registro
   curto.                                                                     */
export const TICKS_ROLLOVER_MS = 65536 * 50;

/* Desenrola TicksInMses.

   AUSÊNCIA DE VOLTA É O CASO ESPERADO EM STREAMING, não um dado suspeito: o
   documento diz que durante o streaming o contador não volta. Por isso a função
   devolve a série intacta sem heurística nenhuma quando não há queda de valor.

   A heurística de escolher o cap por homogeneidade fica como RECUO, e só é
   usada quando o cap documentado deixa alguma diferença não positiva — isto é,
   quando o arquivo não se comporta como documentado. Nesses casos a saída
   carrega `capUsed` e `fallback: true` para que o desvio não passe em silêncio. */
export function unwrapTicks(ticks) {
  if (!ticks || ticks.length < 2) return ticks ? ticks.slice() : [];
  const temVolta = ticks.some((v, i) => i > 0 && v < ticks[i - 1]);
  if (!temVolta) {
    const out = ticks.slice();
    out.capUsed = null; out.fallback = false;
    out.note = 'sem volta de contador — o caso esperado durante o BrainSense Streaming (UC202012929cEN, p. 24)';
    return out;
  }
  /* Positividade sozinha é um teste fraco demais: desenrolar com um cap grande
     demais também produz diferenças positivas — só que introduz um salto
     gigante onde havia uma volta. O escore mede a HOMOGENEIDADE das diferenças,
     que é o que distingue "desenrolou" de "somou um número grande". */
  const avalia = cap => {
    const u = unwrapCounter(ticks, cap);
    const d = [];
    for (let i = 1; i < u.length; i++) d.push(u[i] - u[i - 1]);
    if (d.some(x => x <= 0)) return null;
    const m = medianOf(d) || 1;
    return { u, cap, escore: d.reduce((a, x) => a + Math.abs(x - m), 0) / d.length / Math.abs(m) };
  };
  const doc = avalia(TICKS_ROLLOVER_MS);
  const alt = avalia(65536);

  /* O cap documentado é o padrão e só é abandonado quando o arquivo o contradiz
     de forma clara — a alternativa precisa ser ao menos 10× mais homogênea. Um
     empate, ou uma vantagem pequena, mantém o documentado. */
  const contradiz = doc && alt && alt.escore * 10 < doc.escore;
  const escolhido = (doc && !contradiz) ? doc : (alt || doc);
  if (!escolhido) {
    const out = ticks.slice();
    out.capUsed = null; out.fallback = true;
    out.note = 'nenhum período de volta produziu diferenças positivas — os ticks deste arquivo não são desenroláveis';
    return out;
  }
  const out = escolhido.u;
  out.capUsed = escolhido.cap;
  out.fallback = escolhido.cap !== TICKS_ROLLOVER_MS;
  out.note = out.fallback
    ? `o período documentado (65 536 × 50 ms) deixaria as diferenças ${doc ? (doc.escore / escolhido.escore).toFixed(0) + '× mais dispersas' : 'não positivas'} ` +
      'neste arquivo; foi usado o recuo heurístico com cap 65 536 ms — comportamento fora do documentado, e por isso declarado'
    : 'volta desenrolada com o período documentado de 65 536 × 50 ms (UC202012929cEN, p. 24)';
  return out;
}

/* ------------------------------------------- A. detecção de perda de pacote */

/* Cap de volta de GlobalSequences, POR MODELO de neuroestimulador.

   "Global Sequences ... Rolls over at 255 for Percept PC or 65,535 for
    Percept RC."  — Medtronic UC202012929cEN FY24, p. 21–24.

   O cap fixo em 256 é correto no Percept PC (B35200) e ERRADO no RC (B35300):
   num RC o contador chega a 65 535, e desenrolar com cap 256 inventa voltas onde
   não há — transformando a contagem de perda em ficção.

   Quando o modelo não é identificável, este módulo NÃO ESCOLHE. Devolve null, e
   quem chama cai para os ticks, declarando o motivo. Chutar o cap seria pior do
   que não usar as sequências.                                                */
export function sequenceCapForModel(model) {
  const m = String(model || '').toUpperCase();
  if (/B35200/.test(m) || /PERCEPT\s*PC/.test(m)) return { cap: 256, model: 'Percept PC (B35200)', source: 'UC202012929cEN FY24, p. 21–24' };
  if (/B35300/.test(m) || /PERCEPT\s*RC/.test(m)) return { cap: 65536, model: 'Percept RC (B35300)', source: 'UC202012929cEN FY24, p. 21–24' };
  return { cap: null, model: m || '(não declarado)', source: null };
}

/* Fluxos em que as sequências são INTERCALADAS entre dois streams e por isso
   NÃO podem ser lidas como contador contínuo de um deles.

   "Global Sequences ... Packets are interleaved with BrainSenseLfp packets."
     — UC202012929cEN FY24, p. 23 (BrainSenseTimeDomain)
   "Seq ... Packets are interleaved with BrainSenseTimeDomain GlobalSequences."
     — UC202012929cEN FY24, p. 24 (BrainSenseLfp)

   Durante o BrainSense Streaming os dois fluxos COMPARTILHAM a numeração. Um
   salto de 1 na sequência do domínio do tempo é o comportamento normal: o número
   que falta pertence a um pacote de potência. Contar esses saltos como perda
   reportava perda maciça e falsa em todo registro de streaming, e a lacuna
   inventada era então inserida como NaN — degradando Welch, espectrograma, ODR,
   bursts e o selo de qualidade, tudo para baixo e de forma convincente.       */
export const INTERLEAVED_STREAMS = ['BrainSenseTimeDomain', 'BrainSenseLfp'];

/* analyzePackets({data, fs, packetSizes, ticksMs, sequences, stream, deviceModel})
   → { nExpected, nReceived, nMissing, pctMissing, gaps, method, reliable }

   Estratégia, em ordem de preferência:
     1. TicksInMses      — SEMPRE preferido em BrainSenseTimeDomain e
                           BrainSenseLfp, porque ali as sequências são
                           intercaladas entre os dois fluxos (p. 23–24).
     2. GlobalSequences  — nos demais fluxos (Survey, Signal Test, Calibration,
                           Indefinite Streaming), com o cap do modelo (p. 21–24).
     3. nenhum dos dois  — reliable: false; a série NÃO é verificável.

   O critério de descontinuidade nos ticks é o do PSEUDOCÓDIGO DO FABRICANTE
   (p. 28):

       IF Difference in TicksInMses > (1 + GlobalPacketSizes)/SampleRateInHz

   NOTE A INCONSISTÊNCIA DE UNIDADE DO ORIGINAL: o lado esquerdo está em
   milissegundos e o direito em segundos. A comparação aqui converte o lado
   direito para ms (× 1000), que é a única leitura que faz o critério ter
   sentido dimensional. O critério anterior deste módulo era RELATIVO (múltiplo
   do intervalo modal); o do fabricante é ABSOLUTO (tamanho do pacote + 1
   amostra), e diverge do relativo em registro com tamanho de pacote variável.
   O critério usado sai em `gapCriterion`.

   Cada lacuna traz startIdx (índice de amostra na série recebida), nSamples e
   startMs (tempo desde o início do registro).                               */
export function analyzePackets(opts) {
  opts = opts || {};
  const data = opts.data || null;
  const fs = isFinite(opts.fs) && opts.fs > 0 ? opts.fs : 250;
  const packetSizes = parseIntList(opts.packetSizes);
  const ticksMs = parseIntList(opts.ticksMs);
  const sequences = parseIntList(opts.sequences);
  const stream = opts.stream || '';
  const intercalado = INTERLEAVED_STREAMS.indexOf(stream) >= 0;
  const capInfo = sequenceCapForModel(opts.deviceModel);

  const nReceived = data ? data.length
    : (packetSizes ? packetSizes.reduce((a, b) => a + b, 0) : 0);
  /* tamanho típico de pacote: 63 amostras a 250 Hz é o caso comum */
  const modalSize = packetSizes && packetSizes.length ? modeOf(packetSizes)
    : Math.max(1, Math.round(fs / 4));
  const sizeAt = i => (packetSizes && isFinite(packetSizes[i])) ? packetSizes[i] : modalSize;

  const gaps = [];
  let method = 'none', reliable = false, nominalMs = NaN, criterio = null, notaTicks = null;
  const porQueNaoSequencias = [];

  const temTicks = ticksMs && ticksMs.length > 1;
  const temSeq = sequences && sequences.length > 1;

  if (temSeq && intercalado) porQueNaoSequencias.push(
    `em ${stream} as sequências são intercaladas com o outro fluxo do streaming (UC202012929cEN, p. 23–24): ` +
    'um salto de 1 é o comportamento normal e contá-lo como perda produziria perda falsa');
  if (temSeq && !intercalado && capInfo.cap == null) porQueNaoSequencias.push(
    `o modelo do neuroestimulador não foi identificado (${capInfo.model}), e o cap de volta das sequências depende ` +
    'dele — 255 no Percept PC, 65 535 no RC (UC202012929cEN, p. 21–24). Escolher um cap às cegas inventaria voltas');

  const usaSequencias = temSeq && !intercalado && capInfo.cap != null;

  if (usaSequencias) {
    method = 'sequences'; reliable = true;
    criterio = `salto > 1 na sequência desenrolada com cap ${capInfo.cap} (${capInfo.model})`;
    const seq = unwrapCounter(sequences, capInfo.cap);
    let idx = 0;
    for (let i = 1; i < seq.length; i++) {
      idx += sizeAt(i - 1);
      const nPk = seq[i] - seq[i - 1] - 1;
      if (nPk >= 1) gaps.push({
        startIdx: idx, nPackets: nPk, nSamples: nPk * modalSize,
        startMs: ticksMs && isFinite(ticksMs[i - 1]) ? ticksMs[i - 1] : idx / fs * 1000
      });
    }
  } else if (temTicks) {
    method = 'ticks'; reliable = true;
    const tk = unwrapTicks(ticksMs);
    notaTicks = tk.note || null;
    const diffs = [];
    for (let i = 1; i < tk.length; i++) diffs.push(tk[i] - tk[i - 1]);
    nominalMs = modeOf(diffs.map(d => Math.round(d))) || medianOf(diffs);
    /* Critério do fabricante (p. 28), com o lado direito convertido para ms:
       há descontinuidade quando Δticks ultrapassa o tempo de (1 + tamanho do
       pacote) amostras. O número de pacotes perdidos vem do excedente. */
    criterio = 'critério do fabricante (UC202012929cEN, p. 28): descontinuidade quando Δticks > ' +
      '(1 + GlobalPacketSizes)/SampleRateInHz, com o lado direito convertido de s para ms';
    let idx = 0;
    for (let i = 1; i < tk.length; i++) {
      idx += sizeAt(i - 1);
      const limiteMs = 1000 * (1 + sizeAt(i - 1)) / fs;
      const d = diffs[i - 1];
      if (!(d > limiteMs)) continue;
      /* quantos pacotes cabem no excedente, na cadência nominal */
      const passo = nominalMs > 0 ? nominalMs : 1000 * sizeAt(i - 1) / fs;
      const nPk = Math.max(1, Math.round(d / passo) - 1);
      gaps.push({ startIdx: idx, nPackets: nPk, nSamples: nPk * modalSize, startMs: tk[i - 1] });
    }
  }

  const nMissing = gaps.reduce((a, g) => a + g.nSamples, 0);
  const nExpected = nReceived + nMissing;
  return {
    nExpected, nReceived, nMissing,
    pctMissing: nExpected ? 100 * nMissing / nExpected : 0,
    gaps, method, reliable, modalPacketSize: modalSize, nominalPacketMs: nominalMs,
    stream: stream || null,
    interleavedSequences: intercalado,
    sequenceCap: usaSequencias ? capInfo.cap : null,
    deviceModel: capInfo.model,
    gapCriterion: criterio,
    ticksNote: notaTicks,
    sequencesAvailableButUnused: temSeq && !usaSequencias,
    whySequencesUnused: porQueNaoSequencias.length ? porQueNaoSequencias.join(' · ') : null,
    reason: reliable ? null
      : (temSeq
        ? 'as sequências existem mas não são utilizáveis neste fluxo, e não há TicksInMses para o método alternativo — ' +
          'perda de pacotes não verificável neste registro'
        : 'sem GlobalSequences nem TicksInMses — perda de pacotes não verificável neste registro')
  };
}

/* ------------------------------------------------ B. lacunas como NaN ---- */

/* insertNaNGaps(series, gaps) → { data, missingMask }
   Reconstrói a série com NaN nas posições dos pacotes perdidos. O comprimento
   de saída é exatamente nExpected. NUNCA interpola e NUNCA concatena por cima
   da lacuna: a ausência é preservada como ausência.                         */
export function insertNaNGaps(series, gaps) {
  const lista = (gaps || []).slice().sort((a, b) => a.startIdx - b.startIdx);
  const extra = lista.reduce((a, g) => a + g.nSamples, 0);
  const total = series.length + extra;
  const out = new Float64Array(total);
  const mask = new Uint8Array(total);
  let si = 0, oi = 0, gi = 0;
  const despejar = () => {
    while (gi < lista.length && lista[gi].startIdx <= si) {
      for (let k = 0; k < lista[gi].nSamples; k++) { out[oi] = NaN; mask[oi] = 1; oi++; }
      gi++;
    }
  };
  while (si < series.length) { despejar(); out[oi++] = series[si++]; }
  despejar();
  return { data: out, missingMask: mask };
}

/* ------------------------------------- C. frequência de amostragem efetiva */

/* effectiveFs({ticksMs, nSamples, nominalFs, packetSizes})
   → { fsEff, fsNominal, ppmDeviation, driftMsPerMinute, driftMsTotal, ... }

   Os ticks marcam o INÍCIO de cada pacote. Entre o primeiro e o último tick
   decorrem, portanto, todas as amostras menos as do último pacote — usar
   nSamples-1 só é correto quando não há informação de tamanho de pacote.
   Unidades: ticks em ms, fs em Hz, deriva em ms.                            */
export function effectiveFs(opts) {
  opts = opts || {};
  const fsNominal = isFinite(opts.nominalFs) && opts.nominalFs > 0 ? opts.nominalFs : 250;
  const ticksMs = parseIntList(opts.ticksMs);
  const packetSizes = parseIntList(opts.packetSizes);
  const nSamples = opts.nSamples;
  const vazio = motivo => ({
    fsEff: NaN, fsNominal, ppmDeviation: NaN, driftMsPerMinute: NaN, driftMsTotal: NaN,
    spanMs: NaN, reliable: false, warnDrift: false, reason: motivo
  });
  if (!ticksMs || ticksMs.length < 2) return vazio('sem TicksInMses — fs efetiva não verificável');
  if (!isFinite(nSamples) || nSamples < 2) return vazio('amostras insuficientes');
  const tk = unwrapTicks(ticksMs);
  const spanMs = tk[tk.length - 1] - tk[0];
  if (!(spanMs > 0)) return vazio('intervalo de ticks não positivo');

  const nSpan = (packetSizes && packetSizes.length === ticksMs.length)
    ? nSamples - packetSizes[packetSizes.length - 1]
    : nSamples - 1;
  const fsEff = nSpan / (spanMs / 1000);
  if (!(fsEff > 0)) return vazio('fs efetiva não positiva');

  const durationS = nSamples / fsEff;
  /* deriva acumulada: diferença entre o tempo suposto pela fs nominal e o real */
  const driftMsTotal = nSamples * 1000 * (1 / fsNominal - 1 / fsEff);
  return {
    fsEff, fsNominal,
    ppmDeviation: (fsEff - fsNominal) / fsNominal * 1e6,
    driftMsTotal,
    driftMsPerMinute: durationS > 0 ? driftMsTotal / (durationS / 60) : NaN,
    spanMs, nSpan, durationS, reliable: true,
    warnDrift: Math.abs(driftMsTotal) > 20,
    reason: Math.abs(driftMsTotal) > 20
      ? `deriva de ${driftMsTotal.toFixed(1)} ms no registro — relevante para análise alinhada a evento`
      : null
  };
}

/* ------------------------------------- D. costura de streams consecutivos - */

/* stitchStreams(streams, {maxGapS}) — concatena registros consecutivos do mesmo
   canal inserindo NaN no intervalo entre eles.

   stitchReliable é SEMPRE false, deliberadamente: a equipe do perceive
   documenta que a concatenação confiável de dois streams pela contagem de ticks
   não está resolvida. A UI deve exibir isso como aviso, não como resultado.  */
export function stitchStreams(streams, opts) {
  opts = opts || {};
  const maxGapS = isFinite(opts.maxGapS) ? opts.maxGapS : 600;
  const lista = (streams || []).filter(s => s && s.data && s.data.length)
    .slice().sort((a, b) => (a.t0Ms || 0) - (b.t0Ms || 0));
  if (!lista.length) return null;
  const fs = lista[0].fs || 250;
  const partes = [], mascaras = [], segments = [];
  let cursor = 0, nGapSamples = 0;
  lista.forEach((s, i) => {
    if (i > 0) {
      const anterior = lista[i - 1];
      const fimAnteriorMs = (anterior.t0Ms || 0) + anterior.data.length / (anterior.fs || fs) * 1000;
      const gapMs = (s.t0Ms || 0) - fimAnteriorMs;
      if (gapMs > 0 && gapMs / 1000 <= maxGapS) {
        const n = Math.round(gapMs / 1000 * fs);
        if (n > 0) {
          partes.push(new Float64Array(n).fill(NaN));
          mascaras.push(new Uint8Array(n).fill(1));
          cursor += n; nGapSamples += n;
        }
      }
    }
    partes.push(s.data);
    mascaras.push(s.missingMask || new Uint8Array(s.data.length));
    segments.push({ index: i, startIdx: cursor, nSamples: s.data.length, t0Ms: s.t0Ms || null });
    cursor += s.data.length;
  });
  const total = partes.reduce((a, p) => a + p.length, 0);
  const data = new Float64Array(total), missingMask = new Uint8Array(total);
  let o = 0;
  partes.forEach((p, k) => {
    for (let i = 0; i < p.length; i++) { data[o] = p[i]; missingMask[o] = mascaras[k][i] || 0; o++; }
  });
  return {
    data, missingMask, fs, segments, nSegments: lista.length, nGapSamples,
    stitchReliable: false,
    reason: 'concatenação por contagem de ticks não é confiável (documentado como não resolvido no perceive) — trate como aviso, não como resultado'
  };
}
