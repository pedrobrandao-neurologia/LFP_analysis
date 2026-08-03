/* export/edf.js — escritor de EDF/EDF+ do zero.

   POR QUE. EDF é o formato que qualquer software de eletrofisiologia abre —
   EEGLAB, FieldTrip, MNE, Brainstorm, os visualizadores clínicos. Exportar o
   sinal bruto do Percept em EDF é o que permite levar o registro para outra
   ferramenta sem passar por CSV gigante nem por formato proprietário.

   O PROBLEMA QUE O EDF NÃO RESOLVE, E QUE AQUI NÃO É ESCONDIDO: o formato
   armazena inteiros de 16 bits e NÃO TEM representação para dado ausente. A
   perda de pacote do Percept, que este software preserva como NaN em todo o
   pipeline, precisa virar algum número na hora de escrever. A política aqui:
     • as amostras faltantes recebem o MÍNIMO DIGITAL, valor que fica fora da
       faixa física dos dados reais por construção (a faixa física é calculada
       só sobre amostras válidas, com margem);
     • a posição de cada lacuna vai para o campo de anotações do EDF+ e para um
       JSON acompanhante;
     • o campo de pré-filtragem de cada canal declara a política em texto.
   Quem abrir o EDF em outro programa consegue, com isso, remascarar as lacunas.
   Escrever NaN como zero — o que a maioria dos conversores faz — seria criar
   sinal onde não há.

   Referências: Kemp B, Olivan J. Clin Neurophysiol 2003;114:1755-1761 (EDF+);
   especificação original em Kemp B, et al. Electroencephalogr Clin
   Neurophysiol 1992;82:391-393.                                              */

/* Preenche à direita com espaços até `n` — toda a cabeçalho do EDF é ASCII de
   largura fixa, e um campo curto demais desloca o arquivo inteiro. */
function campo(v, n) {
  let s = String(v == null ? '' : v);
  /* remove acento e qualquer coisa fora do ASCII imprimível: o EDF exige
     US-ASCII, e um caractere fora disso corrompe o deslocamento em bytes */
  s = s.normalize ? s.normalize('NFD').replace(/[̀-ͯ]/g, '') : s;
  s = s.replace(/[^\x20-\x7E]/g, ' ');
  if (s.length > n) s = s.slice(0, n);
  return s + ' '.repeat(n - s.length);
}
function numeroCampo(v, n) {
  if (!isFinite(v)) return campo('0', n);
  let s = String(v);
  if (s.length > n) {
    /* encurta mantendo o máximo de precisão que couber */
    for (let d = n - 2; d >= 0; d--) { s = Number(v).toFixed(d); if (s.length <= n) break; }
    if (s.length > n) s = Number(v).toExponential(Math.max(0, n - 7));
    if (s.length > n) s = s.slice(0, n);
  }
  return campo(s, n);
}
const dois = v => String(Math.floor(v)).padStart(2, '0');

/* writeEdf(signals, opts) → { bytes: Uint8Array, meta }
   signals: [{ label, data (Float64Array|Array), fs, unit, prefilter, transducer }]
   opts: { startMs, patientId, recordingId, recordSeconds }                   */
