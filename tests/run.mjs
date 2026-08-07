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
  catch (e) { falhas++; console.log('  \u2717 ' + nome + '  ->  ' + e.message);
    if (process.env.PLS_STACK) console.log(String(e.stack).split('\n').slice(0, 6).join('\n')); }
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
    /* o cap de volta depende do MODELO (255 no PC, 65 535 no RC —
       UC202012929cEN p. 21–24), e por isso ele passou a ser obrigatório */
    const r = C.analyzePackets({
      data: recebidas, fs: FS, packetSizes: sizes, ticksMs: ticks, sequences: seqs,
      stream: 'LfpMontageTimeDomain', deviceModel: 'Percept PC B35200'
    });
    assert(r.method === 'sequences', 'método: ' + r.method);
    assert(r.sequenceCap === 256, 'cap do Percept PC deveria ser 256, veio ' + r.sequenceCap);
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
    const r = C.analyzePackets({
      data: recebidas, fs: FS, packetSizes: sizes, ticksMs: ticks, sequences: seqs,
      stream: 'LfpMontageTimeDomain', deviceModel: 'B35200'
    });
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

/* -------------------- 13. estado do dispositivo, fuso e QC (Ondas 1.3/2.2) -- */
sec('estado do dispositivo, fuso robusto e controle de qualidade');
{
  t('inferDeviceState distingue OFF, ON-0 mA e ON-terapêutico com evidência', () => {
    const base = { groups: [], eventLogs: [] };
    const on0 = C.inferDeviceState({ hemisphere: 'Left', series: { Left: { ma: [0, 0, 0] } }, therapy: { perHemi: { Left: { rate: 130 } } } }, base, { modality: 'streaming' });
    assert(on0.state === 'ON_0mA', 'ON a 0 mA não reconhecido: ' + on0.state);
    const onT = C.inferDeviceState({ hemisphere: 'Left', series: { Left: { ma: [0, 1.5, 2.7] } } }, base, { modality: 'streaming' });
    assert(onT.state === 'ON_THERAPEUTIC', 'ON terapêutico não reconhecido: ' + onT.state);
    assert(onT.amplitudeMa === 2.7, 'amplitude: ' + onT.amplitudeMa);
    const off = C.inferDeviceState({ hemisphere: 'Left' }, base, { modality: 'survey' });
    /* deixou de ser inferência fraca: o estado do Survey está DOCUMENTADO
       (UC202012929cEN p. 4, "Stimulation is off during the measurement") */
    assert(off.state === 'OFF', 'Survey deveria inferir OFF, veio ' + off.state);
    assert(off.confidence === 'documentada', 'a confiança do Survey deveria ser documentada, veio ' + off.confidence);
    assert(off.evidence.some(e => /UC202012929cEN/.test(e)), 'o estado documentado não cita a fonte');
    [on0, onT, off].forEach(r => assert(r.evidence.length > 0, 'inferência sem evidência registrada'));
    return `ON_0mA · ON_THERAPEUTIC (${onT.amplitudeMa} mA) · OFF (${off.confidence})`;
  });
  t('estados diferentes são declarados como não comparáveis (Hammer et al.)', () => {
    assert(C.statesComparable('OFF', 'OFF').comparable, 'mesmo estado deveria ser comparável');
    const r = C.statesComparable('OFF', 'ON_0mA');
    assert(!r.comparable, 'OFF vs ON-0 mA não pode ser comparável');
    assert(/0 mA/.test(r.reason), 'motivo não cita o achado de Hammer et al.');
    assert(!C.statesComparable('OFF', 'UNKNOWN').comparable, 'desconhecido não é comparável');
    return r.reason.slice(0, 58) + '…';
  });
  t('device_state entra como coluna obrigatória nas métricas agudas', () => {
    const b = C.extractMetrics(parsed, null, { profileId: 'pd' });
    b.acute.forEach(r => {
      assert('device_state' in r, 'sem device_state');
      assert(['OFF', 'ON_0mA', 'ON_THERAPEUTIC', 'UNKNOWN'].includes(r.device_state), 'estado inválido: ' + r.device_state);
      assert('device_state_evidence' in r, 'sem a evidência da inferência');
    });
    return b.acute.map(r => `${r.hemisphere[0]}:${r.device_state}`).join(' · ');
  });
  t('tabela de horário de verão gera transições corretas', () => {
    const br = C.dstTransitions('BR', 2017, 2019);
    assert(br.length >= 4, 'poucas transições no Brasil: ' + br.length);
    assert(br.every(x => Math.abs(x.deltaMin) === 60), 'delta diferente de 60 min');
    /* o horário de verão brasileiro foi extinto em 2019: sem início em 2019 */
    assert(!br.some(x => x.deltaMin === 60 && new Date(x.t).getUTCFullYear() === 2019),
      'não deveria haver início de horário de verão no Brasil em 2019');
    const eu = C.dstTransitions('EU', 2025, 2025);
    assert(eu.length === 2, 'UE deveria ter 2 transições por ano');
    assert(new Date(eu[0].t).getUTCMonth() === 2 && new Date(eu[0].t).getUTCDay() === 0, 'início da UE não é domingo de março');
    return `BR ${br.length} transições (extinto em 2019) · UE ${eu.length}/ano`;
  });
  t('série que atravessa transição é segmentada em dois', () => {
    /* 40 dias cruzando o fim do horário de verão brasileiro de 2018 */
    const fim = C.dstTransitions('BR', 2018, 2018).find(x => x.deltaMin === -60);
    const rows = [];
    for (let i = -20 * 144; i < 20 * 144; i++) rows.push({ t: fim.t + i * 10 * 60000, lfp: 40 });
    const seg = C.segmentByOffset(rows, { manualOffsetMin: -120, tzRegion: 'BR', detect: false });
    assert(seg.segments.length === 2, 'esperava 2 segmentos, veio ' + seg.segments.length);
    assert(seg.segments[0].offsetMin !== seg.segments[1].offsetMin, 'offsets iguais nos dois segmentos');
    assert(seg.segments[1].offsetMin === seg.segments[0].offsetMin - 60, 'delta aplicado incorreto');
    return `${seg.segments.length} segmentos: UTC${seg.segments[0].offsetMin / 60}h → UTC${seg.segments[1].offsetMin / 60}h`;
  });
  t('artefato de rampa é detectado nos instantes de mudança de amplitude', () => {
    const FS = 250, N = FS * 20;
    const x = new Float64Array(N);
    for (let i = 0; i < N; i++) x[i] = Math.sin(2 * Math.PI * 20 * i / FS);
    const ma = []; for (let i = 0; i < 40; i++) ma.push(i < 10 ? 0 : i < 25 ? 1.5 : 2.5);   // 2 degraus
    const r = C.detectRampArtifacts(x, FS, { maSeries: ma, maFs: 2 });
    assert(r.nSteps === 2, 'esperava 2 degraus, veio ' + r.nSteps);
    assert(r.alignmentOffsetSamples === 4, 'offset de alinhamento deveria ser a 4ª amostra (DBSsync)');
    const idxEsperado = Math.round(10 * FS / 2) + 4;
    assert(Math.abs(r.steps[0].idx - idxEsperado) <= 1, `degrau em ${r.steps[0].idx}, esperado ~${idxEsperado}`);
    const rem = C.removeRampArtifact(x, FS, r, { mode: 'mask' });
    assert(rem.applied && Array.from(rem.cleaned).some(Number.isNaN), 'mascaramento não aplicou NaN');
    return `${r.nSteps} degraus, alinhamento na 4ª amostra, ${rem.pctMasked}% mascarado`;
  });
  t('transientes polifásicos são marcados, não corrigidos', () => {
    const FS = 250, N = FS * 20;
    const x = new Float64Array(N);
    for (let i = 0; i < N; i++) x[i] = Math.sin(2 * Math.PI * 20 * i / FS);
    /* transiente polifásico de 40 ms (10 amostras) com 5 inversões de fase */
    for (let k = 0; k < 6; k++) for (let i = 0; i < 2; i++) x[1000 + k * 2 + i] += (k % 2 ? -1 : 1) * 12;
    const r = C.detectPolyphasic(x, FS, { k: 6 });
    assert(r.nEvents >= 1, 'nenhum transiente detectado');
    assert(/não é corrigido/i.test(r.note), 'nota não deixa claro que não corrige');
    return `${r.nEvents} evento(s), ${r.pctAffected}% do registro`;
  });
  t('harmônicos identificam onda quadrada como artefato provável', () => {
    const FS = 250, N = FS * 30;
    const quad = new Float64Array(N), seno = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      quad[i] = Math.sign(Math.sin(2 * Math.PI * 10 * i / FS)) * 2 + 0.3 * Math.sin(2 * Math.PI * 3.3 * i / FS);
      seno[i] = 2 * Math.sin(2 * Math.PI * 10 * i / FS) + 0.3 * Math.sin(2 * Math.PI * 3.3 * i / FS);
    }
    const wq = C.welchPSD(quad, FS, { nperseg: 2048, overlap: .5 });
    const ws = C.welchPSD(seno, FS, { nperseg: 2048, overlap: .5 });
    const hq = C.checkHarmonics(Array.from(wq.f), Array.from(wq.p), 10, {});
    const hs = C.checkHarmonics(Array.from(ws.f), Array.from(ws.p), 10, {});
    assert(hq.verdict === 'artefato provável', 'onda quadrada deveria ser artefato provável: ' + hq.verdict);
    assert(hs.verdict !== 'artefato provável', 'senoide pura não deveria ser artefato: ' + hs.verdict);
    return `quadrada: ${hq.nHarmonics} harmônicos → "${hq.verdict}" · senoide → "${hs.verdict}"`;
  });
  t('aliasing da estimulação é sinalizado quando o pico cai na dobra', () => {
    const h = C.checkHarmonics([1, 10, 20, 30], [1, 5, 1, 1], 30, { stimRateHz: 280, fs: 250 });
    assert(h.aliasing && h.aliasing.foldingFrequencies.includes(30), 'dobra de 280 Hz a 250 Hz deveria ser 30 Hz');
    assert(h.aliasing.peakNearFolding && h.isSuspect, 'pico sobre a dobra não foi sinalizado');
    return `fstim 280 Hz a 250 Hz → dobra em ${h.aliasing.foldingFrequencies.join(', ')} Hz`;
  });
  t('notch de 60 Hz reduz >20 dB em 60 sem alterar 20 Hz em mais de 1%', () => {
    const FS = 250, N = FS * 30;
    const x = new Float64Array(N);
    for (let i = 0; i < N; i++) x[i] = Math.sin(2 * Math.PI * 20 * i / FS) + 0.8 * Math.sin(2 * Math.PI * 60 * i / FS);
    const y = C.notchFFT(x, FS, { freq: 60, harmonics: 1 });
    const pot = (s, f0) => {
      const w = C.welchPSD(s, FS, { nperseg: 2048, overlap: .5 });
      let m = 0, n = 0;
      for (let i = 0; i < w.f.length; i++) if (Math.abs(w.f[i] - f0) <= 0.5) { m += w.p[i]; n++; }
      return n ? m / n : NaN;
    };
    const red = 10 * Math.log10(pot(x, 60) / pot(y, 60));
    const alt = Math.abs(pot(y, 20) / pot(x, 20) - 1) * 100;
    assert(red > 20, `redução em 60 Hz de apenas ${red.toFixed(1)} dB`);
    assert(alt < 1, `20 Hz alterado em ${alt.toFixed(2)}%`);
    return `−${red.toFixed(0)} dB em 60 Hz, 20 Hz alterado ${alt.toFixed(3)}%`;
  });
  t('reprodutibilidade classifica desvio de 0,5 Hz e de 4 Hz corretamente', () => {
    const f = []; for (let i = 0; i < 100; i++) f.push(i * 0.5);
    const espectro = pico => f.map(x => 1 / (1 + x) + (Math.abs(x - pico) < 0.6 ? 5 : 0));
    const estavel = [
      { hemisphere: 'Left', channel: '0-2', f, p: espectro(18.0) },
      { hemisphere: 'Left', channel: '0-2', f, p: espectro(18.5) }
    ];
    const instavel = [
      { hemisphere: 'Right', channel: '1-3', f, p: espectro(16.0) },
      { hemisphere: 'Right', channel: '1-3', f, p: espectro(20.0) }
    ];
    const r = C.peakReproducibility(estavel.concat(instavel), { lo: 13, hi: 35 });
    const e = r.channels.find(c => c.channel === '0-2'), i = r.channels.find(c => c.channel === '1-3');
    assert(e.verdict === 'reprodutível', 'desvio de 0,5 Hz deveria ser reprodutível: ' + e.verdict);
    assert(i.verdict === 'instável', 'desvio de 4 Hz deveria ser instável: ' + i.verdict);
    return `0,5 Hz → ${e.verdict} · 4 Hz → ${i.verdict}`;
  });
  t('painel de QC cobre o checklist e declara o que não é verificável', () => {
    const qc = C.qcPanel(parsed, { band: [13, 35] });
    assert(qc.rows.length > 0, 'painel vazio');
    const chaves = new Set(qc.rows[0].items.map(i => i.chave));
    ['pacotes', 'fs', 'ecg', 'rampa', 'polifasicos', 'movimento', 'estado', 'harmonicos', 'reprodutibilidade']
      .forEach(k => assert(chaves.has(k), 'item ausente do checklist: ' + k));
    qc.rows.flatMap(r => r.items).forEach(i => {
      assert(['verde', 'amarelo', 'vermelho', 'cinza'].includes(i.cor), 'cor inválida: ' + i.cor);
      /* cinza SEMPRE precisa dizer por que não foi verificável */
      if (i.cor === 'cinza') assert(i.motivo || i.valor, 'item cinza sem motivo: ' + i.chave);
    });
    const s = qc.summary;
    assert(s.verde + s.amarelo + s.vermelho + s.cinza === s.nItems, 'contagem do resumo não fecha');
    return `${s.nRows} linhas × ${chaves.size} itens — ${s.verde}✓ ${s.amarelo}⚠ ${s.vermelho}✗ ${s.cinza}○ (${s.pctVerificado}% verificável)`;
  });
  t('triagem por ECG recomenda incluir, excluir ou inspecionar', () => {
    const tri = C.screenChronicByEcg(parsed);
    const hs = Object.values(tri.hemispheres);
    assert(hs.length === 2, 'deveria avaliar os dois hemisférios');
    hs.forEach(h => assert(['incluir', 'excluir série crônica', 'inspeção visual necessária', 'não avaliável']
      .includes(h.recommendation), 'recomendação inválida: ' + h.recommendation));
    assert(/van Rheede/.test(tri.criterion), 'critério não cita a referência');
    return hs.map(h => `${h.hemisphere[0]}:${h.recommendation}`).join(' · ');
  });
  t('build detecta colisão de identificadores entre módulos', () => {
    /* garantia estrutural: o bundle é um escopo só, e o build precisa acusar
       colisão em tempo de build em vez de gerar bundle quebrado */
    const b = fs.readFileSync(path.join(RAIZ, 'src/build.mjs'), 'utf8');
    assert(/Colisão de identificadores/.test(b), 'build sem detecção de colisão');
    assert(/process\.exit\(1\)/.test(b), 'build não falha na colisão');
    return 'build falha alto em colisão de nomes';
  });
}

/* ------------------------------- 14. aDBS: elegibilidade e simulação (4.2) -- */
sec('aDBS — elegibilidade, simulador de limiar e predição dose-resposta');
{
  t('Levenberg-Marquardt recupera parâmetros de curva sintética', () => {
    const p = [10, 1.5, 0.5, 2];                        // L, k, x0, L0
    const x = [], y = [];
    for (let i = 0; i <= 20; i++) { const xv = i * 0.25; x.push(xv); y.push(C.MODELOS.decay.fn(xv, p)); }
    const r = C.levenbergMarquardt(x, y, C.MODELOS.decay.fn, [5, 1, 0, 0]);
    assert(r.r2 > 0.999, 'R² baixo: ' + r.r2);
    assert(Math.abs(r.params[1] - 1.5) < 0.05, 'k recuperado: ' + r.params[1]);
    return `R² ${r.r2.toFixed(5)}, k ${r.params[1].toFixed(3)} (verdadeiro 1,5), ${r.iterations} iterações`;
  });
  t('ajuste sigmoide recupera x0 de curva sintética com erro < 5%', () => {
    const p = [8, 3, 1.8, 1];
    const x = [], y = [];
    for (let i = 0; i <= 24; i++) { const xv = i * 0.15; x.push(xv); y.push(C.MODELOS.inverseSigmoid.fn(xv, p)); }
    const r = C.fitDoseResponse(x, y, { nBoot: 60 });
    assert(r, 'sem ajuste');
    const erro = 100 * Math.abs(r.halfSuppressionMa - 1.8) / 1.8;
    assert(erro < 5, `x0 = ${r.halfSuppressionMa}, erro ${erro.toFixed(1)}%`);
    assert(!r.stimulationArtifactSuspected, 'curva decrescente marcada como artefato');
    return `x₀ ${r.halfSuppressionMa} mA (verdadeiro 1,8; erro ${erro.toFixed(1)}%), modelo "${r.label}", R² ${r.r2}`;
  });
  t('curva CRESCENTE é sinalizada como artefato de estimulação', () => {
    const x = [], y = [];
    for (let i = 0; i <= 12; i++) { x.push(i * 0.2); y.push(2 + 1.5 * i * 0.2); }   // cresce com mA
    const r = C.fitDoseResponse(x, y, { nBoot: 40 });
    assert(r && r.stimulationArtifactSuspected, 'não sinalizou artefato numa curva crescente');
    assert(/artefato de estimulação/.test(r.reason), 'motivo não explica a heurística');
    return r.reason.slice(0, 60) + '…';
  });
  t('simulador: limiar no ponto médio dá duty cycle próximo de 50%', () => {
    /* série bimodal, metade do tempo em cada patamar */
    const serie = [];
    for (let i = 0; i < 600; i++) serie.push({ t: i * 600000, v: (Math.floor(i / 50) % 2) ? 80 : 20 });
    const s = C.simulateAdbs(serie, { mode: 'single', lower: 50, upper: 50, minMa: 1, maxMa: 3, averagingMs: 0 });
    assert(s, 'sem simulação');
    assert(Math.abs(s.dutyCycle - 0.5) < 0.1, 'duty cycle: ' + s.dutyCycle);
    assert(s.pctHigh > 40 && s.pctHigh < 60, '% em alta: ' + s.pctHigh);
    return `duty cycle ${s.dutyCycle}, ${s.pctHigh}% em amplitude alta`;
  });
  t('constante de tempo do aparelho reduz substancialmente as transições', () => {
    /* tendência lenta + ruído rápido, com o limiar deslocado da média — é o
       caso real: sem suavização o aparelho persegue cada oscilação */
    const serie = [];
    for (let i = 0; i < 800; i++)
      serie.push({ t: i * 600000, v: 50 + 25 * Math.sin(i / 60) + 18 * Math.sin(i * 2.3) });
    const comum = { mode: 'single', lower: 55, upper: 55, minMa: 1, maxMa: 3, rampMaPerSec: 10 };
    const instant = C.simulateAdbs(serie, Object.assign({ averagingMs: 0 }, comum));
    const suave = C.simulateAdbs(serie, Object.assign({ averagingMs: 1800000 }, comum));
    const reducao = 100 * (1 - suave.transitions / instant.transitions);
    assert(reducao > 30, `redução de apenas ${reducao.toFixed(0)}% nas transições`);
    assert(Math.abs(suave.dutyCycle - instant.dutyCycle) < 0.1, 'a suavização não deveria mudar muito o duty cycle');
    return `${instant.transitions} → ${suave.transitions} transições (−${reducao.toFixed(0)}%), duty cycle preservado`;
  });
  t('varredura de limiares cobre a grade e sugere por três critérios', () => {
    const serie = [];
    for (let i = 0; i < 400; i++) serie.push({ t: i * 600000, v: 40 + 20 * Math.sin(i / 20) });
    const sw = C.thresholdSweep(serie, { n: 6, minMa: 1, maxMa: 3 });
    assert(sw && sw.grid.length === 36, 'grade incompleta: ' + (sw ? sw.grid.length : 0));
    assert(sw.grid.some(c => c.valid), 'nenhuma célula válida');
    const sug = C.suggestThresholds(serie, { targetDutyCycle: 0.4 });
    assert(sug.suggestions.length >= 2, 'poucas sugestões');
    sug.suggestions.forEach(x => assert(x.upper > x.lower, 'sugestão com limiares invertidos: ' + x.criterion));
    return `${sw.grid.filter(c => c.valid).length} pares válidos · ${sug.suggestions.length} critérios de sugestão`;
  });
  t('elegibilidade avalia os seis critérios e diz o que falta capturar', () => {
    const e = C.assessEligibility(parsed, { profileId: 'pd', offMin: -180 });
    assert(e.hemispheres.length === 2, 'deveria avaliar os dois hemisférios');
    e.hemispheres.forEach(h => {
      const ids = h.criteria.map(c => c.id);
      ['pico', 'artefato', 'reprodutibilidade', 'parametros', 'cronico', 'circadiano']
        .forEach(k => assert(ids.includes(k), `critério ausente: ${k}`));
      assert(['elegível', 'elegível com ressalva', 'não elegível', 'dados insuficientes'].includes(h.verdict),
        'veredito inválido: ' + h.verdict);
      h.criteria.forEach(c => assert(c.evidencia && c.evidencia.length, 'critério sem evidência: ' + c.id));
      /* todo critério não atendido precisa dizer o que fazer a respeito */
      h.criteria.filter(c => c.veredito !== 'atende').forEach(c =>
        assert(c.pendencia || c.veredito === 'atende com ressalva', 'pendência não explicada: ' + c.id));
    });
    assert(/ADAPT-START/.test(e.context), 'contexto não cita o ADAPT-START');
    assert(e.prevalence && /84,8/.test(e.prevalence.adaptPd), 'prevalência do ADAPT-PD ausente');
    return e.hemispheres.map(h => `${h.hemisphere[0]}:${h.verdict}`).join(' · ');
  });
  t('sem pico na banda primária o hemisfério não é elegível', () => {
    /* espectro plano: nenhum pico destacado do fundo */
    const falso = JSON.parse(JSON.stringify({
      fileName: 'x.json',
      meta: { sessionStart: '2025-01-06T12:00:00Z', utcOffsetMin: -180 },
      patient: { idHash: 'sub-00000000', diagnosis: 'ParkinsonsDisease' },
      device: { implantDate: '2024-09-12' }, leads: [{ hemisphere: 'Left', target: 'Stn' }],
      groups: [], eventLogs: [], sensingSetup: [], signalCheck: [], bsTimeDomain: [], bsLfp: [],
      montageTD: [], snapshots: [], trend: {}, availability: {},
      montage: [{ hemisphere: 'Left', label: '0-2', f: Array.from({ length: 100 }, (_, i) => i * 0.5),
        mag: Array.from({ length: 100 }, (_, i) => 1 / (1 + i * 0.5)), artifact: 'ARTIFACT_NOT_PRESENT' }]
    }));
    const e = C.assessEligibility([falso], { profileId: 'pd', offMin: -180 });
    const L = e.hemispheres.find(h => h.hemisphere === 'Left');
    assert(!L.hasPeak, 'não deveria encontrar pico num espectro plano');
    assert(L.verdict === 'não elegível', 'veredito: ' + L.verdict);
    assert(L.blockers.length > 0, 'sem bloqueios listados');
    return `veredito "${L.verdict}", bloqueios: ${L.blockers.join('; ')}`;
  });
  t('com menos de 3 dias de Timeline o critério crônico não é atendido', () => {
    const e = C.assessEligibility(parsed, { profileId: 'pd', offMin: -180 });
    const h = e.hemispheres[0];
    const cr = h.criteria.find(c => c.id === 'cronico');
    assert(cr, 'critério crônico ausente');
    if (h.nDaysChronic >= 5) assert(cr.veredito === 'atende', 'com ≥5 dias deveria atender');
    else assert(cr.pendencia && /ADAPT-START/.test(cr.pendencia), 'pendência não cita o número de dias do ADAPT-START');
    return `${h.nDaysChronic} dias → "${cr.veredito}"`;
  });
}

/* ------------------------------ desempenho e retorno de processo (Onda 8.0) */
sec('desempenho e retorno de processo');
{
  /* O bootstrap de blocos era o gargalo do carregamento: com meses de Timeline
     ele sozinho segurava a thread por segundos. A reformulação soma as equações
     normais por dia, então precisa provar DUAS coisas: que o estimador não
     mudou e que o custo caiu. */
  const off = -180, T0 = Date.parse('2025-03-02T03:00:00Z');
  let semente = 4242;
  const rnd = () => { semente = (Math.imul(semente, 1664525) + 1013904223) >>> 0; return semente / 4294967296; };
  const linhas = [];
  for (let d = 0; d < 45; d++) for (let k = 0; k < 144; k++) {
    const tt = T0 + d * 864e5 + k * 6e5;
    linhas.push({ t: tt, lfp: 40 + 8 * Math.cos(2 * Math.PI * (C.localHour(tt, off) - 16) / 24) + 2 * (rnd() - 0.5) });
  }

  t('bootstrap de blocos é idêntico ao reajuste completo', () => {
    /* referência: refaz o cosinor inteiro em cada reamostragem, com a MESMA
       sequência de sorteio (mesmo gerador, mesma semente, mesma ordem de dias) */
    const porDia = {};
    linhas.forEach(r => { const k = C.localDayKey(r.t, off); (porDia[k] = porDia[k] || []).push(r); });
    const dias = Object.keys(porDia);
    let sem = 999 >>> 0;
    const prox = () => { sem = (Math.imul(sem, 1664525) + 1013904223) >>> 0; return sem / 4294967296; };
    const mesor = [], amp = [];
    for (let b = 0; b < 60; b++) {
      const amostra = [];
      for (let i = 0; i < dias.length; i++) amostra.push(...porDia[dias[(prox() * dias.length) | 0]]);
      const c = C.cosinor(amostra.map(r => C.localHour(r.t, off)), amostra.map(r => r.lfp), [24]);
      mesor.push(c.mesor); amp.push(c.components[0].amplitude);
    }
    const ref = { m: [C.quantile(mesor, 0.025), C.quantile(mesor, 0.975)], a: [C.quantile(amp, 0.025), C.quantile(amp, 0.975)] };
    const b = C.cosinorBootstrap(linhas, [24], 60, off, { seed: 999 });
    const dif = Math.max(
      Math.abs(b.mesorCI[0] - ref.m[0]), Math.abs(b.mesorCI[1] - ref.m[1]),
      Math.abs(b.amplitudeCI[0] - ref.a[0]), Math.abs(b.amplitudeCI[1] - ref.a[1]));
    assert(dif < 1e-8, 'estimador divergiu do reajuste completo: ' + dif.toExponential(2));
    return `diferença máxima ${dif.toExponential(1)} sobre ${linhas.length} pontos`;
  });

  t('bootstrap é reprodutível entre execuções (semente fixa)', () => {
    const a = C.cosinorBootstrap(linhas, [24], 80, off);
    const b = C.cosinorBootstrap(linhas, [24], 80, off);
    assert(a.mesorCI[0] === b.mesorCI[0] && a.amplitudeCI[1] === b.amplitudeCI[1], 'IC mudou entre execuções idênticas');
    const c = C.cosinorBootstrap(linhas, [24], 80, off, { seed: 7 });
    assert(c.mesorCI[0] !== a.mesorCI[0] || c.amplitudeCI[0] !== a.amplitudeCI[0], 'a semente não muda nada');
    return `semente ${a.seed} reproduz; semente 7 difere`;
  });

  t('bootstrap de 6 semanas com nBoot=200 custa menos de 1 s', () => {
    const t0 = Date.now();
    const b = C.cosinorBootstrap(linhas, [24], 200, off);
    const dt = Date.now() - t0;
    assert(b && b.nBoot === 200, 'bootstrap incompleto');
    assert(dt < 1000, `levou ${dt} ms — o gargalo do carregamento voltou`);
    return `${linhas.length} pontos × 200 reamostragens em ${dt} ms`;
  });

  t('valores não finitos são excluídos e contabilizados, nunca imputados', () => {
    const sujo = linhas.slice(0, 4000).concat([{ t: T0, lfp: NaN }, { t: T0 + 6e5, lfp: NaN }]);
    const b = C.cosinorBootstrap(sujo, [24], 40, off);
    assert(b.nExcluded === 2, 'nExcluded: ' + b.nExcluded);
    return `${b.nExcluded} amostras excluídas, ${b.nDays} dias mantidos`;
  });

  /* O painel de processamento é o que responde à pergunta "travou ou está
     calculando?". Aqui verificamos o contrato: percentual monotônico, cada
     etapa registrada, e término em 100%. */
  await ta('painel de processamento anuncia etapas e chega a 100%', async () => {
    const G = H.Prog;
    G.begin('teste').expect(3);
    const pcts = [];
    for (const rotulo of ['ler', 'interpretar', 'agregar']) {
      await G.step(rotulo);
      pcts.push(parseInt(document.getElementById('procPct').textContent, 10));
    }
    await G.finish('ok');
    const fim = parseInt(document.getElementById('procPct').textContent, 10);
    assert(pcts.every((v, i) => i === 0 || v >= pcts[i - 1]), 'percentual não é monotônico: ' + pcts.join(','));
    assert(fim === 100, 'não terminou em 100%: ' + fim);
    assert(!G.ativo, 'painel continuou ativo após finish');
    return `percentuais ${pcts.join(' → ')} → ${fim}%`;
  });

  await ta('falha de uma etapa não derruba as demais', async () => {
    const G = H.Prog;
    G.begin('teste').expect(2);
    await G.step('etapa que falha');
    G.falhaEtapa('arquivo inválido');
    await G.step('etapa que segue');
    await G.finish('ok');
    assert(!G.ativo, 'painel não encerrou');
    return 'etapa marcada como falha e execução continuou';
  });

  /* Regressão real: um identificador inexistente em renderRail derrubava TODO o
     carregamento — o painel lateral lançava ReferenceError antes de qualquer
     figura ser desenhada, e o aplicativo terminava sem entregar gráfico nenhum.
     O erro não aparecia nos testes porque nada exercitava o painel lateral. */
  t('painel lateral do registro é montado sem exceção', () => {
    H.renderRail();
    return `${H.S.files.length} arquivo(s) no painel`;
  });

  t('ds() é memoizado e invalidado explicitamente', () => {
    const a = H.ds();
    assert(H.ds() === a, 'ds() recalculou sem mudança de estado');
    H.invalidarDs();
    assert(H.ds() !== a, 'ds() não recalculou após invalidação');
    return 'cache válido entre chamadas, descartado em invalidarDs()';
  });
}

/* ------------------------- modo clínico e leituras em prosa (Onda 8.1) ----- */
sec('modo clínico, leituras em linguagem simples e pipelines');
{
  const b81 = C.extractMetrics(parsed, -180, { profileId: 'pd' });
  const painel81 = C.qcPanel(parsed, { band: [13, 35] });
  const r81 = C.clinicalReadings(b81, { profileId: 'pd', qcPanel: painel81 });

  t('leituras cobrem os seis domínios, por hemisfério', () => {
    assert(r81, 'sem leituras');
    const ids = new Set(r81.readings.map(l => l.id));
    ['pico', 'aperiodico', 'bursts', 'circadiano', 'limiares', 'estados'].forEach(k =>
      assert(ids.has(k), 'domínio ausente: ' + k));
    return `${r81.readings.length} leituras · domínios: ${Array.from(ids).join(', ')}`;
  });

  t('toda leitura com número declara o parâmetro que o produziu', () => {
    const semParam = r81.readings.filter(l => l.numeros && !l.parametro);
    assert(!semParam.length, 'sem parâmetro declarado: ' + semParam.map(l => l.id).join(', '));
    return `${r81.readings.filter(l => l.parametro).length} leituras declaram parâmetro`;
  });

  t('toda leitura conclusiva traz ressalva explícita', () => {
    const semRessalva = r81.readings.filter(l => l.nivel === 'ok' && !l.ressalva);
    assert(!semRessalva.length, 'sem ressalva: ' + semRessalva.map(l => l.id).join(', '));
    return `${r81.readings.filter(l => l.ressalva).length}/${r81.readings.length} com ressalva`;
  });

  t('nenhuma leitura sugere uso diagnóstico ou substituição do software regulado', () => {
    /* invariante 6 do contrato: não é dispositivo médico. O teste varre TODO o
       texto exposto ao usuário, não só o disclaimer. */
    const proibido = /\b(diagnostic[ao]|diagnostica(?:r|do)|cura|prognóstico|substitui\s+o\s+(?:julgamento|software)|indica(?:do|ção)\s+terapêutic)/i;
    const texto = r81.readings.map(l => [l.titulo, l.frase, l.numeros, l.parametro, l.ressalva].join(' ')).join('\n');
    const achado = texto.split('\n').find(linha => proibido.test(linha));
    assert(!achado, 'termo proibido em: ' + String(achado).slice(0, 120));
    assert(/não substituem o julgamento clínico/.test(r81.disclaimer), 'disclaimer sem a ressalva obrigatória');
    return 'nenhum termo diagnóstico nas leituras; disclaimer presente';
  });

  t('dado ausente vira "não é possível determinar", nunca um número inventado', () => {
    const vazio = { subject: { id: 'sub-0', profile_id: 'pd' }, acute: [{ hemisphere: 'Left', target: 'Stn' }], chronic: [] };
    const r = C.clinicalReadings(vazio, { profileId: 'pd' });
    const insuf = r.readings.filter(l => l.nivel === 'insuficiente');
    assert(insuf.length >= 2, 'esperava leituras insuficientes, veio ' + insuf.length);
    assert(insuf.every(l => !/\d+,\d/.test(l.numeros || '')), 'leitura insuficiente trouxe número');
    return `${insuf.length} leituras declaram dado insuficiente, sem números`;
  });

  t('semáforo de QC resume sem esconder o que não é verificável', () => {
    const sf = C.qcTrafficLight(painel81);
    assert(['verde', 'amarelo', 'vermelho', 'cinza'].includes(sf.cor), 'cor inválida: ' + sf.cor);
    if (sf.naoVerificaveis > 0) assert(/não são verificáveis/.test(sf.frase), 'não declarou itens não verificáveis');
    const semPainel = C.qcTrafficLight(null);
    assert(semPainel.cor === 'cinza', 'sem painel deveria ser cinza');
    return `${sf.cor} — ${sf.rotulo} · ${sf.naoVerificaveis} item(ns) não verificáveis`;
  });

  t('modo clínico mostra as figuras do perfil; modo pesquisa mostra todas', () => {
    const antes = H.S.mode, perfilAntes = H.S.profile;
    H.S.profile = 'pd'; H.S.mode = 'clinico';
    const clin = H.figurasVisiveis().map(f => f.id);
    H.S.mode = 'pesquisa';
    const pesq = H.figurasVisiveis().map(f => f.id);
    H.S.mode = antes; H.S.profile = perfilAntes;
    /* o conjunto tem de ser EXATAMENTE o declarado no perfil — comparar contra
       um número mágico deixaria passar figura trocada por outra */
    /* compara como CONJUNTO: a ordem de exibição é a de FIGURES, e a ordem
       declarada no perfil é a de leitura pretendida — as duas não coincidem de
       propósito. Trocar uma figura por outra continua sendo pego. */
    const esperado = C.PROFILES.pd.clinicalFigures.slice().sort();
    assert(clin.slice().sort().join(' ') === esperado.join(' '),
      `modo clínico mostrou "${clin.join(' ')}", perfil declara "${C.PROFILES.pd.clinicalFigures.join(' ')}"`);
    assert(pesq.length === H.FIGURES.length, 'modo pesquisa deveria mostrar todas');
    return `clínico: ${clin.join(' ')} · pesquisa: ${pesq.length} figuras`;
  });

  t('toda figura declarada nos perfis existe de fato', () => {
    const ids = new Set(H.FIGURES.map(f => f.id));
    const faltando = [];
    C.PROFILE_IDS.forEach(pid => (C.PROFILES[pid].clinicalFigures || []).forEach(fid => {
      if (!ids.has(fid)) faltando.push(pid + ':' + fid);
    }));
    assert(!faltando.length, 'figura inexistente: ' + faltando.join(', '));
    return `${C.PROFILE_IDS.length} perfis, todas as figuras clínicas existem`;
  });

  t('trocar de modo não muda nenhum número calculado', () => {
    const antes = H.S.mode;
    H.S.mode = 'clinico';
    const a = JSON.stringify(H.exportBundle().chronic);
    H.S.mode = 'pesquisa';
    const b = JSON.stringify(H.exportBundle().chronic);
    H.S.mode = antes;
    assert(a === b, 'as métricas mudaram com o modo');
    return 'métricas crônicas idênticas nos dois modos';
  });

  t('pipelines apontam para figuras existentes e trazem uma exportação', () => {
    const ids = new Set(H.FIGURES.map(f => f.id));
    H.PIPELINES.forEach(pl => {
      assert(pl.figs.length && pl.figs.every(x => ids.has(x)), 'figura inexistente no pipeline ' + pl.id);
      assert(typeof pl.exportar === 'function', 'pipeline sem exportação: ' + pl.id);
      assert(pl.desc && pl.desc.length > 20, 'pipeline sem descrição: ' + pl.id);
    });
    return `${H.PIPELINES.length} pipelines: ${H.PIPELINES.map(p => p.id).join(', ')}`;
  });
}

