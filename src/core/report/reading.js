/* report/reading.js — leituras em linguagem clínica a partir das métricas.

   O QUE FAZ. Converte as linhas de `extractMetrics` (agudas e crônicas) e o
   painel de QC em frases que um médico lê sem decodificar notação. Uma leitura
   por domínio, por hemisfério quando fizer sentido.

   REGRAS QUE ESTE MÓDULO NÃO PODE QUEBRAR — são as mesmas do contrato do
   projeto, só que aqui em prosa:
     • toda frase que depende de escolha de parâmetro CITA o parâmetro
       (percentil de burst, banda, limiar, fonte do espectro);
     • toda frase que depende de qualidade de dado CITA o indicador (n de dias,
       p corrigido, R² do ajuste, % de dados usados);
     • "não é possível determinar com este dado" é uma saída legítima e
       preferível a um número frágil;
     • nada aqui sugere diagnóstico, prognóstico ou substituição do software
       regulado do fabricante. As frases descrevem CORRELATOS de sinal.

   Saída de cada leitura:
     { id, titulo, frase, numeros, parametro, ressalva, nivel, figura }
   `nivel` ∈ 'ok' | 'atencao' | 'insuficiente' — governa a cor na interface e o
   ícone no relatório, nunca o conteúdo da frase.                             */

import { getProfile } from '../profiles/index.js';

const HEMI_PT = { Left: 'esquerdo', Right: 'direito' };
const ladoDe = h => HEMI_PT[h] || h;
const n1 = v => isFinite(v) ? (+v).toFixed(1).replace('.', ',') : '—';
const n2 = v => isFinite(v) ? (+v).toFixed(2).replace('.', ',') : '—';
const pTexto = p => !isFinite(p) ? '—' : p < 0.001 ? 'p < 0,001' : 'p = ' + p.toFixed(3).replace('.', ',');
const hora = h => isFinite(h) ? `${String(Math.floor(h)).padStart(2, '0')}h${String(Math.round((h % 1) * 60)).padStart(2, '0')}` : '—';

const leitura = (id, titulo, frase, opts) => Object.assign({
  id, titulo, frase, numeros: '', parametro: '', ressalva: '', nivel: 'ok', figura: ''
}, opts || {});

/* ---------------------------------------------------------------- espectro */
function leiaPico(row, perfil) {
  const alvo = row.target ? ` (${row.target})` : '';
  const lado = `alvo ${ladoDe(row.hemisphere)}${alvo}`;
  const pb = perfil.primaryBand;
  const base = {
    figura: 'F1',
    parametro: `banda ${pb.label} ${pb.lo}–${pb.hi} Hz · fonte do espectro: ${row.spectrum_source || '—'} · ` +
      `pico definido após remoção do fundo aperiódico`
  };
  if (!row.primary_peak_hz && !isFinite(row.primary_peak_hz))
    return leitura('pico', `Pico ${pb.label} — ${lado}`,
      'Não há espectro utilizável deste lado nesta sessão, então não é possível dizer se existe pico.',
      Object.assign({ nivel: 'insuficiente', ressalva: 'Capturar BrainSense Survey bilateral com estimulação desligada.' }, base));

  if (!row.has_beta_peak && !row.has_theta_alpha_peak && !isFinite(row.primary_peak_hz))
    return leitura('pico', `Pico ${pb.label} — ${lado}`,
      `Nenhuma oscilação em ${pb.label} se destaca do fundo do espectro deste lado.`,
      Object.assign({
        nivel: 'atencao',
        numeros: `nenhum pico destacado entre ${pb.lo} e ${pb.hi} Hz`,
        ressalva: 'Ausência de pico é achado comum e não indica falha do registro: no ADAPT-PD ' +
          '84,8% dos hemisférios tinham pico beta (64,2% bilateral). Sem pico, o DBS adaptativo ' +
          'guiado por essa banda não é programável neste lado.'
      }, base));

  const forte = isFinite(row.beta_rel_pct) ? row.beta_rel_pct : row.theta_alpha_rel_pct;
  return leitura('pico', `Pico ${pb.label} — ${lado}`,
    `${perfil.glossary.intuicao} Neste lado o pico está em ${n1(row.primary_peak_hz)} Hz` +
    (isFinite(forte) ? `, respondendo por ${n1(forte)}% da potência do espectro.` : '.'),
    Object.assign({
      nivel: 'ok',
      numeros: `pico em ${n1(row.primary_peak_hz)} Hz` + (isFinite(forte) ? ` · ${n1(forte)}% da potência` : ''),
      ressalva: row.device_artifact
        ? 'Este espectro traz sinalização de artefato do próprio dispositivo — interprete com reserva.'
        : 'É um correlato de sinal, não uma medida de sintoma. A frequência do pico é usada para escolher a banda de sensing.'
    }, base));
}

