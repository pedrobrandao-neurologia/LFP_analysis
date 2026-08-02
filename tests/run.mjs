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
const ta = async (nome, fn) => {
  try { const r = await fn(); ok++; console.log('  \u2713 ' + nome + (r ? '  \u2014 ' + r : '')); }
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

/* ------------------------- 10. artefato cardíaco: 3 métodos + validação (Onda 2) -- */
sec('remoção de ECG — detecção em duas passagens, três métodos e validação');
{
  const FS = 250, DUR = 60, N = FS * DUR, BPM = 60, RR = Math.round(FS * 60 / BPM);

  /* QRS sintético paramétrico: onda bifásica estreita (~100 ms) */
  const qrs = (() => {
    const L = Math.round(0.1 * FS), t = [];
    for (let i = 0; i < L; i++) {
      const u = (i / L - 0.5) * 8;
      t.push(Math.exp(-u * u / 2) * (1 - 0.55 * u * u));
    }
    return t;
  })();

  /* sinal = senoide beta 20 Hz + ruído 1/f (determinístico) + QRS em SNR dado */
  function gerar(snrDb) {
    const limpo = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      let rosa = 0;
      for (let k = 1; k <= 8; k++) rosa += Math.sin(2 * Math.PI * (k * 0.7) * i / FS + k * 1.7) / k;
      limpo[i] = 2 * Math.sin(2 * Math.PI * 20 * i / FS) + 0.6 * rosa
        + 1.2 * Math.sin(2 * Math.PI * 6 * i / FS + 0.4);
    }
    let pS = 0; for (let i = 0; i < N; i++) pS += limpo[i] * limpo[i];
    pS /= N;
    /* posição de referência = o MÁXIMO do QRS, que é o que um detector encontra.
       O RR leva variabilidade (HRV): sem ela o QRS fica travado em fase com o
       beta e o template médio passa a conter o próprio sinal cerebral — um
       artefato do sinal sintético, não do método. */
    let iMax = 0; qrs.forEach((v, i) => { if (v > qrs[iMax]) iMax = i; });
    const picos = [];
    let pos = RR;
    for (let b = 0; pos < N - RR; b++) {
      picos.push(pos + iMax);
      pos += Math.round(RR * (1 + 0.10 * Math.sin(b * 1.7) + 0.05 * Math.sin(b * 0.53)));
    }
    const artef = new Float64Array(N);
    picos.forEach(p => { for (let k = 0; k < qrs.length; k++) { const i = p - iMax + k; if (i < N) artef[i] += qrs[k]; } });
    let pA = 0; for (let i = 0; i < N; i++) pA += artef[i] * artef[i];
    pA /= N;
    /* escala o artefato para o SNR pedido: SNR = 10log10(pS/pA') */
    const alvo = pS / Math.pow(10, snrDb / 10);
    const g = pA > 0 ? Math.sqrt(alvo / pA) : 0;
    const sujo = new Float64Array(N);
    for (let i = 0; i < N; i++) sujo[i] = limpo[i] + g * artef[i];
    return { limpo, sujo, picos };
  }

  const medirDeteccao = (snr) => {
    const { sujo, picos } = gerar(snr);
    const det = C.detectRPeaks(sujo, FS, {});
    const tol = Math.round(0.05 * FS);
    let vp = 0; const usados = new Set();
    det.peaks.forEach(p => {
      const achou = picos.findIndex((v, i) => !usados.has(i) && Math.abs(v - p) <= tol);
      if (achou >= 0) { vp++; usados.add(achou); }
    });
    return {
      det, nTrue: picos.length,
      vp: 100 * vp / picos.length,
      fp: 100 * (det.peaks.length - vp) / Math.max(1, det.peaks.length)
    };
  };

  t('detecção de picos R: > 95% VP e < 1% FP com artefato detectável', () => {
    /* regime em que a remoção de ECG faz sentido: o artefato domina o registro */
    for (const snr of [-10, -5]) {
      const r = medirDeteccao(snr);
      assert(r.vp > 95, `SNR ${snr} dB: VP ${r.vp.toFixed(1)}%`);
      assert(r.fp < 1, `SNR ${snr} dB: FP ${r.fp.toFixed(1)}%`);
      assert(r.det.method === 'template-2-passagens', 'método: ' + r.det.method);
      assert(Math.abs(r.det.bpm - BPM) < 6, `SNR ${snr} dB: bpm ${r.det.bpm.toFixed(1)}`);
    }
    const a = medirDeteccao(-10), b = medirDeteccao(-5);
    return `−10 dB: VP ${a.vp.toFixed(0)}%/FP ${a.fp.toFixed(0)}% · −5 dB: VP ${b.vp.toFixed(0)}%/FP ${b.fp.toFixed(0)}%`;
  });

  t('com artefato desprezível, o detector não reivindica confiança alta', () => {
    /* SNR +10 dB: o QRS é 10× menor que o sinal cerebral. Nesse caso não há o
       que remover, e o comportamento correto é NÃO afirmar um resultado —
       Vivien et al. relatam 2 de 30 STN em que o pico R não era detectável sem
       ECG externo. O detector precisa sinalizar isso, não produzir número. */
    const r = medirDeteccao(10);
    assert(r.det.confidence !== 'alta',
      `confiança "${r.det.confidence}" com artefato desprezível (VP real ${r.vp.toFixed(0)}%)`);
    assert(typeof r.det.reason === 'string' && r.det.reason.length, 'sem motivo legível');
    return `confiança ${r.det.confidence} — ${r.det.reason.slice(0, 44)}…`;
  });

  t('SVD de Jacobi reconstrói matriz de posto 1 exatamente', () => {
    const u = [1, 2, 3, 4], v = [2, -1, 0.5];
    const A = u.map(a => v.map(b => a * b));
    const s = C.svdJacobi(A);
    assert(s.S[0] > 0 && s.S[1] < 1e-8, 'posto não é 1: ' + Array.from(s.S).join(','));
    const R = C.lowRankApprox(s, 1);
    let err = 0;
    for (let i = 0; i < A.length; i++) for (let j = 0; j < v.length; j++) err = Math.max(err, Math.abs(R[i][j] - A[i][j]));
    assert(err < 1e-8, 'erro de reconstrução ' + err);
    return `σ = [${Array.from(s.S).map(x => x.toFixed(3)).join(', ')}], erro ${err.toExponential(1)}`;
  });

  /* varredura de SNR com os três métodos — é a comparação que Stam et al. e
     Vivien et al. fizeram e que nenhuma ferramenta reporta para si mesma */
  const METODOS = ['interpolation', 'template', 'svd'];
  for (const snr of [-10, -5]) {
    t(`SNR ${snr} dB — os três métodos suprimem o ECG e preservam o pico beta`, () => {
      const { limpo, sujo } = gerar(snr);
      const det = C.detectRPeaks(sujo, FS, {});
      assert(det.peaks.length > 30, 'poucos picos detectados: ' + det.peaks.length);
      const linhas = METODOS.map(method => {
        const r = C.removeEcg(sujo, FS, det.peaks, { method });
        assert(r.applied, `${method} não aplicado: ${r.reason}`);
        const v = C.validateEcgRemoval(sujo, r.cleaned, FS, { peakHz: 20, reference: limpo });
        assert(v.suppressionRatioDb > 0, `${method}: supressão ${v.suppressionRatioDb.toFixed(2)} dB não é > 0`);
        /* faixa medida para os três métodos nos defaults; o SVD, recomendado na
           literatura, é verificado no critério estrito [0,8; 1,2] logo abaixo */
        assert(v.betaPeakRecovery >= 0.7 && v.betaPeakRecovery <= 1.3,
          `${method}: recuperação do pico beta ${v.betaPeakRecovery.toFixed(2)} fora de [0,7; 1,3]`);
        if (method === 'svd') {
          assert(v.betaPeakRecovery >= 0.8 && v.betaPeakRecovery <= 1.2,
            `svd: recuperação ${v.betaPeakRecovery.toFixed(2)} fora de [0,8; 1,2]`);
          assert(v.correlationWithReference > 0.90,
            `svd: correlação com o ground truth ${v.correlationWithReference.toFixed(3)} ≤ 0,90`);
        }
        return `${method.slice(0, 4)} ${v.suppressionRatioDb.toFixed(1)}dB/${v.betaPeakRecovery.toFixed(2)}`;
      });
      return linhas.join(' · ');
    });
  }

  t('SVD supera os demais na correlação com o ground truth (comparação direta)', () => {
    const { limpo, sujo } = gerar(-10);
    const det = C.detectRPeaks(sujo, FS, {});
    const corr = {};
    METODOS.forEach(m => {
      const r = C.removeEcg(sujo, FS, det.peaks, { method: m });
      corr[m] = C.validateEcgRemoval(sujo, r.cleaned, FS, { peakHz: 20, reference: limpo }).correlationWithReference;
    });
    assert(corr.svd >= corr.template && corr.svd >= corr.interpolation,
      `SVD não é o melhor: ${JSON.stringify(corr)}`);
    return METODOS.map(m => `${m.slice(0, 4)} ${corr[m].toFixed(3)}`).join(' · ');
  });

  t('validação reprova limpeza que destrói o pico beta', () => {
    const { sujo } = gerar(0);
    const zerado = new Float64Array(sujo.length);      // "limpeza" que apaga tudo
    const v = C.validateEcgRemoval(sujo, zerado, FS, { peakHz: 20 });
    assert(v.verdict !== 'supressão com preservação do pico', 'veredito complacente: ' + v.verdict);
    return v.verdict;
  });

  t('ecgTemplateSubtract mantém a forma de retorno e passa a usar a nova detecção', () => {
    const { sujo } = gerar(0);
    const r = C.ecgTemplateSubtract(sujo, FS);
    assert(r.applied && r.cleaned.length === sujo.length, 'forma de retorno alterada');
    assert(isFinite(r.bpm) && r.nBeats > 0, 'bpm/nBeats ausentes');
    assert(r.detection && r.detection.method, 'não expôs a detecção nova');
    return `${r.nBeats} batimentos, ${r.bpm.toFixed(0)} bpm, via ${r.detection.method}`;
  });
}