/* ------------------------- DSP avançada: multitaper, specparam, wavelet,
                              PAC e gama (Onda 3) --------------------------- */
sec('DSP avançada — multitaper, specparam, wavelet, PAC e gama');
{
  const FS3 = 250;
  let sem3 = 20260802;
  const rnd3 = () => { sem3 = (Math.imul(sem3, 1664525) + 1013904223) >>> 0; return sem3 / 4294967296; };
  const gauss3 = () => { let u = 0, v = 0; while (u === 0) u = rnd3(); while (v === 0) v = rnd3(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  /* ------------------------------------------------------------ multitaper */
  t('DPSS: tapers ortonormais com k cruzamentos de zero na ordem k', () => {
    const s = C.dpss(256, 4, 7);
    assert(s && s.tapers.length === 7, 'dpss não devolveu 7 tapers');
    let pior = 0;
    for (let a = 0; a < 7; a++) for (let b = a; b < 7; b++) {
      let d = 0; for (let i = 0; i < 256; i++) d += s.tapers[a][i] * s.tapers[b][i];
      pior = Math.max(pior, Math.abs(d - (a === b ? 1 : 0)));
    }
    assert(pior < 1e-8, 'desvio de ortonormalidade: ' + pior.toExponential(2));
    s.tapers.forEach((v, k) => {
      let z = 0; for (let i = 1; i < v.length; i++) if (v[i - 1] * v[i] < 0) z++;
      assert(z === k, `taper de ordem ${k} tem ${z} cruzamentos de zero`);
    });
    return `ortonormalidade ${pior.toExponential(1)}; cruzamentos de zero 0…6 na ordem`;
  });

  t('DPSS: concentrações decrescentes e ≈1 até a ordem 2NW−2', () => {
    const s = C.dpss(512, 4, 8);
    for (let k = 1; k < s.concentrations.length; k++)
      assert(s.concentrations[k] <= s.concentrations[k - 1] + 1e-9, 'concentração subiu na ordem ' + k);
    for (let k = 0; k < 2 * 4 - 2; k++)
      assert(s.concentrations[k] > 0.99, `λ${k} = ${s.concentrations[k].toFixed(4)} abaixo de 0,99`);
    return `λ = ${s.concentrations.slice(0, 8).map(v => v.toFixed(4)).join(' ')}`;
  });

  t('multitaper recupera pico conhecido em registro curto e devolve IC', () => {
    const N = FS3 * 8;                              // 8 s: poucos segmentos de Welch
    const x = new Float64Array(N);
    for (let i = 0; i < N; i++) x[i] = Math.sin(2 * Math.PI * 21.5 * i / FS3) + 0.8 * gauss3();
    const mt = C.multitaperPSD(x, FS3, { NW: 3 });
    assert(mt && mt.p, 'multitaper falhou');
    let bf = NaN, bv = -Infinity;
    for (let i = 0; i < mt.f.length; i++) if (mt.f[i] > 10 && mt.f[i] < 35 && mt.p[i] > bv) { bv = mt.p[i]; bf = mt.f[i]; }
    assert(Math.abs(bf - 21.5) < 0.6, 'pico em ' + bf.toFixed(2) + ' Hz');
    assert(mt.ciLow && mt.ciHigh, 'sem IC por jackknife');
    const ib = mt.f.findIndex(v => Math.abs(v - bf) < 1e-9);
    assert(mt.ciLow[ib] < mt.p[ib] && mt.p[ib] < mt.ciHigh[ib], 'IC não contém a estimativa');
    return `pico ${bf.toFixed(2)} Hz (verdadeiro 21,5) · K = ${mt.K} · ${mt.dofApprox} gl`;
  });

  t('multitaper recusa quando não há trecho contíguo utilizável', () => {
    const x = new Float64Array(2000);
    for (let i = 0; i < 2000; i++) x[i] = (i % 7 === 0) ? NaN : Math.sin(i / 5);
    const mt = C.multitaperPSD(x, FS3, { NW: 3 });
    assert(mt && mt.p === null, 'devolveu espectro apesar das lacunas');
    assert(/contíguo/.test(mt.reason), 'motivo não menciona o trecho contíguo: ' + mt.reason);
    return mt.reason;
  });

  /* ------------------------------------------------------------- specparam */
  const espectroSintetico = (chi, offset, picos) => {
    const f = [], p = [];
    for (let k = 1; k <= 200; k++) {
      const x = k * 0.5;
      let logp = offset - chi * Math.log10(x);
      picos.forEach(([a, c, sg]) => { logp += a * Math.exp(-Math.pow(x - c, 2) / (2 * sg * sg)); });
      f.push(x); p.push(Math.pow(10, logp));
    }
    return { f, p };
  };

  t('specparam recupera expoente, offset e picos de espectro sintético', () => {
    const e = espectroSintetico(1.5, 1.2, [[0.6, 22, 3], [0.3, 8, 1.5]]);
    const m = C.specparam(e.f, e.p, { fmin: 2, fmax: 95 });
    assert(m, 'specparam devolveu null');
    assert(Math.abs(m.exponent - 1.5) < 0.1, 'expoente ' + m.exponent);
    assert(Math.abs(m.offset - 1.2) < 0.15, 'offset ' + m.offset);
    assert(m.r2 > 0.95, 'R² ' + m.r2);
    const cf = m.peaks.map(x => x.cf);
    assert(cf.some(v => Math.abs(v - 22) < 1), 'não achou o pico de 22 Hz: ' + cf.join(','));
    assert(cf.some(v => Math.abs(v - 8) < 1), 'não achou o pico de 8 Hz: ' + cf.join(','));
    const p22 = m.peaks.find(x => Math.abs(x.cf - 22) < 1);
    assert(Math.abs(p22.bw - 6) < 2.5, 'largura do pico de 22 Hz: ' + p22.bw);
    return `χ ${m.exponent} (1,5) · offset ${m.offset} (1,2) · R² ${m.r2} · picos ${cf.map(v => v.toFixed(1)).join(', ')} Hz`;
  });

  t('specparam escolhe joelho quando há joelho e reta quando não há', () => {
    const fj = [], pj = [];
    for (let k = 1; k <= 200; k++) { const x = k * 0.5; fj.push(x); pj.push(Math.pow(10, 1.5) / (10 + Math.pow(x, 2))); }
    const comJoelho = C.specparamCompare(fj, pj, { fmin: 1, fmax: 95 });
    assert(comJoelho.best === 'knee', 'não escolheu joelho: ' + comJoelho.best);
    assert(Math.abs(comJoelho.knee.exponent - 2) < 0.2, 'expoente com joelho: ' + comJoelho.knee.exponent);
    const reta = espectroSintetico(1.4, 1.0, [[0.5, 20, 3]]);
    const semJoelho = C.specparamCompare(reta.f, reta.p, { fmin: 2, fmax: 95 });
    assert(semJoelho.best === 'fixed', 'escolheu joelho onde não há: ' + semJoelho.best);
    return `com joelho → "${comJoelho.best}" (ΔAIC ${comJoelho.deltaAic}) · sem joelho → "${semJoelho.best}"`;
  });

  t('specparam avisa quando o ajuste não descreve o espectro', () => {
    const f = [], p = [];
    for (let k = 1; k <= 200; k++) { const x = k * 0.5; f.push(x); p.push(1 + 0.9 * Math.sin(x)); }
    const m = C.specparam(f, p, { fmin: 2, fmax: 95 });
    if (!m) return 'espectro rejeitado antes do ajuste';
    if (m.r2 < 0.8) { assert(m.warning && /R²/.test(m.warning), 'sem aviso de R² baixo'); return `R² ${m.r2} → "${m.quality}", aviso emitido`; }
    return `R² ${m.r2} (ajuste inesperadamente bom) — qualidade "${m.quality}"`;
  });

  /* ----------------------------------------------------------------- wavelet */
  t('CWT de Morlet localiza a frequência correta e marca o cone de influência', () => {
    const N = FS3 * 6, x = new Float64Array(N);
    for (let i = 0; i < N; i++) x[i] = Math.sin(2 * Math.PI * 18 * i / FS3);
    const freqs = []; for (let ff = 10; ff <= 30; ff += 1) freqs.push(ff);
    const cwt = C.morletCWT(x, FS3, freqs, { nCycles: 7 });
    assert(cwt, 'CWT falhou');
    const meio = Math.floor(N / 2);
    let bk = -1, bv = -Infinity;
    cwt.power.forEach((linha, k) => { if (linha[meio] > bv) { bv = linha[meio]; bk = k; } });
    assert(Math.abs(freqs[bk] - 18) <= 1, 'máximo em ' + freqs[bk] + ' Hz');
    assert(!Number.isFinite(cwt.power[bk][0]), 'a borda deveria ser NaN (cone de influência)');
    return `máximo em ${freqs[bk]} Hz · cone de influência ${cwt.coneOfInfluenceSec[bk]} s em cada borda`;
  });

  t('detecção e delimitação de burst são parâmetros separados', () => {
    const N = FS3 * 40, x = new Float64Array(N);
    let env = 0.3;
    for (let i = 0; i < N; i++) {
      env = 0.94 * env + 0.06 * (rnd3() < 0.02 ? 3 : 0.3);
      x[i] = 2 * env * Math.cos(2 * Math.PI * 20 * i / FS3) + 0.5 * gauss3();
    }
    const freqs = []; for (let ff = 13; ff <= 30; ff += 1.5) freqs.push(ff);
    const cwt = C.morletCWT(x, FS3, freqs, { nCycles: 7 });
    const env2 = C.waveletBandEnvelope(cwt, 13, 30);
    const meia = C.waveletBursts(env2.env, FS3, { percentile: 75, edgeFraction: 0.5 });
    const rente = C.waveletBursts(env2.env, FS3, { percentile: 75, edgeFraction: 1.0 });
    assert(meia && rente, 'detecção falhou');
    assert(meia.meanDurationMs > rente.meanDurationMs * 1.3,
      `a fração de borda não mudou a duração: ${meia.meanDurationMs} vs ${rente.meanDurationMs}`);
    assert(meia.threshold === rente.threshold, 'o limiar de detecção deveria ser o mesmo');
    return `mesmo limiar, borda 50% → ${meia.meanDurationMs} ms · borda 100% → ${rente.meanDurationMs} ms`;
  });

  t('limiar por linha de base 1/f não se move quando a oscilação cresce', () => {
    /* o percentil é circular: se o paciente passa mais tempo em beta alto, ele
       sobe junto e "não há mais bursts". O limiar aperiódico não. */
    const fraco = espectroSintetico(1.5, 1.2, [[0.3, 20, 3]]);
    const forte = espectroSintetico(1.5, 1.2, [[1.2, 20, 3]]);
    const mf = C.specparam(fraco.f, fraco.p, { fmin: 2, fmax: 95 });
    const ms = C.specparam(forte.f, forte.p, { fmin: 2, fmax: 95 });
    const tf = C.aperiodicBurstThreshold(mf, 13, 30, { k: 2 });
    const ts = C.aperiodicBurstThreshold(ms, 13, 30, { k: 2 });
    assert(tf && ts, 'limiar aperiódico não calculado');
    const varLimiar = Math.abs(ts.threshold - tf.threshold) / tf.threshold;
    /* o percentil da própria banda muda muito mais */
    const banda = (e) => { let s = 0, n = 0; e.f.forEach((x, i) => { if (x >= 13 && x <= 30) { s += e.p[i]; n++; } }); return s / n; };
    const varBanda = Math.abs(banda(forte) - banda(fraco)) / banda(fraco);
    assert(varLimiar < 0.2, 'o limiar aperiódico variou ' + (100 * varLimiar).toFixed(0) + '%');
    assert(varBanda > 1.0, 'a potência da banda deveria mudar muito: ' + (100 * varBanda).toFixed(0) + '%');
    return `potência da banda +${(100 * varBanda).toFixed(0)}% · limiar aperiódico ${(100 * varLimiar).toFixed(1)}%`;
  });

  /* --------------------------------------------------------------------- PAC */
  const sinalPac = (acoplado) => {
    const N = FS3 * 60, x = new Float64Array(N);
    let fase = 0, env = 0.3;
    for (let i = 0; i < N; i++) {
      const fb = 20 + 1.5 * Math.sin(2 * Math.PI * 0.13 * i / FS3) + 0.4 * gauss3();
      fase += 2 * Math.PI * fb / FS3;
      env = 0.94 * env + 0.06 * (rnd3() < 0.02 ? 3 : 0.3);
      const mod = acoplado ? (1 + Math.cos(fase)) / 2 : (1 + Math.cos(2 * Math.PI * 3.3 * i / FS3)) / 2;
      x[i] = 2 * env * Math.cos(fase) + 1.0 * mod * Math.sin(2 * Math.PI * 80 * i / FS3) + 0.6 * gauss3();
    }
    return x;
  };

  t('PAC separa sinal acoplado de sinal não acoplado', () => {
    const a = C.pacTort(sinalPac(true), FS3, { phaseBand: [13, 30], ampBand: [50, 120], nSurrogates: 150 });
    const b = C.pacTort(sinalPac(false), FS3, { phaseBand: [13, 30], ampBand: [50, 120], nSurrogates: 150 });
    assert(a.significant, `acoplado não deu significativo: z=${a.z}, p=${a.pEmpirical}`);
    assert(!b.significant, `não acoplado deu significativo: z=${b.z}, p=${b.pEmpirical}`);
    assert(a.z > b.z + 5, `z do acoplado (${a.z}) não é claramente maior que o do controle (${b.z})`);
    return `acoplado z=${a.z} p=${a.pEmpirical} · controle z=${b.z} p=${b.pEmpirical}`;
  });

  t('PAC é reprodutível: mesma semente, mesmo resultado', () => {
    const x = sinalPac(true);
    const a = C.pacTort(x, FS3, { phaseBand: [13, 30], ampBand: [50, 120], nSurrogates: 60, seed: 4242 });
    const b = C.pacTort(x, FS3, { phaseBand: [13, 30], ampBand: [50, 120], nSurrogates: 60, seed: 4242 });
    assert(a.z === b.z && a.pEmpirical === b.pEmpirical, 'resultado mudou entre execuções idênticas');
    return `z = ${a.z} reproduzido com a semente ${a.seed}`;
  });

  t('assimetria de forma de onda separa seno de dente de serra', () => {
    const N = FS3 * 30;
    const seno = new Float64Array(N), serra = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      seno[i] = Math.sin(2 * Math.PI * 20 * i / FS3) + 0.05 * gauss3();
      const ph = (i / FS3 * 20) % 1;
      serra[i] = 2 * ph - 1 + 0.05 * gauss3();
    }
    const a = C.waveformAsymmetry(seno, FS3, 13, 30);
    const b = C.waveformAsymmetry(serra, FS3, 13, 30);
    assert(!a.nonSinusoidal, 'seno marcado como não senoidal: ' + a.peakTroughSymmetry);
    assert(b.nonSinusoidal, 'dente de serra não marcado: ' + b.peakTroughSymmetry);
    assert(Math.abs(a.peakTroughSymmetry - 0.5) < 0.05, 'simetria do seno: ' + a.peakTroughSymmetry);
    return `simetria pico-vale: seno ${a.peakTroughSymmetry} (0,5 = simétrico) · serra ${b.peakTroughSymmetry}`;
  });

  /* -------------------------------------------------------------------- gama */
  const espectroGama = (picoHz) => {
    const f = [], p = [];
    for (let k = 1; k <= 250; k++) {
      const x = k * 0.5;
      let logp = 1.0 - 1.4 * Math.log10(x);
      logp += 0.9 * Math.exp(-Math.pow(x - picoHz, 2) / (2 * 1.2 * 1.2));
      f.push(x); p.push(Math.pow(10, logp));
    }
    return { f, p };
  };

  t('gama em f_stim/2 é classificada como entrained, não como endógena', () => {
    const e = espectroGama(65);
    const g = C.detectGamma(e.f, e.p, { stimRateHz: 130, tolHz: 2.5 });
    assert(g.entrained, 'não classificou como entrained: ' + g.verdict);
    assert(Math.abs(g.entrained.hz - 65) < 1.5, 'pico em ' + g.entrained.hz);
    assert(/estimulação/.test(g.clinicalNote || ''), 'nota clínica não explica o engate');
    const g2 = C.detectGamma(e.f, e.p, { stimRateHz: 160, tolHz: 2.5 });
    assert(g2.ftg && !g2.entrained, 'com f_stim = 160 o mesmo pico deveria ser endógeno: ' + g2.verdict);
    return `65 Hz com f_stim 130 → "${g.verdict}" · com f_stim 160 → "${g2.verdict}"`;
  });

  t('sem a frequência de estimulação, gama não é classificada', () => {
    const e = espectroGama(65);
    const g = C.detectGamma(e.f, e.p, {});
    assert(/indistinguível/.test(g.verdict), 'veredito: ' + g.verdict);
    assert(!g.entrained, 'afirmou entrained sem f_stim');
    assert(g.reason && /opostas/.test(g.reason), 'não explica por que se recusa');
    return g.verdict;
  });

  t('mudar a frequência de estimulação confirma o entrainment', () => {
    const r = C.confirmEntrainment([
      Object.assign({ label: 'A', stimRateHz: 130 }, espectroGama(65)),
      Object.assign({ label: 'B', stimRateHz: 160 }, espectroGama(80))
    ], { tolHz: 2.5 });
    assert(r.conclusive && /entrained/.test(r.verdict), 'veredito: ' + r.verdict);
    const parado = C.confirmEntrainment([
      Object.assign({ label: 'A', stimRateHz: 130 }, espectroGama(75)),
      Object.assign({ label: 'B', stimRateHz: 160 }, espectroGama(75))
    ], { tolHz: 2.5 });
    assert(parado.conclusive && /endógeno/.test(parado.verdict), 'veredito parado: ' + parado.verdict);
    const um = C.confirmEntrainment([Object.assign({ stimRateHz: 130 }, espectroGama(65))], {});
    assert(!um.conclusive, 'concluiu com um registro só');
    return `pico acompanha → "${r.verdict}" · pico parado → "${parado.verdict}"`;
  });
}

/* ------------------- varredura do Survey: ranking dos pares bipolares ------ */
sec('varredura do Survey — ranking dos pares bipolares (F1)');
{
  /* espectro sintético: 1/f com offset e expoente dados, mais um bump gaussiano */
  const espectro = (offset, chi, bumpAlt, bumpHz, bumpSg) => {
    const f = [], mag = [];
    for (let k = 1; k <= 100; k++) {
      const x = k * 0.977;
      let logp = offset - chi * Math.log10(x);
      if (bumpAlt) logp += bumpAlt * Math.exp(-Math.pow(x - bumpHz, 2) / (2 * bumpSg * bumpSg));
      f.push(+x.toFixed(4)); mag.push(Math.pow(10, logp));
    }
    return { f, mag };
  };
  const canal = (hemi, rotulo, e) => Object.assign({
    hemisphere: hemi, electrodes: rotulo.replace('-', '_AND_') + '_' + hemi.toUpperCase(),
    label: rotulo, artifact: ''
  }, e);

  t('ordena os pares por hemisfério, com posições de 1 a n', () => {
    const mont = [
      canal('Left', '0-1', espectro(1.0, 1.5, 0.2, 20, 3)),
      canal('Left', '0-2', espectro(1.0, 1.5, 0.7, 20, 3)),
      canal('Left', '1-3', espectro(1.0, 1.5, 0.4, 20, 3)),
      canal('Right', '0-2', espectro(1.0, 1.5, 0.3, 22, 3)),
      canal('Right', '1-3', espectro(1.0, 1.5, 0.9, 22, 3))
    ];
    const r = C.rankSurveyChannels(mont, { lo: 13, hi: 35, criterion: 'aperiodic' });
    assert(r, 'ranking nulo');
    assert(r.hemispheres.Left.length === 3 && r.hemispheres.Right.length === 2, 'contagem por hemisfério');
    assert(r.hemispheres.Left[0].label === '0-2', 'melhor à esquerda: ' + r.hemispheres.Left[0].label);
    assert(r.hemispheres.Right[0].label === '1-3', 'melhor à direita: ' + r.hemispheres.Right[0].label);
    r.hemispheres.Left.forEach((c, i) => assert(c.rank === i + 1, 'posição fora de ordem'));
    return `E: ${r.hemispheres.Left.map(c => c.label).join(' > ')} · D: ${r.hemispheres.Right.map(c => c.label).join(' > ')}`;
  });

  t('descontar o 1/f muda a ordem — é o motivo de o critério ser esse', () => {
    /* A tem oscilação; B só tem o fundo mais alto (mais ruído, impedância
       diferente). Na área bruta B ganha; acima do aperiódico, A ganha. */
    const A = canal('Left', '0-2', espectro(1.0, 1.5, 0.6, 20, 3));
    const B = canal('Left', '1-3', espectro(1.6, 1.5, 0, 20, 3));
    const bruto = C.rankSurveyChannels([A, B], { lo: 13, hi: 35, criterion: 'raw' });
    const corr = C.rankSurveyChannels([A, B], { lo: 13, hi: 35, criterion: 'aperiodic' });
    assert(bruto.hemispheres.Left[0].label === '1-3', 'na área bruta deveria ganhar o de fundo alto');
    assert(corr.hemispheres.Left[0].label === '0-2', 'acima do 1/f deveria ganhar o que tem oscilação');
    return `bruto → ${bruto.hemispheres.Left[0].label} · acima do 1/f → ${corr.hemispheres.Left[0].label}`;
  });

  t('pares repetidos entre registros viram um só, pela mediana', () => {
    const base = espectro(1.0, 1.5, 0.6, 20, 3);
    const alto = { f: base.f, mag: base.mag.map(v => v * 3) };     // registro contaminado
    const mont = [
      canal('Left', '0-2', base), canal('Left', '0-2', base), canal('Left', '0-2', alto),
      canal('Left', '1-3', espectro(1.0, 1.5, 0.3, 20, 3))
    ];
    const r = C.rankSurveyChannels(mont, { lo: 13, hi: 35 });
    const c = r.hemispheres.Left.find(x => x.label === '0-2');
    assert(r.hemispheres.Left.length === 2, 'não agrupou: ' + r.hemispheres.Left.length + ' entradas');
    assert(c.nRecords === 3, 'nRecords: ' + c.nRecords);
    /* a mediana de [v, v, 3v] é v — o registro contaminado não puxa o ranking */
    const so = C.rankSurveyChannels([canal('Left', '0-2', base)], { lo: 13, hi: 35 });
    const dif = Math.abs(c.bandArea - so.hemispheres.Left[0].bandArea) / so.hemispheres.Left[0].bandArea;
    assert(dif < 0.02, 'a mediana não neutralizou o registro contaminado: ' + (100 * dif).toFixed(1) + '%');
    return `3 registros → 1 par, área ${c.bandArea} (mediana; registro 3× não contaminou)`;
  });

  t('canal sem ajuste aperiódico utilizável fica fora da ordenação, não no topo', () => {
    /* ordenar pela área bruta um canal que os outros mediram acima do 1/f
       misturaria escalas e inventaria uma ordem — ele vai para o fim, marcado */
    const f = [], mag = [];
    for (let k = 1; k <= 100; k++) { const x = k * 0.977; f.push(x); mag.push(30 + 25 * Math.sin(x)); }
    const bom = canal('Left', '0-2', espectro(1.0, 1.5, 0.6, 20, 3));
    const ruim = canal('Left', '1-3', { f, mag });
    const r = C.rankSurveyChannels([bom, ruim], { lo: 13, hi: 35, criterion: 'aperiodic' });
    const cr = r.hemispheres.Left.find(c => c.label === '1-3');
    assert(cr, 'canal ausente');
    assert(!cr.rankable, 'deveria ser marcado como não ordenável (R² ' + cr.aperiodicR2 + ')');
    assert(cr.rank === r.hemispheres.Left.length, 'não foi para o fim da lista');
    assert(!r.top.Left.some(c => c.label === '1-3'), 'canal não ordenável apareceu entre os melhores');
    assert(/NÃO entraram na ordenação/.test(r.caveat), 'o aviso não explica a exclusão');
    /* e a área bruta dele é muito maior — é exatamente por isso que ordenar
       misturando escalas produziria a ordem errada */
    assert(cr.bandArea > r.top.Left[0].bandArea, 'o caso construído não é o pretendido');
    return `R² ${cr.aperiodicR2} → fora da ordenação (área bruta ${cr.bandArea} vs ${r.top.Left[0].bandArea} do #1)`;
  });

  t('F1 monta a varredura e a tabela dos três melhores', () => {
    const fig = H.FIGURES.find(x => x.id === 'F1');
    const n = document.createElement('div');
    const d = H.ds();
    fig.render(n, d);
    assert(n.children.length > 6, 'poucos blocos na F1: ' + n.children.length);
    const rk = C.rankSurveyChannels(d.montage, { lo: 13, hi: 35, criterion: 'aperiodic' });
    assert(rk && rk.top.Left && rk.top.Left.length <= 3, 'top 3 ausente');
    return `${n.children.length} blocos · ${rk.nChannels} pares ordenados`;
  });
}

/* -------------------- trabalho em segundo plano (Onda 0.2) ---------------- */
sec('trabalho em segundo plano e instrumentação');
{
  t('parsePerceptText devolve o mesmo que parsePercept sobre o JSON', () => {
    const arq = arquivos[0];
    const texto = fs.readFileSync(path.join(PASTA, arq), 'utf8');
    const a = C.parsePercept(JSON.parse(texto), arq);
    const b = C.parsePerceptText(texto, arq);
    assert(a.patient.idHash === b.patient.idHash, 'identificador diferente');
    assert(JSON.stringify(a.availability) === JSON.stringify(b.availability), 'modalidades diferentes');
    assert((a.montage || []).length === (b.montage || []).length, 'número de canais de survey diferente');
    return `${arq}: ${(b.montage || []).length} canais de survey, ${Object.keys(b.availability).length} modalidades`;
  });

  await ta('sem Worker, o cálculo cai para a thread principal e isso é declarado', async () => {
    /* neste ambiente não existe Worker — é exatamente o caminho de degradação
       que precisa funcionar em navegador antigo ou em file:// restritivo */
    assert(typeof Worker !== 'function', 'este ambiente tem Worker; o teste precisa do caminho sem ele');
    assert(!H.Trabalhador.disponivel(), 'o trabalhador se declarou disponível sem Worker');
    const out = await H.Trabalhador.chamar('extractMetrics', [parsed, -180, { profileId: 'pd' }]);
    assert(out.r && out.r.subject, 'não devolveu o pacote de métricas');
    assert(/thread principal/.test(out.ondeRodou), 'não declarou onde rodou: ' + out.ondeRodou);
    assert(isFinite(out.ms), 'não mediu o tempo');
    return `${out.ondeRodou} em ${out.ms} ms · motivo: ${H.Trabalhador.motivo || '—'}`;
  });

  await ta('o trabalhador só executa funções nomeadas do núcleo', async () => {
    let erro = null;
    try { await H.Trabalhador.chamar('naoExiste', []); } catch (e) { erro = e.message; }
    assert(erro && /desconhecida/.test(erro), 'aceitou nome arbitrário: ' + erro);
    let erro2 = null;
    try { await H.Trabalhador.chamar('constructor', []); } catch (e) { erro2 = e.message; }
    assert(erro2 && /desconhecida/.test(erro2), 'aceitou um membro herdado de Object: ' + erro2);
    return 'nomes fora do núcleo são recusados';
  });

  await ta('a instrumentação registra passo, tempo e onde rodou', async () => {
    H.Instrumentacao.limpa();
    const a = await H.Trabalhador.chamar('extractMetrics', [parsed, -180, { profileId: 'pd' }]);
    H.Instrumentacao.registra('extractMetrics', a.ms, a.ondeRodou);
    const r = H.Instrumentacao.resumo();
    assert(r.nSteps === 1, 'passos: ' + r.nSteps);
    assert(r.steps[0].step === 'extractMetrics' && isFinite(r.steps[0].ms), 'passo malformado');
    assert(r.workerState === 'indisponível' || r.workerState === 'não iniciado', 'estado: ' + r.workerState);
    assert(r.nInWorker === 0, 'contou passos no trabalhador onde não há trabalhador');
    return `${r.nSteps} passo(s), ${r.totalMs} ms, ${r.nInWorker} no trabalhador, estado "${r.workerState}"`;
  });

  await ta('o manifesto de proveniência registra onde o cálculo aconteceu', async () => {
    H.S.subject = chaves[0]; H.S.opts = {};
    H.Instrumentacao.limpa();
    const a = await H.Trabalhador.chamar('extractMetrics', [parsed, -180, { profileId: 'pd' }]);
    H.Instrumentacao.registra('extractMetrics', a.ms, a.ondeRodou);
    const prov = await H.buildProvenance();
    const m = prov.manifest();
    const passo = (m.steps || []).find(x => x.step === 'runtime.instrumentation');
    assert(passo, 'o manifesto não traz a instrumentação');
    assert(passo.params.stepsTotal >= 1, 'nenhum passo registrado no manifesto');
    assert('workerState' in passo.params, 'o manifesto não diz o estado do trabalhador');
    return `manifesto declara estado "${passo.params.workerState}", ${passo.params.stepsInWorker}/${passo.params.stepsTotal} no trabalhador`;
  });
}

/* ------------- sinal externo, sincronização e coerência (Onda 2.3) -------- */
sec('sinal externo, sincronização e coerência');
{
  const FSX = 250, NX = FSX * 40;
  let semX = 424242;
  const rndX = () => { semX = (Math.imul(semX, 1664525) + 1013904223) >>> 0; return semX / 4294967296; };
  const gX = () => { let u = 0, v = 0; while (u === 0) u = rndX(); while (v === 0) v = rndX(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  /* par com fonte comum de 5 Hz e atraso conhecido no sinal externo */
  const parComAtraso = atrasoMs => {
    const dN = Math.round(atrasoMs * FSX / 1000);
    const comum = new Float64Array(NX + dN);
    let fase = 0;
    for (let i = 0; i < comum.length; i++) {
      fase += 2 * Math.PI * (5 + 0.3 * Math.sin(2 * Math.PI * 0.07 * i / FSX)) / FSX;
      comum[i] = Math.sin(fase) * (1 + 0.5 * Math.sin(2 * Math.PI * 0.05 * i / FSX));
    }
    const lfp = new Float64Array(NX), ext = new Float64Array(NX);
    for (let i = 0; i < NX; i++) { lfp[i] = 2 * comum[i + dN] + gX(); ext[i] = 1.5 * comum[i] + gX(); }
    return { lfp, ext };
  };

  t('lê CSV genérico e declara delimitador, tempo, fs e irregularidade', () => {
    const { ext } = parComAtraso(0);
    const linhas = ['Time (s);Acc_X (g);EMG1 (mV)'];
    for (let i = 0; i < 2000; i++) linhas.push([(i / FSX).toFixed(5), ext[i].toFixed(5), (0.2 * gX()).toFixed(5)].join(';'));
    const p = C.parseExternalCsv(linhas.join('\n'));
    assert(p.ok, 'não leu: ' + p.reason);
    assert(p.delimiter === ';', 'delimitador: ' + p.delimiter);
    assert(Math.abs(p.fs - FSX) < 0.5, 'fs: ' + p.fs);
    assert(p.channels.length === 2, 'canais: ' + p.channels.length);
    assert(p.channels[0].kind === 'imu' && p.channels[1].kind === 'emg', 'tipos: ' + p.channels.map(c => c.kind).join(','));
    assert(p.channels[0].unit === 'g', 'unidade: ' + p.channels[0].unit);
    assert(!p.absoluteTime && /relativo/.test(p.timeInterpretation), 'tempo: ' + p.timeInterpretation);
    assert(p.warnings.some(w => /RELATIVA/.test(w)), 'não avisou sobre tempo relativo');
    return `delim "${p.delimiter}" · ${p.fs} Hz · ${p.channels.map(c => c.name + '[' + c.kind + ']').join(', ')}`;
  });

  t('CSV com timestamp ISO e vírgula decimal também é lido', () => {
    const linhas = ['timestamp,valor'];
    const t0 = Date.parse('2026-03-01T10:00:00Z');
    for (let i = 0; i < 500; i++) linhas.push(new Date(t0 + i * 4).toISOString() + ',' + String(Math.sin(i / 9).toFixed(4)).replace('.', ','));
    const p = C.parseExternalCsv(linhas.join('\n'));
    assert(p.ok, 'não leu: ' + p.reason);
    assert(p.absoluteTime, 'não reconheceu tempo absoluto');
    assert(Math.abs(p.fs - 250) < 1, 'fs: ' + p.fs);
    assert(p.channels[0].nValid === 500, 'valores com vírgula decimal não foram lidos: ' + p.channels[0].nValid);
    return `${p.timeInterpretation} · ${p.fs} Hz · ${p.channels[0].nValid} valores`;
  });

  t('linhas malformadas são descartadas com contagem, nunca remendadas', () => {
    const linhas = ['t,v'];
    for (let i = 0; i < 300; i++) linhas.push(i % 50 === 7 ? `${i / 250},1,2,3` : `${i / 250},${Math.sin(i / 7).toFixed(4)}`);
    const p = C.parseExternalCsv(linhas.join('\n'));
    assert(p.ok, 'não leu');
    assert(p.nRowsDropped === 6, 'descartadas: ' + p.nRowsDropped);
    assert(p.warnings.some(w => /descartada/.test(w)), 'não avisou sobre o descarte');
    return `${p.nRowsDropped} linhas descartadas de 300`;
  });

  t('reamostragem não preenche lacuna: buraco vira NaN', () => {
    const tMs = [], y = [];
    for (let i = 0; i < 1000; i++) { const t = i * 4; if (t > 1200 && t < 2400) continue; tMs.push(t); y.push(Math.sin(i / 5)); }
    const r = C.resampleUniform(tMs, y, 250, {});
    assert(r, 'reamostragem falhou');
    assert(r.nNaN > 200, 'a lacuna de 1,2 s não virou NaN: ' + r.nNaN);
    return `${r.nNaN} amostras NaN (${r.pctNaN}%) na lacuna de 1,2 s`;
  });

  t('coerência declara o limiar da nula e não confunde ruído com acoplamento', () => {
    const a = new Float64Array(NX), b = new Float64Array(NX);
    for (let i = 0; i < NX; i++) { a[i] = gX(); b[i] = gX(); }
    const coh = C.coherence(a, b, FSX, { nperseg: 512 });
    const r = C.coherenceBand(coh, 3, 8);
    assert(coh.expectedNullCoherence > 0, 'não declarou a coerência esperada sob a nula');
    assert(!r.significant, `ruído independente deu significativo: pico ${r.peakCoherence} vs limiar ${r.thresholdBandCorrected}`);
    assert(r.thresholdBandCorrected > r.threshold, 'o limiar da banda não é mais exigente que o por bin');
    return `pico ${r.peakCoherence} < limiar corrigido ${r.thresholdBandCorrected} (por bin ${r.threshold}, nula ${coh.expectedNullCoherence})`;
  });

  t('coerência recupera o atraso conhecido entre os dois sinais', () => {
    const erros = [20, 40, 60].map(atraso => {
      const { lfp, ext } = parComAtraso(atraso);
      const r = C.coherenceBand(C.coherence(lfp, ext, FSX, { nperseg: 512 }), 3, 8);
      assert(r.significant, `atraso ${atraso} ms: coerência não significativa`);
      return { atraso, medido: r.preferredLagMs, erro: Math.abs(r.preferredLagMs - atraso) };
    });
    const pior = Math.max.apply(null, erros.map(e => e.erro));
    assert(pior < 5, 'erro de atraso: ' + pior.toFixed(1) + ' ms');
    return erros.map(e => `${e.atraso}→${e.medido.toFixed(1)}`).join(' · ') + ` ms (pior erro ${pior.toFixed(1)} ms)`;
  });

  t('parte imaginária separa acoplamento com atraso de mistura instantânea', () => {
    /* mistura instantânea: o mesmo sinal nos dois canais, sem atraso nenhum —
       coerência alta e parte imaginária nula, que é a assinatura de condução
       de volume ou referência comum */
    const fonte = new Float64Array(NX);
    let fase = 0;
    for (let i = 0; i < NX; i++) { fase += 2 * Math.PI * 5 / FSX; fonte[i] = Math.sin(fase); }
    const a = new Float64Array(NX), b = new Float64Array(NX);
    for (let i = 0; i < NX; i++) { a[i] = fonte[i] + 0.5 * gX(); b[i] = 0.8 * fonte[i] + 0.5 * gX(); }
    const inst = C.coherenceBand(C.coherence(a, b, FSX, { nperseg: 512 }), 3, 8);
    const comAtraso = parComAtraso(40);
    const atrasado = C.coherenceBand(C.coherence(comAtraso.lfp, comAtraso.ext, FSX, { nperseg: 512 }), 3, 8);
    assert(inst.significant && atrasado.significant, 'os dois casos deveriam ser coerentes');
    assert(inst.volumeConductionSuspected, 'mistura instantânea não foi sinalizada: fase ' + inst.phaseAtPeakDeg + '°, imag no pico ' + inst.imagAtPeak);
    assert(!atrasado.volumeConductionSuspected, 'acoplamento com atraso foi confundido com condução de volume');
    return `instantâneo: fase ${inst.phaseAtPeakDeg}°, imag ${inst.imagAtPeak} (sinalizado) · com atraso: fase ${atrasado.phaseAtPeakDeg}°, imag ${atrasado.imagAtPeak}`;
  });

  t('sincronização por artefato de estimulação casa os eventos', () => {
    const la = new Float64Array(NX), ea = new Float64Array(NX);
    const desl = Math.round(0.4 * FSX);
    for (let i = 0; i < NX; i++) {
      const onL = i > FSX * 10 && i < FSX * 25.2;
      const onE = i > FSX * 10 + desl && i < FSX * 25.2 + desl;
      la[i] = gX() * (onL ? 6 : 1);
      ea[i] = gX() * (onE ? 5 : 1);
    }
    const st = C.alignByStimArtifact(la, ea, FSX, {});
    assert(st.ok, 'não alinhou: ' + st.reason);
    assert(Math.abs(st.lagMs - 400) < 300, 'deslocamento: ' + st.lagMs + ' ms (esperado ~400)');
    assert(st.nEvents >= 2, 'eventos casados: ' + st.nEvents);
    return `${st.nEvents} eventos, deslocamento ${st.lagMs} ms, dispersão ${st.spreadMs} ms, confiança ${st.confidence}`;
  });

  t('sincronização mal determinada é declarada mal determinada', () => {
    const { lfp, ext } = parComAtraso(0);
    const al = C.alignByCrossCorrelation(lfp, ext, FSX, { band: [3, 8], maxLagSec: 2, nSurrogates: 60 });
    assert(al.ok, 'falhou: ' + al.reason);
    assert(isFinite(al.peakHalfWidthMs), 'não reportou a largura do pico');
    /* o envelope de um ritmo estreito dá pico largo — a incerteza precisa
       aparecer, e a confiança não pode ser "alta" nessa situação */
    if (al.peakHalfWidthMs > 100) assert(al.confidence !== 'alta',
      `pico de ±${al.peakHalfWidthMs} ms declarado com confiança alta`);
    assert(/incerteza/.test(al.caveat), 'a ressalva não menciona a incerteza');
    return `lag ${al.lagMs} ms ± ${al.peakHalfWidthMs} ms · r ${al.correlation} · confiança ${al.confidence}`;
  });

  t('timestamp declarado é aceito, mas marcado como não verificado', () => {
    const a = C.alignByTimestamp(1000, 1500);
    assert(a.ok && a.lagMs === 500, 'deslocamento: ' + a.lagMs);
    assert(a.confidence === 'não verificado', 'confiança: ' + a.confidence);
    assert(/não são sincronizados/.test(a.caveat), 'a ressalva não explica o risco');
    const b = C.alignByTimestamp(NaN, 1500);
    assert(!b.ok, 'aceitou alinhar sem hora absoluta');
    return 'aceito com ressalva; recusado quando falta hora absoluta';
  });
}

/* --------- actograma, banda-controle, cluster, ICC e longitudinal --------- */
sec('actograma, banda-controle, cluster, ICC e longitudinal (Ondas 4.1 e 4.3)');
{
  let sem4 = 777;
  const rnd4 = () => { sem4 = (Math.imul(sem4, 1664525) + 1013904223) >>> 0; return sem4 / 4294967296; };
  const g4 = () => { let u = 0, v = 0; while (u === 0) u = rnd4(); while (v === 0) v = rnd4(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const mat = (nEnsaios, nPontos, bump) => Array.from({ length: nEnsaios }, () =>
    Array.from({ length: nPontos }, (_, i) => g4() + (bump && i >= 10 && i <= 16 ? 2 : 0)));

  t('cluster encontra a região com efeito e a localiza corretamente', () => {
    const r = C.clusterPermutation(mat(20, 30, true), mat(20, 30, false), { nPermutations: 500 });
    const sig = r.clusters.filter(c => c.significant);
    assert(sig.length >= 1, 'nenhum cluster significativo');
    const c = sig[0];
    assert(c.startIdx <= 11 && c.endIdx >= 15, `cluster [${c.startIdx}-${c.endIdx}] não cobre a região 10–16`);
    assert(/EM ALGUM LUGAR/.test(r.caveat), 'a ressalva sobre localização não está presente');
    return `cluster [${c.startIdx}–${c.endIdx}] massa ${c.mass} p = ${c.p}`;
  });

  t('cluster não inventa efeito onde não há', () => {
    const r = C.clusterPermutation(mat(20, 30, false), mat(20, 30, false), { nPermutations: 500 });
    assert(!r.anySignificant, 'declarou significativo em ruído puro: ' + JSON.stringify(r.clusters.map(c => c.p)));
    return r.clusters.length ? `${r.clusters.length} cluster(s) candidato(s), nenhum significativo` : 'nenhum cluster candidato';
  });

  t('cluster pareado usa troca de sinal e é reprodutível', () => {
    const A = mat(15, 24, true), B = mat(15, 24, false);
    const a = C.clusterPermutation(A, B, { paired: true, nPermutations: 400, seed: 5 });
    const b = C.clusterPermutation(A, B, { paired: true, nPermutations: 400, seed: 5 });
    assert(a.paired, 'não marcou como pareado');
    assert(JSON.stringify(a.clusters) === JSON.stringify(b.clusters), 'resultado mudou com a mesma semente');
    return `${a.clusters.length} cluster(s), reprodutível com a semente ${a.seed}`;
  });

  t('actograma recupera a deriva de fase que existe e não inventa a que não existe', () => {
    const T0 = Date.parse('2025-03-01T00:00:00Z');
    const monta = deriva => {
      const rows = [];
      for (let d = 0; d < 14; d++) for (let k = 0; k < 144; k++) {
        const tt = T0 + d * 864e5 + k * 6e5;
        rows.push({ t: tt, lfp: 40 + 8 * Math.cos(2 * Math.PI * (k / 144 - (16 + deriva * d) / 24)) + 1.5 * g4() });
      }
      return rows;
    };
    const medidas = [0, 0.25, -0.5].map(dv => ({ dv, medido: C.actogram(monta(dv), 0, { binMin: 30 }).medianDriftHoursPerDay }));
    medidas.forEach(m => assert(Math.abs(m.medido - m.dv) < 0.12, `deriva ${m.dv} h/dia medida como ${m.medido}`));
    const semDeriva = C.actogram(monta(0), 0, { binMin: 30 });
    assert(/se mantém/.test(semDeriva.driftNote), 'inventou deriva: ' + semDeriva.driftNote);
    const comDeriva = C.actogram(monta(-0.5), 0, { binMin: 30 });
    assert(/desloca/.test(comDeriva.driftNote), 'não relatou a deriva real');
    assert(comDeriva.rows[0].values.length === 2 * comDeriva.nBins, 'não é duplo-plot');
    return medidas.map(m => `${m.dv}→${m.medido}`).join(' · ') + ' h/dia';
  });

  t('banda-controle recusa quando não há espectros datados suficientes', () => {
    const r = C.controlBandDiurnal([{ t: 1, f: [1, 2], p: [1, 1] }], -180, {});
    assert(!r.ok, 'aceitou com um espectro só');
    assert(/ao menos 8/.test(r.reason), 'motivo: ' + r.reason);
    return r.reason.slice(0, 90);
  });

  t('banda-controle separa ritmo específico de modulação global', () => {
    const T0 = Date.parse('2025-03-01T00:00:00Z');
    const espectro = (hora, ganhoMarcador, ganhoGlobal) => {
      const f = [], p = [];
      for (let k = 1; k <= 120; k++) {
        const x = k * 0.977;
        let v = Math.pow(10, 1 - 1.4 * Math.log10(x));
        if (x >= 13 && x <= 35) v *= ganhoMarcador;
        p.push(v * ganhoGlobal * (1 + 0.05 * g4())); f.push(x);
      }
      return { f, p };
    };
    const monta = (especifico) => {
      const out = [];
      for (let d = 0; d < 6; d++) for (let hh = 0; hh < 24; hh += 3) {
        const ciclo = 1 + 0.6 * Math.cos(2 * Math.PI * (hh - 16) / 24);
        const e = especifico ? espectro(hh, ciclo, 1) : espectro(hh, 1, ciclo);
        out.push({ t: T0 + d * 864e5 + hh * 36e5, f: e.f, p: e.p });
      }
      return out;
    };
    const espec = C.controlBandDiurnal(monta(true), 0, { markerBand: [13, 35], controlBand: [55, 95], nBins: 8, nPermutations: 600 });
    const global = C.controlBandDiurnal(monta(false), 0, { markerBand: [13, 35], controlBand: [55, 95], nBins: 8, nPermutations: 600 });
    assert(espec.ok && global.ok, 'não avaliável');
    assert(espec.bandSpecific, `ritmo específico não reconhecido: razão ${espec.amplitudeRatio}, cluster ${espec.cluster && espec.cluster.anySignificant}`);
    assert(!global.bandSpecific, `modulação global tratada como específica: razão ${global.amplitudeRatio}`);
    return `específico: razão ${espec.amplitudeRatio}× (${espec.verdict}) · global: razão ${global.amplitudeRatio}× (${global.verdict})`;
  });

  t('ICC separa métrica confiável de métrica que é só ruído', () => {
    const bom = Array.from({ length: 8 }, (_, i) => Array.from({ length: 3 }, () => 20 + i * 2 + 0.4 * g4()));
    const ruim = Array.from({ length: 8 }, () => Array.from({ length: 3 }, () => 20 + 3 * g4()));
    const a = C.icc(bom), b = C.icc(ruim);
    assert(a.ok && b.ok, 'ICC não calculado');
    assert(a.icc21 > 0.9 && a.interpretation === 'excelente', 'confiável: ' + a.icc21);
    assert(b.icc21 < 0.5 && b.interpretation === 'ruim', 'não confiável: ' + b.icc21);
    assert(a.ci95[0] < a.icc21 && a.icc21 < a.ci95[1], 'IC não contém a estimativa');
    return `confiável ${a.icc21} [${a.ci95.join('; ')}] · ruído ${b.icc21} [${b.ci95.join('; ')}]`;
  });

  t('ICC com amostra pequena declara que não distingue nada', () => {
    const pequeno = Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, () => 20 + i * 2 + 1.5 * g4()));
    const r = C.icc(pequeno);
    assert(r.ok, 'não calculou');
    if (r.ciSpansCategories) assert(/NÃO distingue/.test(r.caveat), 'ressalva ausente: ' + r.caveat);
    const recusa = C.icc([[1, 2], [2, 3]]);
    assert(!recusa.ok && /ao menos 3 sujeitos/.test(recusa.reason), 'aceitou 2 sujeitos');
    return `n=3: IC [${r.ci95.join('; ')}]${r.ciSpansCategories ? ' — declarado indistinguível' : ''}`;
  });

  t('deriva de impedância é detectada e ligada ao efeito sobre a amplitude', () => {
    const a = parsed[0];
    const b = JSON.parse(JSON.stringify(a));
    b.fileName = 'segunda.json';
    b.meta.sessionStart = '2025-06-01T10:00:00Z';
    Object.keys(b.impedance).forEach(h => b.impedance[h].mono.forEach((e, i) => { e.ohm = e.ohm * (i === 0 ? 1.6 : 1.05); }));
    const r = C.impedanceDrift([a, b], { changePct: 25 });
    assert(r.ok, 'não avaliou: ' + r.reason);
    assert(r.nFlagged >= 1, 'não marcou o contato que mudou 60%');
    assert(/divisor de tensão/.test(r.interpretation), 'não explica por que importa');
    const so = C.impedanceDrift([a], {});
    assert(!so.ok, 'avaliou deriva com uma sessão só');
    return `${r.nContacts} contatos, ${r.nFlagged} marcado(s), mediana ${r.medianChangePct}%`;
  });

  t('confiabilidade longitudinal recusa com menos de 3 sujeitos e explica por quê', () => {
    const b = C.extractMetrics(parsed, -180, { profileId: 'pd' });
    const r = C.longitudinalReliability([b], {});
    assert(!r.ok, 'calculou ICC com um sujeito');
    assert(/variância ENTRE sujeitos/.test(r.reason), 'não explica o motivo estatístico: ' + r.reason);
    return r.reason.slice(0, 110);
  });
}

/* ------------- coorte, EDF, BIDS-like, pacote e CLI (Onda 6) -------------- */
sec('coorte, EDF, BIDS-like e linha de comando');
{
  const FSE = 250, NE = FSE * 10;
  const xa = new Float64Array(NE), xb = new Float64Array(NE);
  for (let i = 0; i < NE; i++) { xa[i] = 100 * Math.sin(2 * Math.PI * 20 * i / FSE); xb[i] = 50 * Math.sin(2 * Math.PI * 6 * i / FSE); }
  for (let i = 500; i < 650; i++) xa[i] = NaN;
  const edf = C.writeEdf([
    { label: 'STN L 0-2', data: xa, fs: FSE, unit: 'uV' },
    { label: 'STN R 0-2', data: xb, fs: FSE, unit: 'uV' }
  ], { startMs: Date.parse('2026-03-01T14:30:00Z'), patientId: 'sub-abc' });

  t('EDF: cabeçalho tem a estrutura e os deslocamentos do formato', () => {
    assert(edf, 'não gerou');
    const td = new TextDecoder('ascii');
    const h = td.decode(edf.bytes.slice(0, 256));
    assert(h.slice(0, 8) === '0       ', 'versão: ' + JSON.stringify(h.slice(0, 8)));
    assert(h.slice(168, 176) === '01.03.26', 'data: ' + h.slice(168, 176));
    assert(h.slice(176, 184) === '14.30.00', 'hora: ' + h.slice(176, 184));
    assert(h.slice(192, 197) === 'EDF+C', 'reservado: ' + JSON.stringify(h.slice(192, 197)));
    assert(parseInt(h.slice(184, 192), 10) === edf.meta.headerBytes, 'tamanho do cabeçalho declarado errado');
    assert(parseInt(h.slice(252, 256), 10) === 2, 'número de sinais');
    assert(edf.bytes.length === edf.meta.headerBytes + edf.meta.nRecords * 2 * FSE * 2, 'tamanho total inconsistente');
    /* o cabeçalho é ASCII puro: um byte fora disso desloca o arquivo inteiro */
    const cab = edf.bytes.slice(0, edf.meta.headerBytes);
    assert(cab.every(b => b >= 0x20 && b <= 0x7E), 'há byte não-ASCII no cabeçalho');
    return `${edf.meta.headerBytes} bytes de cabeçalho, ${edf.meta.nRecords} registros, ${edf.meta.totalBytes} bytes`;
  });

  t('EDF: o sinal reconstrói dentro do erro de quantização', () => {
    const dv = new DataView(edf.bytes.buffer);
    const cab = edf.meta.headerBytes, spr = FSE;
    const leia = (canal, amostra) => {
      const rec = Math.floor(amostra / spr), dentro = amostra % spr;
      return dv.getInt16(cab + (rec * spr * 2 + canal * spr + dentro) * 2, true);
    };
    const c0 = edf.meta.channels[0];
    const rec = d => c0.physicalMin + (d + 32768) * (c0.physicalMax - c0.physicalMin) / 65535;
    let pior = 0;
    for (let i = 0; i < NE; i++) if (isFinite(xa[i])) pior = Math.max(pior, Math.abs(rec(leia(0, i)) - xa[i]));
    const passo = (c0.physicalMax - c0.physicalMin) / 65535;
    assert(pior <= passo, `erro ${pior.toExponential(2)} maior que um passo de quantização ${passo.toExponential(2)}`);
    return `erro máximo ${pior.toExponential(2)} µV (passo de quantização ${passo.toExponential(2)})`;
  });

  t('EDF: lacuna vira mínimo digital, e nenhuma amostra válida colide com ele', () => {
    const dv = new DataView(edf.bytes.buffer);
    const cab = edf.meta.headerBytes, spr = FSE;
    const leia = (canal, amostra) => {
      const rec = Math.floor(amostra / spr), dentro = amostra % spr;
      return dv.getInt16(cab + (rec * spr * 2 + canal * spr + dentro) * 2, true);
    };
    [500, 575, 649].forEach(i => assert(leia(0, i) === -32768, `amostra ${i} da lacuna não foi marcada`));
    let colisoes = 0;
    for (let i = 0; i < NE; i++) if (isFinite(xa[i]) && leia(0, i) === -32768) colisoes++;
    assert(colisoes === 0, `${colisoes} amostras válidas colidiram com a marca de ausente`);
    assert(edf.meta.gaps.length === 1 && edf.meta.gaps[0].nSamples === 150, 'lacunas: ' + JSON.stringify(edf.meta.gaps));
    assert(/MÍNIMO DIGITAL/.test(edf.meta.missingSamplePolicy), 'a política não está declarada');
    return `lacuna de ${edf.meta.gaps[0].durationSec} s registrada; 0 colisões em ${NE} amostras`;
  });

  t('BIDS-like declara que NÃO é conforme e marca o que falta como n/a', () => {
    const b = C.buildBidsLike(parsed, { includeSignalTsv: false });
    assert(b && b.length, 'não gerou');
    const dd = JSON.parse(b.find(a => a.path === 'dataset_description.json').content);
    assert(/NÃO um dataset BIDS conforme/.test(dd.ConformanceNote), 'não declara a não conformidade');
    const part = b.find(a => a.path === 'participants.tsv').content.split('\n');
    assert(part[0].split('\t')[0] === 'participant_id', 'participants.tsv sem a coluna obrigatória');
    const ieeg = b.find(a => /ieeg\.json$/.test(a.path));
    assert(ieeg, 'sem sidecar ieeg.json');
    const j = JSON.parse(ieeg.content);
    assert(j.iEEGReference && /bipolar/.test(j.iEEGReference), 'referência não descrita');
    assert(/não constam do/.test(j.NonConformanceNote), 'o sidecar não diz o que falta');
    assert(/NaN/.test(j.MissingDataPolicy), 'a política de dado ausente não está no sidecar');
    return `${b.length} arquivos · ${b.filter(a => a.path.includes('/ieeg/')).length} por sessão`;
  });

  t('coorte: prevalência com IC de Wilson e acrofase tratada como circular', () => {
    const b = C.extractMetrics(parsed, -180, { profileId: 'pd' });
    const co = C.cohortSummary([b], {});
    assert(co, 'sem resumo');
    assert(co.descriptiveOnly, 'com 1 sujeito deveria ser marcado como descritivo');
    assert(/DESCRITIVO/.test(co.note), 'não avisa que é descritivo');
    const pv = co.prevalence.byHemisphere;
    assert(pv.ci95[0] >= 0 && pv.ci95[1] <= 1, 'IC fora de [0,1]: ' + JSON.stringify(pv.ci95));
    /* Wald daria [1,1] para 2/2; Wilson tem de ser largo */
    if (pv.k === pv.n && pv.n <= 3) assert(pv.ci95[0] < 0.6, 'IC otimista demais para n pequeno: ' + JSON.stringify(pv.ci95));
    const acro = co.stats.find(e => e.field === 'acrophase_24h');
    if (acro && acro.all) assert(acro.all.circular === true, 'acrofase não foi tratada como circular');
    return `${pv.k}/${pv.n} com pico · IC de Wilson [${(100 * pv.ci95[0]).toFixed(1)}; ${(100 * pv.ci95[1]).toFixed(1)}]%`;
  });

  t('IC de Wilson não escapa de [0,1] nem colapsa em proporção extrema', () => {
    [[0, 5], [5, 5], [1, 3], [50, 100]].forEach(([k, n]) => {
      const ci = C.wilsonCI(k, n);
      assert(ci[0] >= 0 && ci[1] <= 1 && ci[0] <= ci[1], `k=${k}, n=${n} → ${JSON.stringify(ci)}`);
      if (k === 0) assert(ci[0] === 0 && ci[1] > 0, 'k=0 deveria ter limite superior positivo');
      if (k === n) assert(ci[1] === 1 && ci[0] < 1, 'k=n deveria ter limite inferior menor que 1');
    });
    return '0/5, 5/5, 1/3 e 50/100 todos dentro de [0,1] e sem colapso';
  });

  await ta('a CLI processa uma pasta e escreve métricas, EDF, BIDS e coorte', async () => {
    const { execFileSync } = await import('child_process');
    const os = await import('os');
    const destino = fs.mkdtempSync(path.join(os.tmpdir(), 'pls-cli-'));
    execFileSync(process.execPath, [path.join(RAIZ, 'tools/cli.mjs'), PASTA, '--out', destino, '--quiet'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const achados = [];
    (function varre(dir) {
      fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
        const q = path.join(dir, e.name);
        if (e.isDirectory()) varre(q); else achados.push(path.relative(destino, q));
      });
    })(destino);
    ['execucao.json', 'coorte/coorte.json'].forEach(f => assert(achados.includes(f), 'faltou ' + f));
    assert(achados.some(f => /metricas_agudas\.csv$/.test(f)), 'sem CSV de métricas agudas');
    assert(achados.some(f => /\.edf$/.test(f)), 'sem EDF');
    assert(achados.some(f => /^bids\/dataset_description\.json$/.test(f)), 'sem estrutura BIDS');
    const exec = JSON.parse(fs.readFileSync(path.join(destino, 'execucao.json'), 'utf8'));
    assert(exec.nParsed >= 1 && exec.nSubjects >= 1, 'execucao.json sem contagens');
    assert(/figuras não são geradas/.test(exec.note), 'a CLI não declara o que não faz');
    fs.rmSync(destino, { recursive: true, force: true });
    return `${achados.length} arquivos escritos · ${exec.nParsed} lido(s), ${exec.nSubjects} sujeito(s), ${exec.edfWritten} EDF`;
  });
}

/* -------- navegação por abas: a hierarquia agudo/crônico (Onda 11) -------- */
sec('abas — hierarquia agudo/crônico e triagem por pergunta');
{
  t('toda figura mora em exatamente uma aba, e toda aba só cita figura que existe', () => {
    const idsFig = new Set(H.FIGURES.map(f => f.id));
    const vistas = new Map();
    const inexistentes = [];
    H.ABAS.forEach(a => (a.figuras || []).forEach(id => {
      if (!idsFig.has(id)) inexistentes.push(`${a.id}:${id}`);
      vistas.set(id, (vistas.get(id) || []).concat(a.id));
    }));
    assert(!inexistentes.length, 'aba cita figura inexistente: ' + inexistentes.join(', '));
    const duplicadas = Array.from(vistas.entries()).filter(([, abas]) => abas.length > 1);
    assert(!duplicadas.length, 'figura em mais de uma aba: ' + duplicadas.map(([f, a]) => `${f}->${a.join('+')}`).join(', '));
    const orfas = H.FIGURES.map(f => f.id).filter(id => !vistas.has(id));
    assert(!orfas.length, 'figura sem aba — ficaria inalcançável: ' + orfas.join(', '));
    return `${H.FIGURES.length} figuras em ${H.ABAS.filter(a => a.figuras).length} abas, sem duplicata e sem órfã`;
  });

  t('cada aba declara a camada de inferência e a fronteira que não deve ser cruzada', () => {
    const semOrientacao = H.ABAS.filter(a => !a.orient || !a.orient.titulo || !(a.orient.texto || []).length);
    assert(!semOrientacao.length, 'aba sem cabeçalho de orientação: ' + semOrientacao.map(a => a.id).join(', '));
    const semLimite = H.ABAS.filter(a => a.figuras && !(a.orient && a.orient.limite));
    assert(!semLimite.length, 'aba de figuras sem declaração de fronteira: ' + semLimite.map(a => a.id).join(', '));
    const agudo = H.ABAS.find(a => a.id === 'agudo');
    const cronico = H.ABAS.find(a => a.id === 'cronico');
    assert(agudo.camada === 'agudo' && cronico.camada === 'cronico', 'camadas não declaradas');
    assert(/Crônico/i.test(agudo.orient.limite), 'a aba Agudo não aponta para onde a pergunta de dias mora');
    assert(/configuração/i.test(cronico.orient.limite), 'a aba Crônico não avisa do confundidor de configuração');
    return H.ABAS.map(a => a.id).join(' · ');
  });

  t('a triagem só oferece pergunta que este arquivo responde, e explica as demais', () => {
    const d = H.ds();
    const semAlvo = H.PERGUNTAS.filter(p => !H.FIGURES.some(f => f.id === p.fig));
    assert(!semAlvo.length, 'pergunta aponta para figura inexistente: ' + semAlvo.map(p => p.id).join(', '));
    const abaRuim = H.PERGUNTAS.filter(p => !H.ABAS.some(a => a.id === p.aba));
    assert(!abaRuim.length, 'pergunta aponta para aba inexistente: ' + abaRuim.map(p => p.id).join(', '));
    const desencontro = H.PERGUNTAS.filter(p => {
      const a = H.ABAS.find(x => x.id === p.aba);
      return a && a.figuras && !a.figuras.includes(p.fig);
    });
    assert(!desencontro.length, 'pergunta leva a aba que não contém a figura: ' +
      desencontro.map(p => `${p.id}->${p.aba}/${p.fig}`).join(', '));
    const semMotivo = H.PERGUNTAS.filter(p => !p.tem(d) && !p.falta);
    assert(!semMotivo.length, 'pergunta indisponível sem motivo: ' + semMotivo.map(p => p.id).join(', '));
    const disp = H.PERGUNTAS.filter(p => p.tem(d)).length;
    const personas = new Set(H.PERGUNTAS.map(p => p.persona));
    assert(personas.has('clinico') && personas.has('pesquisa'), 'a triagem não cobre as duas personas');
    return `${disp}/${H.PERGUNTAS.length} perguntas respondíveis · personas: ${Array.from(personas).join(', ')}`;
  });

  t('o recorte por aba compõe com o recorte por modo, sem esconder incerteza', () => {
    const d = H.ds();
    const antes = H.S.mode;
    H.S.mode = 'pesquisa';
    const nPesquisa = H.ABAS.filter(a => a.figuras).reduce((n, a) => n + H.figurasDaAba(a, d).length, 0);
    H.S.mode = 'clinico';
    const nClinico = H.ABAS.filter(a => a.figuras).reduce((n, a) => n + H.figurasDaAba(a, d).length, 0);
    H.S.mode = antes;
    assert(nPesquisa === H.FIGURES.length,
      `modo pesquisa deveria alcançar as ${H.FIGURES.length} figuras pelas abas, alcança ${nPesquisa}`);
    assert(nClinico > 0 && nClinico < nPesquisa, 'o modo clínico não está recortando');
    /* o painel de QC é requisito clínico, não item de pesquisa: um clínico que
       não vê o alarme de artefato interpreta canal contaminado */
    C.PROFILE_IDS.forEach(id => {
      assert(C.PROFILES[id].clinicalFigures.includes('F17'),
        `perfil ${id} não mostra o painel de qualidade no modo clínico`);
    });
    return `pesquisa alcança ${nPesquisa} figuras · clínico ${nClinico} · F17 obrigatória em todos os perfis`;
  });
}

/* ------- tempo-frequência no padrão do BRAVO (Onda 10) -------------------- */
sec('espectrogramas — FFT arbitrária, escala do scipy e emulação de bordo');
{
  const FS = 250;
  const semente = (s0) => { let s = s0 >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };
  const ruidoBranco = (n, sigma, s0) => {
    const r = semente(s0), x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = sigma * Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
    return x;
  };
  const senoide = (n, fs, f0, A) => { const x = new Float64Array(n); for (let i = 0; i < n; i++) x[i] = A * Math.sin(2 * Math.PI * f0 * i / fs); return x; };

  t('Bluestein bate com a DEFINIÇÃO da DFT em N não potência de dois', () => {
    /* contra a definição, não contra outra FFT: uma implementação rápida errada
       e um teste escrito a partir dela concordariam entre si */
    let pior = 0;
    for (const N of [3, 7, 61, 250, 500]) {
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < N; i++) { re[i] = Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1); im[i] = 0.1 * Math.sin(i * 1.3); }
      const ref = C.dftDireta(re, im);
      const a = Float64Array.from(re), b = Float64Array.from(im);
      C.fftBluestein(a, b, false);
      let err = 0, esc = 0;
      for (let k = 0; k < N; k++) { err = Math.max(err, Math.hypot(a[k] - ref.re[k], b[k] - ref.im[k])); esc = Math.max(esc, Math.hypot(ref.re[k], ref.im[k])); }
      pior = Math.max(pior, err / esc);
    }
    assert(pior < 1e-11, 'erro relativo ' + pior.toExponential(2));
    return `N ∈ {3,7,61,250,500} · erro relativo máx ${pior.toExponential(1)}`;
  });

  t('Bluestein concorda com a radix-2 quando N é potência de dois, e a inversa desfaz', () => {
    const N = 512, re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = Math.sin(i * 0.31) + Math.cos(i * 0.077);
    const a = Float64Array.from(re), b = Float64Array.from(im); C.fft(a, b, false);
    const c = Float64Array.from(re), d2 = Float64Array.from(im); C.fftBluestein(c, d2, false);
    let e1 = 0, esc = 0;
    for (let k = 0; k < N; k++) { e1 = Math.max(e1, Math.hypot(c[k] - a[k], d2[k] - b[k])); esc = Math.max(esc, Math.hypot(a[k], b[k])); }
    assert(e1 / esc < 1e-11, 'divergiu da radix-2: ' + (e1 / esc).toExponential(2));
    /* ida e volta em N ímpar */
    const M = 375, p = new Float64Array(M), q = new Float64Array(M);
    for (let i = 0; i < M; i++) p[i] = Math.cos(i * 0.19);
    const p0 = Float64Array.from(p);
    C.fftBluestein(p, q, false); C.fftBluestein(p, q, true);
    let e2 = 0; for (let i = 0; i < M; i++) e2 = Math.max(e2, Math.abs(p[i] - p0[i]));
    assert(e2 < 1e-10, 'ida e volta não fecha: ' + e2.toExponential(2));
    return `radix-2: ${(e1 / esc).toExponential(1)} · ida-e-volta N=375: ${e2.toExponential(1)}`;
  });

  t('a escala de densidade obedece Parseval: a integral da PSD é a potência do sinal', () => {
    /* É o teste que amarra a convenção do scipy inteira de uma vez: |X|²/(fs·Σw²)
       com ×2 unilateral. Senóide de amplitude A tem potência A²/2, exatamente. */
    const A = 3, F0 = 20;
    const x = senoide(FS * 20, FS, F0, A);
    const saidas = [];
    ['welch', 'stft'].forEach(met => {
      const sp = C.timeFrequency(x, FS, { method: met, windowS: 1, overlapS: 0.5, freqRes: 0.5 });
      assert(sp.ok, met + ': ' + sp.reason);
      assert(sp.params.nfft === 500, `${met}: NFFT deveria ser round(250/0.5)=500, veio ${sp.params.nfft}`);
      const df = sp.freqs[1] - sp.freqs[0];
      const col = sp.power[Math.floor(sp.power.length / 2)];
      let integral = 0; for (let k = 0; k < col.length; k++) integral += col[k] * df;
      assert(Math.abs(integral - A * A / 2) < 0.02, `${met}: integral ${integral.toFixed(4)} ≠ A²/2 = ${(A * A / 2).toFixed(4)}`);
      let bi = 0; for (let k = 0; k < col.length; k++) if (col[k] > col[bi]) bi = k;
      assert(Math.abs(sp.freqs[bi] - F0) < 1e-9, `${met}: pico em ${sp.freqs[bi]} Hz, esperado ${F0}`);
      saidas.push(`${met} ∫PSD=${integral.toFixed(4)}`);
    });
    return `A²/2 = ${(A * A / 2).toFixed(2)} · ${saidas.join(' · ')} · pico exatamente em 20 Hz`;
  });

  t('ruído branco devolve PSD plana em σ²/(fs/2), nos três métodos paramétricos', () => {
    const sigma = 2, x = ruidoBranco(FS * 60, sigma, 12345);
    const esperado = sigma * sigma / (FS / 2);
    const linhas = [];
    ['welch', 'stft', 'ar'].forEach(met => {
      const sp = C.timeFrequency(x, FS, { method: met, windowS: 1, overlapS: 0.5, freqRes: 0.5 });
      assert(sp.ok, met + ': ' + sp.reason);
      let acc = 0, m = 0;
      for (let i = 0; i < sp.power.length; i++) for (let k = 5; k < sp.freqs.length - 5; k++) { const v = sp.power[i][k]; if (isFinite(v)) { acc += v; m++; } }
      const razao = acc / m / esperado;
      assert(Math.abs(razao - 1) < 0.05, `${met}: PSD média ${(acc / m).toExponential(3)} vs esperado ${esperado.toExponential(3)} (razão ${razao.toFixed(3)})`);
      linhas.push(`${met} ${razao.toFixed(3)}×`);
    });
    return `σ²/(fs/2) = ${esperado.toFixed(4)} · razões: ${linhas.join(' · ')}`;
  });

  t('janela periódica e simétrica são diferentes — e cada método usa a sua', () => {
    const n = 8;
    const hp = C.hannPeriodic(n), hs = C.hannSymmetric(n), mp = C.hammingPeriodic(n);
    assert(hp[0] === 0 && hs[0] === 0, 'Hann deveria começar em zero');
    assert(hs[n - 1] === 0, 'Hann simétrica deveria terminar em zero');
    assert(hp[n - 1] > 0.1, 'Hann periódica não deveria terminar em zero (é a diferença toda)');
    assert(Math.abs(hp[n / 2] - 1) < 1e-12, 'Hann periódica deveria valer 1 no meio');
    assert(Math.abs(mp[0] - 0.08) < 1e-12, 'Hamming periódica deveria começar em 0,08: ' + mp[0]);
    /* e o método certo usa a janela certa */
    const x = senoide(FS * 5, FS, 20, 1);
    assert(C.spectrogramWelch(x, FS, {}).params.window === 'hann-periodic', 'Welch não usou Hann periódica');
    assert(C.spectrogramSTFT(x, FS, {}).params.window === 'hamming-periodic', 'STFT não usou Hamming periódica');
    assert(C.spectrogramPercept(x, FS, {}).params.window === 'hann-symmetric', 'a emulação Medtronic não usou Hann simétrica');
    return `Hann periódica termina em ${hp[n - 1].toFixed(3)}, simétrica em ${hs[n - 1].toFixed(3)} · Hamming[0] = ${mp[0]}`;
  });

  t('emulação do Percept reproduz a aritmética de bordo declarada', () => {
    const x = senoide(FS * 6, FS, 20, 2);
    const sp = C.spectrogramPercept(x, FS, {});
    assert(sp.ok, sp.reason);
    const p = sp.params;
    assert(p.nperseg === 250 && p.nfft === 256, `janela/NFFT: ${p.nperseg}/${p.nfft}`);
    assert(Math.abs(p.gain - 1 / 54) < 1e-12, 'ganho não é 1/54: ' + p.gain);
    assert(p.packetSamples === 5, 'passo de pacote: ' + p.packetSamples);
    assert(sp.freqs.length === 100, 'deveria devolver 100 bins, veio ' + sp.freqs.length);
    assert(Math.abs(sp.freqs[1] - FS / 256) < 1e-12, 'eixo não é k·fs/256');
    assert(p.scaling === 'magnitude', 'a escala deveria ser magnitude, não potência: ' + p.scaling);
    assert(Math.abs(sp.times[1] - sp.times[0] - 5 / FS) < 1e-12, 'o passo temporal não é de 5 amostras');
    /* o pico cai no bin do aparelho, que é grosseiro: 20 Hz → bin 20 → 19,53 Hz */
    let bi = 0; const col = sp.power[10];
    for (let k = 1; k < col.length; k++) if (col[k] > col[bi]) bi = k;
    assert(bi === 20, 'pico no bin ' + bi + ', esperado 20');
    /* a magnitude escala LINEARMENTE com a amplitude — se estivesse ao quadrado, dobraria ao quadrado */
    const sp2 = C.spectrogramPercept(senoide(FS * 6, FS, 20, 4), FS, {});
    const razao = sp2.power[10][20] / col[20];
    assert(Math.abs(razao - 2) < 0.02, 'dobrar a amplitude deveria dobrar a magnitude, e deu ' + razao.toFixed(3));
    return `bin ${bi} = ${sp.freqs[bi].toFixed(2)} Hz · passo ${p.stepS}s · ganho 1/54 · dobrar A dobra |FFT| (${razao.toFixed(3)}×)`;
  });

  t('época com perda de pacote NÃO vira potência: sai NaN e marcada', () => {
    const x = senoide(FS * 10, FS, 20, 2);
    for (let i = FS * 3; i < FS * 3 + 40; i++) x[i] = NaN;      // lacuna de 160 ms
    ['welch', 'stft', 'ar', 'percept'].forEach(met => {
      const sp = C.timeFrequency(x, FS, { method: met, windowS: 1, overlapS: 0.5 });
      assert(sp.ok, met + ': ' + sp.reason);
      const marcadas = Array.from(sp.flagged).filter(Boolean).length;
      assert(marcadas > 0, met + ': a lacuna não foi marcada');
      sp.flagged.forEach((fl, i) => {
        if (!fl) return;
        assert(Array.from(sp.power[i]).every(v => !isFinite(v)), met + ': época marcada saiu com potência numérica');
      });
      assert(sp.nEpochsValid < sp.nEpochs, met + ': a contabilidade de épocas não fecha');
      /* e a fração faltante é reportada, não só o sinalizador */
      const comFalta = Array.from(sp.missing).filter(v => v > 0).length;
      assert(comFalta >= marcadas, met + ': fração faltante não reportada');
    });
    const sp = C.timeFrequency(x, FS, { method: 'welch', windowS: 1, overlapS: 0.5 });
    return `${sp.nEpochs - sp.nEpochsValid} de ${sp.nEpochs} épocas descartadas (${sp.pctEpochsFlagged}%) nos quatro métodos`;
  });

  t('normalização por linha de base e remoção de 1/f fazem o que dizem', () => {
    /* sinal com 1/f conhecido: ruído filtrado por integração dá inclinação ~2 */
    const n = FS * 40, br = ruidoBranco(n, 1, 777), x = new Float64Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) { acc = 0.98 * acc + br[i]; x[i] = acc; }
    const sp = C.timeFrequency(x, FS, { method: 'welch', windowS: 1, overlapS: 0.5, detrendAperiodic: true, fitLo: 5, fitHi: 60 });
    assert(sp.ok && sp.aperiodic, 'não ajustou o fundo aperiódico');
    assert(sp.aperiodic.exponent > 1 && sp.aperiodic.exponent < 3.2, 'expoente 1/f fora do plausível: ' + sp.aperiodic.exponent);
    assert(sp.aperiodic.r2 > 0.9, 'R² do ajuste baixo: ' + sp.aperiodic.r2);
    assert(/não é FOOOF/.test(sp.aperiodic.method) && /FOOOF completo/.test(sp.caveat),
      'não declara que o ajuste NÃO é o FOOOF: ' + sp.aperiodic.method);
    /* depois de dividir pelo fundo, a média por frequência fica perto de 1 */
    const nF = sp.freqs.length;
    let soma = 0, m = 0;
    for (let k = 10; k < nF - 10; k++) { const v = C.median(sp.power.map(c => c[k]).filter(isFinite)); if (isFinite(v)) { soma += v; m++; } }
    assert(Math.abs(soma / m - 1) < 0.6, 'a divisão pelo fundo não achatou o espectro: média ' + (soma / m).toFixed(2));

    /* normalização por divisão: a janela de referência vira ~1 */
    const sp2 = C.timeFrequency(x, FS, { method: 'welch', windowS: 1, overlapS: 0.5, normalize: true, mode: 'divide', baseline: [0, 5] });
    assert(sp2.normalization && sp2.normalization.mode === 'divide', 'normalização não declarada');
    const iRef = sp2.times.findIndex(t2 => t2 >= 0 && t2 <= 5);
    const medRef = C.median(Array.from(sp2.power[iRef]).filter(isFinite));
    assert(Math.abs(medRef - 1) < 0.8, 'a janela de referência não ficou perto de 1: ' + medRef.toFixed(2));
    return `expoente 1/f = ${sp.aperiodic.exponent.toFixed(2)} (R² ${sp.aperiodic.r2.toFixed(3)}) · referência normalizada ≈ ${medRef.toFixed(2)}`;
  });

  t('Levinson-Durbin resolve Yule-Walker e o BIC escolhe ordem parcimoniosa', () => {
    /* AR(2) conhecido: x[n] = 1.4·x[n-1] − 0.8·x[n-2] + e[n], pico ressonante */
    const n = FS * 30, e = ruidoBranco(n, 1, 999), x = new Float64Array(n);
    for (let i = 2; i < n; i++) x[i] = 1.4 * x[i - 1] - 0.8 * x[i - 2] + e[i];
    const sp = C.spectrogramAR(x, FS, { windowS: 2, overlapS: 1, maxOrder: 30 });
    assert(sp.ok, sp.reason);
    assert(sp.params.medianOrder >= 2 && sp.params.medianOrder <= 12,
      'ordem mediana ' + sp.params.medianOrder + ' — o BIC deveria ficar perto de 2, não estourar');
    /* o pico do AR tem de cair na ressonância teórica do sistema */
    const r = Math.sqrt(0.8), teta = Math.acos(1.4 / (2 * r));
    const fTeo = teta * FS / (2 * Math.PI);
    const col = sp.power[Math.floor(sp.power.length / 2)];
    let bi = 1; for (let k = 1; k < col.length; k++) if (col[k] > col[bi]) bi = k;
    assert(Math.abs(sp.freqs[bi] - fTeo) < 2, `pico do AR em ${sp.freqs[bi].toFixed(2)} Hz, ressonância teórica ${fTeo.toFixed(2)} Hz`);
    assert(/IMPOSTO pelo modelo/.test(sp.caveat), 'não avisa que a forma do espectro vem do modelo');
    /* Levinson devolve variância residual decrescente com a ordem */
    const lev = C.levinsonDurbin(Float64Array.from([1, 0.5, 0.2, 0.05]), 3);
    for (let p = 1; p <= 3; p++) assert(lev.varResidual[p] <= lev.varResidual[p - 1] + 1e-12, 'variância residual subiu com a ordem');
    return `ordem mediana ${sp.params.medianOrder} (BIC) · pico ${sp.freqs[bi].toFixed(2)} Hz vs teórico ${fTeo.toFixed(2)} Hz`;
  });

  t('a matriz para desenho recorta em fMax e converte em dB sem perder NaN', () => {
    const x = senoide(FS * 8, FS, 20, 2);
    for (let i = FS * 2; i < FS * 2 + 30; i++) x[i] = NaN;
    const sp = C.timeFrequency(x, FS, { method: 'welch', windowS: 1, overlapS: 0.5 });
    const tm = C.tfMatrix(sp, { fMax: 60, dB: true });
    assert(tm.freqs[tm.freqs.length - 1] <= 60, 'não recortou em fMax');
    assert(tm.matrix.length === tm.freqs.length, 'matriz e eixo de frequência com tamanhos diferentes');
    assert(tm.matrix[0].length === sp.times.length, 'largura da matriz ≠ número de épocas');
    const iMarc = Array.from(sp.flagged).indexOf(1);
    assert(iMarc >= 0 && !isFinite(tm.matrix[10][iMarc]), 'época descartada virou número na matriz de desenho');
    /* dB = 10·log10(potência), como no frontend do BRAVO */
    const iBom = Array.from(sp.flagged).indexOf(0);
    const k = 40;
    assert(Math.abs(tm.matrix[k][iBom] - 10 * Math.log10(sp.power[iBom][k])) < 1e-9, 'a conversão em dB não é 10·log10');
    return `${tm.freqs.length} bins até ${tm.freqs[tm.freqs.length - 1]} Hz · NaN preservado · dB = 10·log10(P)`;
  });

  await ta('o espectrograma roda no trabalhador e o CSV exportado se explica sozinho', async () => {
    const td = parsed.map(p => p.bsTimeDomain.concat(p.montageTD)).find(a => a.length)[0];
    const out = await H.Trabalhador.chamar('timeFrequency', [td.data, td.fs, { method: 'welch', windowS: 1, overlapS: 0.5, freqRes: 0.5 }]);
    assert(out.r && out.r.ok, 'o trabalhador não devolveu espectrograma');
    const tm = C.tfMatrix(out.r, { fMax: 60, dB: true });
    const csv = H.csvEspectrograma(out.r, tm, td, true);
    const linhas = csv.split('\n');
    const cab = linhas.find(l => !l.startsWith('#'));
    assert(cab === 'Time_s,Frequency_Hz,Power,logPower_dB,Channel,Missing', 'cabeçalho em inglês mudou: ' + cab);
    /* o bloco de metadados tem de permitir refazer o cálculo */
    const meta = linhas.filter(l => l.startsWith('#')).join(' ');
    ['method=', 'window_samples=', 'nfft=', 'scaling=', 'fs_hz=', 'freq_resolution_hz=', 'epochs_flagged_missing='].forEach(k => {
      assert(meta.includes(k), 'metadado ausente no CSV: ' + k);
    });
    assert(/NOT A MEDICAL DEVICE/.test(meta), 'o CSV não carrega o aviso de uso');
    assert(!/PatientFirstName|PatientLastName|SerialNumber/i.test(csv), 'identificador vazou para a exportação');
    return `${out.ondeRodou} · ${out.ms} ms · ${linhas.length - 1} linhas · cabeçalho em inglês`;
  });
}

