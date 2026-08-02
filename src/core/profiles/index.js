/* profiles/index.js — perfis de doença como objetos declarativos.

   POR QUE ISTO EXISTE. Até aqui o software falava uma doença só: bandas,
   leitura clínica, glossário e figuras estavam cabeados em doença de Parkinson
   e STN. A revisão aponta que distonia e tremor essencial estão
   sub-representados em TODAS as ferramentas existentes — é lacuna real do campo
   e a mais barata de ocupar.

   Cada perfil é declarativo, SEM lógica: bandas, normalização, seleção de banda
   crônica, sinais externos recomendados, glossário e referências. A UI, o CSV
   exportado e o relatório leem o perfil ativo; nada de banda ou leitura clínica
   pode voltar a ficar hardcoded em app.js.

   Ver docs/perfis.md para a tabela comparativa.                              */

/* Paleta compartilhada, para que a mesma banda tenha a mesma cor entre perfis */
const COR = {
  delta: '#3B3F73', theta: '#2F6E8E', alpha: '#2E8B7A',
  lowbeta: '#B8912A', highbeta: '#C4652B', gamma: '#8E3B4E',
  tremor: '#7A3E9D', supra: '#B06BC9', thetaalpha: '#2F7E86'
};

/* ------------------------------------------------------------------ perfis */

