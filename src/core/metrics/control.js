/* metrics/control.js — banda-controle e actograma.

   BANDA-CONTROLE: A PERGUNTA QUE SEPARA RITMO DE ARTEFATO. Um padrão diurno na
   potência de beta pode ser ritmo neural — ou pode ser postura, movimento,
   impedância que muda com a temperatura, qualquer coisa que module o sinal
   INTEIRO. O teste é simples e é o que a literatura pede: o mesmo padrão
   aparece numa banda que não deveria carregar o biomarcador? Se aparecer, o
   achado provavelmente não é específico da banda.

   Aqui a comparação é feita sobre espectros COM HORA (snapshots de evento,
   sessões de Survey datadas): para cada um, a potência da banda marcadora e a
   da banda-controle, cada uma normalizada pela própria média, e o perfil diurno
   das duas. A diferença entre os perfis é testada por permutação de cluster ao
   longo do eixo de hora — não ponto a ponto.

   ACTOGRAMA: a representação clássica da cronobiologia. Cada linha é um dia,
   e o gráfico é DUPLICADO lado a lado (dia N e dia N+1 na mesma linha), o que
   torna visível a deriva de fase — um ritmo que atrasa um pouco por dia aparece
   como uma faixa diagonal, coisa que o heatmap simples esconde.

   Unidades: potência na unidade do arquivo; hora local em horas decimais.

   Referências:
     Refinetti R, et al. Biol Rhythm Res 2007;38:275-325 (actograma e análise).
     van Rheede JJ, et al. npj Parkinsons Dis 2022;8:88 (ritmo circadiano de
       beta no STN e a necessidade de controle).                              */

import { localHour, localDayKey } from '../io/parse.js';
import { median, quantile, mean } from '../stats/descriptive.js';
import { bandPower } from '../dsp/spectral.js';
import { clusterPermutation } from '../stats/cluster.js';

/* controlBandDiurnal(espectros, offMin, opts)
   `espectros`: [{ t (ms), f, p }] — snapshots ou sessões datadas.            */
