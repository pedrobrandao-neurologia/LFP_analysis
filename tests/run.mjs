#!/usr/bin/env node
/* ==========================================================================
   Suíte de testes do Percept LFP Studio.

       node tests/run.mjs                 # usa examples/ (dados sintéticos)
       node tests/run.mjs /caminho/jsons  # usa uma pasta própria

   Exercita: parser, DSP, estatística, camada gráfica e os 12 renderizadores
   de figura, com um DOM mínimo simulado (tests/shim.mjs).
   ========================================================================== */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { installDOM } from './shim.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASTA = process.argv[2] || path.join(RAIZ, 'examples');

installDOM();

/* carrega o bundle exatamente como o navegador o executa */
const html = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (scripts.length !== 3) { console.error('index.html não contém os 3 scripts esperados.'); process.exit(1); }
scripts.forEach(s => (0, eval)(s));
const C = globalThis.PerceptCore, P = globalThis.PerceptPlot, H = globalThis.__PLS__;

let ok = 0, falhas = 0, pulados = 0;
const t = (nome, fn) => {
  try { const r = fn(); ok++; console.log('  \u2713 ' + nome + (r ? '  \u2014 ' + r : '')); }
  catch (e) { falhas++; console.log('  \u2717 ' + nome + '  ->  ' + e.message); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sec = s => console.log('\n\u2500\u2500 ' + s);

/* ------------------------------------------------------------- 1. parser -- */
sec('parser');
const arquivos = fs.readdirSync(PASTA).filter(f => f.endsWith('.json'));
assert(arquivos.length, 'nenhum .json em ' + PASTA);
const parsed = arquivos.map(f => C.parsePercept(JSON.parse(fs.readFileSync(path.join(PASTA, f), 'utf8')), f));
t('lê todos os arquivos', () => `${parsed.length} arquivo(s)`);
t('pseudonimiza identificadores', () => {
  parsed.forEach(p => assert(/^sub-[0-9a-f]{8}$/.test(p.patient.idHash), 'hash inválido: ' + p.patient.idHash));
  return parsed.map(p => p.patient.idHash).join(' ');
});
t('detecta modalidades', () => {
  const inv = parsed.map(p => Object.entries(p.availability).filter(([, v]) => v > 0).length);
  assert(Math.max(...inv) >= 4, 'poucas modalidades detectadas');
  return 'máx. ' + Math.max(...inv) + ' modalidades num arquivo';
});
t('converte fuso horário', () => {
  const p = parsed.find(x => x.meta.utcOffsetMin != null);
  assert(p, 'nenhum offset lido');
  const h = C.localHour(Date.UTC(2025, 0, 6, 15, 30), p.meta.utcOffsetMin);
  assert(h >= 0 && h < 24, 'hora local fora de [0,24): ' + h);
  return `offset ${p.meta.utcOffsetMin} min`;
});

/* ---------------------------------------------------------------- 2. DSP -- */
sec('processamento de sinal');
const comSinal = parsed.find(p => p.bsTimeDomain.length);
if (!comSinal) { pulados += 6; console.log('  \u25cb sem sinal bruto nesta pasta'); }
else {
  const td = comSinal.bsTimeDomain[0];
  t('Welch PSD', () => {
    const w = C.welchPSD(td.data, td.fs, { nperseg: 512, overlap: .5 });
    assert(w.segments > 5, 'poucos segmentos');
    assert(Math.abs(w.df - td.fs / 512) < 1e-9, 'resolução espectral errada');
    return `${w.segments} segmentos, \u0394f=${w.df.toFixed(3)} Hz`;
  });
  t('pico beta é recuperado', () => {
    const w = C.welchPSD(td.data, td.fs, { nperseg: 512 });
    let bi = -1; w.f.forEach((f, i) => { if (f >= 10 && f <= 35 && (bi < 0 || w.p[i] > w.p[bi])) bi = i; });
    assert(bi >= 0, 'nenhum bin na faixa 10-35 Hz');
    assert(w.f[bi] >= 10 && w.f[bi] <= 35, 'pico fora da faixa beta');
    return `pico em ${w.f[bi].toFixed(1)} Hz`;
  });
  t('parametrização aperiódica', () => {
    const w = C.welchPSD(td.data, td.fs, { nperseg: 512 });
    const ap = C.fitAperiodic(Array.from(w.f), Array.from(w.p), { fmin: 2, fmax: 95 });
    assert(ap, 'ajuste nulo');
    assert(ap.exponent > 0.2 && ap.exponent < 5, 'expoente implausível: ' + ap.exponent);
    return `\u03c7=${ap.exponent.toFixed(2)}, R\u00b2=${ap.r2.toFixed(3)}`;
  });
  t('filtro de fase zero preserva o comprimento', () => {
    const bp = C.bandpassFFT(td.data, td.fs, 13, 20);
    assert(bp.length === td.data.length, 'comprimento alterado');
    assert(bp.every(Number.isFinite), 'NaN no sinal filtrado');
    return `${bp.length} amostras`;
  });
  t('detecção de bursts e histograma consistente', () => {
    const env = C.hilbertEnvelope(C.bandpassFFT(td.data, td.fs, 13, 20));
    const b = C.detectBursts(env, td.fs, { percentile: 75, minDurationMs: 100 });
    const soma = b.durationHistogram.pct.reduce((a, c) => a + c, 0);
    assert(Math.abs(soma - 100) < 0.5, 'histograma soma ' + soma.toFixed(1) + '%');
    assert(b.probability >= 0 && b.probability <= 1, 'probabilidade fora de [0,1]');
    return `${b.n} bursts, mediana ${b.medianDurationMs.toFixed(0)} ms`;
  });
  t('remoção de artefato cardíaco', () => {
    const e = C.ecgTemplateSubtract(td.data, td.fs);
    if (!e.applied) return 'sem QRS detectável (aceitável)';
    assert(e.bpm > 25 && e.bpm < 200, 'bpm implausível: ' + e.bpm);
    return `${e.nBeats} batimentos, ${e.bpm.toFixed(0)} bpm`;
  });
}

/* -------------------------------------------------------- 3. estatística -- */
sec('estatística');
const comTrend = parsed.find(p => Object.keys(p.trend).length);
if (!comTrend) { pulados += 6; console.log('  \u25cb sem Timeline nesta pasta'); }
else {
  const hemi = Object.keys(comTrend.trend)[0];
  const off = comTrend.meta.utcOffsetMin ?? -180;
  const limpo = C.removeOutliersMAD(comTrend.trend[hemi], 'lfp', 4);
  t('remoção robusta de outliers', () => {
    assert(limpo.kept.length > 0, 'removeu tudo');
    assert(limpo.removed / comTrend.trend[hemi].length < 0.2, 'removeu demais');
    return `${limpo.removed} de ${comTrend.trend[hemi].length} pontos`;
  });
  const hrs = limpo.kept.map(r => C.localHour(r.t, off));
  const y = limpo.kept.map(r => r.lfp);
  const cos = C.cosinor(hrs, y, [24, 12]);
  t('cosinor', () => {
    assert(cos, 'ajuste nulo');
    const a = ((cos.components[0].acrophaseHours % 24) + 24) % 24;
    assert(a >= 0 && a < 24, 'acrofase fora de [0,24): ' + a);
    assert(cos.p >= 0 && cos.p <= 1, 'p fora de [0,1]');
    assert(cos.r2 >= 0 && cos.r2 <= 1, 'R\u00b2 fora de [0,1]');
    return `MESOR=${cos.mesor.toFixed(1)} amp=${cos.components[0].amplitude.toFixed(2)} acro=${a.toFixed(2)}h R\u00b2=${cos.r2.toFixed(3)}`;
  });
  t('correção por autocorrelação AR(1)', () => {
    assert(cos.rhoAR1 > -1 && cos.rhoAR1 < 1, 'rho fora de (-1,1)');
    assert(cos.pAdjustedAR1 >= cos.p - 1e-12, 'p corrigido não é mais conservador');
    return `\u03c1=${cos.rhoAR1.toFixed(3)}, n efetivo=${cos.nEffective.toFixed(0)}, p ajustado=${cos.pAdjustedAR1.toExponential(1)}`;
  });
  t('perfil diurno com detrending', () => {
    const dp = C.diurnalProfile(limpo.kept, off, 30, true);
    assert(dp.nBins === 48, 'bins: ' + dp.nBins);
    assert(dp.profile.filter(Number.isFinite).length >= 40, 'perfil com muitos vazios');
    return `${dp.days.length} dias \u00d7 ${dp.nBins} bins`;
  });
  t('bootstrap de blocos por dia', () => {
    const b = C.cosinorBootstrap(limpo.kept, [24], 120, off);
    assert(b, 'bootstrap nulo');
    assert(b.amplitudeCI[0] <= b.amplitudeCI[1], 'IC invertido');
    return `IC95% amplitude [${b.amplitudeCI.map(x => x.toFixed(2)).join('; ')}]`;
  });
  t('Rayleigh das acrofases diárias', () => {
    const dp = C.diurnalProfile(limpo.kept, off, 30, true);
    const picos = dp.matrix.map(m => {
      let bi = -1, bv = -Infinity;
      m.values.forEach((v, i) => { if (Number.isFinite(v) && v > bv) { bv = v; bi = i; } });
      return bi >= 0 ? dp.hours[bi] : NaN;
    }).filter(Number.isFinite);
    const r = C.rayleigh(picos);
    assert(r.R >= 0 && r.R <= 1, 'R fora de [0,1]');
    assert(r.p >= 0 && r.p <= 1, 'p fora de [0,1]');
    return `R=${r.R.toFixed(3)}, p=${r.p.toExponential(1)}, hora média ${r.meanHour.toFixed(1)}h`;
  });
  t('proporções de limiar somam 100%', () => {
    const s = C.thresholdSummary(y, C.quantile(y, .25), C.quantile(y, .75));
    const tot = s.belowPct + s.betweenPct + s.abovePct;
    assert(Math.abs(tot - 100) < 1e-9, 'soma ' + tot);
    return `${s.belowPct.toFixed(0)}/${s.betweenPct.toFixed(0)}/${s.abovePct.toFixed(0)} %`;
  });
}

/* ------------------------------------------------------ 4. camada gráfica -- */
sec('camada gráfica');
const mk = o => new P.Chart(document.createElement('canvas'), Object.assign({ width: 600, height: 300 }, o));
t('eixos, linha e legenda', () => { const c = mk({ xlim: [0, 60], ylim: [0, 5] }); c.axes(); c.line([0, 1, 2], [1, 2, 3], { color: '#000', label: 'x' }); c.legend(); });
t('escala log-log', () => { const c = mk({ xlog: true, ylog: true, xlim: [1, 100], ylim: [.01, 10] }); c.axes(); c.line([1, 10, 100], [1, .1, .01], { color: '#000' }); });
t('área, faixa, linhas de referência', () => { const c = mk({ xlim: [0, 10], ylim: [0, 10] }); c.axes(); c.area([0, 5, 10], [1, 1, 1], [5, 6, 7], { color: '#0a0' }); c.span(2, 4, { color: '#00a', label: '\u03b2' }); c.hline(5, { label: 'thr' }); c.vline(3, { label: 'ev' }); });
t('barras, dispersão e marcadores', () => { const c = mk({ xlim: [-1, 5], ylim: [0, 10] }); c.axes(); c.bars([0, 1, 2, 3], [1, 5, 3, 7], { color: v => v > 4 ? '#a00' : '#00a' }); c.scatter([0, 1], [2, 3], { color: '#000' }); c.marker(1, 5, { label: 'pico', shape: 'tri' }); });
t('mapa de calor com NaN e barra de cores', () => { const c = mk({ xlim: [0, 10], ylim: [0, 4] }); c.heat([[1, 2, 3], [4, 5, 6], [7, 8, 9], [1, NaN, 3]], { cmap: 'viridis' }); c.axes({ grid: false }); c.colorbar({ label: 'dB' }); });
t('gráfico polar', () => { P.polarBars(document.createElement('canvas'), Array.from({ length: 48 }, (_, i) => 50 + 10 * Math.sin(i / 48 * 6.28)), { width: 300, height: 300, acrophaseHours: 9.2 }); });
t('exportação CSV escapa separadores', () => {
  const s = P.toCSV([{ a: 1, b: 'x,y' }, { a: NaN, b: null }]);
  assert(s.includes('"x,y"'), 'escape falhou');
  assert(s.split('\n').length === 3, 'linhas: ' + s.split('\n').length);
});

/* --------------------------------------------- 5. renderizadores (F1–F12) -- */
sec('renderizadores de figura');
parsed.forEach(p => H.S.files.push({ name: p.fileName, parsed: p }));
const chaves = [...new Set(parsed.map(p => p.patient.idHash + '|' + p.device.snHash))];
if (chaves.length > 1) console.log(`  \u2139 ${chaves.length} registros distintos \u2014 testados separadamente`);
for (const k of chaves) {
  H.S.subject = k; H.S.opts = {};
  const d = H.ds();
  const rotulo = k.split('|')[0];
  for (const fig of H.FIGURES) {
    if (!fig.has(d)) { pulados++; console.log(`  \u25cb ${fig.id} (${rotulo}) \u2014 sem dados`); continue; }
    t(`${fig.id} (${rotulo})`, () => {
      const node = document.createElement('div');
      const t0 = Date.now();
      fig.render(node, d);
      assert(node.children.length > 0, 'não produziu elementos');
      return `${node.children.length} blocos, ${Date.now() - t0} ms`;
    });
  }
}

/* variações de opções, para cobrir ramos alternativos */
sec('variações de parâmetros');
H.S.subject = chaves[0]; H.S.opts = {};
const dsel = H.ds();
[['F1', { bands: false }], ['F2', { fmin: 5, fmax: 60 }], ['F3', { hemi: 'Right' }],
 ['F5', { norm: true }], ['F6', { ecg: true, pct: 85, blo: 20, bhi: 35, win: 6 }],
 ['F8', { smooth: 1, ma: false, mad: 2.5 }], ['F9', { detrend: false, bin: 60, harm: '24', boot: 60 }],
 ['F9', { detrend: true, bin: 15 }], ['F10', { norm: false, pre: 30, post: 120 }],
 ['F11', { lo: 35, hi: 48 }], ['F12', { all: true }]
].forEach(([id, o]) => {
  const fig = H.FIGURES.find(f => f.id === id);
  if (!fig.has(dsel)) { pulados++; console.log(`  \u25cb ${id} ${JSON.stringify(o)}`); return; }
  H.S.opts[id] = Object.assign(H.S.opts[id] || {}, o);
  t(`${id} ${JSON.stringify(o)}`, () => { const n = document.createElement('div'); fig.render(n, dsel); assert(n.children.length, 'vazio'); });
});

/* ------------------------------------------ 6. extração de métricas-chave -- */
sec('extração de métricas (relatório · CSV · JSON)');
{
  const b = C.extractMetrics(parsed, null);
  t('pacote com sujeito, sessões, agudas e crônicas', () => {
    assert(b && b.subject && b.subject.id, 'sem sujeito');
    assert(Array.isArray(b.acute) && Array.isArray(b.chronic) && Array.isArray(b.sessions), 'estrutura inválida');
    return `${b.sessions.length} sessão(ões), ${b.acute.length} agudas, ${b.chronic.length} crônicas`;
  });
  t('linhas nomeadas por paciente, sessão e implante', () => {
    const all = b.acute.concat(b.chronic);
    assert(all.length, 'nenhuma linha de métrica');
    all.forEach(r => {
      assert(r.subject_id === b.subject.id, 'subject_id ausente/divergente');
      assert('implant_date' in r, 'implant_date ausente');
      assert(r.hemisphere === 'Left' || r.hemisphere === 'Right', 'hemisfério inválido');
    });
    return `implante ${b.subject.implant_date || '—'}`;
  });
  if (b.acute.length) t('métricas agudas: pico beta e flag têm valores válidos', () => {
    b.acute.forEach(r => {
      assert(r.has_beta_peak === 0 || r.has_beta_peak === 1, 'has_beta_peak não é 0/1');
      if (Number.isFinite(r.beta_peak_hz)) assert(r.beta_peak_hz >= 13 && r.beta_peak_hz <= 35, 'pico beta fora de 13–35 Hz: ' + r.beta_peak_hz);
      assert('days_since_implant' in r, 'days_since_implant ausente');
    });
    const withPk = b.acute.filter(r => r.has_beta_peak);
    return `${withPk.length}/${b.acute.length} hemisférios com pico beta`;
  });
  if (b.chronic.length) t('métricas crônicas: cosinor e Rayleigh coerentes', () => {
    b.chronic.forEach(r => {
      assert(r.n_points > 0, 'sem pontos de Timeline');
      if (Number.isFinite(r.acrophase_24h)) assert(r.acrophase_24h >= 0 && r.acrophase_24h < 24, 'acrofase fora de 0–24 h');
      if (Number.isFinite(r.rayleigh_p)) assert(r.rayleigh_p >= 0 && r.rayleigh_p <= 1, 'p de Rayleigh fora de [0,1]');
      const soma = (r.pct_below || 0) + (r.pct_between || 0) + (r.pct_above || 0);
      if (Number.isFinite(soma) && soma > 0) assert(Math.abs(soma - 100) < 1.5, 'faixas de limiar não somam 100%: ' + soma);
    });
    const c0 = b.chronic[0];
    return `${c0.n_days} dias · MESOR ${c0.mesor} · acrofase ${c0.acrophase_24h}h`;
  });
  t('CSV tidy usa a união das colunas de todas as linhas', () => {
    const rows = b.acute.length ? b.acute : b.chronic;
    const keys = []; const seen = new Set();
    rows.forEach(r => Object.keys(r).forEach(k => { if (!seen.has(k)) { seen.add(k); keys.push(k); } }));
    const csv = P.toCSV(rows, keys);
    const header = csv.split('\n')[0].split(',');
    assert(header.length === keys.length, 'cabeçalho incompleto');
    assert(csv.split('\n').length === rows.length + 1, 'linhas do CSV divergem');
    return `${keys.length} colunas × ${rows.length} linhas`;
  });
}

/* --------------------------------------------------- 7. estados ON/OFF (β) -- */
sec('detecção automática de estados ON/OFF pela amplitude do beta');
t('série bimodal separa em dois estados (baixo=ON, alto=OFF)', () => {
  const ser = [];
  for (let i = 0; i < 200; i++) ser.push({ t: i, v: (i % 40 < 20) ? 1 + (i % 7) * 0.01 : 6 + (i % 7) * 0.01 });
  const st = C.detectStates(ser, { minDur: 0 });
  assert(st, 'sem resultado');
  assert(st.labels.length === ser.length, 'labels != pontos');
  assert(st.betaHigh > st.betaLow, 'clusters invertidos');
  assert(st.bimodality > 0.555, 'bimodalidade baixa em série claramente bimodal: ' + st.bimodality);
  assert(st.nOff > 0 && st.nOn > 0, 'não encontrou ambos os estados');
  const off = st.labels.reduce((a, x) => a + x, 0) / st.labels.length;
  assert(Math.abs(off - 0.5) < 0.15, 'fração OFF inesperada: ' + off);
  return `OFF% ${(100 * st.offFraction).toFixed(0)}, sep ${st.separation.toFixed(1)}, BC ${st.bimodality.toFixed(2)}`;
});
t('duração mínima funde episódios curtos', () => {
  const ser = [];                                   // ON longo · OFF curto espúrio (3) · ON · OFF longo (30)
  for (let i = 0; i < 100; i++) { let v = 1; if (i >= 40 && i <= 42) v = 10; if (i >= 70) v = 10; ser.push({ t: i, v }); }
  const noMin = C.detectStates(ser, { minDur: 0 });
  const withMin = C.detectStates(ser, { minDur: 5 });
  assert(noMin && withMin, 'sem resultado');
  assert(noMin.nOff === 2, 'esperava 2 episódios OFF sem minDur, veio ' + noMin.nOff);
  assert(withMin.nOff === 1, 'minDur deveria fundir o OFF curto, veio ' + withMin.nOff);
  return `episódios OFF: ${noMin.nOff} → ${withMin.nOff} com minDur`;
});
t('coeficiente de bimodalidade: bimodal > gaussiano', () => {
  const bim = [], gau = [];
  for (let i = 0; i < 400; i++) { bim.push(i < 200 ? 0 : 10); let s = 0; for (let k = 0; k < 12; k++) s += ((i * 97 + k * 57) % 1000) / 1000; gau.push(s - 6); }
  const bcB = C.bimodalityCoefficient(bim), bcG = C.bimodalityCoefficient(gau);
  assert(bcB > 0.555, 'bimodal não detectado: ' + bcB);
  assert(bcG < bcB, 'gaussiano não é menor que bimodal');
  return `BC bimodal ${bcB.toFixed(2)} > gauss ${bcG.toFixed(2)}`;
});
t('envelope de beta a partir do sinal bruto', () => {
  const td = parsed.flatMap(p => (p.bsTimeDomain || []).concat(p.montageTD || []))[0];
  if (!td) return 'sem sinal bruto no exemplo';
  const ser = C.betaEnvelopeSeries(td, { lo: 13, hi: 30, winS: 1 });
  assert(ser.length > 2, 'série curta');
  assert(ser.every(s => isFinite(s.v) && isFinite(s.t)), 'valores não finitos');
  for (let i = 1; i < ser.length; i++) assert(ser[i].t > ser[i - 1].t, 't não crescente');
  return `${ser.length} pontos de envelope`;
});

/* ------------------------------------ 8. integridade do sinal bruto (Onda 1) -- */
sec('perda de pacotes, fs efetiva e NaN');
{
  /* série sintética: 20 pacotes de 63 amostras a 250 Hz, com os pacotes 5, 12 e 13 perdidos */
  const NPK = 20, SZ = 63, FS = 250, MS = SZ / FS * 1000;   // 252 ms por pacote
  const perdidos = new Set([5, 12, 13]);
  const seqs = [], ticks = [], sizes = [];
  for (let i = 0; i < NPK; i++) {
    if (perdidos.has(i)) continue;
    seqs.push(i % 256); ticks.push(Math.round(i * MS)); sizes.push(SZ);
  }
  const recebidas = new Float64Array((NPK - perdidos.size) * SZ).fill(1);

  t('GlobalSequences detecta exatamente os pacotes perdidos', () => {
    const r = C.analyzePackets({ data: recebidas, fs: FS, packetSizes: sizes, ticksMs: ticks, sequences: seqs });
    assert(r.method === 'sequences', 'método: ' + r.method);
    assert(r.reliable, 'deveria ser verificável');
    const nPk = r.gaps.reduce((a, g) => a + g.nPackets, 0);
    assert(nPk === perdidos.size, `pacotes perdidos: ${nPk} ≠ ${perdidos.size}`);
    assert(r.gaps.length === 2, 'esperava 2 lacunas (5 isolado; 12–13 contíguos), veio ' + r.gaps.length);
    assert(r.nMissing === perdidos.size * SZ, 'amostras perdidas: ' + r.nMissing);
    assert(r.nExpected === NPK * SZ, 'nExpected: ' + r.nExpected);
    return `${r.gaps.length} lacunas, ${r.nMissing} amostras (${r.pctMissing.toFixed(1)}%)`;
  });
  t('TicksInMses detecta a mesma perda sem GlobalSequences', () => {
    const r = C.analyzePackets({ data: recebidas, fs: FS, packetSizes: sizes, ticksMs: ticks });
    assert(r.method === 'ticks', 'método: ' + r.method);
    const nPk = r.gaps.reduce((a, g) => a + g.nPackets, 0);
    assert(nPk === perdidos.size, `pacotes: ${nPk} ≠ ${perdidos.size}`);
    return `${nPk} pacotes por ticks (nominal ${r.nominalPacketMs} ms)`;
  });
  t('sem sequências nem ticks a série é marcada como não verificável', () => {
    const r = C.analyzePackets({ data: recebidas, fs: FS });
    assert(r.method === 'none' && !r.reliable, 'deveria ser não verificável');
    assert(r.nMissing === 0, 'não pode inventar perda');
    assert(typeof r.reason === 'string' && r.reason.length, 'sem motivo legível');
    return r.reason.slice(0, 46) + '…';
  });
  t('ticks com rollover em 2^16 não geram falso positivo', () => {
    const base = [];
    for (let i = 0; i < 40; i++) base.push(Math.round(i * MS));
    const CAP = 65536;
    const comVolta = base.map(v => (v + CAP - 3000) % CAP);      // força uma volta no meio
    assert(comVolta.some((v, i) => i > 0 && v < comVolta[i - 1]), 'o teste precisa conter uma volta');
    const u = C.unwrapTicks(comVolta);
    for (let i = 1; i < u.length; i++) assert(u[i] > u[i - 1], 'desenrolar falhou em ' + i);
    const r = C.analyzePackets({ data: new Float64Array(40 * SZ), fs: FS, packetSizes: base.map(() => SZ), ticksMs: comVolta });
    assert(r.gaps.length === 0, 'falso positivo: ' + r.gaps.length + ' lacunas');
    return 'volta desenrolada, 0 lacunas espúrias';
  });
  t('unwrapCounter trata perda que ultrapassa a volta (250 → 4)', () => {
    const u = C.unwrapCounter([248, 249, 250, 4, 5], 256);
    assert(u[3] === 260, 'esperava 260, veio ' + u[3]);
    return '250 → 4 vira salto de 10 (9 pacotes perdidos)';
  });
  t('insertNaNGaps preserva o número total de amostras esperadas', () => {
    const r = C.analyzePackets({ data: recebidas, fs: FS, packetSizes: sizes, ticksMs: ticks, sequences: seqs });
    const out = C.insertNaNGaps(recebidas, r.gaps);
    assert(out.data.length === r.nExpected, `${out.data.length} ≠ ${r.nExpected}`);
    assert(out.missingMask.length === r.nExpected, 'máscara com comprimento divergente');
    const nNaN = Array.from(out.data).filter(Number.isNaN).length;
    assert(nNaN === r.nMissing, `NaN: ${nNaN} ≠ ${r.nMissing}`);
    const nMask = Array.from(out.missingMask).reduce((a, b) => a + b, 0);
    assert(nMask === r.nMissing, 'máscara não bate com os NaN');
    /* nenhuma amostra válida pode ter sido perdida ou interpolada */
    assert(Array.from(out.data).filter(v => v === 1).length === recebidas.length, 'amostras válidas alteradas');
    return `${out.data.length} amostras, ${nNaN} NaN, nada interpolado`;
  });
  t('fs efetiva de série a 249,99 Hz é recuperada com erro < 0,001 Hz', () => {
    const FS_REAL = 249.99, N = 60;
    const tk = [], sz = [];
    for (let i = 0; i < N; i++) { tk.push(i * SZ / FS_REAL * 1000); sz.push(SZ); }
    const r = C.effectiveFs({ ticksMs: tk, nSamples: N * SZ, nominalFs: 250, packetSizes: sz });
    assert(r.reliable, 'deveria ser verificável');
    const erro = Math.abs(r.fsEff - FS_REAL);
    assert(erro < 0.001, `erro ${erro.toExponential(2)} Hz`);
    assert(isFinite(r.ppmDeviation) && isFinite(r.driftMsTotal), 'deriva não calculada');
    return `fsEff ${r.fsEff.toFixed(4)} Hz (${r.ppmDeviation.toFixed(0)} ppm, deriva ${r.driftMsTotal.toFixed(1)} ms)`;
  });
  t('deriva acima de 20 ms levanta aviso de qualidade', () => {
    const FS_REAL = 249.9, N = 600;
    const tk = [], sz = [];
    for (let i = 0; i < N; i++) { tk.push(i * SZ / FS_REAL * 1000); sz.push(SZ); }
    const r = C.effectiveFs({ ticksMs: tk, nSamples: N * SZ, nominalFs: 250, packetSizes: sz });
    assert(r.warnDrift, 'deveria avisar: deriva ' + r.driftMsTotal);
    return `deriva ${r.driftMsTotal.toFixed(0)} ms em ${(r.durationS / 60).toFixed(1)} min`;
  });
  t('costura de streams insere NaN e nunca se declara confiável', () => {
    const a = { data: Float64Array.from({ length: 250 }, () => 1), fs: 250, t0Ms: 0, missingMask: new Uint8Array(250) };
    const b = { data: Float64Array.from({ length: 250 }, () => 2), fs: 250, t0Ms: 3000, missingMask: new Uint8Array(250) };
    const s = C.stitchStreams([a, b], { maxGapS: 60 });
    assert(s.stitchReliable === false, 'jamais pode se declarar confiável');
    assert(s.nGapSamples === 500, 'lacuna esperada de 2 s = 500 amostras, veio ' + s.nGapSamples);
    assert(s.data.length === 1000, 'comprimento: ' + s.data.length);
    assert(Array.from(s.data).filter(Number.isNaN).length === 500, 'NaN não inseridos');
    return `${s.nSegments} segmentos, ${s.nGapSamples} amostras de lacuna, reliable=false`;
  });
  t('parser expõe integridade e fs efetiva em cada série bruta', () => {
    const td = parsed.flatMap(p => (p.bsTimeDomain || []).concat(p.montageTD || []));
    assert(td.length, 'sem séries brutas no exemplo');
    td.forEach(x => {
      assert(x.packets && typeof x.packets.pctMissing === 'number', 'sem contabilidade de pacotes');
      assert(x.missingMask && x.missingMask.length === x.data.length, 'máscara ausente ou desalinhada');
      assert(isFinite(x.fsEff) && x.fsEff > 0, 'fsEff inválida');
    });
    const semMeta = td.filter(x => !x.packets.reliable).length;
    return `${td.length} séries; ${semMeta} sem metadados de sequência (não verificáveis)`;
  });
}

/* --------------------------------------------- 9. DSP tolerante a NaN (Onda 1) -- */
sec('DSP tolerante a lacunas');
{
  const FS = 250, N = 250 * 20;                       // 20 s a 250 Hz
  const senoide = (nan) => {
    const x = new Float64Array(N);
    for (let i = 0; i < N; i++) x[i] = Math.sin(2 * Math.PI * 20 * i / FS);
    if (nan) for (const i of nan) x[i] = NaN;
    return x;
  };
  const picoDe = w => {
    let bi = 0;
    for (let i = 0; i < w.f.length; i++) if (w.f[i] >= 5 && w.f[i] <= 45 && w.p[i] > w.p[bi]) bi = i;
    return w.f[bi];
  };

  t('nanStats conta lacunas e a maior sequência contígua', () => {
    const x = senoide([10, 11, 12, 500]);
    const s = C.nanStats(x);
    assert(s.nNan === 4, 'nNan: ' + s.nNan);
    assert(s.nValid === N - 4, 'nValid: ' + s.nValid);
    assert(s.longestGapSamples === 3, 'maior lacuna: ' + s.longestGapSamples);
    return `${s.nNan} NaN (${s.pctNan.toFixed(2)}%), maior lacuna ${s.longestGapSamples}`;
  });
  t('PSD com 5% de perda de pacotes (lacunas contíguas) recupera o pico', () => {
    /* perda real é de PACOTES INTEIROS (63 amostras), não de amostras avulsas */
    const idx = [];
    for (const p of [8, 30, 52, 74]) for (let k = 0; k < 63; k++) idx.push(p * 63 + k);
    const w = C.welchPSD(senoide(idx), FS, { nperseg: 512, overlap: .5 });
    assert(w.p, 'espectro não deveria ser nulo: ' + w.reason);
    const erro = Math.abs(picoDe(w) - 20);
    assert(erro < 0.5, 'erro de ' + erro.toFixed(2) + ' Hz');
    assert(w.nSegmentsDropped > 0, 'deveria ter descartado os segmentos com lacuna');
    assert(w.pctDataUsed > 0 && w.pctDataUsed < 100, 'pctDataUsed: ' + w.pctDataUsed);
    return `pico ${picoDe(w).toFixed(2)} Hz, ${w.nSegments} segs usados, ${w.nSegmentsDropped} descartados (${w.pctDataUsed.toFixed(0)}%)`;
  });
  t('NaN espalhado: recusa honesta com maxNanPct=0, estima com tolerância explícita', () => {
    const idx = []; for (let i = 0; i < N * 0.05; i++) idx.push((i * 37) % N);
    const x = senoide(idx);
    /* com o default (qualquer NaN descarta), nenhum segmento sobra — e a
       resposta correta é dizer isso, não fabricar um espectro */
    const estrito = C.welchPSD(x, FS, { nperseg: 512, overlap: .5 });
    assert(estrito.p === null, 'deveria recusar com maxNanPct=0');
    /* com tolerância declarada pelo usuário, estima e reporta quanto faltava */
    const tolerante = C.welchPSD(x, FS, { nperseg: 512, overlap: .5, maxNanPct: 10 });
    assert(tolerante.p, 'deveria estimar com maxNanPct=10: ' + tolerante.reason);
    const erro = Math.abs(picoDe(tolerante) - 20);
    assert(erro < 0.5, 'erro de ' + erro.toFixed(2) + ' Hz');
    assert(tolerante.pctNan > 4 && tolerante.pctNan < 6, 'pctNan não reportado');
    return `estrito → null; tolerante → pico ${picoDe(tolerante).toFixed(2)} Hz (${tolerante.pctNan.toFixed(1)}% faltante)`;
  });
  t('PSD com 90% de NaN retorna null com motivo legível', () => {
    const idx = []; for (let i = 0; i < N * 0.9; i++) idx.push(i);
    const w = C.welchPSD(senoide(idx), FS, { nperseg: 512, overlap: .5 });
    assert(w.p === null, 'deveria recusar-se a estimar');
    assert(typeof w.reason === 'string' && w.reason.length > 10, 'sem motivo legível');
    return w.reason.slice(0, 54) + '…';
  });
  t('espectrograma produz coluna NaN visível na lacuna (não zero)', () => {
    const x = senoide([]);
    for (let i = 1000; i < 1400; i++) x[i] = NaN;
    const sg = C.spectrogram(x, FS, { window: 256, hop: 64, fmax: 60 });
    assert(sg.nColumnsNaN > 0, 'nenhuma coluna marcada como lacuna');
    const temNaN = sg.S.some(c => Array.from(c).every(Number.isNaN));
    assert(temNaN, 'coluna de lacuna deveria ser NaN, não zero');
    const temZero = sg.S.some(c => Array.from(c).every(v => v === 0));
    assert(!temZero, 'lacuna virou silêncio espectral (zero) — errado');
    return `${sg.nColumnsNaN}/${sg.nColumns} colunas em lacuna`;
  });
  t('filtro e envelope imputam só para filtrar e repõem NaN, declarando pctImputed', () => {
    const x = senoide([]); for (let i = 500; i < 560; i++) x[i] = NaN;
    const bp = C.bandpassFFT(x, FS, 13, 30);
    const env = C.hilbertEnvelope(bp);
    assert(bp.pctImputed > 0, 'pctImputed não declarado no filtro');
    assert(Number.isNaN(bp[520]), 'NaN não reposto no filtro');
    assert(Number.isNaN(env[520]), 'NaN não reposto no envelope');
    assert(isFinite(bp[100]) && isFinite(env[100]), 'amostras válidas viraram NaN');
    return `pctImputed ${bp.pctImputed.toFixed(2)}%, NaN reposto`;
  });
  t('bursts não atravessam lacunas e os truncados saem das estatísticas', () => {
    const env = new Float64Array(1000).fill(0.1);
    for (let i = 100; i < 200; i++) env[i] = 5;          // burst inteiro, 400 ms
    for (let i = 400; i < 500; i++) env[i] = 5;          // burst que encosta na lacuna
    for (let i = 500; i < 520; i++) env[i] = NaN;        // lacuna
    const r = C.detectBursts(env, 250, { threshold: 1, minDurationMs: 100 });
    assert(r.n === 2, 'esperava 2 bursts, veio ' + r.n);
    assert(r.nTruncatedByGap === 1, 'esperava 1 truncado, veio ' + r.nTruncatedByGap);
    r.bursts.forEach(b => {
      for (let k = Math.round(b.start * 250); k < Math.round(b.end * 250); k++)
        assert(isFinite(env[k]), 'burst atravessou lacuna em ' + k);
    });
    /* o truncado não pode contaminar a duração média */
    assert(Math.abs(r.meanDurationMs - 400) < 1e-6, 'duração média contaminada: ' + r.meanDurationMs);
    return `${r.n} bursts, ${r.nTruncatedByGap} truncado fora das estatísticas`;
  });
  t('média e variância ignoram NaN em vez de propagá-lo', () => {
    assert(C.mean([1, 2, NaN, 3]) === 2, 'mean: ' + C.mean([1, 2, NaN, 3]));
    assert(isFinite(C.variance([1, 2, NaN, 3])), 'variance virou NaN');
    assert(isFinite(C.sd([1, 2, NaN, 3])), 'sd virou NaN');
    return 'na.rm com n reportado por nanStats';
  });
  t('espectro sem lacuna é idêntico ao de antes (sem regressão)', () => {
    const w = C.welchPSD(senoide([]), FS, { nperseg: 512, overlap: .5 });
    const erro = Math.abs(picoDe(w) - 20);
    assert(erro < 0.5, 'erro ' + erro);
    assert(w.nSegmentsDropped === 0, 'descartou segmento sem motivo');
    assert(w.pctDataUsed === 100, 'pctDataUsed: ' + w.pctDataUsed);
    return `pico ${picoDe(w).toFixed(2)} Hz, 100% dos segmentos usados`;
  });
}

/* ------------------------------------------------------------- resultado -- */
console.log(`\n${'='.repeat(58)}`);
console.log(`  ${ok} passaram   ${falhas} falharam   ${pulados} sem dados`);
console.log('='.repeat(58));
process.exit(falhas ? 1 : 0);