export const PROFILES = {
  /* ---------------------------------------------------------- Parkinson --- */
  pd: {
    id: 'pd', label: 'Doença de Parkinson (STN/GPi)',
    diagnoses: ['ParkinsonsDisease', 'Parkinson'],
    targets: ['Stn', 'Gpi'],
    bands: [
      { key: 'delta', label: 'δ', lo: 1, hi: 4, color: COR.delta, clinicalReading: 'Frequências muito lentas; pouco específicas e sensíveis a artefato de movimento.' },
      { key: 'theta', label: 'θ', lo: 4, hi: 8, color: COR.theta, clinicalReading: 'Teta subtalâmico; associado a aspectos não motores (ansiedade traço) e a tremor.' },
      { key: 'alpha', label: 'α', lo: 8, hi: 13, color: COR.alpha, clinicalReading: 'Sobe com levodopa; parte do padrão de baixas frequências do estado ON.' },
      { key: 'lowbeta', label: 'β↓', lo: 13, hi: 20, color: COR.lowbeta, primary: true, clinicalReading: 'Beta baixo — é o que mais responde à levodopa e o que rastreia bradicinesia e rigidez.' },
      { key: 'highbeta', label: 'β↑', lo: 20, hi: 35, color: COR.highbeta, primary: true, clinicalReading: 'Beta alto; responde menos à medicação que o beta baixo.' },
      { key: 'gamma', label: 'γ', lo: 35, hi: 100, color: COR.gamma, clinicalReading: 'Gama; a faixa 55–95 Hz abriga a gama finamente sintonizada e a gama entrained pela estimulação.' }
    ],
    primaryBand: { lo: 13, hi: 35, label: 'beta' },
    peakSearch: [{ band: 'beta', lo: 13, hi: 35, method: 'aperiodic_corrected' }],
    normalization: 'aperiodic_corrected',
    burstBand: { lo: 13, hi: 30 }, burstMethodDefault: 'hilbert_percentile',
    chronicBandSelection: 'a_priori',
    requiredExternalSignals: [],
    glossary: {
      primario: 'pico β (beta)',
      intuicao: 'O beta (13–35 Hz) é o “ritmo do freio” dos núcleos da base: sobe quando a medicação está no fim (OFF) e cai quando a levodopa faz efeito (ON) ou sob estimulação eficaz.',
      picoTexto: 'Frequência onde o beta é mais forte. Beta alto acompanha mais rigidez e lentidão.',
      elegibilidade: 'A presença de um pico beta nítido é pré-requisito para programar o DBS adaptativo guiado por beta.'
    },
    references: [
      'Neumann W-J, et al. Brain Stimul 2021;14:1301-1306.',
      'Mathiopoulou V, et al. Nat Commun 2025;16:2956 (gama entrained).',
      'van Rheede JJ, et al. npj Parkinsons Dis 2022;8:88 (circadiano).'
    ]
  },

  /* ------------------------------------------------------------ distonia --- */
  dystonia: {
    id: 'dystonia', label: 'Distonia (GPi)',
    diagnoses: ['Dystonia', 'DystonicDisorder'],
    targets: ['Gpi'],
    bands: [
      { key: 'delta', label: 'δ', lo: 1, hi: 4, color: COR.delta, clinicalReading: 'Faixa em que o tremor cefálico da distonia cervical se sobrepõe ao sinal — cuidado.' },
      { key: 'thetaalpha', label: 'θα', lo: 4, hi: 12, color: COR.thetaalpha, primary: true, clinicalReading: 'Teta-alfa palidal — é o biomarcador da distonia. Pico médio descrito em 5,7 Hz (DP ± 2,1).' },
      { key: 'lowbeta', label: 'β↓', lo: 13, hi: 20, color: COR.lowbeta, clinicalReading: 'Beta baixo; aqui serve de banda de contraste, não de biomarcador.' },
      { key: 'highbeta', label: 'β↑', lo: 20, hi: 35, color: COR.highbeta, clinicalReading: 'Beta alto; contraste.' },
      { key: 'gamma', label: 'γ', lo: 35, hi: 100, color: COR.gamma, clinicalReading: 'Gama; pouco caracterizada em distonia.' }
    ],
    primaryBand: { lo: 4, hi: 12, label: 'teta-alfa' },
    peakSearch: [{ band: 'thetaalpha', lo: 4, hi: 12, method: 'aperiodic_corrected' }],
    /* normalização específica: minimiza contaminação espectral por movimentos
       distônicos fásicos e mioclonias (Thenaisie et al. 2021) */
    normalization: 'sd_6_96hz',
    burstBand: { lo: 4, hi: 12 }, burstMethodDefault: 'hilbert_percentile',
    chronicBandSelection: 'largest_peak',
    requiredExternalSignals: ['imu'],
    warnings: [{
      when: 'no_imu',
      html: 'O <b>tremor cefálico</b> da distonia cervical ocorre a <b>1–6 Hz</b> e cai DIRETAMENTE sobre o biomarcador teta-alfa do GPi. ' +
        'Sem um canal de IMU para regredir o movimento, o risco de reportar <b>artefato mecânico como biomarcador</b> é real. ' +
        'As métricas de teta-alfa abaixo devem ser lidas com essa ressalva.'
    }],
    glossary: {
      primario: 'pico teta-alfa (4–12 Hz)',
      intuicao: 'Na distonia o marcador palidal não é o beta: são as oscilações lentas de 4–12 Hz do GPi, que acompanham a gravidade da distonia.',
      picoTexto: 'Frequência onde a oscilação lenta do GPi é mais forte; a média descrita na literatura é 5,7 Hz.',
      elegibilidade: 'Ausência de pico claro em um dos lados é achado comum e não invalida o outro (Hubers et al. não detectaram pico no GPi direito).'
    },
    references: [
      'Thenaisie Y, et al. J Neural Eng 2021;18:042002 (pico teta-alfa 5,7 ± 2,1 Hz; contatos 0-3).',
      'Hubers D, et al. Mov Disord 2025 (correlação −0,69 entre gravidade e LFP do GPi).',
      'COMEDD study protocol. Dystonia 2026.'
    ]
  },

  /* ---------------------------------------------------- tremor essencial --- */
  et: {
    id: 'et', label: 'Tremor essencial (VIM)',
    diagnoses: ['EssentialTremor', 'Tremor'],
    targets: ['Vim', 'Vim_Psa', 'Psa'],
    /* as bandas de tremor são DERIVADAS da frequência medida, não fixas */
    bands: [
      { key: 'tremor', label: 'f₀', lo: 2, hi: 12, color: COR.tremor, primary: true, dynamic: 'tremor_fundamental', clinicalReading: 'Frequência do tremor do próprio paciente — não é uma banda fixa, é medida.' },
      { key: 'supra', label: '2f₀', lo: 8, hi: 24, color: COR.supra, dynamic: 'tremor_supraharmonic', clinicalReading: 'Supraharmônico do tremor; sua presença ajuda a confirmar que a oscilação é do tremor.' },
      { key: 'lowbeta', label: 'β↓', lo: 13, hi: 20, color: COR.lowbeta, clinicalReading: 'Beta talâmico — banda de apoio, estudada para closed-loop.' },
      { key: 'highbeta', label: 'β↑', lo: 20, hi: 30, color: COR.highbeta, clinicalReading: 'Beta talâmico alto; apoio.' }
    ],
    primaryBand: { lo: 2, hi: 12, label: 'frequência do tremor' },
    peakSearch: [{ band: 'tremor', lo: 2, hi: 12, method: 'accelerometer_first' }],
    normalization: 'relative',
    burstBand: { lo: 3, hi: 10 }, burstMethodDefault: 'hilbert_percentile',
    chronicBandSelection: 'largest_peak',
    requiredExternalSignals: ['accelerometer'],
    warnings: [{
      when: 'no_accelerometer',
      html: 'Sem <b>acelerômetro</b>, a frequência do tremor vem do maior pico do espectro do LFP, o que é menos confiável. ' +
        'A <b>coerência LFP–acelerômetro</b> na frequência do tremor e na supraharmônica é o método que distingue oscilação talâmica real de artefato mecânico.'
    }, {
      when: 'always',
      html: 'Com o PC+S, a ocorrência frequente de <b>artefatos de EKG</b> impediu a análise talâmica automática para closed-loop — verificar contaminação cardíaca (F15) é especialmente crítico neste perfil.'
    }],
    glossary: {
      primario: 'frequência do tremor e supraharmônico',
      intuicao: 'No tremor essencial o biomarcador não é uma banda fixa: é a frequência do tremor daquele paciente (tipicamente 4–6 Hz) e o seu supraharmônico (2×).',
      picoTexto: 'Frequência do tremor medida no sinal; idealmente confirmada por acelerômetro.',
      elegibilidade: 'A estimulação pode suprimir pouco a potência do LFP e ainda assim DESACOPLAR tremor e LFP — o desacoplamento é a métrica de resposta, não a supressão.'
    },
    references: [
      'Buijink AWG, et al. Clin Neurophysiol Pract 2022;7:103-106 (pico de tremor a 3,8 Hz e supraharmônico).',
      'Fung W, et al. Mov Disord 2025 (desacoplamento tremor–LFP como métrica de resposta).',
      'Sci Rep 2023;13 (beta talâmico para closed-loop).'
    ]
  },

  /* ----------------------------------------------------------- epilepsia --- */
  epilepsy: {
    id: 'epilepsy', label: 'Epilepsia (ANT)',
    diagnoses: ['Epilepsy'],
    targets: ['Ant', 'AnteriorNucleus'],
    bands: [
      { key: 'delta', label: 'δ', lo: 1, hi: 4, color: COR.delta, clinicalReading: 'Delta; relevante em ciclos de sono e em atividade lenta.' },
      { key: 'theta', label: 'θ', lo: 4, hi: 8, color: COR.theta, primary: true, clinicalReading: 'Teta do núcleo anterior; faixa de interesse em ciclos de longo prazo.' },
      { key: 'alpha', label: 'α', lo: 8, hi: 13, color: COR.alpha, clinicalReading: 'Alfa.' },
      { key: 'lowbeta', label: 'β↓', lo: 13, hi: 20, color: COR.lowbeta, clinicalReading: 'Beta baixo.' },
      { key: 'highbeta', label: 'β↑', lo: 20, hi: 35, color: COR.highbeta, clinicalReading: 'Beta alto.' },
      { key: 'gamma', label: 'γ', lo: 35, hi: 100, color: COR.gamma, clinicalReading: 'Gama.' }
    ],
    primaryBand: { lo: 4, hi: 8, label: 'teta' },
    peakSearch: [{ band: 'theta', lo: 1, hi: 13, method: 'aperiodic_corrected' }],
    normalization: 'relative',
    burstBand: { lo: 4, hi: 13 }, burstMethodDefault: 'hilbert_percentile',
    chronicBandSelection: 'largest_peak',
    requiredExternalSignals: [],
    glossary: {
      primario: 'ritmo do núcleo anterior',
      intuicao: 'Em epilepsia com estimulação do núcleo anterior do tálamo, o interesse está em ciclos de longo prazo do sinal, mais do que num pico espectral único.',
      picoTexto: 'Maior pico do espectro nas bandas lentas.',
      elegibilidade: 'Caracterização ainda inicial na literatura — trate como exploratório.'
    },
    references: ['J Neural Eng 2024. doi:10.1088/1741-2552/ad1dc3 (sensing do Percept em ANT).']
  },

  /* ------------------------------------------------------------- genérico -- */
  generic: {
    id: 'generic', label: 'Genérico configurável',
    diagnoses: [], targets: [],
    bands: [
      { key: 'delta', label: 'δ', lo: 1, hi: 4, color: COR.delta, clinicalReading: '' },
      { key: 'theta', label: 'θ', lo: 4, hi: 8, color: COR.theta, clinicalReading: '' },
      { key: 'alpha', label: 'α', lo: 8, hi: 13, color: COR.alpha, clinicalReading: '' },
      { key: 'lowbeta', label: 'β↓', lo: 13, hi: 20, color: COR.lowbeta, primary: true, clinicalReading: '' },
      { key: 'highbeta', label: 'β↑', lo: 20, hi: 35, color: COR.highbeta, clinicalReading: '' },
      { key: 'gamma', label: 'γ', lo: 35, hi: 100, color: COR.gamma, clinicalReading: '' }
    ],
    primaryBand: { lo: 13, hi: 35, label: 'banda primária' },
    peakSearch: [{ band: 'custom', lo: 13, hi: 35, method: 'aperiodic_corrected' }],
    normalization: 'relative',
    burstBand: { lo: 13, hi: 30 }, burstMethodDefault: 'hilbert_percentile',
    chronicBandSelection: 'largest_peak',
    requiredExternalSignals: [],
    editable: true,
    glossary: {
      primario: 'banda definida pelo usuário',
      intuicao: 'Perfil aberto: defina bandas, rótulos e leituras clínicas para acompanhar biomarcadores que ainda não existem na literatura.',
      picoTexto: 'Maior pico dentro da banda primária configurada.',
      elegibilidade: '—'
    },
    references: []
  }
};

