/* metrics/agenda.js — a direção ASCENDENTE da ponte entre as duas camadas.

   A HIERARQUIA, EM UMA FRASE. O registro agudo calibra o crônico (é o
   passaporte do biomarcador: qual par bipolar, qual pico, qual largura, qual
   SNR — ver metrics/passport.js). O registro crônico faz o caminho de volta:
   ele observa trinta dias de vida livre, encontra o que não se explica, e
   transforma isso na AGENDA da próxima sessão aguda. Uma queda reprodutível de
   beta às 3 h da manhã, uma tomada que deixou de responder, uma assimetria
   interhemisférica que apareceu entre duas consultas — nada disso se resolve
   olhando mais o crônico. Resolve-se com um experimento, e o experimento
   precisa ser desenhado antes de o paciente chegar.

   O QUE ESTE MÓDULO PRODUZ, E O QUE ELE NUNCA PRODUZ. Produz uma lista
   ordenada de PERGUNTAS INVESTIGÁVEIS, cada uma com o achado que a motivou, a
   evidência numérica, o protocolo de aquisição que a responderia e a frase
   explícita do que aquele protocolo decidiria. Nunca produz conduta
   terapêutica: não sugere trocar contato, mudar amplitude, ajustar medicação
   nem programar aDBS. A fronteira é dura e está codificada — todo item passa
   por `agSemConduta`, que rejeita o texto se ele contiver verbo de prescrição.

   A REGRA DE OURO, IGUAL À DO ALARME. Verificação não feita não é achado
   ausente. Toda checagem que o dado não permitiu sai em `notChecked` com o
   motivo, e o resumo diz quantas foram. Uma agenda vazia com seis checagens
   impossíveis não é "nada a investigar" — é "não foi possível investigar".

   COINCIDÊNCIA NÃO É CAUSA. Vários achados aqui são temporais (uma mudança de
   nível caiu perto de uma reprogramação; uma assimetria surgiu entre duas
   consultas). O módulo reporta a coincidência e diz, em cada item, que a ordem
   causal não é recuperável a partir de série observacional — é justamente por
   isso que o item vira agenda de experimento, e não conclusão.

   Unidades: t em epoch ms; lfp na unidade de potência do arquivo (a.u. do
   BrainSense Timeline); horas locais decimais; durações em minutos.

   Referências de desenho (leitura, não dependência):
     Gilron R, et al. Nat Biotechnol 2021;39:1078-1085 — registro domiciliar
       prolongado e a distância entre o que se vê no consultório e em casa.
     van Rheede JJ, et al. npj Parkinsons Dis 2022;8:88 — ritmo circadiano do
       beta subtalâmico em registro crônico do Percept.
     Maris E, Oostenveld R. J Neurosci Methods 2007;164:177-190 — por que uma
       hipótese escolhida depois de olhar o dado precisa de teste próprio.    */

import { localHour, localDayKey } from '../io/parse.js';
import { mean, median, sd, quantile, linreg } from '../stats/descriptive.js';
import { permutationTwoSample } from '../stats/events.js';
import { cosinor } from '../stats/circadian.js';
import { actigraphyPanel, m10l5 } from '../stats/actigraphy.js';
import { changePointsInTime, annotateChangePoints } from '../stats/changepoint.js';
import { levodopaResponse } from './diary.js';

export const AGENDA_VERSION = 1;

const AG_DIA_MS = 86400000;

/* Limiares. Todos declarados na saída, porque cada um deles é uma escolha e
   nenhum tem consenso na literatura. Foram fixados por ordem de grandeza:
   0,15 no índice de assimetria é cerca de 35% de diferença entre lados, que é
   o que se distingue a olho num gráfico; 1,0 de IV é o valor a partir do qual
   a cronobiologia da actigrafia chama o ritmo de fragmentado; 0,4 de IS é o
   limite abaixo do qual o perfil médio de 24 h explica menos de metade do que
   um perfil estável explicaria.                                             */
const AGENDA_PADRAO = {
  assimetriaIndice: 0.15,      /* |(E−D)/(E+D)| que já vale investigar        */
  assimetriaDelta: 0.10,       /* mudança do índice entre primeiro e último terço */
  assimetriaP: 0.05,
  doseP: 0.05,
  doseQuedaMin: 5,             /* % de queda abaixo da qual a resposta é irrelevante */
  circadianoZ: 2.0,            /* z robusto da hora anômala contra as vizinhas  */
  circadianoEfeito: 0.15,      /* e, além do z, um tamanho de efeito mínimo: fração
                                  da amplitude pico-a-vale do perfil de 24 h. Sem
                                  este piso, um perfil muito liso faz a escala do
                                  resíduo colapsar e qualquer ondulação vira z alto */
  circadianoFracaoDias: 0.5,   /* fração mínima de dias em que a anomalia se repete */
  derivaPctPorSemana: 5,       /* % de deriva semanal do nível basal          */
  passaporteDiasMax: 180,      /* idade do passaporte a partir da qual ele envelhece */
  coberturaMinDia: 0.5,        /* fração de bins de 1 h com dado, por dia     */
  coberturaMinDias: 14,        /* dias com cobertura suficiente para um crônico útil */
  ivFragmentado: 1.0,
  isInstavel: 0.4,
  minDias: 6
};

/* Verbos que caracterizam CONDUTA, não investigação. Se um protocolo sugerido
   contiver qualquer um deles, é bug de redação — o item é rebaixado e a saída
   diz que foi. Barato, e impede que uma frase descuidada vire recomendação
   terapêutica num software que declara não ser dispositivo médico.          */
const AG_VERBOS_CONDUTA = [
  'aumente', 'diminua', 'reduza', 'troque o contato', 'ajuste a amplitude',
  'prescreva', 'suspenda a medicação', 'ative o adbs', 'programe o adbs',
  'eleve a dose', 'reduza a dose', 'mude o grupo'
];

function agSemConduta(texto) {
  const t = String(texto || '').toLowerCase();
  return !AG_VERBOS_CONDUTA.some(v => t.indexOf(v) >= 0);
}

const AG_RANK = { alta: 0, média: 1, baixa: 2 };

/* Constrói um item já no formato final. Nenhum caminho de código monta item à
   mão, para que nenhum item possa sair sem protocolo ou sem o que ele decide. */
function agItem(id, priority, finding, evidence, suggestedProtocol, whatItWouldSettle, confidence, extra) {
  const limpo = agSemConduta(suggestedProtocol) && agSemConduta(whatItWouldSettle);
  return Object.assign({
    id,
    priority,
    rank: AG_RANK[priority] == null ? 3 : AG_RANK[priority],
    finding,
    evidence,
    suggestedProtocol: limpo ? suggestedProtocol : suggestedProtocol + ' [texto revisado: este módulo não sugere conduta]',
    whatItWouldSettle,
    confidence,
    conductFree: limpo
  }, extra || {});
}

function agNaoChecado(id, whyNot, whatWouldBeNeeded) {
  return { id, whyNot, whatWouldBeNeeded };
}

/* ------------------------------------------------------------ utilidades -- */