function leiaAperiodico(row) {
  if (!isFinite(row.aperiodic_exponent))
    return leitura('aperiodico', 'Fundo aperiódico',
      'Não foi possível ajustar o componente aperiódico com este espectro.',
      { nivel: 'insuficiente', figura: 'F1' });
  const r2 = isFinite(row.aperiodic_r2) ? row.aperiodic_r2 : NaN;
  return leitura('aperiodico', `Fundo aperiódico — alvo ${ladoDe(row.hemisphere)}`,
    'Além dos picos, o espectro tem um fundo que decai com a frequência. A inclinação desse fundo ' +
    'reflete o balanço entre excitação e inibição da rede e muda com estimulação e com medicação. ' +
    'Serve de apoio, nunca isolada.',
    {
      numeros: `inclinação (χ) = ${n2(row.aperiodic_exponent)}` + (isFinite(r2) ? ` · R² do ajuste = ${n2(r2)}` : ''),
      parametro: 'ajuste entre 2 e 95 Hz, aproximação do specparam/FOOOF',
      nivel: isFinite(r2) && r2 < 0.8 ? 'atencao' : 'ok',
      ressalva: (isFinite(r2) && r2 < 0.8
        ? `O ajuste explicou pouco do espectro (R² = ${n2(r2)}); trate este número como indicativo. `
        : '') + 'A decomposição completa entre a parte oscilatória e o fundo está na figura F2, no modo pesquisa.',
      /* fica junto do espectro (F1): é a mesma leitura, vista por outro ângulo */
      figura: 'F1'
    });
}

function leiaBursts(row) {
  if (!isFinite(row.burst_rate_hz))
    return leitura('bursts', 'Rajadas (bursts)',
      'Não há sinal bruto suficiente deste lado para medir rajadas.',
      { nivel: 'insuficiente', figura: 'F6', ressalva: 'Capturar BrainSense Streaming de pelo menos 60 s em repouso.' });
  const dur = row.burst_mean_ms;
  const banda = row.burst_band_hz ? String(row.burst_band_hz).replace('-', '–') + ' Hz' : 'banda primária';
  return leitura('bursts', `Rajadas de ${banda} — alvo ${ladoDe(row.hemisphere)}`,
    'A oscilação não é contínua: ela vem em rajadas. Rajadas mais longas e mais frequentes acompanham ' +
    'mais rigidez e lentidão, e são o alvo do DBS adaptativo de limiar único — o aparelho sobe a ' +
    'corrente justamente durante elas.',
    {
      numeros: `${n2(row.burst_rate_hz)} rajadas por segundo · duração média ${n1(dur)} ms · ` +
        `${n1(row.burst_prob_pct)}% do tempo em rajada`,
      parametro: `limiar no percentil ${row.burst_percentile} do envelope de Hilbert · banda ${banda} · ` +
        `duração mínima 100 ms`,
      nivel: 'ok',
      ressalva: 'O percentil do limiar é uma escolha, não uma constante da natureza: mudá-lo muda a ' +
        'duração média. Registre o percentil usado em qualquer comparação entre pacientes ou entre visitas.',
      figura: 'F6'
    });
}

