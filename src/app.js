/* ==========================================================================
   PERCEPT LFP STUDIO — aplicação
   ========================================================================== */
(function () {
'use strict';
const C = window.PerceptCore, P = window.PerceptPlot;
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const el = (tag, attrs, kids) => {
  const n = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === 'class') n.className = attrs[k];
    else if (k === 'html') n.innerHTML = attrs[k];
    else if (k === 'text') n.textContent = attrs[k];
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
    else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
  }
  (kids || []).forEach(k => n.appendChild(typeof k === 'string' ? document.createTextNode(k) : k));
  return n;
};
const f = P.fmt;
const COL = {
  Left: '#1B4A72', Right: '#9C3050', ink: '#0E1A24', muted: '#5C7284',
  rule: '#C7D3DC', grid: '#E1E8ED', accent: '#0C6E6B', warn: '#A8621B', ok: '#2C7A4B'
};
const hcol = h => COL[h] || COL.accent;
const hname = h => h === 'Left' ? 'esquerdo' : h === 'Right' ? 'direito' : h;

/* ======================================================== estado global == */
const S = {
  files: [],            // [{name, parsed}]
  tzOverride: null,     // minutos
  subject: null,        // idHash do registro ativo
  opts: {},             // opções por figura
  profile: null,        // id do perfil de doença; null = sugerir pelo JSON
  symptomSeries: null,  // série clínica importada (distonia): [{t, v}]
};

/* Perfil de doença ativo (Onda 5). Sugerido a partir de Diagnosis e
   LeadLocation, confirmado ou trocado pelo usuário, e persistido. Nenhuma banda
   ou leitura clínica pode ficar hardcoded — tudo vem daqui. */
function activeProfileId() {
  if (S.profile) return S.profile;
  const p0 = (activeFiles()[0] || S.files[0] || {}).parsed;
  return p0 ? C.suggestProfile(p0) : 'pd';
}
function activeProfile() { return C.getProfile(activeProfileId()); }
/* bandas do perfil; em TE dependem da frequência de tremor medida */
function profileBands() {
  const perfil = activeProfile();
  let tremorHz = NaN;
  if (perfil.id === 'et') {
    const d = ds();
    const src = (d.sensingSetup.find(s => s.psd) || {}).psd
      || (d.montage[0] ? { f: d.montage[0].f, p: d.montage[0].mag } : null);
    if (src) { const tr = C.detectTremorFrequency(src.f, src.p, {}); if (tr) tremorHz = tr.fundamentalHz; }
  }
  return C.bandsOf(perfil, { tremorHz });
}
/* Avisos declarados pelo perfil, conforme os sinais externos disponíveis. */
function profileWarnings(node) {
  const perfil = activeProfile();
  (perfil.warnings || []).forEach(w => {
    const semImu = !S.externalChannels || !S.externalChannels.some(c => c.kind === 'imu');
    const semAcc = !S.externalChannels || !S.externalChannels.some(c => c.kind === 'accelerometer');
    const mostrar = w.when === 'always' || (w.when === 'no_imu' && semImu) || (w.when === 'no_accelerometer' && semAcc);
    if (mostrar) node.appendChild(el('div', { class: 'warnbox', html: w.html }));
  });
}

/* Agrupa arquivos por registro. Arquivos de pessoas diferentes NUNCA são
   agregados: misturar séries de pacientes distintos invalidaria toda análise. */
function subjects() {
  const map = new Map();
  S.files.forEach(fl => {
    const k = fl.parsed.patient.idHash + '|' + (fl.parsed.device.snHash || '');
    if (!map.has(k)) map.set(k, { key: k, idHash: fl.parsed.patient.idHash, files: [], implant: fl.parsed.device.implantDate });
    map.get(k).files.push(fl);
  });
  return Array.from(map.values());
}
function activeSubject() {
  const subs = subjects();
  if (!subs.length) return null;
  return subs.find(s => s.key === S.subject) || subs[0];
}
function activeFiles() { const s = activeSubject(); return s ? s.files : []; }

function offMin() {
  if (S.tzOverride != null) return S.tzOverride;
  for (const fl of activeFiles()) if (fl.parsed.meta.utcOffsetMin != null) return fl.parsed.meta.utcOffsetMin;
  return -180;
}

/* Datasets agregados (somente dentro do registro ativo) -------------------- */
function ds() {
  const all = activeFiles().map(x => x.parsed);
  const merge = key => {
    const out = {};
    all.forEach(p => Object.keys(p[key] || {}).forEach(h => {
      out[h] = (out[h] || []).concat(p[key][h]);
    }));
    Object.keys(out).forEach(h => {
      const seen = new Set(); const rows = [];
      out[h].sort((a, b) => a.t - b.t).forEach(r => { if (!seen.has(r.t)) { seen.add(r.t); rows.push(r); } });
      out[h] = rows;
    });
    return out;
  };
  const cat = key => all.flatMap(p => (p[key] || []).map(r => Object.assign({ _file: p.fileName }, r)));
  return {
    all,
    trend: merge('trend'),
    montage: cat('montage'), montageTD: cat('montageTD'),
    bsTimeDomain: cat('bsTimeDomain'), bsLfp: cat('bsLfp'),
    snapshots: cat('snapshots'), signalCheck: cat('signalCheck'), sensingSetup: cat('sensingSetup'),
    eventLogs: cat('eventLogs'),
    impedance: (all.find(p => Object.keys(p.impedance || {}).length) || {}).impedance || {},
    thresholds: (() => {
      const t = {};
      all.forEach(p => (p.sensingSetup || []).forEach(s => {
        if (isFinite(s.lowerThr)) t[s.hemisphere] = { lower: s.lowerThr, upper: s.upperThr, centerFreq: s.centerFreq };
      }));
      all.forEach(p => (p.bsLfp || []).forEach(b => Object.keys(b.therapy.perHemi || {}).forEach(h => {
        const x = b.therapy.perHemi[h];
        if (isFinite(x.lowerThr) && !t[h]) t[h] = { lower: x.lowerThr, upper: x.upperThr, centerFreq: x.centerFreq };
      })));
      return t;
    })(),
    patientEvents: all.flatMap(p => p.patientEvents || []),
    eventSummary: all.map(p => p.eventSummary).filter(Boolean)
  };
}

/* ============================================================ controles == */
function ctrlSelect(label, options, value, onChange) {
  const s = el('select', { onchange: e => onChange(e.target.value) });
  options.forEach(o => {
    const v = typeof o === 'string' ? o : o.value, t = typeof o === 'string' ? o : o.label;
    const op = el('option', { value: v, text: t });
    if (String(v) === String(value)) op.selected = true;
    s.appendChild(op);
  });
  return el('label', { class: 'field' }, [label, s]);
}
function ctrlNumber(label, value, min, max, step, onChange) {
  const i = el('input', { type: 'number', value, min, max, step, onchange: e => onChange(parseFloat(e.target.value)) });
  return el('label', { class: 'field' }, [label, i]);
}
function ctrlCheck(label, value, onChange) {
  const i = el('input', { type: 'checkbox', onchange: e => onChange(e.target.checked) });
  i.checked = !!value;
  return el('label', { class: 'field' }, [i, label]);
}
function opt(figId, key, def) {
  S.opts[figId] = S.opts[figId] || {};
  if (S.opts[figId][key] === undefined) S.opts[figId][key] = def;
  return S.opts[figId][key];
}
function setOpt(figId, key, v) { S.opts[figId] = S.opts[figId] || {}; S.opts[figId][key] = v; renderFigure(figId); }

function plotBox(parent, h) {
  const box = el('div', { class: 'plotbox' });
  const cv = el('canvas');
  box.appendChild(cv); parent.appendChild(box);
  const w = parent.clientWidth || 640;
  cv.style.width = '100%'; cv.style.height = (h || 260) + 'px';
  return { canvas: cv, width: Math.max(280, (box.clientWidth || w) - 12), height: h || 260 };
}
/* Selo de qualidade do dado (Onda 1): toda figura que consome série bruta
   declara quantas amostras são válidas e quanto falta. Acima de 20% de dados
   faltantes o selo vira alerta e o painel avisa que as métricas derivadas têm
   confiabilidade reduzida — o cálculo não é bloqueado, é informado. */
function qualitySeal(node, td) {
  if (!td || !td.data) return;
  const st = C.nanStats(td.data);
  const pk = td.packets || {};
  const alerta = st.pctNan > 20;
  const partes = [`${st.nValid.toLocaleString('pt-BR')} / ${st.n.toLocaleString('pt-BR')} amostras válidas (${f(st.pctNan, 1)}% faltante)`];
  if (pk.method && pk.method !== 'none') partes.push(`perda detectada por ${pk.method === 'sequences' ? 'GlobalSequences' : 'TicksInMses'}`);
  else if (pk.reliable === false) partes.push('perda de pacotes não verificável neste registro');
  if (td.timing && td.timing.reliable) partes.push(`fs efetiva ${f(td.fsEff, 3)} Hz`);
  node.appendChild(el('div', { class: 'seal' + (alerta ? ' warn' : ''), text: partes.join(' · ') }));
  if (alerta) node.appendChild(el('div', {
    class: 'warnbox', html: `Este registro tem <b>${f(st.pctNan, 1)}% de dados faltantes</b> (maior lacuna contígua: ` +
      `${f(st.longestGapSamples / (td.fsEff || td.fs), 2)} s). As métricas derivadas abaixo têm <b>confiabilidade reduzida</b> — ` +
      `as lacunas não são interpoladas, e segmentos que as contêm ficam de fora do espectro.`
  }));
  if (td.timing && td.timing.warnDrift) node.appendChild(el('div', {
    class: 'warnbox', html: `<b>Deriva temporal de ${f(td.timing.driftMsTotal, 1)} ms</b> neste registro ` +
      `(fs efetiva ${f(td.fsEff, 4)} Hz vs. ${f(td.fs, 0)} Hz nominal). Relevante para análise alinhada a evento e para sincronização com dado externo.`
  }));
}

function exportRow(items) {
  const d = el('div', { class: 'ctrls' });
  items.forEach(i => d.appendChild(el('button', { class: 'btn', onclick: i.fn, text: i.label })));
  return d;
}
function table(headers, rows) {
  const t = el('table', { class: 'data' });
  t.appendChild(el('thead', {}, [el('tr', {}, headers.map(h => el('th', { text: h })))]));
  const tb = el('tbody');
  rows.forEach(r => tb.appendChild(el('tr', {}, r.map(c =>
    typeof c === 'object' && c !== null && c.html !== undefined
      ? el('td', { class: c.cls || '', html: c.html })
      : el('td', { class: (typeof c === 'number' ? 'num' : ''), text: c == null ? '—' : (typeof c === 'number' ? f(c) : String(c)) })))));
  t.appendChild(tb); return t;
}
const pTag = p => p == null || !isFinite(p) ? '—'
  : (p < 0.001 ? '<0,001' : p.toFixed(3)).replace('.', ',');
const pHtml = p => `<span class="${p < 0.05 ? 'sig' : 'ns'}">${pTag(p)}</span>`;