/* ------ heatmap: orientação, unidade do detrending e escala de cor -------- */
sec('heatmap dia × hora — orientação, unidade e escala de cor');
{
  /* A armadilha: `drawImage` põe a linha 0 da imagem no TOPO, mas o eixo Y
     cresce para CIMA. Sem tratamento a matriz sai espelhada em relação aos
     rótulos, e o leitor atribui o padrão de um dia à data errada. Este teste
     amarra a convenção nas duas direções. */
  t('heat respeita a origem declarada, nos dois sentidos', () => {
    const cv = document.createElement('canvas');
    const registradas = [];
    const ctxOrig = cv.getContext('2d');
    /* intercepta a tela auxiliar onde o heat pinta a imagem */
    const criarOrig = document.createElement;
    document.createElement = tag => {
      const n = criarOrig.call(document, tag);
      if (tag === 'canvas') {
        const g = n.getContext('2d');
        const put = g.putImageData.bind(g);
        g.putImageData = (img, x, y) => { registradas.push(img); return put(img, x, y); };
      }
      return n;
    };
    const M = [[9, 9], [0, 0], [0, 0]];              // linha 0 = valor alto
    const lerLinha = (img, cols, r) => img.data[(r * cols) * 4];   // canal R
    try {
      const ch = new P.Chart(cv, { width: 200, height: 120, xlim: [0, 2], ylim: [0, 3] });
      registradas.length = 0;
      ch.heat(M, { cmap: 'viridis', zmin: 0, zmax: 9 });
      const imgBase = registradas[registradas.length - 1];
      registradas.length = 0;
      ch.heat(M, { cmap: 'viridis', zmin: 0, zmax: 9, origin: 'top' });
      const imgTopo = registradas[registradas.length - 1];
      /* viridis: t=1 → (253,231,37) canal R alto; t=0 → (68,1,84) canal R baixo */
      assert(lerLinha(imgBase, 2, 2) > 200, 'origin padrão: a linha 0 não foi para a última linha da imagem (base do gráfico)');
      assert(lerLinha(imgBase, 2, 0) < 100, 'origin padrão: linha 0 vazou para o topo');
      assert(lerLinha(imgTopo, 2, 0) > 200, "origin 'top': a linha 0 não ficou no topo");
      assert(lerLinha(imgTopo, 2, 2) < 100, "origin 'top': linha 0 vazou para a base");
      return "padrão = linha 0 na base (eixo ascendente); origin:'top' = linha 0 no topo";
    } finally { document.createElement = criarOrig; void ctxOrig; }
  });

  t('unidade do detrending muda a escala, não o padrão', () => {
    const linhas = [];
    const t0 = Date.UTC(2025, 0, 1, 0, 0, 0);
    for (let k = 0; k < 3 * 144; k++) {
      const tt = t0 + k * 6e5, hora = (tt / 36e5) % 24;
      linhas.push({ t: tt, lfp: 40 * (1 + 0.3 * Math.cos(2 * Math.PI * (hora - 9) / 24)) });
    }
    const pct = C.diurnalProfile(linhas, 0, 30, { detrend: true, unit: 'percent' });
    const raz = C.diurnalProfile(linhas, 0, 30, { detrend: true, unit: 'ratio' });
    const antigo = C.diurnalProfile(linhas, 0, 30, true);         // forma booleana
    assert(pct.unit === 'percent' && raz.unit === 'ratio', 'unidade não declarada no resultado');
    assert(antigo.unit === 'percent', 'a forma booleana antiga mudou de unidade');
    for (let i = 0; i < pct.profile.length; i++) {
      if (!isFinite(pct.profile[i])) continue;
      assert(Math.abs(pct.profile[i] - 100 * raz.profile[i]) < 1e-9, 'as duas escalas não são o mesmo número');
      assert(Math.abs(pct.profile[i] - antigo.profile[i]) < 1e-12, 'a forma booleana divergiu de percent');
    }
    /* o pico está no mesmo bin nas duas escalas */
    const arg = a => a.reduce((b, v, i) => (isFinite(v) && v > a[b] ? i : b), 0);
    assert(arg(pct.profile) === arg(raz.profile), 'a escala deslocou o horário do pico');
    return `pico às ${pct.hours[arg(pct.profile)]} h nas duas · ${pct.profile[arg(pct.profile)].toFixed(1)}% = ${raz.profile[arg(raz.profile)].toFixed(3)}×`;
  });

  t('a escala preto→azul existe e vai de preto a azul', () => {
    const cm = P.CMAPS.pretoazul;
    assert(cm, 'colormap pretoazul não registrado');
    const rgb = t => cm(t).match(/\d+/g).map(Number);
    const ini = rgb(0), fim = rgb(1);
    assert(ini[0] < 12 && ini[1] < 12 && ini[2] < 12, 'não começa em preto: ' + ini);
    assert(fim[2] > 200 && fim[2] > fim[0] + 80, 'não termina em azul: ' + fim);
    /* monotônica no azul — uma escala sequencial não pode voltar atrás */
    let ant = -1;
    for (let i = 0; i <= 20; i++) { const b = rgb(i / 20)[2]; assert(b >= ant - 1, 'o azul não é monotônico'); ant = b; }
    return `${ini.join(',')} → ${fim.join(',')} · monotônica`;
  });

  t('a barra de cor marca a mediana do dia quando pedida', () => {
    const cv = document.createElement('canvas');
    const escritos = [];
    const ch = new P.Chart(cv, { width: 220, height: 140, xlim: [0, 2], ylim: [0, 2] });
    const g = cv.getContext('2d');
    const orig = g.fillText.bind(g);
    g.fillText = (s, x, y) => { escritos.push(String(s)); return orig(s, x, y); };
    ch.heat([[0.6, 1.4], [1.0, 1.9]], { cmap: 'pretoazul', zmin: 0.6, zmax: 1.9 });
    ch.colorbar({ label: '× a mediana do dia', ticks: [0.6, 1, 1.9], fmt: v => v.toFixed(2) });
    g.fillText = orig;
    assert(escritos.includes('1.00'), 'a marca da mediana (1,00) não foi escrita: ' + escritos.join('|'));
    assert(escritos.some(x => /mediana do dia/.test(x)), 'o rótulo da barra não saiu');
    return escritos.filter(x => /^\d/.test(x)).join(' · ');
  });
}