/* Série de um valor por dia local, com a estatística de resumo declarada.
   A mediana é o padrão porque um pico de movimento num único bin de 10 min não
   deve deslocar o nível do dia; a média fica disponível em opts.             */
function agSerieDiaria(rows, offMin, agregacao) {
  const porDia = {};
  (rows || []).forEach(r => {
    if (!r || !isFinite(r.t) || !isFinite(r.lfp)) return;
    const d = localDayKey(r.t, offMin);
    (porDia[d] = porDia[d] || []).push(r.lfp);
  });
  const dias = Object.keys(porDia).sort();
  return {
    days: dias,
    values: dias.map(d => agregacao === 'mean' ? mean(porDia[d]) : median(porDia[d])),
    n: dias.map(d => porDia[d].length),
    aggregation: agregacao === 'mean' ? 'média' : 'mediana'
  };
}

/* Matriz dia × hora (bins de 1 h) e o perfil médio de 24 h, guardando por hora
   quantos dias contribuíram. Escrita aqui, e não reaproveitada de
   stats/actigraphy.js, porque lá os dias com cobertura baixa são excluídos —
   e a checagem de cobertura precisa justamente vê-los.                       */
function agGradeHoraria(rows, offMin) {
  const porDia = {};
  let ignoradas = 0;
  (rows || []).forEach(r => {
    if (!r || !isFinite(r.t) || !isFinite(r.lfp)) { ignoradas++; return; }
    const d = localDayKey(r.t, offMin);
    if (!porDia[d]) porDia[d] = Array.from({ length: 24 }, () => []);
    porDia[d][Math.min(23, Math.floor(localHour(r.t, offMin)))].push(r.lfp);
  });
  const dias = Object.keys(porDia).sort();
  const matriz = dias.map(d => porDia[d].map(b => b.length ? median(b) : NaN));
  const cobertura = matriz.map(l => l.filter(isFinite).length / 24);
  const perfil = [], nPorHora = [];
  for (let h = 0; h < 24; h++) {
    const col = matriz.map(l => l[h]).filter(isFinite);
    perfil.push(col.length ? median(col) : NaN);
    nPorHora.push(col.length);
  }
  return { days: dias, matrix: matriz, coverage: cobertura, profile: perfil, nPerHour: nPorHora, nIgnored: ignoradas };
}

/* Desvio robusto (MAD escalado) de um vetor, ignorando não finitos. */
function agMadEscalado(v) {
  const ok = (v || []).filter(isFinite);
  if (ok.length < 3) return NaN;
  const m = median(ok);
  return 1.4826 * median(ok.map(x => Math.abs(x - m)));
}

const agN = (x, k) => isFinite(x) ? +x.toFixed(k == null ? 2 : k) : NaN;
const agLado = h => h === 'Left' ? 'esquerdo' : h === 'Right' ? 'direito' : String(h || '—');

/* ========================================================================= */
/*  1. Assimetria interhemisférica emergente                                  */
/* ========================================================================= */

/* Índice de assimetria diário (E−D)/(E+D), comparado entre o primeiro e o
   último terço do registro. O nível absoluto do índice diz pouco — os dois
   hemisférios podem estar em pares bipolares e frequências centrais
   diferentes, e nesse caso a razão entre eles mistura biologia com
   configuração. O que é interpretável é a MUDANÇA do índice ao longo do
   registro, desde que a configuração não tenha mudado no meio.              */
function agAssimetria(ctx, lim) {
  const E = ctx.byHemisphere.Left, D = ctx.byHemisphere.Right;
  if (!E || !D || !E.days.length || !D.days.length) return agNaoChecado(
    'assimetria',
    'o Timeline não traz os dois hemisférios neste arquivo',
    'um registro crônico com sensing bilateral — sem os dois lados não existe índice de assimetria'
  );

  const idx = {};
  E.days.forEach((d, i) => { idx[d] = { e: E.values[i] }; });
  D.days.forEach((d, i) => { if (idx[d]) idx[d].d = D.values[i]; });
  const comuns = Object.keys(idx).filter(d => isFinite(idx[d].e) && isFinite(idx[d].d) && (idx[d].e + idx[d].d) > 0).sort();
  if (comuns.length < lim.minDias) return agNaoChecado(
    'assimetria',
    `só ${comuns.length} dia(s) têm valor nos dois hemisférios — abaixo dos ${lim.minDias} necessários`,
    'mais dias com sensing simultâneo dos dois lados'
  );

  const serie = comuns.map(d => (idx[d].e - idx[d].d) / (idx[d].e + idx[d].d));
  const corte = Math.max(2, Math.floor(comuns.length / 3));
  const inicio = serie.slice(0, corte), fim = serie.slice(-corte);
  const iMed = median(inicio), fMed = median(fim), delta = fMed - iMed;
  const geral = median(serie);
  const perm = permutationTwoSample(inicio, fim, { nPermutations: 4000, seed: ctx.seed });

  const mudou = Math.abs(delta) >= lim.assimetriaDelta && isFinite(perm.p) && perm.p < lim.assimetriaP;
  const alto = Math.abs(geral) >= lim.assimetriaIndice;
  if (!mudou && !alto) return null;

  /* configuração diferente entre os lados degrada a leitura, mas não a anula:
     a MUDANÇA do índice continua interpretável se a configuração foi estável */
  const cfgDif = ctx.configAssimetrica;
  const confianca = cfgDif ? 'baixa' : (mudou && comuns.length >= 14 ? 'média' : 'baixa');

  const evidencia = {
    asymmetryIndexOverall: agN(geral, 3),
    asymmetryIndexFirstThird: agN(iMed, 3),
    asymmetryIndexLastThird: agN(fMed, 3),
    delta: agN(delta, 3),
    p: agN(perm.p, 4),
    pMethod: perm.exact ? 'permutação exata' : `permutação (${perm.nPermutations} sorteios)`,
    nDaysPaired: comuns.length,
    nDaysPerThird: corte,
    definition: 'índice = (esquerdo − direito)/(esquerdo + direito), um valor por dia, dias com valor nos dois lados',
    configurationDiffersBetweenSides: !!cfgDif
  };

  const achado = mudou
    ? `A assimetria entre os hemisférios MUDOU ao longo do registro: o índice passou de ${agN(iMed, 2)} no primeiro ` +
      `terço para ${agN(fMed, 2)} no último (p = ${agN(perm.p, 3)}). O lado ${delta > 0 ? 'esquerdo' : 'direito'} ` +
      'ganhou peso relativo.'
    : `A potência é persistentemente assimétrica (índice mediano ${agN(geral, 2)}, com o lado ` +
      `${geral > 0 ? 'esquerdo' : 'direito'} mais alto ao longo de todo o período).`;

  return agItem(
    'assimetria',
    mudou ? 'alta' : 'média',
    achado,
    evidencia,
    'Survey bipolar completo nos dois hemisférios na mesma sessão, seguido de streaming de 2 min por lado em repouso, ' +
      'com a configuração de sensing dos dois lados registrada antes e depois. Com o Survey em mãos, gerar o passaporte ' +
      'do biomarcador de cada lado e comparar com o passaporte anterior.',
    mudou
      ? 'Se o pico e o par bipolar de cada lado continuarem os mesmos do passaporte anterior, a mudança do índice é ' +
        'do sinal e não da medida. Se o pico se deslocou ou o par mudou, a assimetria é artefato de configuração e a ' +
        'série dos dois lados não deve ser comparada em escala absoluta.'
      : 'Se o Survey mostrar o mesmo par e o mesmo pico dos dois lados, a assimetria é da fisiologia; se os lados estão ' +
        'em pares ou frequências diferentes, o índice não mede assimetria biológica e não deve ser reportado como tal.',
    confianca,
    {
      caveat: cfgDif
        ? 'os dois hemisférios NÃO estão na mesma configuração de sensing — parte ou toda esta assimetria pode ser da ' +
          'medida, e é por isso que a confiança está baixa'
        : 'esta é uma série observacional: a mudança do índice é compatível com progressão, com mudança de rotina, com ' +
          'mudança de aderência à medicação e com deriva do próprio eletrodo, e nenhuma delas é distinguível aqui'
    }
  );
}

