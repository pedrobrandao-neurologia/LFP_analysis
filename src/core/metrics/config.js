/* metrics/config.js — mudança de configuração de sensing e segmentação do crônico.

   POR QUE ESTE MÓDULO EXISTE. O confundidor número um do registro crônico do
   Percept não é ruído, nem artefato, nem perda de pacote: é a REPROGRAMAÇÃO
   ENTRE CONSULTAS. O BrainSense Timeline devolve um número por intervalo,
   sempre com o mesmo nome ("LFP") e sempre na mesma unidade aparente. Mas esse
   número é a potência integrada numa banda estreita em torno de uma frequência
   central escolhida pelo programador, medida num par bipolar de contatos também
   escolhido pelo programador. Troque o par bipolar e a série passa a medir a
   diferença de potencial sobre outro volume de tecido, com outra impedância e
   outro acoplamento à fonte. Troque a frequência central e a série passa a
   integrar outra faixa do espectro. Nos dois casos o gráfico continua liso,
   contínuo e bonito — e passou a mostrar duas variáveis diferentes coladas uma
   na outra. Nada no arquivo, nada no eixo e nada na curva denuncia a troca.

   Traçar uma linha, ajustar uma tendência ou calcular uma variação percentual
   atravessando essa descontinuidade é erro de inferência, não de estética. É o
   equivalente a somar temperatura em Celsius com temperatura em Fahrenheit
   porque as duas colunas se chamavam "temp".

   O QUE ESTE MÓDULO FAZ. Lê a configuração declarada em cada arquivo, compara
   sessões consecutivas campo a campo com tolerância explícita, e parte a série
   crônica em BLOCOS de configuração comparável. Cada mudança detectada sai
   classificada por gravidade:
     • 'quebra'      — impede comparar a série (par bipolar, frequência central,
                       largura de banda). Divide blocos.
     • 'covariável'  — altera a magnitude mas permite comparar declarando o
                       ajuste (amplitude, grupo, frequência e largura de pulso
                       de estimulação). NÃO divide blocos.
     • 'informativa' — não altera a leitura da série de potência (limiares de
                       LFP), embora possa invalidar métricas derivadas dela.
   e com uma frase em pt-BR dizendo exatamente o que aquela mudança impede.

   O QUE ESTE MÓDULO NÃO FAZ. Não conserta nada. Não reescala, não normaliza e
   não "harmoniza" blocos incomparáveis — não existe fator de conversão entre
   potência medida em 1-3 e potência medida em 0-2, e inventar um seria pior do
   que não comparar. A saída honesta de um dado que mudou de configuração é
   dizer que ele mudou.

   DUAS DECISÕES QUE FICAM EXPOSTAS AO USUÁRIO, PORQUE SÃO CONTROVERSAS:

   1) ATRIBUIÇÃO TEMPORAL. O JSON guarda o estado Initial e o Final da sessão; o
      parser deste projeto retém o Final, isto é, a configuração DEPOIS de
      qualquer reprogramação feita na consulta. Só que o Timeline que veio nesse
      mesmo arquivo foi registrado ANTES da consulta. Existem portanto duas
      convenções defensáveis, e a literatura não fixou nenhuma:
        'retrospectiva' (padrão) — a configuração lida na sessão k descreve os
            dados que chegaram com a sessão k, isto é, o intervalo
            (T[k-1], T[k]]. É a convenção que mantém cada Timeline junto do
            arquivo que o trouxe, e a única que funciona com um arquivo só.
        'prospectiva' — a configuração lida na sessão k governa daí para a
            frente, [T[k], T[k+1]). É a convenção fiel ao fato de o parser ler o
            estado Final; em compensação, joga todo o Timeline anterior à
            primeira sessão para fora de qualquer bloco conhecido.
      A escolha é registrada em `attribution` e a ressalva vai em `caveat`.

   2) LARGURA DA BANDA DE POTÊNCIA. O JSON declara a frequência central e NÃO
      declara a largura da banda integrada. Este módulo assume ±2,5 Hz (5 Hz de
      largura), que é o descrito para o canal de potência do Percept. A largura
      assumida é exportada em `bandwidthHz` com `bandwidthSource: 'assumida'`, e
      a consequência está dita em `caveat`: uma mudança REAL de largura de banda
      não é detectável a partir deste arquivo.

   UNIDADES. Frequência central, largura de banda e frequência de estimulação em
   Hz; largura de pulso em µs; amplitude em mA; limiares na unidade adimensional
   de LFP do próprio dispositivo; tempos em epoch ms; durações em dias.

   Referências:
     Thenaisie Y, et al. J Neural Eng 2021;18:042002 — cadeia de sensing do
       Percept PC, canal de potência e o significado dos campos do JSON.
     Swinnen BEKS, et al. J Neural Eng 2025;22:014001 — checklist de reporte de
       sensing crônico: exigência de declarar canal, frequência central e
       parâmetros de estimulação em toda comparação longitudinal.
     van Rheede JJ, et al. npj Parkinsons Dis 2022;8:88 — uso do Timeline em
       janela longa e os cuidados com descontinuidade de configuração.        */

import { prettyChannel, localDayKey, T } from '../io/parse.js';

/* ------------------------------------------------------------------------- */
/*  Constantes e utilitários locais (prefixo cfg* para não colidir no bundle)  */
/* ------------------------------------------------------------------------- */

const CFG_HEMIS = ['Left', 'Right'];
const CFG_HEMI_PT = { Left: 'esquerdo', Right: 'direito', Ambos: 'ambos os hemisférios' };
const CFG_HEMI_SIGLA = { Left: 'E', Right: 'D', Ambos: 'E+D' };
const CFG_DAY_MS = 86400000;

/* Meia-largura assumida da banda de potência do Timeline, em Hz.
   O JSON não declara a largura; ver cabeçalho. */
const CFG_BAND_HALFWIDTH_HZ = 2.5;
const CFG_BAND_SOURCE = 'assumida — o JSON do Percept declara a frequência central e não a largura da banda integrada';

/* Tolerâncias de comparação, TODAS explícitas e todas exportadas no resultado.
   Comparar ponto flutuante com === produziria "mudança" a cada arredondamento
   do programador; comparar com tolerância frouxa demais esconderia mudança
   real. Os valores abaixo são um compromisso declarado, não uma verdade. */
