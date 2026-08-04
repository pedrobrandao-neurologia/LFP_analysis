/* metrics/passport.js — PASSAPORTE DO BIOMARCADOR.

   POR QUE ESTE MÓDULO EXISTE. A sessão aguda não é "mais um exame": é o ato que
   DEFINE o biomarcador daquele paciente. Nela se decide qual par bipolar
   carrega o sinal, em que frequência está o pico, qual a largura de banda que
   o contém, quanto o pico se destaca do fundo aperiódico, e se o registro está
   contaminado por ECG. Tudo o que vier depois — meses de BrainSense Timeline,
   comparações antes/depois de ajuste de dose, curvas circadianas — é medido
   ATRAVÉS dessa definição.

   O problema que isso resolve. O Timeline do Percept devolve um único número
   por amostra: a potência dentro de uma janela estreita ao redor de uma
   frequência central, num par bipolar, com um ganho. Troque o par, desloque a
   frequência central 3 Hz, mude a banda, troque o gerador — e o número continua
   se chamando "LFP", continua sendo plotado no mesmo eixo, e não é mais a mesma
   variável. Comparar dois meses de Timeline sem verificar isso é comparar duas
   grandezas diferentes com o mesmo nome. Foi por isso que o campo passou a
   exigir que a configuração de sensing seja reportada junto de qualquer série
   crônica (Neumann et al., Brain Stimul 2021; Swinnen et al., J Neural Eng
   2025 — checklist de reporte).

   O QUE O PASSAPORTE É. Um objeto pequeno, versionado, determinístico e
   comparável, que registra: o par escolhido, o pico, a banda, a relação
   sinal-ruído com definição declarada, o expoente aperiódico e o R² do ajuste,
   as bandeiras de qualidade, os PARÂMETROS de todas as escolhas, e uma
   impressão digital curta do próprio conteúdo. Ele é a ponte entre a sessão
   aguda e o registro crônico: `passportMatchesConfig` diz se o aparelho está
   medindo o que o passaporte definiu, e `passportCompare` diz se a definição
   sobreviveu ao tempo.

   O QUE O PASSAPORTE NÃO É. Não é prescrição, não é programação, não é
   diagnóstico. `passportSensingSuggestion` produz uma SUGESTÃO de parâmetros
   que precisa ser conferida e inserida pelo profissional no programador do
   fabricante. Este software é ferramenta de pesquisa e apoio à decisão.

   PSEUDONIMIZAÇÃO. Só entram no passaporte os hashes já produzidos pelo parser
   (`patient.idHash`, `device.snHash`). Nome, data de nascimento, PatientId,
   número de série e nome do arquivo NÃO entram — nem no conteúdo, nem no texto
   canônico de onde sai a impressão digital.

   DETERMINISMO. `createdAt` é a data da SESSÃO que definiu o biomarcador, e não
   o instante em que o objeto foi montado. É uma escolha deliberada: assim o
   mesmo arquivo produz sempre o mesmo passaporte, byte a byte, e a impressão
   digital serve de fato para detectar mudança de calibração. Nenhuma etapa
   deste módulo é estocástica — não há sorteio a semear (ver `params.seedNote`).

   CONTROVÉRSIAS DECLARADAS (a UI oferece a escolha, o resultado registra qual
   foi usada — ver `params` e `controversy`):
     • banda a priori (13–35 Hz) versus banda centrada no maior pico. A primeira
       é comparável entre pacientes e não depende do dado; a segunda respeita a
       frequência individual, que varia bastante no STN e mais ainda no GPi.
     • pico do espectro bruto versus pico do resíduo acima do fundo 1/f. O
       espectro bruto enviesa o pico para baixo, porque o 1/f decresce dentro da
       banda; corrigir pelo aperiódico é o padrão desde Donoghue et al. (2020),
       mas depende de um ajuste que pode não convergir.

   UNIDADES. f em Hz; `magnitude` na unidade do arquivo (µVp/√Hz no LFPMontage
   do Percept, µV²/Hz num PSD); `snrDb` em dB, com a definição escrita em
   `snrDefinition` e a origem do espectro em `spectrumSource` — dB de magnitude
   e dB de potência NÃO são intercambiáveis (ver comentário de `passportSnrDb`).

   Referências:
     Neumann W-J, et al. Brain Stimul 2021;14:1301-1306 (escolha do contato de
       sensing pelo beta; necessidade de declarar a configuração).
     Donoghue T, et al. Nat Neurosci 2020;23:1655-1665 (separar componente
       periódico do aperiódico antes de comparar bandas).
     Swinnen BEKS, et al. J Neural Eng 2025;22:014001 (checklist de reporte de
       LFP crônico: canal, frequência central, banda, estado do estimulador).
     Thenaisie Y, et al. J Neural Eng 2021;18:042002 (sensing crônico do Percept
       e suas dependências de configuração).
     van Rheede JJ, et al. npj Parkinsons Dis 2022;8:88 (contaminação por ECG
       como critério de exclusão em séries crônicas).                          */

import { rankSurveyChannels } from './survey.js';
import { peakInBand, pickSpectrum, HEMIS } from './acute.js';
import { fitAperiodic } from '../dsp/aperiodic.js';
import { prettyChannel } from '../io/parse.js';
import { rnd } from '../stats/descriptive.js';
import { detectRPeaks } from '../artifact/rpeaks.js';

/* Versão do FORMATO do passaporte. Muda quando um campo muda de significado —
   um passaporte de versão diferente não deve ser comparado sem revisão. */
export const PASSPORT_VERSION = 1;

/* ======================================================================== */
/*  Auxiliares locais (prefixo `passport` porque o build concatena todos os  */
/*  módulos num único escopo)                                                */
/* ======================================================================== */

/* passportArea(f, y, lo, hi) — área sob a curva entre lo e hi pela regra do
   trapézio, PULANDO segmentos que tocam valor não finito.

   Pular é imputação disfarçada: o intervalo integrado encolhe sem aviso. Por
   isso a função devolve também o vão coberto e o vão pedido, e quem chama
   reporta a cobertura. Unidades: [y]×Hz.                                     */
function passportArea(f, y, lo, hi) {
  let s = 0, coberto = 0;
  for (let i = 1; i < f.length; i++) {
    const f0 = f[i - 1], f1 = f[i];
    if (f1 < lo || f0 > hi) continue;
    const a = y[i - 1], b = y[i];
    if (!isFinite(a) || !isFinite(b)) continue;
    s += 0.5 * (a + b) * (f1 - f0);
    coberto += (f1 - f0);
  }
  return { area: s, spanCovered: coberto, spanRequested: Math.max(0, hi - lo) };
}

/* Índice do elemento mais próximo de `alvo` (array ordenado ou não). */
function passportNearestIdx(xs, alvo) {
  let melhor = -1, dist = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const d = Math.abs(xs[i] - alvo);
    if (d < dist) { dist = d; melhor = i; }
  }
  return melhor;
}

/* passportHash32(texto) — FNV-1a de 32 bits, em hexadecimal.

   PARA QUE SERVE E PARA QUE NÃO SERVE. Serve para responder "este passaporte é
   o mesmo de antes?" — troca de calibração, arquivo recarregado, parâmetro
   alterado. NÃO é função criptográfica: é curta (32 bits, ~4,3×10⁹ valores),
   não tem resistência a colisão deliberada, e não protege nada. Foi escrita
   aqui, e não importada, porque o projeto não usa dependências e o núcleo roda
   sem `crypto`. Mesma família do `hashId` do parser, propositalmente. */
function passportHash32(texto) {
  const s = String(texto == null ? '' : texto);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return ('00000000' + h.toString(16)).slice(-8);
}