/* ---- diário de Hauser, matriz hora × dia e resposta à levodopa (Onda 9) --- */
sec('diário de Hauser, matriz hora × dia e resposta à levodopa');
{
  /* diário sintético com estrutura CONHECIDA: OFF matinal antes da primeira
     dose (06:00–08:00), OFF vespertino de wearing-off (17:00–18:30), sono das
     23h às 6h30, ON o resto do dia — 7 dias, bins de 30 min */
  const ESTADOS = (dia, h) => {
    if (h >= 23 || h < 6.5) return 'Asleep';
    if (h < 8) return 'Off';
    if (h >= 17 && h < 18.5) return 'Off';
    if (h >= 13 && h < 14 && dia % 2 === 0) return 'On_TroublesomeDysk';
    return 'On_NoDysk';
  };
  const linhasCsv = ['patient_id,condition,day,bin_index,time,hour_decimal,state'];
  for (let dia = 1; dia <= 7; dia++) for (let b = 0; b < 48; b++) {
    const h = b * 0.5;
    const hh = `${String(Math.floor(h)).padStart(2, '0')}:${h % 1 ? '30' : '00'}`;
    linhasCsv.push(`P01,Baseline,${dia},${b},${hh},${h},${ESTADOS(dia, h)}`);
  }
  const csv = linhasCsv.join('\n');

  t('lê o diário no esquema de colunas do arquivo de referência', () => {
    const r = C.parseDiaryCsv(csv);
    assert(r.ok, 'não leu: ' + r.reason);
    assert(r.binMin === 30, 'bin inferido errado: ' + r.binMin);
    assert(r.nRows === 7 * 48, 'linhas: ' + r.nRows);
    assert(r.conditions.length === 1 && r.conditions[0] === 'Baseline', 'condições: ' + r.conditions);
    return `${r.nRows} bins de ${r.binMin} min · delimitador "${r.delimiter}"`;
  });

  t('estado não reconhecido é CONTADO, não descartado em silêncio', () => {
    const sujo = csv.replace('On_NoDysk', 'BANANA');
    const r = C.parseDiaryCsv(sujo);
    assert(r.ok, 'recusou o arquivo inteiro por uma linha ruim');
    assert(r.nMalformed === 1, 'não contou a linha ruim: ' + r.nMalformed);
    assert(r.unknownStates.some(u => u.value === 'BANANA'), 'não declarou o valor desconhecido');
    assert(/descartada/.test(r.note), 'a nota não menciona o descarte');
    /* e aceita sinônimos de outra planilha */
    const alt = C.parseDiaryCsv(csv.replace(/On_NoDysk/g, 'ON').replace(/Asleep/g, 'sono'));
    assert(alt.ok && alt.rows.some(x => x.state === 'On_NoDysk') && alt.rows.some(x => x.state === 'Asleep'), 'não aceitou sinônimos');
    return `1 linha contada como inválida · sinônimos "ON"/"sono" reconhecidos`;
  });

  t('célula sem registro fica vazia — nunca preenchida pelo vizinho', () => {
    const faltando = linhasCsv.filter((_, i) => i === 0 || i % 7 !== 0).join('\n');
    const r = C.parseDiaryCsv(faltando);
    const g = C.diaryGrid(r.rows, { binMin: 30 });
    assert(g.ok, g.reason);
    assert(g.nMissing > 0, 'não sobrou buraco para testar');
    const vazias = g.cells.flat().filter(v => v === null).length;
    assert(vazias === g.nMissing, `contabilidade não fecha: ${vazias} nulos vs ${g.nMissing} declarados`);
    return `${g.nMissing} de ${g.nCells} células vazias (${g.pctMissing}%), todas declaradas`;
  });

  t('composição diária recupera as horas construídas', () => {
    const r = C.parseDiaryCsv(csv);
    const g = C.diaryGrid(r.rows, { binMin: 30 });
    const c24 = C.dailyComposition(g, { awakeOnly: false });
    assert(Math.abs(c24.meanTotal - 24) < 1e-6, 'o dia de 24 h não soma 24: ' + c24.meanTotal);
    /* OFF construído: 06:30–08:00 (1,5 h) + 17:00–18:30 (1,5 h) = 3 h */
    assert(Math.abs(c24.byState.Off.mean - 3) < 1e-6, 'OFF de 24 h: ' + c24.byState.Off.mean);
    assert(Math.abs(c24.byState.Asleep.mean - 7.5) < 1e-6, 'sono: ' + c24.byState.Asleep.mean);
    const cv = C.dailyComposition(g, { awakeOnly: true });
    assert(Math.abs(cv.meanTotal - 16.5) < 1e-6, 'vigília: ' + cv.meanTotal);
    assert(Math.abs(cv.byState.Off.mean - 3) < 1e-6, 'o OFF muda entre recortes');
    assert(cv.byState.Asleep === undefined, 'o sono entrou no recorte de vigília');
    return `24 h: 3,0 h OFF + 7,5 h sono · vigília: 16,5 h de total, 3,0 h OFF`;
  });

  t('dia incompleto não entra na média — e a exclusão é declarada', () => {
    const cortado = linhasCsv.filter((l, i) => i === 0 || !/^P01,Baseline,3,(3[0-9]|4[0-7]),/.test(l)).join('\n');
    const r = C.parseDiaryCsv(cortado);
    const g = C.diaryGrid(r.rows, { binMin: 30 });
    const c = C.dailyComposition(g, { awakeOnly: false, minCoverage: 0.9 });
    assert(c.nDaysExcluded === 1, 'dias excluídos: ' + c.nDaysExcluded);
    assert(c.byState.Off.n === 6, 'a média usou o dia incompleto: n=' + c.byState.Off.n);
    assert(/cobertura/.test(c.note), 'a nota não declara a exclusão');
    return `${c.nDaysExcluded} dia fora da média · n = ${c.byState.Off.n} dias`;
  });

  t('perfil circadiano encontra onde o OFF se concentra', () => {
    const r = C.parseDiaryCsv(csv);
    const g = C.diaryGrid(r.rows, { binMin: 30 });
    const p = C.circadianStateProfile(g);
    assert(p.ok, 'perfil não calculado');
    assert(p.props.Off[13] === 100, 'às 06:30 nem todo dia está OFF: ' + p.props.Off[13]);
    assert(p.props.Off[20] === 0, 'às 10:00 alguém ficou OFF: ' + p.props.Off[20]);
    assert(isFinite(p.peakOffHour), 'hora de pico do OFF não estimada');
    return `pico de OFF às ${p.peakOffHour} h em ${p.peakOffPct}% dos dias`;
  });

  t('comparação entre condições usa permutação EXATA quando dá', () => {
    /* pós-tratamento: sem o OFF vespertino → 1,5 h a menos por dia */
    const pos = linhasCsv.slice(1).map(l => {
      const c = l.split(',');
      const h = +c[5];
      if (c[6] === 'Off' && h >= 17) c[6] = 'On_NoDysk';
      c[1] = 'Post';
      return c.join(',');
    });
    const r = C.parseDiaryCsv([linhasCsv[0]].concat(linhasCsv.slice(1), pos).join('\n'));
    const cmp = C.compareConditions(r.rows, { binMin: 30, awakeOnly: true });
    assert(cmp.ok, cmp.reason);
    assert(Math.abs(cmp.deltaOff + 1.5) < 1e-6, 'Δ OFF: ' + cmp.deltaOff);
    assert(cmp.test.exact, 'não enumerou as partições');
    assert(cmp.test.nPermutations === 3432, 'partições: ' + cmp.test.nPermutations);
    assert(!cmp.paired, 'pareou dias que não são pares');
    assert(/não pareada/.test(cmp.caveat), 'não declara o pressuposto');
    /* e é reprodutível: mesmo dado, mesmo p */
    return `Δ = ${cmp.deltaOff} h · p exato ${cmp.test.p} sobre ${cmp.test.nPermutations} partições`;
  });

  t('permutação com semente fixa devolve o mesmo p duas vezes', () => {
    const a = Array.from({ length: 40 }, (_, i) => 5 + Math.sin(i) * 2);
    const b = Array.from({ length: 40 }, (_, i) => 6 + Math.cos(i) * 2);
    const p1 = C.permutationTwoSample(a, b, { seed: 7, nPermutations: 2000 });
    const p2 = C.permutationTwoSample(a, b, { seed: 7, nPermutations: 2000 });
    assert(!p1.exact, 'enumerou 40+40, o que seria caro demais');
    assert(p1.p === p2.p, `p variou entre execuções: ${p1.p} vs ${p2.p}`);
    const p3 = C.permutationTwoSample([1, 2, 3, 4], [8, 9, 10, 11], {});
    assert(p3.exact && p3.nPermutations === 70, 'não enumerou C(8,4): ' + p3.nPermutations);
    return `p = ${p1.p} reproduzido (semente ${p1.seed}) · exato com 70 partições no caso pequeno`;
  });

  t('matriz do Timeline usa a MESMA grade e declara o limiar', () => {
    const trend = C.removeOutliersMAD(parsed[0].trend.Left || Object.values(parsed[0].trend)[0], 'lfp', 4).kept;
    const tg = C.timelineGrid(trend, -180, { binMin: 30 });
    assert(tg.ok, tg.reason);
    assert(tg.nBins === 48, 'bins: ' + tg.nBins);
    assert(tg.states.length === tg.values.length, 'grade categórica e contínua com tamanhos diferentes');
    assert(isFinite(tg.threshold) && /k-médias/.test(tg.thresholdDetail), 'limiar não declarado');
    assert(/NÃO é OFF clínico/.test(tg.caveat), 'não avisa que o limiar não é diagnóstico');
    /* limiar por percentil: 50% acima por construção */
    const tp = C.timelineGrid(trend, -180, { binMin: 30, thresholdMethod: 'percentile', pct: 50 });
    assert(Math.abs(tp.highFraction - 0.5) < 0.03, 'percentil 50 não parte a distribuição ao meio: ' + tp.highFraction);
    assert(tp.thresholdParams.pct === 50, 'não exportou o parâmetro do percentil');
    /* célula sem dado é NaN, e a contabilidade fecha */
    const nans = tg.values.flat().filter(v => !isFinite(v)).length;
    assert(nans === tg.nMissing, `contabilidade: ${nans} NaN vs ${tg.nMissing} declarados`);
    return `${tg.days.length} dias × ${tg.nBins} bins · limiar ${tg.threshold} (${tg.thresholdMethod}) · ${tg.pctMissing}% sem dado`;
  });

  t('marcas de dose saem dos eventos do aparelho, com os nomes disponíveis', () => {
    const dm = C.doseMarkers(parsed[0].snapshots, -180, {});
    assert(dm.ok, dm.reason);
    assert(dm.n > 0 && dm.nDays > 0, 'nenhuma marca');
    assert(dm.hours.every(h => h >= 0 && h < 24), 'hora fora de [0,24)');
    const vazio = C.doseMarkers([], -180, {});
    assert(!vazio.ok && /não tem eventos/.test(vazio.reason), 'não explica a ausência');
    const semMatch = C.doseMarkers([{ t: Date.now(), name: 'Caiu' }], -180, {});
    assert(!semMatch.ok && semMatch.availableNames.includes('Caiu'), 'não lista os eventos disponíveis');
    return `${dm.n} tomadas em ${dm.nDays} dias · mediana ${dm.dosesPerDay}/dia`;
  });

  t('resposta à levodopa recupera latência, nadir e duração construídos', () => {
    /* série com efeito CONHECIDO: queda de 30% começando 30 min após cada dose,
       nadir por volta de 90 min, retorno perto de 220 min */
    const t0 = Date.UTC(2025, 0, 1, 0, 0, 0);
    const doses = [];
    for (let d = 0; d < 14; d++) [7, 12, 17].forEach(h => doses.push(t0 + d * 864e5 + (h + (d % 3) * 0.7) * 36e5));
    const linhas = [];
    for (let k = 0; k < 14 * 144; k++) {
      const tt = t0 + k * 6e5;
      let fator = 1;
      for (let i = doses.length - 1; i >= 0; i--) {
        if (doses[i] > tt) continue;
        const m = (tt - doses[i]) / 60000;
        if (m >= 30 && m <= 220) fator = 1 - 0.30 * Math.sin(Math.PI * (m - 30) / 190);
        break;
      }
      linhas.push({ t: tt, lfp: 40 * fator * (1 + 0.04 * Math.sin(k / 11)) });
    }
    const rl = C.levodopaResponse(linhas, doses, 0, { nSurrogates: 200, nBootstrap: 300, seed: 11 });
    assert(rl.ok, rl.reason);
    assert(rl.detected, 'não detectou um efeito de 30% construído (p=' + rl.p + ')');
    assert(rl.latencyMin >= 20 && rl.latencyMin <= 60, 'latência fora do esperado: ' + rl.latencyMin);
    assert(rl.timeToNadirMin >= 60 && rl.timeToNadirMin <= 140, 'nadir fora do esperado: ' + rl.timeToNadirMin);
    assert(rl.dropPct > 20, 'magnitude subestimada: ' + rl.dropPct);
    assert(isFinite(rl.surrogateDropPct), 'não reportou a queda dos surrogados');
    return `latência ${rl.latencyMin} min (construída 30) · nadir ${rl.timeToNadirMin} min (95) · queda ${rl.dropPct}% (30) · p ${rl.p}`;
  });

  t('sem efeito real, a resposta à levodopa NÃO inventa latência', () => {
    /* mesma série, mas as doses não têm relação com o sinal: só ritmo diurno */
    const t0 = Date.UTC(2025, 0, 1, 0, 0, 0);
    const linhas = [];
    for (let k = 0; k < 14 * 144; k++) {
      const tt = t0 + k * 6e5, hora = (tt / 36e5) % 24;
      linhas.push({ t: tt, lfp: 40 * (1 + 0.15 * Math.cos(2 * Math.PI * (hora - 9.5) / 24)) });
    }
    const doses = [];
    for (let d = 0; d < 14; d++) [8.3, 13.1, 19.7].forEach(h => doses.push(t0 + d * 864e5 + h * 36e5));
    const rl = C.levodopaResponse(linhas, doses, 0, { nSurrogates: 200, nBootstrap: 200, seed: 11 });
    assert(rl.ok, rl.reason);
    assert(!isFinite(rl.latencyMin), 'reportou latência sobre curva sem efeito: ' + rl.latencyMin);
    assert(!isFinite(rl.durationMin), 'reportou duração sobre curva sem efeito');
    assert(/não é possível afirmar|não se separa/.test(rl.interpretation), 'não diz que não é possível determinar');
    assert(/mesma coluna do desenho/.test(rl.confound), 'não declara a confusão com a hora do dia');
    return `p = ${rl.p} · nenhum marco reportado · queda dos surrogados ${rl.surrogateDropPct}%`;
  });

  t('concordância diário × LFP mede em vez de assumir, e declara o alinhamento', () => {
    const r = C.parseDiaryCsv(csv);
    const gd = C.diaryGrid(r.rows, { binMin: 30 });
    /* LFP construído para BATER com o diário: beta alto exatamente no OFF */
    const dias = gd.days;
    const alto = { ok: true, kind: 'lfp', binMin: 30, nBins: 48, days: dias.slice(),
      states: gd.cells.map(l => l.map(v => v == null ? null : (v === 'Off' ? 'LFP_high' : 'LFP_low'))) };
    const ag = C.diaryVsLfpAgreement(gd, alto, {});
    assert(ag.ok, ag.reason);
    assert(ag.kappa > 0.95, 'concordância perfeita não foi reconhecida: kappa ' + ag.kappa);
    assert(/por data|por ordem/.test(ag.alignment), 'não declara o alinhamento');
    assert(ag.nSleepBins > 0 && ag.n < gd.nCells, 'não excluiu os bins de sono');
    /* agora um LFP invertido: kappa tem de despencar */
    const inv = Object.assign({}, alto, { states: alto.states.map(l => l.map(v => v == null ? null : (v === 'LFP_high' ? 'LFP_low' : 'LFP_high'))) });
    const ag2 = C.diaryVsLfpAgreement(gd, inv, {});
    assert(ag2.kappa < 0, 'LFP invertido não foi penalizado: kappa ' + ag2.kappa);
    assert(/não é validação/.test(ag2.caveat), 'não avisa que concordância não é validação');
    return `kappa ${ag.kappa} (concordante) vs ${ag2.kappa} (invertido) · ${ag.n} bins, sono fora`;
  });

  t('a matriz desenha células, barras e marcas — e exporta em 2×', () => {
    const r = C.parseDiaryCsv(csv);
    const g = C.diaryGrid(r.rows, { binMin: 30 });
    const comp = C.dailyComposition(g, { awakeOnly: false });
    const paleta = {}; C.DIARY_STATES.forEach(s => { paleta[s.id] = s; });
    const pai = document.createElement('div');
    let baixado = 0;
    const antes = P.downloadCanvas;
    P.downloadCanvas = () => { baixado++; };
    const bx = H.painelMatriz(pai, {
      days: g.days, nBins: g.nBins, cells: g.cells, states: g.cells,
      rows: comp.perDay.map(dd => C.DIARY_STATES.map(s => ({ state: s.id, hours: dd.hours[s.id] || 0 }))),
      barMax: 24, palette: paleta,
      legend: C.DIARY_STATES.map(s => ({ label: s.label, color: s.color })),
      doseRows: g.days.map(() => [7, 11, 15, 19]),
      rowLabel: dia => 'Dia ' + dia, title: 'teste'
    });
    assert(bx && bx.canvas, 'não devolveu a tela');
    assert(bx.canvas._ctx.calls > 0, 'nada foi escrito na tela');
    bx.exportar2x('teste');
    P.downloadCanvas = antes;
    assert(baixado === 1, 'a exportação 2× não gerou download');
    return `${g.days.length} linhas desenhadas · exportação 2× em tela fora do documento`;
  });
}

