/* io/sync.js — alinhamento temporal entre o LFP do Percept e um sinal externo.

   O PROBLEMA. O gravador externo (IMU, EMG, ECG) tem o próprio relógio. Mesmo
   quando os dois arquivos trazem hora absoluta, os relógios divergem — e uma
   defasagem de 200 ms já destrói qualquer conclusão sobre atraso de fase entre
   córtex e músculo. Três caminhos, do mais confiável ao menos:

   1. ARTEFATO DE ESTIMULAÇÃO (`alignByStimArtifact`). Ligar ou desligar a
      estimulação produz um degrau em AMBOS os sinais — no LFP porque o artefato
      entra no sensing, no externo porque o pulso acopla ao amplificador. É o
      método do DBSsync e o único que dá alinhamento sub-amostra confiável,
      porque o evento é o MESMO evento físico.

   2. CORRELAÇÃO CRUZADA DE ENVELOPES (`alignByCrossCorrelation`). Sem evento
      comum, resta procurar o deslocamento que maximiza a correlação entre os
      envelopes de banda. Funciona quando existe atividade compartilhada — em
      tremor, quase sempre. A confiança é medida contra um NULO por
      deslocamentos aleatórios: um pico de correlação sozinho não significa
      nada, porque sempre existe um máximo.

   3. TIMESTAMP DECLARADO (`alignByTimestamp`). Barato e frequentemente errado.
      Fica disponível, mas o resultado avisa que não foi verificado.

   Nenhum destes métodos é aplicado em silêncio: a saída sempre traz `method`,
   `confidence` e o que sustenta (ou não) o alinhamento.

   Unidades: atrasos em milissegundos; positivo = o sinal externo está ATRASADO
   em relação ao LFP.

   Referência de arquitetura: DBSsync (Vivien) — sincronização por artefato de
   estimulação.                                                               */

import { mean, sd, median, quantile } from '../stats/descriptive.js';
import { bandpassFFT, hilbertEnvelope } from '../dsp/filters.js';

/* Correlação de Pearson entre duas séries, ignorando pares com NaN. */
function correl(a, b, desloc) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  const ini = Math.max(0, -desloc), fim = Math.min(a.length, b.length - desloc);
  for (let i = ini; i < fim; i++) {
    const x = a[i], y = b[i + desloc];
    if (!isFinite(x) || !isFinite(y)) continue;
    n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  if (n < 32) return { r: NaN, n };
  const cov = sab / n - (sa / n) * (sb / n);
  const va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
  return { r: va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : NaN, n };
}

/* alignByCrossCorrelation(lfp, ext, fs, {band, maxLagSec, nSurrogates})
   Ambos já reamostrados para a MESMA fs.                                     */