/* ---------------------------------------------------------------- crônicas */
function leiaCircadiano(row) {
  const lado = `alvo ${ladoDe(row.hemisphere)}`;
  if (!isFinite(row.mesor))
    return leitura('circadiano', `Ritmo de 24 h — ${lado}`,
      'Não há Timeline suficiente deste lado para descrever o ritmo de 24 horas.',
      { nivel: 'insuficiente', figura: 'F9', ressalva: 'Habilitar o BrainSense Timeline nos dois hemisférios e aguardar ao menos 5 dias.' });

  const relativo = isFinite(row.amp_24h) && row.mesor ? 100 * row.amp_24h / row.mesor : NaN;
  const significativo = isFinite(row.cosinor_p_adj_ar1) && row.cosinor_p_adj_ar1 < 0.05;
  const estavel = isFinite(row.rayleigh_p) && row.rayleigh_p < 0.05;
  const poucos = row.n_days < 5;

  let frase = 'O nível do marcador muda ao longo do dia. ';
  if (significativo && estavel)
    frase += `Aqui esse ciclo existe e se repete: o pico acontece por volta de ${hora(row.acrophase_24h)}, ` +
      `e o horário do pico é consistente entre os dias registrados.`;
  else if (significativo)
    frase += `Aqui há um ciclo de 24 h, com pico por volta de ${hora(row.acrophase_24h)}, mas o horário do pico ` +
      `varia entre os dias — o ritmo é real e pouco regular.`;
  else
    frase += 'Neste registro o ciclo de 24 h não se separa do ruído. Isso pode significar ausência de ritmo ' +
      'ou apenas poucos dias de dado.';

  return leitura('circadiano', `Ritmo de 24 h — ${lado}`, frase, {
    numeros: `nível médio (MESOR) ${n2(row.mesor)} · variação dia↔noite ${n2(row.amp_24h)}` +
      (isFinite(relativo) ? ` (${n1(relativo)}% do nível médio)` : '') +
      ` · pico às ${hora(row.acrophase_24h)} · ${row.n_days} dias, ${row.n_points} pontos`,
    parametro: `cosinor com harmônicos de 24 e 12 h · ${pTexto(row.cosinor_p_adj_ar1)} corrigido para ` +
      `autocorrelação AR(1) (ρ = ${n2(row.rho_ar1)}) · Rayleigh das acrofases diárias ${pTexto(row.rayleigh_p)}`,
    nivel: poucos ? 'atencao' : significativo ? 'ok' : 'atencao',
    ressalva: (poucos ? `Apenas ${row.n_days} dia(s) de registro — o ADAPT-START usou 5 dias e sugere que 3 possam bastar. ` : '') +
      'O p usado é o corrigido para autocorrelação: amostras a cada 10 min não são independentes, e o p bruto ' +
      'exageraria a significância. Artefato de movimento pode produzir padrão pseudo-diurno.',
    figura: 'F9'
  });
}

function leiaLimiares(row) {
  const lado = `alvo ${ladoDe(row.hemisphere)}`;
  if (!isFinite(row.pct_below))
    return leitura('limiares', `Tempo em cada faixa de limiar — ${lado}`,
      'Não há limiares de aDBS registrados no arquivo nem Timeline suficiente para estimar como o tempo se distribui.',
      { nivel: 'insuficiente', figura: 'F11' });
  const concentrado = Math.max(row.pct_below, row.pct_between, row.pct_above) > 90;
  return leitura('limiares', `Tempo em cada faixa de limiar — ${lado}`,
    'Se o DBS adaptativo for programado com estes limiares, esta é a fração do tempo que o aparelho passaria ' +
    'em corrente baixa, em rampa e em corrente alta. Quando quase todo o tempo cai numa única faixa, o aparelho ' +
    'praticamente não modula — o adaptativo vira contínuo.',
    {
      numeros: `abaixo do limiar inferior ${n1(row.pct_below)}% · entre os limiares ${n1(row.pct_between)}% · ` +
        `acima do limiar superior ${n1(row.pct_above)}%`,
      parametro: `limiares ${row.thr_source === 'device' ? 'lidos do dispositivo' : 'estimados dos percentis do próprio paciente'}` +
        (isFinite(row.thr_lower) ? ` (${n2(row.thr_lower)} / ${n2(row.thr_upper)})` : ''),
      nivel: concentrado ? 'atencao' : 'ok',
      ressalva: concentrado
        ? 'Mais de 90% do tempo numa única faixa: com estes limiares o adaptativo modularia muito pouco.'
        : 'Estes percentuais descrevem o registro domiciliar disponível, não o comportamento futuro do aparelho.',
      figura: 'F11'
    });
}

function leiaEstados(row) {
  const lado = `alvo ${ladoDe(row.hemisphere)}`;
  if (!isFinite(row.off_pct))
    return leitura('estados', `Estados de beta alto e baixo — ${lado}`,
      'Não foi possível separar dois estados de beta neste registro.',
      { nivel: 'insuficiente', figura: 'F13' });
  const bimodal = isFinite(row.beta_bimodality) && row.beta_bimodality > 0.555;
  return leitura('estados', `Estados de beta alto e baixo — ${lado}`,
    'O registro é dividido automaticamente em períodos de beta baixo e beta alto. O beta alto costuma ' +
    'acompanhar o fim do efeito da medicação; o beta baixo, o período em que ela está agindo. ' +
    (bimodal
      ? 'Aqui os dois estados são de fato distinguíveis: a distribuição tem dois patamares.'
      : 'Aqui a distribuição é praticamente unimodal — a divisão é uma linha de corte descritiva, não dois estados separados.'),
    {
      numeros: `${n1(row.off_pct)}% do registro em beta alto · ${row.n_off_episodes} episódio(s) · ` +
        `duração média ${n1(row.mean_off_min)} min em beta alto e ${n1(row.mean_on_min)} min em beta baixo`,
      parametro: `limiar por separação de dois patamares · coeficiente de bimodalidade de Sarle = ${n2(row.beta_bimodality)} ` +
        `(> 0,555 indica bimodalidade)`,
      nivel: bimodal ? 'ok' : 'atencao',
      ressalva: 'É um correlato de sinal, não uma medida do estado clínico: artefato de movimento e mudanças ' +
        'de postura elevam o beta e podem simular um período OFF. Confronte com o diário do paciente.',
      figura: 'F13'
    });
}