/* --------------------------------------- 11. perfis de doença (Onda 5) -- */
sec('perfis de doença');
{
  t('todos os perfis carregam com estrutura declarativa completa', () => {
    C.PROFILE_IDS.forEach(id => {
      const p = C.getProfile(id);
      assert(p.bands && p.bands.length, `${id}: sem bandas`);
      assert(p.primaryBand && isFinite(p.primaryBand.lo) && isFinite(p.primaryBand.hi), `${id}: sem banda primária`);
      assert(p.normalization, `${id}: sem normalização`);
      assert(p.glossary && p.glossary.intuicao, `${id}: sem glossário`);
      assert(Array.isArray(p.references), `${id}: sem referências`);
      p.bands.forEach(b => assert(b.hi > b.lo, `${id}/${b.key}: banda invertida`));
    });
    return C.PROFILE_IDS.join(', ');
  });
  t('trocar de perfil muda banda primária, normalização e glossário', () => {
    const pd = C.getProfile('pd'), dy = C.getProfile('dystonia'), et = C.getProfile('et');
    assert(pd.primaryBand.lo === 13 && pd.primaryBand.hi === 35, 'DP: banda primária errada');
    assert(dy.primaryBand.lo === 4 && dy.primaryBand.hi === 12, 'distonia: deveria ser teta-alfa 4–12');
    assert(dy.normalization === 'sd_6_96hz', 'distonia: normalização deveria ser sd_6_96hz');
    assert(et.primaryBand.lo === 2 && et.primaryBand.hi === 12, 'TE: deveria buscar a frequência do tremor');
    assert(pd.glossary.primario !== dy.glossary.primario, 'glossário não mudou entre perfis');
    assert(dy.chronicBandSelection === 'largest_peak' && pd.chronicBandSelection === 'a_priori', 'seleção de banda crônica não difere');
    return `DP β 13–35 · distonia θα 4–12 (${dy.normalization}) · TE f₀ 2–12`;
  });
  t('perfil é sugerido pelo Diagnosis e pelo alvo do eletrodo', () => {
    assert(C.suggestProfile(parsed[0]) === 'pd', 'exemplo (Parkinson/STN) deveria sugerir pd');
    const falso = { patient: { diagnosis: 'Dystonia' }, leads: [{ target: 'Gpi' }] };
    assert(C.suggestProfile(falso) === 'dystonia', 'Dystonia/GPi deveria sugerir dystonia');
    const soAlvo = { patient: { diagnosis: '' }, leads: [{ target: 'Vim' }] };
    assert(C.suggestProfile(soAlvo) === 'et', 'alvo Vim deveria sugerir tremor essencial');
    return 'Parkinson→pd · Dystonia/GPi→dystonia · Vim→et';
  });
  t('detectTremorFrequency recupera 4,5 Hz e o supraharmônico em 9 Hz', () => {
    const FS = 250, N = FS * 30;
    const x = new Float64Array(N);
    for (let i = 0; i < N; i++)
      x[i] = 2.0 * Math.sin(2 * Math.PI * 4.5 * i / FS) + 0.8 * Math.sin(2 * Math.PI * 9.0 * i / FS + 0.6)
        + 0.15 * Math.sin(2 * Math.PI * 23 * i / FS);
    const w = C.welchPSD(x, FS, { nperseg: 2048, overlap: .5 });
    const tr = C.detectTremorFrequency(Array.from(w.f), Array.from(w.p), { searchRange: [2, 12] });
    assert(tr, 'sem resultado');
    assert(Math.abs(tr.fundamentalHz - 4.5) < 0.3, 'fundamental: ' + tr.fundamentalHz);
    assert(Math.abs(tr.supraharmonicHz - 9.0) < 0.4, 'supraharmônico: ' + tr.supraharmonicHz);
    assert(tr.hasSupraharmonic, 'não identificou o supraharmônico');
    return `f₀ ${tr.fundamentalHz.toFixed(2)} Hz, 2f₀ ${tr.supraharmonicHz.toFixed(2)} Hz (razão ${tr.supraToFundamentalRatio.toFixed(2)})`;
  });
  t('bandas do perfil de TE são derivadas da frequência medida', () => {
    const fixas = C.bandsOf(C.getProfile('et'), {});
    const derivadas = C.bandsOf(C.getProfile('et'), { tremorHz: 4.5 });
    const f0 = derivadas.find(b => b.key === 'tremor'), s0 = derivadas.find(b => b.key === 'supra');
    assert(Math.abs(f0.lo - 3.5) < 1e-9 && Math.abs(f0.hi - 5.5) < 1e-9, 'fundamental não derivou: ' + JSON.stringify(f0));
    assert(Math.abs(s0.lo - 7.5) < 1e-9 && Math.abs(s0.hi - 10.5) < 1e-9, 'supraharmônico não derivou');
    assert(fixas.find(b => b.key === 'tremor').hi === 12, 'sem tremorHz deveria manter a faixa de busca');
    return `f₀ ${f0.lo}–${f0.hi} Hz · 2f₀ ${s0.lo}–${s0.hi} Hz`;
  });
  t('normalização sd_6_96hz da distonia difere da relativa', () => {
    const f = [], p = [];
    for (let i = 0; i < 200; i++) { f.push(i * 0.5); p.push(10 / (1 + i * 0.5) + (Math.abs(i * 0.5 - 5.7) < 1 ? 5 : 0)); }
    const rel = C.normalizeSpectrum(f, p, 'relative');
    const sd = C.normalizeSpectrum(f, p, 'sd_6_96hz');
    assert(rel.some((v, i) => Math.abs(v - sd[i]) > 1e-9), 'as duas normalizações deram o mesmo resultado');
    const somaRel = rel.reduce((a, b, i) => f[i] >= 1 && f[i] <= 100 ? a + b : a, 0);
    assert(Math.abs(somaRel - 100) < 1, 'normalização relativa não soma 100%: ' + somaRel);
    assert(sd.every(v => isFinite(v)), 'sd_6_96hz produziu valores não finitos');
    return `relativa soma ${somaRel.toFixed(1)}% · sd_6_96hz preserva a forma`;
  });
  t('métricas exportadas carregam o perfil e a banda primária', () => {
    const b = C.extractMetrics(parsed, null, { profileId: 'dystonia' });
    assert(b.subject.profile_id === 'dystonia', 'perfil não chegou ao sujeito');
    b.acute.forEach(r => {
      assert(r.profile_id === 'dystonia', 'linha aguda sem profile_id');
      assert(r.primary_band === '4-12', 'banda primária errada: ' + r.primary_band);
      assert('primary_peak_hz' in r, 'sem primary_peak_hz');
      if (isFinite(r.primary_peak_hz)) assert(r.primary_peak_hz >= 4 && r.primary_peak_hz <= 12, 'pico primário fora da banda');
    });
    b.chronic.forEach(r => assert(r.profile_id === 'dystonia', 'linha crônica sem profile_id'));
    return `${b.acute.length} linhas agudas com banda primária ${b.acute[0].primary_band} Hz`;
  });
  t('perfil de TE exporta métricas de tremor que os outros não exportam', () => {
    const et = C.extractMetrics(parsed, null, { profileId: 'et' });
    const pd = C.extractMetrics(parsed, null, { profileId: 'pd' });
    assert('tremor_fundamental_hz' in et.acute[0], 'TE não exportou métrica de tremor');
    assert(!('tremor_fundamental_hz' in pd.acute[0]), 'DP exportou métrica de tremor indevidamente');
    return `TE: f₀ ${et.acute[0].tremor_fundamental_hz} Hz, supraharmônico ${et.acute[0].tremor_has_supraharmonic ? 'sim' : 'não'}`;
  });
  t('Spearman e média móvel para correlação sintoma-LFP (distonia)', () => {
    /* relação monotônica negativa, como em Hubers et al. (ρ = −0,69) */
    const x = [], y = [];
    for (let i = 0; i < 40; i++) { x.push(i); y.push(100 - 2 * i + 6 * Math.sin(i * 1.3)); }
    const s = C.spearman(x, y, { nBoot: 200 });
    assert(s, 'sem resultado');
    assert(s.rho < -0.8, 'ρ deveria ser fortemente negativo: ' + s.rho);
    assert(s.ci95[0] <= s.rho && s.rho <= s.ci95[1], 'ρ fora do próprio IC');
    const serie = x.map(i => ({ t: Date.UTC(2025, 0, 1) + i * 864e5, v: y[i] }));
    const mm = C.movingAverageDays(serie, 5);
    assert(mm.length === serie.length, 'média móvel mudou o comprimento');
    assert(mm.every(p => isFinite(p.v)), 'média móvel com NaN');
    return `ρ = ${s.rho.toFixed(3)} IC95% [${s.ci95.map(v => v.toFixed(2)).join('; ')}], média móvel de 5 dias`;
  });
  t('renderizadores funcionam sob todos os perfis', () => {
    const antes = H.S.profile;
    const usados = [];
    C.PROFILE_IDS.forEach(id => {
      H.S.profile = id; H.S.opts = {};
      const d = H.ds();
      const fig = H.FIGURES.find(x => x.id === 'F1');
      const node = document.createElement('div');
      fig.render(node, d);
      assert(node.children.length > 0, `perfil ${id}: F1 não renderizou`);
      usados.push(id);
    });
    H.S.profile = antes;
    return usados.length + ' perfis renderizam F1';
  });
}

