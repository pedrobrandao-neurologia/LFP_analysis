/* adbs/eligibility.js — relatório de elegibilidade a aDBS.

   POR QUE ISTO IMPORTA. No ADAPT-START (Cascino et al., npj Parkinsons Dis
   2026), de 20 pacientes consecutivos com Percept e cDBS otimizada, apenas
   NOVE foram elegíveis; as exclusões decorreram de artefatos de sinal, ausência
   de pico beta distinto, ou parâmetros de estimulação incompatíveis. Saber
   disso ANTES da consulta de programação é o que este relatório entrega.

   Cada critério devolve veredito, evidência e — quando pendente — O QUE
   CAPTURAR para resolvê-lo. Contexto regulatório: em fevereiro de 2025 o FDA
   aprovou o BrainSense Adaptive DBS (Percept RC) para DP com flutuações
   motoras, com base no ADAPT-PD; o algoritmo usa atividade alfa-beta (~8–30 Hz).

   Prevalência do pico beta, para o usuário saber que ausência é comum:
     • 64–69,5% por hemisfério em coortes pequenas;
     • 84,8% (64,2% bilateral, n = 51) no ADAPT-PD;
     • 89,0% (69,4% bilateral, n = 113) no registro de vigilância BrainSense.  */

import { welchPSD } from '../dsp/spectral.js';
import { fitAperiodic } from '../dsp/aperiodic.js';
import { pickSpectrum, peakInBand } from '../metrics/acute.js';
import { checkHarmonics } from '../qc/harmonics.js';
import { peakReproducibility } from '../qc/reproducibility.js';
import { detectRPeaks } from '../artifact/rpeaks.js';
import { mergeTrend } from '../metrics/chronic.js';
import { cosinor } from '../stats/circadian.js';
import { localHour, localDayKey } from '../io/parse.js';
import { removeOutliersMAD } from '../stats/descriptive.js';
import { inferDeviceState } from '../io/devicestate.js';
import { getProfile } from '../profiles/index.js';

export const PREVALENCIA_BETA = {
  coortesPequenas: '64–69,5% por hemisfério',
  adaptPd: '84,8% por hemisfério; 64,2% bilateral (n = 51)',
  registroBrainSense: '89,0% por hemisfério; 69,4% bilateral (n = 113)',
  nota: 'uma proporção substancial de pacientes simplesmente não expressa beta — isso precisa entrar no cálculo amostral'
};

const crit = (id, rotulo, veredito, evidencia, pendencia) =>
  ({ id, rotulo, veredito, evidencia, pendencia: pendencia || null });