/* ========================================================================= */
/*  2. Resposta à levodopa perdida ou ausente                                 */
/* ========================================================================= */

/* A curva de dose agregada é, dos produtos do crônico, o de leitura clínica
   mais direta: alinhar todas as tomadas de trinta dias e mediar a trajetória
   do beta dá latência, profundidade, duração e variabilidade entre doses. Aqui
   interessa o caso NEGATIVO — a dose que não produz queda reprodutível, ou que
   produzia e deixou de produzir — porque é ele que vira experimento.        */
function agDose(ctx, lim) {
  if (!ctx.doseTimes || ctx.doseTimes.length < 3) return agNaoChecado(
    'dose',
    ctx.doseTimes && ctx.doseTimes.length
      ? `só ${ctx.doseTimes.length} tomada(s) marcada(s) no aparelho — são necessárias ao menos 3`
      : 'nenhuma tomada de levodopa marcada no aparelho durante o período',
    'marcações de tomada pelo paciente (evento no controlador) ou um diário com horários, cobrindo ao menos 3 doses'
  );
  const linhas = ctx.principal;
  if (!linhas || !linhas.length) return agNaoChecado(
    'dose', 'não há série crônica utilizável para alinhar às tomadas', 'BrainSense Timeline com potência em banda'
  );

  const total = levodopaResponse(linhas, ctx.doseTimes, ctx.offMin, { seed: ctx.seed });
  if (!total.ok) return agNaoChecado('dose', total.reason, 'mais tomadas marcadas ou mais cobertura de Timeline na janela da dose');

  const queda = isFinite(total.dropPct) ? total.dropPct : NaN;
  const surro = isFinite(total.surrogateDropPct) ? total.surrogateDropPct : NaN;
  const semResposta = !total.detected || !(queda > lim.doseQuedaMin);

  /* perda ao longo do tempo: metade inicial vs metade final das tomadas */
  const doses = ctx.doseTimes.slice().sort((a, b) => a - b);
  const meio = Math.floor(doses.length / 2);
  let perdeu = null, r1 = null, r2 = null;
  if (doses.length >= 8) {
    r1 = levodopaResponse(linhas, doses.slice(0, meio), ctx.offMin, { seed: ctx.seed });
    r2 = levodopaResponse(linhas, doses.slice(meio), ctx.offMin, { seed: ctx.seed });
    if (r1.ok && r2.ok) perdeu = r1.detected && !r2.detected;
  }

  if (!semResposta && !perdeu) return null;

  const evidencia = {
    nDoses: doses.length,
    detected: !!total.detected,
    p: agN(total.p, 4),
    dropPct: agN(queda, 1),
    surrogateDropPct: agN(surro, 1),
    latencyMin: total.latencyMin == null ? NaN : total.latencyMin,
    timeToNadirMin: total.timeToNadirMin == null ? NaN : total.timeToNadirMin,
    durationMin: total.durationMin == null ? NaN : total.durationMin,
    firstHalfDetected: r1 ? !!r1.detected : null,
    secondHalfDetected: r2 ? !!r2.detected : null,
    nDosesPerHalf: r1 && r2 ? meio : null,
    window: 'de −60 a +240 min da marca, bins de 10 min, curva mediana entre tomadas'
  };

  const achado = perdeu
    ? 'A queda de beta após a tomada estava presente na primeira metade do período e não se sustenta na segunda: ' +
      'a resposta agregada mudou dentro do próprio registro.'
    : `As ${doses.length} tomadas marcadas NÃO produzem queda reprodutível de beta ` +
      `(queda observada ${agN(queda, 1)}%, contra ${agN(surro, 1)}% que o ritmo diurno sozinho já produz; ` +
      `p = ${agN(total.p, 3)}).`;

  return agItem(
    'dose',
    'alta',
    achado,
    evidencia,
    'Teste de levodopa supervisionado com aquisição contínua: streaming de 10 min em estado prático OFF — o mesmo que a ' +
      'equipe já usa nos testes de resposta —, tomada com horário anotado ao minuto, e streaming de 5 min a cada 20 min ' +
      'por 2 h, com escala motora aplicada nos mesmos instantes. O horário da tomada precisa vir de relógio da sessão, ' +
      'não de memória do paciente.',
    'Separa três explicações que a série crônica não separa: (a) a marca no aparelho não corresponde ao horário real da ' +
      'tomada, e o alinhamento é que está errado; (b) a tomada é real e o beta de fato não responde neste par bipolar, ' +
      'o que questiona o próprio biomarcador; (c) o beta responde, mas a janela de 4 h do crônico é curta ou grossa ' +
      'demais para capturar a resposta deste paciente.',
    perdeu ? 'média' : (doses.length >= 20 ? 'média' : 'baixa'),
    {
      caveat: 'a marca de tomada é auto-relatada e seu horário tem erro desconhecido; ausência de efeito medido é ' +
        'compatível com ausência de efeito e com erro de alinhamento, e as duas coisas não são separáveis aqui'
    }
  );
}

/* ========================================================================= */
/*  3. Anomalia circadiana reprodutível                                       */
/* ========================================================================= */

/* Mediana móvel CIRCULAR de um perfil de 24 h, com o centro excluído da
   janela. Circular porque 23 h e 0 h são vizinhas; centro excluído porque uma
   anomalia de uma hora não pode entrar na definição da sua própria linha de
   base — se entrasse, ela se explicaria sozinha.                             */
function agBaseLocal(perfil, meiaJanela) {
  const n = perfil.length, out = new Array(n).fill(NaN);
  for (let h = 0; h < n; h++) {
    const viz = [];
    for (let k = -meiaJanela; k <= meiaJanela; k++) {
      if (k === 0) continue;
      const v = perfil[(h + k + n) % n];
      if (isFinite(v)) viz.push(v);
    }
    if (viz.length >= 4) out[h] = median(viz);
  }
  return out;
}