/* ------------------------ 12. proveniência e PERCEPT-REPORT (Onda 7.2) -- */
sec('proveniência auditável e checklist de reporte');
{
  const montarProv = () => {
    const prov = C.createProvenance({
      appVersion: '0.5.0', now: '2026-08-02T12:00:00Z',
      profileId: 'pd', profileLabel: 'Doença de Parkinson (STN/GPi)', timezoneOffsetMin: -180
    });
    prov.file({ name: 'a.json', sha256: 'abc123', subjectId: 'sub-676dc462', firmware: '07.05.05', deviceModel: 'Percept PC' });
    prov.record('io.analyzePackets', { method: 'sequences', pctMissing: 0 }, { nIn: 1260, nOut: 1260, nDropped: 0 });
    prov.record('dsp.welchPSD', { window: 'hann', nperseg: 512, overlap: 0.5, maxNanPct: 0 }, { nIn: 1260, nOut: 257, figure: 'F1' });
    prov.record('stats.cosinor', { harmonics: '24+12', nBoot: 200 }, { figure: 'F9' });
    return prov;
  };

  t('manifesto registra passos com os parâmetros efetivos e a contabilidade', () => {
    const m = montarProv().manifest();
    assert(m.header.appVersion === '0.5.0' && m.header.profileId === 'pd', 'cabeçalho incompleto');
    assert(m.files.length === 1 && m.files[0].sha256 === 'abc123', 'arquivo sem hash');
    assert(m.steps.length === 3, 'passos: ' + m.steps.length);
    const w = m.steps.find(s => s.step === 'dsp.welchPSD');
    assert(w.params.nperseg === 512 && w.params.overlap === 0.5, 'parâmetros efetivos não registrados');
    assert(w.nIn === 1260 && w.nOut === 257, 'contagens não registradas');
    assert(m.figures.F1 && m.figures.F1.includes(w.id), 'grafo figura→passo ausente');
    return `${m.steps.length} passos, ${Object.keys(m.figures).length} figuras no grafo`;
  });
  t('nenhum identificador direto entra no manifesto', () => {
    const m = montarProv().manifest();
    const txt = JSON.stringify(m);
    assert(/sub-[0-9a-f]{8}/.test(txt), 'deveria conter o id pseudonimizado');
    ['PatientId', 'DateOfBirth', 'SerialNumber', 'PatientFirstName'].forEach(k =>
      assert(!txt.includes(k), 'manifesto contém identificador direto: ' + k));
    return 'apenas subject_id hasheado';
  });
  await ta('hash do manifesto é estável para a mesma análise e muda com o parâmetro', async () => {
    const h1 = await montarProv().hash();
    const h2 = await montarProv().hash();
    assert(h1 === h2, 'hash instável entre execuções idênticas');
    const alterado = montarProv();
    alterado.record('dsp.welchPSD', { window: 'hann', nperseg: 1024, overlap: 0.5 }, {});
    const h3 = await alterado.hash();
    assert(h3 !== h1, 'hash não mudou ao mudar um parâmetro');
    assert(/^[0-9a-f]{32,64}$/.test(h1), 'formato de hash inesperado: ' + h1);
    return `${h1.slice(0, 16)}… estável; muda com o parâmetro`;
  });
  t('verifyManifest confirma reprodução e detecta divergência', () => {
    const a = montarProv().manifest();
    const igual = C.verifyManifest(a, montarProv().manifest());
    assert(igual.ok, 'reprodução idêntica não foi confirmada: ' + igual.verdict);
    /* muda um parâmetro efetivo → tem de acusar */
    const b = montarProv();
    const m2 = b.manifest();
    m2.steps.find(s => s.step === 'dsp.welchPSD').params.nperseg = 1024;
    const dif = C.verifyManifest(a, m2);
    assert(!dif.ok && dif.nDivergences >= 1, 'não detectou a divergência de parâmetro');
    assert(dif.divergences[0].campo.includes('welchPSD'), 'divergência apontou o campo errado');
    /* muda o hash do arquivo → tem de acusar */
    const m3 = montarProv().manifest();
    m3.files[0].sha256 = 'outro';
    assert(!C.verifyManifest(a, m3).ok, 'não detectou arquivo diferente');
    return `idêntico → ok; parâmetro alterado → ${dif.nDivergences} divergência(s)`;
  });
  t('checklist PERCEPT-REPORT preenche automaticamente a partir do manifesto', () => {
    const b = C.extractMetrics(parsed, null, { profileId: 'pd' });
    const ck = C.generateChecklist(montarProv().manifest(), b, C.getProfile('pd'));
    assert(ck.nTotal >= 35, 'checklist curto demais: ' + ck.nTotal);
    assert(ck.nFilled > 0, 'nada preenchido automaticamente');
    const todos = ck.items.flatMap(g => g.itens);
    /* o que não dá para extrair precisa DIZER que não deu, nunca ficar vazio */
    todos.forEach(i => assert(i.valor && String(i.valor).length > 0, 'item vazio: ' + i.chave));
    const naoDet = todos.filter(i => !i.preenchido);
    assert(naoDet.every(i => /não determinado|não aplicável/.test(i.valor)), 'item não preenchido sem justificativa');
    const est = todos.find(i => i.chave === 'estimator');
    assert(/nperseg 512/.test(est.valor), 'parâmetros de Welch não chegaram ao checklist: ' + est.valor);
    return `${ck.nFilled}/${ck.nTotal} itens preenchidos automaticamente`;
  });
  t('checklist sai em Markdown e em DOCX válido', () => {
    const b = C.extractMetrics(parsed, null, { profileId: 'pd' });
    const ck = C.generateChecklist(montarProv().manifest(), b, C.getProfile('pd'));
    assert(/^# PERCEPT-REPORT/.test(ck.markdown), 'markdown sem título');
    assert(ck.markdown.includes('| Item | Valor usado |'), 'markdown sem tabela');
    const docx = C.checklistDocx(ck);
    assert(docx instanceof Uint8Array && docx.length > 400, 'docx vazio');
    /* assinatura de arquivo ZIP (PK\x03\x04) — um .docx é um ZIP */
    assert(docx[0] === 0x50 && docx[1] === 0x4B && docx[2] === 0x03 && docx[3] === 0x04, 'docx não é um ZIP válido');
    const txt = new TextDecoder().decode(docx);
    assert(txt.includes('word/document.xml') && txt.includes('[Content_Types].xml'), 'docx sem as partes obrigatórias');
    return `${ck.markdown.split('\n').length} linhas de Markdown, DOCX de ${(docx.length / 1024).toFixed(1)} KB`;
  });
  t('escritor ZIP produz CRC32 correto', () => {
    /* vetor de referência: CRC32("123456789") = 0xCBF43926 */
    const crc = C.crc32(new TextEncoder().encode('123456789'));
    assert(crc === 0xCBF43926, 'CRC32 incorreto: 0x' + crc.toString(16));
    const z = C.makeZip([{ name: 'a.txt', data: 'olá' }, { name: 'b/c.txt', data: 'mundo' }]);
    assert(z[0] === 0x50 && z[1] === 0x4B, 'ZIP sem assinatura');
    return 'CRC32 confere com o vetor de referência';
  });
}

/* ------------------------------------------------------------- resultado -- */
console.log(`\n${'='.repeat(58)}`);
console.log(`  ${ok} passaram   ${falhas} falharam   ${pulados} sem dados`);
console.log('='.repeat(58));
process.exit(falhas ? 1 : 0);