/* assessEligibility(parsedList, opts) → por hemisfério */
export function assessEligibility(parsedList, opts) {
  opts = opts || {};
  const lista = Array.isArray(parsedList) ? parsedList : [parsedList];
  const perfil = getProfile(opts.profileId || 'pd');
  const pb = perfil.primaryBand;
  const offMin = isFinite(opts.offMin) ? opts.offMin : -180;
  const merged = mergeTrend(lista);

  /* reprodutibilidade é entre registros: uma vez para o conjunto */
  const registros = [];
  lista.forEach(p => (p.montage || []).forEach(m => registros.push({
    hemisphere: m.hemisphere, channel: m.label, f: m.f, p: m.mag,
    sessionDate: p.meta.sessionStart, artifact: m.artifact
  })));
  const reprod = peakReproducibility(registros, { lo: pb.lo, hi: pb.hi });

  const hemis = ['Left', 'Right'].map(hemi => {
    const criterios = [];
    const p0 = lista[0];

    /* 1. pico na banda primária, distinto após correção aperiódica ---------- */
    let picoHz = NaN, temPico = false;
    const spec = pickSpectrum(p0, hemi);
    if (!spec) criterios.push(crit('pico', `Pico ${pb.label} distinto`, 'dados insuficientes',
      'nenhum espectro disponível para este hemisfério',
      'executar BrainSense Survey bilateral com estimulação desligada'));
    else {
      const ap = fitAperiodic(spec.f, spec.p, { fmin: 2, fmax: 95 });
      const picos = ap ? ap.peaks.filter(pk => pk.cf >= pb.lo && pk.cf <= pb.hi) : [];
      const bruto = peakInBand(spec.f, spec.p, pb.lo, pb.hi);
      picoHz = picos.length ? picos[0].cf : bruto.f;
      /* verificação contra harmônicos: pico com escada de harmônicos é suspeito */
      const st0 = inferDeviceState(null, p0, { modality: 'survey' });
      const h = checkHarmonics(spec.f, spec.p, picoHz, { stimRateHz: st0.rateHz, fs: 250 });
      temPico = picos.length > 0 && h.verdict !== 'artefato provável';
      criterios.push(crit('pico', `Pico ${pb.label} distinto`,
        temPico ? 'atende' : picos.length ? 'não atende' : 'não atende',
        picos.length
          ? `pico em ${picoHz.toFixed(1)} Hz (fonte ${spec.source}); verificação de harmônicos: ${h.verdict}`
          : `nenhum pico destacado do fundo aperiódico em ${pb.lo}–${pb.hi} Hz`,
        temPico ? null : 'sem pico distinto o aDBS guiado por essa banda não é programável neste hemisfério'));
    }

    /* 2. ausência de artefato relevante ------------------------------------ */
    const td = (p0.bsTimeDomain || []).find(t => t.hemisphere === hemi)
      || (p0.montageTD || []).find(t => t.hemisphere === hemi);
    if (!td) criterios.push(crit('artefato', 'Ausência de artefato relevante', 'dados insuficientes',
      'sem sinal bruto para avaliar contaminação', 'registrar BrainSense Streaming ou Survey neste hemisfério'));
    else {
      const fs = td.fsEff || td.fs;
      const det = detectRPeaks(td.data, fs, {});
      const pk = td.packets || {};
      const problemas = [];
      if (det.nDetected >= 8 && det.confidence === 'alta') problemas.push('contaminação cardíaca detectada com alta confiança');
      if (pk.reliable && pk.pctMissing > 10) problemas.push(`${pk.pctMissing.toFixed(1)}% de perda de pacotes`);
      criterios.push(crit('artefato', 'Ausência de artefato relevante',
        problemas.length ? 'não atende' : 'atende',
        problemas.length ? problemas.join('; ') : 'sem artefato relevante detectado nos registros disponíveis',
        problemas.length ? 'artefato é causa reconhecida de maladaptação em aDBS (Busch et al.) — ver F15 e F17' : null));
    }

    /* 3. reprodutibilidade do pico ----------------------------------------- */
    const rep = reprod.channels.filter(c => c.hemisphere === hemi && c.verdict !== 'n insuficiente');
    if (!rep.length) criterios.push(crit('reprodutibilidade', 'Reprodutibilidade do pico', 'dados insuficientes',
      'é preciso mais de um registro do mesmo canal',
      'repetir o BrainSense Survey numa segunda sessão para verificar se o pico se mantém'));
    else {
      const instaveis = rep.filter(c => c.verdict === 'instável').length;
      criterios.push(crit('reprodutibilidade', 'Reprodutibilidade do pico',
        instaveis === 0 ? 'atende' : instaveis === rep.length ? 'não atende' : 'atende com ressalva',
        `${rep.length - instaveis}/${rep.length} canais com desvio ≤ 1 Hz entre registros`,
        instaveis ? 'pico que muda entre registros não sustenta um limiar fixo' : null));
    }

    /* 4. parâmetros de estimulação compatíveis ------------------------------ */
    const st = inferDeviceState(
      (p0.bsLfp || []).find(b => b.series && b.series[hemi]) || td || { hemisphere: hemi },
      p0, { modality: 'streaming' });
    const incompat = [];
    if (isFinite(st.rateHz) && st.rateHz > 0) {
      /* o sensing é censurado perto da frequência de estimulação e de suas dobras */
      if (st.rateHz < 100) incompat.push(`frequência de estimulação baixa (${st.rateHz} Hz) — maior censura espectral`);
    }
    if (isFinite(st.pulseWidthUs) && st.pulseWidthUs > 90)
      incompat.push(`largura de pulso alta (${st.pulseWidthUs} µs) — mais artefato no sensing`);
    criterios.push(crit('parametros', 'Parâmetros de estimulação compatíveis',
      st.state === 'UNKNOWN' ? 'dados insuficientes' : incompat.length ? 'atende com ressalva' : 'atende',
      st.state === 'UNKNOWN' ? 'estado do dispositivo não determinável'
        : `${st.state}; ${isFinite(st.rateHz) ? st.rateHz + ' Hz' : 'freq. ?'}, ` +
          `${isFinite(st.pulseWidthUs) ? st.pulseWidthUs + ' µs' : 'PW ?'}, ${isFinite(st.amplitudeMa) ? st.amplitudeMa + ' mA' : 'amp. ?'}`,
      incompat.length ? incompat.join('; ') : null));

    /* 5. dados crônicos suficientes ---------------------------------------- */
    const rows = merged[hemi] || [];
    const dias = new Set(rows.map(r => localDayKey(r.t, offMin))).size;
    /* ADAPT-START usou 5 dias e sugere que 3 possam bastar; uma única sessão
       in-clinic é insuficiente para o modo de limiar duplo */
    const vered5 = dias >= 5 ? 'atende' : dias >= 3 ? 'atende com ressalva' : 'não atende';
    criterios.push(crit('cronico', 'Dados crônicos suficientes', rows.length ? vered5 : 'não atende',
      rows.length ? `${dias} dia(s) de Timeline, ${rows.length} pontos` : 'sem Timeline registrado',
      dias >= 5 ? null
        : `ADAPT-START usou 5 dias de registro e sugere que 3 possam bastar para avaliar a variabilidade circadiana; ` +
          `uma única sessão de consultório é insuficiente para o modo de limiar duplo` +
          (rows.length ? '' : ' — habilitar BrainSense Timeline nos dois hemisférios')));

    /* 6. variabilidade circadiana detectável -------------------------------- */
    if (rows.length < 24) criterios.push(crit('circadiano', 'Variabilidade circadiana detectável',
      'dados insuficientes', 'Timeline curto demais para ajustar o cosinor',
      'ao menos alguns dias de registro domiciliar'));
    else {
      const limpo = removeOutliersMAD(rows, 'lfp', 4).kept;
      const cos = cosinor(limpo.map(r => localHour(r.t, offMin)), limpo.map(r => r.lfp), [24, 12]);
      const rel = cos ? cos.components[0].amplitude / (cos.mesor || 1) : NaN;
      const ok = cos && cos.pAdjustedAR1 < 0.05 && rel > 0.05;
      criterios.push(crit('circadiano', 'Variabilidade circadiana detectável',
        ok ? 'atende' : 'atende com ressalva',
        cos ? `amplitude de 24 h = ${(100 * rel).toFixed(1)}% do MESOR; p corrigido para AR(1) = ${cos.pAdjustedAR1.toExponential(1)}`
          : 'cosinor não ajustável',
        ok ? null : 'variabilidade circadiana fraca reduz o ganho esperado do limiar duplo'));
    }

    /* veredito global ------------------------------------------------------- */
    const naoAtende = criterios.filter(c => c.veredito === 'não atende');
    const insuf = criterios.filter(c => c.veredito === 'dados insuficientes');
    const ressalva = criterios.filter(c => c.veredito === 'atende com ressalva');
    const global = naoAtende.length ? 'não elegível'
      : insuf.length ? 'dados insuficientes'
        : ressalva.length ? 'elegível com ressalva' : 'elegível';

    return {
      hemisphere: hemi, verdict: global, criteria: criterios,
      peakHz: isFinite(picoHz) ? +picoHz.toFixed(2) : NaN, hasPeak: temPico,
      nDaysChronic: dias,
      blockers: naoAtende.map(c => c.rotulo),
      missing: criterios.filter(c => c.pendencia).map(c => ({ criterio: c.rotulo, pendencia: c.pendencia }))
    };
  });

  return {
    hemispheres: hemis,
    profile: perfil.id, band: [pb.lo, pb.hi],
    prevalence: PREVALENCIA_BETA,
    context: 'ADAPT-START: de 20 pacientes consecutivos com Percept e cDBS otimizada, apenas 9 foram elegíveis',
    bilateral: hemis.every(h => h.verdict === 'elegível' || h.verdict === 'elegível com ressalva')
  };
}
