/* i18n/index.js — dois idiomas na interface.

   ESCOPO, DECLARADO. Estão traduzidos: a moldura da interface (cabeçalho,
   painéis, botões, painel de processo, primeiros passos), os TÍTULOS e
   subtítulos das figuras, os rótulos de exportação e as mensagens de estado.
   NÃO estão traduzidos: os textos metodológicos dentro de cada figura, as
   leituras em linguagem clínica e as ressalvas — são centenas de parágrafos com
   terminologia que muda de sentido em tradução apressada, e uma tradução ruim
   num texto que explica limitação metodológica é pior do que texto em outro
   idioma. A interface avisa isso ao trocar de idioma, em vez de deixar o
   usuário descobrir sozinho.

   `t(chave)` devolve a própria chave quando não há tradução — sumir em silêncio
   é como dicionário incompleto vira tela em branco.                          */

export const IDIOMAS = [
  { id: 'pt', label: 'português' },
  { id: 'en', label: 'English' }
];

const DIC = {
  pt: {},
  en: {
    'STN · potenciais de campo local · análise local': 'STN · local field potentials · local analysis',
    'fuso': 'time zone', 'do arquivo': 'from file',
    '⤓ CSV para R': '⤓ CSV for R', 'imprimir / PDF': 'print / PDF',
    '+ carregar JSON': '+ load JSON', '+ pasta': '+ folder',
    'clínico': 'clinical', 'pesquisa': 'research',
    'Arquivos': 'Files', 'Registro em análise': 'Record under analysis',
    'Matriz de dados': 'Data matrix', 'Registro': 'Record',
    'Perfil de doença': 'Disease profile', 'Exportar': 'Export',
    'Qualidade do sinal': 'Signal quality', 'Pipelines de um clique': 'One-click pipelines',
    'modalidade': 'modality', 'presente (n)': 'present (n)', 'ausente': 'absent',
    'identificador': 'identifier', 'diagnóstico': 'diagnosis', 'dispositivo': 'device',
    'implante': 'implant', 'alvos': 'targets', 'bateria': 'battery',
    'perfil de doença': 'disease profile', 'fuso aplicado': 'time zone applied',
    'Soltar arquivos JSON aqui': 'Drop JSON files here',
    'ou clicar para escolher · vários de uma vez': 'or click to choose · several at once',
    'dados presentes': 'data present', 'sem dados': 'no data',
    'remover': 'remove', 'Primeiros passos': 'Getting started', 'entendi': 'got it',
    'Processando': 'Processing', 'preparando…': 'preparing…', 'concluído': 'done',
    'pronto': 'ready', 'no total': 'total', 'falhou': 'failed',
    'ocultar': 'hide', 'ocultar painel de processamento': 'hide processing panel',
    'Espectro de potência anotado e varredura do Survey': 'Annotated power spectrum and Survey sweep',
    'Decomposição periódico / aperiódico': 'Periodic / aperiodic decomposition',
    'Integridade de eletrodos': 'Electrode integrity',
    'Linha do tempo da sessão e parâmetros': 'Session timeline and parameters',
    'Mapa da montagem — canal × frequência': 'Montage map — channel × frequency',
    'Domínio do tempo — traçado, espectrograma e bursts': 'Time domain — trace, spectrogram and bursts',
    'Streaming com estimulação — potência × amplitude': 'Streaming with stimulation — power × amplitude',
    'Timeline crônico — série temporal multi-dia ou dia a dia': 'Chronic Timeline — multi-day time series or day-by-day panels',
    'MRDS — (des)sincronização relacionada ao movimento': 'MRDS — movement-related desynchronization or synchronization',
    'Ritmo circadiano — heatmap, perfil polar e cosinor': 'Circadian rhythm — heatmap, polar profile and cosinor',
    'Resposta alinhada a evento': 'Event-aligned response',
    'Distribuição da potência e limiares de aDBS': 'Power distribution and aDBS thresholds',
    'Espectros por tipo de evento': 'Spectra by event type',
    'Estados ON/OFF pela amplitude do beta': 'ON/OFF states from beta amplitude',
    'Limpeza de artefato cardíaco — três métodos e validação': 'Cardiac artifact removal — three methods and validation',
    'QC — reprodutibilidade do pico entre registros': 'QC — peak reproducibility across recordings',
    'Painel de controle de qualidade': 'Quality control panel',
    'Espectro multitaper com intervalo de confiança': 'Multitaper spectrum with confidence interval',
    'specparam completo — reta ou joelho, largura dos picos, R²': 'Full specparam — fixed or knee, peak width, R²',
    'Wavelet de Morlet — escalograma e bursts delimitados': 'Morlet wavelet — scalogram and bracketed bursts',
    'Acoplamento fase-amplitude (PAC) e comodulograma': 'Phase-amplitude coupling (PAC) and comodulogram',
    'Gama finamente sintonizada vs. gama entrained em f_stim/2': 'Finely-tuned gamma vs. entrained gamma at f_stim/2',
    'aDBS — elegibilidade e simulador de limiar': 'aDBS — eligibility and threshold simulator',
    'Sinal externo — IMU, EMG ou ECG: alinhamento e coerência': 'External signal — IMU, EMG or ECG: alignment and coherence',
    'Actograma e banda-controle — o ritmo é específico?': 'Actogram and control band — is the rhythm specific?',
    'Longitudinal — impedância, confiabilidade e uso do aparelho': 'Longitudinal — impedance, reliability and device usage',
    'Coorte — todos os registros carregados lado a lado': 'Cohort — all loaded records side by side',
    'Matriz hora × dia — estados ON/OFF ligados à sua integral': 'Hour × day matrix — ON/OFF states linked to their integral',
    'Resposta à levodopa alinhada às tomadas': 'Levodopa response aligned to intake marks',
    'Espectrograma — análise tempo-frequência no padrão do BRAVO': 'Spectrogram — time-frequency analysis following BRAVO',
    'Passaporte do biomarcador — o que a sessão aguda calibra no crônico': 'Biomarker passport — what the acute session calibrates in the chronic record',
    'Blocos de configuração e pontos de mudança': 'Configuration blocks and change points',
    'Agenda da próxima sessão': 'Agenda for the next session',
    'Assistente de limiares de aDBS (TIDAL-DT)': 'aDBS Threshold Advisor (TIDAL-DT)',
    'ODR e features por janela — dinâmica multi-banda do registro agudo':
      'ODR and windowed features — multi-band dynamics of the acute recording',
    'Início': 'Home', 'Agudo': 'Acute', 'Crônico': 'Chronic', 'Ponte': 'Bridge',
    'Qualidade': 'Quality', 'Coorte': 'Cohort', 'Relatório': 'Report',
    '⤓ Relatório PDF': '⤓ PDF report', '⤓ Relatório clínico (PDF)': '⤓ Clinical report (PDF)',
    '⤓ JSON para estatística': '⤓ JSON for statistics',
    '⤓ CSV — métricas agudas': '⤓ CSV — acute metrics',
    '⤓ CSV — métricas crônicas': '⤓ CSV — chronic metrics',
    '⤓ CSV — Timeline bruto': '⤓ CSV — raw Timeline',
    '⤓ Todas as figuras (PNG)': '⤓ All figures (PNG)',
    '⤓ Manifesto de proveniência': '⤓ Provenance manifest',
    '⤓ Pacote completo (.zip)': '⤓ Complete package (.zip)',
    'escopo da tradução': 'translation scope'
  }
};

let atual = 'pt';
export function setLanguage(id) { atual = DIC[id] ? id : 'pt'; return atual; }
export function getLanguage() { return atual; }
export function t(chave) {
  if (chave == null) return '';
  const d = DIC[atual];
  if (!d) return String(chave);
  const v = d[chave];
  return v == null ? String(chave) : v;
}
export function translationCoverage() {
  return {
    languages: IDIOMAS.map(l => l.id),
    nKeys: Object.keys(DIC.en).length,
    scope: 'moldura da interface, títulos e subtítulos de figura, rótulos de exportação e mensagens de estado',
    outOfScope: 'textos metodológicos dentro das figuras, leituras em linguagem clínica e ressalvas',
    reason: 'uma tradução apressada de texto que explica limitação metodológica é pior do que texto em outro idioma',
    notice: {
      pt: 'A moldura da interface e os títulos das figuras mudam de idioma. Os textos metodológicos dentro de cada ' +
        'figura, as leituras em linguagem clínica e as ressalvas permanecem em português.',
      en: 'The interface frame and figure titles change language. The methodological text inside each figure, the ' +
        'plain-language readings and the caveats remain in Portuguese — translating them badly would be worse than ' +
        'leaving them in the original language.'
    }
  };
}