/* Procura a hora do dia que mais se destaca EM RELAÇÃO ÀS HORAS VIZINHAS, e que
   se destaca na mesma direção em pelo menos metade dos dias.

   POR QUE CONTRA AS VIZINHAS, E NÃO CONTRA A MÉDIA DO DIA. O beta cai no sono e
   sobe ao acordar: é a forma esperada do ritmo, e comparar cada hora com a
   média das 24 h faria toda a madrugada parecer anômala. A referência aqui é a
   mediana das horas vizinhas (±3 h, circular, sem a própria hora), o que remove
   a forma suave do ritmo e deixa só o que é LOCAL — o entalhe de uma hora, o
   degrau que não acompanha a curva. É por isso que uma queda às 3 h, dentro do
   sono, ainda aparece: ela é abrupta em relação às 2 h e às 4 h.

   ESTA É UMA HIPÓTESE ESCOLHIDA DEPOIS DE OLHAR O DADO. O z reportado não é um
   teste — é o quanto aquela hora se destaca entre 24 candidatas. Está dito no
   item, e é por isso que ele vira agenda em vez de conclusão.                */
function agCircadiano(ctx, lim) {
  const g = ctx.grade;
  if (!g || g.days.length < lim.minDias) return agNaoChecado(
    'circadiano',
    `só ${g ? g.days.length : 0} dia(s) de registro — abaixo dos ${lim.minDias} necessários para dizer que uma hora se repete`,
    'ao menos duas semanas de Timeline com cobertura das 24 h'
  );
  const nHoras = g.profile.filter(isFinite).length;
  if (nHoras < 18) return agNaoChecado(
    'circadiano',
    `só ${nHoras} das 24 horas do dia têm dado em algum dia — o perfil de 24 h está incompleto demais`,
    'cobertura mais uniforme ao longo do dia'
  );

  const meiaJanela = 3;
  const baseLocal = agBaseLocal(g.profile, meiaJanela);
  const residuo = g.profile.map((v, h) => (isFinite(v) && isFinite(baseLocal[h])) ? v - baseLocal[h] : NaN);
  const escala = agMadEscalado(residuo);
  if (!isFinite(escala) || escala <= 0) return agNaoChecado(
    'circadiano',
    'o perfil de 24 h é liso demais para que alguma hora se destaque das vizinhas',
    'uma série com variação hora a hora mensurável'
  );

  const ml = ctx.m10l5;
  const l5ini = ml && ml.ok ? ml.L5startHour : NaN;
  const noSono = h => {
    if (!isFinite(l5ini)) return null;
    for (let k = 0; k < 5; k++) if (((l5ini + k) % 24) === h) return true;
    return false;
  };

  /* amplitude pico-a-vale do perfil, que dá a escala física do efeito */
  const finitos = g.profile.filter(isFinite);
  const amplitude = Math.max.apply(null, finitos) - Math.min.apply(null, finitos);
  const pisoEfeito = amplitude * lim.circadianoEfeito;

  let melhor = null;
  for (let h = 0; h < 24; h++) {
    if (!isFinite(residuo[h])) continue;
    const z = residuo[h] / escala;
    if (Math.abs(z) < lim.circadianoZ) continue;
    /* piso de tamanho de efeito: destacar-se do ruído não basta, é preciso
       destacar-se o bastante para significar alguma coisa na escala do dia */
    if (!(Math.abs(residuo[h]) >= pisoEfeito)) continue;
    /* reprodutibilidade: em quantos dias aquela hora fica do mesmo lado da
       mediana das SUAS vizinhas naquele mesmo dia */
    let comDado = 0, mesma = 0;
    g.matrix.forEach(linha => {
      const v = linha[h];
      if (!isFinite(v)) return;
      const b = agBaseLocal(linha, meiaJanela)[h];
      if (!isFinite(b)) return;
      comDado++;
      if (z > 0 ? v > b : v < b) mesma++;
    });
    if (comDado < Math.max(3, Math.ceil(g.days.length * 0.4))) continue;
    const frac = mesma / comDado;
    if (frac < lim.circadianoFracaoDias) continue;
    if (!melhor || Math.abs(z) > Math.abs(melhor.z)) melhor = { hour: h, z, nDays: comDado, frac };
  }
  if (!melhor) return null;

  const dentroDoSono = noSono(melhor.hour);
  const evidencia = {
    hourLocal: melhor.hour,
    robustZ: agN(melhor.z, 2),
    direction: melhor.z > 0 ? 'acima' : 'abaixo',
    reference: `mediana das horas vizinhas (±${meiaJanela} h, circular, sem a própria hora)`,
    localBaseline: agN(baseLocal[melhor.hour], 3),
    hourValue: agN(g.profile[melhor.hour], 3),
    residual: agN(residuo[melhor.hour], 3),
    profileAmplitude: agN(amplitude, 3),
    effectFraction: agN(Math.abs(residuo[melhor.hour]) / amplitude, 3),
    effectFloor: agN(pisoEfeito, 3),
    robustScale: agN(escala, 3),
    fractionOfDaysSameDirection: agN(melhor.frac, 2),
    nDaysWithThatHour: melhor.nDays,
    nDays: g.days.length,
    insideSleepWindow: dentroDoSono,
    sleepWindow: isFinite(l5ini) ? `${l5ini}h–${(l5ini + 5) % 24}h (L5)` : 'não foi possível estimar a janela L5',
    selection: 'a hora foi escolhida por ser a mais destacada entre 24 candidatas — o z NÃO é um valor de teste'
  };

  return agItem(
    'circadiano',
    'média',
    `Há um desvio reprodutível às ${melhor.hour}h: essa hora fica ${agN(Math.abs(residuo[melhor.hour]), 2)} ` +
      `${melhor.z > 0 ? 'acima' : 'abaixo'} da mediana das suas horas vizinhas — ` +
      `${Math.round(100 * Math.abs(residuo[melhor.hour]) / amplitude)}% de toda a amplitude do ritmo diário —, ` +
      `na mesma direção em ${Math.round(melhor.frac * 100)}% dos ${melhor.nDays} dias em que ela tem dado` +
      (dentroDoSono === true ? ', e cai dentro da janela de sono estimada' : dentroDoSono === false ? ', fora da janela de sono estimada' : '') + '.',
    evidencia,
    `Sessão aguda marcada para cobrir a hora suspeita: streaming de 10 min imediatamente antes, durante e depois das ` +
      `${melhor.hour}h, com registro simultâneo do que o paciente está fazendo (acordado, dormindo, em pé, comendo) e ` +
      'do horário da última tomada. Se houver acelerômetro ou actígrafo disponível, gravar em paralelo com marca comum ' +
      'de sincronização no início e no fim.',
    'Distingue fisiologia de contexto. Se o desvio aparece na sessão supervisionada com o paciente em repouso e sem ' +
      'evento externo, é do sinal. Se ele acompanha uma atividade (levantar da cama, refeição, transição de sono) ou ' +
      'desaparece sob observação, o que a série crônica mostra é rotina, não ritmo neural.',
    g.days.length >= 21 ? 'média' : 'baixa',
    {
      caveat: 'hipótese gerada a partir do próprio dado: a hora foi escolhida por se destacar, e por isso o z não pode ' +
        'ser lido como significância. Duas explicações banais precisam ser descartadas antes de qualquer outra — a ' +
        'transição de acordar, que é abrupta por natureza, e o horário fixo de uma tomada. Só um registro novo, com a ' +
        'hora fixada de antemão, testa esta hipótese'
    }
  );
}