/* ======================================================== FIGURAS ======== */
const FIGURES = [
  /* ------------------------------------------------------------------ F1 */
  {
    id: 'F1', title: 'Espectro de potência anotado',
    sub: 'Signal Test · Survey · Snapshot — escala linear e log-log',
    has: d => d.sensingSetup.length || d.signalCheck.length || d.montage.length,
    render(node, d) {
      const src = [];
      d.sensingSetup.forEach((s, i) => s.psd && src.push({ value: 'ss' + i, label: `SignalTest ${s.channel} (${s.hemisphere})`, f: s.psd.f, p: s.psd.p, hemi: s.hemisphere, center: s.centerFreq, artifact: s.psd.artifact }));
      d.signalCheck.forEach((s, i) => src.push({ value: 'sc' + i, label: `SignalCheck ${C.prettyChannel(s.channel)}`, f: s.f, p: s.p, hemi: /LEFT/i.test(s.channel) ? 'Left' : 'Right', artifact: s.artifact }));
      d.montage.forEach((m, i) => src.push({ value: 'mo' + i, label: `Survey ${m.hemisphere[0]} · ${m.label}`, f: m.f, p: m.mag, hemi: m.hemisphere, artifact: m.artifact }));
      if (!src.length) return node.appendChild(el('div', { class: 'empty', text: 'Nenhum espectro disponível.' }));
      const cur = src.find(s => s.value === opt('F1', 'src', src[0].value)) || src[0];
      const showBands = opt('F1', 'bands', true);

      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('canal', src, cur.value, v => setOpt('F1', 'src', v)),
        ctrlCheck('faixas de frequência', showBands, v => setOpt('F1', 'bands', v))
      ]));
      const grid = el('div', { class: 'plotgrid two' }); node.appendChild(grid);

      const fmax = 60;
      const idx = cur.f.map((_, i) => i).filter(i => cur.f[i] <= fmax);
      const xs = idx.map(i => cur.f[i]), ys = idx.map(i => cur.p[i]);
      let peakI = 0; ys.forEach((v, i) => { if (xs[i] >= 4 && v > ys[peakI]) peakI = i; });

      /* (a) linear */
      const b1 = plotBox(grid, 268);
      const ch1 = new P.Chart(b1.canvas, {
        width: b1.width, height: b1.height, xlim: [0, fmax], ylim: [0, Math.max(...ys) * 1.22],
        xlabel: 'frequência (Hz)', ylabel: 'magnitude (µVp/√Hz)', title: '(a) escala linear',
        pad: { l: 58, r: 14, t: 24, b: 40 }
      });
      ch1.axes();
      if (showBands) profileBands().forEach(b => { if (b.lo < fmax) ch1.span(b.lo, Math.min(b.hi, fmax), { color: b.color, alpha: .09, label: b.label }); });
      if (cur.center) ch1.span(cur.center - 2.5, cur.center + 2.5, { color: COL.warn, alpha: .16 });
      ch1.line(xs, ys, { color: COL.ink, width: 1.6 });
      ch1.marker(xs[peakI], ys[peakI], { color: COL.right, shape: 'tri', size: 4.5, label: `${xs[peakI].toFixed(1)} Hz · ${f(ys[peakI], 2)}`, align: xs[peakI] > fmax * .6 ? 'right' : 'left' });

      /* (b) log-log */
      const pos = idx.filter(i => cur.f[i] >= 1 && cur.p[i] > 0);
      const lx = pos.map(i => cur.f[i]), ly = pos.map(i => cur.p[i]);
      const b2 = plotBox(grid, 268);
      const ch2 = new P.Chart(b2.canvas, {
        width: b2.width, height: b2.height, xlog: true, ylog: true,
        xlim: [1, Math.max(...cur.f)], ylim: [Math.max(1e-4, Math.min(...ly) * .7), Math.max(...ly) * 1.5],
        xlabel: 'frequência (Hz)', ylabel: 'magnitude (log)', title: '(b) escala log-log',
        pad: { l: 62, r: 14, t: 24, b: 40 }
      });
      ch2.axes({ xfmt: v => v >= 1 ? String(v) : v.toFixed(1) });
      ch2.line(lx, ly, { color: COL.ink, width: 1.6 });

      /* tabela de bandas */
      const bt = C.bandTable(cur.f, cur.p);
      node.appendChild(table(['banda', 'faixa', 'potência abs.', 'relativa %', 'pico (Hz)', 'magnitude'],
        bt.map(b => [{ html: `<span style="color:${b.color};font-weight:600">${b.label} ${b.key}</span>` },
        `${b.lo}–${b.hi}`, b.absolute, b.relative, b.peakF, b.peakV])));

      node.appendChild(exportRow([
        { label: '⤓ PNG (a)', fn: () => P.downloadCanvas(b1.canvas, 'F1a_psd_linear') },
        { label: '⤓ PNG (b)', fn: () => P.downloadCanvas(b2.canvas, 'F1b_psd_loglog') },
        { label: '⤓ CSV espectro', fn: () => P.downloadText(P.toCSV(cur.f.map((v, i) => ({ frequencia_Hz: v, magnitude: cur.p[i] }))), 'F1_espectro.csv', 'text/csv') }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Método.</b> Espectro nativo do dispositivo (FFT de 256 pontos sobre 250 Hz de amostragem, Δf ≈ 0,977 Hz). ` +
          `Estado do artefato reportado pelo Percept: <b>${cur.artifact || '—'}</b>. ` +
          (cur.center ? `Faixa laranja = janela de sensing crônico (${f(cur.center, 1)} ± 2,5 Hz). ` : '') +
          `A escala log-log é a forma canônica na literatura porque lineariza o componente aperiódico 1/f.`
      }));
    }
  },

  /* ------------------------------------------------------------------ F2 */
  {
    id: 'F2', title: 'Decomposição periódico / aperiódico',
    sub: 'parametrização espectral no espírito do specparam (FOOOF)',
    has: d => d.sensingSetup.length || d.montage.length || d.bsTimeDomain.length,
    render(node, d) {
      const src = [];
      d.bsTimeDomain.forEach((t, i) => src.push({ value: 'td' + i, label: `Streaming bruto ${t.label} (Welch)`, td: t }));
      d.montageTD.forEach((t, i) => src.push({ value: 'mtd' + i, label: `Survey bruto ${t.hemisphere[0]}·${t.label} (Welch)`, td: t }));
      d.sensingSetup.forEach((s, i) => s.psd && src.push({ value: 'ss' + i, label: `SignalTest ${s.channel}`, f: s.psd.f, p: s.psd.p }));
      d.montage.forEach((m, i) => src.push({ value: 'mo' + i, label: `Survey ${m.hemisphere[0]}·${m.label}`, f: m.f, p: m.mag }));
      if (!src.length) return node.appendChild(el('div', { class: 'empty', text: 'Nenhum espectro disponível.' }));
      const cur = src.find(s => s.value === opt('F2', 'src', src[0].value)) || src[0];
      const fmin = opt('F2', 'fmin', 2), fmax = opt('F2', 'fmax', 95);

      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('fonte', src, cur.value, v => setOpt('F2', 'src', v)),
        ctrlNumber('f min', fmin, 1, 20, 0.5, v => setOpt('F2', 'fmin', v)),
        ctrlNumber('f max', fmax, 30, 100, 5, v => setOpt('F2', 'fmax', v))
      ]));
      let ff, pp;
      if (cur.td) { const w = C.welchPSD(cur.td.data, cur.td.fs, { nperseg: 512, overlap: .5 }); ff = Array.from(w.f); pp = Array.from(w.p); }
      else { ff = cur.f; pp = cur.p; }
      const ap = C.fitAperiodic(ff, pp, { fmin, fmax });
      if (!ap) return node.appendChild(el('div', { class: 'empty', text: 'Dados insuficientes para o ajuste.' }));

      const grid = el('div', { class: 'plotgrid two' }); node.appendChild(grid);
      const b1 = plotBox(grid, 272);
      const ch = new P.Chart(b1.canvas, {
        width: b1.width, height: b1.height, xlog: true, ylog: true,
        xlim: [fmin, fmax], ylim: [Math.max(1e-5, Math.min(...ap.aperiodic) * .5), Math.max(...ap.observed) * 1.6],
        xlabel: 'frequência (Hz)', ylabel: 'potência (log)', title: '(a) modelo espectral', pad: { l: 62, r: 14, t: 24, b: 40 }
      });
      ch.axes({ xfmt: v => String(v) });
      ch.area(ap.f, ap.aperiodic, ap.observed.map((v, i) => Math.max(v, ap.aperiodic[i])), { color: COL.accent, alpha: .22, label: 'periódico' });
      ch.line(ap.f, ap.observed, { color: COL.ink, width: 1.6, label: 'observado' });
      ch.line(ap.f, ap.aperiodic, { color: COL.muted, width: 1.5, dash: [5, 3], label: `aperiódico (χ=${f(ap.exponent, 2)})` });
      ch.legend({ x: ch.x0 + 8, y: ch.y1 + 6 });

      const b2 = plotBox(grid, 272);
      const ch2 = new P.Chart(b2.canvas, {
        width: b2.width, height: b2.height, xlim: [fmin, Math.min(fmax, 60)],
        ylim: [Math.min(0, Math.min(...ap.periodic)), Math.max(...ap.periodic) * 1.25],
        xlabel: 'frequência (Hz)', ylabel: 'potência periódica', title: '(b) componente periódico (resíduo)', pad: { l: 58, r: 14, t: 24, b: 40 }
      });
      ch2.axes();
      profileBands().forEach(b => ch2.span(b.lo, Math.min(b.hi, fmax), { color: b.color, alpha: .08, label: b.label }));
      ch2.hline(0, { color: COL.rule, dash: [2, 2] });
      ch2.line(ap.f, ap.periodic, { color: COL.accent, width: 1.7 });
      ap.peaks.slice(0, 3).forEach(pk => ch2.marker(pk.cf, pk.power, { color: COL.right, size: 3.4, label: `${f(pk.cf, 1)}` }));

      node.appendChild(table(['parâmetro', 'valor', 'interpretação'], [
        ['expoente aperiódico χ', f(ap.exponent, 3), 'inclinação 1/f; associado a balanço E/I'],
        ['offset', f(ap.offset, 3), 'potência de banda larga (log)'],
        ['R² do ajuste', f(ap.r2, 3), 'qualidade do modelo aperiódico'],
        ['picos detectados', ap.peaks.length, ap.peaks.map(p => `${f(p.cf, 1)}Hz(${p.band})`).join(' · ') || '—']
      ]));
      node.appendChild(exportRow([
        { label: '⤓ PNG (a)', fn: () => P.downloadCanvas(b1.canvas, 'F2a_specparam') },
        { label: '⤓ PNG (b)', fn: () => P.downloadCanvas(b2.canvas, 'F2b_periodico') },
        { label: '⤓ CSV modelo', fn: () => P.downloadText(P.toCSV(ap.f.map((v, i) => ({ f_Hz: v, observado: ap.observed[i], aperiodico: ap.aperiodic[i], periodico: ap.periodic[i] }))), 'F2_specparam.csv', 'text/csv') }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Método.</b> Regressão robusta iterativa em log-log com exclusão progressiva de resíduos positivos (picos), ` +
          `seguida de detecção de picos no resíduo com largura a meia-altura. É uma aproximação do algoritmo specparam/FOOOF (Donoghue et al., 2020) ` +
          `implementada sem dependências; para publicação, confirme os parâmetros com a implementação oficial em Python.`
      }));
    }
  },

  /* ------------------------------------------------------------------ F3 */
  {
    id: 'F3', title: 'Integridade de eletrodos',
    sub: 'impedâncias monopolares e matriz bipolar, bilateral',
    has: d => Object.keys(d.impedance).length,
    render(node, d) {
      const hemis = Object.keys(d.impedance);
      const labels = ['0', '1a', '1b', '1c', '2a', '2b', '2c', '3'];
      const grid = el('div', { class: 'plotgrid two' }); node.appendChild(grid);

      const b1 = plotBox(grid, 250);
      const allv = hemis.flatMap(h => d.impedance[h].mono.map(m => m.ohm));
      const ch = new P.Chart(b1.canvas, {
        width: b1.width, height: b1.height, xlim: [-0.6, labels.length - 0.4], ylim: [0, Math.max(...allv) * 1.18],
        xlabel: 'contato', ylabel: 'impedância monopolar (Ω)', title: '(a) contato vs. case', pad: { l: 62, r: 14, t: 24, b: 40 }
      });
      ch.axes({ xticks: labels.map((_, i) => i), xfmt: v => labels[v] || '' });
      ch.span(-0.6, labels.length - 0.4, { color: COL.ok, alpha: 0 });
      ch.hline(2000, { color: COL.ok, dash: [3, 3], label: 'referência 2 kΩ' });
      hemis.forEach((h, hi) => {
        const vals = labels.map(L => { const m = d.impedance[h].mono.find(x => x.b === L || x.a === L); return m ? m.ohm : NaN; });
        const w = (ch.X(1) - ch.X(0)) * .38;
        ch.bars(labels.map((_, i) => i + (hi - (hemis.length - 1) / 2) * w * 1.05), vals,
          { color: hcol(h), width: w, label: `STN ${hname(h)}` });
      });
      ch.legend({ x: ch.x0 + 8, y: ch.y1 + 6 });

      const hSel = opt('F3', 'hemi', hemis[0]);
      node.appendChild(el('div', { class: 'ctrls' }, [ctrlSelect('matriz bipolar', hemis.map(h => ({ value: h, label: 'STN ' + hname(h) })), hSel, v => setOpt('F3', 'hemi', v))]));
      const b2 = plotBox(grid, 250);
      const M = labels.map(() => labels.map(() => NaN));
      d.impedance[hSel].bipolar.forEach(e => {
        const i = labels.indexOf(e.a), j = labels.indexOf(e.b);
        if (i >= 0 && j >= 0) { M[i][j] = e.ohm; M[j][i] = e.ohm; }
      });
      const ch2 = new P.Chart(b2.canvas, {
        width: b2.width, height: b2.height, xlim: [0, labels.length], ylim: [0, labels.length],
        xlabel: 'contato', ylabel: 'contato', title: `(b) bipolar — STN ${hname(hSel)} (Ω)`, pad: { l: 46, r: 62, t: 24, b: 40 }
      });
      ch2.heat(M.slice().reverse(), { cmap: 'ice', smooth: false });
      ch2.axes({ grid: false, xticks: labels.map((_, i) => i + .5), yticks: labels.map((_, i) => i + .5), xfmt: v => labels[Math.floor(v)] || '', yfmt: v => labels[labels.length - 1 - Math.floor(v)] || '' });
      ch2.colorbar({ label: 'Ω' });

      const st = (S.files[0] || {}).parsed;
      const flag = allv.some(v => v > 4000 || v < 500);
      if (flag) node.appendChild(el('div', {
        class: 'warnbox', html: `Há contatos fora da faixa habitual (500–2000 Ω). Status reportado pelo dispositivo: <b>${(st && st.impedanceStatus) || '—'}</b>. ` +
          `Valores altos em contatos segmentados são esperados (área de superfície menor); o que importa é a <b>estabilidade seriada</b> e a ausência de valores extremos (curto &lt;50 Ω, circuito aberto &gt;10 kΩ).`
      }));
      node.appendChild(exportRow([
        { label: '⤓ PNG (a)', fn: () => P.downloadCanvas(b1.canvas, 'F3a_impedancia_mono') },
        { label: '⤓ PNG (b)', fn: () => P.downloadCanvas(b2.canvas, 'F3b_impedancia_bipolar') },
        { label: '⤓ CSV', fn: () => P.downloadText(P.toCSV(hemis.flatMap(h => [].concat(
          d.impedance[h].mono.map(m => ({ hemisferio: h, tipo: 'monopolar', a: m.a, b: m.b, ohm: m.ohm })),
          d.impedance[h].bipolar.map(m => ({ hemisferio: h, tipo: 'bipolar', a: m.a, b: m.b, ohm: m.ohm }))))), 'F3_impedancias.csv', 'text/csv')
        }
      ]));
    }
  },

  /* ------------------------------------------------------------------ F4 */
  {
    id: 'F4', title: 'Linha do tempo da sessão e parâmetros',
    sub: 'EventLogs, grupos ativos e configuração de estimulação',
    has: d => d.eventLogs.length || d.all.some(p => p.groups.length),
    render(node, d) {
      const logs = d.eventLogs.filter(e => isFinite(e.t)).sort((a, b) => a.t - b.t);
      if (logs.length > 1) {
        const box = plotBox(node, 150);
        const t0 = logs[0].t, t1 = logs[logs.length - 1].t;
        const ch = new P.Chart(box.canvas, {
          width: box.width, height: box.height, xlim: [t0 - (t1 - t0) * .03, t1 + (t1 - t0) * .03], ylim: [0, 1],
          xlabel: 'data/hora local', title: 'eventos registrados no dispositivo', pad: { l: 20, r: 20, t: 24, b: 42 }
        });
        ch.axes({
          ny: 2, yticks: [], nx: 5,
          xfmt: v => new Date(v + offMin() * 60000).toISOString().slice(5, 16).replace('T', ' ')
        });
        const kinds = Array.from(new Set(logs.map(l => l.kind)));
        logs.forEach(l => {
          const y = 0.15 + 0.7 * (kinds.indexOf(l.kind) / Math.max(1, kinds.length - 1));
          ch.marker(l.t, y, { color: /TherapyStatus/i.test(l.kind) ? COL.right : COL.accent, size: 3.6 });
        });
        kinds.forEach((k, i) => ch.text(ch.x0 + 4, ch.Y(0.15 + 0.7 * (i / Math.max(1, kinds.length - 1))) - 12, k, { color: COL.muted }));
        node.appendChild(exportRow([{ label: '⤓ PNG', fn: () => P.downloadCanvas(box.canvas, 'F4_timeline_sessao') }]));
      }
      const rows = [];
      d.all.forEach(p => p.groups.forEach(g => g.programs.forEach(pr => rows.push([
        p.fileName.slice(-19, -5), g.id + (g.active ? ' ●' : ''),
        { html: `<span class="hemi-${pr.hemisphere[0]}">${hname(pr.hemisphere)}</span>` },
        pr.contacts.join('+') || '—', pr.amplitude, pr.pulseWidth, pr.rate
      ]))));
      if (rows.length) node.appendChild(table(['arquivo', 'grupo', 'hemisfério', 'contatos', 'mA', 'µs', 'Hz'], rows));
      const sens = [];
      d.all.forEach(p => (p.sensingSetup || []).forEach(s => sens.push([
        { html: `<span class="hemi-${s.hemisphere[0]}">${hname(s.hemisphere)}</span>` }, C.prettyChannel(s.channel),
        s.centerFreq, s.averagingMs, s.lowerThr, s.upperThr,
        { html: (s.measuredLower === 0 && s.measuredUpper === 0) ? '<span class="ns">não calibrado</span>' : `${f(s.measuredLower)} / ${f(s.measuredUpper)}` }
      ])));
      if (sens.length) {
        node.appendChild(el('h4', { class: 'note', html: '<b>Configuração de sensing</b>' }));
        node.appendChild(table(['hemisfério', 'canal', 'f alvo (Hz)', 'média (ms)', 'limiar inf.', 'limiar sup.', 'LFP medido inf./sup.'], sens));
      }
      const logRows = logs.slice(-25).map(l => [new Date(l.t + offMin() * 60000).toISOString().slice(0, 16).replace('T', ' '), l.kind, l.detail || '—']);
      if (logRows.length) node.appendChild(table(['data/hora local', 'evento', 'detalhe'], logRows));
    }
  },

  /* ------------------------------------------------------------------ F5 */
  {
    id: 'F5', title: 'Mapa da montagem — canal × frequência',
    sub: 'BrainSense Survey: escolha do contato de sensing',
    has: d => d.montage.length,
    render(node, d) {
      const hemis = Array.from(new Set(d.montage.map(m => m.hemisphere)));
      const norm = opt('F5', 'norm', false);
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlCheck('normalizar cada canal pelo próprio máximo', norm, v => setOpt('F5', 'norm', v))
      ]));
      const grid = el('div', { class: 'plotgrid two' }); node.appendChild(grid);
      const boxes = [];
      hemis.forEach(h => {
        const rows = d.montage.filter(m => m.hemisphere === h);
        if (!rows.length) return;
        const fmax = 60;
        const fi = rows[0].f.map((_, i) => i).filter(i => rows[0].f[i] <= fmax);
        const M = rows.map(r => { const v = fi.map(i => r.mag[i]); const mx = Math.max(...v) || 1; return norm ? v.map(x => x / mx) : v; });
        const box = plotBox(grid, 34 + rows.length * 15); boxes.push(box);
        const ch = new P.Chart(box.canvas, {
          width: box.width, height: box.height, xlim: [0, fmax], ylim: [0, rows.length],
          xlabel: 'frequência (Hz)', title: `STN ${hname(h)} — ${rows.length} canais`, pad: { l: 62, r: 60, t: 24, b: 40 }
        });
        ch.heat(M.slice().reverse(), { cmap: 'magma', smooth: true });
        ch.axes({ grid: false, yticks: rows.map((_, i) => i + .5), yfmt: v => (rows[rows.length - 1 - Math.floor(v)] || {}).label || '' });
        ch.colorbar({ label: norm ? 'norm.' : 'µVp' });
        /* marca a banda PRIMÁRIA do perfil ativo (beta em DP, teta-alfa em
           distonia, frequência do tremor em TE) — não mais "beta" fixo */
        const pbF5 = activeProfile().primaryBand;
        ch.vline(pbF5.lo, { color: '#fff', dash: [3, 3] });
        ch.vline(Math.min(pbF5.hi, fmax), { color: '#fff', dash: [3, 3] });
      });
      const rank = d.montage.slice().sort((a, b) => b.peakMag - a.peakMag).slice(0, 12).map(m => [
        { html: `<span class="hemi-${m.hemisphere[0]}">${hname(m.hemisphere)}</span>` }, m.label, m.peakF, m.peakMag,
        { html: C.bandOf(m.peakF) }, { html: m.artifact === 'ARTIFACT_NOT_PRESENT' ? '<span class="ns">sem artefato</span>' : `<span style="color:var(--warn)">${m.artifact}</span>` }
      ]);
      node.appendChild(table(['hemisfério', 'canal', 'pico (Hz)', 'magnitude (µVp)', 'banda', 'artefato'], rank));
      node.appendChild(exportRow([
        ...boxes.map((b, i) => ({ label: `⤓ PNG ${hemis[i][0]}`, fn: () => P.downloadCanvas(b.canvas, `F5_survey_${hemis[i]}`) })),
        { label: '⤓ CSV picos', fn: () => P.downloadText(P.toCSV(d.montage.map(m => ({ hemisferio: m.hemisphere, canal: m.label, pico_Hz: m.peakF, magnitude_uVp: m.peakMag, artefato: m.artifact }))), 'F5_survey_picos.csv', 'text/csv') }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Leitura.</b> Cada linha é um par bipolar; o brilho é a magnitude espectral. As linhas tracejadas brancas delimitam a banda beta. ` +
          `O canal com maior pico beta é o candidato natural ao sensing crônico. Compare com o contato de estimulação: registrar em contatos que flanqueiam o de estimulação (0–2, 1–3) minimiza o artefato de estimulação.`
      }));
    }
  },

  /* ------------------------------------------------------------------ F6 */
  {
    id: 'F6', title: 'Domínio do tempo — traçado, espectrograma e bursts',
    sub: 'BrainSense Streaming / Survey a 250 Hz',
    has: d => d.bsTimeDomain.length || d.montageTD.length,
    render(node, d) {
      const src = [].concat(
        d.bsTimeDomain.map((t, i) => ({ value: 'bs' + i, label: `Streaming ${t.label} (${(t.data.length / t.fs).toFixed(0)} s)`, td: t })),
        d.montageTD.map((t, i) => ({ value: 'mt' + i, label: `Survey ${t.hemisphere[0]}·${t.label} (${(t.data.length / t.fs).toFixed(0)} s)`, td: t })));
      if (!src.length) return node.appendChild(el('div', { class: 'empty', text: 'Nenhum sinal bruto disponível.' }));
      const cur = src.find(s => s.value === opt('F6', 'src', src[0].value)) || src[0];
      const td = cur.td;
      const doEcg = opt('F6', 'ecg', false);
      const blo = opt('F6', 'blo', 13), bhi = opt('F6', 'bhi', 20);
      const pct = opt('F6', 'pct', 75), minMs = opt('F6', 'minms', 100);
      const winS = opt('F6', 'win', Math.min(20, Math.round(td.data.length / td.fs)));

      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('sinal', src, cur.value, v => setOpt('F6', 'src', v)),
        ctrlCheck('remover artefato cardíaco', doEcg, v => setOpt('F6', 'ecg', v)),
        ctrlNumber('banda inf.', blo, 1, 90, 1, v => setOpt('F6', 'blo', v)),
        ctrlNumber('banda sup.', bhi, 2, 100, 1, v => setOpt('F6', 'bhi', v)),
        ctrlNumber('percentil', pct, 50, 95, 5, v => setOpt('F6', 'pct', v)),
        ctrlNumber('dur. mín (ms)', minMs, 20, 400, 10, v => setOpt('F6', 'minms', v)),
        ctrlNumber('janela vista (s)', winS, 2, 120, 2, v => setOpt('F6', 'win', v))
      ]));

      qualitySeal(node, td);

      let x = td.data, ecg = null;
      if (doEcg) { ecg = C.ecgTemplateSubtract(td.data, td.fs); x = ecg.cleaned; }

      /* (a) traçado */
      const nView = Math.min(x.length, Math.round(winS * td.fs));
      const tv = Array.from({ length: nView }, (_, i) => i / td.fs);
      const b1 = plotBox(node, 190);
      const yv = Array.from(x.slice(0, nView));
      const amp = Math.max(...yv.map(Math.abs)) * 1.15;
      const ch1 = new P.Chart(b1.canvas, {
        width: b1.width, height: b1.height, xlim: [0, nView / td.fs], ylim: [-amp, amp],
        xlabel: 'tempo (s)', ylabel: 'µV', title: `(a) ${td.label} · ${td.fs} Hz${doEcg ? ' · ECG removido' : ''}`, pad: { l: 58, r: 14, t: 24, b: 38 }
      });
      ch1.axes();
      if (doEcg) ch1.line(tv, Array.from(td.data.slice(0, nView)), { color: '#C9D3DC', width: 1, label: 'bruto' });
      ch1.line(tv, yv, { color: COL.ink, width: 1, label: doEcg ? 'limpo' : 'sinal' });
      if (doEcg) ch1.legend({ x: ch1.x0 + 8, y: ch1.y1 + 6 });

      /* (b) espectrograma */
      const sg = C.spectrogram(x, td.fs, { window: 256, hop: 64, fmax: 60 });
      const logS = sg.S.map(c => Array.from(c, v => 10 * Math.log10(Math.max(v, 1e-12))));
      const flat = logS.flat().filter(isFinite).sort((a, b) => a - b);
      const zmin = flat[Math.floor(flat.length * .05)], zmax = flat[Math.floor(flat.length * .995)];
      const Mt = sg.f.map((_, fi) => logS.map(col => col[fi]));
      const b2 = plotBox(node, 230);
      const ch2 = new P.Chart(b2.canvas, {
        width: b2.width, height: b2.height, xlim: [sg.t[0], sg.t[sg.t.length - 1]], ylim: [0, 60],
        xlabel: 'tempo (s)', ylabel: 'frequência (Hz)', title: '(b) espectrograma (dB)', pad: { l: 58, r: 62, t: 24, b: 38 }
      });
      ch2.heat(Mt.slice().reverse(), { cmap: 'viridis', zmin, zmax, smooth: true });
      ch2.axes({ grid: false });
      ch2.colorbar({ label: 'dB' });

      /* (c) envelope + bursts */
      const bp = C.bandpassFFT(x, td.fs, blo, bhi);
      const env = C.hilbertEnvelope(bp);
      const bu = C.detectBursts(env, td.fs, { percentile: pct, minDurationMs: minMs });
      const b3 = plotBox(node, 190);
      const ch3 = new P.Chart(b3.canvas, {
        width: b3.width, height: b3.height, xlim: [0, nView / td.fs], ylim: [-Math.max(...Array.from(env.slice(0, nView))) * 1.1, Math.max(...Array.from(env.slice(0, nView))) * 1.25],
        xlabel: 'tempo (s)', ylabel: 'µV', title: `(c) ${blo}–${bhi} Hz · envelope de Hilbert · bursts > p${pct}`, pad: { l: 58, r: 14, t: 24, b: 38 }
      });
      ch3.axes();
      bu.bursts.filter(b => b.start < nView / td.fs).forEach(b => ch3.span(b.start, Math.min(b.end, nView / td.fs), { color: COL.warn, alpha: .22 }));
      ch3.line(tv, Array.from(bp.slice(0, nView)), { color: '#9FB3C0', width: .9 });
      ch3.line(tv, Array.from(env.slice(0, nView)), { color: COL.ink, width: 1.5 });
      ch3.hline(bu.threshold, { color: COL.right, dash: [4, 3], label: `p${pct} = ${f(bu.threshold, 2)}` });

      /* (d) histograma de duração + (e) curva limiar-dependente */
      const grid = el('div', { class: 'plotgrid two' }); node.appendChild(grid);
      const b4 = plotBox(grid, 210);
      const hh = bu.durationHistogram;
      const ch4 = new P.Chart(b4.canvas, {
        width: b4.width, height: b4.height, xlim: [-.6, hh.labels.length - .4], ylim: [0, Math.max(...hh.pct) * 1.2],
        xlabel: 'duração do burst (ms)', ylabel: '% dos bursts', title: '(d) perfil de duração', pad: { l: 52, r: 14, t: 24, b: 42 }
      });
      ch4.axes({ xticks: hh.labels.map((_, i) => i), xfmt: v => hh.labels[v] || '' });
      ch4.bars(hh.labels.map((_, i) => i), hh.pct, { color: COL.accent, width: (ch4.X(1) - ch4.X(0)) * .62 });

      const pcts = [55, 60, 65, 70, 75, 80, 85, 90];
      const sortedEnv = Array.from(env).sort((a, b) => a - b);
      const qEnv = q => sortedEnv[Math.min(sortedEnv.length - 1, Math.round(q * (sortedEnv.length - 1)))];
      const curve = pcts.map(p => C.detectBursts(env, td.fs, { percentile: p, minDurationMs: minMs, threshold: qEnv(p / 100) }).meanDurationMs);
      const b5 = plotBox(grid, 210);
      const ch5 = new P.Chart(b5.canvas, {
        width: b5.width, height: b5.height, xlim: [50, 95], ylim: [0, Math.max(...curve) * 1.2],
        xlabel: 'percentil do limiar', ylabel: 'duração média (ms)', title: '(e) sensibilidade ao limiar', pad: { l: 58, r: 14, t: 24, b: 42 }
      });
      ch5.axes();
      ch5.line(pcts, curve, { color: COL.ink, width: 1.8 });
      ch5.scatter(pcts, curve, { color: COL.right, size: 3.4 });
      ch5.vline(pct, { color: COL.warn, label: 'atual' });

      const psd = C.welchPSD(x, td.fs, { nperseg: 512, overlap: .5 });
      node.appendChild(table(['métrica', 'valor'], [
        ['duração do registro', `${(td.data.length / td.fs).toFixed(1)} s (${td.data.length} amostras)`],
        ['bursts detectados', `${bu.n} (${f(bu.rate, 2)}/s)`],
        ['duração mediana / média', `${f(bu.medianDurationMs, 0)} / ${f(bu.meanDurationMs, 0)} ms`],
        ['probabilidade de burst', `${f(100 * bu.probability, 1)} % do tempo`],
        ['potência beta 13–30 Hz', f(C.bandPower(psd.f, psd.p, 13, 30), 3)],
        ...(ecg ? [['artefato cardíaco', `${ecg.nBeats} batimentos · ${f(ecg.bpm, 0)} bpm · template subtraído`]] : [])
      ]));
      node.appendChild(exportRow([
        { label: '⤓ PNG traçado', fn: () => P.downloadCanvas(b1.canvas, 'F6a_tracado') },
        { label: '⤓ PNG espectrograma', fn: () => P.downloadCanvas(b2.canvas, 'F6b_espectrograma') },
        { label: '⤓ PNG bursts', fn: () => P.downloadCanvas(b3.canvas, 'F6c_bursts') },
        { label: '⤓ CSV bursts', fn: () => P.downloadText(P.toCSV(bu.bursts.map(b => ({ inicio_s: b.start, fim_s: b.end, duracao_ms: b.durationMs, amplitude_media: b.mean, pico: b.peak }))), 'F6_bursts.csv', 'text/csv') },
        { label: '⤓ CSV sinal', fn: () => P.downloadText(P.toCSV(Array.from(x).map((v, i) => ({ t_s: i / td.fs, uV: v }))), 'F6_sinal.csv', 'text/csv') }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Método.</b> Filtro passa-banda de fase zero por FFT, envelope pela transformada de Hilbert, limiar no percentil ${pct} da distribuição do envelope ` +
          `e exclusão de bursts &lt; ${minMs} ms. O painel (e) mostra por que o percentil deve ser <b>pré-registrado</b>: a duração média varia sistematicamente com ele. ` +
          `A remoção de artefato cardíaco usa subtração de template do QRS.`
      }));
    }
  },

  /* ------------------------------------------------------------------ F7 */
  {
    id: 'F7', title: 'Streaming com estimulação — potência × amplitude',
    sub: 'BrainSenseLfp: série a 2 Hz e curva dose-resposta',
    has: d => d.bsLfp.length,
    render(node, d) {
      const opts = [];
      d.bsLfp.forEach((b, i) => Object.keys(b.series).forEach(h => opts.push({ value: i + '|' + h, label: `${C.prettyChannel(b.channel)} · ${hname(h)}`, b, h })));
      if (!opts.length) return node.appendChild(el('div', { class: 'empty', text: 'Sem streaming de potência.' }));
      const cur = opts.find(o => o.value === opt('F7', 'src', opts[0].value)) || opts[0];
      node.appendChild(el('div', { class: 'ctrls' }, [ctrlSelect('canal', opts, cur.value, v => setOpt('F7', 'src', v))]));
      const s = cur.b.series[cur.h], th = cur.b.therapy.perHemi[cur.h] || {};

      const b1 = plotBox(node, 250);
      const maxL = Math.max(...s.lfp), maxA = Math.max(...s.ma, 0.1);
      const ch = new P.Chart(b1.canvas, {
        width: b1.width, height: b1.height, xlim: [0, s.t[s.t.length - 1]], ylim: [0, maxL * 1.15],
        xlabel: 'tempo (s)', ylabel: 'potência LFP (u.a.)',
        title: `(a) potência na banda ${f(th.centerFreq, 1)} Hz e amplitude de estimulação`, pad: { l: 62, r: 52, t: 24, b: 40 }
      });
      ch.axes();
      const scaled = s.ma.map(v => v / maxA * maxL * .95);
      ch.area(s.t, s.ma.map(() => 0), scaled, { color: COL.accent, alpha: .16, label: 'estimulação (mA)' });
      ch.line(s.t, s.lfp, { color: hcol(cur.h), width: 1.3, label: 'potência LFP' });
      if (isFinite(th.lowerThr) && th.lowerThr > 0) { ch.hline(th.lowerThr, { color: COL.muted, label: 'limiar inf.' }); ch.hline(th.upperThr, { color: COL.muted, label: 'limiar sup.' }); }
      ch.legend({ x: ch.x0 + 8, y: ch.y1 + 6 });
      /* eixo direito de mA */
      ch.text(ch.x1 + 8, ch.y1, `mA`, { color: COL.accent });
      [0, .25, .5, .75, 1].forEach(fr => ch.text(ch.x1 + 8, ch.Y(fr * maxL * .95) - 5, f(fr * maxA, 1), { color: COL.accent }));

      /* dose-resposta */
      const levels = {};
      s.ma.forEach((m, i) => { const k = m.toFixed(2); (levels[k] = levels[k] || []).push(s.lfp[i]); });
      const keys = Object.keys(levels).map(parseFloat).sort((a, b) => a - b).filter(k => levels[k.toFixed(2)].length >= 4);
      if (keys.length >= 3) {
        const grid = el('div', { class: 'plotgrid two' }); node.appendChild(grid);
        const meds = keys.map(k => C.median(levels[k.toFixed(2)]));
        const q1 = keys.map(k => C.quantile(levels[k.toFixed(2)], .25));
        const q3 = keys.map(k => C.quantile(levels[k.toFixed(2)], .75));
        const b2 = plotBox(grid, 240);
        const ch2 = new P.Chart(b2.canvas, {
          width: b2.width, height: b2.height, xlim: [Math.min(...keys) - .05, Math.max(...keys) + .05], ylim: [0, Math.max(...q3) * 1.15],
          xlabel: 'amplitude de estimulação (mA)', ylabel: 'potência LFP (mediana)', title: '(b) dose-resposta', pad: { l: 62, r: 14, t: 24, b: 42 }
        });
        ch2.axes();
        ch2.area(keys, q1, q3, { color: hcol(cur.h), alpha: .18, label: 'IQR' });
        ch2.line(keys, meds, { color: hcol(cur.h), width: 2 });
        ch2.scatter(keys, meds, { color: COL.ink, size: 3.4 });
        const lr = C.linreg(keys, meds);
        ch2.line([keys[0], keys[keys.length - 1]], [lr.intercept + lr.slope * keys[0], lr.intercept + lr.slope * keys[keys.length - 1]],
          { color: COL.warn, width: 1.4, dash: [5, 3], label: `β=${f(lr.slope, 1)}/mA · R²=${f(lr.r2, 2)}` });
        ch2.legend({ x: ch2.x0 + 8, y: ch2.y1 + 6 });

        /* boxplot por nível */
        const b3 = plotBox(grid, 240);
        const ch3 = new P.Chart(b3.canvas, {
          width: b3.width, height: b3.height, xlim: [-.6, keys.length - .4], ylim: [0, Math.max(...keys.map(k => C.quantile(levels[k.toFixed(2)], .95))) * 1.1],
          xlabel: 'amplitude (mA)', ylabel: 'potência LFP', title: '(c) distribuição por nível', pad: { l: 62, r: 14, t: 24, b: 42 }
        });
        ch3.axes({ xticks: keys.map((_, i) => i), xfmt: v => keys[v] != null ? f(keys[v], 1) : '' });
        keys.forEach((k, i) => {
          const v = levels[k.toFixed(2)];
          const lo = C.quantile(v, .05), hi = C.quantile(v, .95);
          ch3.line([i, i], [lo, hi], { color: COL.muted, width: 1 });
          const x0 = ch3.X(i) - 8, y1 = ch3.Y(C.quantile(v, .75)), y2 = ch3.Y(C.quantile(v, .25));
          ch3.ctx.fillStyle = hcol(cur.h); ch3.ctx.globalAlpha = .5;
          ch3.ctx.fillRect(x0, y1, 16, y2 - y1); ch3.ctx.globalAlpha = 1;
          ch3.ctx.strokeStyle = COL.ink; ch3.ctx.beginPath();
          ch3.ctx.moveTo(x0, ch3.Y(C.median(v)) + .5); ch3.ctx.lineTo(x0 + 16, ch3.Y(C.median(v)) + .5); ch3.ctx.stroke();
        });
        const first = levels[keys[0].toFixed(2)], last = levels[keys[keys.length - 1].toFixed(2)];
        const pt = C.permutationTest(first, last, 3000);
        node.appendChild(table(['comparação', 'n', 'mediana', 'teste'], [
          [`${f(keys[0], 1)} mA`, first.length, C.median(first), ''],
          [`${f(keys[keys.length - 1], 1)} mA`, last.length, C.median(last), ''],
          ['permutação (5.000)', '', '', { html: `Δ=${f(pt.observed, 1)} · p ${pHtml(pt.p)}` }]
        ]));
        node.appendChild(exportRow([
          { label: '⤓ PNG série', fn: () => P.downloadCanvas(b1.canvas, 'F7a_streaming') },
          { label: '⤓ PNG dose-resposta', fn: () => P.downloadCanvas(b2.canvas, 'F7b_dose_resposta') },
          { label: '⤓ CSV', fn: () => P.downloadText(P.toCSV(s.t.map((t, i) => ({ t_s: t, lfp: s.lfp[i], mA: s.ma[i] }))), 'F7_streaming.csv', 'text/csv') }
        ]));
      } else {
        node.appendChild(el('div', { class: 'warnbox', html: 'A amplitude de estimulação não variou o suficiente neste registro para uma curva dose-resposta. Para obtê-la, execute uma rampa de titulação durante o streaming.' }));
        node.appendChild(exportRow([{ label: '⤓ PNG série', fn: () => P.downloadCanvas(b1.canvas, 'F7a_streaming') }]));
      }
      node.appendChild(el('div', {
        class: 'note', html: `<b>Leitura.</b> A potência é calculada pelo próprio dispositivo em janela de ${f(th.averagingMs, 0)} ms centrada em ${f(th.centerFreq, 1)} Hz e amostrada a 2 Hz. ` +
          `A supressão beta dose-dependente é o achado esperado com estimulação eficaz. Cuidado: amplitudes altas também introduzem artefato residual, então uma <i>queda</i> aparente pode ser saturação — inspecione o sinal bruto (F6) em paralelo.`
      }));
    }
  },

  /* ------------------------------------------------------------------ F8 */
  {
    id: 'F8', title: 'Timeline crônico — série temporal multi-dia',
    sub: 'LFPTrendLogs: potência a cada 10 min',
    has: d => Object.keys(d.trend).length,
    render(node, d) {
      const hemis = Object.keys(d.trend);
      const k = opt('F8', 'mad', 4), showMa = opt('F8', 'ma', true), smooth = opt('F8', 'smooth', 6);
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlNumber('outliers: k×MAD', k, 2, 10, .5, v => setOpt('F8', 'mad', v)),
        ctrlNumber('suavização (pontos)', smooth, 1, 72, 1, v => setOpt('F8', 'smooth', v)),
        ctrlCheck('mostrar amplitude de estimulação', showMa, v => setOpt('F8', 'ma', v))
      ]));
      const cleaned = {}; let tmin = Infinity, tmax = -Infinity, vmax = 0;
      hemis.forEach(h => {
        const c = C.removeOutliersMAD(d.trend[h], 'lfp', k);
        cleaned[h] = c;
        c.kept.forEach(r => { if (r.t < tmin) tmin = r.t; if (r.t > tmax) tmax = r.t; if (r.lfp > vmax) vmax = r.lfp; });
      });
      const box = plotBox(node, 290);
      const ch = new P.Chart(box.canvas, {
        width: box.width, height: box.height, xlim: [tmin, tmax], ylim: [0, vmax * 1.12],
        xlabel: 'data local', ylabel: 'potência LFP (u.a.)', title: 'potência crônica por hemisfério', pad: { l: 62, r: 52, t: 24, b: 42 }
      });
      ch.axes({ nx: 7, xfmt: v => new Date(v + offMin() * 60000).toISOString().slice(5, 10).split('-').reverse().join('/') });
      /* faixas noturnas */
      const dayMs = 864e5;
      for (let t = tmin - dayMs; t < tmax + dayMs; t += dayMs) {
        const base = Math.floor((t + offMin() * 60000) / dayMs) * dayMs - offMin() * 60000;
        ch.span(base + 22 * 36e5, base + 30 * 36e5, { color: '#1B3A5C', alpha: .05 });
      }
      hemis.forEach(h => {
        const rows = cleaned[h].kept;
        const xs = rows.map(r => r.t), ys = rows.map(r => r.lfp);
        ch.scatter(xs, ys, { color: hcol(h), size: 1.1, alpha: .28 });
        if (smooth > 1) {
          const sm = movingMedian(ys, smooth);
          ch.line(xs, sm, { color: hcol(h), width: 1.6, label: `STN ${hname(h)}` });
        } else ch.line(xs, ys, { color: hcol(h), width: .8, label: `STN ${hname(h)}` });
      });
      if (showMa) {
        const maMax = Math.max(...hemis.flatMap(h => cleaned[h].kept.map(r => r.ma)), .1);
        hemis.forEach(h => ch.line(cleaned[h].kept.map(r => r.t), cleaned[h].kept.map(r => r.ma / maMax * vmax * .28),
          { color: COL.accent, width: 1, dash: [3, 2] }));
        ch.text(ch.x1 + 6, ch.Y(vmax * .28) - 6, `${f(maMax, 1)} mA`, { color: COL.accent });
        ch.text(ch.x1 + 6, ch.Y(0) - 6, '0 mA', { color: COL.accent });
      }
      ch.legend({ x: ch.x0 + 8, y: ch.y1 + 6 });

      node.appendChild(table(['hemisfério', 'n pontos', 'removidos', 'período', 'mediana', 'IQR', 'MAD'],
        hemis.map(h => {
          const c = cleaned[h], v = c.kept.map(r => r.lfp);
          const t0 = new Date(c.kept[0].t + offMin() * 60000), t1 = new Date(c.kept[c.kept.length - 1].t + offMin() * 60000);
          const days = Math.round((t1 - t0) / dayMs);
          return [{ html: `<span class="hemi-${h[0]}">${hname(h)}</span>` }, c.kept.length,
          `${c.removed} (${f(100 * c.removed / d.trend[h].length, 1)}%)`,
          `${t0.toISOString().slice(0, 10)} → ${t1.toISOString().slice(0, 10)} (${days} d)`,
          C.median(v), `${f(C.quantile(v, .25))}–${f(C.quantile(v, .75))}`, c.mad];
        })));
      node.appendChild(exportRow([
        { label: '⤓ PNG', fn: () => P.downloadCanvas(box.canvas, 'F8_timeline_cronico') },
        {
          label: '⤓ CSV completo', fn: () => P.downloadText(P.toCSV(hemis.flatMap(h => d.trend[h].map(r => ({
            hemisferio: h, utc: new Date(r.t).toISOString(),
            local: new Date(r.t + offMin() * 60000).toISOString().slice(0, 19),
            hora_decimal: C.localHour(r.t, offMin()).toFixed(4), lfp: r.lfp, mA: r.ma,
            outlier: Math.abs(r.lfp - cleaned[h].median) > k * cleaned[h].mad ? 1 : 0
          })))), 'F8_timeline.csv', 'text/csv')
        }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Método.</b> Exclusão de outliers por mediana ± ${k}×MAD (robusto, preferível a média ± DP em distribuição assimétrica). ` +
          `Faixas sombreadas = 22h–06h locais. A linha grossa é mediana móvel de ${smooth} pontos (${smooth * 10} min). ` +
          `<b>Atenção:</b> artefatos de movimento podem gerar padrão pseudo-diurno — confirme em F9 comparando com uma banda-controle.`
      }));
    }
  },

  /* ------------------------------------------------------------------ F9 */
  {
    id: 'F9', title: 'Ritmo circadiano — heatmap, perfil polar e cosinor',
    sub: 'dia × hora com detrending diário; MESOR, amplitude, acrofase',
    has: d => Object.keys(d.trend).length,
    render(node, d) {
      const hemis = Object.keys(d.trend);
      const h = opt('F9', 'hemi', hemis[0]);
      const detr = opt('F9', 'detrend', true);
      const binMin = opt('F9', 'bin', 30);
      const harm = opt('F9', 'harm', '24+12');
      const nBoot = opt('F9', 'boot', 200);
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('hemisfério', hemis.map(x => ({ value: x, label: 'STN ' + hname(x) })), h, v => setOpt('F9', 'hemi', v)),
        ctrlCheck('detrending diário (% da mediana do dia)', detr, v => setOpt('F9', 'detrend', v)),
        ctrlSelect('bin', [{ value: 15, label: '15 min' }, { value: 30, label: '30 min' }, { value: 60, label: '60 min' }], binMin, v => setOpt('F9', 'bin', +v)),
        ctrlSelect('harmônicos', ['24', '24+12'], harm, v => setOpt('F9', 'harm', v)),
        ctrlNumber('bootstrap', nBoot, 50, 2000, 50, v => setOpt('F9', 'boot', v))
      ]));
      const clean = C.removeOutliersMAD(d.trend[h], 'lfp', 4).kept;
      const dp = C.diurnalProfile(clean, offMin(), binMin, detr);
      if (dp.days.length < 2) return node.appendChild(el('div', { class: 'empty', text: 'São necessários ao menos 2 dias de registro.' }));

      /* heatmap dia × hora */
      const box = plotBox(node, Math.max(180, 46 + dp.days.length * 4.4));
      const M = dp.matrix.map(m => m.values);
      const flat = M.flat().filter(isFinite).sort((a, b) => a - b);
      const ch = new P.Chart(box.canvas, {
        width: box.width, height: box.height, xlim: [0, 24], ylim: [0, dp.days.length],
        xlabel: 'hora local', ylabel: 'dia', title: `(a) dia × hora — STN ${hname(h)}${detr ? ' (normalizado pela mediana diária)' : ''}`,
        pad: { l: 76, r: 62, t: 24, b: 40 }
      });
      ch.heat(M, { cmap: detr ? 'divergent' : 'viridis', zmin: flat[Math.floor(flat.length * .02)], zmax: flat[Math.floor(flat.length * .98)], smooth: false });
      const step = Math.max(1, Math.ceil(dp.days.length / 12));
      ch.axes({
        grid: false, xticks: [0, 3, 6, 9, 12, 15, 18, 21, 24], xfmt: v => String(v).padStart(2, '0') + 'h',
        yticks: dp.days.map((_, i) => i + .5).filter((_, i) => i % step === 0),
        yfmt: v => (dp.days[Math.floor(v)] || '').slice(5).split('-').reverse().join('/')
      });
      ch.colorbar({ label: detr ? '% mediana do dia' : 'u.a.' });

      /* perfil + polar */
      const grid = el('div', { class: 'plotgrid two' }); node.appendChild(grid);
      const hrs = clean.map(r => C.localHour(r.t, offMin()));
      const yv = clean.map(r => r.lfp);
      const periods = harm === '24' ? [24] : [24, 12];
      const cos = C.cosinor(hrs, yv, periods);
      const vh = C.varianceByHour(clean, offMin());

      const b2 = plotBox(grid, 250);
      const valid = dp.profile.filter(isFinite);
      const ch2 = new P.Chart(b2.canvas, {
        width: b2.width, height: b2.height, xlim: [0, 24],
        ylim: [Math.min(...dp.q1.filter(isFinite)) * .96, Math.max(...dp.q3.filter(isFinite)) * 1.04],
        xlabel: 'hora local', ylabel: detr ? '% da mediana do dia' : 'potência LFP',
        title: '(b) perfil diurno (mediana entre dias, IQR)', pad: { l: 62, r: 14, t: 24, b: 42 }
      });
      ch2.axes({ xticks: [0, 4, 8, 12, 16, 20, 24], xfmt: v => String(v).padStart(2, '0') + 'h' });
      ch2.span(0, 6, { color: '#1B3A5C', alpha: .06 }); ch2.span(22, 24, { color: '#1B3A5C', alpha: .06 });
      ch2.area(dp.hours, dp.q1, dp.q3, { color: hcol(h), alpha: .2, label: 'IQR entre dias' });
      ch2.line(dp.hours, dp.profile, { color: hcol(h), width: 2, label: 'mediana' });
      if (cos && !detr) {
        const fh = Array.from({ length: 145 }, (_, i) => i / 6);
        ch2.line(fh, fh.map(cos.predict), { color: COL.warn, width: 1.6, dash: [5, 3], label: 'cosinor' });
      }
      ch2.legend({ x: ch2.x0 + 8, y: ch2.y1 + 6 });

      const b3 = plotBox(grid, 300);
      P.polarBars(b3.canvas, dp.profile, {
        width: b3.width, height: 292, rmin: Math.min(...valid) * .97, rmax: Math.max(...valid) * 1.02,
        color: (v) => { const t = (v - Math.min(...valid)) / (Math.max(...valid) - Math.min(...valid) || 1); return P.CMAPS.magma(.15 + t * .7); },
        acrophaseHours: cos ? ((cos.components[0].acrophaseHours % 24) + 24) % 24 : null,
        acroColor: COL.right, center: '', title: '(c) ciclo de 24 h', ink: COL.ink, muted: COL.muted, grid: COL.grid
      });

      /* estatística */
      if (cos) {
        const peaks = dp.matrix.map(m => { const v = m.values; let bi = -1, bv = -Infinity; v.forEach((x, i) => { if (isFinite(x) && x > bv) { bv = x; bi = i; } }); return bi >= 0 ? dp.hours[bi] : NaN; }).filter(isFinite);
        const ray = C.rayleigh(peaks);
        const boot = C.cosinorBootstrap(clean, [24], nBoot, offMin());
        const rows = [
          ['MESOR', f(cos.mesor, 2), boot ? `[${f(boot.mesorCI[0], 2)} – ${f(boot.mesorCI[1], 2)}]` : '—', 'média ajustada ao ritmo'],
          ['amplitude 24 h', f(cos.components[0].amplitude, 2), boot ? `[${f(boot.amplitudeCI[0], 2)} – ${f(boot.amplitudeCI[1], 2)}]` : '—', 'metade da variação no ciclo'],
          ['acrofase 24 h', `${f(((cos.components[0].acrophaseHours % 24) + 24) % 24, 2)} h`, boot ? `[${f(boot.acrophaseCI[0], 1)} – ${f(boot.acrophaseCI[1], 1)}] h` : '—', 'horário do pico'],
        ];
        if (periods.length > 1) rows.push(['amplitude 12 h', f(cos.components[1].amplitude, 2), '—', 'componente bimodal']);
        rows.push(
          ['R² do cosinor', f(cos.r2, 3), '—', 'variância explicada pelo modelo'],
          ['F / p', `${f(cos.F, 1)}`, { html: pHtml(cos.p) }, 'teste global do ritmo'],
          ['ρ AR(1) dos resíduos', f(cos.rhoAR1, 3), '—', 'autocorrelação serial'],
          ['n efetivo (corrigido)', f(cos.nEffective, 0), { html: pHtml(cos.pAdjustedAR1) }, 'p corrigido para autocorrelação'],
          ['η² hora do dia (ANOVA)', `${f(100 * vh.eta2, 1)} %`, { html: pHtml(vh.p) }, 'variância explicada pela hora'],
          ['Rayleigh (acrofases diárias)', `R=${f(ray.R, 3)}`, { html: pHtml(ray.p) }, `${dp.days.length} dias; hora média ${f(ray.meanHour, 2)} h`]
        );
        node.appendChild(table(['parâmetro', 'estimativa', 'IC 95% / p', 'interpretação'], rows));
        if (cos.rhoAR1 > 0.5) node.appendChild(el('div', {
          class: 'warnbox', html: `A autocorrelação dos resíduos é alta (ρ = ${f(cos.rhoAR1, 2)}), esperada em amostragem a cada 10 min. ` +
            `O p bruto do cosinor é anticonservador; use o <b>p corrigido para n efetivo</b> e, na análise definitiva, um modelo misto com estrutura AR(1) (ver script R fornecido).`
        }));
      }
      node.appendChild(exportRow([
        { label: '⤓ PNG heatmap', fn: () => P.downloadCanvas(box.canvas, 'F9a_heatmap_dia_hora') },
        { label: '⤓ PNG perfil', fn: () => P.downloadCanvas(b2.canvas, 'F9b_perfil_diurno') },
        { label: '⤓ PNG polar', fn: () => P.downloadCanvas(b3.canvas, 'F9c_polar') },
        { label: '⤓ CSV perfil', fn: () => P.downloadText(P.toCSV(dp.hours.map((x, i) => ({ hora: x, mediana: dp.profile[i], q1: dp.q1[i], q3: dp.q3[i] }))), 'F9_perfil.csv', 'text/csv') },
        { label: '⤓ CSV matriz', fn: () => P.downloadText(P.toCSV(dp.matrix.flatMap(m => m.values.map((v, i) => ({ dia: m.day, hora: dp.hours[i], valor: v })))), 'F9_matriz.csv', 'text/csv') }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Método.</b> Normalização de cada dia pela própria mediana antes do heatmap (obrigatória: deriva entre dias mascara o ritmo). ` +
          `Perfil = mediana por bin de ${binMin} min dentro de cada dia, depois mediana entre dias. Cosinor por mínimos quadrados com harmônicos de ${periods.join(' e ')} h; ` +
          `IC por bootstrap de blocos com reamostragem <b>de dias inteiros</b> (preserva a autocorrelação intradiária).`
      }));
    }
  },

  /* ----------------------------------------------------------------- F10 */
  {
    id: 'F10', title: 'Resposta alinhada a evento',
    sub: 'janela −60 / +180 min em torno de eventos marcados pelo paciente',
    has: d => d.snapshots.length && Object.keys(d.trend).length,
    render(node, d) {
      const names = Array.from(new Set(d.snapshots.map(s => s.name)));
      if (!names.length) return node.appendChild(el('div', { class: 'empty', text: 'Sem eventos marcados pelo paciente.' }));
      const hemis = Object.keys(d.trend);
      const evName = opt('F10', 'ev', names.find(n => /medica/i.test(n)) || names[0]);
      const h = opt('F10', 'hemi', hemis[0]);
      const pre = opt('F10', 'pre', 60), post = opt('F10', 'post', 180);
      const normalize = opt('F10', 'norm', true);
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('evento', names, evName, v => setOpt('F10', 'ev', v)),
        ctrlSelect('hemisfério', hemis.map(x => ({ value: x, label: 'STN ' + hname(x) })), h, v => setOpt('F10', 'hemi', v)),
        ctrlNumber('pré (min)', pre, 10, 180, 10, v => setOpt('F10', 'pre', v)),
        ctrlNumber('pós (min)', post, 30, 480, 30, v => setOpt('F10', 'post', v)),
        ctrlCheck('normalizar pela linha de base', normalize, v => setOpt('F10', 'norm', v))
      ]));
      const times = d.snapshots.filter(s => s.name === evName).map(s => s.t);
      const clean = C.removeOutliersMAD(d.trend[h], 'lfp', 4).kept;
      const al = C.eventAligned(clean, times, pre, post, 10, normalize);
      if (!al.nTrials) return node.appendChild(el('div', { class: 'empty', text: 'Nenhuma janela com cobertura suficiente de dados.' }));

      const box = plotBox(node, 280);
      const allv = al.trials.flatMap(t => t.values).filter(isFinite);
      const ch = new P.Chart(box.canvas, {
        width: box.width, height: box.height, xlim: [-pre, post],
        ylim: [C.quantile(allv, .01) * .95, C.quantile(allv, .99) * 1.05],
        xlabel: 'minutos em relação ao evento', ylabel: normalize ? '% da linha de base' : 'potência LFP',
        title: `"${evName}" — ${al.nTrials} ocorrências · STN ${hname(h)}`, pad: { l: 66, r: 14, t: 24, b: 42 }
      });
      ch.axes();
      ch.span(-pre, 0, { color: COL.muted, alpha: .07, label: 'linha de base' });
      al.trials.forEach(t => ch.line(al.offsets, t.values, { color: hcol(h), width: .7 }));
      ch.area(al.offsets, al.q1, al.q3, { color: hcol(h), alpha: .22, label: 'IQR' });
      ch.line(al.offsets, al.median, { color: COL.ink, width: 2.4, label: 'mediana' });
      ch.vline(0, { color: COL.right, width: 1.6, dash: null, label: evName });
      if (normalize) ch.hline(100, { color: COL.muted, dash: [2, 2] });
      ch.legend({ x: ch.x1 - 110, y: ch.y1 + 6 });

      const base = al.trials.flatMap(t => t.values.slice(0, Math.round(pre / 10)).filter(isFinite));
      const wins = [[0, 60], [60, 120], [120, post]];
      const rows = wins.map(([a, b]) => {
        const i0 = Math.round((a + pre) / 10), i1 = Math.round((b + pre) / 10);
        const v = al.trials.flatMap(t => t.values.slice(i0, i1).filter(isFinite));
        if (!v.length) return null;
        const pt = C.permutationTest(base, v, 3000);
        return [`${a}–${b} min`, v.length, C.median(v), f(C.median(v) - C.median(base), 1), { html: pHtml(pt.p) }];
      }).filter(Boolean);
      node.appendChild(table(['janela', 'n', 'mediana', 'Δ vs. base', 'p (permutação)'],
        [['−' + pre + '–0 min (base)', base.length, C.median(base), '—', { html: '—' }]].concat(rows)));
      node.appendChild(exportRow([
        { label: '⤓ PNG', fn: () => P.downloadCanvas(box.canvas, 'F10_alinhado_evento') },
        { label: '⤓ CSV', fn: () => P.downloadText(P.toCSV(al.trials.flatMap((t, i) => t.values.map((v, j) => ({ ensaio: i + 1, evento_utc: new Date(t.t).toISOString(), offset_min: al.offsets[j], valor: v })))), 'F10_alinhado.csv', 'text/csv') }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Método.</b> Janela de −${pre} a +${post} min, bins de 10 min (resolução nativa do Timeline). ` +
          `Cada ensaio normalizado pela mediana da própria linha de base, o que controla deriva entre dias. ` +
          `Comparações por permutação de rótulos (3.000 reamostragens) contra a linha de base agregada. ` +
          `Para inferência definitiva com múltiplos pacientes, use modelo misto com ensaio aninhado em paciente.`
      }));
    }
  },

  /* ----------------------------------------------------------------- F11 */
  {
    id: 'F11', title: 'Distribuição da potência e limiares de aDBS',
    sub: 'histograma, ECDF e proporção de tempo em cada faixa',
    has: d => Object.keys(d.trend).length,
    render(node, d) {
      const hemis = Object.keys(d.trend);
      const h = opt('F11', 'hemi', hemis[0]);
      const th = d.thresholds[h] || {};
      const lower = opt('F11', 'lo', isFinite(th.lower) ? th.lower : NaN);
      const upper = opt('F11', 'hi', isFinite(th.upper) ? th.upper : NaN);
      const clean = C.removeOutliersMAD(d.trend[h], 'lfp', 4).kept;
      const vals = clean.map(r => r.lfp);
      const auto = { lo: C.quantile(vals, .25), hi: C.quantile(vals, .75) };
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('hemisfério', hemis.map(x => ({ value: x, label: 'STN ' + hname(x) })), h, v => setOpt('F11', 'hemi', v)),
        ctrlNumber('limiar inferior', isFinite(lower) ? lower : Math.round(auto.lo), 0, 1e6, 1, v => setOpt('F11', 'lo', v)),
        ctrlNumber('limiar superior', isFinite(upper) ? upper : Math.round(auto.hi), 0, 1e6, 1, v => setOpt('F11', 'hi', v)),
        el('button', { class: 'btn', text: 'usar Q1/Q3 dos dados', onclick: () => { S.opts.F11.lo = auto.lo; S.opts.F11.hi = auto.hi; renderFigure('F11'); } })
      ]));
      const lo = isFinite(lower) ? lower : auto.lo, hi = isFinite(upper) ? upper : auto.hi;
      const hist = C.histogram(vals, 44), cdf = C.ecdf(vals);
      const sm = C.thresholdSummary(vals, lo, hi);
      const grid = el('div', { class: 'plotgrid two' }); node.appendChild(grid);

      const b1 = plotBox(grid, 250);
      const ch = new P.Chart(b1.canvas, {
        width: b1.width, height: b1.height, xlim: [hist.lo, hist.hi], ylim: [0, Math.max(...hist.counts) * 1.15],
        xlabel: 'potência LFP (u.a.)', ylabel: 'n de amostras de 10 min', title: '(a) distribuição', pad: { l: 62, r: 14, t: 24, b: 42 }
      });
      ch.axes();
      ch.bars(hist.centers, hist.counts, {
        width: (ch.X(hist.centers[1]) - ch.X(hist.centers[0])) * .92,
        color: (v, i) => hist.centers[i] < lo ? '#93A7B5' : hist.centers[i] > hi ? COL.warn : hcol(h)
      });
      ch.vline(lo, { color: COL.ink, width: 1.5, label: 'inf.' });
      ch.vline(hi, { color: COL.ink, width: 1.5, label: 'sup.', align: 'left' });

      const b2 = plotBox(grid, 250);
      const ch2 = new P.Chart(b2.canvas, {
        width: b2.width, height: b2.height, xlim: [hist.lo, hist.hi], ylim: [0, 1],
        xlabel: 'potência LFP (u.a.)', ylabel: 'proporção acumulada', title: '(b) ECDF e faixas de estimulação', pad: { l: 62, r: 14, t: 24, b: 42 }
      });
      ch2.axes({ yfmt: v => (v * 100).toFixed(0) + '%' });
      ch2.span(hist.lo, lo, { color: '#93A7B5', alpha: .13, label: 'mín.' });
      ch2.span(hi, hist.hi, { color: COL.warn, alpha: .13, label: 'máx.' });
      ch2.line(cdf.x, cdf.y, { color: COL.ink, width: 2 });
      ch2.vline(lo, { color: COL.ink }); ch2.vline(hi, { color: COL.ink });

      node.appendChild(table(['faixa', '% do tempo', 'implicação para aDBS'], [
        ['abaixo do limiar inferior', f(sm.belowPct, 1) + ' %', 'estimulação na amplitude mínima'],
        ['entre os limiares', f(sm.betweenPct, 1) + ' %', 'rampa proporcional entre mín. e máx.'],
        ['acima do limiar superior', f(sm.abovePct, 1) + ' %', 'estimulação na amplitude máxima'],
        ['mediana [IQR]', `${f(sm.median)} [${f(sm.q1)}–${f(sm.q3)}]`, 'centro da distribuição'],
        ['p10 / p90', `${f(sm.p10)} / ${f(sm.p90)}`, 'candidatos empíricos a limiar']
      ]));
      const es = d.eventSummary.flatMap(e => e.lfpAmp).filter(x => x.hemisphere === h);
      if (es.length) node.appendChild(table(['grupo', 'abaixo %', 'entre %', 'acima %', 'mA médio'],
        es.map(x => [x.group, x.below, x.between, x.above, x.avgMa])));
      const bad = sm.abovePct > 80 || sm.belowPct > 80;
      if (bad) node.appendChild(el('div', {
        class: 'warnbox', html: `Com os limiares atuais o sinal fica ${f(Math.max(sm.abovePct, sm.belowPct), 0)} % do tempo em uma única faixa — ` +
          `na prática equivale a estimulação contínua, sem modulação adaptativa. Considere recentrar os limiares em torno de Q1/Q3 da distribuição real.`
      }));
      node.appendChild(exportRow([
        { label: '⤓ PNG histograma', fn: () => P.downloadCanvas(b1.canvas, 'F11a_distribuicao') },
        { label: '⤓ PNG ECDF', fn: () => P.downloadCanvas(b2.canvas, 'F11b_ecdf') }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Uso clínico.</b> Esta é a figura de decisão para programar aDBS de duplo limiar. ` +
          `Limiares definidos em consulta única tendem a não representar a variação domiciliar; a recomendação atual é ≥ 5 dias de registro real, ` +
          `descartando dias artefatados, antes de fixar os limiares.`
      }));
    }
  },

  /* ----------------------------------------------------------------- F12 */
  {
    id: 'F12', title: 'Espectros por tipo de evento',
    sub: 'LfpFrequencySnapshotEvents — PSD disparada pelo paciente',
    has: d => d.snapshots.length,
    render(node, d) {
      const names = Array.from(new Set(d.snapshots.map(s => s.name)));
      const hemis = Array.from(new Set(d.snapshots.flatMap(s => Object.keys(s.hemi))));
      const h = opt('F12', 'hemi', hemis[0]);
      const showAll = opt('F12', 'all', false);
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('hemisfério', hemis.map(x => ({ value: x, label: 'STN ' + hname(x) })), h, v => setOpt('F12', 'hemi', v)),
        ctrlCheck('mostrar espectros individuais', showAll, v => setOpt('F12', 'all', v))
      ]));
      const palette = ['#1B4A72', '#9C3050', '#0C6E6B', '#A8621B', '#5B3E86', '#2C7A4B'];
      const groups = names.map((n, i) => {
        const items = d.snapshots.filter(s => s.name === n && s.hemi[h]);
        if (!items.length) return null;
        const f0 = items[0].hemi[h].f;
        const med = f0.map((_, k) => C.median(items.map(s => s.hemi[h].p[k])));
        return { name: n, color: palette[i % palette.length], f: f0, med, items };
      }).filter(Boolean);
      if (!groups.length) return node.appendChild(el('div', { class: 'empty', text: 'Sem snapshots para este hemisfério.' }));

      const box = plotBox(node, 300);
      const fmax = 45;
      const ymax = Math.max(...groups.flatMap(g => g.med.filter((_, k) => g.f[k] <= fmax))) * 1.2;
      const ch = new P.Chart(box.canvas, {
        width: box.width, height: box.height, xlim: [0, fmax], ylim: [0, ymax],
        xlabel: 'frequência (Hz)', ylabel: 'magnitude (µVp)', title: `espectro mediano por evento — STN ${hname(h)}`, pad: { l: 62, r: 14, t: 24, b: 42 }
      });
      ch.axes();
      profileBands().forEach(b => { if (b.lo < fmax) ch.span(b.lo, Math.min(b.hi, fmax), { color: b.color, alpha: .07, label: b.label }); });
      groups.forEach(g => {
        if (showAll) g.items.forEach(s => ch.line(g.f, s.hemi[h].p, { color: g.color, width: .6 }));
        ch.line(g.f, g.med, { color: g.color, width: 2.2, label: `${g.name} (n=${g.items.length})` });
      });
      ch.legend({ x: ch.x1 - 168, y: ch.y1 + 6 });

      const rows = groups.map(g => {
        const bt = C.bandTable(g.f, g.med);
        const lb = bt.find(b => b.key === 'lowbeta'), hb = bt.find(b => b.key === 'highbeta');
        let pf = NaN, pv = -Infinity;
        g.f.forEach((x, k) => { if (x >= 8 && x <= 35 && g.med[k] > pv) { pv = g.med[k]; pf = x; } });
        return [{ html: `<span style="color:${g.color};font-weight:600">${g.name}</span>` }, g.items.length,
          pf, pv, lb.relative, hb.relative];
      });
      node.appendChild(table(['evento', 'n', 'pico 8–35 Hz', 'magnitude', 'β↓ rel. %', 'β↑ rel. %'], rows));

      /* comparação entre dois eventos */
      if (groups.length >= 2) {
        const a = groups[0], b2 = groups[1];
        const inBeta = a.f.map((x, k) => k).filter(k => a.f[k] >= 13 && a.f[k] <= 30);
        const va = a.items.flatMap(s => inBeta.map(k => s.hemi[h].p[k]));
        const vb = b2.items.flatMap(s => inBeta.map(k => s.hemi[h].p[k]));
        const pt = C.permutationTest(va, vb, 3000);
        node.appendChild(el('div', {
          class: 'note', html: `<b>Comparação exploratória (β 13–30 Hz):</b> ${a.name} vs. ${b2.name} — ` +
            `Δ = ${f(pt.observed, 3)}, p = ${pTag(pt.p)} (permutação, 3.000). ` +
            `Trate como exploratório: os bins espectrais dentro de um mesmo snapshot não são independentes.`
        }));
      }
      node.appendChild(exportRow([
        { label: '⤓ PNG', fn: () => P.downloadCanvas(box.canvas, 'F12_espectros_evento') },
        { label: '⤓ CSV', fn: () => P.downloadText(P.toCSV(d.snapshots.flatMap(s => Object.keys(s.hemi).flatMap(hh => s.hemi[hh].f.map((x, k) => ({ utc: new Date(s.t).toISOString(), evento: s.name, hemisferio: hh, f_Hz: x, magnitude: s.hemi[hh].p[k] }))))), 'F12_snapshots.csv', 'text/csv') }
      ]));
    }
  },

  /* ----------------------------------------------------------------- F13 */
  {
    id: 'F13', title: 'Estados ON/OFF pela amplitude do beta',
    sub: 'classificação automática: baixo β = ON · alto β = OFF',
    has: d => d.bsTimeDomain.length || Object.keys(d.trend).length,
    render(node, d) {
      const src = [];
      d.bsTimeDomain.forEach((t, i) => src.push({ value: 'st' + i, label: `Streaming ${t.label} (${(t.data.length / t.fs).toFixed(0)} s)`, kind: 'stream', td: t }));
      Object.keys(d.trend).forEach(h => src.push({ value: 'tl' + h, label: `Timeline crônico — STN ${hname(h)}`, kind: 'timeline', hemi: h }));
      if (!src.length) return node.appendChild(el('div', { class: 'empty', text: 'Sem streaming nem Timeline.' }));
      const cur = src.find(s => s.value === opt('F13', 'src', src[0].value)) || src[0];
      const lo = opt('F13', 'lo', 13), hi = opt('F13', 'hi', 30);

      const ctrls = [
        ctrlSelect('fonte', src, cur.value, v => setOpt('F13', 'src', v)),
        ctrlNumber('β inf.', lo, 1, 45, 1, v => setOpt('F13', 'lo', v)),
        ctrlNumber('β sup.', hi, 5, 90, 1, v => setOpt('F13', 'hi', v))
      ];
      let series, isTime, minDur;
      if (cur.kind === 'stream') {
        const mds = opt('F13', 'mds', 2);
        ctrls.push(ctrlNumber('dur. mín (s)', mds, 0, 30, 1, v => setOpt('F13', 'mds', v)));
        qualitySeal(node, cur.td);
        series = C.betaEnvelopeSeries(cur.td, { lo, hi, winS: 1 }); isTime = false; minDur = mds;
      } else {
        const mdm = opt('F13', 'mdm', 30);
        ctrls.push(ctrlNumber('dur. mín (min)', mdm, 0, 240, 10, v => setOpt('F13', 'mdm', v)));
        const clean = C.removeOutliersMAD(d.trend[cur.hemi], 'lfp', 4).kept;
        series = clean.map(r => ({ t: r.t, v: r.lfp })); isTime = true; minDur = mdm * 60000;
      }
      node.appendChild(el('div', { class: 'ctrls' }, ctrls));

      const st = C.detectStates(series, { minDur });
      if (!st) return node.appendChild(el('div', { class: 'empty', text: 'Dados insuficientes para classificar estados.' }));

      const box = plotBox(node, 250);
      const xs = st.points.map(p => p.t), ys = st.points.map(p => p.v);
      const ch = new P.Chart(box.canvas, {
        width: box.width, height: box.height, xlim: [xs[0], xs[xs.length - 1]], ylim: [0, Math.max(...ys) * 1.16],
        xlabel: isTime ? 'data local' : 'tempo (s)', ylabel: cur.kind === 'stream' ? 'amplitude β (µV)' : 'potência β (u.a.)',
        title: `estados por amplitude de beta (${lo}–${hi} Hz)`, pad: { l: 60, r: 14, t: 24, b: 42 }
      });
      ch.axes(isTime ? { nx: 7, xfmt: v => new Date(v + offMin() * 60000).toISOString().slice(5, 10).split('-').reverse().join('/') } : {});
      st.episodes.forEach(e => { if (e.state === 'OFF') ch.span(e.startT, e.endT, { color: COL.right, alpha: .15 }); });
      ch.line(xs, ys, { color: COL.ink, width: 1.2 });
      ch.hline(st.threshold, { color: COL.warn, dash: [4, 3], label: `limiar β = ${f(st.threshold, 2)}` });

      node.appendChild(table(['métrica', 'valor', 'o que significa'], [
        ['limiar de beta (ON | OFF)', f(st.threshold, 2), 'acima → OFF (alto beta); abaixo → ON'],
        ['β médio ON / OFF', `${f(st.betaLow, 2)} / ${f(st.betaHigh, 2)}`, 'nível típico de beta em cada estado'],
        ['% do tempo em OFF', f(100 * st.offFraction, 1) + ' %', 'quanto do registro ficou em alto beta'],
        ['episódios OFF / ON', `${st.nOff} / ${st.nOn}`, 'número de blocos de cada estado'],
        ['duração média OFF / ON', cur.kind === 'stream' ? `${f(st.meanOffDur, 1)} / ${f(st.meanOnDur, 1)} s` : `${f(st.meanOffDur / 60000, 0)} / ${f(st.meanOnDur / 60000, 0)} min`, 'persistência de cada estado'],
        ['contraste entre estados (d)', f(st.separation, 2), 'distância padronizada entre os níveis'],
        ['bimodalidade (Sarle)', f(st.bimodality, 3), '> 0,555 sugere dois estados reais']
      ]));
      if (!(st.bimodality > 0.555)) node.appendChild(el('div', {
        class: 'warnbox', html: `A distribuição do beta é praticamente <b>unimodal</b> (bimodalidade ${f(st.bimodality, 3)} ≤ 0,555): ` +
          `o beta varia de forma contínua, sem dois patamares nítidos. A divisão ON/OFF aqui é apenas descritiva — interprete com cautela.`
      }));
      node.appendChild(exportRow([
        { label: '⤓ PNG', fn: () => P.downloadCanvas(box.canvas, 'F13_estados_onoff') },
        {
          label: '⤓ CSV episódios', fn: () => P.downloadText(P.toCSV(st.episodes.map(e => ({
            estado: e.state,
            inicio: isTime ? new Date(e.startT + offMin() * 60000).toISOString().slice(0, 19) : +e.startT.toFixed(2),
            fim: isTime ? new Date(e.endT + offMin() * 60000).toISOString().slice(0, 19) : +e.endT.toFixed(2),
            duracao: isTime ? +(e.dur / 60000).toFixed(1) : +e.dur.toFixed(2),
            unidade: isTime ? 'min' : 's', beta_medio: +e.meanV.toFixed(3)
          }))), 'F13_estados_onoff.csv', 'text/csv')
        }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Como funciona.</b> A amplitude do beta (${lo}–${hi} Hz) é separada automaticamente em dois níveis por agrupamento (k-médias): ` +
          `<b>baixo beta = ON</b> (medicação/estimulação fazendo efeito) e <b>alto beta = OFF</b> (efeito reduzido), com um limiar entre eles e ` +
          `duração mínima para evitar troca-troca. <b>Cuidado:</b> o beta é um <i>correlato</i> do estado clínico, não a verdade — ` +
          `artefato de movimento infla o beta (falso OFF) e a própria estimulação o reduz; a bimodalidade indica se realmente há dois estados. ` +
          `Em streaming curto de consultório, o registro costuma ficar num único estado — o método rende mais no Timeline crônico, ao longo dos ciclos da levodopa.`
      }));
    }
  },

  /* ----------------------------------------------------------------- F15 */
  {
    id: 'F15', title: 'Limpeza de artefato cardíaco — três métodos e validação',
    sub: 'detecção de picos R em duas passagens · interpolação, template e SVD',
    has: d => d.bsTimeDomain.length || d.montageTD.length,
    render(node, d) {
      const src = [].concat(
        d.bsTimeDomain.map((t, i) => ({ value: 'bs' + i, label: `Streaming ${t.label} (${(t.data.length / t.fs).toFixed(0)} s)`, td: t })),
        d.montageTD.map((t, i) => ({ value: 'mt' + i, label: `Survey ${t.hemisphere[0]}·${t.label} (${(t.data.length / t.fs).toFixed(0)} s)`, td: t })));
      if (!src.length) return node.appendChild(el('div', { class: 'empty', text: 'Nenhum sinal bruto disponível.' }));
      const cur = src.find(s => s.value === opt('F15', 'src', src[0].value)) || src[0];
      const td = cur.td, fs = td.fsEff || td.fs;
      const metodo = opt('F15', 'metodo', 'svd');
      const kSvd = opt('F15', 'k', 2);
      const janela = opt('F15', 'win', 0.06);
      const comparar = opt('F15', 'cmp', false);

      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('sinal', src, cur.value, v => setOpt('F15', 'src', v)),
        ctrlSelect('método', [
          { value: 'interpolation', label: 'interpolação de QRS' },
          { value: 'template', label: 'subtração de template' },
          { value: 'svd', label: 'SVD (recomendado)' }
        ], metodo, v => setOpt('F15', 'metodo', v)),
        ctrlNumber('componentes SVD (k)', kSvd, 1, 5, 1, v => setOpt('F15', 'k', v)),
        ctrlNumber('janela (s)', janela, 0.02, 0.3, 0.01, v => setOpt('F15', 'win', v)),
        ctrlCheck('comparar os três métodos', comparar, v => setOpt('F15', 'cmp', v))
      ]));
      qualitySeal(node, td);

      const det = C.detectRPeaks(td.data, fs, {});
      if (!det.peaks.length) {
        node.appendChild(el('div', {
          class: 'warnbox', html: `<b>Nenhum pico R detectado.</b> ${det.reason || ''} ` +
            `Sem detecção confiável, não há o que remover — e forçar a limpeza pioraria o sinal.`
        }));
        return;
      }
      const rem = C.removeEcg(td.data, fs, det.peaks, { method: metodo, svdComponents: kSvd, window: janela });
      const val = C.validateEcgRemoval(td.data, rem.cleaned, fs, {});

      /* barra de métricas de validação — saída obrigatória */
      const confCls = det.confidence === 'alta' ? 'sig' : det.confidence === 'baixa' ? 'warn' : '';
      node.appendChild(table(['métrica de validação', 'valor', 'leitura'], [
        ['razão de supressão de ECG', `${f(val.suppressionRatioDb, 2)} dB`, 'potência removida em 0,5–40 Hz; > 0 indica supressão'],
        ['recuperação do pico beta', f(val.betaPeakRecovery, 3), 'próximo de 1 = preservado sem amplificação espúria'],
        ['veredito', { html: `<b>${val.verdict}</b>` }, 'leitura conjunta das duas métricas acima'],
        ['picos R detectados', `${det.nDetected} (${f(det.bpm, 0)} bpm)`, `SDNN ${f(det.hrvSdnn, 0)} ms · polaridade ${det.polarity > 0 ? 'positiva' : 'negativa'}`],
        ['confiança da detecção', { html: `<span class="${confCls}">${det.confidence}</span>` }, det.reason || 'casamento de template consistente']
      ]));
      if (det.confidence === 'baixa') node.appendChild(el('div', {
        class: 'warnbox', html: `<b>Confiança baixa na detecção dos picos R.</b> ${det.reason || ''}`
      }));

      const grid = el('div', { class: 'plotgrid two' }); node.appendChild(grid);
      const nVis = Math.min(td.data.length, Math.round(6 * fs));
      const tv = Array.from({ length: nVis }, (_, i) => i / fs);
      const bruto = Array.from(td.data.slice(0, nVis));
      const limpo = Array.from(rem.cleaned.slice(0, nVis));
      const amp = Math.max(...bruto.filter(isFinite).map(Math.abs)) * 1.15 || 1;

      /* (a) bruto com picos R e template */
      const b1 = plotBox(grid, 210);
      const c1 = new P.Chart(b1.canvas, {
        width: b1.width, height: b1.height, xlim: [0, nVis / fs], ylim: [-amp, amp],
        xlabel: 'tempo (s)', ylabel: 'µV', title: '(a) bruto · picos R detectados', pad: { l: 58, r: 14, t: 24, b: 38 }
      });
      c1.axes();
      c1.line(tv, bruto, { color: COL.ink, width: 1 });
      det.peaks.filter(p => p < nVis).forEach(p => c1.vline(p / fs, { color: COL.right, dash: [2, 2] }));

      /* (b) limpo sobreposto ao bruto */
      const b2 = plotBox(grid, 210);
      const c2 = new P.Chart(b2.canvas, {
        width: b2.width, height: b2.height, xlim: [0, nVis / fs], ylim: [-amp, amp],
        xlabel: 'tempo (s)', ylabel: 'µV', title: '(b) limpo sobre o bruto (mesma escala)', pad: { l: 58, r: 14, t: 24, b: 38 }
      });
      c2.axes();
      c2.line(tv, bruto, { color: '#C9D3DC', width: 1, label: 'bruto' });
      c2.line(tv, limpo, { color: COL.accent, width: 1.2, label: 'limpo' });
      c2.legend({ x: c2.x0 + 8, y: c2.y1 + 6 });

      /* (c) PSD bruta vs limpa em log-log */
      const pB = C.welchPSD(td.data, fs, { nperseg: 512, overlap: .5 });
      const pL = C.welchPSD(rem.cleaned, fs, { nperseg: 512, overlap: .5 });
      if (pB.p && pL.p) {
        const idx = Array.from(pB.f).map((v, i) => i).filter(i => pB.f[i] >= 1 && pB.f[i] <= 90 && pB.p[i] > 0 && pL.p[i] > 0);
        const b3 = plotBox(grid, 230);
        const ys = idx.map(i => pB.p[i]).concat(idx.map(i => pL.p[i]));
        const c3 = new P.Chart(b3.canvas, {
          width: b3.width, height: b3.height, xlog: true, ylog: true,
          xlim: [1, 90], ylim: [Math.max(1e-6, Math.min(...ys) * .7), Math.max(...ys) * 1.4],
          xlabel: 'frequência (Hz)', ylabel: 'potência (log)', title: '(c) espectro antes e depois', pad: { l: 62, r: 14, t: 24, b: 40 }
        });
        c3.axes({ xfmt: v => String(v) });
        c3.span(13, 35, { color: '#B8912A', alpha: .12, label: 'β' });
        c3.line(idx.map(i => pB.f[i]), idx.map(i => pB.p[i]), { color: '#9FB3C0', width: 1.4, label: 'bruto' });
        c3.line(idx.map(i => pL.f[i]), idx.map(i => pL.p[i]), { color: COL.ink, width: 1.6, label: 'limpo' });
        c3.legend({ x: c3.x0 + 8, y: c3.y1 + 6 });
      }

      /* (d) épocas empilhadas antes e depois */
      const half = Math.max(2, Math.round(janela * fs));
      const epocas = (sinal) => det.peaks
        .filter(p => p - half >= 0 && p + half < sinal.length)
        .slice(0, 120)
        .map(p => Array.from(sinal.slice(p - half, p + half + 1)).map(v => isFinite(v) ? v : 0));
      const eA = epocas(td.data), eD = epocas(rem.cleaned);
      if (eA.length > 3) {
        const todos = eA.flat();
        const zmin = C.quantile(todos, .02), zmax = C.quantile(todos, .98);
        [[eA, '(d) épocas do QRS — antes'], [eD, '(d) épocas do QRS — depois']].forEach(([M, titulo]) => {
          const bx = plotBox(grid, 210);
          const ch = new P.Chart(bx.canvas, {
            width: bx.width, height: bx.height, xlim: [-janela * 1000, janela * 1000], ylim: [0, M.length],
            xlabel: 'tempo em relação ao pico R (ms)', ylabel: 'época', title: titulo, pad: { l: 58, r: 58, t: 24, b: 40 }
          });
          ch.heat(M, { cmap: 'divergent', zmin, zmax, smooth: false });
          ch.axes({ grid: false });
          ch.colorbar({ label: 'µV' });
        });
      }

      /* (e) espectro de valores singulares, para escolher k com evidência */
      if (metodo === 'svd' && rem.singularValues) {
        const sv = rem.singularValues.slice(0, 12);
        const b5 = plotBox(grid, 210);
        const c5 = new P.Chart(b5.canvas, {
          width: b5.width, height: b5.height, xlim: [-.6, sv.length - .4], ylim: [0, Math.max(...sv) * 1.15],
          xlabel: 'componente', ylabel: 'valor singular', title: `(e) espectro de valores singulares — k = ${kSvd}`,
          pad: { l: 62, r: 14, t: 24, b: 40 }
        });
        c5.axes({ xticks: sv.map((_, i) => i), xfmt: v => String(v + 1) });
        c5.bars(sv.map((_, i) => i), sv, {
          width: (c5.X(1) - c5.X(0)) * .6,
          color: (v, i) => i < kSvd ? COL.accent : '#B9C6D0'
        });
        node.appendChild(el('div', {
          class: 'note', html: `Os <b>${kSvd}</b> primeiros componentes explicam <b>${f(rem.varianceExplained, 1)}%</b> da variância das épocas. ` +
            `Vivien et al. recomendam mais de um componente quando a contaminação é alta — escolha k pela queda do espectro acima, não por default.`
        }));
      }

      /* comparação dos três métodos em um clique */
      if (comparar) {
        const linhas = ['interpolation', 'template', 'svd'].map(m => {
          const r = C.removeEcg(td.data, fs, det.peaks, { method: m, svdComponents: kSvd, window: janela });
          const v = C.validateEcgRemoval(td.data, r.cleaned, fs, {});
          return [m === 'interpolation' ? 'interpolação' : m === 'template' ? 'template' : 'SVD',
            f(v.suppressionRatioDb, 2) + ' dB', f(v.betaPeakRecovery, 3), v.verdict];
        });
        node.appendChild(el('h4', { class: 'note', html: '<b>Comparação direta dos três métodos</b> (mesmos picos R)' }));
        node.appendChild(table(['método', 'supressão', 'recuperação do pico β', 'veredito'], linhas));
      }

      node.appendChild(exportRow([
        { label: '⤓ PNG bruto', fn: () => P.downloadCanvas(b1.canvas, 'F15a_bruto_picosR') },
        { label: '⤓ PNG limpo', fn: () => P.downloadCanvas(b2.canvas, 'F15b_limpo') },
        { label: '⤓ CSV sinal limpo', fn: () => P.downloadText(P.toCSV(Array.from(rem.cleaned).map((v, i) => ({ t_s: +(i / fs).toFixed(4), uV: v }))), 'F15_sinal_limpo.csv', 'text/csv') },
        { label: '⤓ CSV picos R', fn: () => P.downloadText(P.toCSV(det.peaks.map((p, i) => ({ indice: p, t_s: +(p / fs).toFixed(4), rr_ms: i ? +det.rrIntervals[i - 1].toFixed(1) : '' }))), 'F15_picos_R.csv', 'text/csv') }
      ]));

      node.appendChild(el('div', {
        class: 'note', html: `<b>Método.</b> Detecção de picos R em <b>duas passagens por correlação de template</b> ` +
          `(percentis decrescentes para semear, template médio, correlação, refino e segunda passagem), como em Stam et al. (2023) e Vivien et al. (2026). ` +
          `Três métodos de remoção comparáveis: <b>interpolação</b> do trecho (perceive), <b>subtração de template</b> ajustado em amplitude por mínimos quadrados a cada batimento (Hammer et al.), ` +
          `e <b>SVD</b> das épocas com reconstrução por k componentes (recomendado). ` +
          `As métricas de validação são <b>saída obrigatória</b>: sem elas não é possível saber se a limpeza removeu o artefato ou o sinal.`
      }));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Prevenção vale mais que correção.</b> Stam et al. recomendam explicitamente prevenir a contaminação em vez de corrigi-la: ` +
          `o artefato reduz a relação sinal-ruído e, portanto, a confiabilidade do LFP para físio-marcadores e para aDBS. ` +
          `Medidas: <b>posicionamento do gerador</b> (Neumann et al., Brain Stimul 2021 — a contaminação por ECG é sensível ao sítio cirúrgico de implante), ` +
          `verificação de impedância de leads e extensões, e <b>registro de ECG externo simultâneo</b> na próxima sessão, que resolve os casos em que o pico R é pequeno demais no LFP.`
      }));
    }
  }
];

