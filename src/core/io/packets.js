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

/* Desenrola TicksInMses. A documentação do Percept indica resolução de 50 ms e
   rollover em 2^16 ticks; como o campo é gravado em milissegundos, o período de
   volta pode ser 2^16 ms ou 2^16 × 50 ms conforme a versão de firmware. Em vez
   de fixar um, testamos os dois e escolhemos o que produz diferenças positivas e
   mais homogêneas — se não houver queda de valor, não há volta a desenrolar.  */
export function unwrapTicks(ticks) {
  if (!ticks || ticks.length < 2) return ticks ? ticks.slice() : [];
  const temVolta = ticks.some((v, i) => i > 0 && v < ticks[i - 1]);
  if (!temVolta) return ticks.slice();
  let melhor = null, melhorEscore = Infinity;
  for (const cap of [65536, 65536 * 50]) {
    const u = unwrapCounter(ticks, cap);
    const d = [];
    for (let i = 1; i < u.length; i++) d.push(u[i] - u[i - 1]);
    if (d.some(x => x <= 0)) continue;
    const m = medianOf(d) || 1;
    const escore = d.reduce((a, x) => a + Math.abs(x - m), 0) / d.length / m;
    if (escore < melhorEscore) { melhorEscore = escore; melhor = u; }
  }
  return melhor || ticks.slice();
}

/* ------------------------------------------- A. detecção de perda de pacote */

/* analyzePackets({data, fs, packetSizes, ticksMs, sequences})
   → { nExpected, nReceived, nMissing, pctMissing, gaps, method, reliable }

   Estratégia, em ordem de preferência:
     1. GlobalSequences  — contador 0–255; salto > 1 = pacote perdido.
     2. TicksInMses      — o intervalo modal é o intervalo nominal por pacote;
                           múltiplos do nominal indicam pacotes perdidos.
     3. nenhum dos dois  — reliable: false; a série NÃO é verificável.
   Cada lacuna traz startIdx (índice de amostra na série recebida), nSamples e
   startMs (tempo desde o início do registro).                               */
export function analyzePackets(opts) {
  opts = opts || {};
  const data = opts.data || null;
  const fs = isFinite(opts.fs) && opts.fs > 0 ? opts.fs : 250;
  const packetSizes = parseIntList(opts.packetSizes);
  const ticksMs = parseIntList(opts.ticksMs);
  const sequences = parseIntList(opts.sequences);

  const nReceived = data ? data.length
    : (packetSizes ? packetSizes.reduce((a, b) => a + b, 0) : 0);
  /* tamanho típico de pacote: 63 amostras a 250 Hz é o caso comum */
  const modalSize = packetSizes && packetSizes.length ? modeOf(packetSizes)
    : Math.max(1, Math.round(fs / 4));
  const sizeAt = i => (packetSizes && isFinite(packetSizes[i])) ? packetSizes[i] : modalSize;

  const gaps = [];
  let method = 'none', reliable = false, nominalMs = NaN;

  if (sequences && sequences.length > 1) {
    method = 'sequences'; reliable = true;
    const seq = unwrapCounter(sequences, 256);
    let idx = 0;
    for (let i = 1; i < seq.length; i++) {
      idx += sizeAt(i - 1);
      const nPk = seq[i] - seq[i - 1] - 1;
      if (nPk >= 1) gaps.push({
        startIdx: idx, nPackets: nPk, nSamples: nPk * modalSize,
        startMs: ticksMs && isFinite(ticksMs[i - 1]) ? ticksMs[i - 1] : idx / fs * 1000
      });
    }
  } else if (ticksMs && ticksMs.length > 1) {
    method = 'ticks'; reliable = true;
    const tk = unwrapTicks(ticksMs);
    const diffs = [];
    for (let i = 1; i < tk.length; i++) diffs.push(tk[i] - tk[i - 1]);
    /* intervalo nominal por pacote: o modal das diferenças arredondadas */
    nominalMs = modeOf(diffs.map(d => Math.round(d))) || medianOf(diffs);
    let idx = 0;
    for (let i = 1; i < tk.length; i++) {
      idx += sizeAt(i - 1);
      const nPk = nominalMs > 0 ? Math.round(diffs[i - 1] / nominalMs) - 1 : 0;
      if (nPk >= 1) gaps.push({
        startIdx: idx, nPackets: nPk, nSamples: nPk * modalSize, startMs: tk[i - 1]
      });
    }
  }

  const nMissing = gaps.reduce((a, g) => a + g.nSamples, 0);
  const nExpected = nReceived + nMissing;
  return {
    nExpected, nReceived, nMissing,
    pctMissing: nExpected ? 100 * nMissing / nExpected : 0,
    gaps, method, reliable, modalPacketSize: modalSize, nominalPacketMs: nominalMs,
    reason: reliable ? null
      : 'sem GlobalSequences nem TicksInMses — perda de pacotes não verificável neste registro'
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