/* ========================================================================= */
/*  4. Deriva do nível basal                                                  */
/* ========================================================================= */

/* Duas formas de o nível basal mudar: por degrau (ponto de mudança) ou por
   rampa (tendência monotônica). As duas viram agenda, mas por motivos
   diferentes — o degrau sem marco correspondente é o que mais interessa,
   porque significa que algo mudou e ninguém registrou o quê.                */
function agDeriva(ctx, lim) {
  const linhas = ctx.principal;
  if (!linhas || !linhas.length) return agNaoChecado(
    'deriva', 'não há série crônica utilizável', 'BrainSense Timeline com potência em banda'
  );
  const cp = changePointsInTime(linhas, { offMin: ctx.offMin, seed: ctx.seed });
  const serie = ctx.serieDiaria;

  /* rampa: regressão do valor diário contra o dia */
  let rampa = null;
  if (serie && serie.days.length >= lim.minDias) {
    const x = [], y = [];
    const t0 = new Date(serie.days[0] + 'T00:00:00Z').getTime();
    serie.days.forEach((d, i) => {
      const v = serie.values[i];
      if (!isFinite(v)) return;
      x.push((new Date(d + 'T00:00:00Z').getTime() - t0) / AG_DIA_MS);
      y.push(v);
    });
    if (x.length >= lim.minDias) {
      const lr = linreg(x, y);
      const nivel = median(y);
      const pctSemana = nivel > 0 ? 100 * 7 * lr.slope / nivel : NaN;
      rampa = { slopePerDay: agN(lr.slope, 4), pctPerWeek: agN(pctSemana, 2), r2: agN(lr.r2, 3), nDays: x.length, level: agN(nivel, 3) };
    }
  }

  const anot = cp.ok ? annotateChangePoints(cp.points, ctx.marcos || [], { toleranceDays: 2 }) : null;
  const semMarco = anot ? anot.annotated.filter(a => !a.explained) : [];
  const rampaForte = rampa && isFinite(rampa.pctPerWeek) && Math.abs(rampa.pctPerWeek) >= lim.derivaPctPorSemana && rampa.r2 >= 0.25;

  if (!semMarco.length && !rampaForte) {
    if (!cp.ok && !rampa) return agNaoChecado('deriva', cp.reason || 'série curta demais para procurar mudança de nível',
      'ao menos duas semanas de Timeline');
    return null;
  }

  const evidencia = {
    nChangePoints: cp.ok ? cp.nPoints : 0,
    nUnexplained: semMarco.length,
    unexplained: semMarco.map(a => ({ day: a.dayKey, delta: agN(a.delta, 3), p: agN(a.p, 4) })),
    nMarkersAvailable: anot ? anot.nMarkers : 0,
    trend: rampa,
    aggregation: cp.ok ? cp.aggregation : (serie ? serie.aggregation : null),
    method: 'segmentação binária com CUSUM de duas amostras sobre o valor diário; significância por permutação da janela'
  };

  const achado = semMarco.length
    ? `Houve ${semMarco.length} mudança(s) de nível sem marco correspondente no arquivo` +
      (semMarco.length === 1 ? ` (em ${semMarco[0].dayKey}, variação de ${agN(semMarco[0].delta, 2)})` : '') +
      '. Nenhuma reprogramação, troca de grupo ou evento registrado coincide com elas dentro de 2 dias.'
    : `O nível basal deriva ${agN(rampa.pctPerWeek, 1)}% por semana ao longo de ${rampa.nDays} dias ` +
      `(R² = ${agN(rampa.r2, 2)}), sem degrau identificável — é rampa, não salto.`;

  return agItem(
    'deriva',
    semMarco.length ? 'alta' : 'média',
    achado,
    evidencia,
    'Repetir a sessão de calibração: Survey bipolar completo mais Signal Test de impedância nos dois lados, gerando um ' +
      'passaporte novo, e comparar com o passaporte da sessão anterior (deslocamento do pico, mudança de SNR, troca do ' +
      'par de melhor sinal). Verificar no aparelho o histórico de configuração no intervalo da mudança.',
    'Separa mudança do SINAL de mudança da MEDIDA. Se o passaporte novo reproduz o anterior — mesmo par, mesmo pico, ' +
      'mesma SNR — e a impedância está estável, o degrau é do sinal e merece explicação clínica. Se o pico se deslocou, ' +
      'a impedância mudou ou o par de melhor sinal trocou, a série atravessa duas variáveis diferentes e não deve ser ' +
      'lida como contínua.',
    (cp.ok && cp.nDays >= 21) ? 'média' : 'baixa',
    {
      caveat: 'coincidência temporal não estabelece causa, e a ausência de marco no arquivo não significa que não houve ' +
        'evento — significa que ele não foi registrado. Mudança de rotina, de medicação e de estação do ano não aparecem ' +
        'no arquivo do aparelho'
    }
  );
}

/* ========================================================================= */
/*  5. Configuração instável                                                  */
/* ========================================================================= */

function agConfig(ctx) {
  const b = ctx.blocks;
  if (!b) return agNaoChecado(
    'configuracao',
    'nenhuma análise de blocos de configuração foi fornecida',
    'ao menos duas sessões carregadas com configuração de sensing declarada e data'
  );
  if (!b.ok) return agNaoChecado('configuracao', b.reason || 'não foi possível ler a configuração de sensing',
    'arquivos de sessão que declarem canal de sensing e frequência central');
  if ((b.nBlocks || 0) <= 1 && !(b.changes || []).length) return null;

  const quebras = (b.changes || []).filter(c => c.severity === 'quebra');
  const covar = (b.changes || []).filter(c => c.severity === 'covariável');
  if (!quebras.length && !covar.length) return null;

  const evidencia = {
    nBlocks: b.nBlocks,
    nBreaks: quebras.length,
    nCovariates: covar.length,
    nUndeclared: (b.undeclared || []).length,
    breaks: quebras.slice(0, 6).map(c => ({ day: c.dayLocal, hemisphere: c.hemisphere, field: c.field, from: c.from, to: c.to })),
    attribution: b.attribution,
    bandwidthHz: b.bandwidthHz,
    bandwidthSource: b.bandwidthSource
  };

  return agItem(
    'configuracao',
    quebras.length ? 'alta' : 'média',
    quebras.length
      ? `A configuração de sensing mudou de forma que quebra a comparação: o período está partido em ${b.nBlocks} ` +
        `bloco(s) por ${quebras.length} mudança(s) de par bipolar ou de frequência central. Trechos de blocos ` +
        'diferentes medem variáveis diferentes.'
      : `Houve ${covar.length} mudança(s) de parâmetro que não quebram a escala mas covariam com ela (grupo, amplitude), ` +
        'e que precisam entrar como covariável em qualquer comparação entre períodos.',
    evidencia,
    'Fixar a configuração de sensing para o próximo período: registrar por escrito par bipolar, frequência central e ' +
      'largura de banda de cada lado no início e no fim do intervalo, e gerar um passaporte do biomarcador na sessão ' +
      'que abre o período. Se a comparação com o período anterior for necessária, adquirir um Survey sob a configuração ' +
      'antiga e outro sob a nova na MESMA sessão.',
    'Os dois Surveys na mesma sessão dão o fator de conversão entre as duas escalas, medido no mesmo dia e no mesmo ' +
      'estado — que é a única forma de tornar comparáveis dois trechos registrados sob configurações diferentes. Sem ' +
      'isso, a descontinuidade permanece não interpretável e a série não deve ser plotada como uma linha só.',
    'alta',
    { caveat: b.caveat || 'a largura de banda usada é assumida, não lida do arquivo' }
  );
}