export const PROFILE_IDS = Object.keys(PROFILES);

export function getProfile(id) { return PROFILES[id] || PROFILES.pd; }

/* Sugere o perfil a partir do Diagnosis e do LeadLocation do JSON. O usuário
   confirma ou troca — nunca é aplicado silenciosamente sem exibir qual foi. */
export function suggestProfile(parsed) {
  if (!parsed) return 'pd';
  const dx = String((parsed.patient && parsed.patient.diagnosis) || '');
  const alvos = (parsed.leads || []).map(l => String(l.target || ''));
  for (const id of PROFILE_IDS) {
    const p = PROFILES[id];
    if (p.diagnoses.some(d => dx.toLowerCase().includes(d.toLowerCase()))) return id;
  }
  for (const id of PROFILE_IDS) {
    const p = PROFILES[id];
    if (p.targets.length && alvos.some(a => p.targets.some(t => a.toLowerCase() === t.toLowerCase()))) return id;
  }
  return 'pd';
}

/* Bandas efetivas do perfil. Em TE, as bandas de tremor são derivadas da
   frequência medida — por isso `dynamic` e o parâmetro tremorHz.            */
export function bandsOf(profile, opts) {
  opts = opts || {};
  const f0 = opts.tremorHz;
  return getProfile(profile.id || profile).bands.map(b => {
    if (!b.dynamic || !isFinite(f0)) return b;
    if (b.dynamic === 'tremor_fundamental')
      return Object.assign({}, b, { lo: Math.max(0.5, f0 - 1), hi: f0 + 1, label: `f₀=${f0.toFixed(1)}` });
    if (b.dynamic === 'tremor_supraharmonic')
      return Object.assign({}, b, { lo: Math.max(1, 2 * f0 - 1.5), hi: 2 * f0 + 1.5, label: `2f₀=${(2 * f0).toFixed(1)}` });
    return b;
  });
}

