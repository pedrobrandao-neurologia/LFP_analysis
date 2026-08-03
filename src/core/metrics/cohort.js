/* metrics/cohort.js — resumo de coorte.

   O QUE FAZ. Recebe um pacote de métricas por SUJEITO e devolve a tabela da
   coorte mais as estatísticas de grupo. É o passo que transforma "analisei este
   paciente" em "tenho uma amostra".

   O QUE ELE SE RECUSA A FAZER. Com poucos sujeitos, média e desvio-padrão de
   grupo são números que parecem uma medida e não são. Abaixo de `minN` (padrão
   5) o resumo sai marcado como DESCRITIVO e sem qualquer teste; a mediana e o
   intervalo continuam, porque descrevem o que se tem, mas o IC normal-teórico
   não aparece. Prevalência de pico beta e proporções trazem IC de Wilson, que
   se comporta bem com n pequeno — ao contrário do IC de Wald, que produz
   intervalos fora de [0,1] justamente quando a proporção é extrema.

   Unidades: as das métricas de origem.

   Referências: Brown LD, et al. Stat Sci 2001;16:101-133 (IC de proporção);
   Cascino et al., npj Parkinsons Dis 2026 (prevalência de elegibilidade).    */

import { median, quantile, mean, sd } from '../stats/descriptive.js';

/* IC de Wilson para uma proporção — o correto com n pequeno. */
export function wilsonCI(k, n, z) {
  z = z || 1.959964;
  if (!(n > 0)) return [NaN, NaN];
  const p = k / n, z2 = z * z;
  const den = 1 + z2 / n;
  const centro = (p + z2 / (2 * n)) / den;
  const meia = (z / den) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return [Math.max(0, +(centro - meia).toFixed(4)), Math.min(1, +(centro + meia).toFixed(4))];
}

const CAMPOS_AGUDOS = [
  { key: 'primary_peak_hz', label: 'frequência do pico primário (Hz)' },
  { key: 'beta_rel_pct', label: 'potência relativa da banda (%)' },
  { key: 'aperiodic_exponent', label: 'expoente aperiódico' },
  { key: 'burst_rate_hz', label: 'taxa de bursts (/s)' },
  { key: 'burst_mean_ms', label: 'duração média de burst (ms)' }
];
const CAMPOS_CRONICOS = [
  { key: 'mesor', label: 'MESOR' },
  { key: 'amp_24h', label: 'amplitude de 24 h' },
  { key: 'acrophase_24h', label: 'acrofase (h)', circular: true },
  { key: 'off_pct', label: '% do tempo em beta alto' },
  { key: 'n_days', label: 'dias de Timeline' }
];

function resume(valores, circular) {
  const v = valores.filter(isFinite);
  if (!v.length) return null;
  if (circular) {
    /* acrofase é grandeza circular: média aritmética de horários é errada */
    const ang = v.map(h => 2 * Math.PI * h / 24);
    const c = mean(ang.map(Math.cos)), s = mean(ang.map(Math.sin));
    let m = Math.atan2(s, c); if (m < 0) m += 2 * Math.PI;
    const R = Math.hypot(c, s);
    return {
      n: v.length, circular: true,
      mean: +(m / (2 * Math.PI) * 24).toFixed(3),
      concentration: +R.toFixed(4),
      dispersionHours: +(24 / (2 * Math.PI) * Math.sqrt(-2 * Math.log(Math.max(1e-12, R)))).toFixed(3),
      min: +Math.min.apply(null, v).toFixed(3), max: +Math.max.apply(null, v).toFixed(3)
    };
  }
  return {
    n: v.length, circular: false,
    median: +median(v).toFixed(4),
    q1: +quantile(v, 0.25).toFixed(4), q3: +quantile(v, 0.75).toFixed(4),
    mean: +mean(v).toFixed(4), sd: v.length > 1 ? +sd(v).toFixed(4) : NaN,
    min: +Math.min.apply(null, v).toFixed(4), max: +Math.max.apply(null, v).toFixed(4)
  };
}