/* ========================================================================= */
/*  6. Passaporte desatualizado                                               */
/* ========================================================================= */

function agPassaporte(ctx, lim) {
  const p = ctx.passport;
  if (!p) return agNaoChecado(
    'passaporte',
    'nenhum passaporte do biomarcador foi fornecido',
    'uma sessão aguda com BrainSense Survey ou Signal Test, que é o que define o biomarcador'
  );
  if (!p.ok) return agNaoChecado('passaporte', p.reason || 'o passaporte não pôde ser montado',
    'uma sessão com espectro utilizável em ao menos um hemisfério');

  const idadeDias = (isFinite(ctx.tFim) && p.createdAt) ? (ctx.tFim - new Date(p.createdAt).getTime()) / AG_DIA_MS : NaN;
  const casa = ctx.passportMatch;
  const naoBate = casa && casa.ok && casa.match === false;
  const velho = isFinite(idadeDias) && idadeDias > lim.passaporteDiasMax;
  const fraco = p.quality && p.quality.nHemispheresUsable === 0;

  if (!naoBate && !velho && !fraco) return null;

  const evidencia = {
    passportFingerprint: p.fingerprint,
    passportCreatedAt: p.createdAt,
    ageDays: agN(idadeDias, 1),
    ageThresholdDays: lim.passaporteDiasMax,
    matchesCurrentConfig: casa && casa.ok ? casa.match : null,
    matchVerdict: casa && casa.ok ? casa.verdict : (casa ? casa.reason : 'configuração vigente não fornecida'),
    nHemispheresUsable: p.quality ? p.quality.nHemispheresUsable : null,
    ecgSuspectedHemispheres: p.quality ? p.quality.ecgSuspectedHemispheres : null
  };

  const achado = naoBate
    ? `A configuração vigente não reproduz o biomarcador do passaporte: ${casa.verdict}.`
    : fraco
      ? 'O passaporte existe mas nenhum hemisfério produziu biomarcador utilizável — a série crônica está sem âncora de escala.'
      : `O passaporte tem ${agN(idadeDias, 0)} dias (acima do limite declarado de ${lim.passaporteDiasMax}); ` +
        'a calibração que ancora a escala desta série pode não valer mais.';

  return agItem(
    'passaporte',
    naoBate ? 'alta' : 'média',
    achado,
    evidencia,
    'Sessão de recalibração: Survey bipolar completo nos dois lados no mesmo estado clínico do Survey anterior (mesmo ' +
      'intervalo desde a última tomada, mesma posição, mesma duração), gerando um passaporte novo para comparar com o ' +
      'antigo par a par.',
    'Se o passaporte novo reproduz o antigo, o que a série crônica mediu continua sendo a mesma variável e a escala se ' +
      'mantém. Se não reproduz, todo período registrado desde a divergência precisa ser tratado como uma segunda ' +
      'variável, e a comparação com o período anterior exige o fator de conversão medido na mesma sessão.',
    naoBate ? 'alta' : 'média',
    {
      caveat: 'a impressão digital do passaporte detecta troca de calibração, não a qualidade dela: dois passaportes ' +
        'idênticos podem ambos estar medindo um canal contaminado'
    }
  );
}

/* ========================================================================= */
/*  7. Cobertura pobre                                                        */
/* ========================================================================= */

/* Cobertura ruim não é um achado sobre o paciente — é um achado sobre o dado, e
   entra na agenda porque a próxima sessão é quando ela pode ser corrigida. O
   ponto delicado é que a falta NÃO é aleatória: o Timeline deixa de gravar
   quando o aparelho está fora de faixa, durante estimulação em certos modos e
   quando o paciente desliga o sensing, e cada uma dessas causas correlaciona
   com estado clínico.                                                       */
function agCobertura(ctx, lim) {
  const g = ctx.grade;
  if (!g || !g.days.length) return agNaoChecado(
    'cobertura', 'não há série crônica com carimbo de tempo utilizável', 'BrainSense Timeline com registros datados'
  );
  const bons = g.coverage.filter(c => c >= lim.coberturaMinDia).length;
  const pctBons = bons / g.days.length;
  const span = g.days.length > 1
    ? Math.round((new Date(g.days[g.days.length - 1] + 'T00:00:00Z') - new Date(g.days[0] + 'T00:00:00Z')) / AG_DIA_MS) + 1
    : 1;
  const diasSemDado = span - g.days.length;

  /* horas sistematicamente vazias — o padrão importa mais que o total */
  const horasVazias = [];
  for (let h = 0; h < 24; h++) if (g.nPerHour[h] < Math.max(1, Math.ceil(g.days.length * 0.25))) horasVazias.push(h);

  if (bons >= lim.coberturaMinDias && !diasSemDado && horasVazias.length <= 2) return null;

  const evidencia = {
    nDaysWithData: g.days.length,
    nDaysSpan: span,
    nDaysWithoutAnyData: diasSemDado,
    nDaysWithCoverage: bons,
    minCoveragePerDay: lim.coberturaMinDia,
    pctDaysWithCoverage: agN(100 * pctBons, 1),
    hoursSystematicallyEmpty: horasVazias,
    nPointsIgnored: g.nIgnored,
    note: 'pontos não finitos foram contados, nunca imputados'
  };

  const achado = horasVazias.length > 2
    ? `A cobertura tem buraco SISTEMÁTICO no dia: ${horasVazias.length} hora(s) (${horasVazias.join(', ')}h) têm dado ` +
      `em menos de um quarto dos dias. ${bons} de ${g.days.length} dias atingem ${Math.round(lim.coberturaMinDia * 100)}% ` +
      'de cobertura.'
    : `Só ${bons} dia(s) atingem ${Math.round(lim.coberturaMinDia * 100)}% de cobertura` +
      (diasSemDado ? `, e ${diasSemDado} dia(s) do intervalo não têm nenhum registro` : '') +
      ` — abaixo dos ${lim.coberturaMinDias} dias que as métricas de ritmo exigem.`;

  return agItem(
    'cobertura',
    horasVazias.length > 2 ? 'alta' : 'média',
    achado,
    evidencia,
    'Antes do próximo período: conferir na sessão a rotina de sincronização do controlador (com que frequência e em que ' +
      'horários o paciente aproxima o controlador), confirmar que o sensing permanece habilitado no grupo em uso e ' +
      'documentar os horários em que o aparelho fica fora de alcance. Repetir o período de registro com essa rotina ' +
      'anotada dia a dia.',
    'Diz se a falta é técnica ou comportamental, e isso muda a interpretação de tudo o que veio antes. Se as horas ' +
      'vazias coincidem com sono, banho ou trabalho, a falta correlaciona com estado clínico e as médias por hora são ' +
      'enviesadas de forma não corrigível; se é falha de sincronização, o próximo período pode ser completo.',
    'alta',
    {
      caveat: 'perda de dado no Timeline não é aleatória: ela depende de proximidade do controlador, de modo de ' +
        'estimulação e de comportamento do paciente. Nenhuma métrica deste software imputa o que falta, mas nenhuma ' +
        'delas corrige o viés de a falta ser seletiva'
    }
  );
}

