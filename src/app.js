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

/* =================================================== retorno de processo ==
   POR QUE ISTO EXISTE. Um Session Report com meses de Timeline e minutos de
   streaming leva segundos para ser processado, e o cálculo roda na thread
   principal do navegador — durante ele a página não repinta. Sem retorno
   visual, isso é indistinguível de travamento, e foi exatamente assim que o
   comportamento foi relatado.

   O QUE MUDA. Cada etapa é ANUNCIADA e pintada ANTES de ser executada, e o
   tempo real medido é registrado depois. Uma espera longa passa a ser legível:
   dá para ver qual etapa está demorando e quanto cada uma custou. O painel não
   bloqueia a tela — as figuras vão aparecendo enquanto ele avança. */

/* Devolve o controle ao navegador por um quadro, para que ele pinte. */
const proximoQuadro = () => new Promise(res => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(res, 0));
  else setTimeout(res, 0);
});
const msTexto = ms => ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms';

const Prog = {
  total: 0, feitos: 0, t0: 0, tEtapa: 0, rotulo: '', ativo: false, _token: 0, _ultimoPct: 0,
  _n(id) { return document.getElementById(id); },

  begin(titulo) {
    this.total = 0; this.feitos = 0; this.ativo = true; this.rotulo = '';
    this.t0 = Date.now(); this.tEtapa = this.t0; this._token++; this._ultimoPct = 0;
    const p = this._n('proc');
    if (p) {
      p.hidden = false; p.className = 'proc';
      const t = this._n('procTitle'); if (t) t.textContent = titulo;
      const l = this._n('procLog'); if (l) l.innerHTML = '';
      const n = this._n('procNow'); if (n) n.textContent = 'preparando…';
    }
    this._pct(0);
    return this;
  },

  /* declara mais n etapas; o denominador do percentual pode crescer ao longo
     do caminho (só depois de agregar sabemos quantas figuras têm dados) */
  expect(n) { this.total += n; this._pct(); return this; },

  /* O denominador CRESCE ao longo do caminho: só depois de agregar as séries se
     sabe quantas figuras têm dados. Para que a barra não ande para trás quando
     isso acontece, o percentual exibido é monotônico dentro de uma execução —
     ele apenas espera as novas etapas alcançarem o ponto já mostrado. Os tempos
     exatos de cada etapa continuam na lista, sem suavização. */
  _pct(v) {
    let pct = v != null ? v : (this.total ? Math.min(99, Math.round(100 * this.feitos / this.total)) : 0);
    pct = Math.max(0, Math.min(100, pct));
    if (v == null) pct = Math.max(pct, this._ultimoPct);
    this._ultimoPct = pct;
    const f = this._n('procFill'), t = this._n('procPct');
    if (f && f.style) f.style.width = pct + '%';
    if (t) t.textContent = pct + '%';
  },

  _encerra(falhou, detalhe) {
    if (!this.rotulo) return;
    const dt = Date.now() - this.tEtapa;
    const log = this._n('procLog');
    if (log && log.appendChild) {
      log.appendChild(el('li', { class: falhou ? 'falhou' : dt >= 1500 ? 'lento' : '' }, [
        el('i', { style: 'font-style:normal', text: (falhou ? '✗ ' : '') + this.rotulo + (detalhe ? ' — ' + detalhe : '') }),
        el('span', { text: msTexto(dt) })
      ]));
      if (isFinite(log.scrollHeight)) log.scrollTop = log.scrollHeight;
    }
    this.feitos++; this.rotulo = '';
    this._pct();
  },

  /* Anuncia a etapa e devolve o controle ao navegador para que ela apareça na
     tela ANTES de o cálculo começar. */
  async step(rotulo) {
    if (!this.ativo) { await proximoQuadro(); return; }
    this._encerra(false);
    this.rotulo = rotulo;
    const n = this._n('procNow'); if (n) n.textContent = rotulo;
    this.tEtapa = Date.now();
    await proximoQuadro();
  },

  /* registra que a etapa corrente falhou, sem interromper as demais */
  falhaEtapa(detalhe) { this._encerra(true, detalhe); },

  async finish(msg) {
    if (!this.ativo) return;
    this._encerra(false);
    const total = Date.now() - this.t0;
    this.ativo = false;
    const p = this._n('proc');
    if (p) p.className = 'proc pronto';
    const n = this._n('procNow');
    if (n) n.textContent = `${msg || 'concluído'} — ${msTexto(total)} no total`;
    this._pct(100);
    const meu = this._token;
    setTimeout(() => {
      const q = this._n('proc');
      if (q && !Prog.ativo && Prog._token === meu) q.hidden = true;
    }, total > 3000 ? 7000 : 2500);
    await proximoQuadro();
  },

  fail(e) {
    this._encerra(true, String((e && e.message) || e));
    this.ativo = false;
    const p = this._n('proc'); if (p) p.className = 'proc erro';
    const n = this._n('procNow');
    if (n) n.textContent = 'falhou: ' + String((e && e.message) || e);
    this._pct(100);
  }
};

/* Executa uma etapa única com retorno visual — usado pelas exportações, que
   recalculam todas as métricas e por isso também levam segundos. */
async function comEtapa(titulo, rotulo, fn) {
  Prog.begin(titulo).expect(1);
  await Prog.step(rotulo);
  try {
    const r = await fn();
    await Prog.finish('pronto');
    return r;
  } catch (e) { Prog.fail(e); throw e; }
}

/* ======================================================== estado global == */
const S = {
  files: [],            // [{name, parsed}]
  tzOverride: null,     // minutos
  subject: null,        // idHash do registro ativo
  opts: {},             // opções por figura
  profile: null,        // id do perfil de doença; null = sugerir pelo JSON
  symptomSeries: null,  // série clínica importada (distonia): [{t, v}]
  mode: 'clinico',      // 'clinico' | 'pesquisa' (Onda 8.1)
};

/* ============================================= preferências de interface ==
   APENAS preferências de interface — o modo de uso e a dispensa do tutorial.
   Nenhum dado de paciente, nome de arquivo ou métrica é gravado: o
   armazenamento local nunca vê o conteúdo do JSON. Se o navegador bloquear o
   armazenamento (janela anônima, política restritiva), tudo continua
   funcionando com os padrões. */
const PREF_KEY = 'pls.prefs.v1';
function lerPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function salvarPref(chave, valor) {
  try { const o = lerPrefs(); o[chave] = valor; localStorage.setItem(PREF_KEY, JSON.stringify(o)); } catch (e) { /* sem armazenamento: segue com o padrão */ }
}

/* ============================================================== modos ====
   Modo CLÍNICO: as seis figuras que respondem às perguntas de consultório
   (definidas por perfil de doença, em profiles/index.js), cada uma com a
   leitura em linguagem simples no topo, um semáforo de qualidade e um botão de
   exportação. Modo PESQUISA: todas as figuras, todos os controles, todas as
   exportações e os pipelines de um clique.

   O modo muda O QUE É MOSTRADO, nunca COMO É CALCULADO: os mesmos números, as
   mesmas ressalvas, os mesmos parâmetros declarados. */
function modoAtual() { return S.mode === 'pesquisa' ? 'pesquisa' : 'clinico'; }
function ehClinico() { return modoAtual() === 'clinico'; }
function setModo(m) {
  if (modoAtual() === m) return;
  S.mode = m; salvarPref('modo', m);
  marcarModo();
  renderAll(m === 'clinico' ? 'Modo clínico' : 'Modo pesquisa');
}
function marcarModo() {
  ['clinico', 'pesquisa'].forEach(m => {
    const b = document.getElementById('modo' + m[0].toUpperCase() + m.slice(1));
    if (b) b.setAttribute('aria-pressed', String(modoAtual() === m));
  });
}

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

/* Datasets agregados (somente dentro do registro ativo) --------------------
   Memoizado: cada figura chamava `ds()` de novo, e a concatenação/desduplicação
   de meses de Timeline custa dezenas de milissegundos por chamada. A chave
   depende apenas do que altera o resultado — os arquivos carregados e o
   registro ativo. Fuso e perfil de doença NÃO entram no agregado. */
let _dsCache = null, _dsChave = null, _dsVersao = 0;
/* Invalidação explícita: trocar o conteúdo de um arquivo pelo mesmo nome não
   muda a chave textual, então quem mexe em S.files avisa aqui. */