/* -------- PDF nativo, idiomas, acessibilidade e robustez (Onda 8.2) ------- */
sec('PDF nativo, idiomas, acessibilidade e robustez');
{
  const doc82 = {
    title: 'Relatório de análise de LFP subtalâmico',
    subtitle: 'registro sub-teste · perfil Doença de Parkinson',
    footer: 'Percept LFP Studio',
    blocks: [
      { type: 'kv', rows: [['identificador', 'sub-teste'], ['implante', '2024-09-12']] },
      { type: 'h1', text: 'Leitura em linguagem clínica' },
      { type: 'p', text: 'Frase longa com acentuação para exercitar a quebra de linha: ação, coração, número, três, ângulo, ambiguidade, ' + 'palavra '.repeat(40) },
      { type: 'note', text: 'Ressalva — o p usado é o corrigido para autocorrelação.' },
      { type: 'table', cols: ['hemisfério', 'pico (Hz)', 'χ'], widths: [0.4, 0.3, 0.3], rows: [['esquerdo', '17,6', '0,91'], ['direito', '15,6', '0,89']] }
    ],
    figures: []
  };
  const pdf82 = C.buildPdf(doc82);

  t('PDF: estrutura do arquivo é válida e o xref aponta para os objetos certos', () => {
    assert(pdf82 && pdf82.bytes.length > 500, 'não gerou');
    let txt = '';
    for (let i = 0; i < pdf82.bytes.length; i++) txt += String.fromCharCode(pdf82.bytes[i]);
    assert(txt.startsWith('%PDF-1.4'), 'sem cabeçalho PDF');
    assert(txt.trim().endsWith('%%EOF'), 'sem marca de fim');
    const m = txt.match(/\nxref\n0 (\d+)\n([\s\S]*?)\ntrailer/);
    assert(m, 'sem tabela xref');
    const n = +m[1], linhas = m[2].split('\n');
    let erros = 0;
    for (let i = 1; i < n; i++) {
      const off = parseInt(linhas[i].slice(0, 10), 10);
      if (!txt.startsWith(i + ' 0 obj', off)) erros++;
    }
    assert(erros === 0, `${erros} de ${n - 1} deslocamentos do xref apontam para o lugar errado`);
    const sx = +(txt.match(/startxref\n(\d+)/) || [])[1];
    assert(txt.startsWith('xref', sx), 'startxref não aponta para a tabela');
    return `${n - 1} objetos, ${pdf82.meta.pages} página(s), ${(pdf82.meta.bytes / 1024).toFixed(1)} KB, xref íntegro`;
  });

  t('PDF: texto sai em WinAnsi e nenhum byte estoura o formato', () => {
    let txt = '';
    for (let i = 0; i < pdf82.bytes.length; i++) txt += String.fromCharCode(pdf82.bytes[i]);
    /* acentos do português precisam sobreviver como bytes Latin-1 */
    assert(/a\xE7\xE3o/.test(txt), 'a palavra "ação" não saiu em Latin-1');
    assert(/cora\xE7\xE3o/.test(txt), '"coração" não saiu em Latin-1');
    /* travessão vira o byte WinAnsi 0x97, não some nem vira "?" */
    assert(txt.indexOf('\x97') >= 0, 'travessão não foi mapeado para WinAnsi');
    assert(pdf82.bytes.every(b => b <= 255), 'byte fora de 0–255');
    /* parênteses dentro de string precisam estar escapados */
    const strings = txt.match(/\(([^\\)]|\\.)*\)/g) || [];
    assert(strings.length > 5, 'poucas strings de texto no conteúdo');
    return `${strings.length} strings de texto · acentos e travessão preservados`;
  });

  t('PDF: quebra de linha usa as larguras reais dos glifos', () => {
    /* "MMMM" é muito mais largo que "iiii" na Helvetica; se a quebra usasse
       contagem de caracteres, os dois dariam a mesma largura */
    const largo = C.textWidth('MMMM', 10, false), estreito = C.textWidth('iiii', 10, false);
    assert(largo > 2.5 * estreito, `larguras iguais demais: ${largo} vs ${estreito}`);
    assert(C.textWidth('ABC', 10, true) > C.textWidth('ABC', 10, false), 'negrito não é mais largo');
    /* um parágrafo longo tem de gerar mais de uma página de conteúdo ou várias linhas */
    const curto = C.buildPdf({ title: 'x', blocks: [{ type: 'p', text: 'curto' }], figures: [] });
    const longo = C.buildPdf({ title: 'x', blocks: [{ type: 'p', text: 'palavra '.repeat(2500) }], figures: [] });
    assert(longo.meta.bytes > curto.meta.bytes * 2, 'texto longo não gerou mais conteúdo');
    assert(longo.meta.pages > curto.meta.pages, 'texto longo não paginou');
    return `M/i = ${(largo / estreito).toFixed(1)}× · texto longo em ${longo.meta.pages} páginas`;
  });

  t('PDF: nenhum caractere do software fica sem representação e vira "?"', () => {
    /* varre tudo o que pode ir para o PDF: títulos, subtítulos, leituras
       clínicas com parâmetros e ressalvas, e os rótulos das métricas */
    const b = C.extractMetrics(parsed, -180, { profileId: 'pd' });
    const painel = C.qcPanel(parsed, { band: [13, 35] });
    const r = C.clinicalReadings(b, { profileId: 'pd', qcPanel: painel });
    const textos = []
      .concat(H.FIGURES.map(f => f.title + ' ' + f.sub))
      .concat(r.readings.map(l => [l.titulo, l.frase, l.numeros, l.parametro, l.ressalva].join(' ')))
      .concat([r.disclaimer, r.semaforo.frase, r.semaforo.rotulo])
      .concat(C.PROFILE_IDS.map(id => {
        const p = C.PROFILES[id];
        return [p.label, p.glossary.intuicao, p.glossary.picoTexto, p.glossary.elegibilidade].join(' ');
      }));
    const fora = new Set();
    textos.forEach(x => C.unmappedChars(x).forEach(c => fora.add(c)));
    assert(!fora.size, 'sem representação no PDF: ' + Array.from(fora).map(c => `"${c}" (U+${c.codePointAt(0).toString(16).toUpperCase()})`).join(', '));
    return `${textos.length} textos varridos, nenhum caractere sem representação`;
  });

  t('idiomas: dicionário traduz o que promete e devolve a chave quando não tem', () => {
    const antes = C.getLanguage();
    C.setLanguage('en');
    assert(C.t('Exportar') === 'Export', 'não traduziu: ' + C.t('Exportar'));
    assert(C.t('Ritmo circadiano — heatmap, perfil polar e cosinor').indexOf('Circadian') === 0, 'título de figura não traduzido');
    const inexistente = 'chave que não existe no dicionário';
    assert(C.t(inexistente) === inexistente, 'chave ausente não voltou como ela mesma');
    C.setLanguage('pt');
    assert(C.t('Exportar') === 'Exportar', 'pt-BR deveria devolver a própria chave');
    C.setLanguage(antes);
    const cov = C.translationCoverage();
    assert(cov.nKeys > 40, 'dicionário pequeno demais: ' + cov.nKeys);
    assert(/metodológicos/.test(cov.outOfScope), 'o escopo não declara o que fica de fora');
    assert(cov.notice && cov.notice.en && cov.notice.pt, 'sem aviso de escopo nos dois idiomas');
    return `${cov.nKeys} chaves · escopo declarado, fora de escopo declarado`;
  });

  t('todo título de figura tem tradução — senão o modo inglês fica pela metade', () => {
    const antes = C.getLanguage();
    C.setLanguage('en');
    const semTraducao = H.FIGURES.filter(f => C.t(f.title) === f.title);
    C.setLanguage(antes);
    assert(!semTraducao.length, 'sem tradução: ' + semTraducao.map(f => f.id).join(', '));
    return `${H.FIGURES.length} figuras, todas traduzidas`;
  });

  t('acessibilidade: todo gráfico ganha papel e rótulo para leitor de tela', () => {
    const cv = document.createElement('canvas');
    new P.Chart(cv, { width: 300, height: 200, title: 'espectro de potência', xlabel: 'frequência (Hz)', ylabel: 'µV²/Hz' });
    assert(cv.attrs && cv.attrs.role === 'img', 'canvas sem role="img"');
    const rot = cv.attrs['aria-label'] || '';
    assert(/espectro de potência/.test(rot), 'rótulo não traz o título: ' + rot);
    assert(/eixo x/.test(rot) && /eixo y/.test(rot), 'rótulo não descreve os eixos: ' + rot);
    return `aria-label: "${rot.slice(0, 70)}…"`;
  });

  t('robustez: JSON malformado é recusado com motivo, não derruba a leitura', () => {
    const casos = [
      ['vazio', ''],
      ['não é JSON', 'isto não é json'],
      ['JSON truncado', '{"PatientInformation": {'],
      ['JSON válido mas sem nada do Percept', '{"foo": 1}'],
      ['modalidade com tipo errado', JSON.stringify({ LFPMontage: 'não é lista', BrainSenseTimeDomain: 42 })]
    ];
    const resultados = casos.map(([nome, txt]) => {
      try {
        const p = C.parsePerceptText(txt, nome + '.json');
        /* aceitar é legítimo desde que o resultado seja honesto sobre o vazio */
        const n = Object.keys(p.availability || {}).filter(k => p.availability[k] > 0).length;
        return `${nome}: lido com ${n} modalidade(s)`;
      } catch (e) {
        assert(e && e.message, nome + ': erro sem mensagem');
        return `${nome}: recusado (${e.message.slice(0, 30)})`;
      }
    });
    /* o que não pode acontecer é travar ou devolver estrutura inconsistente */
    const p = C.parsePerceptText('{"foo":1}', 'vazio.json');
    assert(p && p.patient && p.availability, 'estrutura incompleta para arquivo vazio');
    assert(Object.keys(p.availability).every(k => p.availability[k] === 0), 'declarou modalidade que não existe');
    return resultados.join(' · ');
  });

  t('robustez: métricas sobre arquivo sem dados não inventam número', () => {
    const p = C.parsePerceptText('{"foo":1}', 'vazio.json');
    const b = C.extractMetrics([p], -180, { profileId: 'pd' });
    assert(b, 'extractMetrics devolveu null');
    assert(b.acute.length === 0 && b.chronic.length === 0, 'produziu linhas sem dado de origem');
    const r = C.clinicalReadings(b, { profileId: 'pd' });
    assert(r.readings.every(l => l.nivel === 'insuficiente' || !l.numeros), 'leitura com número sobre nada');
    return `${b.acute.length} agudas, ${b.chronic.length} crônicas, ${r.readings.length} leitura(s) — todas declaram dado insuficiente`;
  });
}


/* ----------------------- cronobiologia, mudança de nível, alarme e agenda -- */
sec('ritmo não paramétrico, ponto de mudança, alarme ativo e agenda da próxima sessão');
{
  const DIA = 86400000, BIN = 600000, T0 = Date.UTC(2025, 0, 1, 0, 0, 0);
  /* gerador determinístico: nDias × 144 bins de 10 min, sem Math.random */
  const serie = (nDias, fn) => {
    const out = [];
    for (let d = 0; d < nDias; d++) for (let k = 0; k < 144; k++) {
      const v = fn(d, k / 6, k);
      if (v != null) out.push({ t: T0 + d * DIA + k * BIN, lfp: v });
    }
    return out;
  };
  const ritmo = h => 10 + 3 * Math.sin(2 * Math.PI * (h - 8) / 24);
  const jitter = (d, k) => 0.35 * Math.sin(d * 7.13 + k * 2.71);

  /* --- IS / IV / M10-L5 contra verdade construída ------------------------ */
  t('IS separa ritmo que se repete de ruído que não se repete', () => {
    const puro = serie(14, (d, h) => ritmo(h));
    const caos = serie(14, (d, h, k) => 10 + 5 * Math.sin(d * 11.7 + k * 3.31));
    const a = C.interdailyStability(puro, 0, {}), b = C.interdailyStability(caos, 0, {});
    assert(a.ok && b.ok, 'IS não calculou');
    assert(a.IS > 0.95, 'ritmo idêntico entre dias deveria dar IS ≈ 1, deu ' + a.IS);
    assert(b.IS < 0.2, 'série sem estrutura de 24 h deveria dar IS baixo, deu ' + b.IS);
    return `IS ritmo puro ${a.IS.toFixed(3)} · IS sem ritmo ${b.IS.toFixed(3)}`;
  });

  t('IV distingue perfil liso de perfil picado, e declara o que descartou', () => {
    const liso = serie(14, (d, h) => ritmo(h));
    const picado = serie(14, (d, h, k) => 10 + 6 * Math.sin(d * 3.7 + k * 1.9));
    const a = C.intradailyVariability(liso, 0, {}), b = C.intradailyVariability(picado, 0, {});
    assert(a.ok && b.ok, 'IV não calculou');
    assert(a.IV < 0.3, 'perfil senoidal deveria dar IV baixo, deu ' + a.IV);
    assert(b.IV > 1.0, 'perfil picado deveria dar IV alto, deu ' + b.IV);
    assert(a.params && a.params.binStatistic, 'IV não declarou a estatística de resumo do bin');
    return `IV liso ${a.IV.toFixed(3)} · IV picado ${b.IV.toFixed(3)} · resumo por ${a.params.binStatistic}`;
  });

  t('M10 e L5 acham a janela construída, e RA não depende da unidade', () => {
    /* pico às 9 h, vale às 21 h */
    const rows = serie(14, (d, h) => 10 + 4 * Math.cos(2 * Math.PI * (h - 9) / 24));
    const dobro = rows.map(r => ({ t: r.t, lfp: 2 * r.lfp }));
    const a = C.m10l5(rows, 0, {}), b = C.m10l5(dobro, 0, {});
    assert(a.ok && b.ok, 'M10/L5 não calculou');
    const dist = Math.min(Math.abs(a.M10startHour - 4), 24 - Math.abs(a.M10startHour - 4));
    assert(dist <= 2, 'M10 de um pico às 9 h deveria começar perto das 4 h, começou às ' + a.M10startHour);
    assert(Math.abs(a.RA - b.RA) < 1e-9, 'RA mudou ao multiplicar a série por 2: ' + a.RA + ' vs ' + b.RA);
    return `M10 começa ${a.M10startHour}h · L5 ${a.L5startHour}h · RA ${a.RA.toFixed(4)} invariante à escala`;
  });

  t('o painel de ritmo recusa dado curto em vez de devolver número frágil', () => {
    const curto = serie(2, (d, h) => ritmo(h));
    const r = C.actigraphyPanel(curto, 0, {});
    assert(!r.ok, 'aceitou 2 dias');
    assert(/dia/.test(r.reason), 'recusou sem dizer por quê: ' + r.reason);
    return r.reason.slice(0, 70);
  });

  /* --- ponto de mudança -------------------------------------------------- */
  t('ponto de mudança acha o degrau construído e não inventa em série plana', () => {
    const comDegrau = serie(20, (d, h, k) => ritmo(h) - (d >= 10 ? 12 : 0) + jitter(d, k));
    const plana = serie(20, (d, h, k) => ritmo(h) + jitter(d, k));
    const a = C.changePointsInTime(comDegrau, { offMin: 0 });
    const b = C.changePointsInTime(plana, { offMin: 0 });
    assert(a.ok && b.ok, 'não calculou');
    assert(a.nPoints === 1, 'esperado 1 ponto de mudança, achou ' + a.nPoints);
    assert(a.points[0].dayKey === '2025-01-11', 'degrau no dia errado: ' + a.points[0].dayKey);
    assert(a.points[0].delta < -10, 'variação do degrau muito pequena: ' + a.points[0].delta);
    assert(b.nPoints === 0, 'inventou ' + b.nPoints + ' mudança(s) numa série sem degrau');
    return `degrau em ${a.points[0].dayKey}, Δ ${a.points[0].delta.toFixed(2)}, p ${a.points[0].p} · série plana: 0 pontos`;
  });

  t('a anotação separa mudança explicada por marco de mudança órfã', () => {
    const rows = serie(20, (d, h, k) => ritmo(h) - (d >= 10 ? 12 : 0) + jitter(d, k));
    const cp = C.changePointsInTime(rows, { offMin: 0 });
    const perto = C.annotateChangePoints(cp.points, [{ t: T0 + 10 * DIA, label: 'reprogramação' }], { toleranceDays: 2 });
    const longe = C.annotateChangePoints(cp.points, [{ t: T0 + 2 * DIA, label: 'reprogramação' }], { toleranceDays: 2 });
    assert(perto.nExplained === 1 && perto.nUnexplained === 0, 'marco a 1 dia não explicou a mudança');
    assert(longe.nExplained === 0 && longe.nUnexplained === 1, 'marco a 9 dias explicou o que não deveria');
    assert(/não estabelece causa/.test(longe.caveat), 'a anotação não declarou que coincidência não é causa');
    return `marco a 1 dia: explicado · marco a 9 dias: órfão · ressalva de causalidade presente`;
  });

  /* --- alarme ativo de artefato ------------------------------------------ */
  const FS = 250, NS = FS * 60;
  const canal = (ampQRS, satura) => {
    const x = new Float64Array(NS);
    let s = 12345;
    const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
    for (let i = 0; i < NS; i++) x[i] = 4 * Math.sin(2 * Math.PI * 20 * i / FS) + 3 * r();
    if (ampQRS > 0) {
      const rr = Math.round(FS * 0.8);                       /* 75 bpm */
      for (let p = rr; p < NS; p += rr) for (let k = -4; k <= 4; k++)
        if (p + k < NS) x[p + k] += ampQRS * Math.exp(-(k * k) / 2) * (k === 0 ? 1 : (k < 0 ? -0.3 : -0.35));
    }
    if (satura) for (let i = 0; i < NS; i++) x[i] = Math.max(-3, Math.min(3, x[i]));
    return {
      bsTimeDomain: [{
        label: '1-3', hemisphere: 'Left', channel: '1-3', fs: FS, fsEff: FS, data: x,
        packets: { pctMissing: 0, nGaps: 0 }, timing: { driftMsTotal: 0 }
      }]
    };
  };

  t('o alarme acha ECG forte, chama de impeditivo e diz o que fazer', () => {
    const a = C.artifactAlarm(canal(30, false), {});
    const ecg = (a.alarms || []).find(x => x.id === 'ecg');
    assert(ecg, 'não alarmou ECG num canal com QRS de 30 µV');
    assert(ecg.severity === 'critico', 'gravidade errada: ' + ecg.severity);
    assert(ecg.verdict === 'não interprete este canal', 'veredito errado: ' + ecg.verdict);
    assert(ecg.plain && !/µV²|FFT|espectrograma/.test(ecg.plain), 'a frase para o clínico usa jargão de processamento');
    assert(ecg.whatToDo && ecg.whatToDo.length > 20, 'alarme sem ação concreta');
    return `${ecg.severity} · ${ecg.evidence.slice(0, 80)}`;
  });

  t('o alarme NÃO acusa batimento num canal limpo com beta forte', () => {
    const a = C.artifactAlarm(canal(0, false), {});
    assert(!(a.alarms || []).some(x => x.id === 'ecg'), 'falso positivo de ECG num canal só com beta e ruído');
    assert(a.level === 'limpo', 'nível deveria ser limpo, veio ' + a.level);
    return `${a.checked.length} verificação(ões) feitas, nenhum alarme`;
  });

  t('o segundo detector pega ECG que o detector de picos R deixa passar', () => {
    /* com QRS pequeno o detector de picos trava no ruído; a periodicidade da
       potência instantânea continua vendo o transiente repetitivo */
    const a = C.artifactAlarm(canal(10, false), {});
    const ecg = (a.alarms || []).find(x => x.id === 'ecg');
    assert(ecg, 'nenhum alarme com QRS de 10 µV — o segundo detector não pegou');
    assert(ecg.severity === 'atencao', 'achado só do segundo detector não pode ser impeditivo: ' + ecg.severity);
    assert(/potência instantânea se repete/.test(ecg.evidence), 'não mostrou a evidência de periodicidade');
    return ecg.evidence.slice(ecg.evidence.indexOf('potência'), 200);
  });

  t('o alarme acha saturação e conta o que NÃO pôde verificar', () => {
    const a = C.artifactAlarm(canal(0, true), {});
    assert((a.alarms || []).some(x => x.id === 'saturacao'), 'não achou o sinal ceifado em ±3 µV');
    const vazio = C.artifactAlarm({}, {});
    assert(vazio.ok && !vazio.alarms.length, 'arquivo vazio deveria voltar sem alarme');
    assert(vazio.notChecked.length >= 3, 'arquivo sem nada deveria acumular verificações impossíveis');
    assert(/ausência de verificação não é ausência de artefato/.test(vazio.summary),
      'o resumo de um arquivo sem dado não avisou que nada foi verificado');
    return `saturação detectada · arquivo vazio: 0 alarmes e ${vazio.notChecked.length} verificações impossíveis`;
  });

  /* --- agenda da próxima sessão ------------------------------------------ */
  t('cada checagem da agenda dispara no cenário que a define', () => {
    const casos = {
      assimetria: {
        rows: {
          Left: serie(30, (d, h, k) => ritmo(h) + jitter(d, k)),
          Right: serie(30, (d, h, k) => (d < 15 ? ritmo(h) : ritmo(h) * 0.55) + jitter(d, k))
        }
      },
      dose: {
        rows: { Left: serie(30, (d, h, k) => ritmo(h) + jitter(d, k)) },
        doseTimes: (() => { const v = []; for (let d = 0; d < 30; d++)[7, 12, 17, 21].forEach(h => v.push(T0 + d * DIA + h * 36e5)); return v; })()
      },
      circadiano: { rows: { Left: serie(30, (d, h, k) => ritmo(h) - (Math.floor(h) === 3 ? 4 : 0) + jitter(d, k)) } },
      deriva: { rows: { Left: serie(30, (d, h, k) => ritmo(h) - (d >= 15 ? 4 : 0) + jitter(d, k)) } },
      cobertura: { rows: { Left: serie(30, (d, h, k) => (h >= 8 && h < 14) ? ritmo(h) + jitter(d, k) : null) } },
      ritmo: { rows: { Left: serie(30, (d, h, k) => 10 + 6 * Math.sin(d * 3.7 + k * 1.9)) } }
    };
    const achados = [];
    Object.keys(casos).forEach(id => {
      const ag = C.sessionAgenda(Object.assign({ offMin: 0 }, casos[id]), {});
      assert(ag.ok, `agenda falhou no caso ${id}: ${ag.reason}`);
      const it = (ag.items || []).find(x => x.id === id);
      assert(it, `a checagem "${id}" não disparou no cenário construído para ela`);
      assert(it.suggestedProtocol && it.whatItWouldSettle, `item ${id} sem protocolo ou sem o que ficaria decidido`);
      assert(it.conductFree, `item ${id} tem verbo de conduta terapêutica no texto`);
      achados.push(`${id}/${it.priority}`);
    });
    return achados.join(' · ');
  });

  t('numa série sem anomalia a agenda não inventa item', () => {
    const limpa = {
      offMin: 0,
      rows: {
        Left: serie(30, (d, h, k) => ritmo(h) + jitter(d, k)),
        Right: serie(30, (d, h, k) => ritmo(h) + jitter(d, k))
      }
    };
    const ag = C.sessionAgenda(limpa, {});
    assert(ag.ok, 'agenda falhou: ' + ag.reason);
    assert(ag.items.length === 0, 'inventou item numa série sem anomalia: ' + ag.items.map(i => i.id).join(', '));
    assert(ag.notChecked.length >= 1, 'sem passaporte e sem dose, deveria haver checagem não realizada');
    assert(/não é\s*\n?\s*ausência|ausência de achado/i.test(ag.incompletenessNote) || ag.notChecked.length === 0,
      'não avisou que verificação não feita não é achado ausente');
    return `0 itens · ${ag.nChecksRun}/${ag.nChecksTotal} verificações · ${ag.notChecked.map(n => n.id).join(', ')} não checadas`;
  });

  t('a agenda declara que é investigação e nunca conduta', () => {
    const ag = C.sessionAgenda({ offMin: 0, rows: { Left: serie(30, (d, h, k) => ritmo(h) - (d >= 15 ? 4 : 0) + jitter(d, k)) } }, {});
    assert(/AGENDA DE INVESTIGAÇÃO/.test(ag.disclaimer), 'sem declaração de natureza');
    assert(/não é conduta terapêutica/i.test(ag.disclaimer), 'não nega conduta terapêutica');
    const texto = (ag.items || []).map(i => `${i.suggestedProtocol} ${i.whatItWouldSettle}`).join(' ').toLowerCase();
    ['aumente', 'diminua a amplitude', 'prescreva', 'troque o contato'].forEach(v =>
      assert(texto.indexOf(v) < 0, 'texto de protocolo contém verbo de conduta: ' + v));
    assert(ag.params && ag.params.thresholds && isFinite(ag.params.seed), 'a agenda não exportou parâmetros e semente');
    return `${ag.items.length} item(ns) · limiares e semente exportados · nenhum verbo de conduta`;
  });

  t('sem Timeline a agenda recusa em vez de devolver lista vazia como se fosse limpo', () => {
    const ag = C.sessionAgenda({ offMin: 0, rows: {} }, {});
    assert(!ag.ok, 'aceitou arquivo sem Timeline');
    assert(/registro crônico|Timeline/.test(ag.reason), 'recusou sem dizer o que falta: ' + ag.reason);
    return ag.reason.slice(0, 80);
  });

  /* --- as duas figuras novas --------------------------------------------- */
  t('F32 e F33 renderizam e existem nas abas certas', () => {
    const f32 = H.FIGURES.find(x => x.id === 'F32'), f33 = H.FIGURES.find(x => x.id === 'F33');
    assert(f32 && f33, 'F32 ou F33 não está registrada');
    const d = H.ds();
    assert(f32.has(d) && f33.has(d), 'as figuras se declaram indisponíveis sobre o exemplo');
    const aba32 = H.ABAS.find(a => (a.figuras || []).indexOf('F32') >= 0);
    const aba33 = H.ABAS.find(a => (a.figuras || []).indexOf('F33') >= 0);
    assert(aba32 && aba32.id === 'cronico', 'F32 deveria morar na aba Crônico');
    assert(aba33 && aba33.id === 'ponte', 'F33 deveria morar na aba Ponte');
    const n1 = document.createElement('div'), n2 = document.createElement('div');
    f32.render(n1, d); f33.render(n2, d);
    /* o DOM de teste é mínimo: varre a árvore à mão em vez de usar seletor */
    const varre = (n, acc) => {
      acc.tags.push(n.tagName || (typeof n.getContext === 'function' ? 'CANVAS' : '?'));
      acc.txt += ' ' + (n.textContent || '') + ' ' + (n.innerHTML || '');
      (n.children || []).forEach(c => varre(c, acc));
      return acc;
    };
    const a1 = varre(n1, { tags: [], txt: '' }), a2 = varre(n2, { tags: [], txt: '' });
    const tabelas = a1.tags.filter(x => x === 'TABLE').length;
    assert(tabelas >= 1, 'F32 não produziu tabela');
    assert(a1.tags.indexOf('CANVAS') >= 0, 'F32 não desenhou a série');
    assert(a2.txt.length > 200, 'F33 produziu conteúdo vazio');
    assert(/AGENDA DE INVESTIGAÇÃO/.test(a2.txt), 'F33 não mostrou a natureza da lista ao usuário');
    return `F32 em ${aba32.id} · F33 em ${aba33.id} · ${tabelas} tabela(s) e 1 gráfico em F32`;
  });
}