/* ========================================================================= */
/*  8. Ritmo fragmentado ou instável                                          */
/* ========================================================================= */

function agFragmentacao(ctx, lim) {
  const a = ctx.actigraphy;
  if (!a || !a.ok) return agNaoChecado(
    'ritmo',
    (a && a.reason) || 'não foi possível calcular as métricas não paramétricas de ritmo',
    'ao menos 3 dias com dois terços dos bins horários preenchidos'
  );
  const frag = isFinite(a.IV) && a.IV >= lim.ivFragmentado;
  const instavel = isFinite(a.IS) && a.IS <= lim.isInstavel;
  if (!frag && !instavel) return null;

  const cos = ctx.cosinor;
  const evidencia = {
    IS: agN(a.IS, 3), IV: agN(a.IV, 3), RA: agN(a.RA, 3),
    M10startHour: a.M10startHour, L5startHour: a.L5startHour,
    isThreshold: lim.isInstavel, ivThreshold: lim.ivFragmentado,
    nDaysUsed: a.quality ? a.quality.nDaysUsed : null,
    nDaysExcluded: a.quality ? a.quality.nDaysExcluded : null,
    cosinorAmplitudePct: cos && isFinite(cos.amplitudePct) ? agN(cos.amplitudePct, 1) : NaN,
    cosinorP: cos && isFinite(cos.p) ? agN(cos.p, 4) : NaN
  };

  return agItem(
    'ritmo',
    'baixa',
    (frag && instavel)
      ? `O ritmo é ao mesmo tempo fragmentado dentro do dia (IV = ${agN(a.IV, 2)}) e pouco reprodutível entre dias ` +
        `(IS = ${agN(a.IS, 2)}): o perfil de 24 h explica pouco desta série.`
      : frag
        ? `O ritmo é fragmentado dentro do dia (IV = ${agN(a.IV, 2)}, acima de ${lim.ivFragmentado}): há muita variação ` +
          'de hora para hora em relação à variação total.'
        : `O ritmo se repete pouco de um dia para o outro (IS = ${agN(a.IS, 2)}, abaixo de ${lim.isInstavel}).`,
    evidencia,
    'Sessão com registro simultâneo de contexto: streaming de LFP em blocos ao longo de um dia inteiro, se possível, ou ' +
      'no mínimo em três horários fixos (manhã, tarde e noite), com actigrafia ou acelerômetro de pulso gravando em ' +
      'paralelo e marca comum de sincronização no início e no fim de cada bloco, e com diário de sono e de tomadas ' +
      'preenchido no momento, não em retrospecto.',
    'Diz se a fragmentação é do sinal neural ou do comportamento que o gera. Um IV alto num paciente com sono ' +
      'fragmentado documentado por actigrafia é consequência do sono; o mesmo IV num paciente com actigrafia normal é ' +
      'achado do sinal. Sem a medida paralela, rotular o estado a partir do próprio beta é circular.',
    'baixa',
    {
      caveat: 'IS e IV são descritivos e não testam nada; e a série do Timeline não é actigrafia — os limiares vieram da ' +
        'cronobiologia da actigrafia e não foram validados para potência em banda de LFP. São usados aqui como ordem de ' +
        'grandeza, e é por isso que a prioridade deste item é baixa'
    }
  );
}

/* ========================================================================= */
/*  sessionAgenda                                                             */
/* ========================================================================= */

/* sessionAgenda(entrada, opts)

   entrada = {
     rows:          { Left: [{t, lfp}], Right: [{t, lfp}] }  — Timeline por hemisfério
     offMin:        deslocamento do fuso em minutos
     doseTimes:     [epoch ms] das tomadas marcadas (opcional)
     markers:       [{t, label}] reprogramações e eventos conhecidos (opcional)
     blocks:        saída de configBlocks (opcional)
     passport:      saída de biomarkerPassport (opcional)
     passportMatch: saída de passportMatchesConfig (opcional)
     alarm:         saída de artifactAlarm (opcional) — só entra no resumo
   }

   opts = { thresholds, aggregation ('median'|'mean'), seed, hemisphere }

   Devolve { ok, items[], notChecked[], nItems, summary, reading, params,
             disclaimer }. `items` ordenado por prioridade e, dentro dela, pela
   ordem de verificação.                                                     */
