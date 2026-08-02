/* adbs/simulate.js — simulador de aDBS de limiar único e duplo.

   Dada a série crônica (ou o envelope de beta do streaming) e um par de
   limiares, simula o comportamento do aDBS e devolve as métricas que a decisão
   de programação exige: % do tempo em cada nível, transições por hora, duração
   mediana de cada estado, duty cycle, amplitude média entregue e energia
   relativa à cDBS.

   DETALHE QUE MUDA O RESULTADO: o dispositivo suaviza o sinal antes de decidir,
   com a constante `AveragingDurationInMilliSeconds` do SensingSetup (tipicamente
   3000 ms), e sobe/desce por rampa configurada. Sem aplicar isso, a simulação
   SUPERESTIMA o número de transições — o aparelho não persegue cada oscilação.

   Referências: ADAPT-PD; Busch et al., npj Parkinsons Dis 2025;11:264
   (limiar duplo, 8 pacientes, avaliação ecológica em casa);
   Cascino et al., npj Parkinsons Dis 2026 (ADAPT-START).                      */

import { median, quantile } from '../stats/descriptive.js';

/* Média móvel causal de `ms` milissegundos — é como o dispositivo enxerga. */
function suavizaCausal(serie, ms) {
  if (!(ms > 0)) return serie.map(p => p.v);
  const out = new Array(serie.length);
  let acc = 0, ini = 0;
  for (let i = 0; i < serie.length; i++) {
    acc += isFinite(serie[i].v) ? serie[i].v : 0;
    while (serie[i].t - serie[ini].t > ms) { acc -= isFinite(serie[ini].v) ? serie[ini].v : 0; ini++; }
    out[i] = acc / Math.max(1, i - ini + 1);
  }
  return out;
}

/* simulateAdbs(series, {mode, lower, upper, minMa, maxMa, averagingMs, rampMaPerSec})
   `series`: [{t (ms), v}] — potência do Timeline ou envelope de beta.        */
export function simulateAdbs(series, opts) {
  opts = opts || {};
  const pts = (series || []).filter(p => p && isFinite(p.v) && isFinite(p.t)).sort((a, b) => a.t - b.t);
  if (pts.length < 8) return null;
  const modo = opts.mode || 'dual';
  const minMa = isFinite(opts.minMa) ? opts.minMa : 1.0;
  const maxMa = isFinite(opts.maxMa) ? opts.maxMa : 3.0;
  const mediaMs = isFinite(opts.averagingMs) ? opts.averagingMs : 3000;
  const rampa = isFinite(opts.rampMaPerSec) ? opts.rampMaPerSec : 0.2;
  const vals = pts.map(p => p.v);
  const lower = isFinite(opts.lower) ? opts.lower : quantile(vals, 0.25);
  const upper = isFinite(opts.upper) ? opts.upper : quantile(vals, 0.75);

  const suave = suavizaCausal(pts, mediaMs);

  /* amplitude ALVO em cada instante, conforme o modo */
  const alvo = suave.map(v => {
    if (modo === 'single') return v > upper ? maxMa : minMa;
    /* duplo: abaixo → mínima; entre → rampa proporcional; acima → máxima */
    if (v <= lower) return minMa;
    if (v >= upper) return maxMa;
    const fr = (v - lower) / ((upper - lower) || 1);
    return minMa + fr * (maxMa - minMa);
  });

  /* amplitude ENTREGUE, limitada pela taxa de rampa do dispositivo */
  const entregue = new Array(pts.length);
  entregue[0] = alvo[0];
  for (let i = 1; i < pts.length; i++) {
    const dt = Math.max(0, (pts[i].t - pts[i - 1].t) / 1000);
    const passoMax = rampa * dt;
    const d = alvo[i] - entregue[i - 1];
    entregue[i] = entregue[i - 1] + Math.max(-passoMax, Math.min(passoMax, d));
  }

  /* estados e transições sobre a amplitude entregue */
  const estadoDe = a => a >= maxMa - 1e-9 ? 'alta' : a <= minMa + 1e-9 ? 'baixa' : 'intermediária';
  const estados = entregue.map(estadoDe);
  let transicoes = 0;
  const episodios = [];
  let ini = 0;
  for (let i = 1; i <= estados.length; i++) {
    if (i === estados.length || estados[i] !== estados[ini]) {
      episodios.push({ state: estados[ini], durMs: pts[Math.min(i, pts.length - 1)].t - pts[ini].t });
      if (i < estados.length) transicoes++;
      ini = i;
    }
  }
  const spanMs = pts[pts.length - 1].t - pts[0].t;
  const horas = spanMs / 36e5;
  const fracao = e => estados.filter(s => s === e).length / estados.length;
  const durDe = e => { const d = episodios.filter(x => x.state === e).map(x => x.durMs).filter(v => v > 0); return d.length ? median(d) : NaN; };
  const mediaEntregue = entregue.reduce((a, b) => a + b, 0) / entregue.length;

  return {
    mode: modo, lower: +lower.toFixed(4), upper: +upper.toFixed(4),
    minMa, maxMa, averagingMs: mediaMs, rampMaPerSec: rampa,
    nPoints: pts.length, spanHours: +horas.toFixed(2),
    pctLow: +(100 * fracao('baixa')).toFixed(1),
    pctMid: +(100 * fracao('intermediária')).toFixed(1),
    pctHigh: +(100 * fracao('alta')).toFixed(1),
    transitions: transicoes,
    transitionsPerHour: horas > 0 ? +(transicoes / horas).toFixed(2) : NaN,
    medianLowMin: +(durDe('baixa') / 60000).toFixed(1),
    medianHighMin: +(durDe('alta') / 60000).toFixed(1),
    dutyCycle: +(fracao('alta') + 0.5 * fracao('intermediária')).toFixed(3),
    meanAmplitudeMa: +mediaEntregue.toFixed(3),
    /* energia ∝ amplitude²; referência: cDBS na amplitude máxima */
    energyVsContinuous: +(entregue.reduce((a, b) => a + b * b, 0) / entregue.length / (maxMa * maxMa)).toFixed(3),
    delivered: entregue, smoothed: suave, times: pts.map(p => p.t)
  };
}