/* Chave normalizada de canal, para comparar rótulos vindos de fontes
   diferentes: 'ZERO_AND_TWO_LEFT', 'ZERO_TWO_LEFT', '0-2' e '02' são o mesmo
   par bipolar escrito de quatro maneiras. */
function passportChannelKey(c) {
  if (c == null || c === '') return '';
  const semPrefixo = String(c).includes('.') ? String(c).split('.').pop() : String(c);
  return prettyChannel(semPrefixo).replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

/* passportSnrDb(ap, lo, hi) — relação sinal-ruído do biomarcador, em dB.

   DEFINIÇÃO (declarada e exportada junto do valor, porque "SNR" sem definição
   é um número sem significado):

       snrDb = 10·log10( A⁺ / A_fundo )

   onde A⁺ é a área do resíduo POSITIVO acima do fundo aperiódico dentro da
   banda [lo, hi], e A_fundo é a área do próprio fundo aperiódico ajustado na
   MESMA banda. Resíduo negativo não conta: espectro abaixo do próprio fundo
   ajustado é falha do ajuste, não "oscilação negativa".

   RESSALVA DE UNIDADE. O fator 10 pressupõe que a grandeza integrada é
   POTÊNCIA. O LFPMontage do Percept exporta MAGNITUDE (µVp/√Hz); nesse caso o
   valor continua sendo uma razão adimensional expressa na convenção 10·log10,
   mas não é o mesmo dB que se obteria de um PSD. Por isso `spectrumScale`
   acompanha o valor, e comparar `snrDb` entre passaportes exige mesma origem
   de espectro. Entrada: f em Hz, y na unidade do arquivo. Saída: dB.         */
function passportSnrDb(ap, lo, hi) {
  if (!ap) return { db: NaN, signal: NaN, background: NaN, reason: 'sem ajuste do fundo aperiódico' };
  const positivo = ap.periodic.map(v => (isFinite(v) && v > 0) ? v : 0);
  const sinal = passportArea(ap.f, positivo, lo, hi);
  const fundo = passportArea(ap.f, ap.aperiodic, lo, hi);
  if (!(fundo.area > 0))
    return { db: NaN, signal: sinal.area, background: fundo.area, reason: 'fundo aperiódico nulo ou negativo na banda — razão indefinida' };
  if (!(sinal.area > 0))
    return {
      db: NaN, signal: 0, background: fundo.area,
      reason: 'não há excesso sobre o fundo aperiódico dentro da banda — não é possível definir relação sinal-ruído'
    };
  return { db: 10 * Math.log10(sinal.area / fundo.area), signal: sinal.area, background: fundo.area, reason: null };
}

/* passportEcgFlag(parsed, hemi, artefatoDoDispositivo, opts)

   Contaminação cardíaca é critério de exclusão documentado em séries crônicas
   (van Rheede et al. excluíram 2 de 12 STN) e causa conhecida de maladaptação
   em aDBS. A única evidência que sustenta a afirmação "há ECG" é a detecção de
   picos R no domínio do tempo com ritmo fisiológico — a bandeira ArtifactStatus
   do próprio aparelho não diz a ORIGEM do artefato (pode ser movimento,
   estimulação ou ECG) e por isso NÃO liga `ecgSuspected`; ela é reportada em
   separado, como `artifactFlagged`.

   TRÊS ESTADOS, E NÃO DOIS. Um booleano sozinho mente aqui: `false` acabaria
   significando ao mesmo tempo "procurei e não achei" e "o detector não deu
   resposta confiável". São coisas diferentes, e a segunda é comum — a detecção
   de picos R dentro do LFP perde batimentos quando o QRS é pequeno em relação
   ao sinal cerebral, e a cadência estimada cai para um subharmônico da real.
   Por isso `ecgVerdict` assume 'suspeito', 'inconclusivo', 'sem evidência' ou
   'não avaliado', e `ecgSuspected` só é `true` no primeiro caso. Um veredito
   'inconclusivo' NÃO é ausência de artefato: é pedido de ECG externo.

   Entrada: sinal em µV, fs em Hz. Saída: bandeiras, veredito e bpm.           */
function passportEcgFlag(parsed, hemi, artefatoDoDispositivo, opts) {
  const rotulo = String(artefatoDoDispositivo || '');
  /* 'ARTIFACT_NOT_PRESENT' contém 'PRESENT': a negativa é testada primeiro */
  const artifactFlagged = !!rotulo && !/NOT_PRESENT|NOT_DETECTED/i.test(rotulo) && /PRESENT|DETECTED/i.test(rotulo);
  const base = { ecgSuspected: false, artifactFlagged, artifactStatus: rotulo || null, ecgBpm: NaN, ecgNBeats: 0 };

  if (opts.checkEcg === false) return Object.assign({}, base, {
    ecgVerdict: 'não avaliado', ecgEvaluable: false,
    ecgEvidence: 'verificação de ECG desligada por parâmetro (checkEcg: false) — nada foi procurado'
  });

  const td = (parsed.bsTimeDomain || []).find(t => t.hemisphere === hemi)
    || (parsed.montageTD || []).find(t => t.hemisphere === hemi);
  const fs = td ? (td.fsEff || td.fs) : NaN;
  if (!td || !td.data || !isFinite(fs) || td.data.length < 10 * fs) return Object.assign({}, base, {
    ecgVerdict: 'não avaliado', ecgEvaluable: false,
    ecgEvidence: 'não há sinal no domínio do tempo suficiente (≥ 10 s) neste hemisfério — a contaminação por ECG NÃO foi ' +
      'avaliada; ausência de bandeira aqui não é ausência de artefato'
  });

  /* teto de duração: a correlação de template é O(n·m) e o diagnóstico não
     melhora com mais minutos — o trecho analisado sai declarado */
  const maxS = isFinite(opts.ecgMaxSeconds) ? opts.ecgMaxSeconds : 60;
  const nMax = Math.max(1, Math.round(maxS * fs));
  const trecho = td.data.length > nMax ? td.data.slice(0, nMax) : td.data;
  const det = detectRPeaks(trecho, fs, {});
  const fisiologico = isFinite(det.bpm) && det.bpm >= 40 && det.bpm <= 180;
  const forte = det.nDetected >= 8 && fisiologico && det.confidence === 'alta';

  let ecgVerdict, ecgEvidence;
  if (forte) {
    ecgVerdict = 'suspeito';
    ecgEvidence = `picos R detectados no próprio LFP (${det.nDetected} batimentos, ${rnd(det.bpm, 0)} bpm, confiança alta) — ` +
      'a série crônica derivada deste canal pode carregar componente cardíaco; considere outro par bipolar ou limpeza do sinal';
  } else if (det.nDetected >= 5) {
    ecgVerdict = 'inconclusivo';
    ecgEvidence = `o detector encontrou ${det.nDetected} candidatos a pico R (${rnd(det.bpm, 0)} bpm, confiança ${det.confidence})` +
      (fisiologico ? '' : ', com cadência fora da faixa fisiológica de 40–180 bpm — típico de batimentos perdidos, que rebaixam a taxa a um subharmônico') +
      '. NÃO é possível afirmar nem descartar contaminação cardíaca com este dado: registrar um canal de ECG externo na ' +
      'próxima sessão resolveria a dúvida' + (det.reason ? ` (${det.reason})` : '');
  } else {
    ecgVerdict = 'sem evidência';
    ecgEvidence = `apenas ${det.nDetected} candidato(s) a pico R em ${rnd(trecho.length / fs, 0)} s — não há evidência de ` +
      'contaminação cardíaca neste trecho; um QRS de amplitude muito pequena ainda assim passaria despercebido';
  }

  return Object.assign({}, base, {
    ecgSuspected: forte, ecgVerdict, ecgEvaluable: true,
    ecgBpm: rnd(det.bpm, 1), ecgNBeats: det.nDetected, ecgConfidence: det.confidence,
    ecgSecondsAnalyzed: rnd(trecho.length / fs, 1),
    ecgEvidence
  });
}

/* passportPickChannel(parsed, hemi, ranking) — escolhe o par bipolar do
   hemisfério. Prioridade: o rank 1 ENTRE OS ORDENÁVEIS do Survey; se nenhum for
   ordenável, o rank 1 mesmo assim, marcado; se não houver Survey, o espectro
   que `pickSpectrum` conseguir (Signal Test, Signal Check, Welch). */
function passportPickChannel(parsed, hemi, ranking) {
  const lista = ranking && ranking.hemispheres ? (ranking.hemispheres[hemi] || []) : [];
  if (lista.length) {
    const ordenaveis = lista.filter(c => c.rankable);
    const esc = ordenaveis.length ? ordenaveis[0] : lista[0];
    return {
      channel: esc.electrodes || esc.label || '', label: esc.label || esc.electrodes || '',
      f: esc.f, y: esc.mag,
      rank: isFinite(esc.rank) ? esc.rank : NaN,
      nCandidates: lista.length, nRankable: ordenaveis.length,
      artifact: esc.artifact || '',
      spectrumSource: 'Survey (LFPMontage)', spectrumScale: 'magnitude',
      selection: ordenaveis.length ? 'ranking do Survey' : 'primeiro do Survey sem ajuste aperiódico utilizável',
      rankable: !!esc.rankable, nRecords: esc.nRecords
    };
  }
  const spec = pickSpectrum(parsed, hemi);
  if (!spec || !spec.f || !spec.f.length) return null;
  return {
    channel: spec.channel || '', label: prettyChannel(spec.channel || '') || (spec.channel || ''),
    f: spec.f, y: spec.p,
    rank: NaN, nCandidates: 1, nRankable: 0,
    artifact: spec.artifact || '',
    spectrumSource: spec.source, spectrumScale: /Welch|SignalTest|SignalCheck/i.test(String(spec.source)) ? 'potência' : 'magnitude',
    selection: 'sem BrainSense Survey neste arquivo — usado o único espectro disponível, sem comparação entre pares',
    rankable: false, nRecords: 1
  };
}

/* Monta o bloco de um hemisfério. Devolve sempre um objeto: quando não dá para
   definir o biomarcador, `usable: false` e `reason` em português dizendo por
   quê — preferível a um número frágil. */
function passportHemiBlock(parsed, hemi, ranking, cfg) {
  const esc = passportPickChannel(parsed, hemi, ranking);
  if (!esc) return {
    channel: null, label: null, peakHz: NaN, bandLo: NaN, bandHi: NaN, snrDb: NaN, magnitude: NaN,
    aperiodicExponent: NaN, aperiodicR2: NaN, peakSurvivesAperiodic: false,
    ecgSuspected: false, ecgVerdict: 'não avaliado', ecgEvaluable: false, artifactFlagged: false,
    rank: NaN, nCandidates: 0, usable: false,
    reason: 'não há nenhum espectro para este hemisfério neste arquivo — sem sessão aguda não há biomarcador a definir'
  };

  const f = esc.f, y = esc.y;
  const fmaxDisp = f[f.length - 1];
  const ap = fitAperiodic(f, y, { fmin: 2, fmax: Math.min(95, fmaxDisp) });
  const r2 = ap && isFinite(ap.r2) ? ap.r2 : NaN;

  /* --- pico: corrigido pelo aperiódico quando possível, bruto como recuo --- */
  const dentro = ap ? ap.peaks.filter(pk => pk.cf >= cfg.bandSearch[0] && pk.cf <= cfg.bandSearch[1]) : [];
  const bruto = peakInBand(f, y, cfg.bandSearch[0], cfg.bandSearch[1]);
  let peakHz = NaN, peakSource = null;
  if (cfg.peakSource === 'raw') { peakHz = bruto.f; peakSource = 'pico do espectro bruto na banda'; }
  else if (dentro.length) { peakHz = dentro[0].cf; peakSource = 'pico do resíduo acima do fundo aperiódico'; }
  else { peakHz = bruto.f; peakSource = 'pico do espectro bruto na banda (o ajuste aperiódico não encontrou pico distinguível)'; }

  /* --- o pico sobrevive à separação do aperiódico? -----------------------
     Dois requisitos, e ambos importam: existir um máximo local no resíduo
     dentro da banda, E esse máximo exceder o fundo em pelo menos
     `minPeakOverBackground` (fração). Só o primeiro não basta — no resíduo de
     um espectro liso qualquer ondulação numérica vira "pico". */
  let excessoRel = NaN;
  if (ap && isFinite(peakHz)) {
    const i = passportNearestIdx(ap.f, peakHz);
    if (i >= 0 && ap.aperiodic[i] > 0) excessoRel = ap.periodic[i] / ap.aperiodic[i];
  }
  const peakSurvivesAperiodic = !!(ap && dentro.length && isFinite(excessoRel) && excessoRel >= cfg.minPeakOverBackground);

  /* --- banda ------------------------------------------------------------- */
  let bandLo = cfg.bandSearch[0], bandHi = cfg.bandSearch[1], bandNote = null;
  if (cfg.bandMode === 'peak') {
    if (isFinite(peakHz)) {
      bandLo = Math.max(f[0], peakHz - cfg.peakBandwidthHz / 2);
      bandHi = Math.min(fmaxDisp, peakHz + cfg.peakBandwidthHz / 2);
      bandNote = `banda centrada no pico individual (${cfg.peakBandwidthHz} Hz de largura total)`;
    } else {
      bandNote = 'banda centrada no pico foi pedida, mas não há pico localizável — mantida a banda a priori';
    }
  } else {
    bandNote = 'banda a priori, igual para todos os sujeitos';
  }

  /* --- cobertura da banda: quantos pontos do eixo original são utilizáveis -
     integrar pulando NaN encolhe o intervalo em silêncio; aqui a perda é
     contada e vira critério de usabilidade */
  let nBanda = 0, nFinitos = 0;
  for (let i = 0; i < f.length; i++) {
    if (f[i] < bandLo || f[i] > bandHi) continue;
    nBanda++;
    if (isFinite(y[i]) && y[i] > 0) nFinitos++;
  }
  const coberturaPct = nBanda > 0 ? 100 * nFinitos / nBanda : NaN;

  /* --- magnitude no pico: janela estreita (±1 Hz), e não o máximo da banda
     inteira, que poderia cair longe do pico declarado ---------------------- */
  const mg = isFinite(peakHz) ? peakInBand(f, y, peakHz - 1, peakHz + 1) : { f: NaN, v: NaN };

  const snr = passportSnrDb(ap, bandLo, bandHi);
  const ecg = passportEcgFlag(parsed, hemi, esc.artifact, cfg.opts);

  /* --- usabilidade: a pergunta é "este passaporte pode ancorar a escala de
     uma série crônica?". Qualquer não abaixo derruba. -------------------- */
  let usable = true, reason = null;
  if (!ap) { usable = false; reason = 'o ajuste do fundo aperiódico não convergiu (poucos pontos válidos no espectro) — sem ele não há como separar oscilação de 1/f'; }
  else if (!(r2 >= cfg.minAperiodicR2)) { usable = false; reason = `o ajuste do fundo aperiódico explica pouco do espectro (R² = ${rnd(r2, 3)}, mínimo exigido ${cfg.minAperiodicR2}) — as métricas corrigidas seriam frágeis`; }
  else if (!peakSurvivesAperiodic) { usable = false; reason = `não há pico distinguível do fundo aperiódico em ${cfg.bandSearch[0]}–${cfg.bandSearch[1]} Hz (excesso sobre o fundo = ${isFinite(excessoRel) ? rnd(100 * excessoRel, 1) + '%' : 'indefinido'}, mínimo exigido ${rnd(100 * cfg.minPeakOverBackground, 0)}%) — não é possível definir um biomarcador espectral com este dado`; }
  else if (!isFinite(snr.db)) { usable = false; reason = 'relação sinal-ruído indefinida: ' + (snr.reason || 'razão não calculável'); }
  else if (!(coberturaPct >= cfg.minBandCoveragePct)) { usable = false; reason = `só ${rnd(coberturaPct, 1)}% dos pontos do espectro dentro da banda são válidos (mínimo ${cfg.minBandCoveragePct}%) — a área integrada não representa a banda`; }
  else if (!esc.rankable) { reason = 'o par não foi ordenado contra outros pares comparáveis (' + esc.selection + ') — confira manualmente antes de usar como referência'; }

  return {
    channel: esc.channel, label: esc.label,
    peakHz: rnd(peakHz, 2),
    bandLo: rnd(bandLo, 2), bandHi: rnd(bandHi, 2),
    snrDb: rnd(snr.db, 2),
    magnitude: rnd(mg.v, 4),
    aperiodicExponent: ap ? rnd(ap.exponent, 3) : NaN,
    aperiodicR2: rnd(r2, 3),
    peakSurvivesAperiodic,
    ecgSuspected: ecg.ecgSuspected, ecgVerdict: ecg.ecgVerdict,
    rank: esc.rank, nCandidates: esc.nCandidates,
    usable, reason,
    /* --- acompanhamento: parâmetro e qualidade viajam junto do valor ----- */
    peakSource, bandMode: cfg.bandMode, bandNote,
    peakExcessOverBackgroundPct: isFinite(excessoRel) ? rnd(100 * excessoRel, 1) : NaN,
    snrDefinition: '10·log10(área do resíduo positivo acima do fundo aperiódico na banda ÷ área do fundo aperiódico na mesma banda)',
    snrSignalArea: rnd(snr.signal, 5), snrBackgroundArea: rnd(snr.background, 5),
    snrReason: snr.reason,
    spectrumSource: esc.spectrumSource, spectrumScale: esc.spectrumScale,
    channelSelection: esc.selection, rankable: esc.rankable, nRecords: esc.nRecords,
    nRankableCandidates: esc.nRankable,
    bandCoveragePct: rnd(coberturaPct, 1), nBandPoints: nBanda, nBandValid: nFinitos,
    ecgEvaluable: ecg.ecgEvaluable, ecgBpm: ecg.ecgBpm, ecgNBeats: ecg.ecgNBeats,
    ecgConfidence: ecg.ecgConfidence, ecgEvidence: ecg.ecgEvidence,
    artifactFlagged: ecg.artifactFlagged, artifactStatus: ecg.artifactStatus
  };
}

/* Texto canônico do passaporte — a entrada da impressão digital. Só campos
   arredondados entram, para que ruído de ponto flutuante não mude a impressão;
   e nenhum identificador direto entra, por construção. */
function passportCanonicalText(p) {
  const partes = [
    'v=' + p.version,
    'created=' + (p.createdAt || ''),
    'subject=' + (p.subject && p.subject.idHash || ''),
    'device=' + (p.subject && p.subject.deviceSnHash || ''),
    'criterion=' + p.params.criterion,
    'bandMode=' + p.params.bandMode,
    'bandSearch=' + p.params.bandSearch.join('-'),
    'peakBw=' + p.params.peakBandwidthHz,
    'peakSource=' + p.params.peakSource,
    'minR2=' + p.params.minAperiodicR2,
    'minPeak=' + p.params.minPeakOverBackground
  ];
  HEMIS.forEach(h => {
    const b = p.byHemisphere[h];
    if (!b) { partes.push(h + '=ausente'); return; }
    partes.push([h, passportChannelKey(b.channel), rnd(b.peakHz, 2), rnd(b.bandLo, 2), rnd(b.bandHi, 2),
      rnd(b.snrDb, 2), rnd(b.aperiodicExponent, 3), b.usable ? 1 : 0].join(':'));
  });
  return partes.join('|');
}

/* ======================================================================== */
/*  1. biomarkerPassport                                                     */
/* ======================================================================== */

/* biomarkerPassport(parsed, opts) — constrói o passaporte a partir de UM
   arquivo de sessão aguda.

   opts: { criterion: 'aperiodic'|'raw'|'peak' (ordenação dos pares do Survey),
           bandSearch: [lo, hi] (Hz, padrão [13, 35]),
           bandMode: 'apriori'|'peak', peakBandwidthHz (padrão 5),
           peakSource: 'aperiodic'|'raw',
           minAperiodicR2 (padrão 0,5), minPeakOverBackground (padrão 0,10),
           minBandCoveragePct (padrão 80), checkEcg (padrão true),
           ecgMaxSeconds (padrão 60) }

   Entrada: estrutura de `parsePercept`. Saída: objeto do passaporte (f em Hz,
   magnitudes na unidade do arquivo, snrDb em dB).                            */
export function biomarkerPassport(parsed, opts) {
  opts = opts || {};
  if (!parsed || typeof parsed !== 'object')
    return { ok: false, version: PASSPORT_VERSION, reason: 'nenhum arquivo de sessão foi fornecido' };

  const cfg = {
    opts,
    criterion: ['aperiodic', 'raw', 'peak'].includes(opts.criterion) ? opts.criterion : 'aperiodic',
    bandSearch: (Array.isArray(opts.bandSearch) && opts.bandSearch.length === 2 &&
      isFinite(opts.bandSearch[0]) && isFinite(opts.bandSearch[1])) ? [opts.bandSearch[0], opts.bandSearch[1]] : [13, 35],
    bandMode: opts.bandMode === 'peak' ? 'peak' : 'apriori',
    peakBandwidthHz: isFinite(opts.peakBandwidthHz) ? opts.peakBandwidthHz : 5,
    peakSource: opts.peakSource === 'raw' ? 'raw' : 'aperiodic',
    minAperiodicR2: isFinite(opts.minAperiodicR2) ? opts.minAperiodicR2 : 0.5,
    minPeakOverBackground: isFinite(opts.minPeakOverBackground) ? opts.minPeakOverBackground : 0.10,
    minBandCoveragePct: isFinite(opts.minBandCoveragePct) ? opts.minBandCoveragePct : 80
  };

  const ranking = rankSurveyChannels(parsed.montage || [], {
    lo: cfg.bandSearch[0], hi: cfg.bandSearch[1], criterion: cfg.criterion
  });

  const byHemisphere = {};
  HEMIS.forEach(h => { byHemisphere[h] = passportHemiBlock(parsed, h, ranking, cfg); });

  const blocos = HEMIS.map(h => byHemisphere[h]);
  const comEspectro = blocos.filter(b => b.channel != null);
  if (!comEspectro.length) return {
    ok: false, version: PASSPORT_VERSION,
    createdAt: (parsed.meta && parsed.meta.sessionStart) || null,
    byHemisphere,
    reason: 'este arquivo não contém nenhum espectro utilizável (nem BrainSense Survey, nem Signal Test, nem sinal bruto) — ' +
      'não há sessão aguda para definir o biomarcador'
  };

  /* --- qualidade agregada ---------------------------------------------- */
  const usaveis = blocos.filter(b => b.usable);
  const faltantes = comEspectro.map(b => isFinite(b.bandCoveragePct) ? 100 - b.bandCoveragePct : NaN).filter(isFinite);
  const pctMissing = faltantes.length ? faltantes.reduce((a, b) => a + b, 0) / faltantes.length : NaN;
  /* perda de pacotes das séries brutas, quando houver — é outra coisa que a
     falta de pontos no espectro, e por isso sai em campo separado */
  const perdas = []
    .concat(parsed.montageTD || [], parsed.bsTimeDomain || [])
    .map(t => t && t.packets && isFinite(t.packets.pctMissing) ? t.packets.pctMissing : NaN)
    .filter(isFinite);

  const passaporte = {
    ok: true,
    version: PASSPORT_VERSION,
    /* data da SESSÃO, não do processamento — ver cabeçalho */
    createdAt: (parsed.meta && parsed.meta.sessionStart) || null,
    subject: {
      idHash: (parsed.patient && parsed.patient.idHash) || null,
      diagnosis: (parsed.patient && parsed.patient.diagnosis) || null,
      deviceModel: (parsed.device && parsed.device.model) || null,
      deviceSnHash: (parsed.device && parsed.device.snHash) || null
    },
    byHemisphere,
    params: {
      criterion: cfg.criterion,
      criterionLabel: ranking ? ranking.criterionLabel : 'sem Survey — nenhum critério de ordenação aplicado',
      bandSearch: cfg.bandSearch,
      bandMode: cfg.bandMode,
      bandModeLabel: cfg.bandMode === 'peak'
        ? `banda de ${cfg.peakBandwidthHz} Hz centrada no pico individual`
        : `banda a priori ${cfg.bandSearch[0]}–${cfg.bandSearch[1]} Hz`,
      peakBandwidthHz: cfg.peakBandwidthHz,
      peakSource: cfg.peakSource,
      minAperiodicR2: cfg.minAperiodicR2,
      minPeakOverBackground: cfg.minPeakOverBackground,
      minBandCoveragePct: cfg.minBandCoveragePct,
      checkEcg: opts.checkEcg !== false,
      ecgMaxSeconds: isFinite(opts.ecgMaxSeconds) ? opts.ecgMaxSeconds : 60,
      seed: null,
      seedNote: 'nenhuma etapa deste módulo é estocástica — não há sorteio a semear'
    },
    quality: {
      nSpectra: ranking ? ranking.nChannels : comEspectro.length,
      nHemispheresWithSpectrum: comEspectro.length,
      nHemispheresUsable: usaveis.length,
      pctMissing: rnd(pctMissing, 2),
      pctMissingNote: 'percentual médio de pontos não finitos do espectro DENTRO da banda dos hemisférios avaliados — ' +
        'não é perda de pacotes',
      pctMissingPacketsTimeDomain: perdas.length ? rnd(perdas.reduce((a, b) => a + b, 0) / perdas.length, 2) : NaN,
      nTimeDomainSeries: perdas.length,
      nChannelsNotRankable: ranking ? ranking.nFallback : 0,
      ecgEvaluated: blocos.filter(b => b.ecgEvaluable).length,
      ecgSuspectedHemispheres: blocos.filter(b => b.ecgSuspected).length,
      ecgInconclusiveHemispheres: blocos.filter(b => b.ecgVerdict === 'inconclusivo').length,
      sessionAbnormalEnd: !!(parsed.meta && parsed.meta.abnormalEnd)
    },
    controversy:
      'Duas escolhas deste módulo são objeto de desacordo explícito na literatura e por isso são parâmetros, ' +
      'não constantes. (1) BANDA: a banda a priori 13–35 Hz é comparável entre sujeitos e não depende do dado, ' +
      'mas ignora que a frequência de pico individual varia de forma relevante — sobretudo no GPi; a banda ' +
      'centrada no pico respeita o indivíduo e perde a comparabilidade direta entre sujeitos. ' +
      '(2) PICO: o máximo do espectro bruto é enviesado para baixo dentro da banda, porque o fundo 1/f decresce ' +
      'ao longo dela; corrigir pelo aperiódico (Donoghue et al. 2020) remove o viés mas depende de um ajuste que ' +
      `pode não convergir. Aqui foi usado: banda ${cfg.bandMode === 'peak' ? 'centrada no pico' : 'a priori'}, ` +
      `pico ${cfg.peakSource === 'raw' ? 'do espectro bruto' : 'corrigido pelo fundo aperiódico'}.`,
    caveat:
      'O passaporte descreve o que ESTE arquivo mostra, com os parâmetros declarados em `params`. Ele não escolhe ' +
      'contato de estimulação — proximidade ao alvo, efeitos colaterais e janela terapêutica não estão neste dado. ' +
      'A relação sinal-ruído aqui é uma razão de áreas com definição declarada em `snrDefinition`: comparar `snrDb` ' +
      'entre passaportes exige a mesma origem de espectro (ver `spectrumScale`). Ferramenta de pesquisa e apoio à ' +
      'decisão; não substitui o software regulado do fabricante.',
    reason: usaveis.length ? null
      : 'nenhum hemisfério produziu um biomarcador utilizável — veja `reason` de cada hemisfério. O passaporte foi ' +
        'montado mesmo assim, para registro do que foi tentado, mas não deve ser usado para ancorar a escala de uma série crônica'
  };

  passaporte.fingerprint = 'bp-' + passportHash32(passportCanonicalText(passaporte));
  passaporte.fingerprintNote =
    'hash FNV-1a de 32 bits do conteúdo arredondado do passaporte. Serve para detectar TROCA DE CALIBRAÇÃO ' +
    '(par, pico, banda, parâmetros ou sujeito diferentes); não é função criptográfica e não protege nada.';
  return passaporte;
}

/* ======================================================================== */
/*  2. passportSensingSuggestion                                             */
/* ======================================================================== */

/* passportSensingSuggestion(passport, opts) — traduz o passaporte em uma
   SUGESTÃO de parâmetros de sensing.

   Não é prescrição, não é programação e não é diagnóstico: os valores precisam
   ser conferidos e inseridos pelo profissional no programador do fabricante,
   que é quem define a grade de frequências e larguras realmente disponíveis.

   opts opcional: { centerFreqStepHz } — se informado, a frequência central é
   arredondada para essa grade e o passo usado sai declarado. Sem ele, nenhum
   arredondamento é inventado.

   Entrada: passaporte. Saída: centerFreq/bandwidth em Hz.                    */
export function passportSensingSuggestion(passport, opts) {
  opts = opts || {};
  if (!passport || !passport.ok)
    return { ok: false, reason: (passport && passport.reason) || 'passaporte ausente ou inválido — não há o que sugerir' };

  const passo = isFinite(opts.centerFreqStepHz) && opts.centerFreqStepHz > 0 ? opts.centerFreqStepHz : null;
  /* Limiares da confiança: declarados aqui e devolvidos em `criteria`, porque
     um rótulo 'alta' sem critério explícito não é informação.

     Por que o critério principal é o EXCESSO NO PICO e não o `snrDb`: o snrDb
     integra a banda inteira, e portanto encolhe mecanicamente quando a banda é
     larga — o mesmo pico rende ~7 dB numa banda de 5 Hz e ~3 dB na banda a
     priori de 22 Hz, sem que nada tenha mudado no sinal. O excesso relativo no
     pico não depende da largura escolhida, e por isso é o que decide; o snrDb
     entra como piso, e o R² do ajuste como garantia de que a separação entre
     periódico e aperiódico é confiável. */
  const criteria = {
    peakExcessAltaPct: isFinite(opts.peakExcessAltaPct) ? opts.peakExcessAltaPct : 100,
    peakExcessMediaPct: isFinite(opts.peakExcessMediaPct) ? opts.peakExcessMediaPct : 30,
    snrDbAlta: isFinite(opts.snrDbAlta) ? opts.snrDbAlta : 0,
    snrDbMedia: isFinite(opts.snrDbMedia) ? opts.snrDbMedia : -3,
    aperiodicR2Alta: isFinite(opts.aperiodicR2Alta) ? opts.aperiodicR2Alta : 0.7,
    note: 'alta = o pico sobrevive ao aperiódico, excede o fundo em ≥ peakExcessAltaPct, snrDb ≥ snrDbAlta, ' +
      'R² do ajuste ≥ aperiodicR2Alta, sem suspeita de ECG e par escolhido por ordenação comparável entre os pares do ' +
      'Survey; media = sobrevive, excede o fundo em ≥ peakExcessMediaPct e snrDb ≥ snrDbMedia; baixa = o resto. ' +
      'O snrDb depende da largura da banda escolhida (ver `bandMode`) e por isso é piso, não critério principal'
  };

  const byHemisphere = {};
  HEMIS.forEach(h => {
    const b = passport.byHemisphere && passport.byHemisphere[h];
    if (!b || b.channel == null) {
      byHemisphere[h] = {
        centerFreq: NaN, bandwidth: NaN, confidence: 'baixa',
        rationale: 'não há espectro deste hemisfério neste arquivo — nada a sugerir'
      };
      return;
    }
    if (!b.usable) {
      byHemisphere[h] = {
        centerFreq: NaN, bandwidth: NaN, confidence: 'baixa',
        channel: b.channel, label: b.label,
        rationale: 'não é possível determinar um alvo de sensing com este dado: ' + (b.reason || 'biomarcador não utilizável') +
          '. Repetir o BrainSense Survey com o paciente em repouso, e conferir impedâncias, resolve a maior parte destes casos'
      };
      return;
    }
    const centro = passo ? Math.round(b.peakHz / passo) * passo : b.peakHz;
    const largura = b.bandHi - b.bandLo;
    const excesso = b.peakExcessOverBackgroundPct;

    /* o que IMPEDE a confiança de subir — dito item a item, porque é isso que
       diz ao usuário o que repetir na próxima sessão */
    const limitingFactors = [];
    if (!b.peakSurvivesAperiodic) limitingFactors.push('o pico não se separa do fundo aperiódico');
    if (!(excesso >= criteria.peakExcessAltaPct)) limitingFactors.push(`o pico excede o fundo em ${rnd(excesso, 0)}% (≥ ${criteria.peakExcessAltaPct}% para confiança alta)`);
    if (!(b.snrDb >= criteria.snrDbAlta)) limitingFactors.push(`snrDb ${rnd(b.snrDb, 1)} dB na banda de ${rnd(largura, 1)} Hz (≥ ${criteria.snrDbAlta} dB para confiança alta)`);
    if (!(b.aperiodicR2 >= criteria.aperiodicR2Alta)) limitingFactors.push(`o ajuste do fundo aperiódico explica R² = ${rnd(b.aperiodicR2, 2)} (≥ ${criteria.aperiodicR2Alta} para confiança alta)`);
    if (b.ecgSuspected) limitingFactors.push('há suspeita de contaminação por ECG neste canal');
    if (!b.rankable) limitingFactors.push('o par não foi ordenado contra pares comparáveis do Survey');

    let confidence = 'baixa';
    if (!limitingFactors.length) confidence = 'alta';
    else if (b.peakSurvivesAperiodic && excesso >= criteria.peakExcessMediaPct && b.snrDb >= criteria.snrDbMedia) confidence = 'media';

    const ressalvas = [];
    if (b.ecgVerdict === 'suspeito') ressalvas.push('há suspeita de contaminação por ECG neste canal');
    if (b.ecgVerdict === 'inconclusivo') ressalvas.push('a verificação de ECG foi inconclusiva — não afirma nem descarta contaminação cardíaca');
    if (b.ecgVerdict === 'não avaliado') ressalvas.push('a contaminação por ECG não pôde ser avaliada (sem sinal bruto suficiente neste hemisfério)');
    if (b.artifactFlagged) ressalvas.push(`o próprio aparelho sinalizou artefato neste canal (${b.artifactStatus}), sem declarar a origem`);
    if (b.nCandidates <= 1) ressalvas.push('havia um único espectro disponível — não houve escolha entre pares');

    byHemisphere[h] = {
      centerFreq: rnd(centro, 2),
      bandwidth: rnd(largura, 2),
      bandLo: b.bandLo, bandHi: b.bandHi,
      channel: b.channel, label: b.label,
      confidence, limitingFactors,
      bandwidthNote: b.bandMode === 'peak'
        ? `largura de ${rnd(largura, 1)} Hz centrada no pico individual, que é a banda em que o biomarcador foi caracterizado`
        : `largura de ${rnd(largura, 1)} Hz correspondente à banda A PRIORI de caracterização — não é uma janela de sensing ` +
          'programável. O aparelho aplica a própria janela, fixa, ao redor da frequência central; para obter uma largura ' +
          'sugerida próxima da janela do aparelho, refaça o passaporte com bandMode: "peak"',
      rationale: `par ${b.label || b.channel}` +
        (isFinite(b.rank) ? ` (posição ${b.rank} de ${b.nCandidates} no Survey pelo critério “${passport.params.criterionLabel}”)` : '') +
        `, pico em ${rnd(b.peakHz, 1)} Hz (${b.peakSource}), excedendo o fundo aperiódico em ${rnd(excesso, 0)}%, ` +
        `banda ${rnd(b.bandLo, 1)}–${rnd(b.bandHi, 1)} Hz (${b.bandNote}), snrDb ${rnd(b.snrDb, 1)} dB pela definição ` +
        `declarada, expoente aperiódico ${rnd(b.aperiodicExponent, 2)} com R² ${rnd(b.aperiodicR2, 2)}` +
        (limitingFactors.length ? `. Confiança ${confidence} porque: ` + limitingFactors.join('; ') : '') +
        (ressalvas.length ? '. Ressalvas: ' + ressalvas.join('; ') : '') +
        (passo ? `. Frequência central arredondada para a grade de ${passo} Hz informada` : '')
    };
  });

  return {
    ok: true, byHemisphere, criteria,
    centerFreqStepHz: passo,
    note: 'SUGESTÃO derivada da sessão aguda carregada, para ser CONFERIDA E INSERIDA PELO PROFISSIONAL no ' +
      'programador do fabricante. Não é prescrição, não é programação automática e não substitui o julgamento ' +
      'clínico nem o software regulado do fabricante. A grade de frequências centrais e as larguras de banda ' +
      'efetivamente disponíveis são definidas pelo aparelho, e podem não coincidir com os valores aqui — ' +
      'se a banda do aparelho for diferente da banda deste passaporte, a escala da série crônica muda junto.'
  };
}

/* ======================================================================== */
/*  3. passportMatchesConfig                                                 */
/* ======================================================================== */

/* Uma diferença entre passaporte e aparelho. `matters` responde a UMA pergunta:
   ela invalida a comparação de ESCALA entre a sessão aguda e a série crônica? */
function passportDiff(field, valorPassaporte, valorDispositivo, matters, note) {
  return { field, passport: valorPassaporte, device: valorDispositivo, matters: !!matters, note: note || null };
}

/* passportMatchesConfig(passport, config) — o aparelho está medindo o que o
   passaporte definiu?

   `config` no formato de `sensingConfigOf` (metrics/config.js):
     { byHemisphere: { Left: { channel, centerFreq, bandLo, bandHi } } }
   O módulo não é importado de propósito: o passaporte só depende do FORMATO,
   e assim a comparação funciona também com uma configuração digitada à mão.

   Regra de `matters`:
     • par bipolar diferente → SEMPRE importa. Outro par vê outro volume de
       tecido, com outra impedância e outro ganho; a série não é a mesma
       variável e nem sequer está na mesma escala.
     • frequência central deslocada além da tolerância → o pico do passaporte
       cai FORA da janela que o aparelho integra: o número crônico passa a medir
       a borda do pico, ou o fundo. A tolerância é metade da MENOR banda
       declarada, limitada a 2,5 Hz — o aparelho integra uma janela estreita ao
       redor da frequência central, e derivar a tolerância de uma banda a priori
       larga (13–35 Hz daria 11 Hz) toleraria deslocamentos absurdos.
     • largura de banda diferente → a integral muda de tamanho; níveis absolutos
       deixam de ser comparáveis mesmo com o mesmo pico dentro.
     • banda que não contém o pico do passaporte → o mesmo problema, dito pelas
       bordas em vez do centro.
   Unidades: Hz.                                                              */
export function passportMatchesConfig(passport, config) {
  if (!passport || !passport.ok)
    return { ok: false, reason: (passport && passport.reason) || 'passaporte ausente ou inválido' };
  if (!config || !config.byHemisphere || typeof config.byHemisphere !== 'object')
    return { ok: false, reason: 'configuração de sensing ausente — sem ela não é possível dizer se o aparelho mede o que o passaporte definiu' };

  const byHemisphere = {};
  let algumComparado = 0, algumImporta = 0, algumDiferenca = 0;

  HEMIS.forEach(h => {
    const p = passport.byHemisphere && passport.byHemisphere[h];
    const d = config.byHemisphere[h];
    if (!p || p.channel == null) {
      byHemisphere[h] = { match: null, comparable: false, differences: [], reason: 'o passaporte não define este hemisfério' };
      return;
    }
    if (!d) {
      byHemisphere[h] = {
        match: false, comparable: false,
        differences: [passportDiff('presença', p.label || p.channel, null, true,
          'o passaporte define um biomarcador para este hemisfério e a configuração vigente não tem sensing aqui — não há série crônica correspondente')],
        reason: 'sem configuração de sensing neste hemisfério'
      };
      algumImporta++; algumDiferenca++;
      return;
    }

    if (!p.usable) {
      byHemisphere[h] = {
        match: null, comparable: false, differences: [],
        reason: 'o passaporte não define um biomarcador utilizável neste hemisfério (' + (p.reason || 'motivo não registrado') +
          ') — não há definição contra a qual comparar a configuração vigente'
      };
      return;
    }

    const dif = [];
    const largura = (isFinite(p.bandHi) && isFinite(p.bandLo)) ? (p.bandHi - p.bandLo) : NaN;
    const larguraDispPrev = (isFinite(d.bandHi) && isFinite(d.bandLo)) ? (d.bandHi - d.bandLo) : NaN;
    /* tolerância de frequência central: metade da MENOR banda declarada,
       limitada a 2,5 Hz (ver cabeçalho da função) */
    const menorLargura = Math.min(
      isFinite(largura) && largura > 0 ? largura : Infinity,
      isFinite(larguraDispPrev) && larguraDispPrev > 0 ? larguraDispPrev : Infinity);
    const tolCentro = Math.min(2.5, isFinite(menorLargura) ? menorLargura / 2 : 2.5);

    /* --- par bipolar ---------------------------------------------------- */
    const kp = passportChannelKey(p.channel), kd = passportChannelKey(d.channel);
    if (kp && kd && kp !== kd)
      dif.push(passportDiff('channel', p.label || p.channel, d.channel, true,
        'par bipolar diferente do que definiu o biomarcador — outro par tem outra impedância e outro ganho, ' +
        'e a série crônica não está na mesma escala'));
    else if (!kd)
      dif.push(passportDiff('channel', p.label || p.channel, d.channel == null ? null : d.channel, true,
        'a configuração não declara o par bipolar — sem ele não é possível afirmar que a escala se manteve'));

    /* --- frequência central --------------------------------------------- */
    if (!isFinite(d.centerFreq))
      dif.push(passportDiff('centerFreq', p.peakHz, d.centerFreq == null ? null : d.centerFreq, true,
        'a configuração não declara frequência central'));
    else if (Math.abs(d.centerFreq - p.peakHz) > 1e-6) {
      const delta = d.centerFreq - p.peakHz;
      const importa = Math.abs(delta) > tolCentro;
      dif.push(passportDiff('centerFreq', p.peakHz, d.centerFreq, importa,
        `diferença de ${rnd(delta, 2)} Hz (tolerância de ${rnd(tolCentro, 2)} Hz)` +
        (importa ? ' — o pico do passaporte cai fora da janela estreita que o aparelho integra ao redor da frequência central'
          : ' — dentro da janela integrada ao redor da frequência central')));
    }

    /* --- limites da banda ------------------------------------------------ */
    const larguraDisp = larguraDispPrev;
    const contemPico = isFinite(d.bandLo) && isFinite(d.bandHi) && isFinite(p.peakHz) &&
      p.peakHz >= d.bandLo && p.peakHz <= d.bandHi;
    [['bandLo', p.bandLo, d.bandLo], ['bandHi', p.bandHi, d.bandHi]].forEach(([campo, vp, vd]) => {
      if (!isFinite(vd)) {
        dif.push(passportDiff(campo, vp, vd == null ? null : vd, true, 'a configuração não declara este limite de banda'));
        return;
      }
      if (Math.abs(vd - vp) <= 1e-6) return;
      const importa = !contemPico || (isFinite(larguraDisp) && isFinite(largura) && Math.abs(larguraDisp - largura) > 1);
      dif.push(passportDiff(campo, vp, vd, importa,
        importa
          ? (!contemPico
            ? `a banda do aparelho (${rnd(d.bandLo, 1)}–${rnd(d.bandHi, 1)} Hz) não contém o pico do passaporte (${rnd(p.peakHz, 1)} Hz)`
            : `a largura integrada mudou de ${rnd(largura, 1)} para ${rnd(larguraDisp, 1)} Hz — níveis absolutos deixam de ser comparáveis`)
          : 'deslocamento pequeno de borda, com o pico ainda dentro e a largura preservada'));
    });

    const importa = dif.some(x => x.matters);
    byHemisphere[h] = {
      match: dif.length === 0, comparable: true,
      differences: dif,
      centerToleranceHz: rnd(tolCentro, 2),
      scaleComparable: !importa,
      reason: dif.length === 0 ? 'a configuração vigente reproduz a definição do passaporte'
        : importa ? 'há diferença que invalida a comparação de escala'
          : 'há diferença sem consequência para a escala'
    };
    algumComparado++;
    if (dif.length) algumDiferenca++;
    if (importa) algumImporta++;
  });

  if (!algumComparado && !algumDiferenca)
    return { ok: false, byHemisphere, reason: 'nenhum hemisfério pôde ser comparado — o passaporte não define nenhum lado' };

  const match = algumDiferenca === 0;
  return {
    ok: true, match, byHemisphere,
    verdict: match ? 'o aparelho está medindo o que o passaporte definiu'
      : algumImporta ? 'a configuração vigente NÃO reproduz o biomarcador do passaporte'
        : 'há diferenças, mas nenhuma altera a escala do que é medido',
    consequence: match
      ? 'a série crônica pode ser lida na escala do passaporte, e comparações entre períodos são legítimas nessa escala'
      : algumImporta
        ? 'os valores do BrainSense Timeline registrados sob esta configuração NÃO são comparáveis, em escala, com os do ' +
          'passaporte nem com períodos anteriores medidos sob ele. Trate como duas variáveis diferentes: reporte a mudança ' +
          'de configuração junto do gráfico, e recalibre com uma nova sessão aguda se a comparação for necessária'
        : 'a escala se mantém; ainda assim registre as diferenças no relatório, porque quem lê o gráfico depois não tem ' +
          'como saber que elas existiram'
  };
}

/* ======================================================================== */
/*  4. passportCompare                                                       */
/* ======================================================================== */

/* passportCompare(a, b) — o biomarcador do mesmo sujeito continua o mesmo?

   Compara dois passaportes em tempos diferentes. `drift` no nível superior é o
   PIOR CASO entre os hemisférios (maior deslocamento de pico em módulo, maior
   perda de SNR, qualquer troca de par), porque é isso que decide se a série
   pode ser lida como contínua; `byHemisphere` traz o detalhe lado a lado.

   Limiares (declarados em `thresholds`): 2,5 Hz de deslocamento de pico —
   metade da largura típica de 5 Hz, além da qual o pico sai da janela — e 6 dB
   de queda de SNR, que é fator 4 em razão de áreas. Unidades: Hz e dB.       */
export function passportCompare(a, b) {
  if (!a || !a.ok || !b || !b.ok)
    return { ok: false, reason: 'são necessários dois passaportes válidos para comparar' };
  const idA = a.subject && a.subject.idHash, idB = b.subject && b.subject.idHash;
  if (idA && idB && idA !== idB)
    return { ok: false, reason: 'os dois passaportes são de sujeitos diferentes — a comparação não faz sentido' };
  if (a.version !== b.version)
    return { ok: false, reason: `os passaportes têm versões de formato diferentes (${a.version} e ${b.version}) — campos podem ter mudado de significado` };

  const thresholds = { maxPeakDriftHz: 2.5, maxSnrDropDb: 6 };
  const deviceChanged = !!(a.subject && b.subject && a.subject.deviceSnHash && b.subject.deviceSnHash &&
    a.subject.deviceSnHash !== b.subject.deviceSnHash);
  const paramsChanged = JSON.stringify(a.params && a.params.bandSearch) !== JSON.stringify(b.params && b.params.bandSearch) ||
    (a.params && a.params.bandMode) !== (b.params && b.params.bandMode) ||
    (a.params && a.params.peakSource) !== (b.params && b.params.peakSource);

  const byHemisphere = {};
  let piorPeak = NaN, piorSnr = NaN, trocouCanal = false, comparados = 0, naoComparaveis = 0, escalaIncomparavel = 0;

  HEMIS.forEach(h => {
    const pa = a.byHemisphere && a.byHemisphere[h], pb = b.byHemisphere && b.byHemisphere[h];
    if (!pa || !pb || pa.channel == null || pb.channel == null) {
      byHemisphere[h] = { comparable: false, reason: 'um dos passaportes não define este hemisfério' };
      naoComparaveis++;
      return;
    }
    if (!pa.usable || !pb.usable) {
      byHemisphere[h] = {
        comparable: false,
        reason: 'ao menos um dos lados não tem biomarcador utilizável: ' + (pa.usable ? (pb.reason || '') : (pa.reason || ''))
      };
      naoComparaveis++;
      return;
    }
    const dPeak = pb.peakHz - pa.peakHz;
    const dSnr = pb.snrDb - pa.snrDb;
    const mudouCanal = passportChannelKey(pa.channel) !== passportChannelKey(pb.channel);
    /* dB de origens espectrais diferentes não se subtraem: uma magnitude do
       Survey e um PSD de Welch não estão na mesma escala */
    const escalaOk = pa.spectrumScale === pb.spectrumScale && pa.spectrumSource === pb.spectrumSource;
    if (!escalaOk) escalaIncomparavel++;
    if (mudouCanal) trocouCanal = true;
    if (!isFinite(piorPeak) || Math.abs(dPeak) > Math.abs(piorPeak)) piorPeak = dPeak;
    if (escalaOk && (!isFinite(piorSnr) || dSnr < piorSnr)) piorSnr = dSnr;
    comparados++;
    byHemisphere[h] = {
      comparable: true,
      channelA: pa.label || pa.channel, channelB: pb.label || pb.channel, channelChanged: mudouCanal,
      peakHzA: pa.peakHz, peakHzB: pb.peakHz, peakHzDelta: rnd(dPeak, 2),
      snrDbA: pa.snrDb, snrDbB: pb.snrDb, snrDelta: rnd(dSnr, 2),
      aperiodicExponentDelta: rnd(pb.aperiodicExponent - pa.aperiodicExponent, 3),
      ecgSuspectedChanged: pa.ecgSuspected !== pb.ecgSuspected,
      stable: !mudouCanal && Math.abs(dPeak) <= thresholds.maxPeakDriftHz &&
        (!escalaOk || dSnr >= -thresholds.maxSnrDropDb),
      scaleComparable: escalaOk,
      scaleNote: escalaOk ? null
        : `os espectros vêm de origens diferentes (${pa.spectrumSource} × ${pb.spectrumSource}) — a diferença de snrDb ` +
          'está reportada, mas não é interpretável como variação do sinal e foi excluída do pior caso'
    };
  });

  if (!comparados) return {
    ok: false, byHemisphere,
    reason: 'nenhum hemisfério é comparável entre os dois passaportes — sem biomarcador utilizável dos dois lados não há deriva a medir'
  };

  const stable = !trocouCanal && !deviceChanged && escalaIncomparavel === 0 &&
    isFinite(piorPeak) && Math.abs(piorPeak) <= thresholds.maxPeakDriftHz &&
    (!isFinite(piorSnr) || piorSnr >= -thresholds.maxSnrDropDb);

  const motivos = [];
  if (trocouCanal) motivos.push('o par bipolar mudou');
  if (deviceChanged) motivos.push('o neuroestimulador mudou (hashes de série diferentes)');
  if (isFinite(piorPeak) && Math.abs(piorPeak) > thresholds.maxPeakDriftHz)
    motivos.push(`o pico deslocou ${rnd(piorPeak, 1)} Hz (limiar ${thresholds.maxPeakDriftHz} Hz)`);
  if (isFinite(piorSnr) && piorSnr < -thresholds.maxSnrDropDb)
    motivos.push(`a relação sinal-ruído caiu ${rnd(-piorSnr, 1)} dB (limiar ${thresholds.maxSnrDropDb} dB)`);
  if (escalaIncomparavel)
    motivos.push(`em ${escalaIncomparavel} hemisfério(s) os espectros vêm de origens diferentes — não é possível dizer se a intensidade do sinal mudou`);
  if (paramsChanged) motivos.push('os parâmetros de definição (banda, modo de banda ou origem do pico) não são os mesmos nos dois passaportes');

  return {
    ok: true,
    stable,
    drift: {
      peakHzDelta: rnd(piorPeak, 2),
      snrDelta: rnd(piorSnr, 2),
      channelChanged: trocouCanal
    },
    byHemisphere,
    thresholds,
    deviceChanged, paramsChanged,
    fingerprintChanged: a.fingerprint !== b.fingerprint,
    nComparable: comparados, nNotComparable: naoComparaveis, nScaleIncomparable: escalaIncomparavel,
    createdAtA: a.createdAt || null, createdAtB: b.createdAt || null,
    driftNote: 'os valores de `drift` são o PIOR CASO entre os hemisférios comparáveis — maior deslocamento de pico em ' +
      'módulo e maior queda de relação sinal-ruído. O detalhe por lado está em `byHemisphere`',
    verdict: stable
      ? 'o biomarcador se manteve entre os dois passaportes: mesmo par, pico e relação sinal-ruído dentro dos limiares — ' +
        'a série crônica pode ser lida como contínua' +
        (paramsChanged ? ', ainda que os parâmetros de definição declarados não sejam os mesmos nos dois' : '')
      : 'o biomarcador NÃO se manteve: ' + motivos.join('; ') + '. Séries crônicas dos dois períodos não devem ser ' +
        'plotadas no mesmo eixo sem indicar a mudança — o número continua se chamando LFP, mas passou a medir outra coisa'
  };
}
