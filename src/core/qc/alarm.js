/* qc/alarm.js — alarme ATIVO de artefato, em linguagem de consultório.

   POR QUE ESTE MÓDULO EXISTE, JÁ HAVENDO UM PAINEL DE QC. O painel descreve;
   este alarma. A diferença não é de tom, é de função. O clínico de distúrbios
   do movimento não vai reconhecer contaminação por ECG olhando um espectro — e
   a contaminação é sistemática, depende do lado de implante do gerador, e
   produz um "pico" convincente exatamente na faixa onde se procura o
   biomarcador. Um software que apenas exibe o espectro e deixa a inspeção por
   conta do usuário está transferindo para o médico uma tarefa de processamento
   de sinal que ele não tem por que saber fazer.

   O QUE MUDA NA SAÍDA. Cada achado vem com quatro coisas: uma frase que um
   médico não engenheiro entende, a evidência numérica que a sustenta, um
   VEREDITO DE USO ('pode interpretar' / 'interprete com ressalva' / 'não
   interprete este canal') e a ação concreta. Os achados saem ordenados por
   gravidade, não por ordem de verificação.

   A REGRA QUE GOVERNA O MÓDULO INTEIRO. Ausência de verificação NÃO é ausência
   de artefato. Toda checagem que não pôde ser feita — porque falta o sinal
   bruto, porque a frequência de estimulação não está declarada, porque o
   registro é curto demais — sai em `notChecked` com o motivo, e o resumo diz
   quantas foram. Um arquivo sem sinal bruto pode voltar 'limpo' na lista de
   alarmes e ter cinco verificações não realizadas; dizer só "limpo" seria
   mentir por omissão.

   Unidades: sinal em µV; frequências em Hz; frações em porcento.

   Referências:
     Neumann W-J, et al. Brain Stimul 2021 — contaminação por ECG no sensing do
       Percept e dependência do lado de implante do gerador.
     Thenaisie Y, et al. J Neural Eng 2021;18:042002 — cadeia de sensing do
       Percept, blanking de estimulação e limites do canal de potência.       */

import { detectRPeaks } from '../artifact/rpeaks.js';
import { checkHarmonics } from './harmonics.js';
import { suggestLineFrequency } from '../dsp/notch.js';
import { welchPSD } from '../dsp/spectral.js';
import { nanStats } from '../dsp/nan.js';
import { median, quantile, sd } from '../stats/descriptive.js';

const ALARME_PADRAO = {
  /* fração da energia total atribuível ao QRS acima da qual o canal é
     considerado comprometido para leitura espectral */
  ecgRatioCritico: 0.30, ecgRatioAtencao: 0.12,
  /* frequência cardíaca plausível: fora disso, o que foi detectado
     provavelmente não é QRS */
  fcMin: 40, fcMax: 140,
  /* perda de pacote */
  perdaCritica: 20, perdaAtencao: 5,
  /* saturação: fração de amostras no extremo do registro */
  clipFrac: 0.005,
  /* amplitude plausível de LFP subtalâmico, em µV de desvio-padrão */
  sdMin: 0.2, sdMax: 60,
  /* quanto de sinal bruto usar na varredura de ECG, em segundos */
  ecgMaxSeconds: 60,
  /* autocorrelação mínima da potência instantânea, no atraso compatível com
     frequência cardíaca, para levantar suspeita de transiente repetitivo */
  ecgPeriodicidade: 0.35,
  /* censura do próprio aparelho no Timeline, em porcento das amostras */
  censuraCritica: 20, censuraAtencao: 3
};

