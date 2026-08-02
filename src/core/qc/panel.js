/* qc/panel.js — painel de controle de qualidade consolidado.

   Reúne, por arquivo e hemisfério, o checklist de artefatos da revisão
   (seção 4.4) como semáforo. É a peça que sustenta a alegação de rigor do
   software: em vez de "confie, tratamos artefato", uma lista item a item do que
   foi verificado, do que passou, do que passou com ressalva e — importante — do
   que NÃO É VERIFICÁVEL com este dado, com o motivo.

   Cores: 'verde' (verificado e aprovado), 'amarelo' (verificado com ressalva),
   'vermelho' (problema), 'cinza' (não verificável — com o motivo).           */

import { nanStats } from '../dsp/nan.js';
import { detectRPeaks } from '../artifact/rpeaks.js';
import { removeEcg } from '../artifact/ecg.js';
import { validateEcgRemoval } from '../artifact/validate.js';
import { detectRampArtifacts, detectPolyphasic } from '../artifact/ramp.js';
import { checkHarmonics } from './harmonics.js';
import { peakReproducibility } from './reproducibility.js';
import { inferDeviceState } from '../io/devicestate.js';
import { welchPSD } from '../dsp/spectral.js';
import { peakInBand } from '../metrics/acute.js';

const item = (chave, rotulo, cor, valor, motivo) => ({ chave, rotulo, cor, valor, motivo: motivo || null });