function movingMedian(arr, w) {
  const out = new Array(arr.length).fill(NaN);
  const half = Math.floor(w / 2);
  for (let i = 0; i < arr.length; i++) {
    const a = Math.max(0, i - half), b = Math.min(arr.length, i + half + 1);
    out[i] = C.median(arr.slice(a, b));
  }
  return out;
}

/* ============================================================== UI ======= */
function renderRail() {
  const rail = $('#rail'); rail.innerHTML = '';
  /* arquivos */
  const cf = el('div', { class: 'card' }, [el('h3', {}, ['Arquivos', el('span', { class: 'n', text: `(${S.files.length})` })])]);
  const body = el('div', { class: 'body' });
  const drop = el('div', {
    class: 'drop', tabindex: '0', role: 'button',
    onclick: () => $('#fileInput').click(),
    onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); } }
  }, [el('b', { text: 'Soltar arquivos JSON aqui' }), el('span', { text: 'ou clicar para escolher · vários de uma vez' })]);
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
  body.appendChild(drop);
  if (S.files.length) {
    const ul = el('ul', { class: 'filelist' });
    S.files.forEach((fl, i) => {
      const p = fl.parsed;
      const n = Object.values(p.availability).filter(v => v > 0).length;
      ul.appendChild(el('li', {}, [
        el('div', { class: 'meta' }, [
          el('b', { text: fl.name.replace(/^Report_Json_Session_Report_/, '').replace(/\.json$/, '') }),
          el('span', { text: `${p.patient.idHash} · ${n} modalidades` })
        ]),
        el('button', { class: 'x', title: 'remover', text: '×', onclick: () => { S.files.splice(i, 1); renderAll(); } })
      ]));
    });
    body.appendChild(ul);
  }
  cf.appendChild(body); rail.appendChild(cf);

  /* seletor de registro — trava contra mistura de pacientes */
  const subs = subjects(); const act = activeSubject();
  if (subs.length > 1) {
    const cr = el('div', { class: 'card' }, [el('h3', {}, ['Registro em análise', el('span', { class: 'n', text: `(${subs.length} distintos)` })])]);
    const br = el('div', { class: 'body' });
    br.appendChild(ctrlSelect('', subs.map(s => ({
      value: s.key, label: `${s.idHash} — ${s.files.length} arq. · implante ${String(s.implant || '').slice(0, 10) || '—'}`
    })), act.key, v => { S.subject = v; S.opts = {}; renderAll(); }));
    br.appendChild(el('div', {
      class: 'warnbox', html: 'Os arquivos carregados pertencem a <b>pessoas diferentes</b>. ' +
        'Apenas o registro selecionado é analisado — séries de registros distintos nunca são agregadas.'
    }));
    cr.appendChild(br); rail.appendChild(cr);
  }

  /* matriz de disponibilidade */
  if (S.files.length) {
    const cm = el('div', { class: 'card' }, [el('h3', {}, ['Matriz de dados'])]);
    const b = el('div', { class: 'body' });
    const t = el('table', { class: 'matrix' });
    const shown = activeFiles();
    const head = el('tr', {}, [el('th', { text: 'modalidade' })].concat(
      shown.map((fl, i) => el('th', { text: 'A' + (i + 1), title: fl.name }))));
    t.appendChild(el('thead', {}, [head]));
    const tb = el('tbody');
    C.MODALITIES.forEach(([k, label]) => {
      const tr = el('tr', {}, [el('td', { class: 'lbl', text: label, title: label })]);
      shown.forEach(fl => {
        const n = fl.parsed.availability[k] || 0;
        tr.appendChild(el('td', {}, [el('span', { class: 'cell' + (n ? ' on' : ''), text: n ? String(n) : '·' })]));
      });
      tb.appendChild(tr);
    });
    t.appendChild(tb); b.appendChild(t);
    b.appendChild(el('div', { class: 'legendrow' }, [
      el('span', { html: '<i style="background:var(--accent)"></i>presente (n)' }),
      el('span', { html: '<i style="background:var(--panel-2);border:1px solid var(--rule-2)"></i>ausente' })
    ]));
    cm.appendChild(b); rail.appendChild(cm);

    /* resumo do caso */
    const p0 = (activeFiles()[0] || S.files[0]).parsed;
    const cs = el('div', { class: 'card' }, [el('h3', {}, ['Registro'])]);
    const bs = el('div', { class: 'body' });
    const kv = el('dl', { class: 'kv' });
    const add = (k, v) => { kv.appendChild(el('dt', { text: k })); kv.appendChild(el('dd', { text: v })); };
    add('identificador', p0.patient.idHash);
    add('diagnóstico', p0.patient.diagnosis || '—');
    add('dispositivo', `${p0.device.model || '—'} · fw ${p0.device.firmware || '—'}`);
    add('implante', String(p0.device.implantDate || '').slice(0, 10) || '—');
    add('alvos', p0.leads.map(l => `${l.hemisphere[0]}:${l.target}`).join(' ') || '—');
    add('bateria', isFinite(p0.device.batteryPct) ? p0.device.batteryPct + ' %' : '—');
    add('perfil de doença', s.profile_label || activeProfile().label);
  add('fuso aplicado', `UTC${offMin() >= 0 ? '+' : '−'}${String(Math.floor(Math.abs(offMin()) / 60)).padStart(2, '0')}:${String(Math.abs(offMin()) % 60).padStart(2, '0')}`);
    bs.appendChild(kv); cs.appendChild(bs); rail.appendChild(cs);

    /* perfil de doença (Onda 5) */
    const sugerido = C.suggestProfile(p0);
    const perfil = activeProfile();
    const cp = el('div', { class: 'card' }, [el('h3', {}, ['Perfil de doença'])]);
    const bp2 = el('div', { class: 'body' });
    bp2.appendChild(ctrlSelect('', C.PROFILE_IDS.map(id => ({ value: id, label: C.PROFILES[id].label })),
      perfil.id, v => { S.profile = v; S.opts = {}; renderAll(); }));
    bp2.appendChild(el('div', {
      class: 'note', style: 'margin-top:8px',
      html: `<b>Banda primária:</b> ${perfil.primaryBand.label} (${perfil.primaryBand.lo}–${perfil.primaryBand.hi} Hz) · ` +
        `<b>normalização:</b> ${perfil.normalization} · <b>banda crônica:</b> ${perfil.chronicBandSelection}<br>` +
        `<span style="color:var(--ink-3)">${perfil.glossary.intuicao}</span>`
    }));
    if (perfil.id === sugerido) bp2.appendChild(el('div', {
      class: 'note', style: 'margin-top:6px;color:var(--ok)',
      html: `Sugerido automaticamente por <b>${p0.patient.diagnosis || '—'}</b> / <b>${(p0.leads[0] || {}).target || '—'}</b>.`
    }));
    else bp2.appendChild(el('div', {
      class: 'note', style: 'margin-top:6px',
      html: `Escolhido manualmente. O JSON sugeria <b>${C.PROFILES[sugerido].label}</b>.`
    }));
    profileWarnings(bp2);
    cp.appendChild(bp2); rail.appendChild(cp);

    /* exportação */
    const ce = el('div', { class: 'card' }, [el('h3', {}, ['Exportar'])]);
    const be = el('div', { class: 'body' });
    const grid = el('div', { class: 'exportgrid' });
    [
      ['⤓ Relatório PDF', 'todas as figuras + resumo de métricas', generateReport, 'primary'],
      ['⤓ JSON para estatística', 'variáveis-chave por sessão · paciente · implante', exportJSON],
      ['⤓ CSV — métricas agudas', 'pico β, aperiódico, bursts (sessão × hemisfério)', exportAcuteCSV],
      ['⤓ CSV — métricas crônicas', 'circadiano e limiares de aDBS (Timeline)', exportChronicCSV],
      ['⤓ CSV — Timeline bruto', 'amostras de 10 min, formato longo para R', exportSession],
      ['⤓ Todas as figuras (PNG)', 'baixa cada gráfico individualmente', downloadAllFigures],
      ['⤓ Checklist PERCEPT-REPORT (.md)', 'itens mínimos de reporte, preenchidos automaticamente', () => exportChecklist('md')],
      ['⤓ Checklist PERCEPT-REPORT (.docx)', 'mesmo conteúdo, pronto para material suplementar', () => exportChecklist('docx')],
      ['⤓ Manifesto de proveniência', 'todos os parâmetros efetivos + hash citável da análise', exportManifest]
    ].forEach(([label, desc, fn, cls]) => {
      grid.appendChild(el('div', { class: 'exportitem' }, [
        el('button', { class: 'btn' + (cls ? ' ' + cls : ''), text: label, onclick: fn }),
        el('span', { class: 'exphint', text: desc })
      ]));
    });
    be.appendChild(grid);
    ce.appendChild(be); rail.appendChild(ce);
  }
}

