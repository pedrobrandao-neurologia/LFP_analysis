/* io/external.js — importação de sinal externo (IMU, EMG, ECG, acelerômetro).

   POR QUE ISTO IMPORTA. Várias perguntas de LFP só se respondem com um segundo
   sinal. Tremor: a oscilação do STN é do cérebro ou é o próprio tremor entrando
   pelo eletrodo? Distonia cervical: o pico teta-alfa do GPi é biomarcador ou é
   o tremor cefálico de 1–6 Hz batendo em cima dele? Artefato cardíaco: o QRS
   está mesmo ali? Sem um canal externo, essas perguntas não têm resposta — e
   este software prefere dizer isso a inventar uma.

   O QUE ESTE MÓDULO FAZ. Lê um CSV/TSV de qualquer origem (Delsys, APDM/Opal,
   planilha, gravador genérico), descobre o delimitador, o cabeçalho, a coluna
   de tempo e os canais numéricos, e devolve as séries com a frequência de
   amostragem INFERIDA e a irregularidade dessa inferência declarada.

   O QUE ELE NÃO FAZ. Não interpola. Lacuna de amostragem vira NaN e é
   contabilizada; linha malformada é descartada com contagem. Não adivinha
   unidade: se o cabeçalho não disser, a unidade sai como desconhecida e as
   figuras dizem "u.a.".

   Referência de arquitetura: DBSsync (Vivien) — sincronização de sinais
   externos ao Percept por artefato de estimulação.                          */

import { median, quantile } from '../stats/descriptive.js';

export const DELIMS = [',', ';', '\t', '|'];

/* Escolhe o delimitador pelo que produz mais colunas de forma CONSISTENTE nas
   primeiras linhas — contar só na primeira linha erra em arquivo com texto. */
export function detectaDelimitador(linhas) {
  let melhor = ',', melhorNota = -1;
  DELIMS.forEach(d => {
    const contas = linhas.slice(0, 12).map(l => l.split(d).length);
    if (!contas.length) return;
    const m = median(contas);
    if (m < 2) return;
    const consistentes = contas.filter(c => c === m).length / contas.length;
    const nota = m * consistentes;
    if (nota > melhorNota) { melhorNota = nota; melhor = d; }
  });
  return melhor;
}

export const numero = s => {
  if (s == null) return NaN;
  const t = String(s).trim().replace(/^"|"$/g, '');
  if (!t) return NaN;
  /* aceita vírgula decimal, comum em exportação brasileira e europeia */
  const v = Number(t.indexOf(',') >= 0 && t.indexOf('.') < 0 ? t.replace(',', '.') : t);
  return isFinite(v) ? v : NaN;
};

/* Interpreta a coluna de tempo. Devolve tempos em MILISSEGUNDOS e diz como
   chegou lá — se a interpretação estiver errada, o alinhamento inteiro está, e
   isso não pode ficar implícito. */
function interpretaTempo(valores) {
  const brutos = valores.map(v => String(v == null ? '' : v).trim().replace(/^"|"$/g, ''));
  /* 1. timestamp ISO */
  const iso = brutos.slice(0, 5).every(s => s && !isFinite(Number(s)) && isFinite(Date.parse(s)));
  if (iso) return {
    ms: brutos.map(s => Date.parse(s)),
    interpretation: 'timestamp ISO 8601 absoluto', absolute: true
  };
  const nums = brutos.map(numero);
  const validos = nums.filter(isFinite);
  if (validos.length < 4) return null;
  const dif = [];
  for (let i = 1; i < nums.length; i++) if (isFinite(nums[i]) && isFinite(nums[i - 1])) dif.push(nums[i] - nums[i - 1]);
  const dt = median(dif.filter(v => v > 0));
  const primeiro = validos[0];
  /* 2. epoch em milissegundos (ordem de 1e12 a partir de 2001) */
  if (primeiro > 1e11) return { ms: nums, interpretation: 'epoch Unix em milissegundos', absolute: true };
  /* 3. epoch em segundos */
  if (primeiro > 1e8) return { ms: nums.map(v => v * 1000), interpretation: 'epoch Unix em segundos', absolute: true };
  /* 4. tempo relativo: segundos ou milissegundos, decidido pelo passo típico */
  if (dt >= 1) return {
    ms: nums.map(v => v - validos[0]),
    interpretation: `tempo relativo em milissegundos (passo típico ${dt.toFixed(2)} ms)`, absolute: false
  };
  return {
    ms: nums.map(v => (v - validos[0]) * 1000),
    interpretation: `tempo relativo em segundos (passo típico ${dt.toFixed(5)} s)`, absolute: false
  };
}