/* ------------- ODR, coerência inter-STN e variação espectral por janela --- */
sec('ODR, coerência inter-STN e variação espectral por janela (Onda 12)');
{
  const FSJ = 250;
  /* gerador determinístico: nenhum Math.random, semente explícita */
  const prngJ = seed => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 - 0.5; }; };
  const sinalJ = (durS, fn, seed) => {
    const n = Math.round(durS * FSJ), x = new Float64Array(n), r = prngJ(seed);
    for (let i = 0; i < n; i++) x[i] = fn(i / FSJ, i) + 1.2 * r();
    return x;
  };
  const oscJ = (t, f, a) => a * Math.sin(2 * Math.PI * f * t);
  const mJ = v => v.reduce((s, x) => s + x, 0) / v.length;
  /* Spearman local, para não depender de qual módulo o exporta */
  const spearJ = (a, b) => {
    const posto = v => {
      const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
      const r = new Array(v.length);
      let i = 0;
      while (i < idx.length) {
        let j = i;
        while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
        const md = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) r[idx[k][1]] = md;
        i = j + 1;
      }
      return r;
    };
    const ra = posto(a), rb = posto(b), ma = mJ(ra), mb = mJ(rb);
    let n = 0, da = 0, db = 0;
    for (let i = 0; i < ra.length; i++) { n += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
    return n / Math.sqrt(da * db);
  };

  /* 1a. a formulação logarítmica É a mesma razão ---------------------------- */
  t('odrLog é a razão do artigo em domínio logarítmico, e isso é verificável', () => {
    const x = sinalJ(300, tt => {
      const k = Math.floor(tt / 10);
      return oscJ(tt, 6, 3 + 0.7 * ((k * 7) % 9)) + oscJ(tt, 16, 3 + 0.7 * ((k * 5) % 11)) + oscJ(tt, 72, 3 + 0.6 * ((k * 3) % 13));
    }, 17);
    const odr = C.odrSeries({ hemispheres: { Left: { x, fs: FSJ, stimRateHz: 130 } } }, { windowS: 10 });
    assert(odr.ok, 'ODR não calculado: ' + odr.reason);
    const bh = odr.byHemisphere.Left;
    const razao = [], log = [];
    bh.windows.forEach(w => {
      const r = Math.log10(w.power.theta * w.power.gammaPeak / w.power.lowBeta);
      if (isFinite(r) && isFinite(w.odrLog)) { razao.push(r); log.push(w.odrLog); }
    });
    assert(razao.length >= 20, 'poucas janelas para a comparação: ' + razao.length);
    const rho = spearJ(razao, log);
    assert(rho > 0.98, `odrLog deveria ser função monotônica de log(θγ/β); Spearman deu ${rho.toFixed(4)}`);
    return `${razao.length} janelas · Spearman odrLog × log(θ·γ/β) = ${rho.toFixed(4)}`;
  });

  /* 1b. e a versão literal é instável — o teste verifica que isso é REPORTADO */
  t('a versão literal explode quando z(β) cruza zero, e o módulo reporta isso', () => {
    /* uma janela com potência de beta praticamente igual à média do registro:
       é ali que o z-score do denominador passa por zero */
    const x = sinalJ(300, tt => {
      const k = Math.floor(tt / 10);
      const a = k === 15 ? 6.7 : (k < 15 ? 3 : 9);
      return oscJ(tt, 6, 5) + oscJ(tt, 16, a) + oscJ(tt, 72, 4);
    }, 29);
    const odr = C.odrSeries({ hemispheres: { Left: { x, fs: FSJ, stimRateHz: 130 } } }, { windowS: 10 });
    assert(odr.ok, 'ODR não calculado: ' + odr.reason);
    const zb = odr.byHemisphere.Left.windows[15].zLowBeta;
    assert(Math.abs(zb) < 0.06, `a construção não colocou z(β) perto de zero: ${zb}`);
    const lit = odr.windows.map(w => w.odrLiteral).filter(isFinite).map(Math.abs);
    const log = odr.windows.map(w => w.odrLog).filter(isFinite).map(Math.abs);
    const maxLit = Math.max.apply(null, lit), maxLog = Math.max.apply(null, log);
    assert(maxLit > 4 * maxLog, `a versão literal deveria explodir: max|literal| ${maxLit.toFixed(1)} vs max|log| ${maxLog.toFixed(2)}`);
    assert(maxLog < 6, 'a versão logarítmica deveria ficar limitada, deu ' + maxLog.toFixed(2));
    assert(odr.literalEscapeCount >= 1, 'a divergência existe mas não foi contabilizada em literalEscapeCount');
    assert(isFinite(odr.spearmanLogVsLiteral), 'a correlação entre as duas formulações não foi reportada');
    assert(/propriedade da fórmula/.test(odr.formulationNote), 'a saída não explica que a divergência é da fórmula');
    return `z(β) = ${zb} · max|literal| ${maxLit.toFixed(1)} vs max|log| ${maxLog.toFixed(2)} · ` +
      `${odr.literalEscapeCount} escape(s) · ρ = ${odr.spearmanLogVsLiteral}`;
  });

  /* 2. direção do ODR ------------------------------------------------------ */
  t('o ODR sobe no trecho com teta e gama altos e beta baixo, e volta depois', () => {
    const dentroDe = [40, 80];
    const x = sinalJ(120, tt => {
      const d = tt >= dentroDe[0] && tt < dentroDe[1];
      return oscJ(tt, 6, d ? 9 : 3) + oscJ(tt, 16, d ? 2 : 8) + oscJ(tt, 72, d ? 5 : 1.5);
    }, 11);
    const odr = C.odrSeries({ hemispheres: { Left: { x, fs: FSJ, stimRateHz: 130 } } }, { windowS: 10 });
    assert(odr.ok, 'ODR não calculado: ' + odr.reason);
    const dentro = odr.windows.filter(w => w.tCenterS >= dentroDe[0] && w.tCenterS < dentroDe[1]).map(w => w.odrLog);
    const fora = odr.windows.filter(w => w.tCenterS < dentroDe[0] || w.tCenterS >= dentroDe[1]).map(w => w.odrLog);
    assert(dentro.length >= 3 && fora.length >= 6, 'partição das janelas inesperada');
    assert(mJ(dentro) > mJ(fora) + 1, `o ODR deveria subir no trecho construído: ${mJ(dentro).toFixed(2)} vs ${mJ(fora).toFixed(2)}`);
    const ultimas = odr.windows.slice(-3).map(w => w.odrLog);
    assert(mJ(ultimas) < mJ(dentro) - 1, 'o ODR não voltou ao nível de base depois do trecho');
    return `dentro ${mJ(dentro).toFixed(2)} · fora ${mJ(fora).toFixed(2)} · pico de gama em ${odr.byHemisphere.Left.gamma.peakHz} Hz`;
  });

  /* 3. recusa por entrainment ---------------------------------------------- */
  t('gama em f_stim/2 faz o ODR recusar o cálculo, e a variante sem gama só sai se pedida', () => {
    const x = sinalJ(120, tt => oscJ(tt, 6, 4) + oscJ(tt, 16, 5) + oscJ(tt, 65, 7), 13);
    const r = C.odrSeries({ hemispheres: { Left: { x, fs: FSJ, stimRateHz: 130 } } }, { windowS: 10 });
    assert(!r.ok, 'calculou o ODR sobre gama entrained em f_stim/2');
    assert(/f_stim\/2|subarmônica/.test(r.reason), 'recusou sem dar o motivo correto: ' + r.reason);
    assert(/opostas/i.test(r.reason), 'não disse que as duas leituras clínicas são opostas');
    const bh = r.byHemisphere.Left;
    assert(bh.entrainmentRefusal === true, 'a recusa não ficou marcada no hemisfério');
    /* a variante sem gama existe, mas só quando pedida explicitamente */
    const v = C.odrSeries({ hemispheres: { Left: { x, fs: FSJ, stimRateHz: 130 } } }, { windowS: 10, allowWithoutGamma: true });
    assert(v.ok, 'a variante odrSemGama não saiu nem quando pedida');
    assert(v.byHemisphere.Left.withoutGamma === true, 'a variante não foi marcada como sem gama');
    assert(/NÃO é o biomarcador do artigo/.test(v.byHemisphere.Left.withoutGammaNote), 'a variante não avisa que não é o biomarcador do artigo');
    /* e sem a frequência de estimulação, a checagem não é feita — e isso é dito */
    const semFstim = C.odrSeries({ hemispheres: { Left: { x, fs: FSJ } } }, { windowS: 10 });
    if (semFstim.ok) assert(semFstim.byHemisphere.Left.entrainmentChecked === false,
      'sem f_stim a checagem foi marcada como feita');
    return `recusado · variante sob pedido marcada · sem f_stim: entrainmentChecked = ` +
      `${semFstim.ok ? semFstim.byHemisphere.Left.entrainmentChecked : 'recusado antes'}`;
  });

  /* 3b. sem pico individual, nada de troca silenciosa ---------------------- */
  t('sem pico individual de gama o ODR recusa, em vez de trocar por banda larga em silêncio', () => {
    const x = sinalJ(120, tt => oscJ(tt, 6, 4) + oscJ(tt, 16, 5), 19);
    const r = C.odrSeries({ hemispheres: { Left: { x, fs: FSJ, stimRateHz: 130 } } }, { windowS: 10 });
    assert(!r.ok, 'calculou o ODR sem pico de gama identificado');
    assert(/gama|saliência/i.test(r.reason), 'recusou sem explicar: ' + r.reason);
    const larga = C.odrSeries({ hemispheres: { Left: { x, fs: FSJ, stimRateHz: 130 } } }, { windowS: 10, gammaSource: 'broad' });
    assert(larga.ok, 'a banda larga não saiu nem sendo pedida explicitamente');
    assert(larga.byHemisphere.Left.gammaSource === 'broad', 'a origem da gama não foi marcada');
    const tab = C.windowedFeatureTable({ odr: larga, channels: { Left: '0-2' } });
    assert(tab.rows.every(l => l.gamma_source === 'broad'), 'a origem da gama não sai marcada em cada linha exportada');
    return `recusa sem pico · banda larga só sob pedido, marcada em ${tab.rows.length} linha(s)`;
  });

  /* 4. coerência sob a nula ------------------------------------------------ */
  t('sob a nula a coerência fica perto de 1/L, não de zero, e o limiar corrigido segura o falso positivo', () => {
    const a = sinalJ(200, () => 0, 21), b = sinalJ(200, () => 0, 99);
    const r = C.windowedCoherence(a, b, FSJ, { windowS: 10, alpha: 0.05, bands: [{ id: 'lowBeta', lo: 12, hi: 20 }] });
    assert(r.ok, 'coerência não calculada: ' + r.reason);
    const Lef = r.windows[0].nSegmentsEffective;
    const nula = 1 / Lef;
    const s = r.byBand.lowBeta;
    assert(Math.abs(s.meanBandCoherence - nula) < 0.05,
      `a coerência média da banda deveria ficar perto de 1/L = ${nula.toFixed(3)}, deu ${s.meanBandCoherence}`);
    assert(s.meanBandCoherence > 0.02, 'a coerência sob a nula NÃO é zero — se der zero, o cálculo está errado');
    assert(s.fractionAboveThreshold <= 0.15,
      `com limiar corrigido a fração de falsos positivos deveria ficar perto de α = 0,05, deu ${s.fractionAboveThreshold}`);
    /* o limiar da banda tem de ser MAIOR que o do bin: é a correção de Šidák */
    assert(r.windows[0].byBand.lowBeta.threshold > r.windows[0].thresholdPerBin,
      'o limiar da banda não está corrigido para o número de bins — trocar por limiar fixo passa despercebido aqui');
    return `L_eff ${Lef} · 1/L ${nula.toFixed(3)} · coerência média da banda ${s.meanBandCoherence} · ` +
      `fração acima ${s.fractionAboveThreshold} · limiar bin ${r.windows[0].thresholdPerBin} → banda ${r.windows[0].byBand.lowBeta.threshold}`;
  });

  /* 5. discriminante de fase zero ------------------------------------------ */
  t('sinal compartilhado dá coerência alta com parte imaginária nula; com atraso, a imaginária sobe', () => {
    const base = sinalJ(120, tt => oscJ(tt, 16, 6) + oscJ(tt, 6, 3), 31);
    const copia = Float64Array.from(base);
    const dAmostras = Math.round(0.008 * FSJ);           /* 8 ms */
    const atrasado = new Float64Array(base.length);
    for (let i = 0; i < base.length; i++) atrasado[i] = base[Math.max(0, i - dAmostras)];
    const B = [{ id: 'lowBeta', lo: 12, hi: 20 }];
    const r0 = C.windowedCoherence(base, copia, FSJ, { windowS: 10, bands: B });
    const r8 = C.windowedCoherence(base, atrasado, FSJ, { windowS: 10, bands: B });
    const s0 = r0.byBand.lowBeta, s8 = r8.byBand.lowBeta;
    assert(s0.meanCoherence > 0.9, 'sinal idêntico deveria dar coerência ~1, deu ' + s0.meanCoherence);
    assert(Math.abs(s0.meanImag) < 0.05, 'com atraso zero a parte imaginária deveria ser ~0, deu ' + s0.meanImag);
    assert(s0.nVolumeConductionSuspected === s0.nAboveThreshold && s0.nAboveThreshold > 0,
      'o veredito de condução de volume não foi levantado em todas as janelas de fase zero');
    assert(Math.abs(s8.meanImag) > 0.3, 'com 8 ms de atraso a parte imaginária deveria subir, deu ' + s8.meanImag);
    assert(s8.nVolumeConductionSuspected === 0, 'com defasagem real o veredito de condução de volume não deveria ser levantado');
    return `atraso 0: coer ${s0.meanCoherence}, imag ${s0.meanImag}, ${s0.nVolumeConductionSuspected}/${s0.nAboveThreshold} marcadas · ` +
      `atraso 8 ms: coer ${s8.meanCoherence}, imag ${s8.meanImag}, ${s8.nVolumeConductionSuspected} marcadas`;
  });

  /* 5b. pareamento --------------------------------------------------------- */
  t('canais de registros diferentes não geram coerência: a recusa vem antes do cálculo', () => {
    const a = sinalJ(60, tt => oscJ(tt, 16, 5), 61);
    const b = sinalJ(60, tt => oscJ(tt, 16, 5), 62);
    const bom = C.interSTNCoherence(
      { x: a, fs: FSJ, t0: '2025-01-06T11:40:00Z' },
      { x: b, fs: FSJ, t0: '2025-01-06T11:40:00Z' }, { windowS: 10 });
    assert(bom.ok, 'recusou dois canais do mesmo registro: ' + bom.reason);
    const ruim = C.interSTNCoherence(
      { x: a, fs: FSJ, t0: '2025-01-06T11:40:00Z' },
      { x: b, fs: FSJ, t0: '2025-02-10T09:00:00Z' }, { windowS: 10 });
    assert(!ruim.ok, 'calculou coerência entre canais de sessões diferentes');
    assert(/mesmo registro|base de tempo/.test(ruim.reason), 'recusou sem explicar: ' + ruim.reason);
    assert(ruim.pairing.mismatches.some(m => /FirstPacketDateTime/.test(m.field)), 'não disse qual campo divergiu');
    const curto = C.interSTNCoherence(
      { x: a, fs: FSJ, t0: 'x' }, { x: b.subarray(0, 1000), fs: FSJ, t0: 'x' }, { windowS: 10 });
    assert(!curto.ok, 'aceitou canais de comprimentos diferentes');
    return `mesmo registro: aceito · data diferente e comprimento diferente: recusados com o campo divergente nomeado`;
  });

  /* 6. bordas da variação espectral ---------------------------------------- */
  t('o CV depende da política de borda e do comprimento da janela — e a diferença é medida', () => {
    const x = sinalJ(120, tt => oscJ(tt, 16, 5 * (1 + 0.5 * Math.sin(2 * Math.PI * 0.05 * tt))), 41);
    const inteiro = C.spectralVariation(x, FSJ, 12, 20, { windowS: 10 });
    const isolada = C.spectralVariation(x, FSJ, 12, 20, { windowS: 10, perWindow: true });
    const j30 = C.spectralVariation(x, FSJ, 12, 20, { windowS: 30 });
    assert(inteiro.ok && isolada.ok && j30.ok, 'algum modo não produziu CV');
    const dif = Math.abs(isolada.meanCv - inteiro.meanCv) / inteiro.meanCv;
    assert(dif > 0.01, 'os dois modos deram o MESMO CV — a política de borda deixou de ter efeito, o que não é esperado');
    assert(j30.meanCv > inteiro.meanCv * 1.3,
      `o CV deveria crescer com a janela: 10 s deu ${inteiro.meanCv}, 30 s deu ${j30.meanCv}`);
    assert(inteiro.windowS === 10 && j30.windowS === 30, 'o comprimento da janela não sai na saída');
    assert(/registro inteiro/.test(inteiro.edgePolicy) && /janela isolada/.test(isolada.edgePolicy),
      'a política de borda não é declarada');
    return `registro inteiro ${inteiro.meanCv} · janela isolada ${isolada.meanCv} (${(100 * dif).toFixed(1)}% de diferença) · ` +
      `janela de 30 s ${j30.meanCv}`;
  });

  /* 7. propagação de NaN --------------------------------------------------- */
  t('janela com lacuna sai NaN com motivo nas três features, nunca calculada sobre o que sobrou', () => {
    const x = sinalJ(120, tt => oscJ(tt, 6, 4) + oscJ(tt, 16, 5) + oscJ(tt, 72, 4), 51);
    for (let i = 30 * FSJ; i < 34 * FSJ; i++) x[i] = NaN;
    const y = sinalJ(120, tt => oscJ(tt, 16, 5), 52);
    const cv = C.spectralVariation(x, FSJ, 12, 20, { windowS: 10 });
    const bp = C.windowedBandPower(x, FSJ, [{ id: 'lowBeta', lo: 12, hi: 20 }], { windowS: 10 });
    const co = C.windowedCoherence(x, y, FSJ, { windowS: 10, bands: [{ id: 'lowBeta', lo: 12, hi: 20 }] });
    const k = 3;                                  /* janela de 30 a 40 s */
    assert(!isFinite(cv.windows[k].cv), 'o CV foi calculado sobre uma janela com 40% de lacuna');
    assert(/ausentes/.test(cv.windows[k].reason || ''), 'o CV saiu NaN sem motivo');
    assert(!isFinite(bp.windows[k].power.lowBeta), 'a potência foi calculada sobre uma janela com lacuna');
    assert(/ausentes/.test(bp.windows[k].reason || ''), 'a potência saiu NaN sem motivo');
    assert(!co.windows[k].byBand.lowBeta, 'a coerência foi calculada sobre uma janela com lacuna');
    assert(/ausentes/.test(co.windows[k].reason || ''), 'a coerência saiu nula sem motivo');
    /* e as janelas vizinhas continuam válidas: a lacuna não contamina o resto */
    assert(isFinite(cv.windows[0].cv) && isFinite(bp.windows[0].power.lowBeta), 'a lacuna contaminou janelas sem lacuna');
    assert(cv.windows[k].pctNan > 30, 'a contabilidade da lacuna não foi reportada');
    return `janela ${k}: ${cv.windows[k].pctNan}% de lacuna · CV, potência e coerência ausentes com motivo · vizinhas intactas`;
  });

  /* 8. tabela tidy e CSV --------------------------------------------------- */
  t('a tabela por janela × hemisfério tem cabeçalho em inglês e o CSV se explica sozinho', () => {
    const x = sinalJ(120, tt => oscJ(tt, 6, 4) + oscJ(tt, 16, 5) + oscJ(tt, 72, 4), 71);
    const odr = C.odrSeries({ hemispheres: { Left: { x, fs: FSJ, stimRateHz: 130 } } }, { windowS: 10 });
    assert(odr.ok, 'ODR não calculado: ' + odr.reason);
    const cvv = { Left: C.odrSpectralVariation({ x, fs: FSJ }, { windowS: 10, gammaBand: odr.byHemisphere.Left.gammaBand }) };
    const ent = { odr, cv: cvv, channels: { Left: '0-2' }, fs: { Left: FSJ } };
    const tab = C.windowedFeatureTable(ent);
    assert(tab.ok && tab.rows.length === odr.byHemisphere.Left.windows.length, 'tabela com número de linhas inesperado');
    C.WINDOWED_COLUMNS.forEach(c => {
      assert(/^[a-z0-9_]+$/.test(c), 'cabeçalho fora do padrão em inglês minúsculo: ' + c);
      assert(c in tab.rows[0], 'coluna declarada e ausente da linha: ' + c);
    });
    ['window_index', 't_center_s', 'odr_log', 'odr_literal', 'cv_theta', 'device_state', 'gamma_source', 'odr_valid']
      .forEach(c => assert(C.WINDOWED_COLUMNS.indexOf(c) >= 0, 'coluna obrigatória ausente: ' + c));
    const csv = C.windowedFeatureCsv(ent, 'teste');
    const linhas = csv.split('\n');
    const meta = linhas.filter(l => l.startsWith('#'));
    assert(meta.length >= 12, 'bloco de metadados curto demais: ' + meta.length + ' linhas');
    ['window_s', 'z_score_policy', 'gamma_peak_definition', 'entrainment_check', 'ssd_not_applied']
      .forEach(k => assert(meta.some(l => l.startsWith('# ' + k)), 'metadado obrigatório ausente: ' + k));
    assert(/SSD is not implementable/.test(csv), 'o CSV não declara que o passo de SSD não foi aplicado');
    assert(/balanced accuracy of 0.61/.test(csv), 'o CSV não declara o desempenho esperado do marcador');
    const cab = linhas.find(l => !l.startsWith('#'));
    assert(cab === C.WINDOWED_COLUMNS.join(','), 'o cabeçalho do CSV não bate com as colunas declaradas');
    return `${tab.rows.length} linha(s) · ${C.WINDOWED_COLUMNS.length} colunas · ${meta.length} linhas de metadado`;
  });

  /* 9. as limitações não ficam só no código -------------------------------- */
  t('as limitações do Percept em relação ao protocolo de origem saem na estrutura, não em nota de rodapé', () => {
    assert(Array.isArray(C.ODR_LIMITACOES) && C.ODR_LIMITACOES.length >= 4, 'a tabela de limitações não está exportada');
    const texto = C.ODR_LIMITACOES.map(l => `${l.item} ${l.artigo} ${l.percept} ${l.consequencia}`).join(' | ');
    ['SSD', 'estimulação', 'externalizados', 'não são comparáveis'].forEach(k =>
      assert(new RegExp(k, 'i').test(texto), 'limitação ausente: ' + k));
    C.ODR_LIMITACOES.forEach(l => {
      assert(l.artigo && l.percept && l.consequencia, 'limitação sem artigo/percept/consequência: ' + l.item);
    });
    assert(/0,61/.test(C.ODR_EXPECTATIVA) && /8 de 21/.test(C.ODR_EXPECTATIVA),
      'a expectativa de desempenho do artigo não está declarada');
    assert(/exploratório/.test(C.ODR_EXPECTATIVA), 'a expectativa não diz que o marcador é exploratório');
    return `${C.ODR_LIMITACOES.length} limitações estruturadas · expectativa com os números do artigo`;
  });

  /* 10. F34 ---------------------------------------------------------------- */
  t('F34 existe, mora na aba Agudo e renderiza', () => {
    const fig = H.FIGURES.find(x => x.id === 'F34');
    assert(fig, 'F34 não está registrada');
    const aba = H.ABAS.find(a => (a.figuras || []).indexOf('F34') >= 0);
    assert(aba && aba.id === 'agudo', 'F34 deveria morar na aba Agudo');
    const d = H.ds();
    assert(fig.has(d), 'F34 se declara indisponível sobre o exemplo, que tem sinal bruto');
    const n = document.createElement('div');
    fig.render(n, d);
    const varre = (x, acc) => {
      acc.tags.push(x.tagName || (typeof x.getContext === 'function' ? 'CANVAS' : '?'));
      acc.txt += ' ' + (x.textContent || '') + ' ' + (x.innerHTML || '');
      (x.children || []).forEach(c => varre(c, acc));
      return acc;
    };
    const a = varre(n, { tags: [], txt: '' });
    assert(a.tags.filter(x => x === 'CANVAS').length >= 2, 'F34 desenhou menos painéis do que deveria');
    assert(/sem SSD|SSD/.test(a.txt), 'F34 não avisa na interface que o passo de SSD não foi aplicado');
    assert(/0,61|0\.61/.test(a.txt), 'F34 não mostra a acurácia balanceada do estudo original');
    assert(/não afirma|não é detecção|sem rótulo/i.test(a.txt), 'F34 não escreve a fronteira: sem rótulo clínico não há detecção de discinesia');
    return `${a.tags.filter(x => x === 'CANVAS').length} painéis · limitações e fronteira no texto da interface`;
  });
}


/* --------- conformidade com o white paper de sensing da Medtronic --------- */
sec('conformidade com o white paper do fabricante (UC202012929cEN FY24)');
{
  const baseJson = () => JSON.parse(fs.readFileSync(path.join(PASTA, arquivos[0]), 'utf8'));

  /* A1 — dado censurado é negativo ---------------------------------------- */
  t('A1: valor negativo do Timeline é CENSURA, não potência, e não entra em conta nenhuma', () => {
    const j = baseJson();
    const tl = j.DiagnosticData && j.DiagnosticData.LFPTrendLogs;
    assert(tl, 'o exemplo precisa ter LFPTrendLogs para este teste');
    let plantados = 0;
    Object.keys(tl).forEach(hk => Object.keys(tl[hk]).forEach(day => {
      tl[hk][day].forEach((r, i) => { if (i % 17 === 0) { r.LFP = -Math.abs(r.LFP || 1); plantados++; } });
    }));
    const p = C.parsePercept(j, 'censurado.json');
    const todas = Object.keys(p.trend).flatMap(h => p.trend[h]);
    assert(!todas.some(r => isFinite(r.lfp) && r.lfp < 0), 'valor negativo sobreviveu como potência');
    const cont = Object.keys(p.trendCensoring).reduce((a, h) => a + p.trendCensoring[h].nCensoredLfp, 0);
    assert(cont === plantados, `contabilidade da censura: ${cont} ≠ ${plantados} plantados`);
    /* a contagem é SEPARADA da perda de pacote — são coisas diferentes */
    const cs = C.censoringSummary([p]);
    assert(cs.ok && cs.nCensored === plantados, 'censoringSummary não bate: ' + cs.nCensored);
    assert(/independente|INDEPENDENTE/.test(cs.separateFromPacketLoss), 'não declara a separação da perda de pacote');
    /* e as estatísticas a jusante ignoram os NaN em vez de somá-los */
    const rows = p.trend[Object.keys(p.trend)[0]];
    const vals = rows.map(r => r.lfp);
    const st = C.thresholdSummary(vals, 30, 45);
    assert(st.n === vals.filter(isFinite).length, 'thresholdSummary contou amostra censurada');
    assert(C.actigraphyPanel(rows, -180, {}).ok, 'a actigrafia quebrou com censura na série');
    return `${plantados} censuradas · ${cs.pctCensored}% do total · contabilidade separada da perda de pacote`;
  });

  t('A1: FFTBinData negativo também é censura, e é contado', () => {
    const j = baseJson();
    const ev = j.DiagnosticData && j.DiagnosticData.LfpFrequencySnapshotEvents;
    if (!ev || !ev.length) return 'o exemplo não tem snapshots de evento — nada a verificar';
    let plantados = 0;
    ev.forEach(e => Object.keys(e.LfpFrequencySnapshotEvents || {}).forEach(hk => {
      const h = e.LfpFrequencySnapshotEvents[hk];
      if (h && Array.isArray(h.FFTBinData)) h.FFTBinData.forEach((v, i) => {
        if (i % 23 === 0) { h.FFTBinData[i] = -Math.abs(v || 1); plantados++; }
      });
    }));
    const p = C.parsePercept(j, 'snapcens.json');
    const blocos = p.snapshots.flatMap(s => Object.keys(s.hemi).map(h => s.hemi[h]));
    assert(!blocos.some(b => b.p.some(v => isFinite(v) && v < 0)), 'magnitude negativa sobreviveu no snapshot');
    const cont = blocos.reduce((a, b) => a + (b.nCensored || 0), 0);
    assert(cont === plantados, `censura do snapshot: ${cont} ≠ ${plantados}`);
    return `${plantados} bins censurados em ${blocos.length} espectro(s)`;
  });

  /* A2 — cap de sequência por modelo -------------------------------------- */
  t('A2: o cap de volta das sequências depende do modelo, e sem modelo o software NÃO escolhe', () => {
    const pc = C.sequenceCapForModel('Percept PC B35200');
    const rc = C.sequenceCapForModel('B35300 Percept RC');
    const nd = C.sequenceCapForModel('');
    assert(pc.cap === 256, 'Percept PC deveria ter cap 256, veio ' + pc.cap);
    assert(rc.cap === 65536, 'Percept RC deveria ter cap 65 536, veio ' + rc.cap);
    assert(nd.cap === null, 'sem modelo o cap deveria ser null, veio ' + nd.cap);
    /* série de um RC que passa de 65 535 para 0: com o cap certo, perda zero */
    const SZ = 63, FS = 250, MS = SZ / FS * 1000;
    const seq = [], ticks = [], sizes = [];
    for (let i = 0; i < 20; i++) { seq.push((65530 + i) % 65536); ticks.push(Math.round(i * MS)); sizes.push(SZ); }
    const dados = new Float64Array(20 * SZ);
    const certo = C.analyzePackets({ data: dados, fs: FS, packetSizes: sizes, ticksMs: ticks, sequences: seq, stream: 'IndefiniteStreaming', deviceModel: 'B35300' });
    assert(certo.method === 'sequences' && certo.sequenceCap === 65536, 'não usou o cap do RC: ' + certo.sequenceCap);
    assert(certo.nMissing === 0, 'cap correto do RC ainda reportou perda: ' + certo.nMissing);
    const errado = C.unwrapCounter(seq, 256);
    assert(errado[6] - errado[5] !== 1, 'o cap errado deveria produzir salto — o teste não está exercitando o risco');
    /* sem modelo declarado, cai para os ticks e diz por quê */
    const semModelo = C.analyzePackets({ data: dados, fs: FS, packetSizes: sizes, ticksMs: ticks, sequences: seq, stream: 'IndefiniteStreaming' });
    assert(semModelo.method === 'ticks', 'sem modelo deveria cair para ticks, usou ' + semModelo.method);
    assert(/modelo/.test(semModelo.whySequencesUnused || ''), 'não explicou por que não usou as sequências');
    return `PC 256 · RC 65 536 · sem modelo: método ${semModelo.method} com motivo declarado`;
  });

  /* A3 — sequências intercaladas ------------------------------------------ */
  t('A3: em BrainSenseTimeDomain e BrainSenseLfp as sequências são intercaladas — e não viram perda falsa', () => {
    const SZ = 63, FS = 250, MS = SZ / FS * 1000, N = 40;
    const seq = [], ticks = [], sizes = [];
    /* o fluxo do domínio do tempo leva os pares; os ímpares são do fluxo de
       potência. Um salto de 2 é o comportamento NORMAL. */
    for (let i = 0; i < N; i++) { seq.push((2 * i) % 256); ticks.push(Math.round(i * MS)); sizes.push(SZ); }
    const dados = new Float64Array(N * SZ);
    const comum = { data: dados, fs: FS, packetSizes: sizes, ticksMs: ticks, sequences: seq, deviceModel: 'B35200' };
    const simples = C.analyzePackets(Object.assign({ stream: 'LfpMontageTimeDomain' }, comum));
    const stream = C.analyzePackets(Object.assign({ stream: 'BrainSenseTimeDomain' }, comum));
    assert(simples.method === 'sequences', 'num fluxo não intercalado as sequências deveriam ser usadas');
    assert(simples.pctMissing > 40, 'a construção não reproduz a perda falsa: ' + simples.pctMissing);
    assert(stream.method === 'ticks', 'em BrainSenseTimeDomain o método deveria ser ticks, veio ' + stream.method);
    assert(stream.nMissing === 0, `perda falsa em fluxo intercalado: ${stream.pctMissing.toFixed(1)}%`);
    assert(stream.interleavedSequences === true, 'não marcou o fluxo como intercalado');
    assert(/intercalad/.test(stream.whySequencesUnused || ''), 'não explicou a intercalação');
    const lfp = C.analyzePackets(Object.assign({ stream: 'BrainSenseLfp' }, comum));
    assert(lfp.method === 'ticks', 'BrainSenseLfp também é intercalado');
    return `lido como fluxo simples: ${simples.pctMissing.toFixed(1)}% de perda falsa · lido como streaming: ${stream.pctMissing.toFixed(1)}%`;
  });

  /* A4 — volta dos ticks --------------------------------------------------- */
  t('A4: a volta dos ticks usa o período documentado, e ausência de volta é o caso esperado', () => {
    assert(C.TICKS_ROLLOVER_MS === 65536 * 50, 'período documentado errado: ' + C.TICKS_ROLLOVER_MS);
    const SZ = 63, FS = 250, MS = SZ / FS * 1000;
    /* série que dá a volta no período DOCUMENTADO */
    const base = [];
    for (let i = 0; i < 40; i++) base.push(Math.round(i * MS));
    const doc = base.map(v => (v + C.TICKS_ROLLOVER_MS - 3000) % C.TICKS_ROLLOVER_MS);
    assert(doc.some((v, i) => i > 0 && v < doc[i - 1]), 'a construção precisa conter uma volta');
    const u = C.unwrapTicks(doc);
    for (let i = 1; i < u.length; i++) assert(u[i] > u[i - 1], 'desenrolar falhou em ' + i);
    assert(u.capUsed === C.TICKS_ROLLOVER_MS && u.fallback === false, 'não usou o período documentado');
    assert(/UC202012929cEN/.test(u.note || ''), 'não cita a fonte do período');
    /* sem volta: o caso esperado durante o streaming, sem heurística nenhuma */
    const semVolta = C.unwrapTicks(base);
    assert(semVolta.fallback === false && semVolta.capUsed === null, 'sem volta não deveria haver cap');
    assert(/streaming/i.test(semVolta.note || ''), 'não declara que ausência de volta é o esperado em streaming');
    return `período ${C.TICKS_ROLLOVER_MS} ms (65 536 × 50) · sem volta: sem heurística, com o motivo declarado`;
  });

  /* A5 — estado da estimulação por modalidade ------------------------------ */
  t('A5: CalibrationTests é ON e SenseChannelTests é OFF — o par que faltava disparar', () => {
    const cal = C.documentedStimState('CalibrationTests');
    const sen = C.documentedStimState('SenseChannelTests');
    assert(cal.state === 'ON', 'CalibrationTests deveria ser ON, veio ' + cal.state);
    assert(sen.state === 'OFF', 'SenseChannelTests deveria ser OFF, veio ' + sen.state);
    assert(cal.page === 15 && sen.page === 15, 'a página da fonte não está declarada');
    assert(C.documentedStimState('IndefiniteStreaming').state === 'OFF', 'Record Streaming é com estimulação desligada');
    assert(C.documentedStimState('BrainSenseTimeDomain').state === 'USER', 'streaming é estado definido pelo usuário');
    const base = { groups: [], eventLogs: [] };
    const a = C.inferDeviceState({ hemisphere: 'Left' }, base, { modality: 'CalibrationTests' });
    const b = C.inferDeviceState({ hemisphere: 'Left' }, base, { modality: 'SenseChannelTests' });
    assert(a.state !== b.state, 'o par OFF/ON da mesma sessão continua indistinguível');
    assert(a.confidence === 'documentada' && b.confidence === 'documentada', 'a confiança deveria ser documentada');
    const cmp = C.statesComparable(a, b);
    assert(!cmp.comparable, 'espectros de estados diferentes não deveriam ser comparáveis');
    assert(!/\[object Object\]/.test(cmp.reason), 'a razão saiu com [object Object] em vez do nome do estado');
    return `Calibration ${a.state} vs SenseChannel ${b.state} · comparação recusada com o motivo legível`;
  });

  /* A6 — piso de quantização do carimbo ------------------------------------ */
  t('A6: o alinhamento por carimbo declara o piso de ±1 s, que é por construção', () => {
    const r = C.alignByTimestamp(1000000, 1002500);
    assert(r.ok, 'alinhamento não calculado');
    assert(r.quantizationMs === 1000, 'piso de quantização ausente: ' + r.quantizationMs);
    assert(r.uncertaintyFloorMs === 1000, 'piso de incerteza ausente');
    assert(/1 s|1000 ms/.test(r.caveat), 'a ressalva não menciona o piso');
    assert(/necessário/.test(r.caveat), 'a ressalva não diz que o artefato de estimulação passa a ser necessário');
    return `lag ${r.lagMs} ms com piso declarado de ±${r.uncertaintyFloorMs} ms`;
  });

  /* B1/B4 — filtros e blanking de GroupSettings ---------------------------- */
  t('B1/B4: o passa-alta e o blanking saem de GroupSettings, e 10 Hz vira ALARME', () => {
    const j = baseJson();
    const g = ((j.Groups || {}).Final || (j.Groups || {}).Initial || [])[0];
    assert(g && g.GroupSettings, 'o exemplo precisa ter GroupSettings');
    g.GroupSettings.HighPassFilterInHertz = 1;
    const p1 = C.parsePercept(j, 'hp1.json');
    assert(p1.filters.highPassConfigurableHz === 1, 'não extraiu o passa-alta: ' + p1.filters.highPassConfigurableHz);
    assert(/GroupSettings/.test(p1.filters.highPassSource || ''), 'não declara de onde veio o passa-alta');
    assert(isFinite(p1.filters.senseBlankingUs), 'não extraiu o blanking de GroupSettings');
    assert(/GroupSettings/.test(p1.filters.senseBlankingSource || ''), 'não declara a precedência do blanking');
    assert(/100 Hz/.test(p1.filters.description) && /1 Hz fixo/.test(p1.filters.description), 'a cadeia de filtros não é descrita');
    assert(p1.filters.lowBandUsable === true, 'com 1 Hz as bandas lentas são utilizáveis');
    assert(!(C.artifactAlarm(p1, {}).alarms || []).some(a => a.id === 'passaalta'), 'alarme de passa-alta com 1 Hz');
    g.GroupSettings.HighPassFilterInHertz = 10;
    const p10 = C.parsePercept(j, 'hp10.json');
    assert(p10.filters.lowBandUsable === false, 'com 10 Hz as bandas lentas NÃO são utilizáveis');
    const al = (C.artifactAlarm(p10, {}).alarms || []).find(a => a.id === 'passaalta');
    assert(al, 'passa-alta em 10 Hz não gerou alarme');
    assert(al.severity === 'critico' && al.verdict === 'não interprete este canal', 'gravidade errada: ' + al.severity);
    assert(/teta|delta/i.test(al.plain), 'o alarme não diz quais bandas foram removidas');
    assert(/ODR|F34/.test(al.whatToDo), 'o alarme não avisa que o termo teta do ODR fica comprometido');
    return `1 Hz: sem alarme · 10 Hz: ${al.severity} · blanking ${p1.filters.senseBlankingUs} µs de ${p1.filters.senseBlankingSource}`;
  });

  /* B2/B3 — largura e unidade documentadas --------------------------------- */
  t('B2/B3: a largura de 5 Hz e a unidade do Timeline deixam de ser suposição', () => {
    const b = C.configBlocks(parsed, -180, {});
    assert(/documentada/.test(b.bandwidthSource), 'a largura ainda sai como assumida: ' + b.bandwidthSource);
    assert(/UC202012929cEN/.test(b.bandwidthSource), 'a largura não cita a fonte');
    assert(/aproximadamente|não verificável/.test(b.bandwidthSource), 'a ressalva sobre a largura exata sumiu');
    assert(/soma do quadrado/.test(C.LFP_POWER_UNIT.label), 'a unidade não descreve a soma de quadrados');
    assert(/µVp²/.test(C.LFP_POWER_UNIT.short), 'unidade curta errada: ' + C.LFP_POWER_UNIT.short);
    assert(/MUDA A ESCALA|muda a escala/.test(C.LFP_POWER_UNIT.scaleWarning), 'não avisa que a largura muda a escala');
    return `${b.bandwidthHz} Hz · ${C.LFP_POWER_UNIT.short} — ${C.LFP_POWER_UNIT.label}`;
  });

  /* B5 — FullyReadForSession ----------------------------------------------- */
  t('B5: com a leitura incompleta, ausência de modalidade deixa de ser ausência de registro', () => {
    const j = baseJson();
    j.FullyReadForSession = false;
    const p = C.parsePercept(j, 'parcial.json');
    assert(p.meta.fullyRead === false, 'não leu FullyReadForSession');
    assert(/pode existir no aparelho|não conclua/.test(p.meta.fullyReadNote), 'a nota não faz a distinção que importa');
    assert(/UC202012929cEN/.test(p.meta.fullyReadNote), 'a nota não cita a fonte');
    j.FullyReadForSession = true;
    assert(C.parsePercept(j, 'ok.json').meta.fullyRead === true, 'não leu o caso verdadeiro');
    delete j.FullyReadForSession;
    const semCampo = C.parsePercept(j, 'sem.json');
    assert(semCampo.meta.fullyRead === null, 'campo ausente deveria dar null, não false');
    assert(/não declara/.test(semCampo.meta.fullyReadNote), 'não distingue campo ausente de leitura incompleta');
    return 'false, true e ausente produzem três leituras diferentes — como devem';
  });

  /* C1 — IndefiniteStreaming ----------------------------------------------- */
  t('C1: Record Streaming (IndefiniteStreaming) é parseado e aparece no inventário', () => {
    assert(C.MODALITIES.some(([k]) => k === 'indefiniteStreaming'), 'a modalidade não está no inventário');
    const j = baseJson();
    /* constrói um Record Streaming com a mesma forma das demais séries */
    const n = 250 * 8, dados = [];
    for (let i = 0; i < n; i++) dados.push(Math.sin(2 * Math.PI * 20 * i / 250));
    j.IndefiniteStreaming = [{
      Channel: 'ZERO_TWO_LEFT', SampleRateInHz: 250, TimeDomainData: dados,
      GlobalPacketSizes: new Array(Math.floor(n / 63)).fill(63).join(','),
      TicksInMses: Array.from({ length: Math.floor(n / 63) }, (_, i) => Math.round(i * 63 / 250 * 1000)).join(','),
      FirstPacketDateTime: '2025-01-06T11:00:00Z'
    }];
    const p = C.parsePercept(j, 'indef.json');
    assert(p.indefiniteStreaming.length === 1, 'não parseou o IndefiniteStreaming');
    const td = p.indefiniteStreaming[0];
    assert(td.data.length >= n - 63, 'série truncada: ' + td.data.length);
    assert(td.hemisphere === 'Left', 'hemisfério não reconhecido: ' + td.hemisphere);
    assert(td.packets && td.packets.method !== 'none', 'a integridade não foi verificada');
    assert(p.availability.indefiniteStreaming === 1, 'não entrou na matriz de disponibilidade');
    /* e o estado documentado é OFF — que é o que torna esta modalidade valiosa */
    assert(C.documentedStimState('IndefiniteStreaming').state === 'OFF', 'Record Streaming é sem estimulação');
    return `${td.label} · ${td.data.length} amostras · integridade por ${td.packets.method} · estimulação OFF documentada`;
  });

  /* C2 — Thresholds -------------------------------------------------------- */
  t('C2: a série de potência que originou os limiares é parseada, com o procedimento declarado', () => {
    const j = baseJson();
    j.Thresholds = [{
      Hemisphere: 'HemisphereLocationDef.Left', SampleRateInHz: 2,
      FirstPacketDateTime: '2025-01-06T11:30:00Z',
      LFPDataLeft: [10, 12, 11, 9, -1, 8, 7]
    }];
    const p = C.parsePercept(j, 'thr.json');
    assert(p.thresholdRuns.length === 1, 'não parseou Thresholds');
    const r = p.thresholdRuns[0];
    assert(r.byHemisphere.Left, 'hemisfério não extraído');
    assert(r.byHemisphere.Left.nCensored === 1, 'o negativo do domínio de potência não foi contado como censura');
    assert(!r.byHemisphere.Left.lfp.some(v => isFinite(v) && v < 0), 'valor negativo sobreviveu');
    assert(/amplitude .*BAIXA|amplitude/i.test(r.procedure), 'o procedimento de captura não está declarado');
    assert(/UC202012929cEN/.test(r.source), 'a fonte não está declarada');
    return `${r.byHemisphere.Left.n} pontos a ${r.fs} Hz · ${r.byHemisphere.Left.nCensored} censurado(s) · procedimento declarado`;
  });

  /* D2 — limiares do fabricante -------------------------------------------- */
  t('D2: os limiares de impedância são os do fabricante, e a faixa habitual é declarada como referência', () => {
    assert(C.IMPEDANCE_LIMITS.shortOhms['1x4'] === 250, 'curto do 1x4 errado');
    assert(C.IMPEDANCE_LIMITS.shortOhms.sensight === 350, 'curto do SenSight errado');
    assert(C.IMPEDANCE_LIMITS.openOhms === 10000, 'aberto errado');
    assert(C.shortThresholdOhms('B33005') === 350, 'SenSight deveria usar 350 Ω');
    assert(C.shortThresholdOhms('3389') === 250, 'eletrodo 1x4 deveria usar 250 Ω');
    assert(/NÃO é critério do dispositivo/.test(C.IMPEDANCE_LIMITS.usualRangeNote), 'a faixa habitual não é declarada como referência');
    assert(/excl/i.test(C.IMPEDANCE_LIMITS.exclusionNote), 'não diz que o dispositivo exclui canais');
    return `curto <250 Ω (1x4) / <350 Ω (SenSight) · aberto >10 kΩ · faixa 500–2000 Ω só como referência`;
  });

  /* D4 — protocolo de sincronização ---------------------------------------- */
  t('D4: o protocolo de sincronização do fabricante está no software, com o marcador no fim', () => {
    const sp = C.SYNC_PROTOCOL;
    assert(sp.coarse.length >= 3 && sp.fine.length >= 4, 'protocolo incompleto');
    assert(sp.fine.some(x => /50\s*Hz/.test(x)), 'não traz a frequência recomendada de 50 Hz');
    assert(sp.fine.some(x => /NOVAMENTE|fim/i.test(x)), 'não pede o marcador no FIM da sessão');
    assert(/deriva/.test(sp.fineNote), 'não explica que o marcador no fim é o que revela a deriva');
    assert(sp.coarse.some(x => /Update Device Time/i.test(x)), 'não traz a sincronização grosseira do relógio');
    assert(/UC202012929cEN/.test(sp.source), 'a fonte não está declarada');
    return `${sp.coarse.length} passos grosseiros · ${sp.fine.length} finos · marcador no início E no fim`;
  });

  /* E1 — o eixo confirmado, e a constante que não está no documento -------- */
  t('E1: o eixo de frequência do PSD de bordo bate com os 0,98 Hz e 96,68 Hz documentados', () => {
    const fs = 250, n = fs * 4;
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * 20 * i / fs);
    const sp = C.spectrogramPercept(x, fs, {});
    assert(sp && sp.freqs && sp.freqs.length, 'emulação não produziu eixo de frequência');
    const df = sp.freqs[1] - sp.freqs[0];
    assert(Math.abs(df - 250 / 256) < 1e-6, `largura do bin deveria ser 250/256 = 0,977 Hz, veio ${df}`);
    const fMax = sp.freqs[sp.freqs.length - 1];
    assert(fMax > 90 && fMax <= 96.7, `o eixo deveria terminar perto de 96,68 Hz, terminou em ${fMax}`);
    return `${sp.freqs.length} bins de ${df.toFixed(4)} Hz até ${fMax.toFixed(2)} Hz — bate com o documentado`;
  });
}


