/* report/checklist.js — PERCEPT-REPORT: itens mínimos de reporte.

   POR QUE ISTO EXISTE. A revisão identifica, como lacuna nº 1 do campo, que
   NÃO EXISTE checklist tipo STROBE/PRISMA para estudos de LFP com dispositivos
   de sensing — e que parâmetros de Welch, critérios de exclusão de artefato,
   método de normalização e tratamento de outliers variam entre grupos e
   frequentemente não são reportados.

   Este módulo propõe esse checklist e o PREENCHE AUTOMATICAMENTE a partir do
   manifesto de proveniência: cada item recebe o valor efetivamente usado, ou é
   marcado como "não aplicável" ou "não determinado — informe manualmente".
   O que o software não conseguir extrair, ele diz que não conseguiu, em vez de
   deixar em branco.

   Ver docs/PERCEPT-REPORT.md para a proposta completa e a fundamentação de
   cada item.                                                                 */

import { makeDocx } from '../export/zip.js';

const NAO_DET = 'não determinado — informe manualmente';
const NAO_APL = 'não aplicável';

/* Itens agrupados. `from` diz de onde o valor sai do manifesto/métricas. */
export const CHECKLIST_ITEMS = [
  ['Dispositivo e aquisição', [
    ['device_model', 'Modelo do neuroestimulador (PC vs RC)'],
    ['firmware', 'Versão de firmware'],
    ['programmer_version', 'Versão do programador'],
    ['target', 'Alvo e modelo de eletrodo'],
    ['sensing_channel', 'Par bipolar de registro'],
    ['fs_nominal', 'Frequência de amostragem nominal (Hz)'],
    ['fs_effective', 'Frequência de amostragem efetiva medida (Hz)'],
    ['hardware_filters', 'Filtros de hardware (passa-alta / passa-baixa)'],
    ['blanking', 'Janela de blanking do sensing (µs)'],
    ['device_state', 'Estado do dispositivo em cada registro (OFF / ON-0 mA / ON-terapêutico)'],
    ['stim_params', 'Parâmetros de estimulação (amplitude, frequência, largura de pulso, contatos)'],
    ['sensing_center', 'Frequência-alvo do sensing e largura da janela (Hz)']
  ]],
  ['Integridade do dado', [
    ['packet_loss', 'Taxa de perda de pacotes e como foi tratada'],
    ['n_valid', 'n de amostras válidas e excluídas'],
    ['drift', 'Deriva temporal estimada (ms)'],
    ['timezone', 'Fuso horário e transições tratadas']
  ]],
  ['Artefatos', [
    ['artifact_types', 'Tipos de artefato avaliados'],
    ['rpeak_method', 'Método de detecção de picos R'],
    ['ecg_method', 'Método de remoção de ECG e seus parâmetros'],
    ['ecg_validation', 'Métricas de validação da remoção (supressão, recuperação do pico)'],
    ['epoch_exclusion', 'Critério de exclusão de época'],
    ['motion', 'Tratamento de artefato de movimento'],
    ['harmonics', 'Verificação de harmônicos']
  ]],
  ['Análise espectral', [
    ['estimator', 'Estimador espectral e todos os parâmetros (janela, sobreposição, nfft, tapers)'],
    ['normalization', 'Método de normalização'],
    ['specparam', 'Parâmetros do specparam / ajuste aperiódico'],
    ['bands', 'Definição exata das bandas']
  ]],
  ['Bursts', [
    ['burst_method', 'Método (Hilbert / wavelet / linha de base 1/f)'],
    ['burst_band', 'Banda usada'],
    ['burst_threshold', 'Percentil de limiar'],
    ['burst_min_duration', 'Duração mínima'],
    ['burst_gaps', 'Como bursts adjacentes a lacunas foram tratados']
  ]],
  ['Crônico', [
    ['n_days', 'n de dias e de pontos válidos'],
    ['outliers', 'Método de remoção de outliers'],
    ['detrending', 'Detrending aplicado'],
    ['cosinor', 'Método do cosinor e correção de autocorrelação'],
    ['acrophase', 'Tratamento da acrofase como grandeza circular']
  ]],
  ['Estatística', [
    ['multiple_comparison', 'Método de correção para comparação múltipla'],
    ['n_permutations', 'n de permutações'],
    ['bootstrap', 'Método de bootstrap'],
    ['software', 'Software e versão']
  ]]
];

