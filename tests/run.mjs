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

/* ------------------------------------------------------------- resultado -- */
console.log(`\n${'='.repeat(58)}`);
console.log(`  ${ok} passaram   ${falhas} falharam   ${pulados} sem dados`);
console.log('='.repeat(58));
process.exit(falhas ? 1 : 0);