export function controlBandDiurnal(espectros, offMin, opts) {
  opts = opts || {};
  const marcador = opts.markerBand || [13, 35];
  const controle = opts.controlBand || [55, 95];
  const nBins = opts.nBins || 12;
  const lista = (espectros || []).filter(s => s && s.f && s.f.length && s.p && isFinite(s.t));
  if (lista.length < 8) return {
    ok: false,
    reason: `só ${lista.length} espectro(s) com hora — são necessários ao menos 8 para comparar perfis diurnos. ` +
      'Ative o registro de eventos pelo paciente e aguarde alguns dias, ou carregue mais sessões datadas.'
  };
  const fmax = Math.max.apply(null, lista.map(s => s.f[s.f.length - 1]));
  if (fmax < controle[0] + 5) return {
    ok: false,
    reason: `os espectros vão só até ${fmax.toFixed(0)} Hz e a banda-controle pedida é ${controle[0]}–${controle[1]} Hz — ` +
      'escolha uma banda-controle dentro do que o dado cobre'
  };

  const linhas = lista.map(s => ({
    t: s.t, hora: localHour(s.t, offMin), dia: localDayKey(s.t, offMin),
    marcador: bandPower(s.f, s.p, marcador[0], marcador[1]),
    controle: bandPower(s.f, s.p, controle[0], controle[1])
  })).filter(r => isFinite(r.marcador) && isFinite(r.controle) && r.marcador > 0 && r.controle > 0);
  if (linhas.length < 8) return { ok: false, reason: 'poucos espectros com potência válida nas duas bandas' };

  /* normaliza cada banda pela PRÓPRIA média: o que se compara é a FORMA do
     perfil diurno, não a escala — bandas diferentes têm potências diferentes */
  const mm = mean(linhas.map(r => r.marcador)), mc = mean(linhas.map(r => r.controle));
  linhas.forEach(r => { r.mNorm = r.marcador / mm; r.cNorm = r.controle / mc; });

  const bins = Array.from({ length: nBins }, () => ({ m: [], c: [] }));
  linhas.forEach(r => {
    const b = Math.min(nBins - 1, Math.floor(r.hora / 24 * nBins));
    bins[b].m.push(r.mNorm); bins[b].c.push(r.cNorm);
  });
  const horas = Array.from({ length: nBins }, (_, i) => (i + 0.5) * 24 / nBins);
  const perfilM = bins.map(b => b.m.length ? median(b.m) : NaN);
  const perfilC = bins.map(b => b.c.length ? median(b.c) : NaN);
  const nPorBin = bins.map(b => b.m.length);

  /* amplitude diurna de cada banda: pico-a-vale do perfil */
  const amp = v => { const ok = v.filter(isFinite); return ok.length ? Math.max.apply(null, ok) - Math.min.apply(null, ok) : NaN; };
  const ampM = amp(perfilM), ampC = amp(perfilC);

  /* teste por cluster ao longo da hora: cada registro é um "ensaio" pareado
     (a mesma amostra dá marcador e controle) */
  const A = [], B = [];
  linhas.forEach(r => {
    const linhaA = new Array(nBins).fill(NaN), linhaB = new Array(nBins).fill(NaN);
    const b = Math.min(nBins - 1, Math.floor(r.hora / 24 * nBins));
    linhaA[b] = r.mNorm; linhaB[b] = r.cNorm;
    A.push(linhaA); B.push(linhaB);
  });
  const cl = clusterPermutation(A, B, {
    paired: true, nPermutations: opts.nPermutations || 2000,
    clusterThreshold: opts.clusterThreshold || 2.0, seed: opts.seed
  });

  const razao = isFinite(ampM) && ampC > 0 ? ampM / ampC : NaN;
  const especifico = isFinite(razao) && razao > 1.5 && cl && cl.anySignificant;

  return {
    ok: true,
    markerBand: marcador, controlBand: controle, nBins,
    hours: horas, markerProfile: perfilM, controlProfile: perfilC, nPerBin: nPorBin,
    nSpectra: linhas.length, nDays: new Set(linhas.map(r => r.dia)).size,
    markerAmplitude: isFinite(ampM) ? +ampM.toFixed(4) : NaN,
    controlAmplitude: isFinite(ampC) ? +ampC.toFixed(4) : NaN,
    amplitudeRatio: isFinite(razao) ? +razao.toFixed(3) : NaN,
    cluster: cl,
    bandSpecific: especifico,
    verdict: !cl ? 'não avaliável'
      : especifico ? 'o padrão diurno é específico da banda marcadora'
        : cl.anySignificant ? 'as bandas diferem, mas a amplitude diurna do controle é comparável — especificidade fraca'
          : 'não há diferença entre marcador e controle além do acaso',
    interpretation: especifico
      ? `a variação diurna do marcador é ${razao.toFixed(1)}× a da banda-controle (${controle[0]}–${controle[1]} Hz), ` +
        'e a diferença entre os perfis sobrevive ao teste de cluster — o padrão não é um efeito global sobre o sinal inteiro'
      : cl && cl.anySignificant
        ? `há diferença entre os perfis, mas a banda-controle também varia (razão de amplitudes ${isFinite(razao) ? razao.toFixed(1) : '—'}×). ` +
          'Postura, movimento e mudanças de impedância modulam o sinal inteiro e produzem padrão pseudo-diurno — ' +
          'trate a especificidade como não demonstrada'
        : 'o perfil do marcador não se separa do da banda-controle: com este dado não é possível dizer que a ' +
          'variação diurna observada é específica da banda, e portanto não é possível atribuí-la ao biomarcador'
  };
}

/* actogram(rows, offMin, opts) → matriz dias × bins, em formato duplo-plot.

   Cada linha traz o dia D seguido do dia D+1, que é o que revela deriva de
   fase: um ritmo que atrasa um pouco por dia vira uma diagonal.              */