function renderFigures() {
  const main = $('#figs'); main.innerHTML = '';
  if (!S.files.length) {
    main.appendChild(el('div', { class: 'card' }, [el('div', {
      class: 'body', html:
        `<p style="margin:0 0 12px;font:13px/1.7 var(--sans)">Carregue um ou mais <b>Session Reports</b> exportados do programador Percept (arquivos <code>Report_Json_Session_Report_*.json</code>).</p>
       <p style="margin:0 0 12px;font:13px/1.7 var(--sans);color:var(--ink-2)">Cada arquivo contém modalidades diferentes conforme o que foi executado na consulta. Carregue vários da mesma pessoa ao mesmo tempo — as séries do Timeline são concatenadas e desduplicadas automaticamente, e cada figura usa a fonte adequada.</p>
       <p style="margin:0;font:11.5px/1.6 var(--mono);color:var(--ink-3)">Os dados nunca saem deste dispositivo: todo o processamento acontece no próprio navegador.</p>`
    })]));
    return;
  }
  const d = ds();
  FIGURES.forEach(fig => {
    const ok = !!fig.has(d);
    const det = el('details', { class: 'fig ' + (ok ? 'ready' : 'na'), id: 'fig-' + fig.id });
    if (ok && ['F1', 'F8', 'F9'].includes(fig.id)) det.open = true;
    det.appendChild(el('summary', {}, [el('header', {}, [
      el('span', { class: 'chev', text: '▸' }),
      el('span', { class: 'id', text: fig.id }),
      el('span', { class: 'ttl' }, [el('b', { text: fig.title }), el('span', { text: fig.sub })]),
      el('span', { class: 'state', text: ok ? 'dados presentes' : 'sem dados' })
    ])]));
    det.appendChild(el('div', { class: 'content', id: 'content-' + fig.id }));
    det.addEventListener('toggle', () => { if (det.open) renderFigure(fig.id); });
    main.appendChild(det);
    if (det.open) renderFigure(fig.id);
  });
}