/* ---------------------------------------------- semáforo de qualidade (QC) */
/* Reduz o painel completo do QC a UMA cor e UMA frase, sem esconder o que não
   foi verificável — o número de itens cinza entra na frase. */
export function qcTrafficLight(painel) {
  if (!painel || !painel.summary || !painel.summary.nItems)
    return { cor: 'cinza', rotulo: 'sem dados para verificar',
      frase: 'Nenhuma modalidade carregada permite verificar a qualidade do sinal.',
      bloqueios: [], naoVerificaveis: 0 };
  const s = painel.summary;
  const bloqueios = [];
  (painel.rows || []).forEach(l => (l.items || []).forEach(i => {
    if (i.cor === 'vermelho') bloqueios.push(`${l.hemisphere ? ladoDe(l.hemisphere) + ': ' : ''}${i.rotulo} — ${i.valor}`);
  }));
  const cor = s.vermelho > 0 ? 'vermelho' : s.amarelo > 0 ? 'amarelo' : 'verde';
  const rotulo = cor === 'vermelho' ? 'revisar antes de usar'
    : cor === 'amarelo' ? 'utilizável com ressalvas' : 'sem problema detectado';
  const cauda = s.cinza
    ? ` ${s.cinza} de ${s.nItems} itens não são verificáveis com este dado (${n1(s.pctVerificado)}% verificável) — ` +
      `isso não é aprovação, é ausência de informação.`
    : '';
  const frase = cor === 'vermelho'
    ? `Há ${s.vermelho} problema(s) de qualidade que afetam a leitura das figuras.${cauda}`
    : cor === 'amarelo'
      ? `Nenhum problema grave; ${s.amarelo} item(ns) passaram com ressalva.${cauda}`
      : `Todos os itens verificáveis passaram.${cauda}`;
  return { cor, rotulo, frase, bloqueios: bloqueios.slice(0, 6), naoVerificaveis: s.cinza, resumo: s };
}

/* ------------------------------------------------------------------ fachada */
/* clinicalReadings(bundle, opts) — `bundle` é a saída de extractMetrics.
   opts: { profileId, qcPanel }                                               */
/* ------------------------------------------------------ ODR (Onda 12) ---- */

/* odrReading(odr) — leitura em linguagem clínica da série de ODR.

   Não entra em `clinicalReadings` porque não vem do bundle de métricas: vem
   direto da figura, que é onde o ODR é calculado. A assinatura é a mesma das
   demais (frase, números, parâmetro, ressalva, nível) para que o relatório
   possa tratá-la sem caso especial.                                         */