const CFG_TOL = {
  centerFreqHz: 0.01,   // frequência central do canal de potência
  bandwidthHz: 0.01,    // largura da banda de potência
  rateHz: 0.1,          // frequência de estimulação
  pulseWidthUs: 1,      // largura de pulso
  amplitudeMa: 0.05,    // amplitude de estimulação
  thresholdUnits: 0.5   // limiares de LFP (unidade do dispositivo)
};

const CFG_TOL_UNIT = {
  centerFreq: 'Hz', bandwidth: 'Hz', rate: 'Hz',
  pulseWidth: 'µs', amplitude: 'mA', thresholds: 'unidades de LFP'
};

const cfgN1 = v => isFinite(v) ? (+v).toFixed(1).replace('.', ',') : '—';
const cfgN2 = v => isFinite(v) ? (+v).toFixed(2).replace('.', ',') : '—';
const cfgLado = h => CFG_HEMI_PT[h] || h;

/* isFinite(null) é TRUE em JavaScript (null vira 0 na coerção). Como aqui null
   significa "extremo aberto do intervalo", usar isFinite direto transformaria
   um bloco aberto em um bloco que começa na época zero. */
const cfgFin = v => v !== null && v !== undefined && typeof v !== 'boolean' && isFinite(v);

/* Máximo/mínimo por laço: Math.max.apply estoura a pilha com séries longas
   (um Timeline de 60 dias a cada 10 min já passa de 8 mil pontos por arquivo). */