function renderFigure(id) {
  const fig = FIGURES.find(x => x.id === id);
  const node = document.getElementById('content-' + id);
  if (!fig || !node) return;
  node.innerHTML = '';
  const d = ds();
  if (!fig.has(d)) {
    node.appendChild(el('div', {
      class: 'empty', html: `Esta figura precisa de dados que não estão nos arquivos carregados.<br>` +
        `Consulte a matriz de dados à esquerda e o checklist de captura no rodapé.`
    }));
    return;
  }
  try { fig.render(node, d); }
  catch (e) {
    node.appendChild(el('div', { class: 'warnbox', html: `<b>Falha ao gerar a figura.</b> ${String(e && e.message || e)}` }));
    console.error(id, e);
  }
}

function renderAll() { renderRail(); renderFigures(); }

/* ---------------------------------------------------------- carregamento */
function handleFiles(fileList) {
  const files = Array.from(fileList).filter(f => /\.json$/i.test(f.name));
  if (!files.length) return;
  let pending = files.length;
  files.forEach(file => {
    const r = new FileReader();
    r.onload = () => {
      try {
        const json = JSON.parse(r.result);
        const parsed = C.parsePercept(json, file.name);
        const dup = S.files.findIndex(x => x.name === file.name);
        if (dup >= 0) S.files.splice(dup, 1);
        S.files.push({ name: file.name, parsed });
      } catch (e) {
        alert(`Não foi possível ler "${file.name}". O arquivo precisa ser um Session Report JSON válido do Percept.\n\n${e.message}`);
      }
      if (--pending === 0) { S.files.sort((a, b) => a.name.localeCompare(b.name)); renderAll(); }
    };
    r.onerror = () => { if (--pending === 0) renderAll(); };
    r.readAsText(file);
  });
}