/* Extrai o valor de um item a partir do manifesto e das métricas. */
function valorDe(chave, prov, metrics, profile) {
  const h = (prov && prov.header) || {};
  const arq = (prov && prov.files && prov.files[0]) || {};
  const passos = (prov && prov.steps) || [];
  const passo = nome => passos.find(s => s.step === nome);
  const ag = (metrics && metrics.acute && metrics.acute[0]) || {};
  const cr = (metrics && metrics.chronic && metrics.chronic[0]) || {};
  const sub = (metrics && metrics.subject) || {};
  const val = v => (v === undefined || v === null || v === '' || (typeof v === 'number' && !isFinite(v))) ? null : v;

  switch (chave) {
    case 'device_model': return val(arq.deviceModel || sub.device_model);
    case 'firmware': return val(arq.firmware || sub.firmware);
    case 'programmer_version': return val(arq.programmerVersion);
    case 'target': return val((sub.targets || []).map(t => `${t.hemisphere}:${t.target} (${t.model || '—'})`).join(', '));
    case 'sensing_channel': return val(ag.spectrum_channel);
    case 'fs_nominal': {
      const p = passo('parse.timeDomain'); return val(p && p.params.fsNominal) || '250 (default do Percept)';
    }
    case 'fs_effective': { const p = passo('parse.timeDomain'); return val(p && p.params.fsEffective); }
    case 'hardware_filters': { const p = passo('parse.timeDomain'); return val(p && p.params.hardwareFilters); }
    case 'blanking': { const p = passo('parse.timeDomain'); return val(p && p.params.blankingUs); }
    case 'device_state': return val(ag.device_state) || NAO_DET + ' (inferência de estado é da Onda 1.3, ainda não implementada)';
    case 'stim_params': { const p = passo('parse.stimulation'); return val(p && JSON.stringify(p.params)); }
    case 'sensing_center': return val(ag.sensing_center_hz ? `${ag.sensing_center_hz} Hz ± 2,5` : null);
    case 'packet_loss': {
      const p = passo('io.analyzePackets');
      if (!p) return null;
      return `${p.params.method === 'none' ? 'não verificável (sem GlobalSequences/TicksInMses)' :
        `detectada por ${p.params.method}: ${p.params.pctMissing}% de amostras`} — lacunas inseridas como NaN, sem interpolação`;
    }
    case 'n_valid': { const p = passo('io.analyzePackets'); return p ? `${p.nOut} válidas de ${p.nIn} esperadas` : null; }
    case 'drift': { const p = passo('parse.timeDomain'); return val(p && p.params.driftMsTotal); }
    case 'timezone': return val(`UTC${h.timezoneOffsetMin >= 0 ? '+' : ''}${(h.timezoneOffsetMin / 60).toFixed(0)}h` +
      (h.timezoneBreaks && h.timezoneBreaks.length ? `; ${h.timezoneBreaks.length} quebra(s) tratada(s)` : '; nenhuma quebra detectada'));
    case 'artifact_types': return val('cardíaco (F15)' + (ag.ecg_detected != null ? '; detectado: ' + (ag.ecg_detected ? 'sim' : 'não') : '') +
      '. Rampa de estimulação, polifásicos e movimento: Onda 2.2/2.3, ainda não implementados');
    case 'rpeak_method': return val(ag.ecg_detection_method ? `${ag.ecg_detection_method} (confiança ${ag.ecg_detection_confidence})` : null);
    case 'ecg_method': return val(ag.ecg_cleaning_method ?
      `${ag.ecg_cleaning_method}, janela ±${ag.ecg_cleaning_window_s} s` +
      (ag.ecg_svd_components ? `, k = ${ag.ecg_svd_components} componentes` : '') : null);
    case 'ecg_validation': return val(isFinite(ag.ecg_suppression_db) ?
      `supressão ${ag.ecg_suppression_db} dB; recuperação do pico beta ${ag.ecg_beta_peak_recovery}; veredito: ${ag.ecg_cleaning_verdict}` : null);
    case 'epoch_exclusion': return val('segmentos com qualquer NaN são descartados do Welch (maxNanPct = 0); épocas sobre lacuna não entram na matriz de SVD');
    case 'motion': return NAO_APL + ' — regressão por IMU é da Onda 2.3, ainda não implementada';
    case 'harmonics': return NAO_APL + ' — verificação de harmônicos é da Onda 2.2, ainda não implementada';
    case 'estimator': { const p = passo('dsp.welchPSD'); return p ? `Welch (Hann, nperseg ${p.params.nperseg}, sobreposição ${p.params.overlap}, Δf ${p.params.df} Hz, ${p.params.nSegments} segmentos usados e ${p.params.nSegmentsDropped} descartados)` : null; }
    case 'normalization': return val(profile ? profile.normalization : ag.normalization);
    case 'specparam': { const p = passo('dsp.fitAperiodic'); return p ? `regressão robusta iterativa em log-log, fmin ${p.params.fmin} Hz, fmax ${p.params.fmax} Hz (aproximação do specparam/FOOOF)` : null; }
    case 'bands': return val(profile ? profile.bands.map(b => `${b.key} ${b.lo}–${b.hi} Hz`).join('; ') : null);
    case 'burst_method': return val(ag.burst_method || 'envelope de Hilbert com limiar por percentil');
    case 'burst_band': return val(ag.burst_band_hz ? ag.burst_band_hz + ' Hz' : null);
    case 'burst_threshold': return val(ag.burst_percentile ? 'percentil ' + ag.burst_percentile : null);
    case 'burst_min_duration': { const p = passo('dsp.detectBursts'); return val(p && p.params.minDurationMs ? p.params.minDurationMs + ' ms' : '100 ms (default)'); }
    case 'burst_gaps': return val('bursts que encostam em lacuna recebem truncated=true, entram na contagem e ficam fora das estatísticas de duração');
    case 'n_days': return val(cr.n_days ? `${cr.n_days} dias, ${cr.n_points} pontos válidos (${cr.n_removed} removidos)` : null);
    case 'outliers': return val(cr.n_days ? 'mediana ± 4×MAD' : null);
    case 'detrending': return val(cr.n_days ? 'normalização de cada dia pela própria mediana antes de agregar' : null);
    case 'cosinor': return val(isFinite(cr.cosinor_p) ?
      `cosinor por mínimos quadrados com harmônicos de 24 e 12 h; p bruto ${cr.cosinor_p}, p corrigido para AR(1) ${cr.cosinor_p_adj_ar1} (ρ = ${cr.rho_ar1})` : null);
    case 'acrophase': return val(isFinite(cr.rayleigh_p) ?
      `tratada como grandeza circular; teste de Rayleigh das acrofases diárias (R = ${cr.rayleigh_R}, p = ${cr.rayleigh_p})` : null);
    case 'multiple_comparison': return NAO_DET + ' (correção FDR entra com o modo Coorte, Onda 6)';
    case 'n_permutations': { const p = passo('stats.permutationTest'); return val(p && p.params.nPerm ? p.params.nPerm : '3.000 nas comparações das figuras'); }
    case 'bootstrap': return val(cr.n_days ? 'bootstrap de blocos reamostrando dias inteiros (preserva a autocorrelação intradiária)' : null);
    case 'software': return val(`${h.tool} ${h.appVersion}` + (h.bundleHash ? ` (bundle ${String(h.bundleHash).slice(0, 12)})` : ''));
    default: return null;
  }
}