/* -------------------------------------------------------- normalizações -- */
/* normalizeSpectrum(f, p, modo) → potência normalizada conforme o perfil.
   'sd_6_96hz' é a normalização de Thenaisie et al. para distonia: divide o
   espectro pelo desvio-padrão calculado entre 6 e 96 Hz, o que minimiza a
   contaminação por movimentos distônicos fásicos e mioclonias.              */
export function normalizeSpectrum(f, p, modo) {
  const out = Array.from(p);
  if (modo === 'relative') {
    let tot = 0;
    for (let i = 0; i < f.length; i++) if (f[i] >= 1 && f[i] <= 100 && isFinite(p[i])) tot += p[i];
    return tot > 0 ? out.map(v => 100 * v / tot) : out;
  }
  if (modo === 'sd_6_96hz' || modo === 'zscore') {
    const lo = modo === 'sd_6_96hz' ? 6 : 1, hi = modo === 'sd_6_96hz' ? 96 : 100;
    const v = [];
    for (let i = 0; i < f.length; i++) if (f[i] >= lo && f[i] <= hi && isFinite(p[i])) v.push(p[i]);
    if (v.length < 3) return out;
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const s = Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / (v.length - 1)) || 1;
    return modo === 'zscore' ? out.map(x => (x - m) / s) : out.map(x => x / s);
  }
  return out;                       // 'aperiodic_corrected' é tratado no specparam
}