function exportSession() {
  const d = ds();
  const rows = [];
  Object.keys(d.trend).forEach(h => d.trend[h].forEach(r => rows.push({
    hemisferio: h, utc: new Date(r.t).toISOString(),
    local: new Date(r.t + offMin() * 60000).toISOString().slice(0, 19),
    hora_local_decimal: +C.localHour(r.t, offMin()).toFixed(4),
    dia_local: C.localDayKey(r.t, offMin()), lfp: r.lfp, mA: r.ma
  })));
  if (!rows.length) return alert('Não há dados de Timeline nos arquivos carregados para exportar.');
  P.downloadText(P.toCSV(rows), 'percept_timeline_para_R.csv', 'text/csv');
}

/* ---------------------------------------------- exportação de métricas -- */
function exportBundle() {
  const ps = activeFiles().map(x => x.parsed);
  return ps.length ? C.extractMetrics(ps, offMin(), { profileId: activeProfileId() }) : null;
}
function unionKeys(rows) {
  const seen = new Set(), out = [];
  rows.forEach(r => Object.keys(r).forEach(k => { if (!seen.has(k)) { seen.add(k); out.push(k); } }));
  return out;
}
function exportJSON() {
  const b = exportBundle();
  if (!b) return alert('Carregue ao menos um arquivo antes de exportar.');
  const doc = {
    export: {
      tool: 'Percept LFP Studio', generated_at: new Date().toISOString(),
      timezone_offset_min: offMin(),
      note: 'Identificadores pseudonimizados no dispositivo. Métricas nomeadas por sessão × hemisfério (agudas) e sujeito × hemisfério (crônicas), com a data de implante e os dias desde o implante em cada linha.'
    },
    subject: b.subject, sessions: b.sessions, acute: b.acute, chronic: b.chronic
  };
  P.downloadText(JSON.stringify(doc, null, 2), `percept_${b.subject.id}_metricas.json`, 'application/json');
}
function exportAcuteCSV() {
  const b = exportBundle();
  if (!b) return alert('Carregue ao menos um arquivo antes de exportar.');
  if (!b.acute.length) return alert('Nenhuma métrica aguda (espectro ou sinal bruto) nos arquivos carregados.');
  P.downloadText(P.toCSV(b.acute, unionKeys(b.acute)), `percept_${b.subject.id}_metricas_agudas.csv`, 'text/csv');
}
function exportChronicCSV() {
  const b = exportBundle();
  if (!b) return alert('Carregue ao menos um arquivo antes de exportar.');
  if (!b.chronic.length) return alert('Nenhum dado de Timeline (crônico) nos arquivos carregados.');
  P.downloadText(P.toCSV(b.chronic, unionKeys(b.chronic)), `percept_${b.subject.id}_metricas_cronicas.csv`, 'text/csv');
}