/* qcPanel(parsedList, opts) → { rows, summary } — uma linha por arquivo × hemisfério */
export function qcPanel(parsedList, opts) {
  opts = opts || {};
  const lista = Array.isArray(parsedList) ? parsedList : [parsedList];
  const linhas = [];

  /* reprodutibilidade é entre registros: calculada uma vez para todo o conjunto */
  const registros = [];
  lista.forEach(p => (p.montage || []).forEach(m => registros.push({
    hemisphere: m.hemisphere, channel: m.label, f: m.f, p: m.mag,
    sessionDate: p.meta.sessionStart, artifact: m.artifact
  })));
  const reprod = peakReproducibility(registros, opts.band ? { lo: opts.band[0], hi: opts.band[1] } : {});

  lista.forEach(p => {
    ['Left', 'Right'].forEach(hemi => {
      const td = (p.bsTimeDomain || []).find(t => t.hemisphere === hemi)
        || (p.montageTD || []).find(t => t.hemisphere === hemi);
      const temAlgo = td || (p.montage || []).some(m => m.hemisphere === hemi) || (p.trend || {})[hemi];
      if (!temAlgo) return;
      const itens = [];
      const fs = td ? (td.fsEff || td.fs) : NaN;

      /* 1. perda de pacotes */
      if (td) {
        const pk = td.packets || {};
        const est = nanStats(td.data);
        if (!pk.reliable) itens.push(item('pacotes', 'Perda de pacotes tratada', 'cinza', 'não verificável',
          'o registro não traz GlobalSequences nem TicksInMses'));
        else if (pk.pctMissing === 0) itens.push(item('pacotes', 'Perda de pacotes tratada', 'verde', '0% perdido',
          `verificado por ${pk.method}`));
        else itens.push(item('pacotes', 'Perda de pacotes tratada', pk.pctMissing > 20 ? 'vermelho' : 'amarelo',
          `${pk.pctMissing.toFixed(2)}% perdido`, `${est.nNan} amostras como NaN, sem interpolação`));
      } else itens.push(item('pacotes', 'Perda de pacotes tratada', 'cinza', 'sem sinal bruto', null));

      /* 2. fs efetiva */
      if (td && td.timing && td.timing.reliable) {
        const dr = td.timing.driftMsTotal;
        itens.push(item('fs', 'fs efetiva recalculada', Math.abs(dr) > 20 ? 'amarelo' : 'verde',
          `${td.fsEff.toFixed(4)} Hz`, `deriva de ${dr.toFixed(1)} ms no registro`));
      } else itens.push(item('fs', 'fs efetiva recalculada', 'cinza', 'não verificável', 'sem TicksInMses'));

      /* 3. artefato cardíaco */
      if (td && td.data.length > 8 * fs) {
        const det = detectRPeaks(td.data, fs, {});
        if (det.nDetected < 5)
          itens.push(item('ecg', 'Artefato cardíaco', 'verde', 'não detectado', det.reason));
        else {
          const rem = removeEcg(td.data, fs, det.peaks, { method: 'svd' });
          const val = validateEcgRemoval(td.data, rem.cleaned, fs, {});
          const ok = val.suppressionRatioDb > 0 && val.betaPeakRecovery >= 0.8 && val.betaPeakRecovery <= 1.2;
          itens.push(item('ecg', 'Artefato cardíaco', det.confidence === 'alta' ? (ok ? 'amarelo' : 'vermelho') : 'amarelo',
            `${det.nDetected} batimentos (${det.bpm.toFixed(0)} bpm)`,
            `supressão ${val.suppressionRatioDb.toFixed(1)} dB; recuperação do pico ${val.betaPeakRecovery.toFixed(2)}; confiança ${det.confidence}`));
        }
      } else itens.push(item('ecg', 'Artefato cardíaco', 'cinza', 'não verificável', 'sem sinal bruto suficiente'));

      /* 4. rampa de estimulação */
      const bs = (p.bsLfp || []).find(b => b.series && b.series[hemi]);
      if (bs) {
        const r = detectRampArtifacts(td ? td.data : null, fs || 250, {
          maSeries: bs.series[hemi].ma, maFs: bs.fsEff || bs.fs || 2
        });
        itens.push(item('rampa', 'Rampa de estimulação', r.nSteps ? 'amarelo' : 'verde',
          `${r.nSteps} mudança(s) de amplitude`,
          r.nSteps ? `${r.pctAffected.toFixed(1)}% do registro em janela de transiente (default: mascarar)` : null));
      } else itens.push(item('rampa', 'Rampa de estimulação', 'cinza', 'não verificável', 'sem série de amplitude (BrainSenseLfp)'));

      /* 5. transientes polifásicos */
      if (td) {
        const poly = detectPolyphasic(td.data, fs);
        itens.push(item('polifasicos', 'Transientes polifásicos', poly.nEvents ? 'amarelo' : 'verde',
          `${poly.nEvents} evento(s)`, poly.nEvents ? `${poly.pctAffected}% do registro afetado` : null));
      } else itens.push(item('polifasicos', 'Transientes polifásicos', 'cinza', 'sem sinal bruto', null));

      /* 6. movimento / tremor */
      itens.push(item('movimento', 'Movimento / tremor', 'cinza', 'não verificável',
        'exige canal de IMU ou EMG sincronizado — importação de sinal externo é da Onda 2.3'));

      /* 7. estado do dispositivo declarado */
      const st = inferDeviceState(bs || td, p, { modality: bs ? 'streaming' : (td ? 'survey' : null) });
      itens.push(item('estado', 'Estado do dispositivo declarado',
        st.state === 'UNKNOWN' ? 'vermelho' : st.confidence === 'fraca' ? 'amarelo' : 'verde',
        st.state, st.evidence.join('; ') || 'sem evidência disponível'));

      /* 8. harmônicos */
      if (td && td.data.length > 4 * fs) {
        const w = welchPSD(td.data, fs, { nperseg: 512, overlap: .5 });
        if (w.p) {
          const pico = peakInBand(w.f, w.p, opts.band ? opts.band[0] : 13, opts.band ? opts.band[1] : 35);
          const h = checkHarmonics(Array.from(w.f), Array.from(w.p), pico.f, {
            stimRateHz: st.rateHz, fs
          });
          itens.push(item('harmonicos', 'Harmônicos verificados',
            h.verdict === 'artefato provável' ? 'vermelho' : h.isSuspect ? 'amarelo' : 'verde',
            h.verdict, h.reason));
        } else itens.push(item('harmonicos', 'Harmônicos verificados', 'cinza', 'espectro não estimável', w.reason));
      } else itens.push(item('harmonicos', 'Harmônicos verificados', 'cinza', 'sem sinal bruto', null));

      /* 9. reprodutibilidade do pico */
      const rep = reprod.channels.filter(c => c.hemisphere === hemi);
      if (!rep.length) itens.push(item('reprodutibilidade', 'Reprodutibilidade do pico', 'cinza', 'não verificável',
        'é preciso mais de um registro do mesmo canal'));
      else {
        const avaliaveis = rep.filter(c => c.verdict !== 'n insuficiente');
        const instaveis = avaliaveis.filter(c => c.verdict === 'instável').length;
        if (!avaliaveis.length) itens.push(item('reprodutibilidade', 'Reprodutibilidade do pico', 'cinza',
          'n insuficiente', 'apenas um registro por canal'));
        else itens.push(item('reprodutibilidade', 'Reprodutibilidade do pico',
          instaveis === 0 ? 'verde' : instaveis === avaliaveis.length ? 'vermelho' : 'amarelo',
          `${avaliaveis.length - instaveis}/${avaliaveis.length} canais reprodutíveis`,
          'critério: desvio ≤ 1 Hz entre registros'));
      }

      linhas.push({
        file: p.fileName, subjectId: p.patient.idHash, hemisphere: hemi,
        deviceState: st.state, items: itens
      });
    });
  });

  const todos = linhas.flatMap(l => l.items);
  const conta = c => todos.filter(i => i.cor === c).length;
  return {
    rows: linhas,
    reproducibility: reprod,
    summary: {
      nRows: linhas.length, nItems: todos.length,
      verde: conta('verde'), amarelo: conta('amarelo'), vermelho: conta('vermelho'), cinza: conta('cinza'),
      pctVerificado: todos.length ? +(100 * (todos.length - conta('cinza')) / todos.length).toFixed(1) : 0
    }
  };
}