export function alignByCrossCorrelation(lfp, ext, fs, opts) {
  opts = opts || {};
  const banda = opts.band || [2, 12];
  const maxLag = Math.round((isFinite(opts.maxLagSec) ? opts.maxLagSec : 5) * fs);
  const nSur = opts.nSurrogates == null ? 200 : opts.nSurrogates;
  if (lfp.length < 4 * fs || ext.length < 4 * fs)
    return { ok: false, reason: 'séries curtas demais para correlação cruzada (mínimo 4 s cada)' };

  /* envelopes de banda: o que se compara é a MODULAÇÃO de amplitude, não a
     forma de onda — as duas modalidades não têm por que ter a mesma fase */
  const envDe = x => {
    const b = bandpassFFT(x, fs, banda[0], banda[1]);
    return hilbertEnvelope(b);
  };
  const a = envDe(lfp), b = envDe(ext);

  let melhor = 0, melhorR = -Infinity;
  const curva = [];
  for (let d = -maxLag; d <= maxLag; d++) {
    const { r } = correl(a, b, d);
    if (isFinite(r)) {
      curva.push({ lagMs: 1000 * d / fs, r, d });
      if (r > melhorR) { melhorR = r; melhor = d; }
    }
  }
  if (!curva.length) return { ok: false, reason: 'nenhum deslocamento produziu sobreposição suficiente' };

  /* LARGURA do pico de correlação = incerteza do alinhamento. O envelope de um
     ritmo estreito é liso, então o máximo é raso e o deslocamento fica mal
     determinado mesmo com correlação alta. Reportar só o máximo esconderia
     isso; aqui sai a faixa em que a correlação fica dentro de 95% do pico. */
  const alvo = melhorR * 0.95;
  const dentro = curva.filter(p => p.r >= alvo).map(p => p.lagMs);
  const larguraMs = dentro.length ? (Math.max.apply(null, dentro) - Math.min.apply(null, dentro)) / 2 : NaN;

  /* nulo: deslocamentos MUITO maiores que a janela de busca destroem qualquer
     relação real e mostram o quanto de correlação o acaso já entrega */
  let semente = (opts.seed >>> 0) || 20260803;
  const prox = () => { semente = (Math.imul(semente, 1664525) + 1013904223) >>> 0; return semente / 4294967296; };
  const nulos = [];
  const minNulo = Math.max(maxLag * 3, Math.floor(fs * 10));
  for (let s = 0; s < nSur && minNulo < a.length / 2; s++) {
    const d = minNulo + Math.floor(prox() * (a.length - 2 * minNulo));
    const { r } = correl(a, b, d);
    if (isFinite(r)) nulos.push(r);
  }
  const mu = nulos.length ? mean(nulos) : NaN;
  const s0 = nulos.length > 2 ? sd(nulos) : NaN;
  const z = isFinite(s0) && s0 > 0 ? (melhorR - mu) / s0 : NaN;
  const p = nulos.length ? (nulos.filter(v => v >= melhorR).length + 1) / (nulos.length + 1) : NaN;

  const confianca = !isFinite(z) ? 'não avaliável'
    : (z > 5 && melhorR > 0.3 && larguraMs < 100) ? 'alta'
      : (z > 3 && larguraMs < 250) ? 'moderada' : 'baixa';

  return {
    ok: true, method: 'correlação cruzada de envelopes',
    band: banda, lagMs: +(1000 * melhor / fs).toFixed(2),
    correlation: +melhorR.toFixed(4),
    z: isFinite(z) ? +z.toFixed(2) : NaN,
    pEmpirical: isFinite(p) ? +p.toFixed(4) : NaN,
    nSurrogates: nulos.length, seed: (opts.seed >>> 0) || 20260803,
    confidence: confianca,
    peakHalfWidthMs: isFinite(larguraMs) ? +larguraMs.toFixed(1) : NaN,
    curve: curva.filter((_, i) => i % Math.max(1, Math.round(curva.length / 400)) === 0),
    caveat: (confianca === 'alta'
      ? 'o deslocamento encontrado é claramente melhor que o acaso; ainda assim ele supõe que os dois sinais ' +
        'compartilham modulação de amplitude nesta banda. '
      : 'o pico de correlação não se destaca do nulo — trate este alinhamento como NÃO estabelecido e ' +
        'prefira sincronizar por artefato de estimulação ou por marcador comum. ') +
      (isFinite(larguraMs)
        ? `A incerteza do deslocamento é de aproximadamente ±${larguraMs.toFixed(0)} ms (largura do pico de ` +
          'correlação) — não interprete atraso de fase com resolução melhor que isso.'
        : '')
  };
}

/* Detecta degraus de amplitude (ligar/desligar estimulação) numa série: o ponto
   onde a energia de alta frequência muda de patamar. */
export function detectStimSteps(x, fs, opts) {
  opts = opts || {};
  const jan = Math.max(8, Math.round((opts.windowSec || 0.25) * fs));
  const n = Math.floor(x.length / jan);
  if (n < 6) return [];
  const energia = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = i * jan; k < (i + 1) * jan && k < x.length; k++) {
      if (!isFinite(x[k])) continue;
      const d = k > 0 && isFinite(x[k - 1]) ? x[k] - x[k - 1] : 0;   /* derivada realça o artefato */
      s += d * d; c++;
    }
    energia[i] = c ? Math.sqrt(s / c) : NaN;
  }
  /* Um limiar ABSOLUTO sobre a energia falha quando o trecho com estimulação
     ocupa boa parte do registro: ele puxa a própria mediana para cima e o
     degrau some. O critério aqui é de MUDANÇA, e é livre de escala: salto no
     log da energia entre janelas vizinhas, grande em relação à variação típica
     desses saltos. */
  const validos = Array.from(energia).filter(v => isFinite(v) && v > 0);
  if (validos.length < 6) return [];
  const logE = Array.from(energia).map(v => (isFinite(v) && v > 0) ? Math.log(v) : NaN);
  const saltos = [];
  for (let i = 1; i < n; i++) if (isFinite(logE[i]) && isFinite(logE[i - 1])) saltos.push(logE[i] - logE[i - 1]);
  if (saltos.length < 5) return [];
  const medSalto = median(saltos);
  const mad = median(saltos.map(v => Math.abs(v - medSalto))) || 1e-9;
  const kMad = isFinite(opts.k) ? opts.k : 5;
  const razaoMin = isFinite(opts.minRatio) ? opts.minRatio : 1.8;
  const limiar = Math.max(kMad * 1.4826 * mad, Math.log(razaoMin));
  const degraus = [];
  for (let i = 1; i < n; i++) {
    if (!isFinite(logE[i]) || !isFinite(logE[i - 1])) continue;
    const d = logE[i] - logE[i - 1];
    if (Math.abs(d - medSalto) < limiar) continue;
    /* evita marcar duas janelas seguidas do mesmo degrau */
    const ultimo = degraus[degraus.length - 1];
    if (ultimo && (i * jan) / fs - ultimo.atSec < 2 * jan / fs) continue;
    degraus.push({
      atSec: +((i * jan) / fs).toFixed(4),
      direction: d > 0 ? 'liga' : 'desliga',
      ratio: +Math.exp(Math.abs(d)).toFixed(2)
    });
  }
  return degraus;
}