/* Abre e renderiza todas as figuras com dados (usado por relatório e PNG). */
function renderAllReady() {
  const d = ds();
  FIGURES.forEach(fig => {
    if (!fig.has(d)) return;
    const det = document.getElementById('fig-' + fig.id);
    if (det) { det.open = true; renderFigure(fig.id); }
  });
}
function downloadAllFigures() {
  if (!S.files.length) return alert('Carregue ao menos um arquivo antes de exportar.');
  renderAllReady();
  setTimeout(() => {
    const d = ds(), jobs = [];
    FIGURES.forEach(fig => {
      if (!fig.has(d)) return;
      const node = document.getElementById('content-' + fig.id);
      const cvs = node ? Array.from(node.querySelectorAll('canvas')) : [];
      cvs.forEach((cv, j) => jobs.push([cv, cvs.length > 1 ? `${fig.id}_${j + 1}` : fig.id]));
    });
    if (!jobs.length) return alert('Nenhuma figura para exportar.');
    jobs.forEach(([cv, name], i) => setTimeout(() => P.downloadCanvas(cv, name), i * 350));
  }, 500);
}


/* -------------------------------------------- proveniência e checklist -- */
/* Monta o manifesto da análise em curso a partir do que o núcleo registrou nos
   objetos parseados e das opções efetivamente usadas nas figuras. */