/* Varredura de pares de limiares — é como o usuário escolhe visualmente. */
export function thresholdSweep(series, opts) {
  opts = opts || {};
  const pts = (series || []).filter(p => p && isFinite(p.v));
  if (pts.length < 8) return null;
  const vals = pts.map(p => p.v);
  const n = opts.n || 12;
  const lo = quantile(vals, 0.05), hi = quantile(vals, 0.95);
  const eixo = Array.from({ length: n }, (_, i) => lo + (hi - lo) * i / (n - 1));
  const grade = [];
  eixo.forEach((L, i) => eixo.forEach((U, j) => {
    if (U <= L) { grade.push({ i, j, lower: L, upper: U, valid: false }); return; }
    const s = simulateAdbs(series, Object.assign({}, opts, { lower: L, upper: U }));
    grade.push({
      i, j, lower: +L.toFixed(3), upper: +U.toFixed(3), valid: true,
      pctHigh: s.pctHigh, transitionsPerHour: s.transitionsPerHour,
      dutyCycle: s.dutyCycle, energyVsContinuous: s.energyVsContinuous
    });
  }));
  return { axis: eixo.map(v => +v.toFixed(3)), grid: grade };
}

/* Três critérios de sugestão de limiares — a escolha continua do usuário. */
export function suggestThresholds(series, opts) {
  opts = opts || {};
  const vals = (series || []).map(p => p.v).filter(isFinite);
  if (vals.length < 8) return null;
  const sugestoes = [];

  sugestoes.push({
    criterion: 'percentis empíricos (p10/p90)',
    lower: +quantile(vals, 0.10).toFixed(3), upper: +quantile(vals, 0.90).toFixed(3),
    rationale: 'usa a distribuição real do próprio paciente; ponto de partida conservador'
  });

  /* separação dos estados ON/OFF, quando existirem dois patamares */
  if (opts.states && isFinite(opts.states.threshold)) {
    const t = opts.states.threshold;
    const meia = (opts.states.betaHigh - opts.states.betaLow) / 4;
    sugestoes.push({
      criterion: 'separação dos estados ON/OFF (F13)',
      lower: +(t - meia).toFixed(3), upper: +(t + meia).toFixed(3),
      rationale: `centrados no limiar que separa os dois estados de beta` +
        (isFinite(opts.states.bimodality) ? ` (bimodalidade ${opts.states.bimodality.toFixed(3)})` : ''),
      caveat: opts.states.bimodality > 0.555 ? null
        : 'a distribuição é praticamente unimodal — esta sugestão é apenas descritiva'
    });
  }

  /* duty cycle alvo definido pelo usuário */
  const alvoDuty = isFinite(opts.targetDutyCycle) ? opts.targetDutyCycle : 0.5;
  const q = 1 - alvoDuty;
  sugestoes.push({
    criterion: `duty cycle alvo de ${(alvoDuty * 100).toFixed(0)}%`,
    lower: +quantile(vals, Math.max(0.02, q - 0.15)).toFixed(3),
    upper: +quantile(vals, Math.min(0.98, q + 0.15)).toFixed(3),
    rationale: 'limiares que colocam aproximadamente a fração desejada do tempo em amplitude alta'
  });

  return { suggestions: sugestoes, note: 'a escolha final é do usuário; cada critério responde a uma pergunta diferente' };
}