/* ------------------------------ geometria dos eletrodos de DBS ----------- */
sec('eletrodos: geometria em escala, detecção automática e marcação de contatos');
{
  t('o modelo é detectado do JSON, e o que não é reconhecido NÃO vira eletrodo genérico', () => {
    const casos = [
      ['LeadModelDef.B33005', 'B33005'], ['Model 3389', '3389'], ['3387', '3387'],
      ['3391', '3391'], ['B33015', 'B33015'], ['B3300533M', 'B33005']
    ];
    casos.forEach(([entrada, esperado]) => {
      const sp = C.leadSpec(entrada);
      assert(sp.identified && sp.id === esperado, `${entrada} → ${sp.id}, esperado ${esperado}`);
    });
    assert(C.leadSpec('B3300533M').bilateralMarkers === true, 'o sufixo M não foi reconhecido');
    ['', 'xyz', null].forEach(x => {
      const sp = C.leadSpec(x);
      assert(!sp.identified, `"${x}" não deveria ser identificado`);
      assert(sp.reason && sp.reason.length > 10, 'recusou sem motivo legível');
      assert(!C.leadGeometry(sp).ok, 'produziu geometria para um modelo não identificado');
    });
    /* e a detecção a partir do arquivo real */
    const L = C.leadsOf(parsed[0]);
    assert(Object.keys(L).length >= 1, 'nenhum eletrodo detectado no exemplo');
    Object.keys(L).forEach(h => assert(L[h].spec.identified, `hemisfério ${h} não identificado`));
    return `${casos.length} modelos + sufixo M · ${Object.keys(L).length} lado(s) detectado(s) no exemplo: ` +
      Object.keys(L).map(h => L[h].spec.id).join(', ');
  });

  t('a geometria reproduz as medidas do manual, e o arranjo bate com a soma das partes', () => {
    const esperado = {
      '3389': { h: 1.5, sp: 0.5, arr: 7.5, tip: 1.5, d: 1.27, fam: 'ring' },
      '3387': { h: 1.5, sp: 1.5, arr: 10.5, tip: 1.5, d: 1.27, fam: 'ring' },
      '3391': { h: 3.0, sp: 4.0, arr: 24.0, tip: 1.5, d: 1.27, fam: 'ring' },
      'B33005': { h: 1.5, sp: 0.5, arr: 7.5, tip: 1.0, d: 1.36, fam: 'directional' },
      'B33015': { h: 1.5, sp: 1.5, arr: 10.5, tip: 1.0, d: 1.36, fam: 'directional' }
    };
    Object.keys(esperado).forEach(id => {
      const e = esperado[id], sp = C.leadSpec(id), g = C.leadGeometry(sp);
      assert(g.ok, `geometria de ${id} não calculada`);
      assert(sp.family === e.fam, `${id}: família ${sp.family}`);
      assert(sp.spacingMm === e.sp, `${id}: espaçamento ${sp.spacingMm} ≠ ${e.sp}`);
      assert(sp.bodyDiameterMm === e.d, `${id}: diâmetro ${sp.bodyDiameterMm} ≠ ${e.d}`);
      assert(sp.tipMm === e.tip, `${id}: ponta ${sp.tipMm} ≠ ${e.tip}`);
      /* a extensão declarada tem de bater com 4 alturas + 3 espaçamentos */
      const calc = 4 * e.h + 3 * e.sp;
      assert(Math.abs(calc - e.arr) < 1e-9, `${id}: 4×${e.h} + 3×${e.sp} = ${calc} ≠ ${e.arr} declarado`);
      assert(Math.abs(sp.arrayLengthMm - e.arr) < 1e-9, `${id}: arranjo ${sp.arrayLengthMm} ≠ ${e.arr}`);
      /* contatos contíguos e na ordem certa: 0 é o mais distal */
      const anel = g.contacts.filter(c => c.segment === null || c.level === 0 || c.level === 3);
      assert(g.contacts[0].level === 0, `${id}: o primeiro contato deveria ser o nível 0`);
      assert(Math.abs(g.contacts[0].z0 - e.tip) < 1e-9, `${id}: o contato 0 deveria começar em ${e.tip} mm`);
      const ultimo = g.contacts[g.contacts.length - 1];
      assert(Math.abs(ultimo.z1 - (e.tip + e.arr)) < 1e-9, `${id}: o arranjo deveria terminar em ${e.tip + e.arr} mm`);
      void anel;
    });
    /* direcional: 8 contatos, com 3 segmentos nos níveis 1 e 2 */
    const gd = C.leadGeometry(C.leadSpec('B33005'));
    assert(gd.contacts.length === 8, 'o SenSight deveria ter 8 contatos, tem ' + gd.contacts.length);
    assert(gd.contacts.filter(c => !c.ring).length === 6, 'deveria haver 6 segmentos');
    assert(gd.contacts.filter(c => c.ring).length === 2, 'os níveis 0 e 3 deveriam ser anelares');
    const angulos = gd.contacts.filter(c => c.level === 1).map(c => c.angleDeg);
    assert(JSON.stringify(angulos) === '[0,120,240]', 'os segmentos deveriam estar a 120°, veio ' + angulos);
    /* e o anelar tem 4 */
    assert(C.leadGeometry(C.leadSpec('3389')).contacts.length === 4, 'o anelar deveria ter 4 contatos');
    return '5 modelos conferidos contra as medidas do manual, com o arranjo verificado por soma';
  });

  t('o 3391 sai marcado como medida NÃO conferida — a ressalva vale para dimensão também', () => {
    assert(C.leadSpec('3391').dimensionsVerified === false, 'o 3391 deveria sair marcado como não conferido');
    assert(/catálogo|literatura/i.test(C.leadSpec('3391').source), 'não declara a origem das medidas');
    ['3387', '3389', 'B33005', 'B33015'].forEach(id =>
      assert(C.leadSpec(id).dimensionsVerified === true, `${id} deveria estar conferido`));
    assert(/NÃO CONFERIDAS/.test(C.leadSummary(C.leadSpec('3391'))), 'o resumo do 3391 não avisa');
    assert(!/NÃO CONFERIDAS/.test(C.leadSummary(C.leadSpec('3389'))), 'o resumo do 3389 avisa sem motivo');
    return 'o 3391 declara a origem das medidas; os quatro conferidos não carregam a ressalva';
  });

  t('nome de canal do Percept vira lista de contatos, e "_AND_" não vira o segmento a', () => {
    const casos = [
      ['ZERO_THREE_LEFT', ['0', '3']],
      ['ONE_AND_THREE_RIGHT', ['1', '3']],
      ['SensingChannelDef.ONE_THREE_RIGHT', ['1', '3']],
      ['ONE_C_AND_TWO_C_LEFT', ['1c', '2c']],
      ['ZERO_A_AND_TWO_LEFT_RING', ['0a', '2']],
      ['THREE_LEFT', ['3']]
    ];
    casos.forEach(([entrada, esperado]) => {
      const r = C.contactsOfChannel(entrada);
      assert(JSON.stringify(r) === JSON.stringify(esperado), `${entrada} → ${JSON.stringify(r)}, esperado ${JSON.stringify(esperado)}`);
    });
    assert(C.contactsOfChannel('').length === 0, 'canal vazio deveria dar lista vazia');
    assert(C.contactsOfChannel('LIXO_SEM_CONTATO').length === 0, 'inventou contato onde não há');
    return `${casos.length} formas de nome reconhecidas, inclusive o par sem segmento em "_AND_"`;
  });

  t('o mesmo par bipolar cobre distâncias diferentes conforme o modelo — que é o ponto do desenho', () => {
    const spans = ['3389', '3387', '3391'].map(id => C.leadSpan(C.leadSpec(id), ['0', '3']));
    spans.forEach((s2, i) => assert(s2.ok, `span ${i} não calculado`));
    assert(Math.abs(spans[0].coveredSpanMm - 7.5) < 1e-9, '0-3 no 3389 deveria abranger 7,5 mm');
    assert(Math.abs(spans[1].coveredSpanMm - 10.5) < 1e-9, '0-3 no 3387 deveria abranger 10,5 mm');
    assert(Math.abs(spans[2].coveredSpanMm - 24) < 1e-9, '0-3 no 3391 deveria abranger 24 mm');
    assert(spans[2].coveredSpanMm > 3 * spans[0].coveredSpanMm, 'a diferença entre modelos sumiu');
    /* e um par de segmentos do mesmo nível não tem distância longitudinal */
    const seg = C.leadSpan(C.leadSpec('B33005'), ['1a', '1c']);
    assert(seg.ok && seg.centerDistanceMm === 0, 'dois segmentos do mesmo nível estão na mesma altura');
    return `0-3 abrange 7,5 / 10,5 / 24 mm em 3389 / 3387 / 3391 · segmentos do mesmo nível: 0 mm de distância axial`;
  });

  t('a orientação anatômica dos segmentos NÃO é afirmada a partir do JSON', () => {
    const g = C.leadGeometry(C.leadSpec('B33005'));
    assert(/NOMENCLATURA|nomenclatura/.test(g.orientationNote), 'não declara que o ângulo é de nomenclatura');
    assert(/NÃO está no JSON|não está no JSON/.test(g.orientationNote), 'não diz que a rotação real não está no arquivo');
    assert(/radiograf/i.test(g.orientationNote), 'não diz de onde a orientação real viria');
    const ga = C.leadGeometry(C.leadSpec('3389'));
    assert(/360|radialmente/.test(ga.orientationNote), 'o anelar deveria declarar a simetria radial');
    return 'ângulo declarado como nomenclatura, com a origem da orientação real dita';
  });

  t('o desenho do eletrodo sai no canvas e devolve a caixa de cada contato', () => {
    const cv = document.createElement('canvas');
    const g = C.leadGeometry(C.leadSpec('B33005'));
    const r = P.drawLead(cv, g, { width: 200, height: 260, highlight: { '1a': 'sensing', '3': 'cathode' } });
    assert(r.ok, 'o desenho falhou');
    assert(r.boxes.length === 8, 'deveria devolver 8 caixas, veio ' + r.boxes.length);
    const marcadas = r.boxes.filter(b => b.state);
    assert(marcadas.length === 2, 'deveria haver 2 contatos marcados, há ' + marcadas.length);
    assert(marcadas.some(b => b.id === '1a' && b.state === 'sensing'), '1a não foi marcado como sensing');
    assert(marcadas.some(b => b.id === '3' && b.state === 'cathode'), '3 não foi marcado como catodo');
    /* o contato 0 é o mais distal: na tela, o de maior y (a ponta fica embaixo) */
    const c0 = r.boxes.find(b => b.id === '0'), c3 = r.boxes.find(b => b.id === '3');
    assert(c0.y > c3.y, 'o contato 0 deveria estar abaixo do 3 no desenho (ponta embaixo)');
    /* segmento ocupa um terço da largura; anel, a largura toda */
    const seg = r.boxes.find(b => b.id === '1a');
    assert(seg.w < c0.w, 'o segmento deveria ser mais estreito que o anel');
    /* modelo não identificado não desenha eletrodo nenhum */
    const vazio = P.drawLead(document.createElement('canvas'), C.leadGeometry(C.leadSpec('xyz')), { width: 200, height: 200 });
    assert(!vazio.ok && vazio.boxes.length === 0, 'desenhou um eletrodo para um modelo desconhecido');
    return `8 contatos desenhados · 2 marcados · ordem distal-proximal correta · modelo desconhecido não desenha`;
  });

  t('os contatos de estimulação do grupo ativo viram marcação de catodo e anodo', () => {
    /* é o caminho da F7, que o exemplo não exercita por não ter BrainSenseLfp */
    const g = (parsed[0].groups || []).find(x => x.active) || (parsed[0].groups || [])[0];
    assert(g, 'o exemplo precisa ter ao menos um grupo');
    const marcas = {};
    (g.programs || []).forEach(pr => {
      if (pr.hemisphere !== 'Left' && pr.hemisphere !== 'Right') return;
      marcas[pr.hemisphere] = marcas[pr.hemisphere] || {};
      (pr.contacts || []).forEach(c => C.contactsOfChannel(c).forEach(id => { marcas[pr.hemisphere][id] = 'cathode'; }));
      (pr.anode || []).forEach(c => C.contactsOfChannel(c).forEach(id => { marcas[pr.hemisphere][id] = 'anode'; }));
    });
    (g.sensing || []).forEach(sc => {
      if (!sc.hemisphere) return;
      marcas[sc.hemisphere] = marcas[sc.hemisphere] || {};
      C.contactsOfChannel(sc.channel).forEach(id => { if (!marcas[sc.hemisphere][id]) marcas[sc.hemisphere][id] = 'sensing'; });
    });
    const lados = Object.keys(marcas);
    assert(lados.length >= 1, 'nenhum hemisfério com contatos marcados');
    const total = lados.reduce((a, h) => a + Object.keys(marcas[h]).length, 0);
    assert(total >= 2, 'poucos contatos marcados: ' + total);
    const temCatodo = lados.some(h => Object.keys(marcas[h]).some(k => marcas[h][k] === 'cathode'));
    const temSensing = lados.some(h => Object.keys(marcas[h]).some(k => marcas[h][k] === 'sensing'));
    assert(temCatodo, 'nenhum catodo marcado a partir dos programas do grupo');
    assert(temSensing, 'o par de sensing não foi marcado junto');
    /* o desenho aceita a marcação sem inventar contato que não existe */
    const spec = C.leadsOf(parsed[0])[lados[0]].spec;
    const geo = C.leadGeometry(spec);
    /* num eletrodo direcional NÃO existe contato "1": pedir o nível 1 tem de
       marcar 1a, 1b e 1c, porque é assim que o aparelho o usa */
    const exp = C.expandContacts(Object.keys(marcas[lados[0]]), geo);
    const marcacao = {};
    exp.ids.forEach(id => { marcacao[id] = marcas[lados[0]][id] || marcas[lados[0]][id.replace(/[abc]$/, '')] || 'sensing'; });
    const r = P.drawLead(document.createElement('canvas'), geo, { width: 200, height: 250, highlight: marcacao });
    const marcadas = r.boxes.filter(b => b.state).map(b => b.id).sort();
    assert(JSON.stringify(marcadas) === JSON.stringify(exp.ids.slice().sort()),
      `desenhou ${JSON.stringify(marcadas)} para ${JSON.stringify(exp.ids)}`);
    if (geo.family === 'directional') {
      assert(exp.expanded.length >= 1, 'o nível pedido num direcional deveria ter sido expandido em segmentos');
      assert(/em curto|anel/.test(exp.note || ''), 'a expansão não é explicada ao usuário');
      ['1a', '1b', '1c'].forEach(id => assert(marcadas.indexOf(id) >= 0, `o segmento ${id} não foi marcado`));
    }
    return lados.map(h => `${h}: ${Object.keys(marcas[h]).map(k => k + '=' + marcas[h][k]).join(' ')}`).join(' · ');
  });

  t('as figuras que citam contatos mostram o eletrodo com eles marcados', () => {
    const d = H.ds();
    const varre = (n, acc) => {
      acc.tags.push(n.tagName || (typeof n.getContext === 'function' ? 'CANVAS' : '?'));
      acc.aria.push((n.attrs && n.attrs['aria-label']) || '');
      acc.txt += ' ' + (n.textContent || '') + ' ' + (n.innerHTML || '');
      (n.children || []).forEach(c => varre(c, acc));
      return acc;
    };
    const comEletrodo = [];
    ['F1', 'F3', 'F6', 'F7', 'F31'].forEach(id => {
      const fig = H.FIGURES.find(x => x.id === id);
      if (!fig || !fig.has(d)) return;
      const n = document.createElement('div');
      fig.render(n, d);
      const a = varre(n, { tags: [], aria: [], txt: '' });
      if (a.aria.some(x => /esquema em escala do eletrodo/.test(x))) comEletrodo.push(id);
    });
    assert(comEletrodo.length >= 3, 'poucas figuras mostram o eletrodo: ' + comEletrodo.join(', '));
    return comEletrodo.join(', ') + ' mostram o eletrodo com os contatos em uso marcados';
  });
}

/* ========================================================================= */
sec('Timeline dia a dia: painel por dia civil, lacuna que corta o traçado');
{
  /* série sintética com três defeitos deliberados, um por regra:
     dia 1 completo · dia 2 AUSENTE · dia 3 com um buraco de 4 h no meio */
  const off = -180;                       /* UTC-03:00, para não testar só UTC */
  const passo = 6e5;                      /* 10 min, o passo do Timeline */
  const d0 = Date.parse('2025-03-10T00:00:00Z') - off * 60000;   /* meia-noite local */
  const linhas = [];
  for (let i = 0; i < 144; i++) linhas.push({ t: d0 + i * passo, lfp: 100 + i, ma: 2 });
  /* dia 2 fica vazio de propósito */
  const d2 = d0 + 2 * 864e5;
  for (let i = 0; i < 144; i++) {
    const h = i * passo / 36e5;
    if (h >= 10 && h < 14) continue;      /* buraco de 4 h */
    linhas.push({ t: d2 + i * passo, lfp: 200 + i, ma: 3 });
  }

  t('o dia sem nenhuma amostra aparece como painel vazio, não some do eixo', () => {
    const r = C.splitByLocalDay(linhas, off);
    assert(r.ok, 'não segmentou');
    assert(r.nDays === 3, `esperava 3 dias, veio ${r.nDays}`);
    assert(r.nEmptyDays === 1, `esperava 1 dia vazio, veio ${r.nEmptyDays}`);
    assert(r.days[1].empty && r.days[1].n === 0, 'o dia do meio deveria estar vazio');
    assert(r.days[0].dayKey === '2025-03-10' && r.days[2].dayKey === '2025-03-12',
      `chaves fora de ordem: ${r.days.map(d => d.dayKey).join(', ')}`);
    /* a ausência não pode encurtar o eixo: o dia vazio ainda ocupa uma posição */
    assert(r.days[1].index === 1, 'o dia vazio perdeu a posição no eixo');
    return `${r.nDays} dias, ${r.nEmptyDays} vazio(s), passo medido ${r.samplingMs / 60000} min`;
  });

  t('o intervalo de amostragem é MEDIDO, não assumido em 10 min', () => {
    const r = C.splitByLocalDay(linhas, off);
    assert(r.samplingMs === passo, `passo medido ${r.samplingMs}, esperado ${passo}`);
    assert(r.gapThresholdMs === passo * 3, 'limiar de lacuna não é 3× o passo');
    /* série de 2 min por amostra: o limiar tem de acompanhar, senão uma lacuna
       real de 10 min passaria despercebida */
    const finas = [];
    for (let i = 0; i < 60; i++) finas.push({ t: d0 + i * 12e4, lfp: 1, ma: 0 });
    const rf = C.splitByLocalDay(finas, off);
    assert(rf.samplingMs === 12e4, `passo fino ${rf.samplingMs}`);
    assert(rf.gapThresholdMs === 36e4, 'o limiar não seguiu o passo medido');
    return `10 min → limiar ${r.gapThresholdMs / 60000} min · 2 min → limiar ${rf.gapThresholdMs / 60000} min`;
  });

  t('a lacuna interna corta a série em segmentos — o traçado não a atravessa', () => {
    const r = C.splitByLocalDay(linhas, off);
    const dia3 = r.days[2];
    assert(dia3.segments.length === 2, `esperava 2 segmentos no dia com buraco, veio ${dia3.segments.length}`);
    const g = dia3.gaps.filter(x => !x.edge);
    assert(g.length === 1, `esperava 1 lacuna interna, veio ${g.length}`);
    assert(Math.abs(g[0].minutes - 240) < 11, `lacuna de ${g[0].minutes} min, esperada ~240`);
    assert(Math.abs(dia3.largestGapMin - 240) < 11, 'maior lacuna não bate');
    /* o dia completo tem UM segmento e nenhuma lacuna interna */
    assert(r.days[0].segments.length === 1, 'o dia completo foi partido sem motivo');
    assert(r.days[0].gaps.filter(x => !x.edge).length === 0, 'lacuna inventada no dia completo');
    /* e os segmentos cobrem todas as amostras, sem perder nem repetir ponto */
    const soma = dia3.segments.reduce((a, s) => a + (s.to - s.from + 1), 0);
    assert(soma === dia3.n, `segmentos cobrem ${soma} de ${dia3.n} amostras`);
    return `${dia3.segments.length} segmentos, lacuna de ${Math.round(g[0].minutes)} min`;
  });

  t('a cobertura do dia é declarada, para que painel cheio e painel pela metade não se confundam', () => {
    const r = C.splitByLocalDay(linhas, off);
    assert(Math.abs(r.days[0].coverage - 1) < 0.01, `dia completo com cobertura ${r.days[0].coverage}`);
    const c3 = r.days[2].coverage;
    assert(c3 > 0.8 && c3 < 0.87, `dia com buraco de 4 h deveria ter ~83% de cobertura, veio ${c3}`);
    assert(!isFinite(r.days[1].coverage) || r.days[1].coverage === 0, 'dia vazio com cobertura positiva');
    return `dia cheio ${Math.round(100 * r.days[0].coverage)}% · dia com buraco ${Math.round(100 * c3)}%`;
  });

  t('os dois hemisférios recebem a MESMA lista de dias, senão os painéis não se comparam', () => {
    const curto = linhas.filter(r => r.t < d0 + 864e5);        /* só o primeiro dia */
    const faixa = C.dayRangeOf([linhas, curto], off);
    assert(faixa.fromDay === '2025-03-10' && faixa.toDay === '2025-03-12',
      `faixa ${faixa.fromDay} → ${faixa.toDay}`);
    const a = C.splitByLocalDay(linhas, off, faixa);
    const b = C.splitByLocalDay(curto, off, faixa);
    assert(a.nDays === b.nDays, `${a.nDays} dias contra ${b.nDays}`);
    assert(a.days.map(x => x.dayKey).join() === b.days.map(x => x.dayKey).join(), 'listas de dias divergentes');
    assert(b.nEmptyDays === 2, `o hemisfério curto deveria ter 2 dias vazios, tem ${b.nEmptyDays}`);
    return `${a.nDays} dias em ambos; o curto declara ${b.nEmptyDays} vazios em vez de encolher`;
  });

  t('o dia local respeita o fuso: a fronteira é a meia-noite do paciente, não a UTC', () => {
    /* 23h30 local de UTC-03:00 é 02h30 UTC do dia seguinte */
    const t23 = Date.parse('2025-03-11T02:30:00Z');
    const r = C.splitByLocalDay([{ t: t23, lfp: 1, ma: 0 }], off);
    assert(r.days[0].dayKey === '2025-03-10', `caiu em ${r.days[0].dayKey}, deveria ser 2025-03-10`);
    assert(Math.abs(r.days[0].hours[0] - 23.5) < 0.01, `hora local ${r.days[0].hours[0]}, esperada 23,5`);
    const rUTC = C.splitByLocalDay([{ t: t23, lfp: 1, ma: 0 }], 0);
    assert(rUTC.days[0].dayKey === '2025-03-11', 'em UTC a mesma amostra deveria cair no dia seguinte');
    return `UTC-03: 2025-03-10 23,5h · UTC: 2025-03-11 02,5h`;
  });

  t('F8 desenha um painel por dia no modo dia a dia, e um só gráfico no contínuo', () => {
    const d = H.ds();
    const fig = H.FIGURES.find(x => x.id === 'F8');
    if (!fig || !fig.has(d)) { assert(false, 'F8 sem dados'); }
    const conta = n => {
      let c = 0;
      const varre = x => { if (typeof x.getContext === 'function') c++; (x.children || []).forEach(varre); };
      varre(n); return c;
    };
    H.S.opts.F8 = Object.assign({}, H.S.opts.F8, { modo: 'multi' });
    const nm = document.createElement('div'); fig.render(nm, d);
    const cMulti = conta(nm);

    H.S.opts.F8 = Object.assign({}, H.S.opts.F8, { modo: 'dia' });
    const nd = document.createElement('div'); fig.render(nd, d);
    const cDia = conta(nd);

    const hemis = Object.keys(d.trend);
    const faixa = C.dayRangeOf(hemis.map(h => C.removeOutliersMAD(d.trend[h], 'lfp', 4).kept), 0);
    const nDias = C.splitByLocalDay(C.removeOutliersMAD(d.trend[hemis[0]], 'lfp', 4).kept, 0, faixa).nDays;

    assert(cMulti === 1, `modo contínuo deveria ter 1 gráfico, tem ${cMulti}`);
    assert(cDia === nDias, `modo dia a dia deveria ter ${nDias} gráficos (um por dia), tem ${cDia}`);
    assert(cDia > 1, 'o modo dia a dia não separou nada');
    H.S.opts.F8 = Object.assign({}, H.S.opts.F8, { modo: 'multi' });
    return `contínuo: 1 gráfico · dia a dia: ${cDia} painéis para ${nDias} dias`;
  });

  t('o modo dia a dia declara a escala usada e a regra da lacuna', () => {
    const d = H.ds();
    const fig = H.FIGURES.find(x => x.id === 'F8');
    const txt = n => {
      let s = (n.textContent || '') + ' ' + (n.innerHTML || '');
      (n.children || []).forEach(c => { s += ' ' + txt(c); });
      return s;
    };
    H.S.opts.F8 = { modo: 'dia', escala: true };
    const a = document.createElement('div'); fig.render(a, d);
    const ta = txt(a);
    assert(/mesma escala vertical/.test(ta), 'não disse que a escala é compartilhada');
    assert(/interrompe o traçado/.test(ta), 'não declarou a regra da lacuna');
    assert(/Intervalo de amostragem medido/.test(ta), 'não declarou o passo medido');
    assert(/cobertura/i.test(ta), 'não expôs a cobertura por dia');

    H.S.opts.F8 = { modo: 'dia', escala: false };
    const b = document.createElement('div'); fig.render(b, d);
    const tb = txt(b);
    assert(/escala vertical própria/.test(tb) && /não<\/b> é comparável|não. é comparável/.test(tb),
      'com escala por painel, a figura não avisou que a altura deixa de ser comparável');
    H.S.opts.F8 = {};
    return 'as duas escalas declaram o que se ganha e o que se perde';
  });
}