/* ------------------------------------------- frequência do tremor (TE) --- */
/* detectTremorFrequency(f, p, {searchRange, externalAccel, accelFs})
   O biomarcador do TE não é uma banda fixa: é a frequência do tremor e seus
   supraharmônicos. Com acelerômetro, a frequência vem dele (mais confiável).
   Retorna a fundamental, a supraharmônica e a razão entre elas.             */
export function detectTremorFrequency(f, p, opts) {
  opts = opts || {};
  const [lo, hi] = opts.searchRange || [2, 12];
  const maiorEm = (a, b, ff, pp) => {
    let bi = -1, bv = -Infinity;
    for (let i = 0; i < ff.length; i++)
      if (ff[i] >= a && ff[i] <= b && isFinite(pp[i]) && pp[i] > bv) { bv = pp[i]; bi = i; }
    return bi >= 0 ? { f: ff[bi], v: pp[bi] } : { f: NaN, v: NaN };
  };
  let fonte = 'lfp';
  let fund = maiorEm(lo, hi, f, p);
  if (opts.accelSpectrum && opts.accelSpectrum.f && opts.accelSpectrum.p) {
    const a = maiorEm(lo, hi, opts.accelSpectrum.f, opts.accelSpectrum.p);
    if (isFinite(a.f)) { fund = { f: a.f, v: maiorEm(a.f - 0.5, a.f + 0.5, f, p).v }; fonte = 'acelerômetro'; }
  }
  if (!isFinite(fund.f)) return null;
  const supra = maiorEm(2 * fund.f - 1.5, 2 * fund.f + 1.5, f, p);
  const tri = maiorEm(3 * fund.f - 2, 3 * fund.f + 2, f, p);
  return {
    fundamentalHz: fund.f, fundamentalPower: fund.v,
    supraharmonicHz: supra.f, supraharmonicPower: supra.v,
    supraToFundamentalRatio: (isFinite(supra.v) && isFinite(fund.v) && fund.v > 0) ? supra.v / fund.v : NaN,
    thirdHarmonicHz: tri.f,
    source: fonte,
    hasSupraharmonic: isFinite(supra.v) && isFinite(fund.v) && supra.v > 0.05 * fund.v
  };
}