/* cohortSummary(bundles, opts) — `bundles`: uma saída de extractMetrics por sujeito. */
export function cohortSummary(bundles, opts) {
  opts = opts || {};
  const minN = isFinite(opts.minN) ? opts.minN : 5;
  const lista = (bundles || []).filter(b => b && b.subject);
  if (!lista.length) return null;

  const sujeitos = lista.map(b => {
    const ag = b.acute || [], cr = b.chronic || [];
    const porHemi = {};
    ['Left', 'Right'].forEach(h => {
      const a = ag.filter(r => r.hemisphere === h);
      const c = cr.find(r => r.hemisphere === h);
      if (!a.length && !c) return;
      const ultima = a.length ? a[a.length - 1] : null;
      porHemi[h] = {
        hasPeak: ultima ? !!(ultima.has_beta_peak || ultima.has_theta_alpha_peak) : null,
        peakHz: ultima ? ultima.primary_peak_hz : NaN,
        aperiodicExponent: ultima ? ultima.aperiodic_exponent : NaN,
        burstRate: ultima ? ultima.burst_rate_hz : NaN,
        burstMeanMs: ultima ? ultima.burst_mean_ms : NaN,
        betaRelPct: ultima ? ultima.beta_rel_pct : NaN,
        mesor: c ? c.mesor : NaN, amp24: c ? c.amp_24h : NaN,
        acrophase: c ? c.acrophase_24h : NaN, offPct: c ? c.off_pct : NaN,
        nDays: c ? c.n_days : NaN
      };
    });
    return {
      subjectId: b.subject.id, diagnosis: b.subject.diagnosis, profile: b.subject.profile_id,
      implantDate: b.subject.implant_date, nSessions: (b.sessions || []).length,
      targets: (b.subject.targets || []).map(t => `${t.hemisphere}:${t.target}`).join(' '),
      hemispheres: porHemi,
      nHemisWithPeak: Object.values(porHemi).filter(x => x.hasPeak === true).length,
      nHemisEvaluated: Object.values(porHemi).filter(x => x.hasPeak !== null).length
    };
  });

  /* estatísticas por hemisfério, agrupando todos os sujeitos */
  const linhas = [];
  sujeitos.forEach(s => Object.keys(s.hemispheres).forEach(h => linhas.push(Object.assign({ subjectId: s.subjectId, hemisphere: h }, s.hemispheres[h]))));

  const mapa = {
    primary_peak_hz: 'peakHz', beta_rel_pct: 'betaRelPct', aperiodic_exponent: 'aperiodicExponent',
    burst_rate_hz: 'burstRate', burst_mean_ms: 'burstMeanMs',
    mesor: 'mesor', amp_24h: 'amp24', acrophase_24h: 'acrophase', off_pct: 'offPct', n_days: 'nDays'
  };
  const estat = CAMPOS_AGUDOS.concat(CAMPOS_CRONICOS).map(c => ({
    field: c.key, label: c.label,
    all: resume(linhas.map(l => l[mapa[c.key]]), c.circular),
    left: resume(linhas.filter(l => l.hemisphere === 'Left').map(l => l[mapa[c.key]]), c.circular),
    right: resume(linhas.filter(l => l.hemisphere === 'Right').map(l => l[mapa[c.key]]), c.circular)
  })).filter(e => e.all);

  /* prevalência de pico — a estatística que muda o cálculo amostral de um
     estudo, e que quase nunca é reportada */
  const avaliados = linhas.filter(l => l.hasPeak !== null);
  const comPico = avaliados.filter(l => l.hasPeak).length;
  const bilaterais = sujeitos.filter(s => s.nHemisEvaluated === 2 && s.nHemisWithPeak === 2).length;
  const comDoisAvaliados = sujeitos.filter(s => s.nHemisEvaluated === 2).length;

  const n = sujeitos.length;
  return {
    nSubjects: n, nHemispheres: linhas.length,
    subjects: sujeitos, rows: linhas, stats: estat,
    prevalence: {
      byHemisphere: { k: comPico, n: avaliados.length, pct: avaliados.length ? +(100 * comPico / avaliados.length).toFixed(1) : NaN, ci95: wilsonCI(comPico, avaliados.length) },
      bilateral: { k: bilaterais, n: comDoisAvaliados, pct: comDoisAvaliados ? +(100 * bilaterais / comDoisAvaliados).toFixed(1) : NaN, ci95: wilsonCI(bilaterais, comDoisAvaliados) },
      reference: 'ADAPT-PD: 84,8% por hemisfério e 64,2% bilateral (n = 51); registro BrainSense: 89,0% e 69,4% (n = 113)',
      ciMethod: 'IC de Wilson — o de Wald produz intervalos fora de [0,1] justamente quando a proporção é extrema'
    },
    descriptiveOnly: n < minN,
    minN,
    note: n < minN
      ? `com ${n} sujeito(s), este resumo é DESCRITIVO: mediana e intervalo descrevem o que se tem, mas não ` +
        'sustentam inferência sobre a população. Nenhum teste de grupo é aplicado abaixo de ' + minN + ' sujeitos'
      : `${n} sujeitos — mediana e IQR por métrica; a prevalência traz IC de Wilson`,
    caveat: 'sujeitos com números diferentes de sessões contribuem com pesos diferentes para qualquer média entre ' +
      'sessões. As estatísticas acima usam a ÚLTIMA sessão de cada sujeito para as métricas agudas, para que cada ' +
      'pessoa entre uma vez.'
  };
}