/* parseExternalCsv(texto, opts) → { channels, tMs, fs, ... } */
export function parseExternalCsv(texto, opts) {
  opts = opts || {};
  const linhas = String(texto || '').split(/\r?\n/).filter(l => l.trim().length);
  if (linhas.length < 4) return { ok: false, reason: 'arquivo com menos de 4 linhas úteis' };
  const delim = opts.delimiter || detectaDelimitador(linhas);
  const celulas = linhas.map(l => l.split(delim).map(c => c.trim().replace(/^"|"$/g, '')));

  /* cabeçalho: primeira linha em que a maioria das células NÃO é número */
  let iCab = -1;
  for (let i = 0; i < Math.min(5, celulas.length); i++) {
    const naoNum = celulas[i].filter(c => c && !isFinite(numero(c))).length;
    if (naoNum >= Math.ceil(celulas[i].length / 2)) { iCab = i; break; }
  }
  const cabecalho = iCab >= 0 ? celulas[iCab] : celulas[0].map((_, i) => 'col' + (i + 1));
  const corpo = celulas.slice(iCab >= 0 ? iCab + 1 : 0);
  const nCols = median(corpo.slice(0, 50).map(r => r.length));
  const linhasDescartadas = corpo.filter(r => r.length !== nCols).length;
  const dados = corpo.filter(r => r.length === nCols);
  if (dados.length < 4) return { ok: false, reason: 'nenhuma linha de dados consistente com o cabeçalho' };

  /* coluna de tempo: a indicada pelo usuário, ou a primeira cujo nome sugere
     tempo, ou a primeira monotônica crescente */
  let iTempo = isFinite(opts.timeColumn) ? opts.timeColumn : -1;
  if (iTempo < 0) iTempo = cabecalho.findIndex(c => /^(time|tempo|timestamp|t|datetime|date|sec|seconds|ms)\b/i.test(c || ''));
  if (iTempo < 0) {
    for (let c = 0; c < nCols; c++) {
      const col = dados.slice(0, 200).map(r => numero(r[c]));
      let cresce = 0;
      for (let i = 1; i < col.length; i++) if (col[i] > col[i - 1]) cresce++;
      if (cresce > 0.95 * (col.length - 1)) { iTempo = c; break; }
    }
  }
  if (iTempo < 0) iTempo = 0;

  const tempo = interpretaTempo(dados.map(r => r[iTempo]));
  if (!tempo) return { ok: false, reason: 'não foi possível interpretar a coluna de tempo' };

  /* canais: todas as demais colunas majoritariamente numéricas */
  const canais = [];
  for (let c = 0; c < nCols; c++) {
    if (c === iTempo) continue;
    const col = dados.map(r => numero(r[c]));
    const validos = col.filter(isFinite).length;
    if (validos < 0.5 * col.length) continue;
    const nome = (cabecalho[c] || ('col' + (c + 1))).trim();
    const unidade = (nome.match(/\(([^)]+)\)|\[([^\]]+)\]/) || [])[1] || (nome.match(/\[([^\]]+)\]/) || [])[1] || null;
    canais.push({
      name: nome, unit: unidade,
      kind: /acc|aceler|imu|gyro|giro/i.test(nome) ? 'imu'
        : /emg|musc/i.test(nome) ? 'emg'
          : /ecg|ekg|card/i.test(nome) ? 'ecg' : 'desconhecido',
      data: Float64Array.from(col),
      nValid: validos, nNaN: col.length - validos
    });
  }
  if (!canais.length) return { ok: false, reason: 'nenhuma coluna numérica além do tempo' };

  /* fs efetiva e a irregularidade dela — um jitter alto invalida qualquer
     análise espectral do sinal externo, e precisa aparecer */
  const dif = [];
  for (let i = 1; i < tempo.ms.length; i++) {
    const d = tempo.ms[i] - tempo.ms[i - 1];
    if (isFinite(d) && d > 0) dif.push(d);
  }
  const dtMed = median(dif);
  const fs = dtMed > 0 ? 1000 / dtMed : NaN;
  const q1 = quantile(dif, 0.25), q3 = quantile(dif, 0.75);
  const jitterPct = dtMed > 0 ? 100 * (q3 - q1) / dtMed : NaN;
  /* lacunas: intervalos maiores que 3× o passo típico */
  const lacunas = [];
  for (let i = 1; i < tempo.ms.length; i++) {
    const d = tempo.ms[i] - tempo.ms[i - 1];
    if (isFinite(d) && d > 3 * dtMed) lacunas.push({ atMs: tempo.ms[i - 1], gapMs: +d.toFixed(2) });
  }

  const avisos = [];
  if (linhasDescartadas) avisos.push(`${linhasDescartadas} linha(s) descartada(s) por número de colunas diferente do cabeçalho`);
  if (isFinite(jitterPct) && jitterPct > 5) avisos.push(
    `a amostragem é irregular (IQR do intervalo = ${jitterPct.toFixed(1)}% do passo típico) — ` +
    'análise espectral deste sinal fica frágil; considere reamostrar antes de comparar bandas');
  if (lacunas.length) avisos.push(`${lacunas.length} lacuna(s) de amostragem detectada(s); nada foi interpolado`);
  if (!tempo.absolute) avisos.push(
    'a coluna de tempo é RELATIVA — o alinhamento com o LFP não pode ser feito por timestamp e ' +
    'precisa de correlação cruzada ou de deslocamento informado à mão');

  return {
    ok: true,
    delimiter: delim === '\t' ? 'tabulação' : delim,
    headerRow: iCab, timeColumn: iTempo, timeColumnName: cabecalho[iTempo] || null,
    timeInterpretation: tempo.interpretation, absoluteTime: tempo.absolute,
    tMs: tempo.ms,
    channels: canais,
    nSamples: dados.length, nRowsDropped: linhasDescartadas,
    fs: isFinite(fs) ? +fs.toFixed(4) : NaN,
    sampleIntervalMs: isFinite(dtMed) ? +dtMed.toFixed(4) : NaN,
    jitterPct: isFinite(jitterPct) ? +jitterPct.toFixed(2) : NaN,
    gaps: lacunas, durationSec: +((tempo.ms[tempo.ms.length - 1] - tempo.ms[0]) / 1000).toFixed(3),
    warnings: avisos
  };
}