/* ========================================================================= */
sec('MRDS — movimento vs repouso, ΔMRDS e o que o n permite concluir');
{
  /* gerador determinístico: nenhum teste deste arquivo pode depender de sorteio */
  const semente = s => () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const FS = 250, DUR = 180, N = FS * DUR;
  /* sinal com β em 22 Hz, γ em 70 Hz e ruído; `escala` multiplica TUDO, que é
     como artefato de banda larga e mudança de ganho entram no registro */
  const sinal = (rnd, aBeta, aGama, escala) => {
    const x = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const t = i / FS;
      x[i] = (escala == null ? 1 : escala) *
        (aBeta * Math.sin(2 * Math.PI * 22 * t + 0.3) + aGama * Math.sin(2 * Math.PI * 70 * t + 1.1)
          + 0.6 * (rnd() * 2 - 1));
    }
    return x;
  };

  t('a decomposição banda-larga × específica é uma identidade exata, não uma heurística', () => {
    const r = semente(11);
    const rest = C.mrdsEpochPSD(sinal(r, 1, .5, 1), FS, {});
    const move = C.mrdsEpochPSD(sinal(r, .6, .65, 1.3), FS, {});
    const par = C.mrdsPair(rest, move, {});
    assert(par.ok, 'par não calculado');
    let pior = 0;
    par.bands.forEach(b => {
      const resid = (1 + b.mrds) - (1 + b.mrdsRelative) * (1 + par.mrdsTotal);
      pior = Math.max(pior, Math.abs(resid));
    });
    assert(pior < 1e-12, `identidade 1+abs=(1+rel)(1+total) violada em ${pior}`);
    return `resíduo máximo ${pior.toExponential(1)} — decomposição exata`;
  });

  t('o escopo do z-score muda o MRDS absoluto e NÃO muda o relativo', () => {
    const mk = () => { const r = semente(23); return { rest_baseline: sinal(r, 1, .5, 1), move_baseline: sinal(r, .6, .65, 1) }; };
    const uS = C.mrdsDesign([{ id: 'u', subject: 's', hemisphere: 'Left', cells: mk(), fs: FS }], { zscoreScope: 'session' });
    const uR = C.mrdsDesign([{ id: 'u', subject: 's', hemisphere: 'Left', cells: mk(), fs: FS }], { zscoreScope: 'record' });
    const bS = uS.units[0].baseline.bands.find(b => b.key === 'beta');
    const bR = uR.units[0].baseline.bands.find(b => b.key === 'beta');
    /* o relativo é invariante a escala — é justamente por isso que ele é o
       candidato honesto a efeito específico de banda */
    assert(Math.abs(bS.mrdsRelative - bR.mrdsRelative) < 1e-9,
      `MRDS relativo mudou com o escopo: ${bS.mrdsRelative} vs ${bR.mrdsRelative}`);
    assert(Math.abs(bS.mrds - bR.mrds) > 1e-3,
      'o MRDS absoluto deveria depender do escopo, e não dependeu');
    /* e a consequência algébrica do z-score por gravação fica visível */
    assert(Math.abs(uR.units[0].baseline.varianceRatio - 1) < 1e-9,
      `z-score por gravação deveria forçar razão de variâncias 1, deu ${uR.units[0].baseline.varianceRatio}`);
    assert(uR.units[0].normalization.forcesUnitVariance === true, 'a consequência não foi declarada');
    return `β absoluto ${bS.mrds.toFixed(3)} (sessão) vs ${bR.mrds.toFixed(3)} (gravação); relativo idêntico ${bR.mrdsRelative.toFixed(4)}`;
  });

  t('o ΔMRDS cancela modulação de movimento presente nos dois momentos', () => {
    /* Artefato de movimento IDÊNTICO no basal e no pós (escala 1,4 em toda a
       época de movimento). Efeito real: β cai a mais só depois da intervenção.
       O MRDS de cada momento carrega o artefato; o ΔMRDS não pode. */
    const r = semente(31);
    const cells = {
      rest_baseline: sinal(r, 1, .5, 1), move_baseline: sinal(r, 1, .5, 1.4),
      rest_post: sinal(r, 1, .5, 1), move_post: sinal(r, .7, .5, 1.4)
    };
    const res = C.mrdsDesign([{ id: 'u', subject: 's', hemisphere: 'Left', cells, fs: FS }], { zscoreScope: 'none' });
    const u = res.units[0];
    const bBas = u.baseline.bands.find(b => b.key === 'beta');
    const bPos = u.post.bands.find(b => b.key === 'beta');
    const gDelta = u.delta.find(x => x.key === 'gamma').delta;
    const bDelta = u.delta.find(x => x.key === 'beta').delta;
    /* no basal, movimento só multiplicou: MRDS de β é o artefato puro, positivo */
    assert(bBas.mrds > 0.5, `MRDS β basal deveria refletir o artefato (~0,96), deu ${bBas.mrds.toFixed(3)}`);
    assert(bPos.mrds < bBas.mrds, 'o efeito real de β não apareceu no momento pós');
    /* γ não tem efeito real: o artefato entra nos dois MRDS e sai no delta */
    assert(Math.abs(gDelta) < 0.06, `ΔMRDS de γ deveria cancelar o artefato, deu ${gDelta.toFixed(3)}`);
    assert(bDelta < -0.3, `ΔMRDS de β deveria captar a queda real, deu ${bDelta.toFixed(3)}`);
    return `β: MRDS ${bBas.mrds.toFixed(2)}→${bPos.mrds.toFixed(2)}, Δ ${bDelta.toFixed(2)} · γ (sem efeito real): Δ ${gDelta.toFixed(3)}`;
  });

  t('o MRDS sozinho NÃO separa artefato de banda larga de dessincronização', () => {
    /* só escala: nenhuma banda muda de fração do espectro */
    const r = semente(41);
    const base = sinal(r, 1, .5, 1);
    const escalado = Float64Array.from(base, v => v * 1.5);
    const par = C.mrdsPair(C.mrdsEpochPSD(base, FS, {}), C.mrdsEpochPSD(escalado, FS, {}), {});
    const v = C.mrdsBroadbandVerdict(par, { relativeFloor: 0.05 });
    assert(v.broadband, 'não reconheceu mudança de banda larga');
    assert(!v.bandSpecific.length, `apontou banda específica onde só houve escala: ${v.bandSpecific.join(',')}`);
    assert(/artefato|escala/.test(v.verdict), 'o veredito não nomeia a alternativa');
    par.bands.forEach(b => assert(Math.abs(b.mrdsRelative) < 0.02,
      `${b.key}: MRDS relativo deveria ser ~0 sob escala pura, deu ${b.mrdsRelative}`));
    assert(par.bands.every(b => b.mrds > 0.9), 'o MRDS absoluto deveria ter subido em todas as bandas');
    return `escala de 1,5×: MRDS absoluto ~${par.bands[0].mrds.toFixed(2)} em toda banda, relativo ~0 — veredito de banda larga`;
  });

  t('o NFFT do protocolo é reproduzível: 0,25 Hz exatos e 89 segmentos em 180 s', () => {
    const r = semente(53);
    const x = sinal(r, 1, .5, 1);
    const exato = C.mrdsEpochPSD(x, FS, { exactNfft: true });
    const pot2 = C.mrdsEpochPSD(x, FS, { exactNfft: false });
    assert(exato.nfft === 1000, `NFFT exato deveria ser 1000, deu ${exato.nfft}`);
    assert(Math.abs(exato.df - 0.25) < 1e-12, `resolução ${exato.df}, esperada 0,25 Hz`);
    assert(pot2.nfft === 1024, `sem NFFT exato deveria ir para 1024, deu ${pot2.nfft}`);
    assert(exato.nSegments === 89, `180 s com janela de 4 s e 50% dão 89 segmentos, deu ${exato.nSegments}`);
    /* e a diferença entre os dois não muda a leitura por banda */
    const pa = C.bandPower(exato.f, exato.p, 13, 35), pb = C.bandPower(pot2.f, pot2.p, 13, 35);
    assert(Math.abs(pa - pb) / pa < 0.01, 'a escolha de NFFT mudou a potência de banda em mais de 1%');
    return `1000 → 0,2500 Hz · 1024 → ${pot2.df.toFixed(4)} Hz · potência de β difere ${(100 * Math.abs(pa - pb) / pa).toFixed(2)}%`;
  });

  t('com 4 unidades pareadas nenhum p pode chegar a 0,05, e o teste diz isso', () => {
    const d = [-0.19, -0.19, -0.17, -0.19];
    const a = C.mrdsSignFlipTest(d, { nUnits: 4, nSubjects: 2 });
    const b = C.mrdsSignFlipTest(d, { nUnits: 4, nSubjects: 2 });
    assert(a.exact && a.nPermutations === 16, `esperava enumeração de 16 sinais, veio ${a.nPermutations}`);
    assert(a.p === b.p, 'o teste não é determinístico — dois cálculos deram p diferente');
    assert(Math.abs(a.minAchievableP - 0.125) < 1e-12, `menor p possível ${a.minAchievableP}, esperado 0,125`);
    assert(a.underpowered === true, 'não declarou que o n limita o p antes do dado');
    assert(a.p >= 0.125 - 1e-12, `p ${a.p} abaixo do mínimo possível`);
    /* o t pareado desce abaixo de 0,05 no MESMO dado: a diferença é a
       suposição de normalidade, e as duas saídas têm de coexistir */
    assert(a.tTest && a.tTest.p < 0.05, `o t pareado deveria descer abaixo de 0,05, deu ${a.tTest && a.tTest.p}`);
    assert(a.testsDisagree === true, 'a discordância entre os testes não foi sinalizada');
    assert(/hemisférios do mesmo paciente/.test(a.subjectNote || ''), 'a pseudorreplicação não foi declarada');
    return `permutação exata p=${a.p} (mínimo 0,125) · t pareado p=${a.tTest.p.toFixed(4)} · 4 hemisférios, 2 indivíduos`;
  });

  t('F35 recusa calcular sem a atribuição das épocas, e calcula quando ela existe', () => {
    const ds = H.ds();
    const fig = H.FIGURES.find(x => x.id === 'F35');
    assert(fig && fig.has(ds), 'F35 sem dados no exemplo');
    const txt = n => {
      let s = (n.textContent || '') + ' ' + (n.innerHTML || '');
      (n.children || []).forEach(c => { s += ' ' + txt(c); });
      return s;
    };
    /* sem atribuição: nenhuma tabela de MRDS, e o motivo escrito */
    H.S.opts.F35 = { modo: 'registros', atrib: {} };
    const a = document.createElement('div'); fig.render(a, ds);
    const ta = txt(a);
    assert(/não carrega rótulo de tarefa/.test(ta), 'não explicou por que a atribuição é necessária');
    assert(!/MRDS relativo/.test(ta), 'calculou MRDS sem atribuição declarada');

    /* com atribuição: as quatro células dentro de uma gravação longa */
    const reg = ds.bsTimeDomain.concat(ds.indefiniteStreaming)[0];
    const dur = Math.floor(reg.data.length / reg.fs);
    const q = Math.floor(dur / 4);
    H.S.opts.F35 = {
      modo: 'janelas', reg: 0, z: 'session',
      janelas: {
        rest_baseline: [0, q], move_baseline: [q, 2 * q],
        rest_post: [2 * q, 3 * q], move_post: [3 * q, 4 * q]
      }
    };
    const b = document.createElement('div'); fig.render(b, ds);
    const tb = txt(b);
    assert(/MRDS relativo/.test(tb), 'não produziu a tabela de MRDS com a atribuição declarada');
    assert(/1 \+ MRDS relativo/.test(tb), 'não declarou a decomposição exata');
    assert(/Razão de variâncias/.test(tb), 'não expôs a razão de variâncias');
    H.S.opts.F35 = {};
    return `sem atribuição: recusa com motivo · com 4 janelas de ${q} s: tabela completa`;
  });

  t('F35 declara que o primeiro nível não é corrigido para artefato de movimento', () => {
    const ds = H.ds();
    const fig = H.FIGURES.find(x => x.id === 'F35');
    const txt = n => {
      let s = (n.textContent || '') + ' ' + (n.innerHTML || '');
      (n.children || []).forEach(c => { s += ' ' + txt(c); });
      return s;
    };
    const reg = ds.bsTimeDomain.concat(ds.indefiniteStreaming)[0];
    const dur = Math.floor(reg.data.length / reg.fs);
    /* só o momento basal: a figura tem de dizer o que falta e por quê */
    H.S.opts.F35 = {
      modo: 'janelas', reg: 0,
      janelas: {
        rest_baseline: [0, Math.floor(dur / 2)], move_baseline: [Math.floor(dur / 2), dur],
        rest_post: [0, 0], move_post: [0, 0]
      }
    };
    const n = document.createElement('div'); fig.render(n, ds);
    const s = txt(n);
    assert(/não<\/b> é corrigido|não. é corrigido/.test(s), 'não avisou que o primeiro nível carrega o artefato');
    assert(/pós − basal|pós - basal/.test(s), 'não apontou o ΔMRDS como o nível que cancela');
    assert(C.MRDS_LIMITACOES.some(x => /não um contraste corrigido/.test(x)), 'a limitação não está no núcleo');
    H.S.opts.F35 = {};
    return 'com um único momento, a figura nomeia o que falta em vez de entregar o número sozinho';
  });

  await ta('sem atribuição declarada, o checklist marca os itens de MRDS como não verificáveis', async () => {
    const ds = H.ds();
    /* estado limpo: ninguém declarou nada */
    H.S.opts.F35 = {};
    const semProv = await H.buildProvenance();
    const passoAusente = (semProv.manifest().steps || []).find(s => s.step === 'metrics.mrds');
    assert(!passoAusente, 'o passo de MRDS entrou na proveniência sem atribuição declarada');
    const ckSem = C.generateChecklist(semProv.manifest(), null, null);
    const grupo = ckSem.items.find(g => /MRDS/.test(g.grupo));
    assert(grupo, 'o grupo de MRDS não está no checklist');
    assert(grupo.itens.every(i => !i.preenchido), 'algum item de MRDS veio preenchido sem declaração humana');

    /* com atribuição: o passo aparece e os itens fecham */
    const reg = ds.bsTimeDomain.concat(ds.indefiniteStreaming)[0];
    const dur = Math.floor(reg.data.length / reg.fs), q = Math.floor(dur / 4);
    H.S.opts.F35 = {
      modo: 'janelas', reg: 0, z: 'session',
      janelas: {
        rest_baseline: [0, q], move_baseline: [q, 2 * q],
        rest_post: [2 * q, 3 * q], move_post: [3 * q, 4 * q]
      }
    };
    const comProv = await H.buildProvenance();
    const passo = (comProv.manifest().steps || []).find(s => s.step === 'metrics.mrds');
    assert(passo, 'o passo de MRDS não entrou na proveniência com a atribuição declarada');
    assert(/não carrega rótulo de tarefa/.test(passo.params.assignmentSource), 'a origem da atribuição não foi registrada');
    const ck = C.generateChecklist(comProv.manifest(), null, null);
    const g2 = ck.items.find(g => /MRDS/.test(g.grupo));
    const cheios = g2.itens.filter(i => i.preenchido);
    assert(cheios.length >= 5, `só ${cheios.length} de ${g2.itens.length} itens de MRDS foram preenchidos`);
    const niveis = g2.itens.find(i => i.chave === 'mrds_levels');
    assert(/ΔMRDS calculado/.test(niveis.valor), `item de níveis: ${niveis.valor}`);
    H.S.opts.F35 = {};
    return `sem declaração: 0/${grupo.itens.length} · com declaração: ${cheios.length}/${g2.itens.length} itens preenchidos`;
  });
}

/* ========================================================================= */
sec('apresentação: contraste medido, vidro contido e movimento com função');
{
  const css = fs.readFileSync(path.join(RAIZ, 'src', 'styles.css'), 'utf8');

  /* --- utilitários de cor: contraste do WCAG 2.1, calculado, não estimado -- */
  const hex = h => {
    const m = /^#([0-9a-f]{6})$/i.exec(String(h).trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const lum = rgb => {
    const c = rgb.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contraste = (a, b) => {
    const la = lum(hex(a)), lb = lum(hex(b));
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  /* lê as variáveis de um bloco de declaração pelo seletor */
  const semComentarios = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const varsDe = seletor => {
    const i = semComentarios.indexOf(seletor);
    assert(i >= 0, `bloco ${seletor} não encontrado no CSS`);
    const ini = semComentarios.indexOf('{', i), fim = semComentarios.indexOf('}', ini);
    const mapa = {};
    semComentarios.slice(ini + 1, fim).split(';').forEach(d => {
      const m = /^\s*(--[a-z0-9-]+)\s*:\s*(.+?)\s*$/i.exec(d);
      if (m) mapa[m[1]] = m[2];
    });
    return mapa;
  };
  const claro = varsDe(':root{');
  const escuro = varsDe('html[data-tema="escuro"]{');

  t('o texto atinge o contraste do WCAG nos DOIS temas — medido, não estimado', () => {
    const pares = [
      ['--ink', '--panel', 4.5, 'corpo sobre painel'],
      ['--ink', '--ground', 4.5, 'corpo sobre fundo'],
      ['--ink-2', '--panel', 4.5, 'texto secundário sobre painel'],
      ['--ink-3', '--panel', 3.0, 'texto auxiliar sobre painel'],
      ['--ink-2', '--panel-2', 4.5, 'secundário sobre painel alternado'],
      ['--accent', '--panel', 3.0, 'accent sobre painel'],
      ['--warn', '--panel', 3.0, 'aviso sobre painel'],
      ['--ok', '--panel', 3.0, 'sucesso sobre painel'],
      ['--right', '--panel', 3.0, 'hemisfério direito sobre painel'],
      ['--left', '--panel', 3.0, 'hemisfério esquerdo sobre painel']
    ];
    const piores = [];
    [['claro', claro], ['escuro', Object.assign({}, claro, escuro)]].forEach(([nome, v]) => {
      pares.forEach(([fg, bg, min, rot]) => {
        const r = contraste(v[fg], v[bg]);
        assert(isFinite(r), `${nome}: cor não resolvida em ${fg}/${bg}`);
        assert(r >= min, `${nome}: ${rot} (${v[fg]} sobre ${v[bg]}) dá ${r.toFixed(2)}:1, mínimo ${min}`);
        piores.push([nome + ' ' + rot, r]);
      });
    });
    piores.sort((a, b) => a[1] - b[1]);
    return `pior par: ${piores[0][0]} ${piores[0][1].toFixed(2)}:1 · ${piores.length} pares verificados`;
  });

  t('o papel da figura não escurece com o tema — o PNG exportado não depende da tela', () => {
    assert(!('--paper' in escuro), 'o tema escuro redefiniu --paper: a figura exportada mudaria com o tema da tela');
    assert(/^#FFFFFF$/i.test(String(claro['--paper']).trim()), `--paper deveria ser branco, é ${claro['--paper']}`);
    /* e o papel é blindado contra material e animação */
    const compacto = semComentarios.replace(/\s+/g, '');
    assert(/\.plotbox,\.plotbox\*\{backdrop-filter:none!important/.test(compacto),
      'o papel da figura não está blindado contra backdrop-filter');
    assert(/animation:none!important/.test(compacto.slice(compacto.indexOf('.plotbox,.plotbox*'), compacto.indexOf('.plotbox,.plotbox*') + 200)),
      'o papel da figura não está blindado contra animação');
    return 'papel branco fixo, sem backdrop-filter e sem animação em qualquer tema';
  });

  t('vidro só nas camadas que flutuam sobre o conteúdo, e nunca uma sobre a outra', () => {
    /* todo seletor que aplica backdrop-filter com desfoque de verdade */
    const regras = css.split('}').map(b => b + '}');
    const comVidro = regras
      .filter(b => /backdrop-filter:\s*blur\(var\(--glass-blur\)\)/.test(b))
      .map(b => b.split('{')[0].trim().split('\n').pop().trim());
    /* Duas, e só duas: o cromo (espinha + cabeçalho + abas, numa camada só) e o
       painel flutuante de processamento. Vidro sobre vidro soma opacidade e
       produz a mancha ilegível pela qual o Liquid Glass foi criticado, então a
       contagem é a própria invariante. */
    const esperados = ['.chrome', '.proc'];
    assert(comVidro.length === esperados.length,
      `esperava ${esperados.length} superfícies de vidro, achei ${comVidro.length}: ${comVidro.join(' | ')}`);
    assert(!/nav\.tabs\{[^}]*backdrop-filter/.test(semComentarios.replace(/\s+/g, '')),
      'a barra de abas voltou a ter vidro próprio dentro do cromo — seriam duas camadas somadas');
    esperados.forEach(sel => assert(comVidro.some(c => c.indexOf(sel) >= 0),
      `${sel} deveria receber vidro; achei ${comVidro.join(' | ')}`));
    /* e nenhuma superfície de dado pode estar na lista */
    ['.plotbox', 'table.data', '.note', '.leitura', '.warnbox', '.card', '.fig{'].forEach(proibido =>
      assert(!comVidro.some(c => c.indexOf(proibido.replace('{', '')) >= 0),
        `${proibido} recebeu vidro — superfície de dado nunca pode ser translúcida`));
    return comVidro.join(' · ');
  });

  t('o material mais transparente ainda mantém um piso de opacidade', () => {
    const alfas = [...css.matchAll(/--glass-bg:\s*rgba\([^)]*?,\s*\.(\d+)\)/g)].map(m => +('0.' + m[1]));
    assert(alfas.length >= 2, 'não achei os níveis de material');
    const piso = Math.min.apply(null, alfas);
    assert(piso >= 0.6, `o vidro desce a ${piso} de opacidade — abaixo de 0,6 o texto do cromo falha sobre figura clara`);
    /* e há saída para quem não tem backdrop-filter ou pede mais contraste */
    assert(/@supports not \(backdrop-filter/.test(css), 'sem fallback para navegador sem backdrop-filter');
    assert(/@media \(prefers-contrast: more\)/.test(css), 'não respeita prefers-contrast: more');
    assert(/html\[data-material="solido"\]/.test(css), 'não existe o nível sólido — o usuário não pode desligar o vidro');
    return `piso de opacidade ${piso} · fallback sem backdrop-filter · sólido disponível`;
  });

  t('movimento respeita prefers-reduced-motion e fica na faixa de 120–300 ms', () => {
    const rm = /@media\(prefers-reduced-motion:reduce\)\{([\s\S]*?)\n\}/.exec(css);
    assert(rm, 'não há bloco de prefers-reduced-motion');
    assert(/animation-duration:\s*\.01ms!important/.test(rm[1]), 'reduced-motion não desliga keyframes');
    assert(/transition-duration:\s*\.01ms!important/.test(rm[1]), 'reduced-motion não desliga transições');
    const durs = [...css.matchAll(/--dur-\d:\s*(\d+)ms/g)].map(m => +m[1]);
    assert(durs.length >= 3, 'faltam tokens de duração');
    assert(Math.min.apply(null, durs) >= 100 && Math.max.apply(null, durs) <= 300,
      `durações fora da faixa recomendada: ${durs.join(', ')} ms`);
    /* nenhuma animação usa duração avulsa: todas saem dos tokens, senão a
       faixa de 120–300 ms vira recomendação em vez de garantia */
    const animes = [...semComentarios.matchAll(/animation:\s*([^;}]+)/g)].map(m => m[1].trim())
      .filter(v => !/^none/.test(v));
    assert(animes.length >= 2, `esperava animações declaradas, achei ${animes.length}`);
    animes.forEach(v => assert(/var\(--dur-\d\)/.test(v), `animação com duração avulsa: ${v}`));
    animes.forEach(v => assert(/var\(--ease/.test(v), `animação sem curva declarada: ${v}`));
    return `tokens ${durs.join('/')} ms · ${animes.length} animações, todas com token de duração e curva`;
  });

  t('alvos de toque de 44 px em ponteiro grosso, e foco visível em tudo que é clicável', () => {
    const coarse = /@media \(pointer: coarse\)\{([\s\S]*?)\n\}/.exec(css);
    assert(coarse, 'não há regra para ponteiro grosso');
    assert(/min-height:44px/.test(coarse[1]), 'os alvos de toque não chegam a 44 px');
    ['.btn', '.field select', 'nav.tabs button', '.segmented button'].forEach(sel =>
      assert(css.indexOf(sel + ':focus-visible') >= 0 || css.indexOf(sel + ':focus-visible,') >= 0,
        `${sel} não declara :focus-visible`));
    return '44 px em toque · foco visível em botão, campo, aba e segmentado';
  });

  t('o cromo condensa ao rolar sem esconder nada que tenha função', () => {
    const compacto = semComentarios.replace(/\s+/g, '');
    assert(/\.chrome\.densa/.test(compacto), 'o cromo não condensa ao rolar');
    /* o que a condensação apaga tem de ser decorativo. Abas, ferramentas e o
       nome do produto continuam na tela em qualquer estado de rolagem. */
    const regrasDensa = [...compacto.matchAll(/\.chrome\.densa([^{]*)\{([^}]*)\}/g)];
    assert(regrasDensa.length >= 2, 'condensação declarada de forma incompleta');
    regrasDensa.forEach(([, alvo, corpo]) => {
      if (!/display:none/.test(corpo)) return;
      assert(/\.brandspan/.test(alvo),
        `a condensação esconde algo com função: ${alvo} → ${corpo}`);
    });
    /* e a altura do cromo é MEDIDA, não chutada: quem gruda embaixo dele
       (coluna lateral e âncora de figura) lê a mesma variável */
    assert(/--chrome-h/.test(compacto), 'a altura do cromo não é publicada como variável');
    assert(/aside\.rail\{position:sticky;top:calc\(var\(--chrome-h/.test(compacto),
      'a coluna lateral não acompanha a altura real do cromo');
    assert(/scroll-margin-top:calc\(var\(--chrome-h/.test(compacto),
      'a âncora de figura não acompanha a altura real do cromo — o título ficaria sob a barra');
    return 'condensação só remove o subtítulo da marca · altura medida, não fixada em pixels';
  });

  t('a impressão força o tema claro, venha de que tema vier a tela', () => {
    const pr = css.slice(css.indexOf('@media print{'));
    assert(/html\[data-tema\]\{[^}]*--panel:#fff/.test(pr.replace(/\s+/g, '')),
      'a impressão não neutraliza o tema escuro — o relatório sairia com fundo escuro');
    return 'relatório impresso sempre em fundo claro';
  });

  t('tema e material são escolha do usuário, persistem, e valor inválido é recusado', () => {
    const raiz = document.documentElement;
    localStorage.clear();
    /* padrão: auto + tingido */
    let a = H.aparenciaAtual();
    assert(a.tema === 'auto' && a.material === 'tingido', `padrão veio ${a.tema}/${a.material}`);
    H.aplicarAparencia();
    assert(raiz.getAttribute('data-tema') === 'claro', `auto com sistema claro deveria resolver claro, deu ${raiz.getAttribute('data-tema')}`);
    assert(raiz.getAttribute('data-material') === 'tingido', 'material não foi carimbado na raiz');

    /* auto acompanha o sistema */
    globalThis.__mediaEscuro = true;
    H.aplicarAparencia();
    assert(raiz.getAttribute('data-tema') === 'escuro', 'auto não seguiu o sistema em modo escuro');
    /* escolha explícita ganha do sistema */
    H.setTema('claro');
    assert(raiz.getAttribute('data-tema') === 'claro', 'escolha explícita não sobrepôs o sistema');
    assert(raiz.getAttribute('data-tema-escolha') === 'claro', 'a escolha não foi registrada separada do resolvido');
    globalThis.__mediaEscuro = false;

    /* persistência */
    H.setMaterial('solido');
    assert(H.aparenciaAtual().material === 'solido', 'o material não persistiu');
    assert(JSON.parse(localStorage.getItem('pls.prefs.v1')).material === 'solido', 'não gravou em localStorage');
    /* nada de paciente entra no armazenamento */
    const bruto = localStorage.getItem('pls.prefs.v1');
    assert(!/patient|Patient|idHash|sub-/.test(bruto), `o armazenamento local guardou algo além de preferência: ${bruto}`);

    /* valor inválido não muda nada */
    H.setTema('roxo'); H.setMaterial('holografico');
    assert(H.aparenciaAtual().tema === 'claro' && H.aparenciaAtual().material === 'solido',
      'valor inválido alterou a aparência');
    localStorage.clear(); H.aplicarAparencia();
    return `${H.TEMAS.join('/')} × ${H.MATERIAIS.join('/')} · inválido recusado · só preferência no armazenamento`;
  });
}

/* ========================================================================= */
sec('TIDAL-DT — limiares de dual threshold derivados do Timeline');
{
  const T = C.TIDAL;

  t('o filtro de Hampel rejeita os picos plantados e deixa o resto em paz', () => {
    const rng = T.tidalRng(7);
    const xs = [];
    for (let i = 0; i < 500; i++) xs.push(1.5 + 0.05 * rng.gauss());
    const plantados = [50, 180, 333];
    plantados.forEach(i => xs[i] += 2.0);
    const h = T.hampelFilter(xs, { window: 12, k: 3 });
    plantados.forEach(i => assert(h.artifact[i] === 1, `o pico em ${i} não foi rejeitado`));
    /* janela de 12 amostras tem MAD instável: ~3% de falsos positivos em ruído
       gaussiano puro é o comportamento documentado do Hampel curto, não bug.
       O que o teste exige é (a) pegar todos os picos e (b) falsos < 6%. */
    const falsos = h.nRejected - plantados.length;
    assert(falsos / 500 < 0.06, `taxa de falsos positivos alta demais: ${falsos} em 500`);
    /* trecho constante: MAD zero não pode rejeitar tudo */
    const c = T.hampelFilter(new Array(100).fill(2.0).concat([9]), { window: 12, k: 3 });
    assert(c.nRejected <= 1, 'MAD zero rejeitou pontos de um trecho constante');
    return `${h.nRejected} rejeições para 3 picos plantados · trecho constante intacto`;
  });

  t('dia com poucas amostras ou muita rejeição é excluído COM o motivo listado', () => {
    const syn = T.syntheticTimeline({ days: 5 });
    /* dia 2 perde 60% das amostras */
    const rows = syn.rows.filter((r, i) => {
      const dia = Math.floor(i / 144);
      return dia !== 2 || (i % 144) < 58;
    });
    const res = T.runPipeline(rows, 0, {});
    assert(res.ok, 'pipeline falhou: ' + (res.reason || ''));
    assert(res.days.used.length === 4, `esperava 4 dias usados, veio ${res.days.used.length}`);
    assert(res.days.excluded.length === 1, 'o dia mutilado não foi excluído');
    assert(/%.*present/.test(res.days.excluded[0].reason), 'a exclusão veio sem motivo legível');
    return `dia ${res.days.excluded[0].day} excluído: ${res.days.excluded[0].reason}`;
  });

  t('a janela de vigília é recuperada do ciclo circadiano, e o fallback é rotulado', () => {
    const syn = T.syntheticTimeline();
    const x0 = syn.rows.map(r => Math.log10(r.lfp + 1));
    const clean = syn.rows.map((r, i) => ({ t: r.t, x: x0[i] }));
    const w = T.detectWakeWindow(clean, 0, {});
    assert(w.refined, 'não usou cosinor + change-point com ritmo forte');
    assert(Math.abs(w.wake[0] - 8) <= 1 && Math.abs(w.wake[1] - 23) <= 1,
      `janela ${w.wake[0]}–${w.wake[1]}, esperada ~8–23`);
    /* série sem ritmo: fallback declarado */
    const rng = T.tidalRng(3);
    const flat = [];
    for (let i = 0; i < 1000; i++) flat.push({ t: i * 600000, x: 1.5 + 0.05 * rng.gauss() });
    const wf = T.detectWakeWindow(flat, 0, {});
    assert(!wf.refined && /fallback fixed 08:00-22:00/.test(wf.method), 'fallback sem rótulo: ' + wf.method);
    assert(wf.wake[0] === 8 && wf.wake[1] === 22, 'fallback fora de 08–22');
    return `ritmo forte: ${w.wake[0]}–${w.wake[1]} h (R²=${w.r2.toFixed(2)}) · sem ritmo: fallback 8–22 rotulado`;
  });

  t('o GMM por EM recupera a mistura plantada e o BIC escolhe k', () => {
    const rng = T.tidalRng(11);
    const xs = [];
    for (let i = 0; i < 400; i++) xs.push(1.45 + 0.06 * rng.gauss());
    for (let i = 0; i < 400; i++) xs.push(1.75 + 0.07 * rng.gauss());
    const g2 = T.fitGMM1D(xs, 2), g1 = T.fitGMM1D(xs, 1);
    assert(g2.converged, 'EM não convergiu');
    assert(Math.abs(g2.means[0] - 1.45) < 0.02 && Math.abs(g2.means[1] - 1.75) < 0.02,
      `médias ${g2.means.map(m => m.toFixed(3)).join(', ')}, esperadas 1,45 e 1,75`);
    assert(g2.bic < g1.bic, 'BIC não preferiu k=2 numa mistura clara');
    assert(T.ashmanD(g2) > 2, `Ashman d ${T.ashmanD(g2).toFixed(2)} ≤ 2 numa mistura separada`);
    /* determinismo: duas chamadas, o mesmo ajuste */
    const g2b = T.fitGMM1D(xs, 2);
    assert(g2.means[0] === g2b.means[0] && g2.logLik === g2b.logLik, 'o EM não é determinístico');
    /* unimodal: fallback rotulado */
    const uni = [];
    const rng2 = T.tidalRng(13);
    for (let i = 0; i < 600; i++) uni.push(1.6 + 0.08 * rng2.gauss());
    const p = T.proposeThresholds(uni, {});
    assert(!p.bimodal && /percentile fallback \(unimodal distribution\)/.test(p.method),
      'distribuição unimodal não caiu no fallback rotulado: ' + p.method);
    return `μ recuperadas ${g2.means.map(m => m.toFixed(3)).join('/')} · Ashman ${T.ashmanD(g2).toFixed(1)} · unimodal → fallback`;
  });

  t('o limiar superior é o cruzamento das densidades, e ambos saem inteiros nativos', () => {
    const g = { k: 2, weights: [0.5, 0.5], means: [1.45, 1.75], sigmas: [0.06, 0.07] };
    const x = T.densityCrossing(g);
    assert(x > 1.45 && x < 1.75, `cruzamento ${x} fora do intervalo entre as médias`);
    /* no cruzamento as densidades ponderadas são iguais */
    const dens = (v, m, s, w) => w * Math.exp(-0.5 * ((v - m) / s) ** 2) / s;
    assert(Math.abs(dens(x, 1.45, .06, .5) - dens(x, 1.75, .07, .5)) < 1e-6, 'as densidades não se igualam no cruzamento');
    const syn = T.syntheticTimeline();
    const res = T.runPipeline(syn.rows, 0, {});
    const p = res.proposal;
    assert(Number.isInteger(p.lower) && Number.isInteger(p.upper), 'limiares não inteiros');
    assert(p.upper > p.lower, 'upper ≤ lower');
    assert(Math.abs(p.lowerLog - (p.gmm2.means[0] + 0.5 * p.gmm2.sigmas[0])) < 1e-6, 'lower ≠ μ1+0,5σ1');
    return `cruzamento em ${x.toFixed(4)} log · proposta ${p.lower}/${p.upper} (inteiros nativos)`;
  });

  t('a simulação: zonas somam 100%, e sem limites de corrente ela diz o que falta', () => {
    const syn = T.syntheticTimeline();
    const res = T.runPipeline(syn.rows, 0, {});
    const s0 = res.sim;
    assert(!s0.hasCurrent && /current limits not provided/.test(s0.reason),
      'sem limites de corrente a simulação deveria declarar a ausência');
    assert(Math.abs(s0.pctBelow + s0.pctWithin + s0.pctAbove - 100) < 1e-9, 'zonas não somam 100%');
    const s1 = T.simulateDualThreshold(res.wakeRows.map(r => r.lfp), {
      lower: res.proposal.lower, upper: res.proposal.upper, iMin: 0.5, iMax: 3.5, step: 0.1,
      dayKeys: res.wakeRows.map(r => C.localDayKey(r.t, 0))
    });
    assert(s1.hasCurrent && isFinite(s1.pctSaturated), 'com limites, a saturação deveria ser medida');
    assert(s1.transitionsPerDay > 0, 'nenhuma transição num sinal com ciclos de medicação');
    return `zonas ${s0.pctBelow.toFixed(0)}/${s0.pctWithin.toFixed(0)}/${s0.pctAbove.toFixed(0)} · ` +
      `com corrente: saturação ${s1.pctSaturated.toFixed(1)}%, ${s1.transitionsPerDay} transições/dia`;
  });

  t('o auto-tune melhora o custo e nunca sai da vizinhança de ±15%', () => {
    const syn = T.syntheticTimeline();
    const res = T.runPipeline(syn.rows, 0, {});
    const p = res.proposal;
    const at = T.autoTune(res.wakeRows.map(r => r.lfp), p, {
      iMin: 0.5, iMax: 3.5, step: 0.1, dayKeys: res.wakeRows.map(r => C.localDayKey(r.t, 0))
    });
    assert(at.cost <= at.baseCost + 1e-9, 'o auto-tune piorou o custo');
    assert(at.lower >= Math.round(p.lower * 0.85) - 1 && at.lower <= Math.round(p.lower * 1.15) + 1, `lower ${at.lower} fora de ±15% de ${p.lower}`);
    assert(at.upper >= Math.round(p.upper * 0.85) - 1 && at.upper <= Math.round(p.upper * 1.15) + 1, `upper ${at.upper} fora de ±15% de ${p.upper}`);
    assert(at.upper > at.lower, 'auto-tune inverteu os limiares');
    return `custo ${at.baseCost.toFixed(1)} → ${at.cost.toFixed(1)} com ${at.lower}/${at.upper} (proposta ${p.lower}/${p.upper})`;
  });

  t('self-test: o pipeline recupera limiares conhecidos com erro < 10%', () => {
    const st = T.selfTest();
    assert(st.pass, `self-test falhou: ${JSON.stringify(st.proposed)} vs ${JSON.stringify({ l: st.truth.lower, u: st.truth.upper })}, erros ${st.errLowerPct}%/${st.errUpperPct}%`);
    assert(st.errLowerPct < 10 && st.errUpperPct < 10, 'erro acima de 10%');
    assert(/GMM dual-state/.test(st.proposed.method), 'o self-test não usou o caminho bimodal');
    /* determinismo completo: rodar duas vezes dá o mesmo número */
    const st2 = T.selfTest();
    assert(st.proposed.lower === st2.proposed.lower && st.proposed.upper === st2.proposed.upper, 'self-test não determinístico');
    return `proposto ${st.proposed.lower}/${st.proposed.upper} vs verdade ${st.truth.lower}/${st.truth.upper} — erro ${st.errLowerPct}%/${st.errUpperPct}%`;
  });

  t('menos de 3 dias utilizáveis bloqueia a proposta citando o ADAPT-START', () => {
    const syn = T.syntheticTimeline({ days: 2 });
    const res = T.runPipeline(syn.rows, 0, {});
    assert(!res.ok && res.blockedByDays, 'registro de 2 dias não foi bloqueado');
    assert(/ADAPT-START/.test(res.reason) && /10\.1038\/s41531-026-01269-z/.test(res.reason),
      'o bloqueio não cita a recomendação de ≥3–5 dias: ' + res.reason);
    return res.reason.slice(0, 84) + '…';
  });

  t('a linha do CSV tem exatamente os cabeçalhos da especificação, na ordem', () => {
    const syn = T.syntheticTimeline();
    const res = T.runPipeline(syn.rows, 0, {});
    const row = T.tidalCsvRow('Left', res);
    assert(JSON.stringify(Object.keys(row)) === JSON.stringify(T.CSV_COLUMNS),
      `cabeçalhos divergem:\n${Object.keys(row).join(',')}\n${T.CSV_COLUMNS.join(',')}`);
    assert(/^\d{2}\.\d-\d{2}\.\d$/.test(row.wake_window), `wake_window mal formatado: ${row.wake_window}`);
    return `${T.CSV_COLUMNS.length} colunas, ordem exata · wake_window ${row.wake_window}`;
  });

  t('o espelho em R existe, com as funções homônimas e o MESMO gerador determinístico', () => {
    const r = fs.readFileSync(path.join(RAIZ, 'R', 'tidal_dt.R'), 'utf8');
    ['hampel_filter', 'fit_cosinor', 'detect_wake_window', 'fit_gmm_1d',
      'propose_thresholds', 'simulate_dual_threshold', 'auto_tune', 'tidal_rng',
      'tidal_synthetic', 'tidal_selftest'].forEach(fn =>
        assert(new RegExp('^' + fn + ' <- function', 'm').test(r), `função ${fn} ausente no R`));
    assert(/48271/.test(r) && /2147483647/.test(r), 'o LCG minstd não está espelhado');
    assert(/1736121600/.test(r), 'o t0 fixo do gerador não está espelhado');
    T.CSV_COLUMNS.forEach(ccol => assert(r.indexOf('"' + ccol + '"') >= 0, `coluna ${ccol} ausente no CSV do R`));
    assert(/Not a medical device/.test(r), 'o disclaimer não está no R');
    ['10.1038/s41531-025-01124-7', '10.1038/s41531-022-00350-7', '10.1038/s41467-023-41128-6',
      '10.1038/s41531-026-01269-z', '10.1038/s41531-024-00772-5'].forEach(doi =>
        assert(r.indexOf(doi) >= 0, `DOI ${doi} ausente no cabeçalho do R`));
    return '10 funções espelhadas · LCG e t0 idênticos · mesmos cabeçalhos, disclaimer e DOIs';
  });

  t('F36 renderiza a proposta com método, disclaimer e limitação dos 10 min declarados', () => {
    const d = H.ds();
    const fig = H.FIGURES.find(x => x.id === 'F36');
    assert(fig && fig.has(d), 'F36 sem dados no exemplo');
    const txt = n => {
      let s = (n.textContent || '') + ' ' + (n.innerHTML || '');
      (n.children || []).forEach(c => { s += ' ' + txt(c); });
      return s;
    };
    H.S.opts.F36 = {};
    const n = document.createElement('div');
    fig.render(n, d);
    const s = txt(n);
    assert(/GMM dual-state|percentile fallback/.test(s), 'nenhum método de limiar declarado');
    assert(/Not a medical device/.test(s), 'sem o disclaimer');
    assert(/10-min averages|zone occupancy/.test(s), 'a limitação da resolução de 10 min não está declarada');
    assert(/Current limits are clinician input|% time saturated/.test(s), 'a decisão de corrente não está atribuída ao clínico');
    assert(/wake window/.test(s), 'a janela de vigília não aparece');

    /* com menos de 3 dias, a figura bloqueia com o aviso */
    const curto = { trend: { Left: d.trend[Object.keys(d.trend)[0]].filter(r => r.t < d.trend[Object.keys(d.trend)[0]][0].t + 2 * 864e5) }, all: d.all, snapshots: [] };
    const n2 = document.createElement('div');
    fig.render(n2, curto);
    const s2 = txt(n2);
    assert(/ADAPT-START/.test(s2), 'registro curto não bloqueou citando o ADAPT-START');
    H.S.opts.F36 = {};
    return 'proposta + disclaimer + limitação declarados · registro de 2 dias bloqueado';
  });
}

/* ------------------------------------------------------------- resultado -- */
console.log(`\n${'='.repeat(58)}`);
console.log(`  ${ok} passaram   ${falhas} falharam   ${pulados} sem dados`);
console.log('='.repeat(58));
process.exit(falhas ? 1 : 0);