export function odrReading(odr) {
  const base = { id: 'odr', figura: 'F34' };
  if (!odr || !odr.ok) return leitura('odr', 'ODR — dinâmica multi-banda',
    'O ODR não pôde ser calculado neste registro.',
    Object.assign({
      nivel: 'insuficiente',
      numeros: (odr && odr.reason) ? String(odr.reason).slice(0, 220) : 'sem sinal bruto no domínio do tempo',
      ressalva: 'Recusar o cálculo é o resultado correto quando o numerador mediria a resposta da rede à própria ' +
        'estimulação, ou quando não há pico individual de gama. Um número aqui seria pior do que nenhum.'
    }, base));

  const s = (odr.windows || []).map(w => w.odrLog).filter(isFinite);
  const inc = odr.trendPerWindow || {};
  const nJan = s.length;
  const primeiroTerco = s.slice(0, Math.max(1, Math.floor(nJan / 3)));
  const ultimoTerco = s.slice(-Math.max(1, Math.floor(nJan / 3)));
  const md = v => v.reduce((a, b) => a + b, 0) / v.length;
  const delta = md(ultimoTerco) - md(primeiroTerco);
  /* "subiu" precisa de um limiar declarado, senão qualquer flutuação vira
     movimento. Meio desvio-padrão do próprio ODR do registro é o critério. */
  const dp = Math.sqrt(odrVar(s));
  const limiar = 0.5 * dp;
  const subiu = delta > limiar, caiu = delta < -limiar;

  const lado = odr.nHemispheres === 1 ? ' (um hemisfério só)' : ' (média dos dois hemisférios)';
  return leitura('odr', 'ODR — dinâmica multi-banda',
    'O ODR combina três ritmos num único número: sobe quando o teta e a gama sobem e quando o beta cai — o padrão ' +
    'descrito nos períodos de discinesia. Aqui ele ' +
    (subiu ? 'subiu' : caiu ? 'caiu' : 'não se moveu') + ' ao longo do registro' + lado + '.',
    Object.assign({
      nivel: 'ok',
      numeros: `${nJan} janela(s) de ${odr.params.windowS} s · primeiro terço ${n2(md(primeiroTerco))}, ` +
        `último terço ${n2(md(ultimoTerco))} (Δ ${n2(delta)}, critério de movimento ${n2(limiar)} = 0,5 DP)` +
        (isFinite(inc.slope) ? ` · inclinação ${n2(inc.slope)} por janela` : ''),
      parametro: `formulação ${odr.formulationUsed === 'literal' ? 'literal do artigo' : 'logarítmica'} · ` +
        `θ 4–8 Hz, β↓ 12–20 Hz, γ ${odr.params.gammaSource === 'broad' ? 'banda larga 60–90 Hz' : 'pico individual ± 2,5 Hz'} · ` +
        `z-score ao longo do registro inteiro · Spearman entre as duas formulações ${odr.spearmanLogVsLiteral}`,
      ressalva: 'É um marcador exploratório: no estudo que o propôs, ele acertou a presença de discinesia em pouco ' +
        'mais de metade dos casos — acurácia balanceada de 0,61 (DP 0,14), com detecção significativa em 8 de 21 ' +
        'sujeitos — e em condições melhores que as deste registro, com decomposição espectro-espacial para otimizar ' +
        'a razão sinal-ruído, estimulação desligada e rótulo clínico validado por vídeo. Aqui não há rótulo clínico ' +
        'nenhum: esta leitura descreve o que a série fez, não afirma que houve discinesia.' +
        (odr.unilateralWarning ? ' ' + odr.unilateralWarning + '.' : '')
    }, base));
}

/* variância populacional local, para não depender de import extra */
function odrVar(v) {
  if (v.length < 2) return 0;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return v.reduce((a, x) => a + (x - m) * (x - m), 0) / v.length;
}

export function clinicalReadings(bundle, opts) {
  opts = opts || {};
  if (!bundle) return null;
  const perfil = getProfile(opts.profileId || (bundle.subject && bundle.subject.profile_id) || 'pd');
  const leituras = [];

  /* agudas: uma linha por sessão × hemisfério — usa a sessão MAIS RECENTE de
     cada hemisfério, que é a que responde "como está hoje" */
  const porHemiAgudo = {};
  (bundle.acute || []).forEach(r => {
    const atual = porHemiAgudo[r.hemisphere];
    if (!atual || String(r.session_date_local || '') >= String(atual.session_date_local || '')) porHemiAgudo[r.hemisphere] = r;
  });
  Object.keys(porHemiAgudo).sort().forEach(h => {
    const r = porHemiAgudo[h];
    leituras.push(leiaPico(r, perfil));
    leituras.push(leiaAperiodico(r));
    leituras.push(leiaBursts(r));
  });

  (bundle.chronic || []).slice().sort((a, b) => String(a.hemisphere).localeCompare(String(b.hemisphere))).forEach(r => {
    leituras.push(leiaCircadiano(r));
    leituras.push(leiaLimiares(r));
    leituras.push(leiaEstados(r));
  });

  const semaforo = qcTrafficLight(opts.qcPanel);

  return {
    profile: perfil.id, profileLabel: perfil.label,
    subjectId: bundle.subject ? bundle.subject.id : null,
    semaforo, readings: leituras,
    nInsuficientes: leituras.filter(l => l.nivel === 'insuficiente').length,
    disclaimer: 'Estas leituras descrevem correlatos de sinal medidos no registro carregado. ' +
      'São apoio à decisão e material de pesquisa — não substituem o julgamento clínico nem o ' +
      'software regulado do fabricante, e não constituem diagnóstico.'
  };
}