/* Periodicidade da POTÊNCIA INSTANTÂNEA, sem localizar evento nenhum.

   O que calcula: x² é suavizado por média móvel de 50 ms, reamostrado para
   ~50 Hz, a média é removida, e a autocorrelação normalizada é varrida nos
   atrasos que correspondem a frequências cardíacas plausíveis. Um transiente
   que se repete a cada RR segundos produz máximo em lag = RR.

   POR QUE A SUAVIZAÇÃO DE 50 ms É OBRIGATÓRIA E NÃO É DETALHE. x² de um ritmo
   de f Hz tem componente em 2f: um beta de 20 Hz vira 40 Hz na potência, e 40 Hz
   reamostrado a 50 Hz REBATE para 10 Hz, produzindo autocorrelação alta em
   atrasos que caem exatamente na faixa de frequência cardíaca. Sem a média
   móvel, um canal limpo com beta forte dispara alarme de batimento. A janela de
   50 ms atenua 40 Hz a ~4% e preserva o QRS, que dura ~80 ms.

   O que NÃO decide: se o transiente é o coração. Batimento é a explicação mais
   comum de um transiente de 40–140/min num LFP de STN, mas movimento rítmico e
   artefato de contato produzem a mesma assinatura. Por isso o alarme que nasce
   só daqui é ressalva, nunca impedimento.

   Entrada em µV, fs em Hz. Saída: r adimensional em [−1, 1], lagS em s.     */
function alarmePeriodicidadePotencia(x, fs, fcMin, fcMax) {
  const fator = Math.max(1, Math.round(fs / 50));
  const fsD = fs / fator;
  const n = Math.floor(x.length / fator);
  if (n < 64) return { ok: false, reason: 'trecho curto demais para medir periodicidade' };
  /* média móvel de 50 ms sobre x², por soma acumulada (anti-rebatimento) */
  const jan = Math.max(fator, Math.round(fs * 0.05));
  const acum = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) acum[i + 1] = acum[i] + x[i] * x[i];
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = i * fator;
    const a = Math.max(0, c - (jan >> 1)), b = Math.min(x.length, a + jan);
    e[i] = (acum[b] - acum[a]) / Math.max(1, b - a);
  }
  let m = 0;
  for (let i = 0; i < n; i++) m += e[i];
  m /= n;
  let c0 = 0;
  for (let i = 0; i < n; i++) { e[i] -= m; c0 += e[i] * e[i]; }
  if (!(c0 > 0)) return { ok: false, reason: 'potência instantânea constante' };

  const lagMin = Math.max(2, Math.round(fsD * 60 / fcMax));
  const lagMax = Math.min(n - 16, Math.round(fsD * 60 / fcMin));
  if (lagMax <= lagMin) return { ok: false, reason: 'trecho curto demais para cobrir a faixa de frequência cardíaca' };
  let melhor = -2, melhorLag = NaN;
  for (let L = lagMin; L <= lagMax; L++) {
    let c = 0;
    for (let i = 0; i + L < n; i++) c += e[i] * e[i + L];
    const r = c / c0;
    if (r > melhor) { melhor = r; melhorLag = L; }
  }
  if (!isFinite(melhor)) return { ok: false, reason: 'autocorrelação não calculável' };
  const lagS = melhorLag / fsD;
  return {
    ok: true, r: melhor, lagS, bpm: 60 / lagS,
    method: 'autocorrelação de x² suavizado por média móvel de 50 ms e reamostrado a ~50 Hz, com a média removida; ' +
      'máximo na faixa de frequência cardíaca',
    smoothingMs: 50,
    caveat: 'periodicidade não identifica a fonte: movimento rítmico e artefato de contato produzem a mesma assinatura'
  };
}

const alarmeHemi = h => h === 'Left' ? 'esquerdo' : h === 'Right' ? 'direito' : String(h || '—');

/* Cria um achado já no formato final, para que nenhum caminho de código possa
   emitir alarme sem veredito ou sem ação. */
function alarmeItem(id, sev, canal, hemi, title, plain, evidence, verdict, whatToDo, confidence) {
  return { id, severity: sev, channel: canal, hemisphere: hemi, title, plain, evidence, verdict, whatToDo, confidence };
}