/* alignByStimArtifact(lfp, ext, fs, opts) — casa o PRIMEIRO degrau de cada
   série. Só devolve alinhamento se os dois tiverem o mesmo número de degraus na
   mesma ordem; senão diz que não dá, em vez de casar coisas diferentes. */
export function alignByStimArtifact(lfp, ext, fs, opts) {
  opts = opts || {};
  const a = detectStimSteps(lfp, fs, opts);
  const b = detectStimSteps(ext, fs, opts);
  if (!a.length || !b.length) return {
    ok: false, method: 'artefato de estimulação',
    reason: `degraus detectados: ${a.length} no LFP, ${b.length} no sinal externo — ` +
      'é preciso ao menos um em cada; ligue e desligue a estimulação com os dois gravando'
  };
  /* Pareamento por PROXIMIDADE e mesma direção, não por ordem no vetor: um
     degrau espúrio a mais em uma das séries desalinharia todos os pares se o
     casamento fosse posicional. Cada degrau externo só pode ser usado uma vez. */
  const janelaMs = isFinite(opts.maxPairMs) ? opts.maxPairMs : 3000;
  const usados = new Set();
  const pares = [];
  a.forEach(pa => {
    let melhor = -1, dist = Infinity;
    b.forEach((pb, j) => {
      if (usados.has(j) || pb.direction !== pa.direction) return;
      const d = Math.abs(pb.atSec - pa.atSec) * 1000;
      if (d < dist && d <= janelaMs) { dist = d; melhor = j; }
    });
    if (melhor >= 0) { usados.add(melhor); pares.push(1000 * (b[melhor].atSec - pa.atSec)); }
  });
  if (!pares.length) return {
    ok: false, method: 'artefato de estimulação',
    reason: `nenhum degrau do LFP encontrou par de mesma direção no sinal externo dentro de ` +
      `${(janelaMs / 1000).toFixed(1)} s (LFP: ${a.map(x => x.direction + '@' + x.atSec.toFixed(1) + 's').join(', ')}; ` +
      `externo: ${b.map(x => x.direction + '@' + x.atSec.toFixed(1) + 's').join(', ')}) — o evento não é o mesmo, ` +
      `ou o desalinhamento é maior que a janela de pareamento`
  };
  const lag = median(pares);
  const disp = pares.length > 1 ? quantile(pares, 0.75) - quantile(pares, 0.25) : 0;
  return {
    ok: true, method: 'artefato de estimulação',
    lagMs: +lag.toFixed(2), nEvents: pares.length,
    spreadMs: +disp.toFixed(2),
    stepsLfp: a.slice(0, 8), stepsExternal: b.slice(0, 8),
    confidence: pares.length >= 2 && disp < 50 ? 'alta' : pares.length >= 2 ? 'moderada' : 'baixa',
    caveat: pares.length < 2
      ? 'apenas um evento em comum: o alinhamento não pode ser verificado contra um segundo evento'
      : disp < 50
        ? `${pares.length} eventos concordam dentro de ${disp.toFixed(0)} ms — alinhamento verificado`
        : `os ${pares.length} eventos discordam em ${disp.toFixed(0)} ms; há deriva entre os relógios, ` +
          'e um único deslocamento não corrige o registro inteiro'
  };
}

/* Alinhamento pelo timestamp declarado. Barato, disponível e não verificado. */
export function alignByTimestamp(lfpT0Ms, extT0Ms) {
  if (!isFinite(lfpT0Ms) || !isFinite(extT0Ms)) return {
    ok: false, method: 'timestamp declarado', reason: 'um dos sinais não traz hora absoluta'
  };
  return {
    ok: true, method: 'timestamp declarado', lagMs: +(extT0Ms - lfpT0Ms).toFixed(2),
    confidence: 'não verificado',
    caveat: 'os relógios do neuroestimulador e do gravador externo não são sincronizados entre si. ' +
      'Este deslocamento vem do que cada arquivo declara e NÃO foi verificado contra o sinal — ' +
      'deriva de segundos é comum. Confirme por artefato de estimulação antes de interpretar atraso de fase.'
  };
}