/* Reamostra para uma grade regular por interpolação linear ENTRE amostras
   vizinhas, e devolve NaN dentro das lacunas — reamostrar não é o mesmo que
   preencher buraco, e a diferença é preservada. */
export function resampleUniform(tMs, y, fsAlvo, opts) {
  opts = opts || {};
  const maxGapMs = isFinite(opts.maxGapMs) ? opts.maxGapMs : 3 * 1000 / fsAlvo;
  const validos = [];
  for (let i = 0; i < tMs.length; i++) if (isFinite(tMs[i]) && isFinite(y[i])) validos.push(i);
  if (validos.length < 4) return null;
  const t0 = tMs[validos[0]], t1 = tMs[validos[validos.length - 1]];
  const n = Math.floor((t1 - t0) * fsAlvo / 1000) + 1;
  if (!(n > 1)) return null;
  const out = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * 1000 / fsAlvo;
    while (k + 1 < validos.length && tMs[validos[k + 1]] < t) k++;
    const a = validos[k], b = validos[Math.min(k + 1, validos.length - 1)];
    const ta = tMs[a], tb = tMs[b];
    if (tb - ta > maxGapMs) { out[i] = NaN; continue; }
    out[i] = tb === ta ? y[a] : y[a] + (y[b] - y[a]) * (t - ta) / (tb - ta);
  }
  let nNaN = 0; for (let i = 0; i < n; i++) if (!isFinite(out[i])) nNaN++;
  return {
    data: out, fs: fsAlvo, t0Ms: t0, n,
    nNaN, pctNaN: +(100 * nNaN / n).toFixed(2),
    maxGapMs,
    note: 'interpolação linear apenas ENTRE amostras vizinhas; lacunas maiores que o limite ficam NaN'
  };
}