/* --------------------------------- correlação sintoma-LFP (distonia) ----- */
/* Correlação de Spearman com IC por bootstrap. Usada para relacionar gravidade
   clínica importada pelo usuário com a série crônica (Hubers et al. 2025:
   ρ = −0,69, p < 0,001, com média móvel de 5 dias).                         */
export function spearman(x, y, opts) {
  opts = opts || {};
  const pares = [];
  for (let i = 0; i < Math.min(x.length, y.length); i++)
    if (isFinite(x[i]) && isFinite(y[i])) pares.push([x[i], y[i]]);
  const n = pares.length;
  if (n < 4) return null;
  const posto = vals => {
    const ord = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(vals.length);
    let i = 0;
    while (i < ord.length) {
      let j = i; while (j + 1 < ord.length && ord[j + 1][0] === ord[i][0]) j++;
      const media = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[ord[k][1]] = media;
      i = j + 1;
    }
    return r;
  };
  const rho = (pp) => {
    const rx = posto(pp.map(p => p[0])), ry = posto(pp.map(p => p[1]));
    const mx = rx.reduce((a, b) => a + b, 0) / pp.length, my = ry.reduce((a, b) => a + b, 0) / pp.length;
    let num = 0, vx = 0, vy = 0;
    for (let i = 0; i < pp.length; i++) {
      const dx = rx[i] - mx, dy = ry[i] - my;
      num += dx * dy; vx += dx * dx; vy += dy * dy;
    }
    return (vx > 0 && vy > 0) ? num / Math.sqrt(vx * vy) : NaN;
  };
  const r = rho(pares);
  /* IC por bootstrap determinístico (reamostragem por índice pseudoaleatório) */
  const nBoot = opts.nBoot || 500;
  let semente = 12345;
  const prox = () => { semente = (semente * 1103515245 + 12345) & 0x7fffffff; return semente / 0x7fffffff; };
  const rs = [];
  for (let b = 0; b < nBoot; b++) {
    const am = [];
    for (let i = 0; i < n; i++) am.push(pares[Math.floor(prox() * n)]);
    const v = rho(am);
    if (isFinite(v)) rs.push(v);
  }
  rs.sort((a, b) => a - b);
  const q = t => rs.length ? rs[Math.min(rs.length - 1, Math.floor(t * (rs.length - 1)))] : NaN;
  /* p aproximado pelo t de Student sobre rho */
  const tStat = isFinite(r) && Math.abs(r) < 1 ? r * Math.sqrt((n - 2) / (1 - r * r)) : Infinity;
  return { rho: r, n, ci95: [q(0.025), q(0.975)], t: tStat };
}

/* Média móvel de N dias sobre uma série {t (ms), v}. Hubers et al. usam 5 dias. */
export function movingAverageDays(serie, dias) {
  const jan = (dias || 5) * 864e5;
  return serie.map(pt => {
    let s = 0, n = 0;
    serie.forEach(o => { if (Math.abs(o.t - pt.t) <= jan / 2 && isFinite(o.v)) { s += o.v; n++; } });
    return { t: pt.t, v: n ? s / n : NaN, n };
  });
}