export function sessionAgenda(entrada, opts) {
  opts = opts || {};
  const e = entrada || {};
  const lim = Object.assign({}, AGENDA_PADRAO, opts.thresholds || {});
  const offMin = isFinite(e.offMin) ? e.offMin : 0;
  const agregacao = opts.aggregation === 'mean' ? 'mean' : 'median';
  const seed = isFinite(opts.seed) ? opts.seed : 20240517;

  const rows = e.rows || {};
  const byHemisphere = {};
  ['Left', 'Right'].forEach(h => { byHemisphere[h] = agSerieDiaria(rows[h] || [], offMin, agregacao); });

  /* hemisfério principal: o que tiver mais dias com dado, salvo escolha
     explícita. Declarado na saída, porque muda todos os números de série única */
  const escolhido = ['Left', 'Right'].indexOf(opts.hemisphere) >= 0
    ? opts.hemisphere
    : (byHemisphere.Left.days.length >= byHemisphere.Right.days.length ? 'Left' : 'Right');
  const principal = (rows[escolhido] || []).filter(r => r && isFinite(r.t) && isFinite(r.lfp));

  if (!principal.length && !byHemisphere.Left.days.length && !byHemisphere.Right.days.length) return {
    ok: false, version: AGENDA_VERSION, items: [], notChecked: [], nItems: 0,
    reason: 'não há BrainSense Timeline utilizável neste arquivo — a agenda da próxima sessão é construída a partir do ' +
      'registro crônico, e sem ele não há o que o crônico tenha observado',
    disclaimer: AG_DISCLAIMER
  };

  const tempos = principal.map(r => r.t);
  const ctx = {
    offMin, seed, principal, byHemisphere, hemisphere: escolhido,
    doseTimes: (e.doseTimes || []).filter(isFinite),
    marcos: e.markers || [],
    blocks: e.blocks || null,
    passport: e.passport || null,
    passportMatch: e.passportMatch || null,
    tInicio: tempos.length ? Math.min.apply(null, tempos) : NaN,
    tFim: tempos.length ? Math.max.apply(null, tempos) : NaN,
    grade: agGradeHoraria(principal, offMin),
    serieDiaria: byHemisphere[escolhido],
    configAssimetrica: agConfigAssimetrica(e.blocks)
  };
  ctx.m10l5 = m10l5(principal, offMin, {});
  ctx.actigraphy = actigraphyPanel(principal, offMin, {});
  ctx.cosinor = agCosinor(principal, offMin);

  const checagens = [
    ['assimetria', () => agAssimetria(ctx, lim)],
    ['dose', () => agDose(ctx, lim)],
    ['circadiano', () => agCircadiano(ctx, lim)],
    ['deriva', () => agDeriva(ctx, lim)],
    ['configuracao', () => agConfig(ctx, lim)],
    ['passaporte', () => agPassaporte(ctx, lim)],
    ['cobertura', () => agCobertura(ctx, lim)],
    ['ritmo', () => agFragmentacao(ctx, lim)]
  ];

  const items = [], notChecked = [];
  checagens.forEach(([id, fn]) => {
    let r;
    try { r = fn(); } catch (err) {
      notChecked.push(agNaoChecado(id, 'a verificação falhou: ' + (err && err.message ? err.message : String(err)),
        'nada a fazer no dado — é falha do próprio módulo e deve ser reportada'));
      return;
    }
    if (!r) return;                          /* verificado, nada encontrado   */
    if (r.whyNot) { notChecked.push(r); return; }
    items.push(r);
  });

  items.sort((a, b) => a.rank - b.rank);
  const nAlta = items.filter(i => i.priority === 'alta').length;
  const verificadas = checagens.length - notChecked.length;

  const resumo = !items.length
    ? (notChecked.length
      ? `Nenhum achado nas ${verificadas} verificação(ões) que o dado permitiu. ${notChecked.length} não puderam ser feitas.`
      : `Nenhum achado nas ${checagens.length} verificações, todas realizadas.`)
    : `${items.length} item(ns) para a próxima sessão` + (nAlta ? `, ${nAlta} de prioridade alta` : '') +
      `. ${verificadas} de ${checagens.length} verificações realizadas.`;

  return {
    ok: true,
    version: AGENDA_VERSION,
    items,
    notChecked,
    nItems: items.length,
    nHighPriority: nAlta,
    nChecksRun: verificadas,
    nChecksTotal: checagens.length,
    summary: resumo,
    reading: items.length
      ? items.map((i, k) => `${k + 1}. [${i.priority}] ${i.finding}`).join(' ')
      : resumo,
    params: {
      hemisphere: escolhido,
      hemisphereNote: opts.hemisphere ? 'hemisfério escolhido pelo usuário' : 'hemisfério com mais dias de dado',
      aggregation: agregacao === 'mean' ? 'média' : 'mediana',
      offsetMinutes: offMin,
      thresholds: lim,
      seed,
      nDoseMarks: ctx.doseTimes.length,
      nMarkers: ctx.marcos.length,
      hasBlocks: !!ctx.blocks,
      hasPassport: !!(ctx.passport && ctx.passport.ok),
      periodStart: isFinite(ctx.tInicio) ? new Date(ctx.tInicio).toISOString() : null,
      periodEnd: isFinite(ctx.tFim) ? new Date(ctx.tFim).toISOString() : null,
      nDays: ctx.grade.days.length
    },
    /* o alarme não gera item de agenda — ele é sobre o dado que já está na tela
       e tem urgência própria. Entra aqui só para que o relatório possa dizer
       que a agenda foi montada sobre um canal que talvez não devesse ser lido */
    artifactNote: agNotaAlarme(e.alarm),
    incompletenessNote: notChecked.length
      ? `${notChecked.length} verificação(ões) não puderam ser feitas com este dado. Ausência de verificação não é ` +
        'ausência de achado: veja `notChecked` para o motivo de cada uma e o que seria necessário.'
      : 'todas as verificações previstas foram realizadas com este dado',
    disclaimer: AG_DISCLAIMER
  };
}

const AG_DISCLAIMER =
  'Esta é uma AGENDA DE INVESTIGAÇÃO: uma lista de perguntas que a próxima sessão aguda poderia responder, com o ' +
  'protocolo de aquisição que as responderia. Não é conduta terapêutica, não sugere programação de estimulação nem ' +
  'ajuste de medicação, e não substitui o software regulado do fabricante. Todo item nasce de série observacional, ' +
  'em que associação temporal não estabelece causa — é exatamente por isso que ele vira experimento em vez de conclusão.';

/* Os dois hemisférios estão na mesma configuração de sensing? Só é possível
   responder quando há bloco de configuração; sem ele a resposta é `null`, que
   é diferente de `false`.                                                   */
function agConfigAssimetrica(blocks) {
  if (!blocks || !blocks.ok || !Array.isArray(blocks.blocks) || !blocks.blocks.length) return null;
  const c = blocks.blocks[blocks.blocks.length - 1].config;
  if (!c || !c.byHemisphere) return null;
  const E = c.byHemisphere.Left, D = c.byHemisphere.Right;
  if (!E || !D || !E.declared || !D.declared) return null;
  const canalDif = E.channel != null && D.channel != null && E.channel !== D.channel;
  const freqDif = isFinite(E.centerFreq) && isFinite(D.centerFreq) && Math.abs(E.centerFreq - D.centerFreq) > 1;
  return canalDif || freqDif;
}

/* Cosinor de 24 h sobre a série, tolerante a falhas — serve só de contexto no
   item de fragmentação, e por isso não vale interromper a agenda se falhar.  */
function agCosinor(rows, offMin) {
  try {
    const h = [], y = [];
    rows.forEach(r => { h.push((r.t - rows[0].t) / 3600000); y.push(r.lfp); });
    const c = cosinor(h, y, [24]);
    if (!c || !c.components || !c.components.length) return null;
    const nivel = median(y);
    const amp = c.components[0].amplitude;
    return Object.assign({}, c, { amplitude: amp, amplitudePct: nivel > 0 ? 100 * amp / nivel : NaN });
  } catch (err) { return null; }
}

/* Nota sobre o alarme de artefato, quando ele foi fornecido. */
function agNotaAlarme(alarm) {
  if (!alarm) return 'nenhum alarme de artefato foi fornecido — a agenda não sabe se o canal analisado é interpretável';
  if (!alarm.ok) return 'o alarme de artefato não pôde ser avaliado neste arquivo';
  const graves = (alarm.alarms || []).filter(i => i.verdict === 'não interprete este canal').length;
  if (graves) return `ATENÇÃO: o alarme de artefato marcou ${graves} canal(is) como não interpretável(is). Reveja o ` +
    'alarme antes de agendar qualquer coisa a partir destes achados — investigar um artefato consome uma sessão à toa';
  return 'o alarme de artefato não marcou nenhum canal como não interpretável';
}