export function writeEdf(signals, opts) {
  opts = opts || {};
  const sinais = (signals || []).filter(s => s && s.data && s.data.length && s.fs > 0);
  if (!sinais.length) return null;
  const durRegistro = isFinite(opts.recordSeconds) && opts.recordSeconds > 0 ? opts.recordSeconds : 1;

  /* amostras por registro de cada canal; a duração total é ditada pelo canal
     mais curto, porque o EDF exige registros completos */
  const porRegistro = sinais.map(s => Math.max(1, Math.round(s.fs * durRegistro)));
  const nRegistros = Math.min.apply(null, sinais.map((s, i) => Math.floor(s.data.length / porRegistro[i])));
  if (!(nRegistros > 0)) return null;

  /* faixa física por canal, calculada SÓ sobre amostras válidas, com margem —
     é o que garante que o valor atribuído às lacunas fique fora dos dados */
  const faixas = sinais.map(s => {
    let mn = Infinity, mx = -Infinity, nNaN = 0;
    for (let i = 0; i < s.data.length; i++) {
      const v = s.data[i];
      if (!isFinite(v)) { nNaN++; continue; }
      if (v < mn) mn = v; if (v > mx) mx = v;
    }
    if (!isFinite(mn) || !isFinite(mx)) { mn = -1; mx = 1; }
    if (mx - mn < 1e-12) { mn -= 1; mx += 1; }
    const margem = 0.05 * (mx - mn);
    return { physMin: mn - margem, physMax: mx + margem, nNaN };
  });

  const digMin = -32768, digMax = 32767;
  const lacunas = [];
  sinais.forEach((s, k) => {
    let ini = -1;
    const n = nRegistros * porRegistro[k];
    for (let i = 0; i <= n; i++) {
      const falta = i < n && !isFinite(s.data[i]);
      if (falta && ini < 0) ini = i;
      else if (!falta && ini >= 0) {
        lacunas.push({ channel: s.label, startSec: +(ini / s.fs).toFixed(4), durationSec: +((i - ini) / s.fs).toFixed(4), nSamples: i - ini });
        ini = -1;
      }
    }
  });

  const ns = sinais.length;
  const bytesCabecalho = 256 * (ns + 1);
  const bytesDados = nRegistros * porRegistro.reduce((a, b) => a + b, 0) * 2;
  const buf = new Uint8Array(bytesCabecalho + bytesDados);
  let off = 0;
  const escreve = txt => { for (let i = 0; i < txt.length; i++) buf[off++] = txt.charCodeAt(i) & 0xff; };

  const inicio = new Date(isFinite(opts.startMs) ? opts.startMs : Date.now());
  const politica = 'lacunas=minimo digital';

  escreve(campo('0', 8));
  escreve(campo(opts.patientId || 'X X X X', 80));
  escreve(campo(opts.recordingId || `Startdate X X X Percept-LFP-Studio (${politica})`, 80));
  escreve(campo(`${dois(inicio.getUTCDate())}.${dois(inicio.getUTCMonth() + 1)}.${dois(inicio.getUTCFullYear() % 100)}`, 8));
  escreve(campo(`${dois(inicio.getUTCHours())}.${dois(inicio.getUTCMinutes())}.${dois(inicio.getUTCSeconds())}`, 8));
  escreve(campo(String(bytesCabecalho), 8));
  escreve(campo('EDF+C', 44));
  escreve(campo(String(nRegistros), 8));
  escreve(numeroCampo(durRegistro, 8));
  escreve(campo(String(ns), 4));

  sinais.forEach(s => escreve(campo(s.label || 'LFP', 16)));
  sinais.forEach(s => escreve(campo(s.transducer || 'DBS lead (Medtronic Percept)', 80)));
  sinais.forEach(s => escreve(campo(s.unit || 'uV', 8)));
  faixas.forEach(r => escreve(numeroCampo(+r.physMin.toPrecision(6), 8)));
  faixas.forEach(r => escreve(numeroCampo(+r.physMax.toPrecision(6), 8)));
  sinais.forEach(() => escreve(campo(String(digMin), 8)));
  sinais.forEach(() => escreve(campo(String(digMax), 8)));
  sinais.forEach((s, k) => escreve(campo(
    (s.prefilter || 'HP: hardware do dispositivo') + '; ' +
    (faixas[k].nNaN ? `${faixas[k].nNaN} amostras ausentes escritas no minimo digital` : 'sem amostras ausentes'), 80)));
  porRegistro.forEach(n => escreve(campo(String(n), 8)));
  sinais.forEach(() => escreve(campo('', 32)));

  /* dados: registro a registro, canal a canal */
  const vista = new DataView(buf.buffer);
  let pos = bytesCabecalho;
  for (let r = 0; r < nRegistros; r++) {
    for (let k = 0; k < ns; k++) {
      const s = sinais[k], fx = faixas[k], n = porRegistro[k];
      const escala = (digMax - digMin) / (fx.physMax - fx.physMin);
      for (let i = 0; i < n; i++) {
        const v = s.data[r * n + i];
        let d;
        if (!isFinite(v)) d = digMin;
        else {
          d = Math.round(digMin + (v - fx.physMin) * escala);
          if (d < digMin + 1) d = digMin + 1;      /* nunca colide com a marca de ausente */
          if (d > digMax) d = digMax;
        }
        vista.setInt16(pos, d, true);
        pos += 2;
      }
    }
  }

  return {
    bytes: buf,
    meta: {
      format: 'EDF+C', nSignals: ns, nRecords: nRegistros, recordSeconds: durRegistro,
      durationSec: +(nRegistros * durRegistro).toFixed(3),
      headerBytes: bytesCabecalho, totalBytes: buf.length,
      channels: sinais.map((s, k) => ({
        label: s.label, fs: s.fs, unit: s.unit || 'uV',
        physicalMin: +faixas[k].physMin.toPrecision(6), physicalMax: +faixas[k].physMax.toPrecision(6),
        samplesPerRecord: porRegistro[k], nMissing: faixas[k].nNaN
      })),
      missingSamplePolicy: 'amostras ausentes (perda de pacote) foram escritas como o MÍNIMO DIGITAL (-32768), ' +
        'valor fora da faixa física por construção. A lista de lacunas acompanha este arquivo em JSON, e o campo ' +
        'de pré-filtragem de cada canal declara a política. Remascare essas amostras antes de qualquer análise.',
      gaps: lacunas,
      truncatedSamples: sinais.map((s, k) => s.data.length - nRegistros * porRegistro[k])
    }
  };
}