function cfgRange(valores) {
  let lo = Infinity, hi = -Infinity, n = 0;
  for (let i = 0; i < valores.length; i++) {
    const v = valores[i];
    if (!isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    n++;
  }
  return n ? { min: lo, max: hi, n } : { min: NaN, max: NaN, n: 0 };
}

/* Chave canônica do par bipolar de sensing.

   Necessária porque o MESMO par aparece com nomes diferentes conforme a origem:
   `SensingElectrodeConfigDef.ONE_AND_THREE` nos grupos e
   `SensingChannelDef.ONE_THREE_LEFT` no TherapySnapshot do streaming.
   `prettyChannel` já resolve a maior parte ('1-3' e '13'); aqui a pontuação é
   removida para que as duas grafias colidam na mesma chave.                  */
function cfgChannelKey(canal) {
  if (!canal) return '';
  return String(prettyChannel(canal)).replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

/* Rótulo legível e ESTÁVEL do par bipolar.

   `prettyChannel` devolve grafias diferentes para o mesmo par conforme a origem
   ('1-3' vindo dos grupos, '13' vindo do TherapySnapshot). Exibir as duas lado a
   lado numa mesma legenda faria o leitor suspeitar de uma diferença que não
   existe — exatamente o oposto do que este módulo se propõe a fazer. Aqui os
   contatos são separados em tokens ([0-3] com segmento a/b/c opcional) e
   reunidos com hífen; se a grafia não for reconhecida, o texto original é
   preservado sem invenção.                                                    */
function cfgChannelLabel(canal) {
  if (!canal) return '';
  const bruto = String(prettyChannel(canal));
  const chave = cfgChannelKey(canal);
  const tokens = chave.match(/[0-3][ABC]?/g);
  if (!tokens || tokens.join('') !== chave) return bruto;
  return tokens.map(x => x.toLowerCase()).join('-');
}

/* Fontes possíveis da configuração de UM hemisfério, em ordem de autoridade.

   1º TherapySnapshot do BrainSense Streaming — é o registro do que o aparelho
      estava efetivamente usando para produzir a série de potência;
   2º canal de sensing do GRUPO ATIVO — a programação vigente;
   3º SensingSetup / Signal Test do mesmo grupo — presente mesmo sem streaming.
   Grupos INATIVOS são deliberadamente ignorados: a configuração de um grupo que
   não estava em uso não descreve o dado que foi registrado.                  */
function cfgCandidates(p, hemi, grupoAtivo) {
  const lista = [];
  (p.bsLfp || []).forEach(b => {
    const h = b && b.therapy && b.therapy.perHemi ? b.therapy.perHemi[hemi] : null;
    if (h) lista.push({ src: 'BrainSenseLfp.TherapySnapshot', rec: h });
  });
  (p.groups || []).forEach(g => {
    if (!g || !g.active) return;
    (g.sensing || []).forEach(s => {
      if (s && s.hemisphere === hemi) lista.push({ src: `grupo ativo ${g.id || '?'} — SensingChannel`, rec: s });
    });
  });
  (p.sensingSetup || []).forEach(s => {
    if (!s || s.hemisphere !== hemi) return;
    if (grupoAtivo && s.groupId && s.groupId !== grupoAtivo) return;
    lista.push({ src: 'SensingSetup (Signal Test)' + (s.groupId ? ` do grupo ${s.groupId}` : ''), rec: s });
  });
  return lista;
}

/* Amplitude de estimulação do hemisfério, em mA.

   Fonte preferida: os programas do grupo ativo. Quando o grupo tem mais de um
   programa no mesmo hemisfério, as correntes são entregues simultaneamente e o
   que interessa como covariável é a SOMA — mas `nPrograms` sai junto para que
   quem lê saiba que houve soma, e não uma leitura única.                     */
function cfgAmplitude(p, hemi, candidatos) {
  const ativo = (p.groups || []).filter(g => g && g.active)[0];
  if (ativo) {
    const progs = (ativo.programs || []).filter(pr => pr && pr.hemisphere === hemi && isFinite(pr.amplitude));
    if (progs.length) {
      const soma = progs.reduce((a, pr) => a + pr.amplitude, 0);
      return {
        value: +soma.toFixed(3), nPrograms: progs.length,
        source: progs.length > 1
          ? `soma das amplitudes dos ${progs.length} programas do grupo ativo (entrega simultânea)`
          : `amplitude do programa do grupo ativo ${ativo.id || '?'}`
      };
    }
  }
  for (let i = 0; i < candidatos.length; i++) {
    const v = candidatos[i].rec.amplitude;
    if (typeof v === 'number' && isFinite(v) && v > 0)
      return { value: +v.toFixed(3), nPrograms: NaN, source: candidatos[i].src + ' (soma por eletrodo do canal de sensing)' };
  }
  return { value: NaN, nPrograms: NaN, source: '' };
}

/* Configuração de um hemisfério. Campo não declarado no arquivo sai NaN (ou ''
   para texto) e a origem de cada campo fica registrada em `sources` — nada é
   preenchido por suposição, exceto a largura de banda, que é declarada como
   suposição em `bandwidthSource`.                                            */
function cfgHemiConfig(p, hemi, grupoAtivo) {
  const cands = cfgCandidates(p, hemi, grupoAtivo);
  const fontes = {};
  const pega = (campo, texto) => {
    for (let i = 0; i < cands.length; i++) {
      const v = cands[i].rec[campo];
      const vale = texto ? (v != null && String(v) !== '') : (typeof v === 'number' && isFinite(v));
      if (vale) { fontes[campo] = cands[i].src; return v; }
    }
    return texto ? '' : NaN;
  };

  const canalBruto = pega('channel', true);
  const centro = pega('centerFreq', false);
  const lo = pega('lowerThr', false);
  const hi = pega('upperThr', false);
  const rate = pega('rate', false);
  const pw = pega('pulseWidth', false);
  const amp = cfgAmplitude(p, hemi, cands);

  return {
    channel: cfgChannelLabel(canalBruto),
    channelRaw: canalBruto || '',
    channelKey: cfgChannelKey(canalBruto),
    centerFreq: centro,
    bandLo: isFinite(centro) ? +(centro - CFG_BAND_HALFWIDTH_HZ).toFixed(3) : NaN,
    bandHi: isFinite(centro) ? +(centro + CFG_BAND_HALFWIDTH_HZ).toFixed(3) : NaN,
    bandwidthHz: isFinite(centro) ? 2 * CFG_BAND_HALFWIDTH_HZ : NaN,
    bandwidthSource: CFG_BAND_SOURCE,
    rate, pulseWidth: pw,
    amplitude: amp.value, nPrograms: amp.nPrograms,
    thresholds: [lo, hi],
    /* "declarado" = o arquivo diz ao menos QUAL canal ou QUAL frequência central.
       Sem nenhum dos dois não há o que comparar neste hemisfério. */
    declared: !!canalBruto || isFinite(centro),
    nSources: cands.length,
    sources: Object.assign({ amplitude: amp.source }, fontes)
  };
}

/* Rótulo curto de uma configuração, para legenda de figura e para as mensagens. */
function cfgSummaryText(cfg) {
  const partes = CFG_HEMIS.filter(h => cfg.byHemisphere[h] && cfg.byHemisphere[h].declared).map(h => {
    const c = cfg.byHemisphere[h];
    return `${CFG_HEMI_SIGLA[h]} ${c.channel || 'canal não declarado'}` +
      (isFinite(c.centerFreq) ? ` @ ${cfgN2(c.centerFreq)} Hz` : ' @ frequência central não declarada');
  });
  return (partes.join(' | ') || 'configuração de sensing não declarada') + (cfg.group ? ` — grupo ${cfg.group}` : '');
}

/* Formatação de valor para as frases. */
function cfgShow(campo, v) {
  if (Array.isArray(v)) return '[' + v.map(x => isFinite(x) ? cfgN1(x) : '—').join('; ') + ']';
  if (typeof v === 'number') return isFinite(v) ? (campo === 'pulseWidth' ? String(Math.round(v)) : cfgN2(v)) : '—';
  return (v == null || v === '') ? '—' : String(v);
}

/* A frase que diz o que a mudança IMPEDE. É o produto principal deste módulo:
   o número que muda é fácil de ver; a consequência sobre o que se pode concluir
   é o que costuma passar batido.                                             */
function cfgConsequence(campo, de, para, hemi, tol) {
  const lado = cfgLado(hemi);
  const A = cfgShow(campo, de), B = cfgShow(campo, para);
  switch (campo) {
    case 'channel':
      return `o par bipolar de sensing do hemisfério ${lado} passou de ${A} para ${B}. As duas séries medem diferença de ` +
        'potencial entre contatos diferentes, sobre volumes de tecido e impedâncias diferentes: apesar do mesmo nome e da ' +
        'mesma unidade, não são a mesma variável. Não ligue os dois trechos por uma linha, não compare magnitude, não ' +
        'calcule variação percentual e não ajuste tendência atravessando esta data.';
    case 'centerFreq':
      return `a frequência central do canal de potência do hemisfério ${lado} passou de ${A} Hz para ${B} Hz ` +
        `(tolerância declarada: ${cfgN2(tol.centerFreqHz)} Hz). O Timeline integra a potência numa banda estreita em torno ` +
        'dessa frequência; com outro centro, a faixa integrada é outra e o valor muda mesmo sem nenhuma mudança neural. ' +
        'Os dois trechos não são comparáveis em magnitude.';
    case 'bandwidth':
      return `a largura da banda de potência do hemisfério ${lado} passou de ${A} Hz para ${B} Hz. A potência passa a ser ` +
        'integrada sobre uma faixa de largura diferente, o que altera a escala do valor independentemente do sinal.';
    case 'rate':
      return `a frequência de estimulação do hemisfério ${lado} passou de ${A} Hz para ${B} Hz. Isso desloca o artefato de ` +
        'estimulação e seus subarmônicos e pode mudar quanto artefato cai dentro da banda de sensing. A série continua ' +
        'sendo a mesma variável, mas comparar magnitude entre os dois períodos exige declarar esta mudança junto do resultado.';
    case 'pulseWidth':
      return `a largura de pulso do hemisfério ${lado} passou de ${A} µs para ${B} µs, o que altera a carga por pulso e a ` +
        'amplitude do artefato de estimulação que vaza para a banda de sensing. Comparação possível apenas com o ajuste declarado.';
    case 'amplitude':
      return `a amplitude de estimulação do hemisfério ${lado} passou de ${A} mA para ${B} mA. Amplitude muda ao mesmo tempo ` +
        'o efeito sobre a rede e o artefato registrado: uma queda de potência depois desta data pode ser efeito da ' +
        'estimulação, contaminação diferente, ou os dois. Comparação possível apenas declarando a mudança junto do resultado.';
    case 'group':
      return `o grupo de estimulação ativo passou de ${A} para ${B}. O grupo carrega contato ativo, amplitude, frequência e ` +
        'muitas vezes o próprio canal de sensing: trate os dois períodos como condições diferentes e declare o grupo em ' +
        'qualquer comparação.';
    case 'thresholds':
      return `os limiares de LFP do hemisfério ${lado} passaram de ${A} para ${B}. A série de potência em si continua ` +
        'comparável, mas todo número derivado de limiar — % acima, % abaixo, tempo em faixa, contagem de eventos e o ' +
        'comportamento da estimulação adaptativa — não é comparável entre os dois períodos.';
    default:
      return `o campo ${campo} do hemisfério ${lado} passou de ${A} para ${B}.`;
  }
}

/* ------------------------------------------------------------------------- */
/*  1. Configuração de UM arquivo                                             */
/* ------------------------------------------------------------------------- */

/* sensingConfigOf(parsed) — configuração de sensing declarada em um arquivo.

   Lê, por hemisfério, de bsLfp[].therapy.perHemi, dos grupos e do sensingSetup
   (ver cfgCandidates para a ordem de autoridade). Campo ausente sai NaN — nunca
   preenchido por herança de outro hemisfério ou de outro arquivo.

   Entrada: objeto de parsePercept. Saída: frequências em Hz, largura de pulso
   em µs, amplitude em mA, limiares na unidade de LFP do dispositivo, sessionT
   em epoch ms.                                                               */
export function sensingConfigOf(parsed) {
  const p = parsed || {};
  const iso = (p.meta && p.meta.sessionStart) || null;
  const sessionT = iso ? T(iso) : NaN;

  /* grupo ativo: primeiro pelos Groups, depois pelo TherapySnapshot */
  const ativos = (p.groups || []).filter(g => g && g.active);
  let group = ativos.length && ativos[0].id ? ativos[0].id : '';
  let groupSource = group ? 'Groups (ActiveGroup)' : '';
  if (!group) {
    const b = (p.bsLfp || []).filter(x => x && x.therapy && x.therapy.group)[0];
    if (b) { group = b.therapy.group; groupSource = 'BrainSenseLfp.TherapySnapshot.ActiveGroup'; }
  }

  const byHemisphere = {};
  CFG_HEMIS.forEach(h => { byHemisphere[h] = cfgHemiConfig(p, h, group); });
  const declarados = CFG_HEMIS.filter(h => byHemisphere[h].declared);

  const comum = {
    byHemisphere, group, groupSource, sessionT, sessionISO: iso,
    fileName: p.fileName || '(sem nome)',
    dated: isFinite(sessionT),
    hemispheresDeclared: declarados,
    bandwidthHz: 2 * CFG_BAND_HALFWIDTH_HZ,
    bandwidthSource: CFG_BAND_SOURCE
  };

  if (!declarados.length) return Object.assign({ ok: false }, comum, {
    reason: 'este arquivo não declara canal de sensing em nenhum hemisfério: não há TherapySnapshot de BrainSense ' +
      'Streaming, nenhum grupo ativo com canal de sensing e nenhum Signal Test. Sem isso não é possível saber sob qual ' +
      'configuração o Timeline deste arquivo foi registrado, e portanto não é possível verificar se ela mudou em ' +
      'relação às outras sessões.'
  });

  return Object.assign({ ok: true }, comum, {
    summary: cfgSummaryText({ byHemisphere, group }),
    reason: '',
    /* honestidade sobre a própria leitura: um hemisfério só declarado significa
       que o outro simplesmente não pode ser verificado, não que ele não mudou */
    note: declarados.length === CFG_HEMIS.length
      ? 'configuração declarada nos dois hemisférios'
      : `configuração declarada apenas no hemisfério ${cfgLado(declarados[0])}; no outro não há canal de sensing no ` +
        'arquivo, e mudanças nele não são verificáveis a partir desta sessão'
  });
}

/* ------------------------------------------------------------------------- */
/*  2. Comparação entre duas sessões                                          */
/* ------------------------------------------------------------------------- */

/* Diferenças entre duas configurações consecutivas.
   Devolve { changes, undeclared }. `undeclared` guarda os campos que NÃO foi
   possível comparar por falta de declaração — que não são "sem mudança", são
   "não verificável", e a diferença entre as duas coisas é todo o ponto.      */
function cfgDiffConfigs(a, b, tol, off) {
  const changes = [], undeclared = [];
  const t = b.sessionT;
  const dia = isFinite(t) ? localDayKey(t, off) : '';
  const base = { t, dayLocal: dia, fileFrom: a.fileName, fileTo: b.fileName };

  const anota = (hemi, campo, de, para, sev, tolValor) => changes.push(Object.assign({}, base, {
    hemisphere: hemi, field: campo, from: de, to: para, severity: sev,
    consequence: cfgConsequence(campo, de, para, hemi, tol),
    tolerance: tolValor == null ? null : tolValor,
    toleranceUnit: CFG_TOL_UNIT[campo] || ''
  }));
  const pendura = (hemi, campo, nota) => undeclared.push(Object.assign({}, base, {
    hemisphere: hemi, field: campo, note: nota
  }));

  /* nível do dispositivo: grupo de estimulação ativo */
  if (a.group && b.group) {
    if (a.group !== b.group) anota('Ambos', 'group', a.group, b.group, 'covariável', null);
  } else {
    pendura('Ambos', 'group', 'o grupo de estimulação ativo não está declarado em ao menos uma das duas sessões — ' +
      'não é possível verificar se houve troca de grupo entre elas');
  }

  CFG_HEMIS.forEach(h => {
    const A = a.byHemisphere[h], B = b.byHemisphere[h];
    if (!A.declared && !B.declared) return;                 // hemisfério sem sensing nas duas: nada a comparar
    if (!A.declared || !B.declared) {
      pendura(h, 'hemisfério', `o hemisfério ${cfgLado(h)} tem configuração de sensing declarada em apenas uma das duas ` +
        'sessões — não é possível verificar mudança; ausência de declaração não é ausência de mudança');
      return;
    }

    const compara = (campo, va, vb, tolValor, sev) => {
      if (!isFinite(va) || !isFinite(vb)) {
        pendura(h, campo, `${campo} não está declarado em ao menos uma das duas sessões no hemisfério ${cfgLado(h)} — ` +
          'não verificável');
        return;
      }
      if (Math.abs(va - vb) > tolValor) anota(h, campo, va, vb, sev, tolValor);
    };

    /* par bipolar — a quebra mais grave e a mais silenciosa */
    if (A.channelKey && B.channelKey) {
      if (A.channelKey !== B.channelKey) anota(h, 'channel', A.channel, B.channel, 'quebra', null);
    } else {
      pendura(h, 'channel', `o par bipolar de sensing do hemisfério ${cfgLado(h)} não está declarado em ao menos uma das ` +
        'duas sessões — não verificável');
    }

    compara('centerFreq', A.centerFreq, B.centerFreq, tol.centerFreqHz, 'quebra');
    compara('bandwidth', A.bandwidthHz, B.bandwidthHz, tol.bandwidthHz, 'quebra');
    compara('rate', A.rate, B.rate, tol.rateHz, 'covariável');
    compara('pulseWidth', A.pulseWidth, B.pulseWidth, tol.pulseWidthUs, 'covariável');
    compara('amplitude', A.amplitude, B.amplitude, tol.amplitudeMa, 'covariável');

    /* limiares: comparados como par, porque mudar só um já invalida as métricas
       derivadas dele */
    const ta = A.thresholds || [NaN, NaN], tb = B.thresholds || [NaN, NaN];
    if (ta.every(isFinite) && tb.every(isFinite)) {
      if (Math.abs(ta[0] - tb[0]) > tol.thresholdUnits || Math.abs(ta[1] - tb[1]) > tol.thresholdUnits)
        anota(h, 'thresholds', ta.slice(), tb.slice(), 'informativa', tol.thresholdUnits);
    } else {
      pendura(h, 'thresholds', `os limiares de LFP do hemisfério ${cfgLado(h)} não estão declarados em ao menos uma das ` +
        'duas sessões — não verificável');
    }
  });

  return { changes, undeclared };
}

/* ------------------------------------------------------------------------- */
/*  3. Blocos de configuração comparável                                      */
/* ------------------------------------------------------------------------- */

/* configBlocks(parsedList, offMin, opts) — parte o crônico em blocos comparáveis.

   opts:
     attribution   'retrospectiva' (padrão) | 'prospectiva' — ver cabeçalho
     tolerances    sobrescreve CFG_TOL campo a campo
     bandwidthHz   largura assumida da banda de potência (padrão 5 Hz)
     splitOn       gravidades que dividem bloco (padrão ['quebra'])

   Entrada: lista de objetos de parsePercept, em qualquer ordem; offMin em
   minutos de deslocamento UTC (só para os rótulos de dia local).             */
export function configBlocks(parsedList, offMin, opts) {
  opts = opts || {};
  const off = isFinite(offMin) ? offMin : 0;
  const tol = Object.assign({}, CFG_TOL, opts.tolerances || {});
  const larguraBanda = isFinite(opts.bandwidthHz) && opts.bandwidthHz > 0 ? opts.bandwidthHz : 2 * CFG_BAND_HALFWIDTH_HZ;
  const meiaBanda = larguraBanda / 2;
  const atribuicao = opts.attribution === 'prospectiva' ? 'prospectiva' : 'retrospectiva';
  const dividirEm = Array.isArray(opts.splitOn) && opts.splitOn.length ? opts.splitOn.slice() : ['quebra'];

  const entrada = (parsedList || []).filter(Boolean);
  const configs = entrada.map(sensingConfigOf);
  const legiveis = configs.filter(c => c.ok);
  const ilegiveis = configs.filter(c => !c.ok).map(c => ({ fileName: c.fileName, reason: c.reason }));

  /* a largura de banda assumida pode ser redefinida por opts: as bordas são
     recalculadas aqui para que o valor exportado corresponda ao usado */
  if (Math.abs(meiaBanda - CFG_BAND_HALFWIDTH_HZ) > 1e-9) legiveis.forEach(c => {
    CFG_HEMIS.forEach(h => {
      const x = c.byHemisphere[h];
      if (!isFinite(x.centerFreq)) return;
      x.bandLo = +(x.centerFreq - meiaBanda).toFixed(3);
      x.bandHi = +(x.centerFreq + meiaBanda).toFixed(3);
      x.bandwidthHz = larguraBanda;
    });
  });

  const semData = legiveis.filter(c => !isFinite(c.sessionT))
    .map(c => ({ fileName: c.fileName, summary: c.summary }));
  const datados = legiveis.filter(c => isFinite(c.sessionT)).sort((x, y) => x.sessionT - y.sessionT);

  const notaBanda = `a largura da banda de potência usada foi ${cfgN1(larguraBanda)} Hz (${CFG_BAND_SOURCE}); ` +
    'uma mudança real de largura de banda não seria detectável a partir deste arquivo.';

  if (!datados.length) return {
    ok: false, blocks: [], changes: [], undeclared: [], comparable: false, nBlocks: 0,
    nSessionsRead: entrada.length, nSessionsUsable: 0,
    unreadable: ilegiveis, undatedSessions: semData,
    attribution: atribuicao, tolerances: tol, bandwidthHz: larguraBanda, bandwidthSource: CFG_BAND_SOURCE,
    splitOn: dividirEm,
    reason: !entrada.length
      ? 'nenhum arquivo foi fornecido'
      : !legiveis.length
        ? (entrada.length === 1
          ? 'o único arquivo carregado não declara configuração de sensing — sem canal e sem frequência central não há ' +
            'como saber o que a série do crônico está medindo'
          : `nenhum dos ${entrada.length} arquivos carregados declara configuração de sensing — sem canal e sem ` +
            'frequência central não há como saber se os trechos do crônico medem a mesma variável')
        : (legiveis.length === 1
          ? 'o único arquivo com configuração declarada não tem data de sessão utilizável, e sem data não é possível ' +
            'atribuir trechos do Timeline a ela'
          : `os ${legiveis.length} arquivos com configuração declarada não têm data de sessão utilizável, e sem data ` +
            'não é possível ordená-los nem atribuir trechos do Timeline a cada configuração'),
    caveat: notaBanda
  };

  /* ---- caminhada: compara sessões consecutivas e fecha bloco na quebra ---- */
  const changes = [], naoDeclarados = [];
  const grupos = [];
  let corrente = [0];
  for (let i = 1; i < datados.length; i++) {
    const d = cfgDiffConfigs(datados[i - 1], datados[i], tol, off);
    d.changes.forEach(c => { c.sessionIndex = i; changes.push(c); });
    d.undeclared.forEach(u => { u.sessionIndex = i; naoDeclarados.push(u); });
    if (d.changes.some(c => dividirEm.indexOf(c.severity) >= 0)) { grupos.push(corrente); corrente = [i]; }
    else corrente.push(i);
  }
  grupos.push(corrente);

  const blocoDaSessao = new Array(datados.length);
  grupos.forEach((g, bi) => g.forEach(si => { blocoDaSessao[si] = bi; }));
  changes.forEach(c => {
    c.blockIndex = blocoDaSessao[c.sessionIndex];
    c.boundary = c.severity === 'quebra' && grupos[c.blockIndex][0] === c.sessionIndex;
  });
  naoDeclarados.forEach(u => { u.blockIndex = blocoDaSessao[u.sessionIndex]; });

  /* ---- intervalos de atribuição ------------------------------------------ */
  const blocks = grupos.map((g, bi) => {
    const primeira = datados[g[0]], ultima = datados[g[g.length - 1]];
    let startT, endT, startInclusive, endInclusive;
    if (atribuicao === 'retrospectiva') {
      /* a configuração da sessão k descreve o que chegou COM a sessão k */
      const anterior = bi > 0 ? grupos[bi - 1] : null;
      startT = anterior ? datados[anterior[anterior.length - 1]].sessionT : null;
      startInclusive = false;
      endT = bi < grupos.length - 1 ? ultima.sessionT : null;
      endInclusive = true;
    } else {
      /* a configuração da sessão k governa daí para a frente */
      startT = primeira.sessionT;
      startInclusive = true;
      endT = bi < grupos.length - 1 ? datados[grupos[bi + 1][0]].sessionT : null;
      endInclusive = false;
    }
    const aberturaIni = !cfgFin(startT), aberturaFim = !cfgFin(endT);
    const nDays = (!aberturaIni && !aberturaFim) ? +((endT - startT) / CFG_DAY_MS).toFixed(2) : NaN;
    const entrada2 = changes.filter(c => c.sessionIndex === g[0] && bi > 0);

    return {
      index: bi,
      startT: aberturaIni ? null : startT,
      endT: aberturaFim ? null : endT,
      startInclusive, endInclusive,
      openStart: aberturaIni, openEnd: aberturaFim,
      startDayLocal: aberturaIni ? '' : localDayKey(startT, off),
      endDayLocal: aberturaFim ? '' : localDayKey(endT, off),
      config: primeira,
      configLast: ultima,
      summary: primeira.summary || cfgSummaryText(primeira),
      sessions: g.map(si => ({
        index: si, fileName: datados[si].fileName,
        sessionT: datados[si].sessionT, sessionISO: datados[si].sessionISO,
        dayLocal: localDayKey(datados[si].sessionT, off),
        summary: datados[si].summary
      })),
      nSessions: g.length,
      firstSessionT: primeira.sessionT,
      lastSessionT: ultima.sessionT,
      nDays,
      nDaysSessions: +((ultima.sessionT - primeira.sessionT) / CFG_DAY_MS).toFixed(2),
      /* mudanças que ABREM o bloco (transição vinda do bloco anterior) */
      entryChanges: entrada2,
      /* mudanças observadas DENTRO do bloco, que não o dividem */
      covariateChanges: changes.filter(c => c.blockIndex === bi && c.sessionIndex !== g[0] && c.severity === 'covariável'),
      informativeChanges: changes.filter(c => c.blockIndex === bi && c.sessionIndex !== g[0] && c.severity === 'informativa'),
      undeclaredFields: naoDeclarados.filter(u => u.blockIndex === bi),
      spanNote: (aberturaIni && aberturaFim)
        ? 'bloco aberto nos dois extremos: é o único bloco conhecido e recebe todo ponto datado, sem que o intervalo de ' +
          'validade da configuração possa ser delimitado por outra sessão'
        : aberturaIni
          ? 'bloco aberto para trás: abrange tudo o que for anterior à última sessão dele, inclusive o Timeline que veio ' +
            'no primeiro arquivo, cuja configuração não pode ser confirmada por uma sessão anterior'
          : aberturaFim
            ? 'bloco aberto para a frente: abrange qualquer ponto posterior à última sessão carregada'
            : `intervalo de ${cfgN1(nDays)} dia(s) delimitado pelas sessões vizinhas`
    };
  });

  const quebras = changes.filter(c => c.severity === 'quebra');
  const covariaveis = changes.filter(c => c.severity === 'covariável');
  const informativas = changes.filter(c => c.severity === 'informativa');
  const umaSessao = datados.length === 1;

  /* ---- ressalvas: sempre presentes, nunca opcionais ---------------------- */
  const partesCaveat = [];
  partesCaveat.push(atribuicao === 'retrospectiva'
    ? 'atribuição temporal RETROSPECTIVA: a configuração lida na sessão k foi atribuída ao intervalo que termina nela, ' +
      '(sessão anterior, sessão k]. É a convenção que mantém cada Timeline junto do arquivo que o trouxe. O parser retém ' +
      'o estado FINAL da sessão, ou seja, posterior a qualquer reprogramação feita na consulta: se houve reprogramação ' +
      'naquele dia, os últimos pontos do intervalo podem ter sido registrados sob a configuração anterior.'
    : 'atribuição temporal PROSPECTIVA: a configuração lida na sessão k foi atribuída ao intervalo [sessão k, sessão k+1). ' +
      'É a convenção fiel ao fato de o parser reter o estado FINAL da sessão, mas ela deixa todo o Timeline anterior à ' +
      'primeira sessão fora de qualquer bloco conhecido — esses pontos aparecem em segmentTrendByConfig com blockIndex nulo.');
  partesCaveat.push(notaBanda);
  partesCaveat.push(`tolerâncias usadas na comparação: frequência central ${cfgN2(tol.centerFreqHz)} Hz, largura de banda ` +
    `${cfgN2(tol.bandwidthHz)} Hz, frequência de estimulação ${cfgN2(tol.rateHz)} Hz, largura de pulso ` +
    `${cfgN1(tol.pulseWidthUs)} µs, amplitude ${cfgN2(tol.amplitudeMa)} mA, limiares ${cfgN1(tol.thresholdUnits)} unidades.`);
  if (umaSessao) partesCaveat.push('há UMA única sessão datada: existe um bloco só por construção, e isso NÃO significa que a ' +
    'configuração não mudou. Significa que não existe uma segunda leitura para comparar — uma reprogramação ocorrida dentro ' +
    'do período coberto por este Timeline seria completamente invisível aqui. Carregue as sessões vizinhas para verificar.');
  if (ilegiveis.length) partesCaveat.push(`${ilegiveis.length} arquivo(s) não declaram configuração de sensing e ficaram fora ` +
    'da detecção; se algum deles corresponder a um período com configuração diferente, essa mudança não foi datada.');
  if (semData.length) partesCaveat.push(`${semData.length} arquivo(s) com configuração declarada não têm data de sessão e ` +
    'ficaram fora do ordenamento; se algum trouxer configuração diferente, a mudança não aparece nos blocos.');
  if (naoDeclarados.length) partesCaveat.push(`${naoDeclarados.length} comparação(ões) de campo não puderam ser feitas por ` +
    'falta de declaração no arquivo (lista em `undeclared`): esses campos não estão confirmados como iguais, apenas não ' +
    'são verificáveis.');

  return {
    ok: true,
    blocks,
    changes,
    undeclared: naoDeclarados,
    comparable: blocks.length === 1,
    nBlocks: blocks.length,
    nChanges: changes.length,
    nBreaking: quebras.length,
    nCovariate: covariaveis.length,
    nInformative: informativas.length,
    nSessionsRead: entrada.length,
    nSessionsUsable: datados.length,
    unreadable: ilegiveis,
    undatedSessions: semData,
    attribution: atribuicao,
    tolerances: tol,
    bandwidthHz: larguraBanda,
    bandwidthSource: CFG_BAND_SOURCE,
    splitOn: dividirEm,
    singleSession: umaSessao,
    reason: '',
    /* a frase de resumo distingue explicitamente "não mudou" de "não dá para saber" */
    verdict: umaSessao
      ? 'uma sessão só: mudança de configuração não é detectável (o que é diferente de não ter havido mudança)'
      : blocks.length === 1
        ? `configuração de sensing estável nas ${datados.length} sessões datadas: par bipolar, frequência central e largura ` +
          'de banda idênticos dentro das tolerâncias declaradas'
        : `${blocks.length} blocos de configuração: ${quebras.length} mudança(s) que impedem comparar a série entre blocos`,
    caveat: partesCaveat.join(' ')
  };
}

/* ------------------------------------------------------------------------- */
/*  4. Segmentação da série crônica pelos blocos                              */
/* ------------------------------------------------------------------------- */

/* Índice do bloco que contém `t`, ou -1. Extremos nulos são abertos. */
function cfgBlockAt(blocks, t) {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const s = b.startT, e = b.endT;
    const depois = !cfgFin(s) ? true : (b.startInclusive === false ? t > s : t >= s);
    const antes = !cfgFin(e) ? true : (b.endInclusive ? t <= e : t < e);
    if (depois && antes) return i;
  }
  return -1;
}

/* Monta um segmento com a contabilidade de faltantes explícita. */
function cfgSegment(blockIndex, linhas, bloco) {
  const faixa = cfgRange(linhas.map(r => r && r.t));
  let validos = 0;
  for (let i = 0; i < linhas.length; i++) if (linhas[i] && isFinite(linhas[i].lfp)) validos++;
  const n = linhas.length;
  return {
    blockIndex,
    rows: linhas,
    startT: faixa.n ? faixa.min : NaN,
    endT: faixa.n ? faixa.max : NaN,
    n,
    config: bloco ? bloco.config : null,
    configSummary: bloco ? bloco.summary : '',
    blockStartT: bloco ? bloco.startT : null,
    blockEndT: bloco ? bloco.endT : null,
    nTimestamped: faixa.n,
    /* NaN não é imputado nem removido: fica na série e é contado aqui */
    nValid: validos,
    nMissing: n - validos,
    pctMissing: n ? +(100 * (n - validos) / n).toFixed(2) : NaN,
    nDaysObserved: faixa.n ? +((faixa.max - faixa.min) / CFG_DAY_MS).toFixed(2) : NaN
  };
}

/* segmentTrendByConfig(rows, blocks, opts) — parte o Timeline pelos blocos.

   `rows`: [{ t (epoch ms), lfp }] — normalmente a saída de mergeTrend para um
   hemisfério. `blocks`: o array `blocks` de configBlocks, ou o resultado inteiro.

   Nenhum ponto é descartado. Pontos sem carimbo de tempo utilizável ou que caem
   fora de todo bloco conhecido vão para um segmento com blockIndex nulo e são
   contados em `nDropped` — "descartado" aqui significa apenas "não atribuível a
   uma configuração", nunca "removido da contabilidade".

   opts: { keepEmpty (padrão true), sort (padrão true) }                      */
export function segmentTrendByConfig(rows, blocks, opts) {
  opts = opts || {};
  const lista = Array.isArray(blocks) ? blocks : (blocks && Array.isArray(blocks.blocks) ? blocks.blocks : []);
  const linhas = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const manterVazios = opts.keepEmpty !== false;
  const ordenar = opts.sort !== false;
  const ordena = arr => ordenar ? arr.slice().sort((x, y) => (isFinite(x.t) ? x.t : Infinity) - (isFinite(y.t) ? y.t : Infinity)) : arr;

  if (!lista.length) {
    const soltos = ordena(linhas);
    return {
      ok: false,
      segments: soltos.length ? [cfgSegment(null, soltos, null)] : [],
      nDropped: soltos.length,
      nRows: linhas.length,
      nSegments: soltos.length ? 1 : 0,
      reason: 'nenhum bloco de configuração conhecido — sem saber sob qual configuração cada período foi registrado não é ' +
        'possível dizer quais trechos do Timeline medem a mesma variável',
      note: `os ${soltos.length} ponto(s) foram mantidos num único segmento com blockIndex nulo: nada foi descartado, mas ` +
        'nada foi atribuído a uma configuração, e por isso nenhum trecho pode ser comparado com outro.'
    };
  }

  const baldes = lista.map(() => []);
  const fora = [];
  let semTempo = 0;
  linhas.forEach(r => {
    if (!isFinite(r.t)) { semTempo++; fora.push(r); return; }
    const i = cfgBlockAt(lista, r.t);
    if (i < 0) fora.push(r); else baldes[i].push(r);
  });

  const segments = [], vazios = [];
  lista.forEach((b, i) => {
    const id = b.index != null ? b.index : i;
    if (!baldes[i].length) vazios.push(id);
    if (!baldes[i].length && !manterVazios) return;
    segments.push(cfgSegment(id, ordena(baldes[i]), b));
  });
  if (fora.length) segments.push(Object.assign(cfgSegment(null, ordena(fora), null), {
    reason: semTempo === fora.length
      ? 'pontos sem carimbo de tempo utilizável — não é possível dizer sob qual configuração foram registrados'
      : 'pontos fora do intervalo de todo bloco conhecido — tipicamente Timeline anterior à primeira sessão carregada ' +
        '(atribuição prospectiva) ou posterior ao último bloco fechado'
  }));

  let totalFalt = 0, totalVal = 0;
  segments.forEach(s => { totalFalt += s.nMissing; totalVal += s.nValid; });

  return {
    ok: true,
    segments,
    nDropped: fora.length,
    nUntimed: semTempo,
    nRows: linhas.length,
    nSegments: segments.length,
    nBlocksWithoutData: vazios.length,
    emptyBlocks: vazios,
    nValid: totalVal,
    nMissing: totalFalt,
    pctMissing: linhas.length ? +(100 * totalFalt / linhas.length).toFixed(2) : NaN,
    note: (fora.length
      ? `${fora.length} de ${linhas.length} ponto(s) ficaram fora de todo bloco de configuração conhecido e foram reunidos ` +
        'num segmento com blockIndex nulo. Eles NÃO foram descartados e NÃO foram atribuídos a nenhuma configuração: não ' +
        'devem ser plotados na mesma linha dos demais nem entrar em estatística que pressuponha configuração conhecida. '
      : 'todos os pontos com carimbo de tempo caíram dentro de um bloco de configuração conhecido. ') +
      (vazios.length ? `${vazios.length} bloco(s) não têm nenhum ponto de Timeline. ` : '') +
      `${totalFalt} valor(es) de LFP faltante(s) foram mantidos como NaN dentro dos segmentos e contabilizados em ` +
      '`nMissing` — nenhuma imputação foi feita. Cada segmento deve ser traçado como uma linha separada: unir segmentos ' +
      'de blocos diferentes por um traço contínuo sugere continuidade de uma variável que mudou de definição.'
  };
}

/* ------------------------------------------------------------------------- */
/*  5. Aviso que a figura mostra antes de deixar comparar                     */
/* ------------------------------------------------------------------------- */

/* crossBlockWarning(blocks) — a frase que precede a comparação entre trechos.

   Aceita o array `blocks` ou o resultado inteiro de configBlocks.
   `level`: 'ok' | 'atencao' | 'proibido' — governa a cor e se a interface libera
   a comparação; 'proibido' é metodológico, não clínico.                      */
export function crossBlockWarning(blocks) {
  const lista = Array.isArray(blocks) ? blocks : (blocks && Array.isArray(blocks.blocks) ? blocks.blocks : []);

  if (!lista.length) return {
    safe: false, level: 'proibido', nBlocks: 0, nSessions: 0,
    message: 'não foi possível ler a configuração de sensing de nenhuma sessão carregada. Sem saber o par bipolar e a ' +
      'frequência central de cada período, não há como afirmar que dois trechos do gráfico medem a mesma variável — e ' +
      'comparar assim é assumir o que não se sabe. Carregue arquivos que contenham a programação de sensing.'
  };

  const nSessoes = lista.reduce((a, b) => a + ((b.sessions || []).length || 0), 0);

  if (lista.length === 1) {
    const b = lista[0];
    const cov = (b.covariateChanges || []).length;
    const naoVerif = (b.undeclaredFields || []).length;

    if (nSessoes <= 1) return {
      safe: true, level: 'ok', nBlocks: 1, nSessions: nSessoes,
      message: 'há uma única sessão carregada: a configuração de sensing é a mesma em todo o traçado POR CONSTRUÇÃO. ' +
        'Isso não é o mesmo que dizer que ela não mudou — com uma sessão só não existe segunda leitura para comparar, e ' +
        'uma reprogramação ocorrida dentro do período deste Timeline seria invisível aqui. Para verificar, carregue as ' +
        'sessões vizinhas.'
    };

    if (cov) return {
      safe: true, level: 'atencao', nBlocks: 1, nSessions: nSessoes,
      message: `o par bipolar, a frequência central e a largura de banda não mudaram nas ${nSessoes} sessões carregadas: ` +
        `a série é a mesma variável em todo o traçado. Mas ${cov} mudança(s) de covariável foram registradas ` +
        `(${(b.covariateChanges || []).map(c => c.field).filter((v, i, a) => a.indexOf(v) === i).join(', ')}). ` +
        'Elas alteram a magnitude sem alterar a definição da medida: a comparação é possível, desde que a mudança seja ' +
        'declarada junto do resultado.'
    };

    if (naoVerif) return {
      safe: true, level: 'atencao', nBlocks: 1, nSessions: nSessoes,
      message: `nenhuma mudança de configuração foi detectada nas ${nSessoes} sessões carregadas, mas ${naoVerif} campo(s) ` +
        'não puderam ser comparados por falta de declaração nos arquivos. Esses campos não estão confirmados como iguais; ' +
        'estão apenas não verificáveis. Trate a comparação como provável, não como demonstrada.'
    };

    return {
      safe: true, level: 'ok', nBlocks: 1, nSessions: nSessoes,
      message: `configuração de sensing idêntica nas ${nSessoes} sessões carregadas — mesmo par bipolar, mesma frequência ` +
        'central e mesma largura de banda, dentro das tolerâncias declaradas. Os trechos do gráfico medem a mesma variável ' +
        'e podem ser comparados entre si.'
    };
  }

  const descricao = lista.map(b => `bloco ${b.index}: ${b.summary || 'configuração não descrita'}` +
    (b.startDayLocal || b.endDayLocal ? ` (${b.startDayLocal || 'início aberto'} → ${b.endDayLocal || 'em aberto'})` : ''));
  const motivos = [];
  lista.forEach(b => (b.entryChanges || []).forEach(c => {
    if (c.severity === 'quebra') motivos.push(`${CFG_HEMI_SIGLA[c.hemisphere] || c.hemisphere} ${c.field}: ` +
      `${cfgShow(c.field, c.from)} → ${cfgShow(c.field, c.to)}`);
  }));

  return {
    safe: false, level: 'proibido', nBlocks: lista.length, nSessions: nSessoes,
    message: `a configuração de sensing mudou entre as sessões carregadas: há ${lista.length} blocos de configuração ` +
      `(${descricao.join('; ')})` + (motivos.length ? `. Mudanças que quebram a comparação: ${motivos.join('; ')}` : '') +
      '. Séries de blocos diferentes têm o mesmo nome e a mesma unidade aparente, mas não são a mesma variável: a potência ' +
      'passa a ser integrada em outra banda ou medida entre outros contatos. Cada bloco deve ser traçado e analisado ' +
      'separadamente; não há fator de conversão entre eles, e normalizar um pelo outro produziria um número sem ' +
      'significado físico. Comparação dentro de cada bloco continua válida.'
  };
}