async function buildProvenance() {
  const perfil = activeProfile();
  const prov = C.createProvenance({
    appVersion: '0.5.0',
    now: new Date().toISOString(),
    profileId: perfil.id, profileLabel: perfil.label,
    timezoneOffsetMin: offMin(),
    timezoneBreaks: []
  });
  for (const fl of activeFiles()) {
    const p = fl.parsed;
    prov.file({
      name: fl.name,
      sha256: fl.sha256 || null,
      subjectId: p.patient.idHash,
      firmware: p.device.firmware, programmerVersion: p.meta.programmerVersion,
      deviceModel: p.device.model, implantDate: String(p.device.implantDate || '').slice(0, 10),
      modalities: p.availability
    });
    (p.bsTimeDomain || []).concat(p.montageTD || []).forEach(td => {
      const est = C.nanStats(td.data);
      prov.record('parse.timeDomain', {
        channel: td.label, fsNominal: td.fs,
        fsEffective: isFinite(td.fsEff) ? +td.fsEff.toFixed(4) : null,
        driftMsTotal: td.timing && isFinite(td.timing.driftMsTotal) ? +td.timing.driftMsTotal.toFixed(2) : null,
        hardwareFilters: 'passa-alta do dispositivo (não exposta no JSON)'
      }, { nIn: est.n, nOut: est.nValid, nDropped: est.nNan, dropReason: 'perda de pacotes (NaN)' });
      const pk = td.packets || {};
      prov.record('io.analyzePackets', {
        method: pk.method, reliable: pk.reliable,
        pctMissing: isFinite(pk.pctMissing) ? +pk.pctMissing.toFixed(3) : null,
        nGaps: (pk.gaps || []).length, policy: 'NaN, sem interpolação nem concatenação'
      }, { nIn: pk.nExpected, nOut: pk.nReceived, nDropped: pk.nMissing, dropReason: pk.reason || 'pacotes perdidos' });
      if (pk.nMissing) prov.exclusion({
        what: `amostras perdidas em ${td.label}`, criterion: 'perda de pacote detectada por ' + pk.method,
        n: pk.nMissing, decidedBy: 'automático', reason: 'lacuna preservada como NaN'
      });
    });
  }
  /* passos de DSP com os parâmetros EFETIVOS usados nas figuras */
  const d = ds();
  const td0 = (d.bsTimeDomain[0] || d.montageTD[0]);
  if (td0) {
    const w = C.welchPSD(td0.data, td0.fsEff || td0.fs, { nperseg: 512, overlap: .5 });
    prov.record('dsp.welchPSD', {
      window: 'hann', nperseg: w.nperseg, overlap: 0.5, df: +w.df.toFixed(4),
      detrend: 'linear por segmento', maxNanPct: 0,
      nSegments: w.nSegments, nSegmentsDropped: w.nSegmentsDropped,
      pctDataUsed: +(w.pctDataUsed || 0).toFixed(1)
    }, { nIn: td0.data.length, nOut: w.p ? w.p.length : 0, figure: 'F1' });
    prov.record('dsp.fitAperiodic', { fmin: 2, fmax: 95, method: 'regressão robusta iterativa log-log' }, { figure: 'F2' });
    const oB = S.opts.F6 || {};
    prov.record('dsp.detectBursts', {
      band: [oB.blo || 13, oB.bhi || 20], percentile: oB.pct || 75,
      minDurationMs: oB.minms || 100, envelope: 'Hilbert', gapPolicy: 'burst não atravessa lacuna'
    }, { figure: 'F6' });
  }
  if (Object.keys(d.trend).length) {
    const o9 = S.opts.F9 || {};
    prov.record('stats.cosinor', {
      harmonics: (o9.harm || '24+12'), binMin: o9.bin || 30, detrendDaily: o9.detrend !== false,
      outlierRule: 'mediana ± 4×MAD', bootstrap: 'blocos por dia inteiro', nBoot: o9.boot || 200
    }, { figure: 'F9' });
    prov.record('stats.permutationTest', { nPerm: 3000, scope: 'comparações das figuras F7/F10/F12' });
  }
  return prov;
}

async function exportChecklist(formato) {
  if (!S.files.length) return alert('Carregue ao menos um arquivo antes de gerar o checklist.');
  const prov = await buildProvenance();
  const b = exportBundle();
  const ck = C.generateChecklist(prov.manifest(), b, activeProfile());
  const nome = `PERCEPT-REPORT_${(b && b.subject.id) || 'analise'}`;
  if (formato === 'docx') {
    const bytes = C.checklistDocx(ck);
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const a = document.createElement('a');
    a.download = nome + '.docx'; a.href = URL.createObjectURL(blob); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } else {
    P.downloadText(ck.markdown, nome + '.md', 'text/markdown');
  }
  return ck;
}

async function exportManifest() {
  if (!S.files.length) return alert('Carregue ao menos um arquivo antes de exportar o manifesto.');
  const prov = await buildProvenance();
  const m = prov.manifest();
  m.manifestHash = await prov.hash();
  P.downloadText(JSON.stringify(m, null, 2), `manifesto_proveniencia_${m.files[0] ? m.files[0].subjectId : 'analise'}.json`, 'application/json');
}

/* Reproduz a análise a partir de um manifesto e confirma que os resultados
   batem — é o que torna a reprodutibilidade verificável, não declarada. */
async function verifyFromManifest(file) {
  try {
    const guardado = JSON.parse(await file.text());
    const atual = (await buildProvenance()).manifest();
    const r = C.verifyManifest(guardado, atual);
    const det = r.ok ? '' : '\n\n' + r.divergences.slice(0, 8)
      .map(d => `• ${d.campo}: manifesto "${d.guardado}" vs. atual "${d.atual}"`).join('\n');
    alert(`${r.ok ? '✓' : '✗'} ${r.verdict}${det}`);
  } catch (e) {
    alert('Não foi possível ler o manifesto: ' + e.message);
  }
}

/* ------------------------------------------------- relatório em PDF ----- */
function buildReportCover(b) {
  const s = b.subject;
  const off = s.timezone_offset_min;
  const wrap = el('div', { class: 'report-cover', id: 'report-cover' });
  wrap.appendChild(el('div', { class: 'rc-head' }, [
    el('div', { class: 'rc-brand', html: '<b>PERCEPT LFP STUDIO</b><span>Relatório de análise de LFP subtalâmico</span>' }),
    el('div', { class: 'rc-date', text: 'Gerado em ' + new Date().toLocaleString('pt-BR') })
  ]));
  const kv = el('dl', { class: 'kv rc-kv' });
  const add = (k, v) => { kv.appendChild(el('dt', { text: k })); kv.appendChild(el('dd', { text: (v == null || v === '') ? '—' : String(v) })); };
  add('identificador', s.id);
  add('diagnóstico', s.diagnosis || '—');
  add('dispositivo', `${s.device_model || '—'} · fw ${s.firmware || '—'} · ${s.device_location || '—'}`);
  add('data de implante', s.implant_date || '—');
  add('alvos', s.targets.map(t => `${(t.hemisphere || '')[0]}:${t.target}`).join('  ') || '—');
  add('perfil de doença', `${s.profile_label || activeProfile().label} · banda primária ${activeProfile().primaryBand.label} (${activeProfile().primaryBand.lo}–${activeProfile().primaryBand.hi} Hz) · normalização ${activeProfile().normalization}`);
  add('fuso aplicado', `UTC${off >= 0 ? '+' : '−'}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`);
  add('sessões', `${b.sessions.length}` + (b.sessions.length ? ` (${b.sessions[0].session_date_local || '—'} → ${b.sessions[b.sessions.length - 1].session_date_local || '—'})` : ''));
  wrap.appendChild(kv);

  if (b.acute.length) {
    wrap.appendChild(el('h3', { class: 'rc-h', text: 'Métricas agudas — por sessão e hemisfério' }));
    wrap.appendChild(table(
      ['hemisfério', 'sessão', 'd. impl.', 'fonte', 'pico β (Hz)', 'β?', 'χ aperiód.', 'burst/s', 'dur. méd. (ms)'],
      b.acute.map(r => [
        { html: `<span class="hemi-${(r.hemisphere || '')[0]}">${hname(r.hemisphere)}</span>` },
        r.session_date_local || '—', r.days_since_implant, r.spectrum_source || '—',
        r.beta_peak_hz, { html: r.has_beta_peak ? '<span class="sig">sim</span>' : '<span class="ns">não</span>' },
        r.aperiodic_exponent, r.burst_rate_hz, r.burst_mean_ms
      ])
    ));
  }
  if (b.chronic.length) {
    wrap.appendChild(el('h3', { class: 'rc-h', text: 'Métricas crônicas (Timeline) — por hemisfério' }));
    wrap.appendChild(table(
      ['hemisfério', 'dias (n)', 'MESOR', 'amp. 24 h', 'acrofase', 'cosinor p*', 'Rayleigh p', '<lim %', 'entre %', '>lim %'],
      b.chronic.map(r => [
        { html: `<span class="hemi-${(r.hemisphere || '')[0]}">${hname(r.hemisphere)}</span>` },
        `${r.n_days} (${r.n_points})`, r.mesor, r.amp_24h,
        isFinite(r.acrophase_24h) ? r.acrophase_24h + ' h' : '—',
        { html: pHtml(r.cosinor_p_adj_ar1) }, { html: pHtml(r.rayleigh_p) },
        r.pct_below, r.pct_between, r.pct_above
      ])
    ));
  }
  wrap.appendChild(el('h3', { class: 'rc-h', text: 'Como ler estas métricas' }));
  const gl = el('dl', { class: 'kv rc-gloss' });
  const g = (k, v) => { gl.appendChild(el('dt', { text: k })); gl.appendChild(el('dd', { html: v })); };
  /* o glossário segue o PERFIL ativo: em distonia o marcador é teta-alfa, em
     tremor essencial é a frequência do tremor — não "beta" fixo */
  const glos = activeProfile().glossary;
  g(glos.primario, `${glos.picoTexto} ${glos.intuicao}`);
  g('elegibilidade', glos.elegibilidade);
  g('pico β (beta)', 'Frequência onde o beta é mais forte. O beta é o “ritmo do freio” dos núcleos da base: tende a subir quando a medicação está no fim (OFF) e a cair quando ela faz efeito (ON) ou sob estimulação eficaz.');
  g('χ aperiódico', 'Inclinação de fundo do espectro (a parte não oscilatória). Reflete o balanço excitação/inibição da rede; use como métrica de apoio, não isolada.');
  g('bursts', 'Rajadas curtas de beta. Rajadas mais longas e frequentes acompanham mais rigidez/lentidão e são o alvo do aDBS de limiar único.');
  g('MESOR · amplitude · acrofase', 'Do ritmo de 24 h: o nível médio, o tamanho da oscilação dia↔noite e a hora do pico. Descrevem como o beta muda ao longo do dia.');
  g('cosinor p* · Rayleigh p', 'Testam se o ritmo de 24 h é real (p* já corrigido para a forte autocorrelação do sinal a cada 10 min) e se o horário do pico se repete entre os dias.');
  g('% abaixo / entre / acima', 'Quanto tempo o beta passa em cada faixa de limiar. Guia a escolha dos limiares do aDBS: se quase tudo cai numa faixa, o aparelho quase não modula.');
  g('estados ON/OFF (β)', 'Divisão automática do sinal em baixo beta (ON, efeito presente) e alto beta (OFF). “% em OFF” resume quanto do registro ficou em alto beta. É um correlato — artefato de movimento pode simular OFF.');
  wrap.appendChild(gl);

  wrap.appendChild(el('div', {
    class: 'note rc-note', html:
      '<b>Notas metodológicas.</b> Espectro por Welch (Hann, 50% de sobreposição) ou nativo do dispositivo; componente aperiódico por ' +
      'aproximação do specparam/FOOOF; bursts por envelope de Hilbert com limiar no percentil 75 (<i>pré-registre o percentil</i>); ' +
      'ritmo circadiano por cosinor de 24+12 h com <i>p</i> corrigido para autocorrelação AR(1) (coluna cosinor p*) e teste de Rayleigh ' +
      'das acrofases diárias; timestamps do Percept (UTC) convertidos para hora local. ' +
      'Ferramenta de pesquisa e apoio à decisão — não substitui o julgamento clínico nem o software regulado do fabricante.'
  }));
  wrap.appendChild(el('div', { class: 'rc-figtitle', text: 'Figuras' }));
  return wrap;
}
function generateReport() {
  if (!S.files.length) return alert('Carregue ao menos um Session Report antes de gerar o relatório.');
  renderAllReady();
  const bundle = exportBundle();
  const main = $('#figs');
  const old = document.getElementById('report-cover'); if (old) old.remove();
  if (bundle) main.insertBefore(buildReportCover(bundle), main.firstChild);
  document.body.classList.add('printing');
  const cleanup = () => {
    document.body.classList.remove('printing');
    const c = document.getElementById('report-cover'); if (c) c.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  setTimeout(() => window.print(), 500);
}

function init() {
  $('#fileInput').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });
  $('#btnExport').addEventListener('click', exportSession);
  $('#btnPrint').addEventListener('click', generateReport);
  $('#tz').addEventListener('change', e => {
    S.tzOverride = e.target.value === 'auto' ? null : parseInt(e.target.value, 10);
    renderAll();
  });
  ['dragover', 'drop'].forEach(ev => document.addEventListener(ev, e => e.preventDefault()));
  document.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (S.files.length) $$('.fig[open]').forEach(f => renderFigure(f.id.replace('fig-', ''))); }, 260); });
  renderAll();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http'))
    navigator.serviceWorker.register('./sw.js').then(reg => {
      /* quando uma nova versão do app for publicada, recarrega uma vez para aplicá-la */
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) location.reload();
        });
      });
    }).catch(() => { });
}
document.addEventListener('DOMContentLoaded', init);
/* hook de depuração (usado pela suíte de testes; inerte em produção) */
window.__PLS__ = { FIGURES, ds, S, renderFigure, handleFiles, offMin, exportBundle, buildReportCover };
})();
