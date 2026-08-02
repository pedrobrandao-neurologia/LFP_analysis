/* qc/reproducibility.js — reprodutibilidade do pico entre registros
   consecutivos, e triagem por ECG que exclui o hemisfério da série crônica.

   POR QUE ISTO EXISTE.
   • Thenaisie et al. (J Neural Eng 2021) reportaram que registros consecutivos
     do MESMO paciente e MESMOS contatos foram classificados de forma
     INCONSISTENTE entre sessões pelo próprio Percept, e que 27% dos pares de
     contato foram rotulados como artefactuais em GPi. Um pico que não se repete
     entre registros não é biomarcador — é ruído com sorte.
   • van Rheede et al. (npj Parkinsons Dis 2022) rastrearam os streams do Signal
     Test quanto a contaminação cardíaca e, quando havia artefato de ECG,
     excluíram TODA a série crônica daquele STN (2 de 12 excluídos). É critério
     conservador e defensável — e aqui é apresentado como DECISÃO EXPLÍCITA que
     o usuário confirma, não como filtro silencioso.                          */

import { mean, sd, median } from '../stats/descriptive.js';
import { peakInBand } from '../metrics/acute.js';
import { detectRPeaks } from '../artifact/rpeaks.js';

/* peakReproducibility(records, {lo, hi})
   `records`: [{ hemisphere, channel, label, f, p, sessionDate, artifact }]
   → por canal: n, frequências, desvio máximo, CV da magnitude, concordância da
     flag de artefato e um veredito.                                           */
export function peakReproducibility(records, opts) {
  opts = opts || {};
  const lo = isFinite(opts.lo) ? opts.lo : 13, hi = isFinite(opts.hi) ? opts.hi : 35;
  const grupos = new Map();
  (records || []).forEach(r => {
    if (!r || !r.f || !r.f.length) return;
    const chave = `${r.hemisphere}|${r.channel || r.label || '?'}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(r);
  });

  const linhas = [];
  grupos.forEach((rs, chave) => {
    const [hemi, canal] = chave.split('|');
    const picos = rs.map(r => {
      const pk = peakInBand(r.f, r.p, lo, hi);
      return { hz: pk.f, mag: pk.v, sessionDate: r.sessionDate || null, artifact: r.artifact || null };
    }).filter(x => isFinite(x.hz));
    if (!picos.length) return;
    const hzs = picos.map(x => x.hz), mags = picos.map(x => x.mag);
    const desvioMax = hzs.length > 1 ? Math.max(...hzs) - Math.min(...hzs) : 0;
    const cv = mags.length > 1 && mean(mags) > 0 ? sd(mags) / mean(mags) : NaN;
    const flags = picos.map(x => x.artifact).filter(Boolean);
    const concordaFlag = flags.length > 1 ? new Set(flags).size === 1 : null;
    const veredito = picos.length < 2 ? 'n insuficiente'
      : desvioMax <= 1 ? 'reprodutível' : 'instável';
    linhas.push({
      hemisphere: hemi, channel: canal, n: picos.length,
      peaks: picos.map(x => +x.hz.toFixed(2)),
      medianHz: +median(hzs).toFixed(2),
      maxDeviationHz: +desvioMax.toFixed(2),
      magnitudeCV: isFinite(cv) ? +cv.toFixed(3) : NaN,
      deviceArtifactFlags: flags,
      artifactFlagAgrees: concordaFlag,
      verdict: veredito
    });
  });

  const reprod = linhas.filter(l => l.verdict === 'reprodutível').length;
  const avaliaveis = linhas.filter(l => l.verdict !== 'n insuficiente').length;
  return {
    channels: linhas.sort((a, b) => a.hemisphere.localeCompare(b.hemisphere) || a.channel.localeCompare(b.channel)),
    band: [lo, hi],
    nChannels: linhas.length, nEvaluable: avaliaveis, nReproducible: reprod,
    pctReproducible: avaliaveis ? +(100 * reprod / avaliaveis).toFixed(1) : NaN,
    criterion: 'desvio ≤ 1 Hz entre registros do mesmo canal',
    note: avaliaveis === 0
      ? 'é preciso mais de um registro do mesmo canal para avaliar reprodutibilidade'
      : null
  };
}

/* screenChronicByEcg(parsed, opts)
   Roda a detecção de picos R nos registros de Signal Test / Survey de cada
   hemisfério e recomenda incluir, excluir a série crônica, ou inspecionar.    */
export function screenChronicByEcg(parsedList, opts) {
  opts = opts || {};
  const lista = Array.isArray(parsedList) ? parsedList : [parsedList];
  const porHemi = {};
  ['Left', 'Right'].forEach(h => {
    const series = [];
    lista.forEach(p => {
      (p.montageTD || []).concat(p.bsTimeDomain || []).forEach(td => {
        if (td.hemisphere === h && td.data && td.data.length > 8 * (td.fsEff || td.fs)) series.push(td);
      });
    });
    if (!series.length) {
      porHemi[h] = {
        hemisphere: h, evaluated: false, ecgDetected: null, confidence: null,
        recommendation: 'não avaliável', reason: 'sem sinal bruto para triagem neste hemisfério'
      };
      return;
    }
    const resultados = series.slice(0, 4).map(td => {
      const fs = td.fsEff || td.fs;
      const det = detectRPeaks(td.data, fs, {});
      return { channel: td.label, nBeats: det.nDetected, confidence: det.confidence, bpm: det.bpm };
    });
    const comEcg = resultados.filter(r => r.nBeats >= 8 && r.confidence !== 'baixa');
    const detectado = comEcg.length > 0;
    const altaConf = comEcg.some(r => r.confidence === 'alta');
    porHemi[h] = {
      hemisphere: h, evaluated: true,
      ecgDetected: detectado,
      confidence: altaConf ? 'alta' : detectado ? 'média' : 'baixa',
      channels: resultados,
      recommendation: !detectado ? 'incluir'
        : altaConf ? 'excluir série crônica' : 'inspeção visual necessária',
      reason: !detectado
        ? 'sem contaminação cardíaca detectável nos registros de triagem'
        : `contaminação cardíaca detectada em ${comEcg.length} de ${resultados.length} registros de triagem` +
          (altaConf ? ' com alta confiança' : '')
    };
  });
  return {
    hemispheres: porHemi,
    criterion: 'van Rheede et al. 2022: com artefato de ECG no Signal Test, a série crônica daquele hemisfério é excluída por inteiro',
    note: 'esta é uma DECISÃO que o usuário confirma; se aceita, o hemisfério aparece como excluído com o motivo, em vez de simplesmente omitido'
  };
}