export function artifactAlarm(parsed, opts) {
  opts = opts || {};
  const P = Object.assign({}, ALARME_PADRAO, opts);
  const alarms = [], checked = [], notChecked = [];
  if (!parsed || typeof parsed !== 'object') return {
    ok: false, level: 'limpo', alarms, checked, notChecked, nCritical: 0, nWarning: 0,
    summary: 'nenhum arquivo para verificar', params: P
  };

  const tds = (parsed.bsTimeDomain || []).concat(parsed.montageTD || []);

  /* ---------------- 1. contaminação por ECG ------------------------------ */
  /* DOIS detectores independentes, porque um sozinho tem ponto cego. O primeiro
     usa os picos R já localizados (o mesmo detector da figura de limpeza) e
     mede concentração de energia em torno deles — é específico, mas depende de
     o detector travar no QRS, e com QRS pequeno ele trava no ruído. O segundo
     não localiza nada: pergunta se a POTÊNCIA INSTANTÂNEA se repete num período
     compatível com frequência cardíaca. Um transiente repetitivo aparece ali
     mesmo quando o detector de picos falha. Achado só do segundo detector nunca
     é crítico — batimento é a explicação mais provável, mas não é a única.  */
  if (!tds.length) {
    notChecked.push({ check: 'contaminação por ECG', whyNot: 'este arquivo não traz sinal bruto no domínio do tempo' });
  } else tds.forEach(td => {
    const fsTd = td.fsEff || td.fs;
    const nMax = Math.min(td.data.length, Math.round(P.ecgMaxSeconds * fsTd));
    const trecho = td.data.subarray ? td.data.subarray(0, nMax) : td.data.slice(0, nMax);
    const limpo = Float64Array.from(trecho, v => isFinite(v) ? v : 0);
    checked.push({ check: 'contaminação por ECG', channel: td.label });
    const dur = limpo.length / fsTd;

    /* --- detector A: concentração de energia nos picos R --- */
    let det = null;
    try { det = detectRPeaks(limpo, fsTd, {}); } catch (e) { det = null; }
    let excesso = NaN, fc = NaN;
    if (det && det.peaks && det.peaks.length >= 4) {
      fc = 60 * det.peaks.length / Math.max(1e-6, dur);
      if (fc >= P.fcMin && fc <= P.fcMax) {
        const w = Math.round(0.04 * fsTd);
        let dentro = 0, total = 0;
        for (let i = 0; i < limpo.length; i++) total += limpo[i] * limpo[i];
        det.peaks.forEach(p => {
          for (let i = Math.max(0, p - w); i < Math.min(limpo.length, p + w); i++) dentro += limpo[i] * limpo[i];
        });
        const fracJanela = (2 * w * det.peaks.length) / Math.max(1, limpo.length);
        const razao = total > 0 ? (dentro / total) / Math.max(1e-9, fracJanela) : NaN;
        /* razão ≈ 1 significa energia uniforme; acima disso há concentração no QRS */
        excesso = isFinite(razao) ? (razao - 1) / Math.max(1e-9, razao) : NaN;
      }
    }
    const critA = isFinite(excesso) && excesso >= P.ecgRatioCritico;
    const atenA = isFinite(excesso) && excesso >= P.ecgRatioAtencao;

    /* --- detector B: periodicidade da potência instantânea --- */
    const per = alarmePeriodicidadePotencia(limpo, fsTd, P.fcMin, P.fcMax);
    const atenB = per.ok && per.r >= P.ecgPeriodicidade;

    if (!atenA && !atenB) return;

    const critico = critA;
    const soB = atenB && !atenA;
    const evid = [];
    if (isFinite(excesso)) evid.push(`${(100 * excesso).toFixed(0)}% da energia do canal está concentrada em torno dos picos R`);
    if (isFinite(fc)) evid.push(`FC implícita ${fc.toFixed(0)} bpm · ${det.peaks.length} batimentos em ${dur.toFixed(0)} s`);
    if (per.ok) evid.push(`potência instantânea se repete a cada ${per.lagS.toFixed(2)} s (${per.bpm.toFixed(0)}/min), ` +
      `autocorrelação ${per.r.toFixed(2)}`);

    alarms.push(alarmeItem(
      'ecg', critico ? 'critico' : 'atencao', td.label, td.hemisphere,
      soB ? 'Transiente repetitivo em ritmo cardíaco' : 'Batimento cardíaco no sinal',
      soB
        ? `O traçado do STN ${alarmeHemi(td.hemisphere)} (${td.label}) tem um transiente que se repete ` +
          `${per.bpm.toFixed(0)} vezes por minuto — a faixa da frequência cardíaca. O detector de complexos QRS não ` +
          'travou neste canal, então não é possível afirmar que seja o coração; mas alguma coisa repetitiva está ali, e ' +
          'ela contamina o espectro.'
        : `O traçado do STN ${alarmeHemi(td.hemisphere)} (${td.label}) carrega o batimento cardíaco: ` +
          `${det.peaks.length} complexos QRS foram identificados, numa frequência de ${fc.toFixed(0)} por minuto. ` +
          'Isso cria no espectro um pico que parece atividade cerebral e não é.',
      evid.join(' · '),
      critico ? 'não interprete este canal' : 'interprete com ressalva',
      soB
        ? 'abra a figura de limpeza de artefato cardíaco (F15) e olhe o traçado sobreposto aos picos detectados: se for ' +
          'QRS, a limpeza resolve; se não for, o que se repete precisa ser identificado antes de o espectro ser lido'
        : 'use a figura de limpeza de artefato cardíaco (F15) antes de ler o espectro deste canal, e confira ali quanto ' +
          'de sinal neural sobreviveu à remoção',
      critico ? 'alta' : soB ? 'baixa' : (det && det.peaks.length >= 20 ? 'alta' : 'média')
    ));
  });

  /* ---------------- 2. harmônicos de estimulação e alias ------------------ */
  const espectros = [];
  (parsed.montage || []).forEach(m => { if (m.f && m.mag) espectros.push({ f: m.f, p: m.mag, label: m.label || m.channel, hemi: m.hemisphere }); });
  (parsed.sensingSetup || []).forEach(s => { if (s.psd) espectros.push({ f: s.psd.f, p: s.psd.p, label: s.channel, hemi: s.hemisphere }); });
  tds.forEach(td => {
    const w = welchPSD(td.data, td.fsEff || td.fs, {});
    if (w && w.p) espectros.push({ f: Array.from(w.f), p: Array.from(w.p), label: td.label, hemi: td.hemisphere, fs: td.fsEff || td.fs });
  });

  const fStim = (() => {
    const r = (parsed.bsLfp || []).map(x => ((x.therapy || {}).perHemi || {}));
    for (const per of r) for (const h of ['Left', 'Right']) if (per[h] && isFinite(per[h].rate)) return per[h].rate;
    const g = (parsed.groups || []).find(x => x.active) || (parsed.groups || [])[0];
    const pr = g && (g.programs || [])[0];
    return pr && isFinite(pr.rate) ? pr.rate : NaN;
  })();

  if (!espectros.length) {
    notChecked.push({ check: 'harmônicos de estimulação', whyNot: 'não há espectro nem sinal bruto neste arquivo' });
  } else if (!isFinite(fStim)) {
    notChecked.push({ check: 'harmônicos de estimulação', whyNot: 'a frequência de estimulação não está declarada no arquivo' });
  } else espectros.forEach(e => {
    let hm = null;
    try { hm = checkHarmonics(e.f, e.p, fStim, {}); } catch (x) { hm = null; }
    checked.push({ check: 'harmônicos de estimulação', channel: e.label });
    if (!hm || !hm.suspicious) return;
    alarms.push(alarmeItem(
      'harmonico', 'atencao', e.label, e.hemi,
      'Pico na frequência da estimulação (ou submúltiplo)',
      `O espectro do canal ${e.label} tem um pico numa frequência que é múltiplo ou submúltiplo exato dos ` +
      `${fStim.toFixed(0)} Hz da estimulação. Um pico assim costuma ser eco do próprio estimulador, não oscilação do cérebro.`,
      hm.detail || `f_stim = ${fStim.toFixed(0)} Hz`,
      'interprete com ressalva',
      'confira na figura de gama (F22) se o pico está em f_stim/2 — se estiver, ele é entrained e não deve ser lido como marcador',
      'média'
    ));
  });

  /* ---------------- 3. frequência de rede -------------------------------- */
  if (!espectros.length) {
    notChecked.push({ check: 'interferência da rede elétrica', whyNot: 'não há espectro neste arquivo' });
  } else espectros.forEach(e => {
    let ln = null;
    try { ln = suggestLineFrequency(e.f, e.p); } catch (x) { ln = null; }
    checked.push({ check: 'interferência da rede elétrica', channel: e.label });
    if (!ln || !ln.detected) return;
    alarms.push(alarmeItem(
      'rede', 'atencao', e.label, e.hemi,
      'Interferência da rede elétrica',
      `O canal ${e.label} tem um pico estreito em ${ln.frequency} Hz, que é a frequência da rede elétrica. ` +
      `Isso é ruído do ambiente, não sinal do paciente.`,
      `pico em ${ln.frequency} Hz · razão sobre a vizinhança ${isFinite(ln.ratio) ? ln.ratio.toFixed(1) : '—'}×`,
      'interprete com ressalva',
      'aplique o filtro notch nos controles da figura antes de ler bandas acima de 40 Hz',
      'alta'
    ));
  });

  /* ---------------- 4. saturação e amplitude implausível ------------------ */
  if (!tds.length) {
    notChecked.push({ check: 'saturação e amplitude', whyNot: 'este arquivo não traz sinal bruto no domínio do tempo' });
  } else tds.forEach(td => {
    checked.push({ check: 'saturação e amplitude', channel: td.label });
    const v = Array.from(td.data).filter(isFinite);
    if (v.length < 100) return;
    const vmax = quantile(v, 1), vmin = quantile(v, 0);
    const nExtremo = v.filter(x => x === vmax || x === vmin).length;
    const frac = nExtremo / v.length;
    if (frac >= P.clipFrac) alarms.push(alarmeItem(
      'saturacao', 'critico', td.label, td.hemisphere,
      'Sinal saturado (ganho alto demais)',
      `${(100 * frac).toFixed(1)}% das amostras do canal ${td.label} estão exatamente no valor máximo ou mínimo do ` +
      `registro. O amplificador chegou ao limite, e tudo acima disso foi cortado — o espectro deste trecho é do corte, não do cérebro.`,
      `${nExtremo} amostras no extremo, de ${v.length} · faixa ${vmin.toFixed(1)} a ${vmax.toFixed(1)}`,
      'não interprete este canal',
      'repita a gravação com ganho menor no programador',
      'alta'
    ));
    const dp = sd(v);
    if (isFinite(dp) && (dp < P.sdMin || dp > P.sdMax)) alarms.push(alarmeItem(
      'amplitude', 'atencao', td.label, td.hemisphere,
      'Amplitude fora do esperado para LFP subtalâmico',
      `O desvio-padrão do canal ${td.label} é ${dp.toFixed(2)} µV, ${dp < P.sdMin ? 'muito abaixo' : 'muito acima'} da ` +
      `faixa habitual (${P.sdMin}–${P.sdMax} µV). Pode ser ganho errado, unidade trocada, ou eletrodo com problema.`,
      `desvio-padrão ${dp.toFixed(2)} µV · mediana ${median(v).toFixed(2)} µV`,
      'interprete com ressalva',
      'confira a impedância do par na figura de integridade de eletrodos (F3) e o ganho declarado no arquivo',
      'média'
    ));
  });

  /* ---------------- 5. perda de pacotes e deriva -------------------------- */
  if (!tds.length) {
    notChecked.push({ check: 'perda de pacotes', whyNot: 'este arquivo não traz sinal bruto no domínio do tempo' });
  } else tds.forEach(td => {
    checked.push({ check: 'perda de pacotes', channel: td.label });
    const st = nanStats(td.data);
    const pk = td.packets || {};
    if (pk.reliable === false) {
      notChecked.push({ check: `perda de pacotes em ${td.label}`, whyNot: 'o arquivo não traz sequências nem ticks para verificar' });
      return;
    }
    if (st.pctNan >= P.perdaAtencao) alarms.push(alarmeItem(
      'perda', st.pctNan >= P.perdaCritica ? 'critico' : 'atencao', td.label, td.hemisphere,
      'Pedaços do sinal não chegaram',
      `${st.pctNan.toFixed(1)}% das amostras do canal ${td.label} se perderam na transmissão. ` +
      `Elas ficam como buraco — não são preenchidas — e os trechos afetados saem de fora das contas.`,
      `${st.nValid.toLocaleString('pt-BR')} de ${st.n.toLocaleString('pt-BR')} amostras válidas · maior buraco contíguo ` +
      `${(st.longestGapSamples / (td.fsEff || td.fs)).toFixed(2)} s`,
      st.pctNan >= P.perdaCritica ? 'não interprete este canal' : 'interprete com ressalva',
      'repita a gravação com o programador mais próximo do gerador e sem obstáculo entre os dois',
      'alta'
    ));
    if (td.timing && td.timing.warnDrift) alarms.push(alarmeItem(
      'deriva', 'atencao', td.label, td.hemisphere,
      'O relógio do registro derivou',
      `O canal ${td.label} acumulou ${td.timing.driftMsTotal.toFixed(0)} ms de diferença entre o tempo nominal e o medido. ` +
      `Isso não afeta o espectro, mas desloca qualquer análise alinhada a evento ou sincronizada com aparelho externo.`,
      `fs efetiva ${(td.fsEff || td.fs).toFixed(4)} Hz vs. ${td.fs} Hz nominal`,
      'interprete com ressalva',
      'use a frequência efetiva (já é o padrão nas figuras) e declare a deriva em qualquer análise de latência',
      'alta'
    ));
  });

  /* ------------- 8. passa-alta configurável em 10 Hz --------------------- */
  /* "a second high pass filter at a user configurable 1Hz or 10Hz"
     — Medtronic UC202012929cEN FY24, p. 11.

     Com 10 Hz, delta e teta são eliminados PELO HARDWARE. Qualquer métrica
     dessas bandas — o termo teta do ODR, a leitura de banda lenta da distonia,
     o acoplamento fase-amplitude com fase em teta — passa a medir o joelho do
     filtro. É alarme, não nota: quem lê o gráfico não tem como saber. */
  const filt = parsed.filters || null;
  if (!filt || !isFinite(filt.highPassConfigurableHz)) {
    notChecked.push({
      check: 'passa-alta configurável',
      whyNot: 'o arquivo não declara o passa-alta em Groups → GroupSettings; não é possível saber se as bandas ' +
        'lentas sobrevivem ao filtro do aparelho'
    });
  } else {
    checked.push({ check: 'passa-alta configurável', channel: 'todos' });
    if (filt.highPassConfigurableHz >= 10) alarms.push(alarmeItem(
      'passaalta', 'critico', 'todos os canais', null,
      'Delta e teta foram removidos pelo próprio aparelho',
      `O segundo passa-alta do neuroestimulador está configurado em ${filt.highPassConfigurableHz} Hz. Tudo abaixo ` +
      'disso foi eliminado pelo hardware antes de o dado ser gravado: delta e teta não estão neste registro, e ' +
      'qualquer número dessas bandas é o joelho do filtro, não atividade cerebral.',
      `passa-alta configurável em ${filt.highPassConfigurableHz} Hz · fonte: ${filt.highPassSource} · ` +
      'cadeia: ' + filt.description,
      'não interprete este canal',
      'não leia teta nem delta neste registro — isso inclui o termo teta do ODR (F34), a leitura de banda lenta da ' +
      'distonia e o acoplamento fase-amplitude com fase em teta. Para recuperá-las, o passa-alta precisa ser mudado ' +
      'para 1 Hz nas Advanced Settings do BrainSense Setup, e um NOVO registro precisa ser feito',
      'alta'
    ));
  }

  /* ------------- 9. dado censurado pelo aparelho ------------------------- */
  /* "Data may be censored to avoid artifacts, censored data is negative."
     — Medtronic UC202012929cEN FY24, p. 24. */
  const cens = parsed.trendCensoring || null;
  const hemisCens = cens ? Object.keys(cens) : [];
  if (!hemisCens.length) {
    notChecked.push({
      check: 'censura do aparelho no Timeline',
      whyNot: 'este arquivo não traz BrainSense Timeline'
    });
  } else {
    checked.push({ check: 'censura do aparelho no Timeline', channel: hemisCens.join(', ') });
    hemisCens.forEach(h => {
      const c = cens[h];
      const pct = Math.max(c.pctCensoredLfp || 0, c.pctCensoredMa || 0);
      if (pct < P.censuraAtencao) return;
      const critico = pct >= P.censuraCritica;
      alarms.push(alarmeItem(
        'censura', critico ? 'critico' : 'atencao', `Timeline ${alarmeHemi(h)}`, h,
        'O aparelho descartou parte do Timeline',
        `${pct.toFixed(1)}% das amostras do Timeline do STN ${alarmeHemi(h)} foram marcadas pelo próprio ` +
        'neuroestimulador como suspeitas de artefato e não trazem valor. Elas não entram em nenhuma conta — mas a ' +
        'falta NÃO é aleatória: o aparelho censura onde suspeita de artefato, e artefato costuma coincidir com ' +
        'movimento, que por sua vez coincide com estado motor.',
        `${c.nCensoredLfp} de ${c.n} amostras com potência censurada (${c.pctCensoredLfp}%) · ` +
        `${c.nCensoredMa} com amplitude censurada (${c.pctCensoredMa}%) · regra: valor negativo = censura ` +
        '(UC202012929cEN FY24, p. 24)',
        critico ? 'não interprete este canal' : 'interprete com ressalva',
        'reporte o percentual censurado junto de qualquer média, mediana ou percentual de tempo acima do limiar ' +
        'deste hemisfério. Censura não é perda de pacote e não deve ser somada a ela',
        'alta'
      ));
    });
  }

  const nCrit = alarms.filter(a => a.severity === 'critico').length;
  const nAt = alarms.filter(a => a.severity === 'atencao').length;
  const ordem = { critico: 0, atencao: 1, informativo: 2 };
  alarms.sort((a, b) => ordem[a.severity] - ordem[b.severity]);

  const resumo = nCrit
    ? `${nCrit} canal(is) com problema que impede a leitura, e ${nAt} com ressalva. ` +
      (notChecked.length ? `Além disso, ${notChecked.length} verificação(ões) não foi(ram) possível(is) neste arquivo.` : '')
    : nAt
      ? `nenhum problema impeditivo; ${nAt} ressalva(s). ` +
        (notChecked.length ? `${notChecked.length} verificação(ões) não foi(ram) possível(is) neste arquivo.` : '')
      : notChecked.length
        ? `nenhum artefato encontrado nas ${checked.length} verificações que foram possíveis — mas ${notChecked.length} ` +
          `não puderam ser feitas neste arquivo, e ausência de verificação não é ausência de artefato.`
        : `nenhum artefato encontrado nas ${checked.length} verificações realizadas.`;

  return {
    ok: true,
    level: nCrit ? 'critico' : nAt ? 'atencao' : 'limpo',
    alarms, nCritical: nCrit, nWarning: nAt,
    checked, notChecked, summary: resumo, params: P,
    stimFrequencyHz: isFinite(fStim) ? fStim : null
  };
}