/* generateChecklist(prov, metrics, profile)
   → { items, nFilled, nTotal, markdown, docxBlocks }                        */
export function generateChecklist(prov, metrics, profile) {
  const grupos = CHECKLIST_ITEMS.map(([grupo, itens]) => ({
    grupo,
    itens: itens.map(([chave, rotulo]) => {
      const v = valorDe(chave, prov, metrics, profile);
      const preenchido = v != null && String(v).indexOf(NAO_DET) !== 0 && String(v).indexOf(NAO_APL) !== 0;
      return { chave, rotulo, valor: v == null ? NAO_DET : String(v), preenchido };
    })
  }));
  const todos = grupos.flatMap(g => g.itens);
  const nFilled = todos.filter(i => i.preenchido).length;

  const md = ['# PERCEPT-REPORT — itens mínimos de reporte', '',
    `Preenchido automaticamente a partir do manifesto de proveniência: **${nFilled} de ${todos.length}** itens.`,
    'Os itens marcados como *não determinado* precisam ser informados manualmente antes da submissão.', '']
    .concat(grupos.flatMap(g => ['', `## ${g.grupo}`, '', '| Item | Valor usado |', '|---|---|']
      .concat(g.itens.map(i => `| ${i.rotulo} | ${i.preenchido ? i.valor : '*' + i.valor + '*'} |`))))
    .join('\n');

  const docxBlocks = [{ tipo: 'h1', texto: 'PERCEPT-REPORT — itens mínimos de reporte' },
    { tipo: 'p', texto: `Preenchido automaticamente a partir do manifesto de proveniência: ${nFilled} de ${todos.length} itens.` }]
    .concat(grupos.flatMap(g => [{ tipo: 'h2', texto: g.grupo }]
      .concat(g.itens.map(i => ({ tipo: 'li', texto: `${i.rotulo}: ${i.valor}` })))));

  return { items: grupos, nFilled, nTotal: todos.length, markdown: md, docxBlocks };
}

/* Documento .docx pronto para anexar como material suplementar. */
export function checklistDocx(checklist) { return makeDocx(checklist.docxBlocks); }