function invalidarDs() { _dsVersao++; _dsCache = null; _bundleCache = null; _leiturasCache = null; }
function ds() {
  const chave = _dsVersao + "|" + S.files.length + "|" + S.files.map(x => x.name).join("~") + "|" + (S.subject || "");
  if (_dsCache && _dsChave === chave) return _dsCache;
  const out = dsCompute();
  _dsChave = chave; _dsCache = out;
  return out;
}
function dsCompute() {
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
/* Trocar um parâmetro recalcula a figura — com aviso, porque em registros
   longos esse recálculo também custa segundos. */
function setOpt(figId, key, v) { S.opts[figId] = S.opts[figId] || {}; S.opts[figId][key] = v; renderFigureAsync(figId); }

function plotBox(parent, h, classe) {
  const box = el('div', { class: 'plotbox' + (classe ? ' ' + classe : '') });
  const cv = el('canvas');
  box.appendChild(cv); parent.appendChild(box);
  const w = parent.clientWidth || 640;
  cv.style.width = '100%'; cv.style.height = (h || 260) + 'px';
  return { canvas: cv, box, width: Math.max(280, (box.clientWidth || w) - 12), height: h || 260 };
}

/* Cor do beta baixo — a mesma da tabela de bandas e do sombreado, para que o
   destaque no painel de varredura fale a mesma língua do resto da figura. */
const CORBETA = '#B8912A';

/* ---------------------------------------------------- painel de varredura --
   POR QUE EXISTE. Um Survey de eletrodo anelar rende 6 pares bipolares por
   hemisfério; com eletrodo direcional passa de 15. Abrir um a um num menu para
   descobrir onde o marcador é mais forte é trabalhoso e compara mal — o olho não
   guarda a curva anterior. Aqui todos os pares do hemisfério aparecem juntos,
   cada um sobre sua própria linha de base (gráfico de cumeeira, "ridgeline"),
   que é o arranjo que evita a sobreposição das curvas.

   O par de maior marcador fica destacado na cor do beta baixo. O mouse sobre
   qualquer curva revela a combinação de contatos e os números daquele par; o
   clique abre esse par no detalhe abaixo.

   A altura é comparável entre pares do MESMO hemisfério (escala única). Com
   "normalizar cada par" ligado, cada curva usa a própria escala — aí só a FORMA
   é comparável, não a amplitude, e a nota da figura diz isso.                */
function painelVarredura(parent, canais, hemi, o) {
  const n = canais.length;
  const altura = Math.max(190, 52 + n * 24);
  const bx = plotBox(parent, altura, 'svbox');
  const tip = el('div', { class: 'svtip' });
  if (bx.box && bx.box.appendChild) bx.box.appendChild(tip);
  if (bx.canvas.style) bx.canvas.style.cursor = 'pointer';

  const fmax = o.fmax;
  const curvas = canais.map(c => {
    const xs = [], ys = [];
    for (let i = 0; i < c.f.length; i++) if (c.f[i] <= fmax) { xs.push(c.f[i]); ys.push(c.mag[i]); }
    const validos = ys.filter(isFinite);
    return { xs, ys, max: validos.length ? Math.max.apply(null, validos) : 1e-9 };
  });
  const maxGlobal = Math.max.apply(null, curvas.map(c => c.max).concat([1e-9]));
  const escalaDe = i => 1.35 / (o.normalizar ? (curvas[i].max || 1e-9) : maxGlobal);

  let hover = -1, ch = null;

  /* a largura é medida no momento do desenho, não no da criação: o painel pode
     ter sido reposicionado pelo layout entre um e outro */
  const larguraAtual = () => Math.max(280, ((bx.box && bx.box.clientWidth) || bx.width + 12) - 12);
  const desenha = () => {
    ch = new P.Chart(bx.canvas, {
      width: larguraAtual(), height: altura, xlim: [0, fmax], ylim: [0, n + 0.45],
      xlabel: 'frequência (Hz)',
      title: `STN ${hname(hemi)} — ${n} pares bipolares`,
      pad: { l: 78, r: 14, t: 24, b: 40 }
    });
    ch.axes({
      grid: false,
      yticks: canais.map((_, i) => n - 1 - i + 0.1),
      yfmt: v => { const i = n - 1 - Math.round(v - 0.1); return canais[i] ? canais[i].label : ''; }
    });
    if (o.showBands) profileBands().forEach(b => { if (b.lo < fmax) ch.span(b.lo, Math.min(b.hi, fmax), { color: b.color, alpha: .09 }); });
    ch.span(o.blo, Math.min(o.bhi, fmax), { color: CORBETA, alpha: .07 });
    /* do topo para baixo: quem está mais abaixo é desenhado por último e fica à
       frente, que é o que dá a leitura de profundidade da cumeeira */
    canais.forEach((c, i) => {
      const base = n - 1 - i, esc = escalaDe(i);
      const alto = curvas[i].ys.map(v => isFinite(v) ? base + v * esc : NaN);
      const baixo = curvas[i].xs.map(() => base);
      const melhor = c.rank === 1, ativo = i === hover;
      const selecionado = o.cur && o.cur.canal && o.cur.canal.key === c.key;
      const cor = ativo ? COL.accent : melhor ? CORBETA : hcol(hemi);
      /* preenchimento opaco antes da cor: é o que impede a curva de baixo de
         aparecer através da de cima */
      ch.area(curvas[i].xs, baixo, alto, { color: '#FBFCFD', alpha: 1 });
      ch.area(curvas[i].xs, baixo, alto, { color: cor, alpha: (ativo || melhor) ? .5 : .2 });
      ch.line(curvas[i].xs, alto, { color: cor, width: ativo ? 2.2 : melhor ? 1.9 : .9 });
      if (selecionado) ch.line([0, fmax], [base, base], { color: COL.ink, width: 1.3, dash: [3, 3] });
    });
  };
  desenha();

  /* Qual curva está sob o cursor: percorre de cima para baixo e fica com a
     ÚLTIMA que contém o ponto — a última desenhada é a que está visível. */
  const alvoDe = (px, py) => {
    if (!ch) return -1;
    const fx = ch.invX(px), fy = ch.invY(py);
    let achado = -1;
    for (let i = 0; i < n; i++) {
      const base = n - 1 - i;
      if (fy < base) continue;
      const xs = curvas[i].xs;
      let j = 0, dist = Infinity;
      for (let k = 0; k < xs.length; k++) { const dd = Math.abs(xs[k] - fx); if (dd < dist) { dist = dd; j = k; } }
      const topo = base + (isFinite(curvas[i].ys[j]) ? curvas[i].ys[j] * escalaDe(i) : 0);
      if (fy <= topo) achado = i;
    }
    if (achado < 0) {
      const i = n - 1 - Math.floor(fy);
      if (i >= 0 && i < n) achado = i;
    }
    return achado;
  };

  const posicao = ev => {
    const r = bx.canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  };
  bx.canvas.addEventListener('mousemove', ev => {
    const [px, py] = posicao(ev);
    const i = alvoDe(px, py);
    if (i !== hover) { hover = i; desenha(); }
    if (i >= 0) {
      const c = canais[i];
      tip.innerHTML = `<b>${c.label}</b> · STN ${hname(hemi)} · <b>#${c.rank}</b> de ${n}<br>` +
        `pico ${isFinite(c.peakHz) ? f(c.peakHz, 1) + ' Hz' : '—'} · acima do 1/f ${f(c.bandAreaCorrected, 2)} · bruta ${f(c.bandArea, 2)}` +
        (c.hasDistinctPeak ? '' : '<br><i>sem pico destacado do fundo aperiódico</i>') +
        (c.nRecords > 1 ? `<br><i>mediana de ${c.nRecords} registros</i>` : '');
      tip.style.display = 'block';
      tip.style.left = Math.max(4, Math.min(px + 14, larguraAtual() - 170)) + 'px';
      tip.style.top = Math.max(4, py - 52) + 'px';
    } else tip.style.display = 'none';
  });
  bx.canvas.addEventListener('mouseleave', () => {
    tip.style.display = 'none';
    if (hover >= 0) { hover = -1; desenha(); }
  });
  bx.canvas.addEventListener('click', ev => {
    const [px, py] = posicao(ev);
    const i = alvoDe(px, py);
    if (i >= 0 && o.svValor && o.svValor[canais[i].key]) setOpt('F1', 'src', o.svValor[canais[i].key]);
  });
  return bx;
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
    id: 'F1', title: 'Espectro de potência anotado e varredura do Survey',
    sub: 'todos os pares bipolares de uma vez, ordenados pelo marcador · detalhe do par escolhido',
    has: d => d.sensingSetup.length || d.signalCheck.length || d.montage.length,
    render(node, d) {
      const pb = profileBands().primary || { lo: 13, hi: 35, label: 'beta' };
      const blo = opt('F1', 'blo', pb.lo), bhi = opt('F1', 'bhi', pb.hi);
      const criterio = opt('F1', 'crit', 'aperiodic');
      const showBands = opt('F1', 'bands', true);
      const normalizar = opt('F1', 'norm', false);
      const fmax = opt('F1', 'fmax', 60);

      /* ranking de todos os pares do Survey, por hemisfério --------------- */
      const rk = d.montage.length ? C.rankSurveyChannels(d.montage, { lo: blo, hi: bhi, criterion: criterio, topN: 3 }) : null;

      /* fontes do painel de detalhe: SignalTest, SignalCheck e um item por
         PAR do Survey (não por registro) — já na ordem do ranking */
      const src = [];
      d.sensingSetup.forEach((s, i) => s.psd && src.push({ value: 'ss' + i, label: `SignalTest ${s.channel} (${hname(s.hemisphere)})`, f: s.psd.f, p: s.psd.p, hemi: s.hemisphere, center: s.centerFreq, artifact: s.psd.artifact }));
      d.signalCheck.forEach((s, i) => src.push({ value: 'sc' + i, label: `SignalCheck ${C.prettyChannel(s.channel)}`, f: s.f, p: s.p, hemi: /LEFT/i.test(s.channel) ? 'Left' : 'Right', artifact: s.artifact }));
      const canaisRk = [], svValor = {};
      if (rk) ['Left', 'Right'].concat(Object.keys(rk.hemispheres).filter(h => !['Left', 'Right'].includes(h)))
        .forEach(h => (rk.hemispheres[h] || []).forEach(c => {
          canaisRk.push(c);
          svValor[c.key] = 'sv' + canaisRk.length;
          src.push({
            value: 'sv' + canaisRk.length, canal: c,
            label: `Survey ${String(c.hemisphere)[0]} · ${c.label} — #${c.rank} de ${rk.hemispheres[h].length}`,
            f: c.f, p: c.mag, hemi: c.hemisphere, artifact: c.artifact
          });
        }));
      if (!src.length) return node.appendChild(el('div', { class: 'empty', text: 'Nenhum espectro disponível.' }));
      const padrao = (src.find(s => s.canal && s.canal.rank === 1) || src[0]).value;
      const cur = src.find(s => s.value === opt('F1', 'src', padrao)) || src[0];

      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('ordenar por', [
          { value: 'aperiodic', label: 'acima do fundo 1/f' },
          { value: 'raw', label: 'área bruta na banda' },
          { value: 'peak', label: 'magnitude do pico' }
        ], criterio, v => setOpt('F1', 'crit', v)),
        ctrlNumber('banda de (Hz)', blo, 1, 60, 1, v => setOpt('F1', 'blo', v)),
        ctrlNumber('banda até (Hz)', bhi, 3, 90, 1, v => setOpt('F1', 'bhi', v)),
        ctrlNumber('f máx. do gráfico (Hz)', fmax, 20, 100, 5, v => setOpt('F1', 'fmax', v)),
        ctrlCheck('faixas de frequência', showBands, v => setOpt('F1', 'bands', v)),
        ctrlCheck('normalizar cada par (compara forma, não amplitude)', normalizar, v => setOpt('F1', 'norm', v))
      ]));

      /* ---------------------------------------------- (a) varredura ------ */
      if (rk) {
        node.appendChild(el('h4', {
          class: 'qc-title',
          html: `<b>(a) Varredura do Survey</b> — todos os pares bipolares de cada hemisfério ao mesmo tempo. ` +
            `Em <span style="color:${CORBETA};font-weight:600">amarelo</span>, o par com mais ${pb.label || 'marcador'} ` +
            `(${rk.criterionLabel}). Passe o mouse para ver a combinação de contatos; clique para abrir no detalhe abaixo.`
        }));
        const lados = ['Left', 'Right'].concat(Object.keys(rk.hemispheres).filter(h => !['Left', 'Right'].includes(h)))
          .filter(h => (rk.hemispheres[h] || []).length);
        const grid = el('div', { class: 'plotgrid' + (lados.length > 1 ? ' two' : '') }); node.appendChild(grid);
        lados.forEach(h => painelVarredura(grid, rk.hemispheres[h], h, { fmax, blo, bhi, showBands, normalizar, cur, svValor }));

        /* --------------------------------------------- top 3 por lado ---- */
        const linhas = [];
        Object.keys(rk.top).forEach(h => rk.top[h].forEach(c => linhas.push([
          { html: `<span class="hemi-${String(h)[0]}">${hname(h)}</span>` },
          `#${c.rank}`,
          { html: `<b>${c.label}</b>` },
          isFinite(c.peakHz) ? f(c.peakHz, 1) + ' Hz' : '—',
          { html: c.hasDistinctPeak ? '<span class="sig">sim</span>' : '<span class="ns">não</span>' },
          f(c.bandAreaCorrected, 2),
          f(c.bandArea, 2),
          isFinite(c.relPct) ? f(c.relPct, 1) + ' %' : '—',
          f(c.aperiodicR2, 2) + (c.fallback ? ' ⚠' : ''),
          c.nRecords > 1 ? `${c.nRecords} registros (mediana)` : (c.artifact || '—')
        ])));
        node.appendChild(el('h4', {
          class: 'qc-title',
          html: `<b>Três melhores pares por hemisfério</b> — ordenados por ${rk.criterionLabel} em ${blo}–${bhi} Hz`
        }));
        node.appendChild(table(
          ['hemisfério', 'ordem', 'contatos', `pico em ${blo}–${bhi} Hz`, 'pico distinto?', 'área acima do 1/f', 'área bruta', 'relativa', 'R² do 1/f', 'observação'],
          linhas));
        node.appendChild(el('div', {
          class: rk.nFallback ? 'warnbox' : 'note',
          html: `<b>Como esta ordem foi obtida.</b> ${rk.nChannels} pares avaliados com o mesmo critério: ` +
            `<b>${rk.criterionLabel}</b>, banda ${blo}–${bhi} Hz. ${rk.caveat}`
        }));
        node.appendChild(exportRow([
          {
            label: '⤓ CSV ranking completo', fn: () => P.downloadText(P.toCSV(
              Object.keys(rk.hemispheres).flatMap(h => rk.hemispheres[h].map(c => ({
                hemisferio: h, ordem: c.rank, contatos: c.label, eletrodos: c.electrodes,
                pico_hz: c.peakHz, pico_magnitude: c.peakMag, pico_distinto: c.hasDistinctPeak ? 1 : 0,
                area_acima_1f: c.bandAreaCorrected, area_bruta: c.bandArea, relativa_pct: c.relPct,
                expoente_aperiodico: c.aperiodicExponent, r2_aperiodico: c.aperiodicR2,
                criterio: c.criterionUsed, n_registros: c.nRecords, artefato: c.artifact,
                banda_lo: blo, banda_hi: bhi
              })))), 'F1_ranking_survey.csv', 'text/csv')
          }
        ]));
      }

      /* ------------------------------------------------- (b) detalhe ----- */
      node.appendChild(el('h4', { class: 'qc-title', html: '<b>Detalhe do par selecionado</b>' }));
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('canal em detalhe', src, cur.value, v => setOpt('F1', 'src', v))
      ]));
      const grid2 = el('div', { class: 'plotgrid two' }); node.appendChild(grid2);

      const idx = cur.f.map((_, i) => i).filter(i => cur.f[i] <= fmax);
      const xs = idx.map(i => cur.f[i]), ys = idx.map(i => cur.p[i]);
      let peakI = 0; ys.forEach((v, i) => { if (xs[i] >= 4 && v > ys[peakI]) peakI = i; });

      const b1 = plotBox(grid2, 268);
      const ch1 = new P.Chart(b1.canvas, {
        width: b1.width, height: b1.height, xlim: [0, fmax], ylim: [0, Math.max(...ys) * 1.22],
        xlabel: 'frequência (Hz)', ylabel: 'magnitude (µVp/√Hz)',
        title: `(b) ${cur.label} — escala linear`,
        pad: { l: 58, r: 14, t: 24, b: 40 }
      });
      ch1.axes();
      if (showBands) profileBands().forEach(b => { if (b.lo < fmax) ch1.span(b.lo, Math.min(b.hi, fmax), { color: b.color, alpha: .09, label: b.label }); });
      if (cur.center) ch1.span(cur.center - 2.5, cur.center + 2.5, { color: COL.warn, alpha: .16 });
      ch1.line(xs, ys, { color: COL.ink, width: 1.6 });
      ch1.marker(xs[peakI], ys[peakI], { color: COL.right, shape: 'tri', size: 4.5, label: `${xs[peakI].toFixed(1)} Hz · ${f(ys[peakI], 2)}`, align: xs[peakI] > fmax * .6 ? 'right' : 'left' });

      const pos = idx.filter(i => cur.f[i] >= 1 && cur.p[i] > 0);
      const lx = pos.map(i => cur.f[i]), ly = pos.map(i => cur.p[i]);
      const b2 = plotBox(grid2, 268);
      const ch2 = new P.Chart(b2.canvas, {
        width: b2.width, height: b2.height, xlog: true, ylog: true,
        xlim: [1, Math.max(...cur.f)], ylim: [Math.max(1e-4, Math.min(...ly) * .7), Math.max(...ly) * 1.5],
        xlabel: 'frequência (Hz)', ylabel: 'magnitude (log)', title: '(c) escala log-log',
        pad: { l: 62, r: 14, t: 24, b: 40 }
      });
      ch2.axes({ xfmt: v => v >= 1 ? String(v) : v.toFixed(1) });
      ch2.line(lx, ly, { color: COL.ink, width: 1.6 });

      const bt = C.bandTable(cur.f, cur.p);
      node.appendChild(table(['banda', 'faixa', 'potência abs.', 'relativa %', 'pico (Hz)', 'magnitude'],
        bt.map(b => [{ html: `<span style="color:${b.color};font-weight:600">${b.label} ${b.key}</span>` },
        `${b.lo}–${b.hi}`, b.absolute, b.relative, b.peakF, b.peakV])));

      node.appendChild(exportRow([
        { label: '⤓ PNG (b)', fn: () => P.downloadCanvas(b1.canvas, 'F1b_psd_linear') },
        { label: '⤓ PNG (c)', fn: () => P.downloadCanvas(b2.canvas, 'F1c_psd_loglog') },
        { label: '⤓ CSV espectro', fn: () => P.downloadText(P.toCSV(cur.f.map((v, i) => ({ frequencia_Hz: v, magnitude: cur.p[i] }))), 'F1_espectro.csv', 'text/csv') }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Método.</b> Espectro nativo do dispositivo (FFT de 256 pontos sobre 250 Hz de amostragem, Δf ≈ 0,977 Hz). ` +
          `Estado do artefato reportado pelo Percept: <b>${cur.artifact || '—'}</b>. ` +
          (cur.center ? `Faixa laranja = janela de sensing crônico (${f(cur.center, 1)} ± 2,5 Hz). ` : '') +
          `A escala log-log é a forma canônica na literatura porque lineariza o componente aperiódico 1/f. ` +
          (rk ? `<b>Sobre a varredura:</b> as curvas do painel (a) estão deslocadas verticalmente uma em relação à outra ` +
            `(<i>ridgeline</i>) justamente para não se sobreporem; a altura é comparável entre pares do mesmo hemisfério ` +
            `${normalizar ? '— exceto agora, com “normalizar cada par” ligado, em que só a FORMA é comparável, não a amplitude' : ''}. ` +
            `Pares repetidos entre sessões entram pela mediana ponto a ponto.` : '')
      }));
    }  },

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
        /* dois modelos não lineares (decaimento e sigmoide inversa), com o de
           menor erro em destaque — a regressão linear não descreve saturação */
        const dr = C.fitDoseResponse(keys, meds, { nBoot: 120 });
        if (dr) {
          const xx = Array.from({ length: 60 }, (_, i) => keys[0] + (keys[keys.length - 1] - keys[0]) * i / 59);
          ch2.line(xx, xx.map(dr.predict), {
            color: dr.stimulationArtifactSuspected ? COL.right : COL.warn, width: 1.8,
            label: `${dr.label} · R²=${f(dr.r2, 2)}`
          });
          if (isFinite(dr.halfSuppressionMa))
            ch2.vline(dr.halfSuppressionMa, { color: COL.ink, dash: [3, 3], label: `x₀=${f(dr.halfSuppressionMa, 2)} mA` });
        }
        const lr = C.linreg(keys, meds);
        ch2.legend({ x: ch2.x0 + 8, y: ch2.y1 + 6 });
        if (dr) {
          node.appendChild(table(['modelo', 'MSE', 'R²', 'seleção'],
            dr.fits.map(x => [x.label, x.mse, x.r2, { html: x.model === dr.best ? '<span class="sig">escolhido</span>' : '<span class="ns">—</span>' }])));
          node.appendChild(table(['parâmetro', 'valor', 'IC 95%'],
            dr.paramNames.map((nm, j) => [nm, dr.params[j], `[${dr.paramCI[j][0]}; ${dr.paramCI[j][1]}]`])
              .concat([['meia-supressão (x₀)', isFinite(dr.halfSuppressionMa) ? dr.halfSuppressionMa + ' mA' : '—', ''],
                       ['supressão máxima', f(dr.maxSuppressionPct, 1) + ' %', '']])));
          if (dr.stimulationArtifactSuspected) node.appendChild(el('div', {
            class: 'warnbox', html: `<b>Artefato de estimulação suspeito.</b> ${dr.reason}`
          }));
        }

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
  },

  /* ----------------------------------------------------------------- F16 */
  {
    id: 'F16', title: 'QC — reprodutibilidade do pico entre registros',
    sub: 'o mesmo canal, medido de novo, dá o mesmo pico?',
    has: d => d.montage.length,
    render(node, d) {
      const pb = activeProfile().primaryBand;
      const registros = d.all.flatMap(p => (p.montage || []).map(m => ({
        hemisphere: m.hemisphere, channel: m.label, f: m.f, p: m.mag,
        sessionDate: String(p.meta.sessionStart || '').slice(0, 10), artifact: m.artifact
      })));
      const r = C.peakReproducibility(registros, { lo: pb.lo, hi: pb.hi });
      if (!r.channels.length) return node.appendChild(el('div', { class: 'empty', text: 'Sem espectros de Survey para avaliar.' }));

      const avaliaveis = r.channels.filter(c => c.verdict !== 'n insuficiente');
      if (avaliaveis.length) {
        const box = plotBox(node, 260);
        const ch = new P.Chart(box.canvas, {
          width: box.width, height: box.height,
          xlim: [-0.6, avaliaveis.length - 0.4], ylim: [pb.lo - 2, pb.hi + 2],
          xlabel: 'canal', ylabel: 'frequência de pico (Hz)',
          title: `pico por canal e registro — banda ${pb.label}`, pad: { l: 62, r: 14, t: 24, b: 56 }
        });
        ch.axes({ xticks: avaliaveis.map((_, i) => i), xfmt: v => (avaliaveis[v] || {}).channel || '' });
        avaliaveis.forEach((c, i) => {
          /* faixa de ±1 Hz ao redor da mediana = critério de reprodutibilidade */
          ch.ctx.fillStyle = c.verdict === 'reprodutível' ? '#2C7A4B' : '#A8621B';
          ch.ctx.globalAlpha = .14;
          ch.ctx.fillRect(ch.X(i - 0.35), ch.Y(c.medianHz + 1), ch.X(i + 0.35) - ch.X(i - 0.35), ch.Y(c.medianHz - 1) - ch.Y(c.medianHz + 1));
          ch.ctx.globalAlpha = 1;
          c.peaks.forEach(hz => ch.marker(i, hz, { color: hcol(c.hemisphere), size: 3.4 }));
        });
      }
      node.appendChild(table(['hemisfério', 'canal', 'n', 'picos (Hz)', 'desvio máx.', 'CV magnitude', 'veredito'],
        r.channels.map(c => [
          { html: `<span class="hemi-${c.hemisphere[0]}">${hname(c.hemisphere)}</span>` },
          c.channel, c.n, c.peaks.join(' · '), c.maxDeviationHz, c.magnitudeCV,
          { html: c.verdict === 'reprodutível' ? '<span class="sig">reprodutível</span>'
            : c.verdict === 'instável' ? '<span style="color:var(--warn);font-weight:600">instável</span>'
            : '<span class="ns">n insuficiente</span>' }
        ])));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Por que isto importa.</b> Thenaisie et al. reportaram que registros consecutivos do mesmo paciente e mesmos contatos ` +
          `foram classificados de forma <b>inconsistente entre sessões</b> pelo próprio Percept, e que 27% dos pares de contato foram rotulados como ` +
          `artefactuais em GPi. Um pico que não se repete entre registros não é biomarcador. Critério: ${r.criterion}.` +
          (r.note ? ` <b>${r.note}</b>` : '')
      }));
      node.appendChild(exportRow([
        { label: '⤓ CSV', fn: () => P.downloadText(P.toCSV(r.channels.map(c => ({
          hemisferio: c.hemisphere, canal: c.channel, n: c.n, picos_Hz: c.peaks.join(' '),
          desvio_max_Hz: c.maxDeviationHz, cv_magnitude: c.magnitudeCV, veredito: c.verdict
        }))), 'F16_reprodutibilidade.csv', 'text/csv') }
      ]));
    }
  },

  /* ----------------------------------------------------------------- F17 */
  {
    id: 'F17', title: 'Painel de controle de qualidade',
    sub: 'semáforo do checklist de artefatos, por arquivo e hemisfério',
    has: d => d.all.length,
    render(node, d) {
      const pb = activeProfile().primaryBand;
      const qc = C.qcPanel(d.all, { band: [pb.lo, pb.hi] });
      const s = qc.summary;

      node.appendChild(el('div', {
        class: 'note', html: `<b>${s.verde}</b> verificados e aprovados · <b>${s.amarelo}</b> com ressalva · ` +
          `<b>${s.vermelho}</b> com problema · <b>${s.cinza}</b> não verificáveis com este dado — ` +
          `<b>${s.pctVerificado}%</b> dos itens puderam ser verificados.`
      }));

      qc.rows.forEach(linha => {
        node.appendChild(el('h4', {
          class: 'qc-title',
          html: `<span class="hemi-${linha.hemisphere[0]}">STN ${hname(linha.hemisphere)}</span> · ` +
            `<span style="color:var(--ink-3)">${linha.file.replace(/^Report_Json_Session_Report_/, '').replace(/\.json$/, '')}</span> · ` +
            `estado do dispositivo: <b>${linha.deviceState}</b>`
        }));
        const grid = el('div', { class: 'qcgrid' });
        linha.items.forEach(i => {
          const cel = el('div', { class: 'qcitem ' + i.cor });
          cel.appendChild(el('b', { text: i.rotulo }));
          cel.appendChild(el('span', { class: 'v', text: String(i.valor) }));
          if (i.motivo) cel.appendChild(el('span', { class: 'm', text: i.motivo }));
          grid.appendChild(cel);
        });
        node.appendChild(grid);
      });

      /* triagem por ECG que exclui hemisfério da série crônica */
      const tri = C.screenChronicByEcg(d.all);
      const linhasTri = Object.values(tri.hemispheres).filter(h => h.evaluated);
      if (linhasTri.length) {
        node.appendChild(el('h4', { class: 'qc-title', html: '<b>Triagem por ECG para a série crônica</b>' }));
        node.appendChild(table(['hemisfério', 'ECG detectado', 'confiança', 'recomendação', 'motivo'],
          linhasTri.map(h => [
            { html: `<span class="hemi-${h.hemisphere[0]}">${hname(h.hemisphere)}</span>` },
            h.ecgDetected ? 'sim' : 'não', h.confidence,
            { html: h.recommendation === 'incluir' ? '<span class="sig">incluir</span>'
              : `<span style="color:var(--warn);font-weight:600">${h.recommendation}</span>` },
            h.reason
          ])));
        node.appendChild(el('div', {
          class: 'note', html: `<b>Critério.</b> ${tri.criterion}. ${tri.note}`
        }));
      }

      node.appendChild(exportRow([
        { label: '⤓ CSV do painel', fn: () => P.downloadText(P.toCSV(qc.rows.flatMap(l => l.items.map(i => ({
          arquivo: l.file, hemisferio: l.hemisphere, estado_dispositivo: l.deviceState,
          item: i.rotulo, status: i.cor, valor: i.valor, motivo: i.motivo || ''
        })))), 'F17_qc.csv', 'text/csv') }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Leitura.</b> Cinza não é falha do software: é a declaração honesta de que <b>este dado não permite verificar</b> o item, com o motivo. ` +
          `A alternativa — omitir o item — daria a impressão de que tudo foi checado.`
      }));
    }
  },

  /* ----------------------------------------------------------------- F23 */
  {
    id: 'F23', title: 'aDBS — elegibilidade e simulador de limiar',
    sub: 'o documento que se leva para a consulta de programação',
    has: d => Object.keys(d.trend).length || d.montage.length,
    render(node, d) {
      /* ---------- A. elegibilidade ---------- */
      const el2 = C.assessEligibility(d.all, { profileId: activeProfileId(), offMin: offMin() });
      node.appendChild(table(['hemisfério', 'veredito', `pico ${activeProfile().primaryBand.label}`, 'dias de Timeline', 'bloqueios'],
        el2.hemispheres.map(h => [
          { html: `<span class="hemi-${h.hemisphere[0]}">${hname(h.hemisphere)}</span>` },
          { html: h.verdict === 'elegível' ? '<span class="sig">elegível</span>'
            : h.verdict === 'não elegível' ? '<span style="color:var(--right);font-weight:600">não elegível</span>'
            : `<span style="color:var(--warn);font-weight:600">${h.verdict}</span>` },
          isFinite(h.peakHz) ? f(h.peakHz, 1) + ' Hz' : '—',
          h.nDaysChronic, h.blockers.join('; ') || '—'
        ])));

      el2.hemispheres.forEach(h => {
        node.appendChild(el('h4', { class: 'qc-title', html: `<b>STN ${hname(h.hemisphere)}</b> — critérios` }));
        const grid = el('div', { class: 'qcgrid' });
        h.criteria.forEach(c => {
          const cor = c.veredito === 'atende' ? 'verde'
            : c.veredito === 'não atende' ? 'vermelho'
            : c.veredito === 'dados insuficientes' ? 'cinza' : 'amarelo';
          const cel = el('div', { class: 'qcitem ' + cor });
          cel.appendChild(el('b', { text: c.rotulo }));
          cel.appendChild(el('span', { class: 'v', text: c.veredito }));
          cel.appendChild(el('span', { class: 'm', text: c.evidencia }));
          if (c.pendencia) cel.appendChild(el('span', { class: 'm', text: '→ ' + c.pendencia }));
          grid.appendChild(cel);
        });
        node.appendChild(grid);
      });
      node.appendChild(el('div', {
        class: 'note', html: `<b>Contexto.</b> ${el2.context}. Prevalência do pico beta na literatura: ` +
          `${el2.prevalence.adaptPd} no ADAPT-PD; ${el2.prevalence.registroBrainSense} no registro de vigilância BrainSense. ` +
          `<i>${el2.prevalence.nota}.</i>`
      }));

      /* ---------- B. simulador ---------- */
      const hemis = Object.keys(d.trend);
      if (!hemis.length) {
        node.appendChild(el('div', { class: 'warnbox', html: 'Sem <b>BrainSense Timeline</b>, não é possível simular o comportamento do aDBS. Habilite o Timeline nos dois hemisférios e registre ao menos 3–5 dias.' }));
        return;
      }
      const h = opt('F23', 'hemi', hemis[0]);
      const modo = opt('F23', 'modo', 'dual');
      const minMa = opt('F23', 'min', 1.0), maxMa = opt('F23', 'max', 3.0);
      const avg = opt('F23', 'avg', 3000);
      const limpo = C.removeOutliersMAD(d.trend[h], 'lfp', 4).kept;
      const serie = limpo.map(r => ({ t: r.t, v: r.lfp }));
      const sug = C.suggestThresholds(serie, {
        states: C.detectStates(serie, { minDur: 30 * 60000 }) || undefined,
        targetDutyCycle: 0.5
      });
      const lo = opt('F23', 'lo', sug ? sug.suggestions[0].lower : NaN);
      const hi = opt('F23', 'hi', sug ? sug.suggestions[0].upper : NaN);

      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('hemisfério', hemis.map(x => ({ value: x, label: 'STN ' + hname(x) })), h, v => setOpt('F23', 'hemi', v)),
        ctrlSelect('modo', [{ value: 'single', label: 'limiar único' }, { value: 'dual', label: 'limiar duplo' }], modo, v => setOpt('F23', 'modo', v)),
        ctrlNumber('limiar inferior', lo, 0, 1e6, 1, v => setOpt('F23', 'lo', v)),
        ctrlNumber('limiar superior', hi, 0, 1e6, 1, v => setOpt('F23', 'hi', v)),
        ctrlNumber('mA mín.', minMa, 0, 10, .1, v => setOpt('F23', 'min', v)),
        ctrlNumber('mA máx.', maxMa, 0, 10, .1, v => setOpt('F23', 'max', v)),
        ctrlNumber('constante do aparelho (ms)', avg, 0, 10000, 500, v => setOpt('F23', 'avg', v))
      ]));

      const sim = C.simulateAdbs(serie, { mode: modo, lower: lo, upper: hi, minMa, maxMa, averagingMs: avg });
      const instant = C.simulateAdbs(serie, { mode: modo, lower: lo, upper: hi, minMa, maxMa, averagingMs: 0 });
      if (!sim) return node.appendChild(el('div', { class: 'empty', text: 'Série curta demais para simular.' }));

      const box = plotBox(node, 280);
      const xs = sim.times, ys = serie.map(p => p.v);
      const ch = new P.Chart(box.canvas, {
        width: box.width, height: box.height, xlim: [xs[0], xs[xs.length - 1]],
        ylim: [0, Math.max(...ys) * 1.12],
        xlabel: 'data local', ylabel: 'potência LFP (u.a.)',
        title: `simulação de aDBS — ${modo === 'single' ? 'limiar único' : 'limiar duplo'}`, pad: { l: 62, r: 52, t: 24, b: 42 }
      });
      ch.axes({ nx: 7, xfmt: v => new Date(v + offMin() * 60000).toISOString().slice(5, 10).split('-').reverse().join('/') });
      ch.span(xs[0], xs[xs.length - 1], { color: '#93A7B5', alpha: 0 });
      ch.hline(lo, { color: COL.muted, dash: [4, 3], label: 'inf.' });
      ch.hline(hi, { color: COL.muted, dash: [4, 3], label: 'sup.' });
      ch.line(xs, ys, { color: hcol(h), width: .8 });
      /* amplitude entregue, reescalada para o mesmo eixo */
      const escala = Math.max(...ys) * .9 / (maxMa || 1);
      ch.line(xs, sim.delivered.map(v => v * escala), { color: COL.accent, width: 1.6, label: 'amplitude simulada' });
      ch.legend({ x: ch.x0 + 8, y: ch.y1 + 6 });

      node.appendChild(table(['métrica', 'com a constante do aparelho', 'decisão instantânea', 'o que significa'], [
        ['% do tempo em amplitude alta', f(sim.pctHigh, 1) + ' %', f(instant.pctHigh, 1) + ' %', 'quanto o paciente passa na amplitude máxima'],
        ['% em amplitude mínima', f(sim.pctLow, 1) + ' %', f(instant.pctLow, 1) + ' %', 'quanto passa no piso'],
        ['transições por hora', f(sim.transitionsPerHour, 2), f(instant.transitionsPerHour, 2), 'a suavização do aparelho reduz o troca-troca'],
        ['duração mediana em alta', f(sim.medianHighMin, 1) + ' min', f(instant.medianHighMin, 1) + ' min', 'persistência de cada estado'],
        ['duty cycle', f(sim.dutyCycle, 3), f(instant.dutyCycle, 3), 'fração efetiva de estimulação alta'],
        ['amplitude média entregue', f(sim.meanAmplitudeMa, 2) + ' mA', f(instant.meanAmplitudeMa, 2) + ' mA', 'média ao longo do período'],
        ['energia vs. cDBS contínua', f(sim.energyVsContinuous, 3), f(instant.energyVsContinuous, 3), '1,0 = mesma energia da estimulação contínua na amplitude máxima']
      ]));

      if (sug) {
        node.appendChild(el('h4', { class: 'qc-title', html: '<b>Sugestões de limiar</b> — cada critério responde a uma pergunta diferente' }));
        node.appendChild(table(['critério', 'inferior', 'superior', 'racional'],
          sug.suggestions.map(x => [x.criterion, x.lower, x.upper,
            x.rationale + (x.caveat ? ` — ${x.caveat}` : '')])));
      }

      node.appendChild(exportRow([
        { label: '⤓ PNG', fn: () => P.downloadCanvas(box.canvas, 'F23_simulador_adbs') },
        { label: '⤓ CSV elegibilidade', fn: () => P.downloadText(P.toCSV(el2.hemispheres.flatMap(x => x.criteria.map(c => ({
          hemisferio: x.hemisphere, veredito_global: x.verdict, criterio: c.rotulo,
          veredito: c.veredito, evidencia: c.evidencia, pendencia: c.pendencia || ''
        })))), 'F23_elegibilidade_adbs.csv', 'text/csv') },
        { label: '⤓ CSV simulação', fn: () => P.downloadText(P.toCSV(sim.times.map((t, i) => ({
          utc: new Date(t).toISOString(), potencia: serie[i].v,
          suavizada: +sim.smoothed[i].toFixed(4), amplitude_mA: +sim.delivered[i].toFixed(4)
        }))), 'F23_simulacao_adbs.csv', 'text/csv') }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Por que a constante do aparelho importa.</b> O dispositivo suaviza o sinal antes de decidir ` +
          `(<code>AveragingDurationInMilliSeconds</code>, tipicamente 3000 ms) e sobe/desce por rampa. Sem aplicar isso, a simulação ` +
          `<b>superestima</b> o número de transições — a coluna "decisão instantânea" mostra exatamente essa diferença. ` +
          `<b>Desafios de programação</b> nomeados por Busch et al. (8 pacientes em limiar duplo, avaliação ecológica em casa por 2 semanas em cada modo): ` +
          `seleção do biomarcador, definição do limiar e <b>maladaptação relacionada a artefato</b> — verifique a F17 antes de fixar limiares.`
      }));
    }
  },

  /* ----------------------------------------------------------------- F18 */
  {
    id: 'F18', title: 'Espectro multitaper com intervalo de confiança',
    sub: 'Slepian (DPSS) sobre o trecho inteiro · jackknife entre tapers · comparação com Welch',
    has: d => d.bsTimeDomain.length || d.montageTD.length,
    render(node, d) {
      const tds = d.bsTimeDomain.concat(d.montageTD);
      const alvo = opt('F18', 'td', 0);
      const NW = opt('F18', 'nw', 3);
      const minC = opt('F18', 'minc', 0.9);
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('canal', tds.map((t, i) => ({ value: i, label: `${t.label} (${hname(t.hemisphere)})` })), alvo, v => setOpt('F18', 'td', +v)),
        ctrlNumber('NW (tempo × banda)', NW, 1.5, 8, 0.5, v => setOpt('F18', 'nw', v)),
        ctrlNumber('concentração mínima', minC, 0.5, 0.999, 0.01, v => setOpt('F18', 'minc', v))
      ]));
      const td = tds[Math.min(alvo, tds.length - 1)];
      if (!td) return node.appendChild(el('div', { class: 'empty', text: 'Sem sinal bruto.' }));
      qualitySeal(node, td);
      const fs = td.fsEff || td.fs;
      const mt = C.multitaperPSD(td.data, fs, { NW, minConcentration: minC });
      if (!mt || !mt.p) return node.appendChild(el('div', { class: 'empty', text: mt ? mt.reason : 'não foi possível estimar.' }));
      const w = C.welchPSD(td.data, fs, { nperseg: 512, overlap: .5 });

      const fmax = 60;
      const idx = []; for (let i = 0; i < mt.f.length; i++) if (mt.f[i] > 0 && mt.f[i] <= fmax) idx.push(i);
      const xs = idx.map(i => mt.f[i]);
      const box = plotBox(node, 300);
      const todos = idx.map(i => mt.ciHigh ? mt.ciHigh[i] : mt.p[i]).filter(isFinite);
      const ch = new P.Chart(box.canvas, {
        width: box.width, height: box.height, xlim: [0, fmax],
        ylim: [0, Math.max.apply(null, todos) * 1.08],
        xlabel: 'frequência (Hz)', ylabel: 'PSD (µV²/Hz)',
        title: `multitaper — NW ${NW}, ${mt.K} taper(s) · resolução ${f(mt.resolutionHz, 2)} Hz`,
        pad: { l: 70, r: 14, t: 24, b: 42 }
      });
      ch.axes();
      if (mt.ciLow) ch.area(xs, idx.map(i => mt.ciLow[i]), idx.map(i => mt.ciHigh[i]),
        { color: hcol(td.hemisphere), alpha: .18, label: 'IC 95% (jackknife)' });
      ch.line(xs, idx.map(i => mt.p[i]), { color: hcol(td.hemisphere), width: 1.8, label: 'multitaper' });
      if (w.p) {
        const iw = []; for (let i = 0; i < w.f.length; i++) if (w.f[i] > 0 && w.f[i] <= fmax) iw.push(i);
        ch.line(iw.map(i => w.f[i]), iw.map(i => w.p[i]), { color: COL.muted, width: 1.1, dash: [4, 3], label: 'Welch' });
      }
      ch.legend({ x: ch.x1 - 150, y: ch.y1 + 6 });

      const pb = profileBands().primary || { lo: 13, hi: 35 };
      const cmp = C.compareEstimators(w, mt, pb.lo, pb.hi);
      const inc = C.spectralUncertainty(mt);
      node.appendChild(table(['item', 'valor', 'o que significa'], [
        ['tapers usados / pedidos', `${mt.K} / ${mt.KRequested}`, 'tapers pouco concentrados vazam energia e são descartados'],
        ['concentração de cada taper', mt.concentrations.map(v => f(v, 4)).join(' · '), 'fração da energia da janela dentro de ±W; abaixo do limiar o taper sai'],
        ['resolução em frequência', `${f(mt.resolutionHz, 2)} Hz`, '2·NW·fs/N — o preço da redução de variância'],
        ['graus de liberdade (aprox.)', String(mt.dofApprox), '2K; o Welch equivalente precisaria de K segmentos independentes'],
        ['dados usados', `${f(mt.pctDataUsed, 1)} % (${mt.nUsed} de ${mt.nTotal} amostras)`, 'maior trecho contíguo sem lacuna; nada foi interpolado'],
        ['largura mediana do IC', isFinite(inc) ? `${f(inc, 2)}×` : '—', 'razão IC alto / IC baixo — incerteza típica do espectro'],
        cmp ? ['pico na banda primária', `Welch ${f(cmp.welchPeakHz, 2)} Hz · multitaper ${f(cmp.multitaperPeakHz, 2)} Hz`, cmp.note] : null
      ].filter(Boolean)));

      if (cmp && !cmp.agree) node.appendChild(el('div', {
        class: 'warnbox', html: `<b>Os estimadores discordam em ${f(cmp.deltaHz, 2)} Hz.</b> ${cmp.note}`
      }));

      node.appendChild(exportRow([
        { label: '⤓ PNG', fn: () => P.downloadCanvas(box.canvas, 'F18_multitaper') },
        { label: '⤓ CSV espectro', fn: () => P.downloadText(P.toCSV(idx.map(i => ({
          hz: +mt.f[i].toFixed(4), psd_multitaper: mt.p[i],
          ic_baixo: mt.ciLow ? mt.ciLow[i] : '', ic_alto: mt.ciHigh ? mt.ciHigh[i] : '',
          NW, K: mt.K
        }))), 'F18_multitaper.csv', 'text/csv') }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Método.</b> Sequências de Slepian calculadas do zero pelo problema tridiagonal de Percival & Walden, ` +
          `com autovalores por bissecção de Sturm e autovetores por iteração inversa. O multitaper aplica ${mt.K} janelas ortogonais ao ` +
          `<b>mesmo trecho</b>, em vez de picar o registro como o Welch — o que importa em streaming curto. ` +
          `O IC vem do jackknife entre tapers em escala logarítmica (Thomson & Chave). ` +
          `<b>Quando os dois estimadores concordam</b> sobre a frequência de pico, ela não depende do método; quando discordam, o vazamento ` +
          `espectral é relevante e isso precisa ser reportado.`
      }));
    }
  },

  /* ----------------------------------------------------------------- F19 */
  {
    id: 'F19', title: 'specparam completo — reta ou joelho, largura dos picos, R²',
    sub: 'ajuste iterativo de gaussianas com limites, reajuste simultâneo e seleção por AIC',
    has: d => d.sensingSetup.some(s => s.psd) || d.signalCheck.length || d.montage.length,
    render(node, d) {
      const src = [];
      d.sensingSetup.forEach((s, i) => s.psd && src.push({ value: 'ss' + i, label: `SignalTest ${s.channel}`, f: s.psd.f, p: s.psd.p, hemi: s.hemisphere }));
      d.signalCheck.forEach((s, i) => src.push({ value: 'sc' + i, label: `SignalCheck ${C.prettyChannel(s.channel)}`, f: s.f, p: s.p, hemi: /LEFT/i.test(s.channel) ? 'Left' : 'Right' }));
      d.montage.forEach((m, i) => src.push({ value: 'mo' + i, label: `Survey ${m.hemisphere[0]} · ${m.label}`, f: m.f, p: m.mag, hemi: m.hemisphere }));
      if (!src.length) return node.appendChild(el('div', { class: 'empty', text: 'Nenhum espectro disponível.' }));
      const cur = src.find(s => s.value === opt('F19', 'src', src[0].value)) || src[0];
      const fmin = opt('F19', 'fmin', 2), fmax = opt('F19', 'fmax', 95);
      const maxN = opt('F19', 'maxn', 6);
      const bwMax = opt('F19', 'bwmax', 12);
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('canal', src, cur.value, v => setOpt('F19', 'src', v)),
        ctrlNumber('f mínima (Hz)', fmin, 1, 20, 1, v => setOpt('F19', 'fmin', v)),
        ctrlNumber('f máxima (Hz)', fmax, 30, 125, 5, v => setOpt('F19', 'fmax', v)),
        ctrlNumber('máx. de picos', maxN, 1, 10, 1, v => setOpt('F19', 'maxn', v)),
        ctrlNumber('largura máx. (Hz)', bwMax, 3, 30, 1, v => setOpt('F19', 'bwmax', v))
      ]));
      const cmp = C.specparamCompare(cur.f, cur.p, { fmin, fmax, maxNPeaks: maxN, peakWidthLimits: [1, bwMax] });
      if (!cmp || !cmp.fixed) return node.appendChild(el('div', { class: 'empty', text: 'Espectro curto demais para o ajuste.' }));
      const m = cmp[cmp.best] || cmp.fixed;

      const grid = el('div', { class: 'plotgrid two' }); node.appendChild(grid);
      const b1 = plotBox(grid, 268);
      const lx = m.f.map(v => Math.log10(v));
      const ch1 = new P.Chart(b1.canvas, {
        width: b1.width, height: b1.height,
        xlim: [Math.log10(fmin), Math.log10(fmax)],
        ylim: [Math.min.apply(null, m.logPower) - .1, Math.max.apply(null, m.logPower) + .15],
        xlabel: 'log₁₀ frequência (Hz)', ylabel: 'log₁₀ potência',
        title: `(a) modelo completo — ${m.aperiodicMode === 'knee' ? 'com joelho' : 'reta'} · R² ${f(m.r2, 3)}`,
        pad: { l: 62, r: 14, t: 24, b: 42 }
      });
      ch1.axes({ xfmt: v => f(Math.pow(10, v), 0) });
      ch1.line(lx, m.logPower, { color: COL.ink, width: 1.4, label: 'observado' });
      ch1.line(lx, m.aperiodicLog, { color: COL.warn, width: 1.6, dash: [5, 3], label: 'aperiódico' });
      ch1.line(lx, m.modelLog, { color: COL.accent, width: 1.8, label: 'modelo' });
      ch1.legend({ x: ch1.x1 - 120, y: ch1.y1 + 6 });

      const b2 = plotBox(grid, 268);
      const per = m.periodicLog;
      const ch2 = new P.Chart(b2.canvas, {
        width: b2.width, height: b2.height, xlim: [fmin, Math.min(fmax, 60)],
        ylim: [Math.min(0, Math.min.apply(null, per)) - .02, Math.max(.05, Math.max.apply(null, per)) * 1.15],
        xlabel: 'frequência (Hz)', ylabel: 'potência acima do aperiódico (log₁₀)',
        title: '(b) componente periódico e picos ajustados', pad: { l: 68, r: 14, t: 24, b: 42 }
      });
      ch2.axes();
      ch2.line(m.f, m.f.map((x, i) => m.logPower[i] - m.aperiodicLog[i]), { color: COL.muted, width: 1, label: 'achatado' });
      ch2.line(m.f, per, { color: hcol(cur.hemi), width: 1.9, label: 'gaussianas' });
      m.peaks.forEach(pk => {
        ch2.vline(pk.cf, { color: COL.accent, width: 1, dash: [3, 3] });
        ch2.span(pk.cf - pk.bw / 2, pk.cf + pk.bw / 2, { color: COL.accent, alpha: .07 });
      });
      ch2.legend({ x: ch2.x1 - 110, y: ch2.y1 + 6 });

      node.appendChild(table(['pico', 'frequência central (Hz)', 'altura (log₁₀)', 'largura (Hz)', 'banda'],
        m.peaks.length ? m.peaks.map((pk, i) => [`#${i + 1}`, f(pk.cf, 2), f(pk.pw, 3), f(pk.bw, 2), C.bandOf(pk.cf)])
          : [['—', '—', '—', '—', 'nenhum pico passou dos critérios']]));

      node.appendChild(table(['modelo', 'expoente χ', 'offset', 'joelho', 'R²', 'erro (MAE)', 'AIC'], [
        ['reta (fixed)', f(cmp.fixed.exponent, 3), f(cmp.fixed.offset, 3), '—', f(cmp.fixed.r2, 4), f(cmp.fixed.error, 4), cmp.aicFixed == null ? '—' : f(cmp.aicFixed, 1)],
        cmp.knee ? ['com joelho (knee)', f(cmp.knee.exponent, 3), f(cmp.knee.offset, 3),
          `${f(cmp.knee.knee, 2)}${cmp.knee.kneeFrequencyHz ? ` (≈ ${f(cmp.knee.kneeFrequencyHz, 1)} Hz)` : ''}`,
          f(cmp.knee.r2, 4), f(cmp.knee.error, 4), cmp.aicKnee == null ? '—' : f(cmp.aicKnee, 1)] : null
      ].filter(Boolean)));

      node.appendChild(el('div', {
        class: m.r2 < 0.8 ? 'warnbox' : 'note',
        html: m.warning
          ? `<b>${m.warning}.</b>`
          : `<b>Seleção de modelo.</b> ${cmp.note} (ΔAIC = ${cmp.deltaAic == null ? '—' : f(cmp.deltaAic, 1)}). ` +
            `${m.nPeaksDiscarded ? `${m.nPeaksDiscarded} candidato(s) a pico foram descartados por altura ou largura fora dos limites. ` : ''}` +
            `Parâmetros efetivos: até ${m.params.maxNPeaks} picos, altura mínima ${m.params.minPeakHeight}, limiar ${m.params.peakThreshold} SD, ` +
            `largura entre ${m.params.peakWidthLimits[0]} e ${m.params.peakWidthLimits[1]} Hz.`
      }));

      node.appendChild(exportRow([
        { label: '⤓ PNG modelo', fn: () => P.downloadCanvas(b1.canvas, 'F19_specparam_modelo') },
        { label: '⤓ PNG picos', fn: () => P.downloadCanvas(b2.canvas, 'F19_specparam_picos') },
        { label: '⤓ CSV picos', fn: () => P.downloadText(P.toCSV(m.peaks.map(pk => ({
          canal: cur.label, modelo: m.aperiodicMode, cf_hz: pk.cf, altura_log10: pk.pw, largura_hz: pk.bw,
          expoente: m.exponent, offset: m.offset, joelho: m.knee == null ? '' : m.knee, r2: m.r2, erro: m.error
        }))), 'F19_specparam_picos.csv', 'text/csv') }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Diferença para a F2.</b> A F2 usa a aproximação robusta (reta em log-log, picos como resíduo) — boa para anotar. ` +
          `Aqui está o procedimento do artigo: ajuste aperiódico robusto, busca iterativa de gaussianas com <b>limites de largura</b>, ` +
          `reajuste <b>simultâneo</b> de todos os picos por Levenberg-Marquardt, e reajuste do aperiódico sobre o espectro sem picos. ` +
          `<b>Não reporte o expoente sem o R²</b>: um ajuste ruim produz um número que parece uma medida e não é.`
      }));
    }
  },

  /* ----------------------------------------------------------------- F20 */
  {
    id: 'F20', title: 'Wavelet de Morlet — escalograma e bursts delimitados',
    sub: 'CWT complexa · detecção e delimitação separadas · limiar por linha de base 1/f',
    has: d => d.bsTimeDomain.length || d.montageTD.length,
    render(node, d) {
      const tds = d.bsTimeDomain.concat(d.montageTD);
      const alvo = opt('F20', 'td', 0);
      const nCiclos = opt('F20', 'nc', 7);
      const pb = profileBands().primary || { lo: 13, hi: 30 };
      const blo = opt('F20', 'blo', pb.lo), bhi = opt('F20', 'bhi', Math.min(pb.hi, 30));
      const pct = opt('F20', 'pct', 75);
      const borda = opt('F20', 'edge', 0.5);
      const modoLimiar = opt('F20', 'thr', 'percentil');
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('canal', tds.map((t, i) => ({ value: i, label: `${t.label} (${hname(t.hemisphere)})` })), alvo, v => setOpt('F20', 'td', +v)),
        ctrlNumber('ciclos da wavelet', nCiclos, 3, 15, 1, v => setOpt('F20', 'nc', v)),
        ctrlNumber('banda de (Hz)', blo, 1, 60, 1, v => setOpt('F20', 'blo', v)),
        ctrlNumber('banda até (Hz)', bhi, 2, 90, 1, v => setOpt('F20', 'bhi', v)),
        ctrlSelect('limiar', [{ value: 'percentil', label: 'percentil do registro' }, { value: 'aperiodico', label: 'linha de base 1/f' }], modoLimiar, v => setOpt('F20', 'thr', v)),
        ctrlNumber('percentil', pct, 50, 95, 5, v => setOpt('F20', 'pct', v)),
        ctrlNumber('borda (fração do limiar)', borda, 0.2, 1, 0.1, v => setOpt('F20', 'edge', v))
      ]));
      const td = tds[Math.min(alvo, tds.length - 1)];
      if (!td) return node.appendChild(el('div', { class: 'empty', text: 'Sem sinal bruto.' }));
      qualitySeal(node, td);
      const fs = td.fsEff || td.fs;
      /* limita o trecho para manter o cálculo interativo, e declara o recorte */
      const maxAmostras = Math.round(fs * 60);
      const recortado = td.data.length > maxAmostras;
      const x = recortado ? (td.data.subarray ? td.data.subarray(0, maxAmostras) : td.data.slice(0, maxAmostras)) : td.data;

      const freqs = []; for (let ff = Math.max(1, blo - 5); ff <= Math.min(bhi + 15, fs / 2 - 5); ff += 1) freqs.push(ff);
      const cwt = C.morletCWT(x, fs, freqs, { nCycles: nCiclos });
      if (!cwt) return node.appendChild(el('div', { class: 'empty', text: 'Trecho curto demais para a wavelet.' }));
      const env = C.waveletBandEnvelope(cwt, blo, bhi);
      if (!env) return node.appendChild(el('div', { class: 'empty', text: 'Nenhuma frequência da CWT cai na banda escolhida.' }));

      /* limiar: percentil do registro ou linha de base aperiódica */
      let limiarInfo = null, opcoes = { percentile: pct, edgeFraction: borda, minDurationMs: 100 };
      if (modoLimiar === 'aperiodico') {
        const w = C.welchPSD(x, fs, { nperseg: 512, overlap: .5 });
        const sp = w.p ? C.specparam(w.f, w.p, { fmin: 2, fmax: Math.min(95, fs / 2 - 5) }) : null;
        limiarInfo = sp ? C.aperiodicBurstThreshold(sp, blo, bhi, { k: 2 }) : null;
        if (limiarInfo) opcoes = { threshold: limiarInfo.threshold, edgeFraction: borda, minDurationMs: 100 };
      }
      const bu = C.waveletBursts(env.env, fs, opcoes);
      if (!bu) return node.appendChild(el('div', { class: 'empty', text: 'Envelope curto demais para detectar bursts.' }));

      /* escalograma */
      const passo = Math.max(1, Math.floor(cwt.n / 900));
      const M = cwt.power.map(linha => {
        const out = [];
        for (let i = 0; i < cwt.n; i += passo) out.push(linha[i]);
        return out;
      });
      const planos = M.flat().filter(isFinite).sort((a, b) => a - b);
      const box = plotBox(node, 260);
      const durSec = cwt.n / fs;
      const ch = new P.Chart(box.canvas, {
        width: box.width, height: box.height, xlim: [0, durSec], ylim: [freqs[0], freqs[freqs.length - 1]],
        xlabel: 'tempo (s)', ylabel: 'frequência (Hz)',
        title: `(a) escalograma de Morlet — ${nCiclos} ciclos`, pad: { l: 70, r: 62, t: 24, b: 42 }
      });
      ch.heat(M, { cmap: 'viridis', zmin: planos[Math.floor(planos.length * .05)], zmax: planos[Math.floor(planos.length * .98)], smooth: true });
      ch.axes({ grid: false });
      ch.colorbar({ label: 'potência (µV²)' });

      /* envelope com bursts marcados */
      const b2 = plotBox(node, 220);
      const t2 = [], e2 = [];
      for (let i = 0; i < env.env.length; i += passo) { t2.push(i / fs); e2.push(env.env[i]); }
      const validos = e2.filter(isFinite);
      const ch2 = new P.Chart(b2.canvas, {
        width: b2.width, height: b2.height, xlim: [0, durSec],
        ylim: [0, Math.max.apply(null, validos) * 1.1],
        xlabel: 'tempo (s)', ylabel: `potência ${blo}–${bhi} Hz (µV²)`,
        title: `(b) envelope e ${bu.n} burst(s) — detecção no limiar, borda em ${f(100 * borda, 0)}% dele`,
        pad: { l: 74, r: 14, t: 24, b: 42 }
      });
      ch2.axes();
      bu.bursts.forEach(b => ch2.span(b.startIdx / fs, b.endIdx / fs, { color: COL.accent, alpha: .16 }));
      ch2.line(t2, e2, { color: hcol(td.hemisphere), width: 1 });
      ch2.hline(bu.threshold, { color: COL.right, dash: [4, 3], label: 'limiar' });
      ch2.hline(bu.edgeThreshold, { color: COL.warn, dash: [2, 3], label: 'borda' });
      ch2.legend({ x: ch2.x1 - 100, y: ch2.y1 + 6 });

      node.appendChild(table(['métrica', 'valor', 'parâmetro que a produziu'], [
        ['bursts detectados', String(bu.n), `limiar ${modoLimiar === 'aperiodico' ? 'pela linha de base 1/f' : 'no percentil ' + pct}`],
        ['taxa', `${f(bu.rateHz, 3)} /s`, `duração mínima ${bu.minDurationMs} ms`],
        ['duração média', `${f(bu.meanDurationMs, 1)} ms`, `borda em ${f(100 * borda, 0)}% do limiar`],
        ['duração mediana', `${f(bu.medianDurationMs, 1)} ms`, 'mediana é menos sensível a um burst muito longo'],
        ['ocupação', `${f(bu.occupancyPct, 1)} %`, 'fração do tempo válido dentro de burst'],
        ['tempo válido', `${f(bu.validSeconds, 1)} s`, `${bu.nNaN} amostras em lacuna ou no cone de influência`]
      ]));

      if (limiarInfo) node.appendChild(el('div', {
        class: limiarInfo.usable ? 'note' : 'warnbox',
        html: `<b>Limiar por linha de base 1/f.</b> ${limiarInfo.rationale}; potência de base ${f(limiarInfo.baselinePower, 4)} µV², ` +
          `R² do ajuste aperiódico ${f(limiarInfo.aperiodicR2, 3)}. ${limiarInfo.caveat}`
      }));

      const sens = C.burstDurationSensitivity(x, fs, [blo, bhi], [3, 5, 7, 10], opcoes);
      node.appendChild(el('h4', { class: 'qc-title', html: '<b>A duração é do cérebro ou do método?</b> — mesma série, quatro resoluções' }));
      node.appendChild(table(['ciclos da wavelet', 'duração média (ms)', 'taxa (/s)', 'ocupação (%)'],
        sens.rows.map(r => [String(r.nCycles), f(r.meanDurationMs, 1), f(r.rateHz, 3), f(r.occupancyPct, 1)])));
      node.appendChild(el('div', {
        class: sens.spreadRelative > 0.25 ? 'warnbox' : 'note',
        html: `<b>Dispersão relativa ${f(100 * sens.spreadRelative, 0)}%.</b> ${sens.verdict}.`
      }));

      node.appendChild(exportRow([
        { label: '⤓ PNG escalograma', fn: () => P.downloadCanvas(box.canvas, 'F20_escalograma') },
        { label: '⤓ PNG envelope', fn: () => P.downloadCanvas(b2.canvas, 'F20_envelope_bursts') },
        { label: '⤓ CSV bursts', fn: () => P.downloadText(P.toCSV(bu.bursts.map(b => ({
          inicio_s: b.startSec, duracao_ms: b.durationMs, pico: b.peak, pico_s: b.peakSec, area: b.area,
          limiar: bu.threshold, borda: bu.edgeThreshold, fracao_borda: borda, ciclos: nCiclos, banda: `${blo}-${bhi}`
        }))), 'F20_bursts_wavelet.csv', 'text/csv') }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Por que separar detecção de delimitação.</b> O limiar diz QUE existe um burst; a borda diz QUANTO ele dura. ` +
          `Se as duas forem o mesmo número, a duração medida vira função do limiar escolhido, e comparar estudos com limiares diferentes ` +
          `deixa de significar alguma coisa. Aqui a detecção usa o limiar e a delimitação desce a ${f(100 * borda, 0)}% dele. ` +
          `${recortado ? `<b>Recorte:</b> a wavelet roda nos primeiros 60 s do registro para manter a interface responsiva — as métricas acima referem-se a esse trecho. ` : ''}` +
          `A wavelet devolve <b>NaN dentro do cone de influência</b> (2σ em cada borda): são amostras desconhecidas, não zero.`
      }));
    }
  },

  /* ----------------------------------------------------------------- F21 */
  {
    id: 'F21', title: 'Acoplamento fase-amplitude (PAC) e comodulograma',
    sub: 'índice de Tort com surrogados · checagem obrigatória de forma de onda',
    has: d => d.bsTimeDomain.length || d.montageTD.length,
    render(node, d) {
      const tds = d.bsTimeDomain.concat(d.montageTD);
      const alvo = opt('F21', 'td', 0);
      const nSur = opt('F21', 'sur', 200);
      const pb = profileBands().primary || { lo: 13, hi: 30 };
      const flo = opt('F21', 'flo', pb.lo), fhi = opt('F21', 'fhi', Math.min(pb.hi, 30));
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('canal', tds.map((t, i) => ({ value: i, label: `${t.label} (${hname(t.hemisphere)})` })), alvo, v => setOpt('F21', 'td', +v)),
        ctrlNumber('fase de (Hz)', flo, 1, 40, 1, v => setOpt('F21', 'flo', v)),
        ctrlNumber('fase até (Hz)', fhi, 3, 50, 1, v => setOpt('F21', 'fhi', v)),
        ctrlNumber('surrogados', nSur, 50, 1000, 50, v => setOpt('F21', 'sur', v))
      ]));
      const td = tds[Math.min(alvo, tds.length - 1)];
      if (!td) return node.appendChild(el('div', { class: 'empty', text: 'Sem sinal bruto.' }));
      qualitySeal(node, td);
      const fs = td.fsEff || td.fs;
      if (fs / 2 < 60) return node.appendChild(el('div', {
        class: 'empty', html: `A frequência de amostragem deste canal (${f(fs, 1)} Hz) coloca o Nyquist em ${f(fs / 2, 1)} Hz. ` +
          `Não há banda de gama utilizável — PAC beta-gama não é mensurável com este dado, e nenhum número é apresentado.`
      }));
      const maxAmostras = Math.round(fs * 120);
      const recortado = td.data.length > maxAmostras;
      const x = recortado ? (td.data.subarray ? td.data.subarray(0, maxAmostras) : td.data.slice(0, maxAmostras)) : td.data;

      const nyq = fs / 2;
      const pac = C.pacTort(x, fs, { phaseBand: [flo, fhi], ampBand: [Math.min(50, nyq - 20), nyq - 2], nSurrogates: nSur });
      const wa = C.waveformAsymmetry(x, fs, flo, fhi);

      if (!pac || !isFinite(pac.mi)) return node.appendChild(el('div', {
        class: 'empty', text: pac ? (pac.reason || 'não foi possível estimar o PAC.') : 'trecho curto demais para PAC.'
      }));

      /* comodulograma */
      const com = C.comodulogram(x, fs, {
        phaseRange: [4, Math.min(40, nyq - 20)], phaseWidth: 4, phaseStep: 2,
        ampRange: [Math.min(30, nyq - 30), nyq - 2], ampStep: 10, nSurrogates: Math.min(50, nSur)
      });

      if (com) {
        const M = com.ampCenters.map((_, j) => com.phaseCenters.map((__, i) => {
          const c = com.grid.find(g => g.i === i && g.j === j);
          return c && isFinite(c.mi) ? c.mi : NaN;
        }));
        const box = plotBox(node, 280);
        const planos = M.flat().filter(isFinite).sort((a, b) => a - b);
        const ch = new P.Chart(box.canvas, {
          width: box.width, height: box.height,
          xlim: [com.phaseCenters[0], com.phaseCenters[com.phaseCenters.length - 1]],
          ylim: [com.ampCenters[0], com.ampCenters[com.ampCenters.length - 1]],
          xlabel: 'frequência da FASE (Hz)', ylabel: 'frequência da AMPLITUDE (Hz)',
          title: '(a) comodulograma — índice de modulação de Tort', pad: { l: 76, r: 62, t: 24, b: 42 }
        });
        ch.heat(M, { cmap: 'magma', zmin: 0, zmax: planos.length ? planos[Math.floor(planos.length * .99)] : 1, smooth: true });
        ch.axes({ grid: false });
        ch.colorbar({ label: 'MI' });
        node.appendChild(el('div', { class: 'note', html: `<b>Política de surrogados.</b> ${com.surrogatePolicy}.` }));
      }

      /* distribuição de amplitude por bin de fase */
      const b2 = plotBox(node, 230);
      const centros = pac.distribution.map((_, i) => -180 + (i + 0.5) * 360 / pac.distribution.length);
      const ch2 = new P.Chart(b2.canvas, {
        width: b2.width, height: b2.height, xlim: [-180, 180],
        ylim: [0, Math.max.apply(null, pac.distribution) * 1.25],
        xlabel: 'fase da banda lenta (graus)', ylabel: 'amplitude normalizada',
        title: `(b) amplitude por bin de fase — MI ${pac.mi.toExponential(2)}, z ${f(pac.z, 1)}`,
        pad: { l: 68, r: 14, t: 24, b: 42 }
      });
      ch2.axes();
      ch2.bars(centros, pac.distribution, { color: hcol(td.hemisphere), width: 340 / pac.distribution.length });
      ch2.hline(1 / pac.distribution.length, { color: COL.muted, dash: [4, 3], label: 'uniforme (sem acoplamento)' });
      ch2.legend({ x: ch2.x0 + 8, y: ch2.y1 + 6 });

      node.appendChild(table(['item', 'valor', 'interpretação'], [
        ['índice de modulação (MI)', pac.mi.toExponential(3), 'divergência da distribuição uniforme; não comparável entre registros de durações diferentes'],
        ['z contra surrogados', f(pac.z, 2), `${pac.nSurrogates} surrogados por deslocamento temporal, semente ${pac.seed}`],
        ['p empírico', { html: pHtml(pac.pEmpirical) }, pac.significant ? 'acoplamento acima do nulo' : 'não distinguível do acaso'],
        ['fase preferida', `${f(pac.preferredPhaseRad * 180 / Math.PI, 1)}°`, 'fase da banda lenta em que a amplitude rápida é máxima'],
        ['profundidade de modulação', `${f(pac.modulationDepthPct, 1)} %`, 'diferença entre o bin mais alto e o mais baixo, em relação ao uniforme'],
        ['banda de fase / amplitude', `${flo}–${fhi} Hz / ${f(pac.ampBand[0], 0)}–${f(pac.ampBand[1], 0)} Hz`, pac.ampBandWideEnough ? 'banda de amplitude larga o bastante para conter as bandas laterais' : 'banda de amplitude estreita demais'],
        wa ? ['forma de onda', `simetria pico-vale ${f(wa.peakTroughSymmetry, 3)} (0,5 = simétrico) · inclinação ${f(wa.steepnessRatio, 2)}`, wa.interpretation] : null
      ].filter(Boolean)));

      if (wa && wa.nonSinusoidal) node.appendChild(el('div', {
        class: 'warnbox', html: `<b>A onda é não senoidal nesta banda</b> (simetria pico-vale ${f(wa.peakTroughSymmetry, 3)}; 0,5 seria simetria perfeita). ${wa.interpretation}. ` +
          `Parte do MI acima pode ser harmônico da própria banda de fase — não interprete como interação entre redes sem outra evidência.`
      }));
      if (pac.warning) node.appendChild(el('div', { class: 'warnbox', html: `<b>Atenção.</b> ${pac.warning}.` }));

      node.appendChild(exportRow([
        { label: '⤓ PNG distribuição', fn: () => P.downloadCanvas(b2.canvas, 'F21_pac_distribuicao') },
        { label: '⤓ CSV comodulograma', fn: () => P.downloadText(P.toCSV((com ? com.grid : []).map(c => ({
          fase_hz: c.phaseHz, amplitude_hz: c.ampHz, mi: c.mi, z: c.z, p: c.p
        }))), 'F21_comodulograma.csv', 'text/csv') }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Por que o cuidado aqui é maior.</b> PAC é fácil de produzir por artefato: uma forma de onda não senoidal gera ` +
          `harmônicos que se acoplam à própria fundamental, sem nenhuma interação entre redes distintas (Cole &amp; Voytek 2017). ` +
          `Por isso o MI cru nunca aparece sozinho — vem sempre com z contra surrogados e com a medida de assimetria da onda. ` +
          `${recortado ? '<b>Recorte:</b> o cálculo usa os primeiros 120 s do registro. ' : ''}` +
          `<b>Leitura clínica:</b> PAC beta-gama no STN está elevado no estado OFF e cai com levodopa e com DBS eficaz; ` +
          `é medida de interação entre ritmos, complementar — não substituta — da potência beta.`
      }));
    }
  },

  /* ----------------------------------------------------------------- F22 */
  {
    id: 'F22', title: 'Gama finamente sintonizada vs. gama entrained em f_stim/2',
    sub: 'dois fenômenos na mesma faixa com leituras clínicas opostas',
    has: d => d.sensingSetup.some(s => s.psd) || d.signalCheck.length || d.montage.length || d.bsTimeDomain.length,
    render(node, d) {
      const src = [];
      d.sensingSetup.forEach((s, i) => s.psd && src.push({ value: 'ss' + i, label: `SignalTest ${s.channel}`, f: s.psd.f, p: s.psd.p, hemi: s.hemisphere, parsed: null }));
      d.signalCheck.forEach((s, i) => src.push({ value: 'sc' + i, label: `SignalCheck ${C.prettyChannel(s.channel)}`, f: s.f, p: s.p, hemi: /LEFT/i.test(s.channel) ? 'Left' : 'Right' }));
      d.montage.forEach((m, i) => src.push({ value: 'mo' + i, label: `Survey ${m.hemisphere[0]} · ${m.label}`, f: m.f, p: m.mag, hemi: m.hemisphere }));
      d.bsTimeDomain.forEach((t, i) => {
        const w = C.welchPSD(t.data, t.fsEff || t.fs, { nperseg: 1024, overlap: .5 });
        if (w.p) src.push({ value: 'td' + i, label: `Streaming ${t.label} (Welch)`, f: Array.from(w.f), p: Array.from(w.p), hemi: t.hemisphere, td: t });
      });
      if (!src.length) return node.appendChild(el('div', { class: 'empty', text: 'Nenhum espectro disponível.' }));
      const cur = src.find(s => s.value === opt('F22', 'src', src[src.length - 1].value)) || src[src.length - 1];

      /* frequência de estimulação: do arquivo quando existir, senão do usuário */
      const est = C.inferDeviceState(cur.td || null, (activeFiles()[0] || {}).parsed, { modality: cur.td ? 'streaming' : 'survey' });
      const fstimArquivo = isFinite(est.rateHz) && est.rateHz > 0 ? est.rateHz : NaN;
      const fstim = opt('F22', 'fstim', isFinite(fstimArquivo) ? fstimArquivo : 0);
      const tol = opt('F22', 'tol', 2.5);
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('fonte', src, cur.value, v => setOpt('F22', 'src', v)),
        ctrlNumber('f_stim (Hz; 0 = desconhecida)', fstim, 0, 250, 5, v => setOpt('F22', 'fstim', v)),
        ctrlNumber('tolerância (Hz)', tol, 0.5, 8, 0.5, v => setOpt('F22', 'tol', v))
      ]));
      const fmaxDisp = cur.f[cur.f.length - 1];
      if (fmaxDisp < 55) return node.appendChild(el('div', {
        class: 'empty', html: `Este espectro vai só até ${f(fmaxDisp, 1)} Hz. A faixa de gama (55–95 Hz) não está no dado — ` +
          `nenhuma conclusão sobre gama é possível aqui.`
      }));
      const g = C.detectGamma(cur.f, cur.p, { stimRateHz: fstim > 0 ? fstim : NaN, tolHz: tol, lo: 40, hi: Math.min(100, fmaxDisp) });

      const box = plotBox(node, 280);
      const idx = []; for (let i = 0; i < cur.f.length; i++) if (cur.f[i] >= 30 && cur.f[i] <= Math.min(110, fmaxDisp)) idx.push(i);
      const ys = idx.map(i => cur.p[i]);
      const ch = new P.Chart(box.canvas, {
        width: box.width, height: box.height, xlim: [30, Math.min(110, fmaxDisp)],
        ylim: [0, Math.max.apply(null, ys) * 1.2],
        xlabel: 'frequência (Hz)', ylabel: 'potência', title: 'faixa de gama — picos e f_stim/2',
        pad: { l: 68, r: 14, t: 24, b: 42 }
      });
      ch.axes();
      ch.span(55, 95, { color: COL.ok, alpha: .07, label: 'faixa da FTG' });
      ch.line(idx.map(i => cur.f[i]), ys, { color: hcol(cur.hemi), width: 1.6 });
      if (fstim > 0) {
        ch.vline(fstim / 2, { color: COL.right, width: 1.6, dash: [5, 3], label: `f_stim/2 = ${f(fstim / 2, 1)} Hz` });
        ch.span(fstim / 2 - tol, fstim / 2 + tol, { color: COL.right, alpha: .08 });
      }
      (g.peaks || []).forEach(pk => ch.marker(pk.hz, cur.p[cur.f.findIndex(v => Math.abs(v - pk.hz) < 1e-6)] || 0, { color: COL.accent, r: 3 }));
      ch.legend({ x: ch.x0 + 8, y: ch.y1 + 6 });

      node.appendChild(table(['pico (Hz)', 'proeminência sobre o aperiódico', 'largura (Hz)', 'Q', 'classificação'],
        (g.peaks || []).length ? g.peaks.map(pk => [
          f(pk.hz, 2), f(pk.prominenceOverAperiodic, 2), f(pk.bandwidthHz, 2), f(pk.q, 1),
          g.entrained && Math.abs(pk.hz - g.entrained.hz) < 1e-6 ? 'entrained (f_stim/2)'
            : g.ftg && Math.abs(pk.hz - g.ftg.hz) < 1e-6 ? 'finamente sintonizada' : '—'
        ]) : [['—', '—', '—', '—', 'nenhum pico destacado do fundo aperiódico']]));

      node.appendChild(el('div', {
        class: g.verdict === 'indistinguível sem a frequência de estimulação' ? 'warnbox' : 'note',
        html: `<b>Veredito: ${g.verdict}.</b> ` +
          (g.reason ? g.reason + '. ' : '') +
          (g.clinicalNote ? g.clinicalNote + '. ' : '') +
          (fstim > 0 ? `f_stim usada: ${f(fstim, 1)} Hz${isFinite(fstimArquivo) ? ' (lida do arquivo)' : ' (informada manualmente)'}; subarmônico em ${f(fstim / 2, 1)} Hz, tolerância ±${f(tol, 1)} Hz.`
            : 'Sem a frequência de estimulação, um pico em 65 Hz pode ser gama endógena ou engate 1:2 com estimulação a 130 Hz — ' +
              'as duas leituras clínicas são opostas, e por isso nenhuma é afirmada.')
      }));

      node.appendChild(el('div', {
        class: 'note', html: `<b>Como confirmar de vez.</b> Registre o mesmo canal com <b>duas frequências de estimulação diferentes</b>. ` +
          `Se o pico acompanhar f_stim/2, é entrained; se ficar parado, é endógeno. Sem essa manobra, a classificação acima é uma ` +
          `inferência aritmética, não uma demonstração. ` +
          `<b>Por que importa:</b> a gama finamente sintonizada acompanha o estado ON de levodopa e discinesia (marcador pró-cinético); ` +
          `a gama entrained é resposta da rede à própria estimulação e não deve ser lida como marcador de estado motor.`
      }));

      node.appendChild(exportRow([
        { label: '⤓ PNG', fn: () => P.downloadCanvas(box.canvas, 'F22_gama') },
        { label: '⤓ CSV picos', fn: () => P.downloadText(P.toCSV((g.peaks || []).map(pk => ({
          fonte: cur.label, hz: pk.hz, proeminencia: pk.prominenceOverAperiodic, largura_hz: pk.bandwidthHz, q: pk.q,
          f_stim: fstim || '', subarmonico: fstim ? fstim / 2 : '', veredito: g.verdict
        }))), 'F22_gama.csv', 'text/csv') }
      ]));
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
        el('button', { class: 'x', title: 'remover', text: '×', onclick: () => { S.files.splice(i, 1); invalidarDs(); renderAll('Removendo arquivo'); } })
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
    })), act.key, v => { S.subject = v; S.opts = {}; renderAll('Trocando de registro'); }));
    br.appendChild(el('div', {
      class: 'warnbox', html: 'Os arquivos carregados pertencem a <b>pessoas diferentes</b>. ' +
        'Apenas o registro selecionado é analisado — séries de registros distintos nunca são agregadas.'
    }));
    cr.appendChild(br); rail.appendChild(cr);
  }

  /* matriz de disponibilidade — detalhe de pesquisa; no modo clínico o que
     interessa é o semáforo de qualidade, não a contagem por modalidade */
  if (S.files.length && !ehClinico()) {
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
  }

  if (S.files.length) {
    /* semáforo de qualidade (modo clínico) — versão de uma linha do painel F17 */
    if (ehClinico()) {
      const cq = el('div', { class: 'card' }, [el('h3', {}, ['Qualidade do sinal'])]);
      const bq = el('div', { class: 'body', id: 'semaforoBody' });
      bq.appendChild(el('div', { class: 'note', text: 'calculando…' }));
      cq.appendChild(bq); rail.appendChild(cq);
    }

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
    add('perfil de doença', activeProfile().label);
  add('fuso aplicado', `UTC${offMin() >= 0 ? '+' : '−'}${String(Math.floor(Math.abs(offMin()) / 60)).padStart(2, '0')}:${String(Math.abs(offMin()) % 60).padStart(2, '0')}`);
    bs.appendChild(kv); cs.appendChild(bs); rail.appendChild(cs);

    /* perfil de doença (Onda 5) */
    const sugerido = C.suggestProfile(p0);
    const perfil = activeProfile();
    const cp = el('div', { class: 'card' }, [el('h3', {}, ['Perfil de doença'])]);
    const bp2 = el('div', { class: 'body' });
    bp2.appendChild(ctrlSelect('', C.PROFILE_IDS.map(id => ({ value: id, label: C.PROFILES[id].label })),
      perfil.id, v => { S.profile = v; S.opts = {}; renderAll('Aplicando perfil de doença'); }));
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
    if (ehClinico()) {
      /* um botão. O relatório já leva a capa com as leituras, as figuras e as
         ressalvas — é o que sai da consulta. */
      const grid1 = el('div', { class: 'exportgrid' });
      grid1.appendChild(el('div', { class: 'exportitem' }, [
        el('button', { class: 'btn primary', text: '⤓ Relatório clínico (PDF)', onclick: generateReport }),
        el('span', { class: 'exphint', text: 'capa com as leituras em linguagem simples, as seis figuras e as ressalvas de cada número' })
      ]));
      be.appendChild(grid1);
      be.appendChild(el('div', {
        class: 'note', style: 'margin-top:9px',
        html: 'CSV, JSON para estatística, PNG individuais, checklist PERCEPT-REPORT e manifesto de ' +
          'proveniência estão no <b>modo pesquisa</b>.'
      }));
      ce.appendChild(be); rail.appendChild(ce);
      return;
    }
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

    /* pipelines de um clique */
    const cpl = el('div', { class: 'card' }, [el('h3', {}, ['Pipelines de um clique'])]);
    const bpl = el('div', { class: 'body' });
    const pipes = el('div', { class: 'pipes' });
    PIPELINES.forEach(pl => pipes.appendChild(el('div', { class: 'pipe' }, [
      el('button', { class: 'btn', text: '▶ ' + pl.label, onclick: () => rodarPipeline(pl) }),
      el('span', { text: pl.desc })
    ])));
    bpl.appendChild(pipes);
    bpl.appendChild(el('div', {
      class: 'note', style: 'margin-top:9px',
      html: 'Cada pipeline abre as figuras da pergunta, calcula e entrega o arquivo correspondente. ' +
        'Nada é decidido por você: os parâmetros continuam os das figuras, e ficam declarados na exportação.'
    }));
    cpl.appendChild(bpl); rail.appendChild(cpl);
  }
}

/* ------------------------------------------------ pipelines de um clique */
/* Sequências prontas para as três perguntas mais frequentes. Existem porque a
   ordem certa de olhar as figuras é conhecimento embutido — e porque, com o
   painel de processo, uma sequência longa passou a ser legível. */
const PIPELINES = [
  {
    id: 'adbs', label: 'Triagem de elegibilidade a aDBS',
    desc: 'abre F23 (elegibilidade e simulador), F16 (reprodutibilidade do pico) e F17 (QC), e exporta o CSV crônico',
    figs: ['F23', 'F16', 'F17'], exportar: () => exportChronicCSV()
  },
  {
    id: 'circadiano', label: 'Perfil circadiano completo',
    desc: 'abre F8, F9, F11 e F12, e exporta o CSV de métricas crônicas',
    figs: ['F8', 'F9', 'F11', 'F12'], exportar: () => exportChronicCSV()
  },
  {
    id: 'qualidade', label: 'Auditoria de qualidade do sinal',
    desc: 'abre F15, F16 e F17, e exporta o manifesto de proveniência com o hash citável',
    figs: ['F15', 'F16', 'F17'], exportar: () => exportManifest()
  }
];

async function rodarPipeline(pl) {
  if (!S.files.length) return alert('Carregue ao menos um arquivo antes de rodar um pipeline.');
  const d = ds();
  const alvos = pl.figs.map(id => FIGURES.find(f => f.id === id)).filter(f => f && f.has(d));
  const ausentes = pl.figs.filter(id => !alvos.some(f => f.id === id));
  Prog.begin('Pipeline — ' + pl.label).expect(alvos.length + 1);
  try {
    for (const fig of alvos) {
      const det = document.getElementById('fig-' + fig.id);
      if (det) det.open = true;
      if (_renderizadas.has(fig.id)) { await Prog.step(`figura ${fig.id} — já calculada`); continue; }
      await Prog.step(`figura ${fig.id} — ${fig.title}`);
      renderFigure(fig.id);
    }
    await Prog.step('gerando o arquivo de saída');
    await Prog.finish(ausentes.length
      ? `pipeline concluído — sem dados para ${ausentes.join(', ')}`
      : 'pipeline concluído');
    if (alvos.length) {
      const primeiro = document.getElementById('fig-' + alvos[0].id);
      if (primeiro && primeiro.scrollIntoView) primeiro.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    await pl.exportar();
  } catch (e) { Prog.fail(e); }
}

/* Preenche o semáforo de qualidade do modo clínico. Roda depois das figuras,
   porque o painel de QC é caro — e por isso também é uma etapa anunciada. */
function preencherSemaforo() {
  const alvo = document.getElementById('semaforoBody');
  if (!alvo || !S.files.length) return null;
  const r = leiturasClinicas();
  alvo.innerHTML = '';
  if (!r) { alvo.appendChild(el('div', { class: 'note', text: 'sem métricas para avaliar.' })); return null; }
  const sf = r.semaforo;
  const bloco = el('div', { class: 'semaforo ' + sf.cor }, [
    el('i', {}),
    el('div', {}, [el('b', { text: sf.rotulo }), el('span', { text: sf.frase })])
  ]);
  if (sf.bloqueios.length) {
    const ul = el('ul', {});
    sf.bloqueios.forEach(x => ul.appendChild(el('li', { text: x })));
    bloco.lastChild.appendChild(ul);
  }
  alvo.appendChild(bloco);
  alvo.appendChild(el('div', {
    class: 'note', style: 'margin-top:9px',
    html: 'O item a item de cada verificação está no <b>painel F17</b>, no modo pesquisa.'
  }));
  return r;
}

/* Figuras abertas automaticamente ao carregar. São as de leitura imediata; as
   demais só calculam quando o usuário as abre, e aí com aviso de "calculando".
   Manter esta lista curta é o que define quanto tempo passa entre soltar o
   arquivo e ver o primeiro gráfico. */
const AUTO_ABRIR = ['F1', 'F8', 'F9'];
const _renderizadas = new Set();

/* Conjunto de figuras visível no modo corrente. No modo clínico vem do perfil
   de doença (declarativo, em profiles/index.js); no modo pesquisa, tudo. */
function figurasVisiveis() {
  if (!ehClinico()) return FIGURES;
  const ids = activeProfile().clinicalFigures || AUTO_ABRIR;
  return FIGURES.filter(f => ids.includes(f.id));
}

async function renderFigures() {
  const main = $('#figs'); main.innerHTML = '';
  _renderizadas.clear();
  if (primeiraVisita()) main.appendChild(cartaoPrimeirosPassos());
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
  const visiveis = figurasVisiveis();
  const abrir = [];
  visiveis.forEach(fig => {
    const ok = !!fig.has(d);
    const det = el('details', { class: 'fig ' + (ok ? 'ready' : 'na'), id: 'fig-' + fig.id });
    /* no modo clínico as seis figuras já vêm abertas: são poucas e é o que a
       pessoa veio ver. No modo pesquisa só as três de leitura imediata. */
    if (ok && (ehClinico() || AUTO_ABRIR.includes(fig.id))) abrir.push(fig);
    det.appendChild(el('summary', {}, [el('header', {}, [
      el('span', { class: 'chev', text: '▸' }),
      el('span', { class: 'id', text: fig.id }),
      el('span', { class: 'ttl' }, [el('b', { text: fig.title }), el('span', { text: fig.sub })]),
      el('span', { class: 'state', text: ok ? 'dados presentes' : 'sem dados' })
    ])]));
    det.appendChild(el('div', { class: 'content', id: 'content-' + fig.id }));
    /* cálculo sob demanda: abrir uma figura pesada mostra o aviso antes de
       travar a thread, e cada figura só é calculada uma vez */
    det.addEventListener('toggle', () => {
      if (det.open && !_renderizadas.has(fig.id)) renderFigureAsync(fig.id);
    });
    main.appendChild(det);
  });
  /* a lista inteira aparece primeiro; só então começam os cálculos */
  await proximoQuadro();
  if (Prog.ativo) Prog.expect(abrir.length);
  /* `open` só é ligado no momento de calcular: o evento `toggle` que ele dispara
     chega depois, encontra a figura já em `_renderizadas` e não refaz o trabalho */
  for (const fig of abrir) {
    if (Prog.ativo) await Prog.step(`figura ${fig.id} — ${fig.title}`);
    else await proximoQuadro();
    const det = document.getElementById('fig-' + fig.id);
    if (det) det.open = true;
    renderFigure(fig.id);
  }
  /* leituras e semáforo são caros (métricas + painel de QC) e por isso vêm
     depois das figuras, como etapa própria e anunciada */
  if (ehClinico() && S.files.length) {
    if (Prog.ativo) await Prog.step('leituras em linguagem clínica e semáforo de qualidade');
    else await proximoQuadro();
    try {
      preencherSemaforo();
      abrir.forEach(fig => inserirLeituras(fig.id));
    } catch (e) { Prog.falhaEtapa(String(e && e.message || e)); }
  }
}

/* Insere, no topo da figura, as leituras em linguagem simples que pertencem a
   ela. O texto vem do núcleo (report/reading.js): a interface não interpreta
   nada por conta própria. */
function inserirLeituras(id) {
  const node = document.getElementById('content-' + id);
  if (!node) return;
  const r = leiturasClinicas();
  if (!r) return;
  const minhas = r.readings.filter(l => l.figura === id);
  if (!minhas.length) return;
  const caixa = el('div', {});
  minhas.forEach(l => caixa.appendChild(caixaLeitura(l)));
  if (node.firstChild) node.insertBefore(caixa, node.firstChild);
  else node.appendChild(caixa);
}

function caixaLeitura(l) {
  const n = el('div', { class: 'leitura ' + l.nivel }, [
    el('h4', { text: l.titulo }),
    el('p', { text: l.frase })
  ]);
  if (l.numeros) n.appendChild(el('span', { class: 'num', text: l.numeros }));
  if (l.parametro) n.appendChild(el('span', { class: 'par', text: 'parâmetros usados: ' + l.parametro }));
  if (l.ressalva) n.appendChild(el('p', { class: 'res', html: '<b>Ressalva.</b> ' + l.ressalva }));
  return n;
}

/* ------------------------------------------------------- primeiros passos */
function primeiraVisita() { return !lerPrefs().tutorialVisto; }
function cartaoPrimeirosPassos() {
  const c = el('div', { class: 'onboard', id: 'onboard' }, [
    el('h3', { text: 'Primeiros passos' }),
    el('ol', {}, [
      el('li', { html: 'Baixe do programador Percept o <b>Session Report em JSON</b> — não o PDF — e solte o arquivo aqui. Pode soltar vários da mesma pessoa de uma vez.' }),
      el('li', { html: 'No <b>modo clínico</b> (atual) aparecem seis figuras com a leitura em linguagem simples no topo de cada uma, um semáforo de qualidade do sinal e um botão de relatório.' }),
      el('li', { html: 'No <b>modo pesquisa</b> aparecem todas as figuras, todos os controles de parâmetro, as exportações em CSV/JSON/PNG, o checklist PERCEPT-REPORT e o manifesto de proveniência.' }),
      el('li', { html: 'Cada número vem com o <b>parâmetro que o produziu</b> e a <b>ressalva</b> que ele exige. Quando o dado não sustenta uma conclusão, o texto diz isso em vez de inventar um valor.' })
    ]),
    el('p', { html: 'Nenhum dado sai deste dispositivo: leitura, cálculo e figuras acontecem no navegador. ' +
      'Nome, data de nascimento e número de série nunca passam do leitor de arquivo. ' +
      'Ferramenta de pesquisa e apoio à decisão — não substitui o julgamento clínico nem o software regulado do fabricante.' })
  ]);
  c.appendChild(el('button', {
    class: 'btn primary', text: 'entendi',
    onclick: () => { salvarPref('tutorialVisto', true); const o = document.getElementById('onboard'); if (o && o.remove) o.remove(); }
  }));
  return c;
}

function renderFigure(id) {
  const fig = FIGURES.find(x => x.id === id);
  const node = document.getElementById('content-' + id);
  if (!fig || !node) return;
  node.innerHTML = '';
  _renderizadas.add(id);
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
  /* redesenhar a figura (troca de parâmetro, redimensionamento) não pode perder
     a leitura clínica. Só reinsere se as leituras JÁ estiverem calculadas — o
     primeiro cálculo é uma etapa anunciada, não um efeito colateral daqui. */
  if (ehClinico() && leiturasProntas()) inserirLeituras(id);
}
function leiturasProntas() { return !!(_leiturasCache && _leiturasChave === chaveAnalise()); }

/* Mesma coisa, mas anunciando o cálculo antes de bloquear a thread. */
async function renderFigureAsync(id) {
  const fig = FIGURES.find(x => x.id === id);
  const node = document.getElementById('content-' + id);
  if (!fig || !node) return;
  _renderizadas.add(id);
  node.innerHTML = '';
  node.appendChild(el('div', {
    class: 'calc', html: `calculando <b>${fig.id} — ${fig.title}</b>…<br>` +
      `<b>o navegador não travou:</b> o cálculo acontece aqui mesmo e pode levar alguns segundos em registros longos`
  }));
  const t0 = Date.now();
  await proximoQuadro();
  renderFigure(id);
  const dt = Date.now() - t0;
  if (dt >= 1500) node.appendChild(el('div', {
    class: 'note', style: 'margin-top:10px',
    html: `Esta figura levou <b>${msTexto(dt)}</b> para ser calculada neste registro.`
  }));
}

async function renderAll(titulo) {
  const proprio = !Prog.ativo && S.files.length > 0;
  if (proprio) Prog.begin(titulo || 'Recalculando figuras').expect(1);
  try {
    if (proprio) await Prog.step('montando painel do registro');
    renderRail();
    await renderFigures();
    if (proprio) await Prog.finish('figuras prontas');
  } catch (e) {
    if (proprio) Prog.fail(e);
    throw e;
  }
}

/* ---------------------------------------------------------- carregamento */
function lerTexto(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('falha de leitura do arquivo'));
    r.readAsText(file);
  });
}

async function handleFiles(fileList) {
  const files = Array.from(fileList).filter(f => /\.json$/i.test(f.name));
  if (!files.length) return;
  const mb = t => isFinite(t) ? ` (${(t / 1048576).toFixed(1)} MB)` : '';
  /* 2 etapas por arquivo (ler do disco, interpretar) + agregação + painel;
     as figuras acrescentam suas próprias etapas quando souberem quantas são */
  Prog.begin(`Carregando ${files.length} arquivo${files.length > 1 ? 's' : ''}`).expect(files.length * 2 + 2);
  try {
    for (const file of files) {
      await Prog.step(`lendo ${file.name}${mb(file.size)}`);
      let texto;
      try { texto = await lerTexto(file); }
      catch (e) { Prog.falhaEtapa(e.message); continue; }
      await Prog.step(`interpretando ${file.name} — JSON e modalidades do Percept`);
      try {
        const parsed = C.parsePercept(JSON.parse(texto), file.name);
        const dup = S.files.findIndex(x => x.name === file.name);
        if (dup >= 0) S.files.splice(dup, 1);
        S.files.push({ name: file.name, parsed });
      } catch (e) {
        Prog.falhaEtapa(e.message);
        alert(`Não foi possível ler "${file.name}". O arquivo precisa ser um Session Report JSON válido do Percept.\n\n${e.message}`);
      }
    }
    S.files.sort((a, b) => a.name.localeCompare(b.name));
    invalidarDs();
    await Prog.step('agregando séries do registro (concatenação e desduplicação)');
    const d = ds();
    const nTrend = Object.keys(d.trend).reduce((a, h) => a + d.trend[h].length, 0);
    const nBruto = d.bsTimeDomain.concat(d.montageTD).reduce((a, td) => a + (td.data ? td.data.length : 0), 0);
    const rod = document.getElementById('procFoot');
    if (rod) rod.innerHTML = `Registro com <b>${nTrend.toLocaleString('pt-BR')}</b> pontos de Timeline e ` +
      `<b>${nBruto.toLocaleString('pt-BR')}</b> amostras de sinal bruto. Todo o cálculo acontece neste navegador — ` +
      `etapas anunciadas acima estão <b>calculando</b>, não travadas.`;
    await Prog.step('montando painel do registro');
    renderRail();
    await renderFigures();
    await Prog.finish('pronto');
  } catch (e) {
    Prog.fail(e);
    throw e;
  }
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
/* extractMetrics custa mais de um segundo em registros longos e é chamado por
   toda exportação, pelo relatório e pelas leituras clínicas. Memoizado pela
   mesma chave do agregado, mais o que muda o resultado: perfil e fuso. */
let _bundleCache = null, _bundleChave = null;
function chaveAnalise() {
  return _dsVersao + '|' + S.files.map(x => x.name).join('~') + '|' + (S.subject || '') +
    '|' + activeProfileId() + '|' + offMin();
}
function exportBundle() {
  const ps = activeFiles().map(x => x.parsed);
  if (!ps.length) return null;
  const chave = chaveAnalise();
  if (_bundleCache && _bundleChave === chave) return _bundleCache;
  _bundleCache = C.extractMetrics(ps, offMin(), { profileId: activeProfileId() });
  _bundleChave = chave;
  return _bundleCache;
}

/* Leituras em linguagem clínica + semáforo de QC. Também memoizadas: o painel
   de QC roda detecção de picos R e validação de artefato, e não pode ser
   refeito a cada figura. */
let _leiturasCache = null, _leiturasChave = null;
function leiturasClinicas() {
  const ps = activeFiles().map(x => x.parsed);
  if (!ps.length) return null;
  const chave = chaveAnalise();
  if (_leiturasCache && _leiturasChave === chave) return _leiturasCache;
  const b = exportBundle();
  const pb = activeProfile().primaryBand;
  let painel = null;
  try { painel = C.qcPanel(ps, { band: [pb.lo, pb.hi] }); } catch (e) { painel = null; }
  _leiturasCache = C.clinicalReadings(b, { profileId: activeProfileId(), qcPanel: painel });
  _leiturasChave = chave;
  return _leiturasCache;
}
function unionKeys(rows) {
  const seen = new Set(), out = [];
  rows.forEach(r => Object.keys(r).forEach(k => { if (!seen.has(k)) { seen.add(k); out.push(k); } }));
  return out;
}
async function exportJSON() {
  if (!S.files.length) return alert('Carregue ao menos um arquivo antes de exportar.');
  const b = await comEtapa('Exportando JSON', 'calculando métricas de todas as sessões', exportBundle);
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
async function exportAcuteCSV() {
  if (!S.files.length) return alert('Carregue ao menos um arquivo antes de exportar.');
  const b = await comEtapa('Exportando CSV de métricas agudas', 'calculando espectro, aperiódico e bursts por sessão', exportBundle);
  if (!b) return alert('Carregue ao menos um arquivo antes de exportar.');
  if (!b.acute.length) return alert('Nenhuma métrica aguda (espectro ou sinal bruto) nos arquivos carregados.');
  P.downloadText(P.toCSV(b.acute, unionKeys(b.acute)), `percept_${b.subject.id}_metricas_agudas.csv`, 'text/csv');
}
async function exportChronicCSV() {
  if (!S.files.length) return alert('Carregue ao menos um arquivo antes de exportar.');
  const b = await comEtapa('Exportando CSV de métricas crônicas', 'ajustando cosinor e limiares sobre o Timeline', exportBundle);
  if (!b) return alert('Carregue ao menos um arquivo antes de exportar.');
  if (!b.chronic.length) return alert('Nenhum dado de Timeline (crônico) nos arquivos carregados.');
  P.downloadText(P.toCSV(b.chronic, unionKeys(b.chronic)), `percept_${b.subject.id}_metricas_cronicas.csv`, 'text/csv');
}

/* Abre e renderiza TODAS as figuras com dados (usado por relatório e PNG).
   É a operação mais cara do aplicativo — em registros de meses passa de dez
   segundos — e por isso é a que mais precisa anunciar cada etapa. Figuras já
   calculadas não são refeitas. */
async function renderAllReady(titulo) {
  const d = ds();
  const pendentes = figurasVisiveis().filter(fig => fig.has(d));
  const proprio = !Prog.ativo;
  if (proprio) Prog.begin(titulo || 'Preparando todas as figuras');
  Prog.expect(pendentes.length);
  try {
    for (const fig of pendentes) {
      const det = document.getElementById('fig-' + fig.id);
      if (!det) continue;
      det.open = true;
      if (_renderizadas.has(fig.id)) { await Prog.step(`figura ${fig.id} — já calculada`); continue; }
      await Prog.step(`figura ${fig.id} — ${fig.title}`);
      renderFigure(fig.id);
    }
    if (proprio) await Prog.finish('todas as figuras prontas');
  } catch (e) {
    if (proprio) Prog.fail(e);
    throw e;
  }
}
async function downloadAllFigures() {
  if (!S.files.length) return alert('Carregue ao menos um arquivo antes de exportar.');
  await renderAllReady('Exportando todas as figuras (PNG)');
  setTimeout(() => {
    const d = ds(), jobs = [];
    figurasVisiveis().forEach(fig => {
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
  Prog.begin('Gerando checklist PERCEPT-REPORT').expect(3);
  await Prog.step('reunindo a proveniência da análise');
  const prov = await buildProvenance();
  await Prog.step('calculando as métricas do registro');
  const b = exportBundle();
  await Prog.step('preenchendo os itens do checklist');
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
  await Prog.finish('checklist gerado');
  return ck;
}

async function exportManifest() {
  if (!S.files.length) return alert('Carregue ao menos um arquivo antes de exportar o manifesto.');
  Prog.begin('Exportando manifesto de proveniência').expect(2);
  await Prog.step('reunindo parâmetros efetivos de cada etapa');
  const prov = await buildProvenance();
  const m = prov.manifest();
  await Prog.step('calculando o hash citável da análise (SHA-256)');
  m.manifestHash = await prov.hash();
  await Prog.finish('manifesto pronto');
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
  /* Leituras em linguagem clínica — o que o médico lê primeiro. Vêm do núcleo
     (report/reading.js), com o parâmetro usado e a ressalva de cada número. */
  const lc = leiturasProntas() ? _leiturasCache : null;
  if (lc) {
    wrap.appendChild(el('h3', { class: 'rc-h', text: 'Leitura em linguagem clínica' }));
    const sf = lc.semaforo;
    wrap.appendChild(el('div', { class: 'semaforo ' + sf.cor, style: 'margin:0 0 12px' }, [
      el('i', {}), el('div', {}, [el('b', { text: 'Qualidade do sinal — ' + sf.rotulo }), el('span', { text: sf.frase })])
    ]));
    lc.readings.forEach(l => wrap.appendChild(caixaLeitura(l)));
    wrap.appendChild(el('div', { class: 'note rc-note', text: lc.disclaimer }));
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
async function generateReport() {
  if (!S.files.length) return alert('Carregue ao menos um Session Report antes de gerar o relatório.');
  Prog.begin('Gerando relatório PDF');
  await renderAllReady();
  Prog.expect(3);
  await Prog.step('calculando o resumo de métricas da capa');
  const bundle = exportBundle();
  await Prog.step('escrevendo as leituras em linguagem clínica');
  try { leiturasClinicas(); } catch (e) { Prog.falhaEtapa(String(e && e.message || e)); }
  await Prog.step('montando a capa e abrindo a caixa de impressão');
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
  await Prog.finish('relatório pronto para impressão');
  setTimeout(() => window.print(), 500);
}

function init() {
  const prefs = lerPrefs();
  if (prefs.modo === 'clinico' || prefs.modo === 'pesquisa') S.mode = prefs.modo;
  marcarModo();
  $('#fileInput').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });
  $('#btnExport').addEventListener('click', exportSession);
  $('#btnPrint').addEventListener('click', generateReport);
  $('#tz').addEventListener('change', e => {
    S.tzOverride = e.target.value === 'auto' ? null : parseInt(e.target.value, 10);
    renderAll('Aplicando fuso horário');
  });
  const px = document.getElementById('procX');
  if (px) px.addEventListener('click', () => { const p = document.getElementById('proc'); if (p) p.hidden = true; });
  ['clinico', 'pesquisa'].forEach(m => {
    const b = document.getElementById('modo' + m[0].toUpperCase() + m.slice(1));
    if (b) b.addEventListener('click', () => setModo(m));
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
window.__PLS__ = { FIGURES, ds, invalidarDs, S, renderRail, renderFigure, renderFigureAsync, renderAllReady, handleFiles, offMin, exportBundle, buildReportCover, Prog, proximoQuadro, setModo, modoAtual, figurasVisiveis, leiturasClinicas, PIPELINES, rodarPipeline, preencherSemaforo, inserirLeituras };
})();