export function actogram(rows, offMin, opts) {
  opts = opts || {};
  const binMin = opts.binMin || 30;
  const nBins = Math.round(24 * 60 / binMin);
  const norm = opts.normalizeDaily !== false;
  const porDia = {};
  (rows || []).forEach(r => {
    if (!isFinite(r.lfp) || !isFinite(r.t)) return;
    const d = localDayKey(r.t, offMin);
    (porDia[d] = porDia[d] || []).push(r);
  });
  const dias = Object.keys(porDia).sort();
  if (dias.length < 2) return { ok: false, reason: 'são necessários ao menos 2 dias de registro para um actograma' };

  const perfilDe = dia => {
    const arr = new Array(nBins).fill(NaN);
    const baldes = Array.from({ length: nBins }, () => []);
    porDia[dia].forEach(r => baldes[Math.min(nBins - 1, Math.floor(localHour(r.t, offMin) * 60 / binMin))].push(r.lfp));
    const medDia = median(porDia[dia].map(r => r.lfp));
    baldes.forEach((b, i) => { if (b.length) arr[i] = norm ? 100 * median(b) / medDia : median(b); });
    return { arr, medDia, n: porDia[dia].length };
  };
  const perfis = {};
  dias.forEach(d => { perfis[d] = perfilDe(d); });

  /* duplo-plot: linha i = dia i seguido do dia i+1 */
  const linhas = [];
  for (let i = 0; i < dias.length; i++) {
    const a = perfis[dias[i]].arr;
    const b = i + 1 < dias.length ? perfis[dias[i + 1]].arr : new Array(nBins).fill(NaN);
    linhas.push({
      day: dias[i], values: a.concat(b),
      n: perfis[dias[i]].n, dayMedian: +perfis[dias[i]].medDia.toFixed(4)
    });
  }
  const planos = linhas.flatMap(l => l.values).filter(isFinite);

  /* Acrofase de cada dia. O bin de maior valor é um estimador ruim: com poucas
     amostras por bin ele salta de um bin para o vizinho por ruído, e a "deriva"
     resultante é do estimador, não do ritmo. Aqui a acrofase é a MÉDIA CIRCULAR
     das horas ponderada pelo excesso sobre o mínimo do dia — usa o perfil
     inteiro e não só o pico. */
  const acro = dias.map(d => {
    const a = perfis[d].arr;
    const validos = a.filter(isFinite);
    if (validos.length < 4) return NaN;
    const minimo = Math.min.apply(null, validos);
    let sx = 0, sy = 0, sw = 0;
    a.forEach((v, i) => {
      if (!isFinite(v)) return;
      const w = v - minimo;
      if (!(w > 0)) return;
      const ang = 2 * Math.PI * ((i + 0.5) * binMin / 60) / 24;
      sx += w * Math.cos(ang); sy += w * Math.sin(ang); sw += w;
    });
    if (!(sw > 0)) return NaN;
    let ang = Math.atan2(sy, sx);
    if (ang < 0) ang += 2 * Math.PI;
    return ang / (2 * Math.PI) * 24;
  });
  const derivas = [];
  for (let i = 1; i < acro.length; i++) {
    if (!isFinite(acro[i]) || !isFinite(acro[i - 1])) continue;
    let d = acro[i] - acro[i - 1];
    while (d > 12) d -= 24; while (d < -12) d += 24;
    derivas.push(d);
  }
  const derivaMediana = derivas.length ? median(derivas) : NaN;

  return {
    ok: true, binMin, nBins, days: dias, rows: linhas,
    normalizeDaily: norm,
    zmin: planos.length ? +quantile(planos, 0.02).toFixed(3) : NaN,
    zmax: planos.length ? +quantile(planos, 0.98).toFixed(3) : NaN,
    acrophaseByDay: acro.map(v => isFinite(v) ? +v.toFixed(2) : NaN),
    medianDriftHoursPerDay: isFinite(derivaMediana) ? +derivaMediana.toFixed(3) : NaN,
    totalDriftHours: isFinite(derivaMediana) ? +(derivaMediana * (dias.length - 1)).toFixed(2) : NaN,
    /* 0,15 h/dia ≈ 9 min/dia: parece pouco, mas em duas semanas acumula 2 h e
       desloca a leitura de acrofase. O limiar precisa ser exigente. */
    driftNote: !isFinite(derivaMediana) ? 'deriva não estimável'
      : Math.abs(derivaMediana) < 0.15
        ? `o horário do pico se mantém entre os dias (${derivaMediana >= 0 ? '+' : ''}${derivaMediana.toFixed(2)} h/dia) — sem deriva relevante`
        : `o horário do pico desloca-se ${derivaMediana > 0 ? 'para mais tarde' : 'para mais cedo'} ` +
          `${Math.abs(derivaMediana).toFixed(2)} h por dia, o que acumula ` +
          `${Math.abs(derivaMediana * (dias.length - 1)).toFixed(1)} h nos ${dias.length} dias registrados. ` +
          'Num actograma isso aparece como faixa diagonal — pode ser ritmo em curso livre, mudança de rotina ou ' +
          'artefato de mudança de horário; confronte com o diário antes de interpretar',
    note: 'cada linha mostra o dia e o dia seguinte lado a lado (duplo-plot) — é o arranjo que torna a deriva ' +
      'de fase visível, e que o heatmap simples esconde'
  };
}
