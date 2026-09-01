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

/* rotuloLado(h) — o rótulo anatômico HONESTO do hemisfério: "STN esquerdo"
   só quando o LeadLocation do arquivo diz STN. Eletrodo no GPi vira "GPi
   esquerdo"; no Vim, "Vim esquerdo"; alvo não declarado vira "hemisfério
   esquerdo" — porque escrever STN sem o arquivo dizer isso é inventar
   anatomia, e esse rótulo acaba em relatório e em figura de artigo. */
/* avisoDeAlvo(node, metodo) — quando o método da figura foi derivado em
   coortes de STN e nenhum eletrodo deste registro está no STN, a figura diz
   isso ANTES do número. Também devolve os avisos de divergência perfil×alvo
   para quem quiser mostrá-los. */
function avisoDeAlvo(node, metodo) {
  const f0 = activeFiles()[0];
  if (!f0 || !f0.parsed) return null;
  const chk = C.targetProfileCheck(f0.parsed, activeProfile().id);
  if (node && metodo && chk.stnMethodCaveat) node.appendChild(el('div', {
    class: 'warnbox', html: `<b>Alvo fora do STN.</b> ${metodo} — e ${chk.stnMethodCaveat}.`
  }));
  return chk;
}

function rotuloLado(h) {
  const f0 = typeof activeFiles === 'function' ? activeFiles()[0] : null;
  const alvos = f0 && f0.parsed ? C.hemisphereTargets(f0.parsed) : null;
  const alvo = alvos ? alvos[h] : null;
  return `${alvo && alvo.label ? alvo.label : 'hemisfério'} ${hname(h)}`;
}

/* ============================================ trabalho em segundo plano ====
   POR QUE. Mesmo depois de a Onda 8.0 tornar cada etapa visível, o cálculo
   continua na thread principal: enquanto ele roda, a página não repinta e nada
   responde ao clique. Um Web Worker move o trabalho pesado para outra thread e
   a interface segue viva — a barra de progresso anima de verdade, e o usuário
   pode rolar a página enquanto o registro é processado.

   COMO, SEM QUEBRAR O INVARIANTE DO ARQUIVO ÚNICO. O worker não vem de um
   arquivo separado: o código do NÚCLEO já está no primeiro <script> da página,
   e é lido de volta em tempo de execução (`document.scripts[0].textContent`),
   concatenado a um pequeno despachante e transformado em Blob. Nenhuma
   requisição de rede, nenhum arquivo adicional, nenhuma duplicação do bundle.

   QUANDO NÃO DÁ. Em `file://` alguns navegadores recusam worker de blob, e há
   ambientes que desabilitam Worker. Nesse caso NÃO há degradação silenciosa: o
   motivo é registrado, aparece no manifesto de proveniência e no painel de
   processo, e o cálculo roda na thread principal exatamente como antes.

   O que o worker executa é sempre uma função do núcleo, nomeada — ele não
   avalia código vindo da interface. */
const Trabalhador = (() => {
  let w = null, seq = 0, estado = 'não iniciado', motivo = '';
  const pendentes = new Map();

  const DESPACHANTE = `
self.onmessage = function (ev) {
  var d = ev.data || {};
  var t0 = Date.now();
  try {
    var api = self.PerceptCore;
    /* só propriedades PRÓPRIAS do núcleo: sem isso, 'constructor', 'toString' e
       companhia passariam pelo teste de "é função" e virariam ponto de entrada */
    var proprio = api && Object.prototype.hasOwnProperty.call(api, d.fn);
    var fn = proprio ? api[d.fn] : null;
    if (typeof fn !== 'function') throw new Error('funcao desconhecida no trabalhador: ' + d.fn);
    var r = fn.apply(null, d.args || []);
    self.postMessage({ id: d.id, ok: true, ms: Date.now() - t0, r: r });
  } catch (e) {
    self.postMessage({ id: d.id, ok: false, ms: Date.now() - t0, erro: String((e && e.message) || e) });
  }
};
self.postMessage({ pronto: true });
`;

  function inicia() {
    if (w || estado === 'indisponível') return w;
    try {
      if (typeof Worker !== 'function' || typeof Blob !== 'function' || !URL.createObjectURL)
        throw new Error('Worker ou Blob indisponível neste navegador');
      const nucleo = document.scripts && document.scripts[0] && document.scripts[0].textContent;
      if (!nucleo || nucleo.indexOf('PerceptCore') < 0)
        throw new Error('não foi possível ler o núcleo da própria página');
      const blob = new Blob([nucleo + '\n' + DESPACHANTE], { type: 'text/javascript' });
      const url = URL.createObjectURL(blob);
      w = new Worker(url);
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      w.onmessage = ev => {
        const d = ev.data || {};
        if (d.pronto) { estado = 'ativo'; return; }
        const p = pendentes.get(d.id);
        if (!p) return;
        pendentes.delete(d.id);
        if (d.ok) p.resolve({ r: d.r, ms: d.ms }); else p.reject(new Error(d.erro));
      };
      w.onerror = e => {
        estado = 'indisponível';
        motivo = String((e && e.message) || 'erro no trabalhador');
        pendentes.forEach(p => p.reject(new Error(motivo)));
        pendentes.clear();
        try { w.terminate(); } catch (x) { }
        w = null;
      };
      estado = 'iniciando';
    } catch (e) {
      estado = 'indisponível';
      motivo = String((e && e.message) || e);
      w = null;
    }
    return w;
  }

  return {
    get estado() { return estado; },
    get motivo() { return motivo; },
    disponivel() { inicia(); return estado !== 'indisponível' && !!w; },

    /* Executa `fn` do núcleo no worker. Se o worker não estiver disponível, ou
       falhar, cai para a thread principal — e devolve `ondeRodou` para que a
       proveniência registre onde o número foi calculado. */
    async chamar(fn, args, opts) {
      opts = opts || {};
      const local = () => {
        if (!Object.prototype.hasOwnProperty.call(C, fn) || typeof C[fn] !== 'function')
          throw new Error('função desconhecida no núcleo: ' + fn);
        const t0 = Date.now();
        const r = C[fn].apply(null, args || []);
        return { r, ms: Date.now() - t0, ondeRodou: 'thread principal' };
      };
      if (!this.disponivel()) return local();
      const id = ++seq;
      try {
        const p = new Promise((resolve, reject) => {
          pendentes.set(id, { resolve, reject });
          if (opts.timeoutMs) setTimeout(() => {
            if (pendentes.has(id)) { pendentes.delete(id); reject(new Error('tempo esgotado no trabalhador')); }
          }, opts.timeoutMs);
        });
        w.postMessage({ id, fn, args: args || [] });
        const out = await p;
        return { r: out.r, ms: out.ms, ondeRodou: 'trabalhador (Web Worker)' };
      } catch (e) {
        /* falhou no worker: refaz na thread principal em vez de perder o passo */
        motivo = String((e && e.message) || e);
        const out = local();
        out.ondeRodou = 'thread principal (o trabalhador falhou: ' + motivo + ')';
        return out;
      }
    }
  };
})();

/* Registro do que rodou onde e em quanto tempo — vai para o manifesto de
   proveniência, porque "quanto custou" e "onde foi calculado" fazem parte de
   descrever a análise. */
const Instrumentacao = {
  passos: [],
  registra(nome, ms, onde) { this.passos.push({ step: nome, ms: Math.round(ms), where: onde }); },
  limpa() { this.passos = []; },
  resumo() {
    const total = this.passos.reduce((a, p) => a + p.ms, 0);
    const noWorker = this.passos.filter(p => /trabalhador/.test(p.where)).length;
    return {
      steps: this.passos.slice(),
      totalMs: total, nSteps: this.passos.length,
      nInWorker: noWorker,
      workerState: Trabalhador.estado,
      workerReason: Trabalhador.motivo || null
    };
  }
};

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
  external: null,       // sinal externo importado (Onda 2.3): {name, parsed}
  diary: null,          // diário de Hauser importado (Onda 9): {name, parsed}
  mode: 'clinico',      // 'clinico' | 'pesquisa' (Onda 8.1)
  lang: 'pt',           // 'pt' | 'en' (Onda 8.2)
  aba: 'inicio',        // aba ativa (Onda 11): inicio|agudo|cronico|ponte|qualidade|coorte|relatorio
};

/* Atalho de tradução. Devolve a própria chave quando não há tradução — o texto
   em português é preferível a um espaço em branco. */
const t = k => C.t(k);

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
/* ========================================================== aparência ====
   Duas escolhas, e as duas pertencem a quem lê a tela.

   TEMA. `auto` segue o sistema; `claro` e `escuro` fixam. O que o CSS lê é o
   tema RESOLVIDO em `data-tema`; a escolha fica em `data-tema-escolha`, o que
   permite um único bloco escuro na folha de estilo em vez de um duplicado
   dentro de media query. Trocar o tema NÃO redesenha nenhum gráfico: o papel
   da figura é claro em qualquer tema, para que o PNG exportado não dependa da
   tela de quem exportou.

   MATERIAL. De `solido` a `vidro`, com `tingido` como padrão. A translucidez
   se aplica só às três camadas que flutuam sobre o conteúdo — cabeçalho, abas
   e painel de processamento. Nunca atrás de gráfico, tabela ou nota. O recuo
   da Apple no Liquid Glass em 2026 foi por legibilidade, e a correção veio na
   forma de controle do usuário; é essa a forma adotada aqui.              */
const TEMAS = ['auto', 'claro', 'escuro'];
const MATERIAIS = ['solido', 'tingido', 'vidro'];
const APARENCIA_PADRAO = { tema: 'auto', material: 'tingido' };

function temaDoSistema() {
  try {
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'escuro' : 'claro';
  } catch (e) { return 'claro'; }
}
function aparenciaAtual() {
  const p = lerPrefs();
  return {
    tema: TEMAS.indexOf(p.tema) >= 0 ? p.tema : APARENCIA_PADRAO.tema,
    material: MATERIAIS.indexOf(p.material) >= 0 ? p.material : APARENCIA_PADRAO.material
  };
}
function aplicarAparencia() {
  const a = aparenciaAtual();
  const resolvido = a.tema === 'auto' ? temaDoSistema() : a.tema;
  const raiz = document.documentElement;
  if (!raiz || !raiz.setAttribute) return a;
  raiz.setAttribute('data-tema', resolvido);
  raiz.setAttribute('data-tema-escolha', a.tema);
  raiz.setAttribute('data-material', a.material);
  /* a barra do navegador acompanha o cromo, senão a moldura do sistema fica
     clara sobre um app escuro */
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && meta.setAttribute) meta.setAttribute('content', resolvido === 'escuro' ? '#0B1218' : '#0E1A24');
  ['segTema', 'segMaterial'].forEach(id => {
    const g = document.getElementById(id);
    if (!g) return;
    (g.children ? Array.prototype.slice.call(g.children) : []).forEach(b => {
      const v = b.getAttribute(id === 'segTema' ? 'data-tema' : 'data-material');
      b.setAttribute('aria-pressed', String(v === (id === 'segTema' ? a.tema : a.material)));
    });
  });
  return Object.assign({}, a, { resolvido });
}
/* medirCromo() — publica a altura REAL da camada fixa em `--chrome-h`.
   A coluna lateral gruda logo abaixo dela e as âncoras de figura rolam até
   ela; com a altura chutada em pixels, uma linha de ferramentas que quebra em
   duas passava a cobrir a barra de abas e o topo de cada figura. */
function medirCromo() {
  const c = document.getElementById('chrome');
  const raiz = document.documentElement;
  if (!c || !raiz || !raiz.style || typeof c.getBoundingClientRect !== 'function') return NaN;
  const h = Math.round(c.getBoundingClientRect().height || 0);
  if (h > 0) raiz.style.setProperty('--chrome-h', h + 'px');
  return h;
}

function setTema(v) { if (TEMAS.indexOf(v) < 0) return; salvarPref('tema', v); aplicarAparencia(); }
function setMaterial(v) { if (MATERIAIS.indexOf(v) < 0) return; salvarPref('material', v); aplicarAparencia(); }

function modoAtual() { return S.mode === 'pesquisa' ? 'pesquisa' : 'clinico'; }
function ehClinico() { return modoAtual() === 'clinico'; }
function setModo(m) {
  if (modoAtual() === m) return;
  S.mode = m; salvarPref('modo', m);
  marcarModo();
  renderAll(m === 'clinico' ? 'Modo clínico' : 'Modo pesquisa');
}
function setIdioma(id) {
  S.lang = C.setLanguage(id);
  salvarPref('idioma', S.lang);
  aplicarIdiomaMoldura();
  renderAll(S.lang === 'en' ? 'Switching language' : 'Trocando de idioma');
}
/* A moldura fora de #rail e #figs não é redesenhada pelo renderAll: é aqui. */
function aplicarIdiomaMoldura() {
  const set = (sel, txt) => { const n = document.querySelector(sel); if (n) n.textContent = txt; };
  set('.brand span', t('STN · potenciais de campo local · análise local'));
  set('#btnExport', t('⤓ CSV para R'));
  set('#btnPrint', t('imprimir / PDF'));
  set('#btnPasta', t('+ pasta'));
  const carregar = document.querySelector('.tools .btn.primary');
  if (carregar) carregar.textContent = t('+ carregar JSON');
  const lf = document.getElementById('labFuso');
  if (lf && lf.firstChild) lf.firstChild.nodeValue = t('fuso') + ' ';
  const auto = document.querySelector('#tz option[value="auto"]');
  if (auto) auto.textContent = t('do arquivo');
  ['clinico', 'pesquisa'].forEach(m => {
    const b = document.getElementById('modo' + m[0].toUpperCase() + m.slice(1));
    if (b) b.textContent = t(m === 'clinico' ? 'clínico' : 'pesquisa');
  });
  const sel = document.getElementById('idioma');
  if (sel) sel.value = S.lang;
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
    /* Record Streaming: tempo-domínio SEM estimulação. O parser já o lia; até
       aqui nenhuma figura o expunha, e é justamente a modalidade que casa com
       protocolos de estimulação desligada. */
    indefiniteStreaming: cat('indefiniteStreaming'),
    /* Electrode Identifier (DataVersion 1.3): gravação REFERENCIADA a um
       eletrodo do outro hemisfério — não é par bipolar, e por isso viaja em
       lista própria até a figura, que declara a referência. */
    electrodeIdentifier: cat('electrodeIdentifier'),
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
function ctrlText(label, value, placeholder, onChange) {
  const i = el('input', { type: 'text', value: value == null ? '' : value, placeholder: placeholder || '', onchange: e => onChange(e.target.value) });
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
      title: `${rotuloLado(hemi)} — ${n} pares bipolares`,
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
      tip.innerHTML = `<b>${c.label}</b> · ${rotuloLado(hemi)} · <b>#${c.rank}</b> de ${n}<br>` +
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
/* ------------------------------------- matriz hora × dia ligada à integral --
   POR QUE ESTE DESENHO. O desfecho de ensaio clínico em Parkinson avançado é
   "horas OFF em vigília", e ele é publicado como barra empilhada. A barra
   destrói exatamente a informação que muda a conduta: 6 h de OFF concentradas
   na manhã (delayed-on) pedem outra coisa que 6 h picadas ao longo do dia. A
   matriz hora × dia preserva ONDE o OFF cai; a barra diz QUANTO. As duas
   perguntas são legítimas, e por isso as duas ficam no mesmo gráfico.

   O QUE ESTA VERSÃO FAZ QUE O PAPEL NÃO FAZ. Cada linha da matriz tem, à
   direita e na mesma baseline, a própria barra empilhada. Passar o cursor sobre
   uma célula acende, ao mesmo tempo, todas as células daquele dia naquele
   estado e o segmento que elas somam — o raster e a sua integral, ligados. É a
   ligação que uma figura estática não consegue mostrar.

   A folga branca entre as células é deliberada: sem ela, bins vizinhos do mesmo
   estado viram um bloco contínuo e o olho perde a contagem de meias horas. É o
   que faz a matriz ser lida como o diário em papel de onde ela vem.          */
function painelMatriz(parent, cfg) {
  const nD = cfg.days.length, nB = cfg.nBins;
  const alturaLinha = Math.max(7, Math.min(26, 330 / Math.max(1, nD)));
  const altura = Math.round(112 + nD * alturaLinha);
  const bx = plotBox(parent, altura, 'svbox');
  const tip = el('div', { class: 'svtip' });
  if (bx.box && bx.box.appendChild) bx.box.appendChild(tip);
  if (bx.canvas.style) bx.canvas.style.cursor = 'crosshair';

  const BARW = Math.max(4, Math.ceil(cfg.barMax || 24));
  const GAP = 2.4, BX0 = 24 + GAP, XTOT = BX0 + BARW;
  const corDe = id => (cfg.palette[id] && cfg.palette[id].color) || '#CCD3DA';
  const rotDe = id => (cfg.palette[id] && cfg.palette[id].label) || String(id);
  const hFmt = h => String(Math.floor(h)).padStart(2, '0') + ':' + String(Math.round((h % 1) * 60)).padStart(2, '0');

  let destaque = null, ch = null;
  const larguraAtual = () => Math.max(320, ((bx.box && bx.box.clientWidth) || bx.width + 12) - 12);

  const desenha = (canvas, larg, dpr) => {
    ch = new P.Chart(canvas, {
      width: larg, height: altura, dpr: dpr || undefined,
      xlim: [0, XTOT], ylim: [0, nD],
      xlabel: 'hora do dia (matriz)     ·     horas acumuladas (barra empilhada)',
      title: cfg.title, pad: { l: 92, r: 14, t: 26, b: 78 }
    });
    const passo = Math.max(1, Math.ceil(nD / 20));
    const linhaDe = v => nD - Math.ceil(v);
    ch.axes({
      grid: false,
      xticks: [0, 3, 6, 9, 12, 15, 18, 21, 24].concat([0, 6, 12, 18, 24].map(v => BX0 + v).filter(v => v <= XTOT + 1e-9)),
      xfmt: v => v <= 24.001 ? String(Math.round(v)).padStart(2, '0') + 'h' : String(Math.round(v - BX0)),
      yticks: cfg.days.map((_, i) => nD - i - 0.5).filter((_, i) => i % passo === 0),
      yfmt: v => { const i = linhaDe(v); return cfg.days[i] == null ? '' : cfg.rowLabel(cfg.days[i], i); }
    });
    /* noite como referência de leitura — é fundo, não dado */
    ch.span(0, 6, { color: COL.ink, alpha: .045 });
    ch.span(22, 24, { color: COL.ink, alpha: .045 });

    const aceso = (r, c) => !destaque || (r === destaque.r && cfg.states[r][c] === destaque.state);
    ch.cells(cfg.cells, {
      x0: 0, x1: 24, emptyColor: cfg.emptyColor || '#F1F4F6',
      gapY: Math.min(0.22, 2.2 / alturaLinha),
      color: cfg.continuous ? cfg.contColor : corDe,
      alphaOf: (v, r, c) => aceso(r, c) ? 1 : 0.18
    });

    /* barra empilhada de cada dia, à direita e na MESMA baseline da linha */
    const mg = Math.min(0.14, 1.6 / alturaLinha);
    cfg.rows.forEach((segs, r) => {
      let acc = 0;
      const yb = nD - r;
      segs.forEach(seg => {
        if (!(seg.hours > 0)) return;
        const forte = !destaque || (destaque.r === r && destaque.state === seg.state);
        ch.rect(BX0 + acc, yb - 1 + mg, BX0 + acc + seg.hours, yb - mg,
          { fill: corDe(seg.state), stroke: '#FFFFFF', lineWidth: 1, alpha: forte ? 1 : 0.18 });
        if (destaque && destaque.r === r && destaque.state === seg.state)
          ch.rect(BX0 + acc, yb - 1 + mg, BX0 + acc + seg.hours, yb - mg, { stroke: COL.ink, lineWidth: 1.6 });
        acc += seg.hours;
      });
    });
    /* o traço que diz "estas células somam aquele segmento" */
    if (destaque) {
      const y = nD - destaque.r - 0.5;
      ch.line([24.2, BX0 - 0.2], [y, y], { color: COL.ink, width: 0.9, dash: [2, 3] });
    }
    /* ▼ das tomadas, apontando para a linha do próprio dia */
    (cfg.doseRows || []).forEach((horas, r) => {
      (horas || []).forEach(h => ch.marker(h, nD - r - 0.04, {
        shape: 'tridown', size: Math.max(2.6, Math.min(4.6, alturaLinha * 0.3)), color: COL.ink, halo: true
      }));
    });
    ch.vline(24 + GAP / 2, { color: COL.rule, width: 1, dash: [3, 3] });
    ch.swatches(cfg.legend, { y: altura - 34, width: larg });
    return ch;
  };
  desenha(bx.canvas, larguraAtual());

  /* ------------------------------------------------------ interação ----- */
  const alvoDe = (px, py) => {
    if (!ch) return null;
    const fx = ch.invX(px), fy = ch.invY(py);
    if (fx < 0 || fx > 24) return null;
    const r = nD - Math.ceil(fy);
    if (!(r >= 0 && r < nD)) return null;
    const c = Math.floor(fx * nB / 24);
    if (!(c >= 0 && c < nB)) return null;
    const st = cfg.states[r][c];
    return st == null ? null : { r, c, state: st };
  };
  const posicao = ev => { const q = bx.canvas.getBoundingClientRect(); return [ev.clientX - q.left, ev.clientY - q.top]; };
  bx.canvas.addEventListener('mousemove', ev => {
    const [px, py] = posicao(ev);
    const a = alvoDe(px, py);
    const mudou = (a && destaque) ? (a.r !== destaque.r || a.state !== destaque.state) : (!!a !== !!destaque);
    if (mudou) { destaque = a; desenha(bx.canvas, larguraAtual()); }
    if (a) {
      const seg = (cfg.rows[a.r] || []).find(s => s.state === a.state);
      const total = (cfg.rows[a.r] || []).reduce((x, s) => x + s.hours, 0);
      const h0 = a.c * 24 / nB;
      tip.innerHTML = `<b>${cfg.rowLabel(cfg.days[a.r], a.r)}</b> · ${hFmt(h0)}–${hFmt(h0 + 24 / nB)}<br>` +
        `<b style="color:${corDe(a.state)}">${rotDe(a.state)}</b>` +
        (cfg.continuous && isFinite(cfg.cells[a.r][a.c]) ? ` · ${f(cfg.cells[a.r][a.c], 1)}` : '') + '<br>' +
        (seg ? `${f(seg.hours, 1)} h neste estado neste dia (${f(100 * seg.hours / (total || 1), 0)}% da barra)` : 'fora do recorte da barra');
      tip.style.display = 'block';
      tip.style.left = Math.max(4, Math.min(px + 14, larguraAtual() - 210)) + 'px';
      tip.style.top = Math.max(4, py - 58) + 'px';
    } else tip.style.display = 'none';
  });
  bx.canvas.addEventListener('mouseleave', () => {
    tip.style.display = 'none';
    if (destaque) { destaque = null; desenha(bx.canvas, larguraAtual()); }
  });
  /* exportar em 2×: a MESMA rotina de desenho numa tela fora do documento com o
     dobro da densidade. Esticar o bitmap já rasterizado devolveria borrão. */
  bx.exportar2x = nome => {
    const fora = document.createElement('canvas');
    const antes = destaque; destaque = null;
    desenha(fora, Math.max(900, larguraAtual()), 2);
    destaque = antes;
    desenha(bx.canvas, larguraAtual());
    P.downloadCanvas(fora, nome);
  };
  return bx;
}

/* ---------------------------------------- cache do espectrograma (F30) ----
   Mexer só no limite de cor ou no colormap não pode recalcular a FFT: em 60 s
   de sinal a 250 Hz o Welch são ~120 épocas de FFT de 500, e recomputar isso a
   cada arrastada de controle trava a interface. A chave carrega TODOS os
   parâmetros que mudam o número — quem não muda (cor, escala do eixo) fica de
   fora e por isso reaproveita. Guarda poucos resultados: cada um é uma matriz
   de centenas de milhares de floats. */
const _tfCache = new Map();
const _tfEmCurso = new Set();
function tfGuarda(chave, r) {
  _tfCache.set(chave, r);
  if (_tfCache.size > 6) _tfCache.delete(_tfCache.keys().next().value);
  return r;
}
/* Calcula no trabalhador e redesenha a figura quando o resultado chega. Duas
   chamadas para a mesma chave não disparam dois cálculos. */
async function calculaEspectrograma(chave, td, params) {
  if (_tfEmCurso.has(chave)) return;
  _tfEmCurso.add(chave);
  try {
    const out = await Trabalhador.chamar('timeFrequency', [td.data, td.fsEff || td.fs, params]);
    Instrumentacao.registra(`timeFrequency ${params.method} ${td.label}`, out.ms, out.ondeRodou);
    tfGuarda(chave, out.r);
  } catch (e) {
    tfGuarda(chave, { ok: false, reason: String((e && e.message) || e) });
  } finally {
    _tfEmCurso.delete(chave);
    _renderizadas.delete('F30');
    renderFigureAsync('F30');
  }
}

/* Bloco de metadados do método, em comentário no topo do CSV. Sem ele o
   arquivo exportado é irreproduzível: a mesma gravação com outra janela ou
   outra escala dá outros números, e seis meses depois ninguém lembra qual foi. */
/* O identificador pseudonimizado do registro ativo. `S.subject` só é
   preenchido quando o usuário TROCA de registro, então ler direto dele deixaria
   a exportação sem identificador no caso comum de um arquivo só. */
function sujeitoAtual() {
  const f = activeFiles()[0];
  return (f && f.parsed && f.parsed.patient && f.parsed.patient.idHash) || S.subject || '';
}
function metaEspectrograma(spec, td) {
  const p = spec.params;
  return [
    'Percept LFP Studio — time-frequency export',
    `generated_at=${new Date().toISOString()}`,
    `subject=${sujeitoAtual()}`,
    `channel=${td.label}  hemisphere=${td.hemisphere}`,
    `method=${spec.method}  pipeline=${(spec.pipeline || []).join(' > ')}`,
    `fs_hz=${p.fs}  fs_nominal_hz=${td.fs}`,
    `window_samples=${p.nperseg || ''}  window_s=${p.nperseg ? (p.nperseg / p.fs).toFixed(4) : ''}  window_fn=${p.window || ''}`,
    `step_s=${p.stepS}  noverlap_samples=${p.noverlap == null ? '' : p.noverlap}`,
    `nfft=${p.nfft || ''}  freq_resolution_hz=${p.nfft ? (p.fs / p.nfft).toFixed(4) : ''}`,
    `scaling=${p.scaling}  unit=${spec.unit}`,
    `detrend=${p.detrend || 'none'}  max_missing_fraction_per_epoch=${p.maxMissingFrac == null ? '' : p.maxMissingFrac}`,
    `epochs_total=${spec.nEpochs}  epochs_flagged_missing=${spec.nEpochs - spec.nEpochsValid}`,
    p.gain != null ? `medtronic_gain=${p.gain}  packet_samples=${p.packetSamples}  n_bins=${p.nBins}` : '',
    p.maxOrder != null ? `ar_max_order=${p.maxOrder}  ar_order_criterion=${p.orderCriterion}  ar_median_order=${p.medianOrder}` : '',
    spec.aperiodic ? `aperiodic_exponent=${spec.aperiodic.exponent}  aperiodic_r2=${spec.aperiodic.r2}  aperiodic_fit_hz=${spec.aperiodic.fitLo}-${spec.aperiodic.fitHi}  aperiodic_method=${spec.aperiodic.method}` : '',
    spec.normalization ? `normalization=${spec.normalization.mode}  baseline_s=${spec.normalization.baselineWindowS.join('-')}  log=${spec.normalization.log}` : '',
    'note=power is in the unit declared above; logPower_dB = 10*log10(Power)',
    'NOT A MEDICAL DEVICE — research and decision-support use only'
  ].filter(Boolean);
}

/* Formato longo com cabeçalhos em INGLÊS: é o que os scripts em R do projeto
   consomem, e trocar o idioma da coluna quebraria todos eles de uma vez. */
function csvEspectrograma(spec, tm, td, dB) {
  const linhas = ['# ' + metaEspectrograma(spec, td).join('\n# ')];
  linhas.push('Time_s,Frequency_Hz,Power,logPower_dB,Channel,Missing');
  const canal = String(td.label).replace(/[",;\n]/g, ' ');
  for (let i = 0; i < spec.times.length; i++) {
    const falt = spec.flagged[i] ? 1 : 0;
    /* tm.freqs é o prefixo de spec.freqs até fMax (o eixo é crescente), então
       o índice k vale nos dois — a potência LINEAR sai sempre do spec, para
       que o CSV não dependa de a figura estar em dB naquele momento */
    for (let k = 0; k < tm.freqs.length; k++) {
      const lin = spec.power[i][k];
      const emDb = isFinite(lin) && lin > 0 ? 10 * Math.log10(lin) : NaN;
      linhas.push([
        spec.times[i].toFixed(4), tm.freqs[k].toFixed(4),
        isFinite(lin) ? lin.toExponential(6) : '',
        isFinite(emDb) ? emDb.toFixed(4) : '',
        canal, falt
      ].join(','));
    }
  }
  void dB;
  return linhas.join('\n');
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

/* ============================================================ eletrodos ====
   POR QUE ESTE PAINEL EXISTE. Todas as figuras falam de contatos — "par 1-3",
   "catodo em 2b", "contato 0 com impedância alta" — e esses nomes eram só
   texto. Um par "0-3" abrange 7,5 mm num eletrodo 3389 e 24 mm num 3391: mesmo
   rótulo, situações anatômicas diferentes. O desenho em escala, com os contatos
   em uso marcados, torna isso visível sem exigir tabela decorada.

   O modelo é detectado do próprio JSON (`LeadConfiguration`); quando não é
   reconhecido, o painel diz isso em vez de desenhar um eletrodo genérico como
   se fosse o do paciente.                                                    */

/* Estado de cada contato numa figura: 'sensing' (par bipolar em uso),
   'cathode' / 'anode' (estimulação) e 'flag' (algo a apontar, p.ex. impedância
   fora de faixa). */
function marcasDeContatos(ids, estado) {
  const m = {};
  (ids || []).forEach(id => { if (id) m[String(id).toLowerCase()] = estado || 'sensing'; });
  return m;
}

/* painelEletrodo(parent, opts)
     hemisphere  'Left' | 'Right'
     highlight   { '1': 'sensing', '3': 'sensing', ... }
     title, subtitle, altura, semRegua, semAxial
   Devolve o canvas principal, para exportação em PNG.                       */
function painelEletrodo(parent, opts) {
  opts = opts || {};
  const hemi = opts.hemisphere || 'Left';
  const p0 = activeFiles()[0] && activeFiles()[0].parsed;
  const porLado = p0 ? C.leadsOf(p0) : {};
  const lead = porLado[hemi] || null;
  const spec = lead ? lead.spec : C.leadSpec(null);
  const geo = C.leadGeometry(spec);

  const wrap = el('div', { class: 'lead-wrap' });
  const alturaEl = opts.altura || 260;

  if (!geo.ok) {
    wrap.appendChild(el('div', {
      class: 'note lead-na',
      html: `<b>Eletrodo não desenhado.</b> ${geo.reason}. O software não desenha um eletrodo genérico no lugar: ` +
        'a geometria muda o que "par 0-3" significa, e um desenho errado seria pior do que nenhum.'
    }));
    parent.appendChild(wrap);
    return null;
  }

  /* um nível pedido num eletrodo direcional vira os três segmentos — ver
     expandContacts: não existe contato anelar nesse nível */
  const pedidos = Object.keys(opts.highlight || {});
  const exp = C.expandContacts(pedidos, geo);
  const marcacao = {};
  exp.ids.forEach(id => {
    const origem = opts.highlight[id] ||
      opts.highlight[String(id).replace(/[abc]$/, '')] || 'sensing';
    marcacao[id] = origem;
  });

  const cv = document.createElement('canvas');
  cv.setAttribute('role', 'img');
  const marcados = Object.keys(marcacao);
  cv.setAttribute('aria-label',
    `esquema em escala do eletrodo ${spec.label} no hemisfério ${hname(hemi)}` +
    (marcados.length ? `, com os contatos ${marcados.join(', ')} destacados` : ''));
  const col = el('div', { class: 'lead-col' });
  col.appendChild(cv);
  wrap.appendChild(col);

  P.drawLead(cv, geo, {
    width: opts.largura || 210, height: alturaEl,
    highlight: marcacao,
    title: opts.title || `${spec.label} · ${rotuloLado(hemi)}`,
    subtitle: opts.subtitle || (lead && lead.target ? `alvo ${lead.target}` : null),
    ruler: !opts.semRegua
  });

  /* vista axial só quando há segmento em uso — senão é ruído */
  const temSegmento = marcados.some(id => /[abc]$/.test(id));
  if (geo.family === 'directional' && temSegmento && !opts.semAxial) {
    const niveis = Array.from(new Set(marcados.filter(id => /[abc]$/.test(id)).map(id => +id[0])));
    niveis.slice(0, 2).forEach(nv => {
      const ax = document.createElement('canvas');
      ax.setAttribute('role', 'img');
      ax.setAttribute('aria-label', `corte axial do nível ${nv} do eletrodo, com os segmentos em uso destacados`);
      const c2 = el('div', { class: 'lead-col' });
      c2.appendChild(ax);
      wrap.appendChild(c2);
      P.drawLeadAxial(ax, geo, {
        width: 132, height: 132, level: nv,
        highlight: marcacao, title: `nível ${nv} (axial)`
      });
    });
  }

  parent.appendChild(wrap);

  if (opts.semLegenda !== true) {
    const partes = [C.leadSummary(spec)];
    if (marcados.length >= 2) {
      const sp = C.leadSpan(spec, marcados);
      if (sp.ok) partes.push(sp.note);
    }
    if (exp.note) partes.push(exp.note);
    parent.appendChild(el('div', { class: 'lead-legenda', text: partes.join(' · ') }));
    if (!spec.dimensionsVerified) parent.appendChild(el('div', {
      class: 'note', html: `<b>Medidas não conferidas.</b> As dimensões do ${spec.label} vêm de catálogo e da ` +
        'literatura, não do manual de implante conferido. Confirme antes de publicar.'
    }));
    if (geo.family === 'directional' && temSegmento) parent.appendChild(el('div', {
      class: 'note', html: `<b>Orientação.</b> ${geo.orientationNote}.`
    }));
  }
  return cv;
}

/* Painel dos DOIS hemisférios lado a lado, para as figuras que mostram ambos. */
function painelEletrodosBilateral(parent, marcasPorHemi, opts) {
  opts = opts || {};
  const linha = el('div', { class: 'lead-bilateral' });
  const canvases = {};
  ['Left', 'Right'].forEach(h => {
    if (!marcasPorHemi[h]) return;
    const cel = el('div');
    canvases[h] = painelEletrodo(cel, Object.assign({}, opts, { hemisphere: h, highlight: marcasPorHemi[h] }));
    linha.appendChild(cel);
  });
  parent.appendChild(linha);
  return canvases;
}

function exportRow(items) {
  const d = el('div', { class: 'ctrls' });
  items.forEach(i => d.appendChild(el('button', { class: 'btn', onclick: i.fn, text: i.label })));
  return d;
}
/* Tabela em que uma célula pode ser um controle (select, input) em vez de
   texto: é o que permite declarar a atribuição de épocas na própria linha da
   gravação, sem um formulário separado longe do dado que ele descreve. */
function tabelaComControles(headers, rows) {
  const t = el('table', { class: 'data' });
  t.appendChild(el('thead', {}, [el('tr', {}, headers.map(h => el('th', { text: h })))]));
  const tb = el('tbody');
  rows.forEach(r => tb.appendChild(el('tr', {}, r.map(c => {
    if (c && typeof c === 'object' && c.node) return el('td', {}, [c.node]);
    if (c && typeof c === 'object' && c.html !== undefined) return el('td', { class: c.cls || '', html: c.html });
    return el('td', { class: typeof c === 'number' ? 'num' : '', text: c == null ? '—' : String(c) });
  }))));
  t.appendChild(tb); return t;
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

      /* --- eletrodo em escala, com o par mostrado marcado ------------------- */
      {
        const ids = C.contactsOfChannel(cur.canal ? (cur.canal.channel || cur.label) : cur.label);
        const hemiCur = cur.hemi || (cur.canal && cur.canal.hemisphere) || 'Left';
        if (ids.length) {
          node.appendChild(el('h4', {
            class: 'qc-title', html: `<b>Onde este par fica no eletrodo</b>`
          }));
          painelEletrodo(node, {
            hemisphere: hemiCur,
            highlight: marcasDeContatos(ids, 'sensing'),
            subtitle: `par ${ids.join('–')} · o que está sendo mostrado acima`
          });
        }
      }
      node.appendChild(el('div', {
        class: 'note', html: '<b>O que o Survey grava, e o que ele exclui.</b> Para um eletrodo 1x4, <b>todos</b> os ' +
          'pares daquele lead são gravados <b>simultaneamente</b> — o que torna legítima a coerência <i>dentro</i> do ' +
          'hemisfério. Mas o segundo hemisfério exige <b>outro survey</b>: os dois lados do Survey <b>não</b> são ' +
          'simultâneos, e coerência entre eles a partir daqui é ficção. Em eletrodo SenSight, o survey de segmentos ' +
          'roda em <b>duas passagens</b> (Pass 1 e Pass 2), e canais de passagens diferentes também não são ' +
          'simultâneos. Cada canal traz cerca de <b>20 s</b> de sinal, com bins de <b>0,98 Hz</b> e centros de 0 a ' +
          '<b>96,68 Hz</b>. E um par <b>ausente</b> deste arquivo pode ter sido excluído pelo próprio aparelho — por ' +
          'suspeita de curto, de circuito aberto ou de artefato cardíaco/de movimento —, não por falta de sinal. ' +
          '[Medtronic UC202012929cEN FY24, p. 4]'
      }));
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
          { color: hcol(h), width: w, label: `${rotuloLado(h)}` });
      });
      ch.legend({ x: ch.x0 + 8, y: ch.y1 + 6 });

      const hSel = opt('F3', 'hemi', hemis[0]);
      node.appendChild(el('div', { class: 'ctrls' }, [ctrlSelect('matriz bipolar', hemis.map(h => ({ value: h, label: rotuloLado(h) })), hSel, v => setOpt('F3', 'hemi', v))]));
      const b2 = plotBox(grid, 250);
      const M = labels.map(() => labels.map(() => NaN));
      d.impedance[hSel].bipolar.forEach(e => {
        const i = labels.indexOf(e.a), j = labels.indexOf(e.b);
        if (i >= 0 && j >= 0) { M[i][j] = e.ohm; M[j][i] = e.ohm; }
      });
      const ch2 = new P.Chart(b2.canvas, {
        width: b2.width, height: b2.height, xlim: [0, labels.length], ylim: [0, labels.length],
        xlabel: 'contato', ylabel: 'contato', title: `(b) bipolar — ${rotuloLado(hSel)} (Ω)`, pad: { l: 46, r: 62, t: 24, b: 40 }
      });
      ch2.heat(M, { cmap: 'ice', smooth: false });
      ch2.axes({ grid: false, xticks: labels.map((_, i) => i + .5), yticks: labels.map((_, i) => i + .5), xfmt: v => labels[Math.floor(v)] || '', yfmt: v => labels[labels.length - 1 - Math.floor(v)] || '' });
      ch2.colorbar({ label: 'Ω' });

      const st = (S.files[0] || {}).parsed;
      /* D2 — os limiares que o DISPOSITIVO usa para excluir um canal do sensing
         são outros: curto abaixo de 250 Ω (1x4) ou 350 Ω (SenSight), aberto
         acima de 10 kΩ (UC202012929cEN FY24, p. 4). A faixa 500–2000 Ω é
         referência de leitura, e passa a ser declarada como tal. */
      const modelo = ((st && st.leads) || []).map(l => l.model).join(' ');
      const curto = C.shortThresholdOhms(modelo);
      const aberto = C.IMPEDANCE_LIMITS.openOhms;
      const foraDoDispositivo = allv.filter(v => v < curto || v > aberto);
      const foraDoHabitual = allv.filter(v => v >= curto && v <= aberto && (v < 500 || v > 2000));
      if (foraDoDispositivo.length) node.appendChild(el('div', {
        class: 'warnbox', html: `<b>${foraDoDispositivo.length} contato(s) fora dos limites do fabricante.</b> ` +
          `Curto abaixo de <b>${curto} Ω</b> (${/B330|sensight/i.test(modelo) ? 'SenSight' : 'eletrodo 1x4'}) ou aberto acima de ` +
          `<b>${aberto / 1000} kΩ</b> — nesses casos o próprio dispositivo <b>exclui o canal do sensing</b>. ` +
          `Status reportado pelo dispositivo: <b>${(st && st.impedanceStatus) || '—'}</b>. ` +
          `[${C.IMPEDANCE_LIMITS.source}]`
      }));
      if (foraDoHabitual.length) node.appendChild(el('div', {
        class: 'note', html: `${foraDoHabitual.length} contato(s) fora da faixa habitual de leitura (500–2000 Ω), mas ` +
          `dentro dos limites do dispositivo. ${C.IMPEDANCE_LIMITS.usualRangeNote}. ` +
          `Valores altos em contatos segmentados são esperados (área de superfície menor); o que importa é a ` +
          `<b>estabilidade seriada</b>.`
      }));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Um par ausente do Survey não é um par sem sinal.</b> ${C.IMPEDANCE_LIMITS.exclusionNote}. ` +
          `[${C.IMPEDANCE_LIMITS.source}]`
      }));

      /* --- eletrodo com os contatos fora dos limites marcados ------------ */
      {
        const marcas = {};
        hemis.forEach(h => {
          marcas[h] = {};
          (d.impedance[h].mono || []).forEach(m => {
            if (!isFinite(m.ohm)) return;
            const ids = C.contactsOfChannel(m.b || m.a);
            const fora = m.ohm < curto || m.ohm > aberto;
            ids.forEach(id => { if (fora) marcas[h][id] = 'flag'; });
          });
        });
        const algum = hemis.some(h => Object.keys(marcas[h]).length);
        node.appendChild(el('h4', {
          class: 'qc-title', html: algum
            ? '<b>Quais contatos estão fora dos limites do fabricante</b>'
            : '<b>Eletrodo implantado</b>'
        }));
        painelEletrodosBilateral(node, marcas, { altura: 250 });
        if (!algum) node.appendChild(el('div', {
          class: 'note', text: 'nenhum contato fora dos limites de curto ou de circuito aberto — o desenho está aqui ' +
            'para dar a escala do eletrodo deste paciente, que é o que torna "par 0-3" interpretável'
        }));
      }
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
          xlabel: 'frequência (Hz)', title: `${rotuloLado(h)} — ${rows.length} canais`, pad: { l: 62, r: 60, t: 24, b: 40 }
        });
        ch.heat(M, { cmap: 'magma', smooth: true });
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
    has: d => d.bsTimeDomain.length || d.montageTD.length || (d.electrodeIdentifier || []).length || (d.indefiniteStreaming || []).length,
    render(node, d) {
      const src = [].concat(
        d.bsTimeDomain.map((t, i) => ({ value: 'bs' + i, label: `Streaming ${t.label} (${(t.data.length / t.fs).toFixed(0)} s)`, td: t })),
        d.montageTD.map((t, i) => ({ value: 'mt' + i, label: `Survey ${t.hemisphere[0]}·${t.label} (${(t.data.length / t.fs).toFixed(0)} s)`, td: t })),
        (d.indefiniteStreaming || []).map((t, i) => ({ value: 'is' + i, label: `Record ${t.hemisphere[0]}·${t.label} (${(t.data.length / t.fs).toFixed(0)} s)`, td: t })),
        (d.electrodeIdentifier || []).map((t, i) => ({ value: 'ei' + i, label: `Identifier ${t.hemisphere[0]}·${t.label} → ref ${t.referenceElectrode || '?'} (${(t.data.length / t.fs).toFixed(0)} s)`, td: t })));
      if (!src.length) return node.appendChild(el('div', { class: 'empty', text: 'Nenhum sinal bruto disponível.' }));
      const cur = src.find(s => s.value === opt('F6', 'src', src[0].value)) || src[0];
      const td = cur.td;
      /* Gravação referenciada não é par bipolar: a amplitude depende do
         eletrodo de referência, no OUTRO hemisfério, e a topografia não se lê
         como a de um par local. Dizer isso antes do traçado evita a leitura
         errada mais provável desta modalidade. */
      if (td.referenced) node.appendChild(el('div', {
        class: 'warnbox', html: `<b>Gravação referenciada, não bipolar.</b> Este registro do modo ` +
          `<i>Electrode Identifier</i> mede ${td.channel} contra <b>${td.referenceElectrode || '?'}</b> do hemisfério ` +
          `${hname(td.referenceHemisphere || '?')}` + (isFinite(td.tipOffset) ? ` (TipOffset ${td.tipOffset})` : '') +
          `. A amplitude depende do eletrodo de referência e a topografia não se lê como a de um par bipolar local — ` +
          `use para identificar o eletrodo, não para comparar potência com os pares do Survey.`
      }));
      const doEcg = opt('F6', 'ecg', false);
      /* a banda do burst segue a banda PRIMÁRIA do perfil ativo — beta baixo no
         Parkinson, teta-alfa na distonia palidal, f0 medida no tremor. O 13–20
         fixo assumia STN parkinsoniano para todo mundo. */
      const pbF6 = activeProfile().primaryBand || { lo: 13, hi: 20 };
      const blo = opt('F6', 'blo', Math.round(pbF6.lo)), bhi = opt('F6', 'bhi', Math.round(Math.min(pbF6.hi, pbF6.lo === 13 ? 20 : pbF6.hi)));
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
      ch2.heat(Mt, { cmap: 'viridis', zmin, zmax, smooth: true });
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
      {
        const ids = C.contactsOfChannel(td.channel || td.label);
        if (ids.length) {
          node.appendChild(el('h4', { class: 'qc-title', html: '<b>Qual par gerou este traçado</b>' }));
          painelEletrodo(node, {
            hemisphere: td.hemisphere || 'Left',
            highlight: marcasDeContatos(ids, 'sensing'),
            subtitle: `par ${ids.join('–')} · ${td.label}`,
            altura: 230
          });
        }
      }
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
      if (!opts.length) return node.appendChild(el('div', {
        class: 'note', html: '<b>Resolução efetiva da série de potência.</b> A amostragem subjacente é de <b>2 Hz</b>, ' +
          'mas uma solução única só é calculada a cada <i>power averaging duration</i>, e essa média <b>não é móvel</b>: ' +
          'cada valor contém um conjunto de dados próprio, sem sobreposição com o anterior. A resolução real é a ' +
          'duração de média configurada, não os 2 Hz nominais — e os pontos são independentes por construção dentro ' +
          'de cada média. [Medtronic UC202012929cEN FY24, p. 9]'
      }));
      node.appendChild(el('div', { class: 'empty', text: 'Sem streaming de potência.' }));
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
        {
        /* aqui o que importa não é o par de sensing: é onde a corrente entra */
        const p0 = activeFiles()[0] && activeFiles()[0].parsed;
        const gAtivo = ((p0 && p0.groups) || []).find(g => g.active) || ((p0 && p0.groups) || [])[0];
        const marcas = {};
        ((gAtivo && gAtivo.programs) || []).forEach(pr => {
          const h = pr.hemisphere === 'Left' || pr.hemisphere === 'Right' ? pr.hemisphere : null;
          if (!h) return;
          marcas[h] = marcas[h] || {};
          /* `contactsOfChannel` entende as duas formas — a verbosa do JSON e a
             curta que o parser já converteu ("1a", "0-3") */
          (pr.contacts || []).forEach(c => C.contactsOfChannel(c).forEach(id => { marcas[h][id] = 'cathode'; }));
          (pr.anode || []).forEach(c => C.contactsOfChannel(c).forEach(id => { marcas[h][id] = 'anode'; }));
        });
        /* e o par de SENSING junto, porque a pergunta clínica é a relação entre
           onde se estimula e onde se registra */
        ((gAtivo && gAtivo.sensing) || []).forEach(sc => {
          const h = sc.hemisphere;
          if (!h) return;
          marcas[h] = marcas[h] || {};
          C.contactsOfChannel(sc.channel).forEach(id => { if (!marcas[h][id]) marcas[h][id] = 'sensing'; });
        });
        if (Object.keys(marcas).length) {
          node.appendChild(el('h4', { class: 'qc-title', html: '<b>Onde a corrente entra e onde o sinal é lido</b>' }));
          painelEletrodosBilateral(node, marcas, { altura: 250 });
          node.appendChild(el('div', {
            class: 'lead-legenda',
            html: `<span style="color:${P.LEAD_CORES.cathode}">■</span> catodo · ` +
              `<span style="color:${P.LEAD_CORES.anode}">■</span> anodo · ` +
              `<span style="color:${P.LEAD_CORES.sensing}">■</span> par de sensing`
          }));
        }
      }
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
    id: 'F8', title: 'Timeline crônico — série temporal multi-dia ou dia a dia',
    sub: 'LFPTrendLogs: potência a cada 10 min · um gráfico contínuo ou um painel por dia civil',
    has: d => Object.keys(d.trend).length,
    render(node, d) {
      const hemis = Object.keys(d.trend);
      const k = opt('F8', 'mad', 4), showMa = opt('F8', 'ma', true), smooth = opt('F8', 'smooth', 6);
      /* APRESENTAÇÃO é escolha, e as duas respondem a perguntas diferentes.
         O gráfico contínuo mostra tendência entre dias — deriva, degrau após
         reprogramação, efeito de titulação. O painel por dia empilha os dias
         sobre o MESMO eixo de horas, que é o arranjo em que o padrão diurno
         se lê (e em que um dia atípico salta). Nenhuma das duas é mais
         "correta"; o que muda é o eixo em que o olho compara. */
      const modo = opt('F8', 'modo', 'multi');
      const mesmaEscala = opt('F8', 'escala', true);
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('apresentação', [
          { value: 'multi', label: 'um gráfico multi-dia (contínuo)' },
          { value: 'dia', label: 'um gráfico por dia (0h–23h59)' }
        ], modo, v => setOpt('F8', 'modo', v)),
        ctrlNumber('outliers: k×MAD', k, 2, 10, .5, v => setOpt('F8', 'mad', v)),
        ctrlNumber('suavização (pontos)', smooth, 1, 72, 1, v => setOpt('F8', 'smooth', v)),
        ctrlCheck('mostrar amplitude de estimulação', showMa, v => setOpt('F8', 'ma', v)),
        modo === 'dia'
          ? ctrlCheck('mesma escala vertical em todos os dias', mesmaEscala, v => setOpt('F8', 'escala', v))
          : el('span')
      ]));
      const cleaned = {}; let tmin = Infinity, tmax = -Infinity, vmax = 0;
      hemis.forEach(h => {
        const c = C.removeOutliersMAD(d.trend[h], 'lfp', k);
        cleaned[h] = c;
        c.kept.forEach(r => { if (r.t < tmin) tmin = r.t; if (r.t > tmax) tmax = r.t; if (r.lfp > vmax) vmax = r.lfp; });
      });
      const dayMs = 864e5;
      /* Segmentação em dias civis locais, com a MESMA faixa de dias nos dois
         hemisférios — painéis com listas de dias diferentes não se comparam
         linha a linha. O limiar de lacuna sai daqui e vale para os dois modos. */
      const faixa = C.dayRangeOf(hemis.map(h => cleaned[h].kept), offMin());
      const porDia = {};
      hemis.forEach(h => { porDia[h] = C.splitByLocalDay(cleaned[h].kept, offMin(), faixa); });
      const limiarLacuna = Math.min.apply(null,
        hemis.map(h => porDia[h].gapThresholdMs).filter(v => isFinite(v)).concat([Infinity]));
      const maMax = Math.max.apply(null, hemis.flatMap(h => cleaned[h].kept.map(r => r.ma)).filter(isFinite).concat([.1]));

      let boxMulti = null, painelDia = null;
      if (modo === 'dia') painelDia = desenhaDiaADia(node, hemis, porDia, {
        vmax, smooth, showMa, maMax, mesmaEscala, limiarLacuna
      });
      else {
        const box = boxMulti = plotBox(node, 290);
        const ch = new P.Chart(box.canvas, {
          width: box.width, height: box.height, xlim: [tmin, tmax], ylim: [0, vmax * 1.12],
          xlabel: 'data local', ylabel: 'potência LFP (u.a.)', title: 'potência crônica por hemisfério', pad: { l: 62, r: 52, t: 24, b: 42 }
        });
        ch.axes({ nx: 7, xfmt: v => new Date(v + offMin() * 60000).toISOString().slice(5, 10).split('-').reverse().join('/') });
        /* faixas noturnas */
        for (let t = tmin - dayMs; t < tmax + dayMs; t += dayMs) {
          const base = Math.floor((t + offMin() * 60000) / dayMs) * dayMs - offMin() * 60000;
          ch.span(base + 22 * 36e5, base + 30 * 36e5, { color: '#1B3A5C', alpha: .05 });
        }
        hemis.forEach(h => {
          const rows = cleaned[h].kept;
          const xs = rows.map(r => r.t), ys = rows.map(r => r.lfp);
          ch.scatter(xs, ys, { color: hcol(h), size: 1.1, alpha: .28 });
          /* A linha é traçada por segmento, e a caneta levanta na lacuna: ligar
             dois pontos separados por horas de silêncio desenharia um dado que
             não foi medido. A suavização também roda dentro do segmento. */
          segmentosPorLacuna(xs, limiarLacuna).forEach((seg, i) => {
            const sx = xs.slice(seg[0], seg[1]), sy = ys.slice(seg[0], seg[1]);
            const yy = smooth > 1 ? movingMedian(sy, smooth) : sy;
            ch.line(sx, yy, { color: hcol(h), width: smooth > 1 ? 1.6 : .8, label: i === 0 ? `${rotuloLado(h)}` : null });
          });
        });
        if (showMa) {
          hemis.forEach(h => ch.line(cleaned[h].kept.map(r => r.t), cleaned[h].kept.map(r => r.ma / maMax * vmax * .28),
            { color: COL.accent, width: 1, dash: [3, 2] }));
          ch.text(ch.x1 + 6, ch.Y(vmax * .28) - 6, `${f(maMax, 1)} mA`, { color: COL.accent });
          ch.text(ch.x1 + 6, ch.Y(0) - 6, '0 mA', { color: COL.accent });
        }
        ch.legend({ x: ch.x0 + 8, y: ch.y1 + 6 });
      }

      node.appendChild(table(['hemisfério', 'n pontos', 'removidos', 'período', 'mediana', 'IQR', 'MAD'],
        hemis.map(h => {
          const c = cleaned[h], v = c.kept.map(r => r.lfp);
          const t0 = new Date(c.kept[0].t + offMin() * 60000), t1 = new Date(c.kept[c.kept.length - 1].t + offMin() * 60000);
          const days = Math.round((t1 - t0) / dayMs);
          return [{ html: `<span class="hemi-${h[0]}">${hname(h)}</span>` }, { html: String(c.kept.length), cls: 'num' },
          `${c.removed} (${f(100 * c.removed / d.trend[h].length, 1)}%)`,
          `${t0.toISOString().slice(0, 10)} → ${t1.toISOString().slice(0, 10)} (${days} d)`,
          C.median(v), `${f(C.quantile(v, .25))}–${f(C.quantile(v, .75))}`, c.mad];
        })));
      /* No modo dia a dia, a tabela é por dia: cobertura e maior lacuna dizem
         quanto daquele painel é medida e quanto é espaço em branco. Um dia com
         cobertura de 30% desenhado ao lado de um dia completo engana o olho se
         o número não estiver escrito. */
      if (modo === 'dia') {
        const linhas = [];
        hemis.forEach(h => porDia[h].days.forEach(dd => {
          /* contagem entra como texto: n é inteiro, e "87,0 amostras" é errado */
          if (dd.empty) { linhas.push([dd.dayKey, { html: `<span class="hemi-${h[0]}">${hname(h)}</span>` }, { html: '0', cls: 'num' }, '—', '24 h', '—', '—']); return; }
          const v = dd.values.filter(isFinite);
          linhas.push([dd.dayKey, { html: `<span class="hemi-${h[0]}">${hname(h)}</span>` }, { html: String(dd.n), cls: 'num' },
            `${f(100 * dd.coverage, 0)}%`,
            dd.largestGapMin >= 60 ? `${f(dd.largestGapMin / 60, 1)} h` : `${f(dd.largestGapMin, 0)} min`,
            C.median(v), `${f(C.quantile(v, .25))}–${f(C.quantile(v, .75))}`]);
        }));
        linhas.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
        node.appendChild(table(['dia local', 'hemisfério', 'n', 'cobertura', 'maior lacuna', 'mediana', 'IQR'], linhas));
      }
      node.appendChild(exportRow([
        modo === 'dia'
          ? { label: `⤓ PNG de todos os ${painelDia.canvases.length} dias`, fn: () => painelDia.canvases.forEach((cv, i) => P.downloadCanvas(cv, `F8_dia_${painelDia.dias[i]}`)) }
          : { label: '⤓ PNG', fn: () => P.downloadCanvas(boxMulti.canvas, 'F8_timeline_cronico') },
        {
          label: '⤓ CSV completo', fn: () => P.downloadText(P.toCSV(hemis.flatMap(h => d.trend[h].map(r => ({
            hemisferio: h, utc: new Date(r.t).toISOString(),
            local: new Date(r.t + offMin() * 60000).toISOString().slice(0, 19),
            dia_local: C.localDayKey(r.t, offMin()),
            hora_decimal: C.localHour(r.t, offMin()).toFixed(4), lfp: r.lfp, mA: r.ma,
            outlier: Math.abs(r.lfp - cleaned[h].median) > k * cleaned[h].mad ? 1 : 0
          })))), 'F8_timeline.csv', 'text/csv')
        },
        {
          /* Cabeçalhos em inglês: esta tabela é feita para entrar em script de
             R sem renomear coluna. Cada linha carrega os parâmetros que a
             produziram (k do MAD, fator de lacuna, intervalo de amostragem). */
          label: '⤓ CSV por dia', fn: () => P.downloadText(P.toCSV(hemis.flatMap(h => porDia[h].days.map(dd => {
            const v = dd.values.filter(isFinite);
            const ma = dd.rows.map(r => r.ma).filter(isFinite);
            return {
              hemisphere: h, day_local: dd.dayKey, day_index: dd.index + 1,
              n_samples: dd.n, empty_day: dd.empty ? 1 : 0,
              coverage_fraction: isFinite(dd.coverage) ? +dd.coverage.toFixed(4) : '',
              n_gaps: dd.gaps.length, largest_gap_min: +dd.largestGapMin.toFixed(1),
              n_segments: dd.segments.length,
              lfp_median: v.length ? C.median(v) : '', lfp_q1: v.length ? C.quantile(v, .25) : '',
              lfp_q3: v.length ? C.quantile(v, .75) : '',
              ma_median: ma.length ? C.median(ma) : '',
              sampling_ms: isFinite(porDia[h].samplingMs) ? porDia[h].samplingMs : '',
              gap_threshold_ms: isFinite(porDia[h].gapThresholdMs) ? porDia[h].gapThresholdMs : '',
              gap_factor: porDia[h].params.gapFactor, outlier_k_mad: k,
              utc_offset_min: offMin()
            };
          }))), 'F8_por_dia.csv', 'text/csv')
        }
      ]));
      /* D5 — capacidade do Timeline por MODELO, e sobrescrita silenciosa.
         PC: 60 dias · RC: 35 dias. "If new timeline data is collected after an
         INS has already collected the maximal amount of data, then the OLDEST
         DAY WILL BE OVERWRITTEN" — UC202012929cEN FY24, p. 7. */
      {
        const st0 = (S.files[0] || {}).parsed || {};
        const mod = [(st0.device || {}).model, (st0.device || {}).modelNumber].join(' ');
        const ehRC = /B35300|percept\s*rc/i.test(mod);
        const capDias = ehRC ? 35 : 60;
        const spanDias = (tmax - tmin) / dayMs;
        if (spanDias > capDias * 0.85) node.appendChild(el('div', {
          class: 'warnbox', html: `<b>O Timeline está perto do limite do aparelho.</b> Um ` +
            `${ehRC ? 'Percept RC' : 'Percept PC'} guarda <b>${capDias} dias</b>, e este registro cobre ` +
            `${f(spanDias, 0)}. Quando o limite é atingido, <b>o dia mais antigo é sobrescrito</b> — então a ausência ` +
            `de dado antes de ${new Date(tmin + offMin() * 60000).toISOString().slice(0, 10)} <b>não é ausência de ` +
            `registro</b>, e sim possível sobrescrita. [Medtronic UC202012929cEN FY24, p. 7]`
        }));
        /* A1 — a censura do aparelho, junto do gráfico que ela distorce */
        const cens = C.censoringSummary(d.all);
        if (cens.ok && cens.nCensored > 0) node.appendChild(el('div', {
          class: cens.pctCensored >= 20 ? 'warnbox' : 'note',
          html: `<b>Censura do aparelho.</b> ${cens.reading}. ${cens.separateFromPacketLoss}. [${cens.rule}]`
        }));
        node.appendChild(el('div', {
          class: 'note', html: `<b>Unidade.</b> O número do Timeline é a ${C.LFP_POWER_UNIT.label} ` +
            `(${C.LFP_POWER_UNIT.short}). ${C.LFP_POWER_UNIT.scaleWarning}. [${C.LFP_POWER_UNIT.source}]`
        }));
      }
      {
        const amostraMin = Math.min.apply(null, hemis.map(h => porDia[h].samplingMs).filter(isFinite).concat([Infinity]));
        const nVazios = Math.max.apply(null, hemis.map(h => porDia[h].nEmptyDays).concat([0]));
        node.appendChild(el('div', {
          class: 'note', html: `<b>Método.</b> Exclusão de outliers por mediana ± ${k}×MAD (robusto, preferível a média ± DP em distribuição assimétrica). ` +
            `Faixas sombreadas = 22h–06h locais. A linha grossa é mediana móvel de ${smooth} pontos` +
            (isFinite(amostraMin) ? ` (${f(smooth * amostraMin / 60000, 0)} min)` : '') + `, calculada dentro de cada segmento. ` +
            `<b>Lacunas.</b> Intervalo de amostragem medido: ${isFinite(amostraMin) ? f(amostraMin / 60000, 1) + ' min' : '—'}; ` +
            `distância maior que ${isFinite(limiarLacuna) ? f(limiarLacuna / 60000, 0) + ' min' : '—'} (3×) interrompe o traçado, ` +
            `porque ligar dois pontos separados por horas de silêncio desenharia dado que não foi medido. ` +
            (modo === 'dia'
              ? `<b>Apresentação dia a dia.</b> Cada painel é um dia civil local completo (0h–23h59), ` +
                `${mesmaEscala ? 'todos na <b>mesma escala vertical</b>, para que a altura seja comparável entre dias' : 'cada um com <b>escala vertical própria</b> — a forma do dia fica legível, mas a altura <b>não</b> é comparável entre painéis'}. ` +
                (nVazios ? `${nVazios} dia(s) sem nenhuma amostra aparecem como painel vazio em vez de sumir: dia ausente é informação, e encurtar o eixo apagaria isso. ` : '')
              : `<b>Apresentação contínua.</b> Bom para deriva e degrau entre dias; para o padrão diurno, troque para um gráfico por dia. `) +
            `<b>Atenção:</b> artefatos de movimento podem gerar padrão pseudo-diurno — confirme em F9 comparando com uma banda-controle.`
        }));
      }
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
      /* Escala de cor e unidade do detrending são ESCOLHA, e mudam o que o olho
         vê sem mudar um único número. O padrão preto→azul com a mediana do dia
         em 1 é a convenção da literatura de ritmo circadiano de beta; o
         divergente com a mediana em 100 é mais direto para leitura clínica. */
      const escalaCor = opt('F9', 'cmap', detr ? 'pretoazul' : 'viridis');
      const unidade = opt('F9', 'unidade', 'ratio');
      const rotuloDia = opt('F9', 'rotulo', 'data');
      const razao = detr && unidade === 'ratio';
      const uni = !detr ? 'u.a.' : razao ? '× a mediana do dia' : '% da mediana do dia';
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('hemisfério', hemis.map(x => ({ value: x, label: rotuloLado(x) })), h, v => setOpt('F9', 'hemi', v)),
        ctrlCheck('detrending diário (cada dia pela própria mediana)', detr, v => setOpt('F9', 'detrend', v)),
        detr ? ctrlSelect('unidade', [{ value: 'ratio', label: '× da mediana (1 = mediana)' }, { value: 'percent', label: '% da mediana (100 = mediana)' }], unidade, v => setOpt('F9', 'unidade', v)) : el('span'),
        ctrlSelect('escala de cor', [
          { value: 'pretoazul', label: 'preto → azul' }, { value: 'divergent', label: 'divergente (azul-branco-vermelho)' },
          { value: 'viridis', label: 'viridis' }, { value: 'magma', label: 'magma' }, { value: 'ice', label: 'gelo' }
        ], escalaCor, v => setOpt('F9', 'cmap', v)),
        ctrlSelect('eixo dos dias', [{ value: 'data', label: 'data' }, { value: 'numero', label: 'número do dia' }], rotuloDia, v => setOpt('F9', 'rotulo', v)),
        ctrlSelect('bin', [{ value: 15, label: '15 min' }, { value: 30, label: '30 min' }, { value: 60, label: '60 min' }], binMin, v => setOpt('F9', 'bin', +v)),
        ctrlSelect('harmônicos', ['24', '24+12'], harm, v => setOpt('F9', 'harm', v)),
        ctrlNumber('bootstrap', nBoot, 50, 2000, 50, v => setOpt('F9', 'boot', v))
      ]));
      const clean = C.removeOutliersMAD(d.trend[h], 'lfp', 4).kept;
      const dp = C.diurnalProfile(clean, offMin(), binMin, { detrend: detr, unit: unidade });
      if (dp.days.length < 2) return node.appendChild(el('div', { class: 'empty', text: 'São necessários ao menos 2 dias de registro.' }));

      /* heatmap dia × hora */
      /* altura por dia: linha fina demais e o padrão diurno de um dia vira um
         fio; a altura total fica aproximadamente constante e o registro longo
         só comprime até o limite em que ainda se distingue uma linha da outra */
      const alturaDia = Math.max(4, Math.min(14, 300 / Math.max(1, dp.days.length)));
      const box = plotBox(node, Math.max(190, Math.round(50 + dp.days.length * alturaDia)));
      const M = dp.matrix.map(m => m.values);
      const flat = M.flat().filter(isFinite).sort((a, b) => a - b);
      const ch = new P.Chart(box.canvas, {
        width: box.width, height: box.height, xlim: [0, 24], ylim: [0, dp.days.length],
        xlabel: 'hora local', ylabel: rotuloDia === 'numero' ? 'dia do registro' : 'dia',
        title: `(a) dia × hora — ${rotuloLado(h)}${detr ? ' (cada dia normalizado pela própria mediana)' : ''}`,
        pad: { l: 76, r: 70, t: 24, b: 40 }
      });
      ch.heat(M, {
        cmap: escalaCor, origin: 'top',
        zmin: flat[Math.floor(flat.length * .02)], zmax: flat[Math.floor(flat.length * .98)], smooth: false
      });
      const step = Math.max(1, Math.ceil(dp.days.length / 12));
      const nDias = dp.days.length;
      /* com origin 'top' a primeira linha fica em cima: o rótulo do valor v do
         eixo se refere ao dia de índice nDias - ceil(v) */
      const diaDe = v => dp.days[nDias - Math.ceil(v)];
      ch.axes({
        grid: false, xticks: [0, 3, 6, 9, 12, 15, 18, 21, 24], xfmt: v => String(v).padStart(2, '0') + 'h',
        yticks: dp.days.map((_, i) => nDias - i - .5).filter((_, i) => i % step === 0),
        yfmt: v => rotuloDia === 'numero'
          ? String(nDias - Math.ceil(v) + 1)
          : (diaDe(v) || '').slice(5).split('-').reverse().join('/')
      });
      ch.colorbar({
        label: uni,
        /* marcar a mediana do dia na barra: sem ela o leitor não sabe onde fica
           o "sem variação", que é a referência de toda a figura */
        ticks: detr ? [ch._z.zmin, razao ? 1 : 100, ch._z.zmax] : null,
        fmt: v => razao ? v.toFixed(2) : v.toFixed(0)
      });

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
        xlabel: 'hora local', ylabel: detr ? uni : 'potência LFP',
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

      /* --- o cosinor supõe senoide; o ritmo do beta muitas vezes não é ------
         As quatro medidas não paramétricas da cronobiologia da actigrafia não
         fazem essa suposição. Elas descrevem a FORMA do ritmo; o cosinor acima
         testa se ele EXISTE. As duas leituras só valem juntas. */
      const act = C.actigraphyPanel(clean, offMin(), {});
      node.appendChild(el('h4', { class: 'qc-title', html: '<b>(d) O ritmo tem forma de senoide? — medidas não paramétricas</b>' }));
      if (!act.ok) {
        node.appendChild(el('div', { class: 'note', html: `<b>Não calculado.</b> ${act.reason}` }));
      } else {
        node.appendChild(table(['medida', 'valor', 'o que responde', 'leitura'], [
          ['IS — estabilidade interdiária', f(act.IS, 3), 'o ritmo se repete de um dia para o outro?',
            act.detail.interdailyStability.interpretation || '—'],
          ['IV — variabilidade intradiária', f(act.IV, 3), 'o ritmo é liso ou picado dentro do dia?',
            act.detail.intradailyVariability.interpretation || '—'],
          ['M10', `${f(act.M10, 2)} (às ${act.M10startHour}h)`, 'as 10 h de maior média e onde começam', '—'],
          ['L5', `${f(act.L5, 2)} (às ${act.L5startHour}h)`, 'as 5 h de menor média e onde começam', '—'],
          ['RA — amplitude relativa', f(act.RA, 3), '(M10 − L5)/(M10 + L5), sem depender da unidade',
            'comparável entre pacientes e entre registros de escalas diferentes']
        ]));
        node.appendChild(el('div', { class: 'note', html: `<b>Por que ao lado do cosinor.</b> ${act.caveat}. ` +
          `Uma amplitude de cosinor baixa com RA alta é a assinatura de um ritmo real que não é senoidal — sobe rápido ao ` +
          `acordar, tem platô, cai por degraus com as tomadas. A senoide não segue os cantos e subestima a amplitude.` }));
        node.appendChild(el('div', { class: 'seal', text:
          `${act.quality.nDaysUsed} dia(s) usados · ${act.quality.nDaysExcluded} excluído(s) por cobertura < ` +
          `${Math.round(act.quality.minCoverage * 100)}% dos bins · bin de ${act.params.binMin} min · ` +
          `resumo do bin por ${act.params.binStatistic}` }));
      }

      node.appendChild(exportRow([
        { label: '⤓ PNG heatmap', fn: () => P.downloadCanvas(box.canvas, 'F9a_heatmap_dia_hora') },
        { label: '⤓ PNG perfil', fn: () => P.downloadCanvas(b2.canvas, 'F9b_perfil_diurno') },
        { label: '⤓ PNG polar', fn: () => P.downloadCanvas(b3.canvas, 'F9c_polar') },
        { label: '⤓ CSV perfil', fn: () => P.downloadText(P.toCSV(dp.hours.map((x, i) => ({ hora: x, mediana: dp.profile[i], q1: dp.q1[i], q3: dp.q3[i], unidade: dp.unit, bin_min: dp.binMin }))), 'F9_perfil.csv', 'text/csv') },
        { label: '⤓ CSV matriz', fn: () => P.downloadText(P.toCSV(dp.matrix.flatMap(m => m.values.map((v, i) => ({ dia: m.day, hora: dp.hours[i], valor: v, unidade: dp.unit, mediana_do_dia: m.dayMedian, n_do_dia: m.n, bin_min: dp.binMin })))), 'F9_matriz.csv', 'text/csv') }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Método.</b> Normalização de cada dia pela própria mediana antes do heatmap (obrigatória: deriva entre dias mascara o ritmo), ` +
          `em <b>${uni}</b> — a unidade sai junto no CSV. A escala de cor é escolha de apresentação e não muda nenhum número: ` +
          `o preto→azul deixa o mapa escuro na maior parte do tempo e destaca só o que sobe acima da mediana do dia, que é a convenção ` +
          `da literatura de ritmo circadiano de beta; o divergente separa melhor o que está <i>abaixo</i> da mediana. ` +
          `Perfil = mediana por bin de ${binMin} min dentro de cada dia, depois mediana entre dias. Cosinor por mínimos quadrados com harmônicos de ${periods.join(' e ')} h; ` +
          `IC por bootstrap de blocos com reamostragem <b>de dias inteiros</b> (preserva a autocorrelação intradiária).`
      }));
    }
  },

  /* ----------------------------------------------------------------- F10 */
  {
    id: 'F10', title: 'Resposta alinhada a evento',
    sub: 'janela −60 / +180 min em torno do RECEBIMENTO do evento pelo neuroestimulador',
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
        ctrlSelect('hemisfério', hemis.map(x => ({ value: x, label: rotuloLado(x) })), h, v => setOpt('F10', 'hemi', v)),
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
        title: `"${evName}" — ${al.nTrials} ocorrências · ${rotuloLado(h)}`, pad: { l: 66, r: 14, t: 24, b: 42 }
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
        ctrlSelect('hemisfério', hemis.map(x => ({ value: x, label: rotuloLado(x) })), h, v => setOpt('F11', 'hemi', v)),
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
    sub: 'LfpFrequencySnapshotEvents — PSD dos 30 s POSTERIORES à marcação do paciente',
    has: d => d.snapshots.length,
    render(node, d) {
      const names = Array.from(new Set(d.snapshots.map(s => s.name)));
      const hemis = Array.from(new Set(d.snapshots.flatMap(s => Object.keys(s.hemi))));
      const h = opt('F12', 'hemi', hemis[0]);
      const showAll = opt('F12', 'all', false);
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('hemisfério', hemis.map(x => ({ value: x, label: rotuloLado(x) })), h, v => setOpt('F12', 'hemi', v)),
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
        xlabel: 'frequência (Hz)', ylabel: 'magnitude (µVp)', title: `espectro mediano por evento — ${rotuloLado(h)}`, pad: { l: 62, r: 14, t: 24, b: 42 }
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
      /* D3 — o que o snapshot É, com fonte. UC202012929cEN FY24, p. 8. */
      node.appendChild(el('div', {
        class: 'note', html: '<b>O que este espectro cobre.</b> O aparelho mede aproximadamente <b>30 s de sinal ' +
          'DEPOIS</b> de receber a marcação do paciente, converte para o domínio da frequência e guarda <b>só o ' +
          'espectro médio</b>. Em janela alinhada a evento, o snapshot representa <b>[0, +30 s]</b> — não uma janela ' +
          'centrada no botão. E o domínio do tempo do snapshot <b>não existe</b>: ele não é gravado na memória do ' +
          'neuroestimulador, e é por isso que esta figura só pode trabalhar com espectro. ' +
          '[Medtronic UC202012929cEN FY24, p. 8]'
      }));
      }
      /* ---- o acumulado e o "vídeo" dos snapshots -------------------------
         O programador mostra cada snapshot isolado — a foto. Aqui entram as
         duas leituras que faltam lá: o ESPECTRO ACUMULADO de todas as janelas
         de 30 s (com o tempo total de sensing que elas somam) e a FITA
         CRONOLÓGICA — cada snapshot vira uma coluna, ordenada no tempo, e a
         sequência de fotos vira o vídeo. Sugestão clínica de Rubens Cury.   */
      {
        const todosH = d.snapshots.filter(s => s.hemi[h] && s.hemi[h].f.length)
          .slice().sort((a, b) => a.t - b.t);
        if (todosH.length >= 2) {
          const f0 = todosH[0].hemi[h].f;
          const nb = Math.min.apply(null, todosH.map(s => s.hemi[h].p.length).concat([f0.length]));
          const idxMax = f0.findIndex(x => x > fmax) === -1 ? nb : Math.min(nb, f0.findIndex(x => x > fmax));
          /* (a) espectro acumulado: média e IQR bin a bin sobre TODAS as janelas */
          const med2 = [], q1 = [], q3 = [];
          for (let k = 0; k < idxMax; k++) {
            const vs = todosH.map(s => s.hemi[h].p[k]).filter(isFinite);
            med2.push(C.median(vs)); q1.push(C.quantile(vs, .25)); q3.push(C.quantile(vs, .75));
          }
          const minutos = todosH.length * 30 / 60;
          const boxA = plotBox(node, 210);
          const chA = new P.Chart(boxA.canvas, {
            width: boxA.width, height: boxA.height, xlim: [0, fmax],
            ylim: [0, Math.max.apply(null, q3.filter(isFinite)) * 1.15 || 1],
            xlabel: 'frequência (Hz)', ylabel: 'magnitude (µVp)',
            title: `espectro acumulado de TODOS os snapshots — ${rotuloLado(h)} · n=${todosH.length} janelas ≈ ${f(minutos, 0)} min de sensing`,
            pad: { l: 62, r: 14, t: 24, b: 40 }
          });
          chA.axes();
          chA.area(f0.slice(0, idxMax), q1, q3, { color: hcol(h), alpha: .18 });
          chA.line(f0.slice(0, idxMax), med2, { color: hcol(h), width: 2, label: `mediana das ${todosH.length} janelas` });
          chA.legend({ x: chA.x1 - 190, y: chA.y1 + 6 });

          /* (b) a fita cronológica: snapshot × frequência, ordenado no tempo */
          const alt = 190;
          const boxF = plotBox(node, alt);
          const cv = boxF.canvas;
          cv.width = boxF.width; cv.height = alt; cv.style.height = alt + 'px';
          const ctx = cv.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, alt);
          const mL = 46, mT = 14, mB = 30, wPlot = cv.width - mL - 8, hPlot = alt - mT - mB;
          const todosVals = todosH.flatMap(s => s.hemi[h].p.slice(0, idxMax)).filter(isFinite);
          const vlo = C.quantile(todosVals, .02), vhi = C.quantile(todosVals, .98);
          const wCol = wPlot / todosH.length;
          const corDe = {}; groups.forEach(g => corDe[g.name] = g.color);
          todosH.forEach((s, i) => {
            const x0 = mL + i * wCol;
            for (let k = 0; k < idxMax; k++) {
              const v = s.hemi[h].p[k];
              if (!isFinite(v)) { ctx.fillStyle = '#EEF1F4'; }
              else {
                const fr = Math.max(0, Math.min(1, (v - vlo) / (vhi - vlo || 1)));
                const c = Math.round(235 - fr * 200);
                ctx.fillStyle = `rgb(${c},${Math.round(c * 1.02)},${Math.min(255, c + 42)})`;
              }
              const y0 = mT + hPlot - (k + 1) / idxMax * hPlot;
              ctx.fillRect(x0, y0, Math.ceil(wCol), Math.ceil(hPlot / idxMax) + 1);
            }
            /* fita do tipo de evento no topo — a legenda das cores é a da figura */
            ctx.fillStyle = corDe[s.name] || '#888';
            ctx.fillRect(x0, 2, Math.ceil(wCol), 8);
          });
          /* eixo y (Hz) e datas no eixo x */
          ctx.fillStyle = '#5C7284'; ctx.font = '9px ui-monospace,monospace';
          ctx.textAlign = 'right';
          [0, 15, 30, 45].forEach(hz => {
            if (hz > fmax) return;
            const y = mT + hPlot - hz / fmax * hPlot;
            ctx.fillText(hz + ' Hz', mL - 4, y + 3);
          });
          ctx.textAlign = 'center';
          const passoRotulo = Math.max(1, Math.ceil(todosH.length / 8));
          todosH.forEach((s, i) => {
            if (i % passoRotulo) return;
            ctx.fillText(new Date(s.t + offMin() * 60000).toISOString().slice(5, 10), mL + (i + .5) * wCol, alt - 16);
          });
          ctx.fillStyle = '#0E1A24'; ctx.textAlign = 'left'; ctx.font = '10px ui-monospace,monospace';
          ctx.fillText(`fita cronológica: cada coluna é um snapshot de 30 s (a faixa no topo é o tipo de evento) — a sequência de fotos vista como vídeo`, mL, alt - 4);
          try {
            cv.setAttribute('role', 'img');
            cv.setAttribute('aria-label', `fita cronológica dos ${todosH.length} snapshots de 30 segundos do hemisfério ${hname(h)}, ordenados no tempo`);
          } catch (e) { }
          node.appendChild(el('div', {
            class: 'note', html: `<b>O acumulado e o vídeo.</b> O programador mostra cada snapshot isolado — a foto. ` +
              `Acima, as duas leituras que faltam lá: o <b>espectro acumulado</b> das ${todosH.length} janelas de 30 s ` +
              `(≈ ${f(minutos, 0)} min de sensing somado, mediana e IQR bin a bin) e a <b>fita cronológica</b>, em que a ` +
              `sequência vira um vídeo: mudanças do espectro ao longo de dias ficam visíveis como mudança de textura da fita. ` +
              `Cada janela cobre os 30 s <b>posteriores</b> ao botão [Medtronic UC202012929cEN FY24, p. 8].`
          }));
        }
      }
      node.appendChild(exportRow([
        { label: '⤓ PNG', fn: () => P.downloadCanvas(box.canvas, 'F12_espectros_evento') },
        { label: '⤓ CSV', fn: () => P.downloadText(P.toCSV(d.snapshots.flatMap(s => Object.keys(s.hemi).flatMap(hh => s.hemi[hh].f.map((x, k) => ({ utc: new Date(s.t).toISOString(), evento: s.name, hemisferio: hh, f_Hz: x, magnitude: s.hemi[hh].p[k] }))))), 'F12_snapshots.csv', 'text/csv') }
      ]));
    }
  },

  /* ----------------------------------------------------------------- F37 */
  /* Percentis de vigília em escala clínica (7–14 dias). Sugestão de Rubens
     Cury: o método manual de limiares usa os percentis 25/75 do beta diurno
     (Busch 2025), mas visualmente esse dado não existe no programador — cada
     dia aparece isolado. Aqui a distribuição da vigília vira figura: banda
     P25–P75 dia a dia, e as linhas agregadas da janela escolhida, que são os
     números que o método manual usaria. O núcleo vive em metrics/chronic.js
     (wakePercentiles) e usa o MESMO detector de vigília do TIDAL-DT.        */
  {
    id: 'F37', title: 'Percentis de vigília — 7–14 dias em escala',
    sub: 'banda P25–P75 do beta acordado, dia a dia · os agregados da janela são os números do método manual de limiares',
    has: d => Object.keys(d.trend).length,
    render(node, d) {
      const hemis = Object.keys(d.trend);
      const janela = opt('F37', 'win', 14);
      const kMad = opt('F37', 'mad', 4);
      const modoVigilia = opt('F37', 'vigilia', 'auto');
      const vIni = opt('F37', 'vini', 8), vFim = opt('F37', 'vfim', 22);
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('janela', [{ value: 7, label: 'últimos 7 dias' }, { value: 14, label: 'últimos 14 dias' }, { value: 0, label: 'registro inteiro' }],
          janela, v => setOpt('F37', 'win', +v)),
        ctrlSelect('vigília', [{ value: 'auto', label: 'automática (cosinor + change-point)' }, { value: 'fixa', label: 'janela fixa (horas abaixo)' }],
          modoVigilia, v => setOpt('F37', 'vigilia', v)),
        modoVigilia === 'fixa' ? ctrlNumber('início (h)', vIni, 0, 23, 1, v => setOpt('F37', 'vini', v)) : el('span'),
        modoVigilia === 'fixa' ? ctrlNumber('fim (h)', vFim, 1, 24, 1, v => setOpt('F37', 'vfim', v)) : el('span'),
        ctrlNumber('outliers: k×MAD', kMad, 2, 10, .5, v => setOpt('F37', 'mad', v))
      ]));

      const csvRows = [];
      hemis.forEach(h => {
        const r = C.wakePercentiles(d.trend[h], offMin(), {
          kMad, lastDays: janela,
          wake: modoVigilia === 'fixa' ? [vIni, vFim] : null
        });
        node.appendChild(el('h3', { class: 'qc-title', html: `<span class="hemi-${h[0]}">${rotuloLado(h)}</span> — percentis da vigília` }));
        if (!r.ok) {
          node.appendChild(el('div', { class: 'warnbox', html: `<b>Não calculável.</b> ${r.reason}` }));
          return;
        }
        const box = plotBox(node, 230);
        {
          const xs = r.days.map((_, i) => i);
          const ymax = Math.max.apply(null, r.days.map(x => x.p75)) * 1.18;
          const ch = new P.Chart(box.canvas, {
            width: box.width, height: box.height, xlim: [-0.5, r.days.length - 0.5], ylim: [0, ymax],
            xlabel: 'dia', ylabel: 'potência LFP (u.a.)',
            title: `vigília ${r.wake.wake[0]}–${r.wake.wake[1]} h · banda P25–P75 por dia e agregado de ${r.aggregate.nDays} dias`,
            pad: { l: 62, r: 88, t: 24, b: 46 }
          });
          const passo = Math.max(1, Math.ceil(r.days.length / 9));
          ch.axes({ xticks: xs.filter(i => i % passo === 0), xfmt: v => (r.days[Math.round(v)] || { dayKey: '' }).dayKey.slice(5) });
          ch.area(xs, r.days.map(x => x.p25), r.days.map(x => x.p75), { color: hcol(h), alpha: .2 });
          ch.line(xs, r.days.map(x => x.p50), { color: hcol(h), width: 1.8, label: 'mediana diária (vigília)' });
          /* as duas linhas que o método manual usaria como limiares iniciais */
          ch.hline(r.aggregate.p25, { color: COL.ok, width: 1.5, dash: [6, 3] });
          ch.hline(r.aggregate.p75, { color: COL.Right, width: 1.5, dash: [6, 3] });
          ch.text(ch.x1 + 5, ch.Y(r.aggregate.p25) + 3, `P25 = ${r.aggregate.p25}`, { color: COL.ok });
          ch.text(ch.x1 + 5, ch.Y(r.aggregate.p75) + 3, `P75 = ${r.aggregate.p75}`, { color: COL.Right });
          ch.legend({ x: ch.x0 + 8, y: ch.y1 + 6 });
        }
        node.appendChild(table(['agregado da janela', 'valor (LFP nativo)'], [
          ['P25 (vigília)', r.aggregate.p25], ['P50 (vigília)', r.aggregate.p50], ['P75 (vigília)', r.aggregate.p75],
          ['n de amostras · dias', `${r.aggregate.n} · ${r.aggregate.nDays} (${r.aggregate.from} → ${r.aggregate.to})`],
          ['estabilidade dia a dia (CV%)', `P25: ${r.stability.p25CvPct}% · P75: ${r.stability.p75CvPct}%`],
          ['vigília', `${r.wake.wake[0]}–${r.wake.wake[1]} h — ${r.wake.method}`]
        ]));
        r.days.forEach(dd => csvRows.push({
          hemisphere: h, day_local: dd.dayKey, n_wake_samples: dd.n,
          p25_lfp: dd.p25, p50_lfp: dd.p50, p75_lfp: dd.p75,
          aggregate_p25: r.aggregate.p25, aggregate_p50: r.aggregate.p50, aggregate_p75: r.aggregate.p75,
          window_days: r.params.lastDays, wake_window: `${r.wake.wake[0]}-${r.wake.wake[1]}`,
          wake_method: r.wake.method, outlier_k_mad: kMad, utc_offset_min: offMin()
        }));
      });

      node.appendChild(el('div', {
        class: 'note', html: `<b>Para que servem estas linhas.</b> Os percentis 25/75 do beta <b>diurno</b> são o ` +
          `método manual de escolha inicial dos limiares de aDBS [Busch et al., npj Parkinsons Dis 2025;11:264, ` +
          `doi:10.1038/s41531-025-01124-7] — e o programador não mostra essa distribuição. A vigília é obrigatória: ` +
          `a hora do dia explica grande parte da variância do beta crônico, e incluir o sono puxa o P25 para baixo ` +
          `[doi:10.1038/s41531-022-00350-7; doi:10.1038/s41467-023-41128-6]. A detecção de vigília é a MESMA do ` +
          `TIDAL-DT (F36) — um único par de percentis por paciente, não um por módulo. A estabilidade dia a dia diz ` +
          `se vale esperar mais dias antes de fixar limiares. Os valores estão em unidades LFP nativas, as mesmas ` +
          `digitadas no programador.`
      }));
      if (csvRows.length) node.appendChild(exportRow([
        { label: '⤓ CSV (R-compatible)', fn: () => P.downloadText(P.toCSV(csvRows), 'F37_wake_percentiles.csv', 'text/csv') }
      ]));
    }
  },

  /* ----------------------------------------------------------------- F39 */
  /* Arquitetura do sono estimada SÓ do LFP crônico — método de Averna et al.
     (Mov Disord 2026, doi:10.1002/mds.70493) adaptado para a ausência de
     sensor vestível. O núcleo vive em core/metrics/sleep.js (C.SLEEP); a
     figura só orquestra: hipnograma por noite em épocas de 10 min, tabela de
     arquitetura e agregado comparado à coorte do artigo, com as ressalvas
     por combinação de biomarcadores sempre visíveis.                        */
  {
    id: 'F39', title: 'Arquitetura do sono estimada do LFP',
    sub: 'hipnograma por noite (épocas de 10 min) sem sensores · centróides de Averna 2026 · Vigília / REM / NREM leve / NREM profundo',
    has: d => Object.keys(d.trend).length,
    render(node, d) {
      avisoDeAlvo(node, 'Os centróides de estágio vêm de registros do NST (Averna 2026); no GPi o beta se sustenta durante o sono (Yin 2023) e o estadiamento não se transfere');
      const S = C.SLEEP;
      const hemis = Object.keys(d.trend);
      const modo = opt('F39', 'modo', 'auto');
      const bedH = opt('F39', 'bed', 23);
      const riseH = opt('F39', 'rise', 7);
      const minCov = opt('F39', 'mincov', 100 * S.DEFAULTS.minNightCoverage);
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('janela de sono', [
          { value: 'auto', label: 'automática (cosinor + change-point, âncora circadiana)' },
          { value: 'manual', label: 'horários habituais (como o artigo configurava o sensor)' }
        ], modo, v => setOpt('F39', 'modo', v)),
        modo === 'manual' ? ctrlNumber('deitar (h)', bedH, 0, 24, 0.5, v => setOpt('F39', 'bed', v)) : el('span'),
        modo === 'manual' ? ctrlNumber('levantar (h)', riseH, 0, 24, 0.5, v => setOpt('F39', 'rise', v)) : el('span'),
        ctrlNumber('cobertura mínima da noite (%)', minCov, 30, 100, 5, v => setOpt('F39', 'mincov', v))
      ]));

      /* frequência de sensing por hemisfério → tipo de biomarcador */
      const th = C.collectThresholds(d.all);
      const centros = {};
      hemis.forEach(h => { centros[h] = th[h] ? th[h].centerFreq : NaN; });

      const res = S.sleepPipeline(d.trend, centros, offMin(), {
        sleepMode: modo, bedH, riseH, minNightCoverage: minCov / 100
      });
      if (!res.ok) {
        node.appendChild(el('div', { class: 'warnbox', html: `<b>Não calculável.</b> ${res.reason}` }));
        return;
      }

      /* tabela dos biomarcadores usados — a suposição de beta, quando houver,
         aparece aqui e não some */
      node.appendChild(table(['hemisfério', 'biomarcador (tipo)', 'limpeza'], res.biomarkers.map(b => [
        rotuloLado(b.hemisphere),
        b.label + (b.assumed ? ' ⚠' : ''),
        `${b.nRejected} de ${b.nFinite} amostras rejeitadas (Hampel)`
      ])));
      if (res.biomarkers.some(b => b.assumed)) node.appendChild(el('div', {
        class: 'warnbox', html: `<b>Suposição declarada.</b> Pelo menos um hemisfério não declara a frequência de sensing no ` +
          `arquivo; a série foi tratada como <b>beta</b> (a banda de sensing padrão do Percept). Se o sensing estava em outra ` +
          `banda, o estadiamento abaixo está errado — confira a configuração na F31.`
      }));

      const cores = { awake: '#E2903B', rem: '#7B5EA7', core: '#5B8FC9', deep: '#1B4A72' };
      const durH = (((res.sleep[1] - res.sleep[0]) % 24) + 24) % 24;

      /* (a) hipnograma: uma linha por noite, épocas de 10 min coloridas */
      const rowH = 16, gapH = 5, mL = 84, mT = 34, mB = 34;
      const alt = mT + res.nights.length * (rowH + gapH) + mB;
      const box = plotBox(node, alt);
      const cv = box.canvas;
      cv.width = box.width; cv.height = alt; cv.style.height = alt + 'px';
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, alt);
      const wPlot = cv.width - mL - 12;
      /* legenda no topo */
      {
        let x = mL;
        ctx.font = '10px ui-monospace,monospace'; ctx.textBaseline = 'middle';
        S.STAGES.forEach(st => {
          ctx.fillStyle = cores[st]; ctx.fillRect(x, 8, 12, 10);
          ctx.fillStyle = '#0E1A24'; ctx.textAlign = 'left';
          const lb = S.STAGE_LABELS[st].split(' (')[0];
          ctx.fillText(lb, x + 16, 13);
          x += 16 + ctx.measureText(lb).width + 14;
        });
        ctx.globalAlpha = .40; ctx.fillStyle = cores.core; ctx.fillRect(x, 8, 12, 10); ctx.globalAlpha = 1;
        ctx.fillStyle = '#0E1A24'; ctx.fillText('translúcido = baixa confiança (margem < ' + res.params.marginFloor + ' z)', x + 16, 13);
      }
      res.nights.forEach((n, i) => {
        const y0 = mT + i * (rowH + gapH);
        const wEp = wPlot / n.nEpochs;
        for (let e = 0; e < n.nEpochs; e++) {
          const st = n.stages[e];
          if (!st) { ctx.fillStyle = '#EEF1F4'; ctx.globalAlpha = 1; }
          else { ctx.fillStyle = cores[st]; ctx.globalAlpha = n.lowConfidence[e] ? .40 : 1; }
          ctx.fillRect(mL + e * wEp, y0, Math.ceil(wEp), rowH);
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = n.ok ? '#0E1A24' : '#B0433C';
        ctx.textAlign = 'right'; ctx.font = '10px ui-monospace,monospace';
        ctx.fillText(n.nightKey.slice(5) + (n.ok ? '' : ' ✕'), mL - 6, y0 + rowH / 2);
      });
      /* eixo de horas da noite */
      ctx.fillStyle = '#5C7284'; ctx.textAlign = 'center'; ctx.font = '9px ui-monospace,monospace';
      const nTicks = Math.min(12, Math.max(4, Math.round(durH)));
      for (let k = 0; k <= nTicks; k++) {
        const hh = (res.sleep[0] + durH * k / nTicks) % 24;
        ctx.fillText(`${Math.floor(hh)}:${String(Math.round((hh % 1) * 60)).padStart(2, '0')}`,
          mL + wPlot * k / nTicks, alt - mB + 12);
      }
      ctx.fillStyle = '#0E1A24'; ctx.textAlign = 'left'; ctx.font = '10px ui-monospace,monospace';
      ctx.fillText(`janela de sono ${res.sleep[0]}–${res.sleep[1]} h (${res.wake.method}) · ✕ = noite excluída do agregado`, mL, alt - 8);
      try {
        cv.setAttribute('role', 'img');
        cv.setAttribute('aria-label', `hipnograma estimado de ${res.nights.length} noites em épocas de 10 minutos, estágios vigília, REM, NREM leve e NREM profundo`);
      } catch (e) { }

      /* (b) arquitetura por noite */
      node.appendChild(el('h3', { class: 'qc-title', text: 'Arquitetura por noite (épocas classificadas)' }));
      node.appendChild(table(
        ['noite', 'cobertura', 'TST est. (h)', 'latência (min)', 'WASO (min)', 'despertares', 'vigília %', 'REM %', 'NREM leve %', 'NREM prof. %', 'baixa conf. %'],
        res.nights.filter(n => n.architecture).map(n => [
          n.nightKey + (n.ok ? '' : ' ✕'),
          f(100 * n.coverage, 0) + '%',
          n.architecture.tstH, isFinite(n.architecture.solMin) ? n.architecture.solMin : '—',
          n.architecture.wasoMin, n.architecture.nAwakenings,
          n.architecture.pct.awake, n.architecture.pct.rem, n.architecture.pct.core, n.architecture.pct.deep,
          f(100 * n.nLowConfidence / Math.max(1, n.nClassified), 0) + '%'
        ])));
      if (res.excluded.length) node.appendChild(el('div', {
        class: 'note', html: `<b>Noites excluídas do agregado (${res.excluded.length}):</b> ` +
          res.excluded.map(x => `${x.night} — ${x.reason}`).join(' · ')
      }));

      /* (c) agregado vs coorte do artigo */
      const agg = res.aggregate;
      if (agg.pct) {
        const iqr = m => m ? `${m.median} (${m.q1}–${m.q3})` : '—';
        node.appendChild(el('h3', { class: 'qc-title', text: `Agregado de ${agg.nNightsOk} noites vs coorte de Averna 2026` }));
        node.appendChild(table(['métrica', 'este registro — mediana (IQR)', 'coorte do artigo (18 pacientes, vestível)'], [
          ['vigília noturna %', iqr(agg.pct.awake), res.cohortRef.awakePct + '%'],
          ['REM %', iqr(agg.pct.rem), res.cohortRef.remPct + '%'],
          ['NREM leve (Core) %', iqr(agg.pct.core), res.cohortRef.corePct + '%'],
          ['NREM profundo (Deep) %', iqr(agg.pct.deep), res.cohortRef.deepPct + '%'],
          ['tempo de sono estimado (h)', iqr(agg.tstH), res.cohortRef.tstH + ' h'],
          ['WASO (min)', iqr(agg.wasoMin), '—'],
          ['épocas de baixa confiança', agg.lowConfidencePct + '%', '—']
        ]));
        if (!agg.ok) node.appendChild(el('div', { class: 'warnbox', html: `<b>Agregado insuficiente.</b> ${agg.reason}` }));
      }

      /* (d) ressalvas do método — sempre visíveis, nunca em <details> */
      node.appendChild(el('div', {
        class: 'warnbox', html: `<b>Limites do método (combinação disponível: ${res.combo}).</b><ul style="margin:4px 0 0 18px">` +
          res.caveats.map(c => `<li>${c}</li>`).join('') + '</ul>'
      }));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Método.</b> Reprodução adaptada de Averna et al., Mov Disord 2026 ` +
          `[doi:10.1002/mds.70493]: potência do Timeline em épocas de 10 min, z-score por intervalo de sono ` +
          `(a normalização do artigo) e estágio pelo centróide mais próximo usando os z medianos por estágio da ` +
          `Fig. 3C (${res.centroidSource.split('—')[1] || 'digitalizados'}). No artigo o intervalo de sono e os rótulos de treino vinham de um ` +
          `relógio (Apple Watch); aqui, sem sensor, a janela vem ${res.params.sleepMode === 'manual' ? 'dos horários habituais informados' : 'do detector circadiano do TIDAL-DT'} ` +
          `e a classificação é não supervisionada — leia como estimativa de pesquisa, não como polissonografia. ` +
          `${S.DISCLAIMER}`
      }));

      node.appendChild(exportRow([
        { label: '⤓ PNG', fn: () => P.downloadCanvas(cv, 'F39_hipnograma_lfp') },
        { label: '⤓ CSV épocas (R-compatible)', fn: () => P.downloadText(P.toCSV(S.sleepCsvRows(res)), 'F39_sleep_epochs.csv', 'text/csv') },
        {
          label: '⤓ CSV noites', fn: () => P.downloadText(P.toCSV(res.nights.filter(n => n.architecture).map(n => ({
            night_local: n.nightKey, included: n.ok ? 1 : 0, coverage: n.coverage,
            tst_est_h: n.architecture.tstH, sol_min: n.architecture.solMin, waso_min: n.architecture.wasoMin,
            n_awakenings: n.architecture.nAwakenings, transitions_per_h: n.architecture.transitionsPerH,
            awake_pct: n.architecture.pct.awake, rem_pct: n.architecture.pct.rem,
            core_pct: n.architecture.pct.core, deep_pct: n.architecture.pct.deep,
            low_confidence_pct: +(100 * n.nLowConfidence / Math.max(1, n.nClassified)).toFixed(1),
            combo: res.combo, sleep_window_local: `${res.sleep[0]}-${res.sleep[1]}`,
            sleep_window_method: res.wake.method, version: S.VERSION
          }))), 'F39_sleep_architecture.csv', 'text/csv')
        }
      ]));
    }
  },

  /* ----------------------------------------------------------------- F40 */
  /* Pipeline de referência do cronotipo (van Rheede 2022) — a resposta padrão
     da área para "existe ritmo diurno?" com VE, permutação circular por dia,
     VE dia/noite, flag de bimodalidade (discinesia) e especificidade de
     banda. O núcleo vive em core/metrics/chronotype.js (C.CHRONOTYPE).      */
  {
    id: 'F40', title: 'Cronotipo do marcador — pipeline de van Rheede',
    sub: 'variância explicada pela hora do dia · permutação circular por dia · bimodalidade como alarme de discinesia',
    has: d => Object.keys(d.trend).length,
    render(node, d) {
      const CT = C.CHRONOTYPE;
      const hemis = Object.keys(d.trend);
      const nPerm = opt('F40', 'nperm', 1000);
      const binMin = opt('F40', 'bin', 30);
      const zThr = opt('F40', 'z', 6);
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlNumber('permutações', nPerm, 100, 2000, 100, v => setOpt('F40', 'nperm', v)),
        ctrlNumber('bin (min)', binMin, 10, 120, 10, v => setOpt('F40', 'bin', v)),
        ctrlNumber('outlier |z| >', zThr, 3, 10, 0.5, v => setOpt('F40', 'z', v))
      ]));

      const resultados = {};
      const csvRows = [];
      hemis.forEach(h => {
        const r = CT.chronotypePipeline(d.trend[h], offMin(), { nPermutations: nPerm, binMinutes: binMin, zThreshold: zThr });
        resultados[h] = r;
        node.appendChild(el('h3', { class: 'qc-title', html: `<span class="hemi-${h[0]}">${rotuloLado(h)}</span> — cronotipo` }));
        if (!r.ok) {
          node.appendChild(el('div', { class: 'warnbox', html: `<b>Não calculável.</b> ${r.reason}` }));
          return;
        }
        /* (a) perfil por bin de 30 min, na escala destendida (mediana diária = 1) */
        const box = plotBox(node, 210);
        {
          const vs = r.profile.values.filter(isFinite);
          const ch = new P.Chart(box.canvas, {
            width: box.width, height: box.height, xlim: [0, 24],
            ylim: [Math.min.apply(null, vs) * 0.95, Math.max.apply(null, vs) * 1.08],
            xlabel: 'hora local', ylabel: 'potência ÷ mediana do dia',
            title: `perfil médio por bin de ${r.profile.binMinutes} min · VE = ${(100 * r.ve).toFixed(1)}% · p(permutação) = ${r.permutation.p}`,
            pad: { l: 62, r: 14, t: 24, b: 40 }
          });
          ch.axes({ nx: 8 });
          ch.hline(1, { color: '#9AA7B4', width: 1, dash: [4, 3] });
          ch.line(r.profile.hours, r.profile.values, { color: hcol(h), width: 2 });
        }
        /* (b) números do pipeline */
        node.appendChild(table(['métrica', 'este registro', 'publicado (van Rheede 2022, n=6)'], [
          ['variância explicada pela hora do dia', `${(100 * r.ve).toFixed(1)}% (p = ${r.permutation.p}, ${r.permutation.nPermutations} permutações circulares)`, '41 ± 9% (p<0,001 em todos)'],
          ['VE dentro da vigília (08–20 h)', isFinite(r.veDay.ve) ? (100 * r.veDay.ve).toFixed(1) + '%' : '—', '13 ± 11%'],
          ['VE dentro do sono (00–06 h)', isFinite(r.veNight.ve) ? (100 * r.veNight.ve).toFixed(1) + '%' : '—', '14 ± 13%'],
          ['limiar do nulo (95º percentil)', (100 * r.permutation.null95).toFixed(1) + '%', '—'],
          ['outliers |z|>' + r.params.zThreshold + ' substituídos', `${r.outliers.nReplaced} (${r.outliers.iterations} iteração(ões)) — interpolação do método publicado, contada`, '18 ± 23 por série'],
          ['dias · amostras', `${r.nDays} · ${r.nSamples}`, '34 ± 13 dias']
        ]));
        /* (c) bimodalidade diurna — o alarme de discinesia */
        if (r.bimodality.ok) node.appendChild(el('div', {
          class: r.bimodality.flag ? 'warnbox' : 'note',
          html: `<b>Distribuição diurna${r.bimodality.flag ? ' — BIMODAL' : ''}.</b> BC de Sarle = ${r.bimodality.sarleBC} ` +
            `(limiar 0,555) · d de Ashman = ${r.bimodality.ashmanD} (limiar 2). ${r.bimodality.reading}.`
        }));
        r.profile.hours.forEach((hh, i) => csvRows.push({
          hemisphere: h, bin_center_hour: hh, mean_detrended: r.profile.values[i], n_samples: r.profile.counts[i],
          ve: r.ve, ve_p: r.permutation.p, ve_day: r.veDay.ve, ve_night: r.veNight.ve,
          n_outliers_replaced: r.outliers.nReplaced, bimodality_flag: r.bimodality.ok && r.bimodality.flag ? 1 : 0,
          n_permutations: r.permutation.nPermutations, bin_minutes: r.profile.binMinutes,
          z_threshold: r.params.zThreshold, utc_offset_min: offMin()
        }));
      });

      /* (d) especificidade: correlação entre os dois hemisférios destendidos */
      if (hemis.length === 2 && resultados[hemis[0]].ok && resultados[hemis[1]].ok) {
        const [hA, hB] = hemis;
        const rA = resultados[hA], rB = resultados[hB];
        const spec = CT.bandSpecificityCheck(d.trend[hA], rA.detrended, d.trend[hB], rB.detrended, {});
        node.appendChild(el('div', {
          class: spec.ok && spec.suspicious ? 'warnbox' : 'note',
          html: `<b>Especificidade de banda (passo 8)${spec.ok && spec.suspicious ? ' — SUSPEITA DE ARTEFATO COMUM' : ''}.</b> ` +
            (spec.ok
              ? `Correlação entre as séries destendidas dos dois hemisférios: r = ${spec.r} (n = ${spec.n}). ${spec.reading}. ` +
                `Faixa publicada: ${spec.published}.`
              : `Não verificável: ${spec.reason}.`)
        }));
      }

      node.appendChild(el('div', {
        class: 'note', html: `<b>Método.</b> Reprodução passo a passo do pipeline de van Rheede et al. ` +
          `[doi:10.1038/s41531-022-00350-7; toolbox original Circa Diem, doi:10.5281/zenodo.5961105]: outliers |z|>6 ` +
          `interpolados iterativamente (contagem exportada), detrending pela mediana diária, ajuste por bins de 30 min, ` +
          `VE e permutação circular por dia (preserva a autocorrelação intradiária, destrói só o alinhamento entre dias; ` +
          `semente fixa). O confundimento central está declarado no artigo: ritmo circadiano fisiológico e ritmo dos ` +
          `artefatos (ECG, movimento) são temporalmente sincronizados pela atividade — um perfil diurno pode ser ` +
          `fisiologia, artefato, ou os dois. A bimodalidade diurna e a correlação inter-hemisférica são os dois ` +
          `indicadores indiretos que o próprio artigo recomenda inspecionar. No GPi o cronotipo difere ` +
          `(beta sustentado no sono — Yin 2023) e a comparação com os números publicados (STN) não se transfere.`
      }));
      if (csvRows.length) node.appendChild(exportRow([
        { label: '⤓ CSV (R-compatible)', fn: () => P.downloadText(P.toCSV(csvRows), 'F40_chronotype_vanrheede.csv', 'text/csv') }
      ]));
    }
  },

  /* ----------------------------------------------------------------- F41 */
  /* Janela de estabilização pós-operatória (stun effect): change-point da
     mediana diária (de Neeling 2026) + taxa de variação e RQA (Feldmann
     2025). O núcleo vive em core/metrics/stun.js (C.STUN).                  */
  {
    id: 'F41', title: 'Estabilização pós-operatória — stun effect',
    sub: 'change-point da mediana diária · 22–40 dias é a janela publicada · não fixe limiares antes de ~1 mês',
    has: d => Object.keys(d.trend).length,
    render(node, d) {
      const ST = C.STUN;
      const hemis = Object.keys(d.trend);
      const implantAuto = (d.all[0] && d.all[0].device && d.all[0].device.implantDate) ? String(d.all[0].device.implantDate).slice(0, 10) : '';
      const implantUser = opt('F41', 'implant', '');
      const implante = implantUser || implantAuto;
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlText('data de implante (AAAA-MM-DD)', implantUser || implantAuto, implantAuto ? implantAuto + ' (do arquivo)' : 'não consta do arquivo — informe',
          v => setOpt('F41', 'implant', v))
      ]));

      const csvRows = [];
      hemis.forEach(h => {
        const r = ST.stunAnalysis(d.trend[h], offMin(), { implantDate: implante || null });
        node.appendChild(el('h3', { class: 'qc-title', html: `<span class="hemi-${h[0]}">${rotuloLado(h)}</span> — mediana diária e mudança de regime` }));
        if (!r.ok) {
          node.appendChild(el('div', { class: 'warnbox', html: `<b>Não calculável.</b> ${r.reason}` }));
          return;
        }
        /* (a) mediana diária com os change-points */
        const box = plotBox(node, 210);
        {
          const xs = r.days.map((_, i) => i);
          const vs = r.dailyMedians.filter(isFinite);
          const ch = new P.Chart(box.canvas, {
            width: box.width, height: box.height, xlim: [-0.5, r.nDays - 0.5],
            ylim: [Math.min.apply(null, vs) * 0.9, Math.max.apply(null, vs) * 1.1],
            xlabel: isFinite(r.implant.startPostOpDay) ? 'dia pós-implante' : 'dia do registro',
            ylabel: 'mediana diária (LFP nativo)',
            title: `veredito: ${r.verdict}` + (r.changePoints.length ? ` · ${r.changePoints.length} change-point(s)` : ''),
            pad: { l: 66, r: 14, t: 24, b: 40 }
          });
          const rotX = i => isFinite(r.implant.startPostOpDay) ? String(r.implant.startPostOpDay + Math.round(i)) : r.days[Math.round(i)].slice(5);
          const passo = Math.max(1, Math.ceil(r.nDays / 9));
          ch.axes({ xticks: xs.filter(i => i % passo === 0), xfmt: rotX });
          ch.line(xs, r.dailyMedians, { color: hcol(h), width: 1.8 });
          r.changePoints.forEach(pt => {
            const x = pt.index + 0.5;
            ch.ctx.strokeStyle = '#B0433C'; ch.ctx.lineWidth = 1.5; ch.ctx.setLineDash([5, 3]);
            ch.ctx.beginPath(); ch.ctx.moveTo(ch.X(x), ch.y0); ch.ctx.lineTo(ch.X(x), ch.y1); ch.ctx.stroke();
            ch.ctx.setLineDash([]);
          });
        }
        /* (b) tabela de change-points e métricas convergentes */
        if (r.changePoints.length) node.appendChild(table(
          ['change-point (dia local)', 'dia pós-implante', 'p (permutação)', 'nível antes → depois'],
          r.changePoints.map(pt => [pt.dayKey, isFinite(pt.postOpDay) ? pt.postOpDay : '—', pt.p, `${pt.levelBefore} → ${pt.levelAfter}`])));
        node.appendChild(table(['métrica convergente', 'primeira metade', 'segunda metade'], [
          ['taxa de variação diária (fração da mediana global)', f(100 * r.rate.earlyMean, 1) + '%', f(100 * r.rate.lateMean, 1) + '%'],
          ['RQA — taxa de recorrência', r.rqa.early.ok ? r.rqa.early.recurrenceRate : '—', r.rqa.late.ok ? r.rqa.late.recurrenceRate : '—'],
          ['RQA — laminaridade', r.rqa.early.ok ? r.rqa.early.laminarity : '—', r.rqa.late.ok ? r.rqa.late.laminarity : '—'],
          ['RQA — determinismo', r.rqa.early.ok ? r.rqa.early.determinism : '—', r.rqa.late.ok ? r.rqa.late.determinism : '—']
        ]));
        r.warnings.forEach(w => node.appendChild(el('div', { class: 'warnbox', html: `<b>Atenção.</b> ${w}.` })));
        node.appendChild(el('div', { class: 'note', html: `<b>Ambiguidade declarada.</b> ${r.aperiodicCaveat}.` }));
        r.days.forEach((dk, i) => csvRows.push({
          hemisphere: h, day_local: dk,
          post_op_day: isFinite(r.implant.startPostOpDay) ? r.implant.startPostOpDay + i : NaN,
          daily_median_lfp: r.dailyMedians[i], daily_rate_of_change: r.rate.series[i],
          is_change_point: r.changePoints.some(pt => pt.dayKey === dk) ? 1 : 0,
          verdict: r.verdict, implant_date: r.implant.date || '', utc_offset_min: offMin()
        }));
      });

      node.appendChild(el('div', {
        class: 'note', html: `<b>Método e por que importa.</b> Duas metodologias independentes convergem: change-point da ` +
          `mediana diária de beta muda de regime em <b>24–40 dias</b> pós-implante (de Neeling et al., Mov Disord 2026, n=32 ` +
          `[doi:10.1002/mds.70042]) e taxa de variação + quantificação de recorrência estabilizam em <b>22–29 dias</b> ` +
          `(Feldmann et al., Brain Stimul 2025, n=14 [doi:10.1016/j.brs.2025.08.002]). A implicação prática: seleção de ` +
          `contato e limiares de aDBS baseados em eletrofisiologia antes de ~1 mês pós-implante são pouco confiáveis. ` +
          `O beta NÃO cai com a ativação da DBS nesse período — continua subindo (efeito da microlesão se dissipando). ` +
          `Este painel posiciona o SEU registro nessa janela; o TIDAL-DT (F36) e o assistente de contato devem ler o ` +
          `veredito antes de propor números.`
      }));
      if (csvRows.length) node.appendChild(exportRow([
        { label: '⤓ CSV (R-compatible)', fn: () => P.downloadText(P.toCSV(csvRows), 'F41_stun_effect.csv', 'text/csv') }
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
      Object.keys(d.trend).forEach(h => src.push({ value: 'tl' + h, label: `Timeline crônico — ${rotuloLado(h)}`, kind: 'timeline', hemi: h }));
      if (!src.length) return node.appendChild(el('div', { class: 'empty', text: 'Sem streaming nem Timeline.' }));
      const cur = src.find(s => s.value === opt('F13', 'src', src[0].value)) || src[0];
      /* a banda dos estados segue a banda primária do perfil — o 13–30 fixo
         assumia beta subtalâmico para qualquer alvo */
      const pbF13 = activeProfile().primaryBand || { lo: 13, hi: 30 };
      const lo = opt('F13', 'lo', Math.round(pbF13.lo)), hi = opt('F13', 'hi', Math.round(pbF13.hi));

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
    has: d => d.bsTimeDomain.length || d.montageTD.length || (d.electrodeIdentifier || []).length || (d.indefiniteStreaming || []).length,
    render(node, d) {
      const src = [].concat(
        d.bsTimeDomain.map((t, i) => ({ value: 'bs' + i, label: `Streaming ${t.label} (${(t.data.length / t.fs).toFixed(0)} s)`, td: t })),
        d.montageTD.map((t, i) => ({ value: 'mt' + i, label: `Survey ${t.hemisphere[0]}·${t.label} (${(t.data.length / t.fs).toFixed(0)} s)`, td: t })),
        (d.indefiniteStreaming || []).map((t, i) => ({ value: 'is' + i, label: `Record ${t.hemisphere[0]}·${t.label} (${(t.data.length / t.fs).toFixed(0)} s)`, td: t })),
        (d.electrodeIdentifier || []).map((t, i) => ({ value: 'ei' + i, label: `Identifier ${t.hemisphere[0]}·${t.label} → ref ${t.referenceElectrode || '?'} (${(t.data.length / t.fs).toFixed(0)} s)`, td: t })));
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
          html: `<span class="hemi-${linha.hemisphere[0]}">${rotuloLado(linha.hemisphere)}</span> · ` +
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
        node.appendChild(el('h4', { class: 'qc-title', html: `<b>${rotuloLado(h.hemisphere)}</b> — critérios` }));
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
        ctrlSelect('hemisfério', hemis.map(x => ({ value: x, label: rotuloLado(x) })), h, v => setOpt('F23', 'hemi', v)),
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
  },

  /* ----------------------------------------------------------------- F24 */
  {
    id: 'F24', title: 'Sinal externo — IMU, EMG ou ECG: alinhamento e coerência',
    sub: 'importa CSV/TSV, sincroniza com o LFP e mede acoplamento com limiar corrigido',
    has: d => d.bsTimeDomain.length || d.montageTD.length,
    render(node, d) {
      const tds = d.bsTimeDomain.concat(d.montageTD);
      if (!tds.length) return node.appendChild(el('div', { class: 'empty', text: 'Sem sinal bruto de LFP para comparar.' }));

      /* ---- importação ------------------------------------------------- */
      const barra = el('div', { class: 'ctrls' });
      const entrada = el('input', {
        type: 'file', accept: '.csv,.tsv,.txt,text/csv', id: 'extFile',
        style: 'display:none',
        onchange: e => {
          const f = e.target.files && e.target.files[0];
          e.target.value = '';
          if (f) carregaExterno(f);
        }
      });
      barra.appendChild(entrada);
      barra.appendChild(el('button', {
        class: 'btn' + (S.external ? '' : ' primary'),
        text: S.external ? '↻ trocar arquivo externo' : '+ carregar sinal externo (CSV/TSV)',
        onclick: () => { const i = document.getElementById('extFile'); if (i) i.click(); }
      }));
      if (S.external) barra.appendChild(el('button', {
        class: 'btn', text: '× remover',
        onclick: () => { S.external = null; renderFigureAsync('F24'); }
      }));
      node.appendChild(barra);

      if (!S.external) {
        node.appendChild(el('div', {
          class: 'empty', html:
            `Carregue um arquivo <b>CSV ou TSV</b> com uma coluna de tempo e um ou mais canais numéricos — ` +
            `acelerômetro/giroscópio (IMU), EMG de superfície, ECG ou qualquer sinal contínuo gravado em paralelo.<br><br>` +
            `<b>Por que isto responde perguntas que o LFP sozinho não responde:</b> em tremor, saber se a oscilação do ` +
            `STN é do cérebro ou é o próprio tremor entrando pelo eletrodo; em distonia cervical, se o pico teta-alfa do ` +
            `GPi é biomarcador ou é o tremor cefálico de 1–6 Hz batendo em cima dele.<br><br>` +
            `<span style="color:var(--ink-3)">O arquivo é lido no próprio navegador e não sai deste dispositivo, ` +
            `como todo o resto.</span>`
        }));
        return;
      }

      const ext = S.external;
      if (!ext.parsed.ok) return node.appendChild(el('div', {
        class: 'warnbox', html: `<b>Não foi possível ler "${ext.name}".</b> ${ext.parsed.reason}.`
      }));

      const p = ext.parsed;
      node.appendChild(table(['propriedade', 'valor', 'observação'], [
        ['arquivo', ext.name, `${p.nSamples.toLocaleString('pt-BR')} amostras · ${f(p.durationSec, 1)} s`],
        ['delimitador / cabeçalho', `"${p.delimiter}" · linha ${p.headerRow + 1}`, p.nRowsDropped ? `${p.nRowsDropped} linha(s) descartada(s)` : 'todas as linhas consistentes'],
        ['coluna de tempo', `${p.timeColumnName || '#' + (p.timeColumn + 1)}`, p.timeInterpretation],
        ['frequência de amostragem', `${f(p.fs, 2)} Hz`, `passo típico ${f(p.sampleIntervalMs, 3)} ms · irregularidade ${f(p.jitterPct, 1)}%`],
        ['canais numéricos', String(p.channels.length), p.channels.map(c => `${c.name} (${c.kind})`).join(' · ')],
        ['lacunas', String(p.gaps.length), p.gaps.length ? 'nada foi interpolado' : 'amostragem contínua']
      ]));
      p.warnings.forEach(w => node.appendChild(el('div', { class: 'warnbox', html: `<b>Atenção.</b> ${w}.` })));

      /* ---- seleção e alinhamento -------------------------------------- */
      const iLfp = opt('F24', 'lfp', 0);
      const iExt = opt('F24', 'ch', 0);
      const metodo = opt('F24', 'sync', p.absoluteTime ? 'timestamp' : 'xcorr');
      const manualMs = opt('F24', 'manual', 0);
      const cbLo = opt('F24', 'clo', 2), cbHi = opt('F24', 'chi', 12);
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('canal de LFP', tds.map((t, i) => ({ value: i, label: `${t.label} (${hname(t.hemisphere)})` })), iLfp, v => setOpt('F24', 'lfp', +v)),
        ctrlSelect('canal externo', p.channels.map((c, i) => ({ value: i, label: `${c.name} [${c.kind}]` })), iExt, v => setOpt('F24', 'ch', +v)),
        ctrlSelect('sincronização', [
          { value: 'timestamp', label: 'timestamp declarado' },
          { value: 'xcorr', label: 'correlação cruzada' },
          { value: 'stim', label: 'artefato de estimulação' },
          { value: 'manual', label: 'deslocamento manual' }
        ], metodo, v => setOpt('F24', 'sync', v)),
        ctrlNumber('deslocamento manual (ms)', manualMs, -60000, 60000, 50, v => setOpt('F24', 'manual', v)),
        ctrlNumber('coerência de (Hz)', cbLo, 1, 60, 1, v => setOpt('F24', 'clo', v)),
        ctrlNumber('coerência até (Hz)', cbHi, 2, 90, 1, v => setOpt('F24', 'chi', v))
      ]));

      const td = tds[Math.min(iLfp, tds.length - 1)];
      const canal = p.channels[Math.min(iExt, p.channels.length - 1)];
      const fsL = td.fsEff || td.fs;
      qualitySeal(node, td);

      /* o externo vai para a MESMA grade do LFP; sem isso, coerência não existe */
      const re = C.resampleUniform(p.tMs, canal.data, fsL, {});
      if (!re) return node.appendChild(el('div', { class: 'empty', text: 'Não foi possível reamostrar o canal externo para a frequência do LFP.' }));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Reamostragem.</b> O canal externo foi levado de ${f(p.fs, 1)} Hz para ` +
          `${f(fsL, 1)} Hz (a do LFP), porque coerência exige a mesma grade temporal. ${re.note}; ` +
          `${f(re.pctNaN, 2)}% das amostras ficaram NaN.`
      }));

      /* alinhamento */
      let al = null;
      const lfpDados = td.data;
      if (metodo === 'timestamp') {
        const t0L = td.firstPacketMs != null ? td.firstPacketMs : (td.t0 != null ? td.t0 : NaN);
        al = C.alignByTimestamp(t0L, p.absoluteTime ? p.tMs[0] : NaN);
      } else if (metodo === 'xcorr') {
        al = C.alignByCrossCorrelation(lfpDados, re.data, fsL, { band: [cbLo, cbHi], maxLagSec: 5, nSurrogates: 150 });
      } else if (metodo === 'stim') {
        al = C.alignByStimArtifact(lfpDados, re.data, fsL, {});
      } else {
        al = { ok: true, method: 'deslocamento manual', lagMs: manualMs, confidence: 'informado pelo usuário', caveat: 'valor digitado; nenhuma verificação foi feita contra o sinal' };
      }

      node.appendChild(el('h4', { class: 'qc-title', html: '<b>Sincronização</b>' }));
      if (!al.ok) node.appendChild(el('div', { class: 'warnbox', html: `<b>${al.method}: não foi possível alinhar.</b> ${al.reason}.` }));
      else {
        node.appendChild(table(['item', 'valor', 'o que sustenta'], [
          ['método', al.method, al.confidence ? `confiança: ${al.confidence}` : '—'],
          ['deslocamento', `${f(al.lagMs, 1)} ms`, isFinite(al.peakHalfWidthMs) ? `incerteza ±${f(al.peakHalfWidthMs, 0)} ms` : (al.nEvents ? `${al.nEvents} evento(s) em comum` : '—')],
          ...(isFinite(al.correlation) ? [['correlação no pico', f(al.correlation, 3), `z = ${f(al.z, 2)} contra ${al.nSurrogates} surrogados, p = ${f(al.pEmpirical, 4)}`]] : []),
          ...(isFinite(al.spreadMs) ? [['dispersão entre eventos', `${f(al.spreadMs, 0)} ms`, al.nEvents > 1 ? 'concordância entre eventos' : 'um único evento']] : [])
        ]));
        node.appendChild(el('div', {
          class: (al.confidence === 'alta') ? 'note' : 'warnbox',
          html: `<b>Ressalva do alinhamento.</b> ${al.caveat}`
        }));
      }

      /* aplica o deslocamento e recorta a sobreposição */
      const desloc = al.ok && isFinite(al.lagMs) ? Math.round(al.lagMs * fsL / 1000) : 0;
      const n = Math.min(lfpDados.length, re.data.length);
      const ini = Math.max(0, desloc), fim = Math.min(n, re.data.length - Math.max(0, -desloc));
      const nComum = Math.max(0, fim - ini);
      if (nComum < 4 * fsL) return node.appendChild(el('div', {
        class: 'empty', text: `Depois do deslocamento de ${f(al.lagMs || 0, 0)} ms sobram menos de 4 s em comum entre os dois sinais — insuficiente para coerência.`
      }));
      const a = new Float64Array(nComum), b = new Float64Array(nComum);
      for (let i = 0; i < nComum; i++) { a[i] = lfpDados[ini + i]; b[i] = re.data[ini + i - desloc]; }

      /* ---- gráficos ---------------------------------------------------- */
      const passo = Math.max(1, Math.floor(nComum / 1400));
      const tx = [], ya = [], yb = [];
      const na = C.nanStats(a), nb = C.nanStats(b);
      const escA = na.n ? 1 : 1;
      let maxA = 0, maxB = 0;
      for (let i = 0; i < nComum; i++) { if (isFinite(a[i])) maxA = Math.max(maxA, Math.abs(a[i])); if (isFinite(b[i])) maxB = Math.max(maxB, Math.abs(b[i])); }
      for (let i = 0; i < nComum; i += passo) { tx.push(i / fsL); ya.push(a[i] / (maxA || 1)); yb.push(b[i] / (maxB || 1)); }
      const box = plotBox(node, 220);
      const ch = new P.Chart(box.canvas, {
        width: box.width, height: box.height, xlim: [0, nComum / fsL], ylim: [-2.4, 1.2],
        xlabel: 'tempo (s)', ylabel: 'amplitude normalizada',
        title: `(a) LFP e ${canal.name} depois do alinhamento (${f(al.lagMs || 0, 0)} ms)`,
        pad: { l: 68, r: 14, t: 24, b: 42 }
      });
      ch.axes();
      ch.line(tx, ya, { color: hcol(td.hemisphere), width: .9, label: `LFP ${td.label}` });
      ch.line(tx, yb.map(v => v - 1.4), { color: COL.accent, width: .9, label: canal.name });
      ch.legend({ x: ch.x1 - 150, y: ch.y1 + 6 });

      /* coerência */
      const coh = C.coherence(a, b, fsL, { nperseg: Math.min(1024, Math.pow(2, Math.floor(Math.log2(nComum / 4)))), overlap: .5 });
      if (!coh.cxy) return node.appendChild(el('div', { class: 'empty', text: coh.reason }));
      const resumo = C.coherenceBand(coh, cbLo, cbHi);

      const fmaxG = Math.min(60, fsL / 2);
      const idx = []; for (let i = 0; i < coh.f.length; i++) if (coh.f[i] <= fmaxG) idx.push(i);
      const b2 = plotBox(node, 250);
      const ch2 = new P.Chart(b2.canvas, {
        width: b2.width, height: b2.height, xlim: [0, fmaxG], ylim: [0, 1],
        xlabel: 'frequência (Hz)', ylabel: 'coerência (Cxy)',
        title: `(b) coerência LFP × ${canal.name} — ${coh.nSegments} segmentos (${coh.nSegmentsEffective} efetivos)`,
        pad: { l: 62, r: 14, t: 24, b: 42 }
      });
      ch2.axes();
      ch2.span(cbLo, Math.min(cbHi, fmaxG), { color: COL.accent, alpha: .08, label: 'banda avaliada' });
      ch2.line(idx.map(i => coh.f[i]), idx.map(i => coh.cxy[i]), { color: COL.ink, width: 1.5, label: 'coerência' });
      ch2.line(idx.map(i => coh.f[i]), idx.map(i => Math.abs(coh.imagCoherency[i])), { color: COL.warn, width: 1.2, dash: [4, 3], label: '|parte imaginária|' });
      ch2.hline(coh.significanceThreshold, { color: COL.muted, dash: [3, 3], label: 'limiar por bin' });
      if (resumo) ch2.hline(resumo.thresholdBandCorrected, { color: COL.right, dash: [5, 3], label: 'limiar corrigido' });
      ch2.legend({ x: ch2.x1 - 160, y: ch2.y1 + 6 });

      if (resumo) {
        node.appendChild(table(['métrica', 'valor', 'o que significa'], [
          ['coerência de pico', `${f(resumo.peakCoherence, 3)} em ${f(resumo.peakHz, 2)} Hz`, resumo.significant ? 'acima do limiar corrigido' : 'abaixo do limiar corrigido'],
          ['coerência média na banda', f(resumo.meanCoherence, 3), `mediana ${f(resumo.medianCoherence, 3)}`],
          ['limiar por bin', f(resumo.threshold, 3), `sob a nula, ${coh.nSegmentsEffective} segmentos efetivos dão ${f(coh.expectedNullCoherence, 3)} em média`],
          ['limiar corrigido para a banda', f(resumo.thresholdBandCorrected, 3), `correção de Šidák sobre os ${resumo.nBins} bins da banda`],
          ['fase e parte imaginária no pico', `${f(resumo.phaseAtPeakDeg, 0)}° · imag ${f(resumo.imagAtPeak, 3)}`, resumo.volumeConductionSuspected ? 'fase praticamente zero — compatível com condução de volume ou referência comum' : 'há defasagem real, incompatível com mistura instantânea'],
          ['atraso estimado', isFinite(resumo.preferredLagMs) ? `${f(resumo.preferredLagMs, 1)} ms` : '—', `${resumo.preferredLagSource}; ambíguo a cada ${f(resumo.lagAmbiguityMs, 0)} ms`]
        ]));
        node.appendChild(el('div', {
          class: resumo.significant && !resumo.volumeConductionSuspected ? 'note' : 'warnbox',
          html: `<b>Leitura.</b> ${resumo.interpretation}.`
        }));
      }

      {
        const sp = C.SYNC_PROTOCOL;
        node.appendChild(el('div', {
          class: 'note', html: '<b>Protocolo de sincronização recomendado pelo fabricante.</b><br>' +
            '<b>Grosseira (segundos):</b> ' + sp.coarse.map((x, n) => `${n + 1}. ${x}`).join('; ') +
            `. <i>${sp.coarseNote}.</i><br>` +
            '<b>Fina (sub-segundo):</b> ' + sp.fine.map((x, n) => `${n + 1}. ${x}`).join('; ') +
            `. <i>${sp.fineNote}.</i><br>` + sp.cycling + `. [${sp.source}]`
        }));
        node.appendChild(el('div', {
          class: 'warnbox', html: '<b>O piso de incerteza do alinhamento por carimbo é ±1000 ms.</b> ' +
            'O <code>FirstPacketDateTime</code> do Percept tem resolução de <b>1 segundo</b> — o piso é por ' +
            'construção, antes de qualquer deriva de relógio. Para resolução sub-segundo, o alinhamento por ' +
            'artefato de estimulação não é preferível: é <b>necessário</b>. ' +
            '[Medtronic UC202012929cEN FY24, p. 21–24]'
        }));
      }
      node.appendChild(exportRow([
        { label: '⤓ PNG alinhamento', fn: () => P.downloadCanvas(box.canvas, 'F24a_alinhamento') },
        { label: '⤓ PNG coerência', fn: () => P.downloadCanvas(b2.canvas, 'F24b_coerencia') },
        {
          label: '⤓ CSV coerência', fn: () => P.downloadText(P.toCSV(idx.map(i => ({
            hz: +coh.f[i].toFixed(4), coerencia: +coh.cxy[i].toFixed(6),
            fase_rad: +coh.phaseRad[i].toFixed(6), imaginaria: +coh.imagCoherency[i].toFixed(6),
            limiar_bin: coh.significanceThreshold, n_segmentos: coh.nSegments,
            metodo_sync: al.method, deslocamento_ms: al.lagMs
          }))), 'F24_coerencia.csv', 'text/csv')
        }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Três armadilhas tratadas aqui.</b> ` +
          `(1) Coerência é <b>inflada por poucos segmentos</b>: sob a nula ela vale 1/L, não zero — com ` +
          `${coh.nSegmentsEffective} segmentos efetivos, dois ruídos independentes dariam ${f(coh.expectedNullCoherence, 3)}. ` +
          `(2) Tomar o máximo sobre os bins da banda é comparação múltipla; o limiar corrigido acima já leva isso em conta. ` +
          `(3) <b>Condução de volume e referência comum</b> produzem coerência de fase zero sem interação nenhuma — ` +
          `por isso a parte imaginária vem sempre junto, porque só sobrevive nela o que teve atraso de propagação.`
      }));
    }
  },

  /* ----------------------------------------------------------------- F25 */
  {
    id: 'F25', title: 'Actograma e banda-controle — o ritmo é específico?',
    sub: 'duplo-plot com deriva de fase · marcador vs. banda-controle por permutação de cluster',
    has: d => Object.keys(d.trend).length || d.snapshots.length,
    render(node, d) {
      const hemis = Object.keys(d.trend);
      const h = opt('F25', 'hemi', hemis[0]);
      const binMin = opt('F25', 'bin', 30);
      const norm = opt('F25', 'norm', true);
      const pb = profileBands().primary || { lo: 13, hi: 35 };
      const cLo = opt('F25', 'clo', 55), cHi = opt('F25', 'chi', 95);
      node.appendChild(el('div', { class: 'ctrls' }, [
        hemis.length ? ctrlSelect('hemisfério', hemis.map(x => ({ value: x, label: rotuloLado(x) })), h, v => setOpt('F25', 'hemi', v)) : el('span', { class: 'exphint', text: 'sem Timeline' }),
        ctrlSelect('bin', [{ value: 15, label: '15 min' }, { value: 30, label: '30 min' }, { value: 60, label: '60 min' }], binMin, v => setOpt('F25', 'bin', +v)),
        ctrlCheck('normalizar cada dia', norm, v => setOpt('F25', 'norm', v)),
        ctrlNumber('banda-controle de (Hz)', cLo, 1, 120, 5, v => setOpt('F25', 'clo', v)),
        ctrlNumber('banda-controle até (Hz)', cHi, 5, 125, 5, v => setOpt('F25', 'chi', v))
      ]));

      /* ---------------- (a) actograma duplo-plot ----------------------- */
      if (hemis.length) {
        const limpo = C.removeOutliersMAD(d.trend[h], 'lfp', 4).kept;
        const ac = C.actogram(limpo, offMin(), { binMin, normalizeDaily: norm });
        if (!ac.ok) node.appendChild(el('div', { class: 'empty', text: ac.reason }));
        else {
          const box = plotBox(node, Math.max(200, 54 + ac.days.length * 8));
          const M = ac.rows.map(r => r.values);
          const ch = new P.Chart(box.canvas, {
            width: box.width, height: box.height, xlim: [0, 48], ylim: [0, ac.days.length],
            xlabel: 'hora local (dois dias por linha)', ylabel: 'dia',
            title: `(a) actograma duplo-plot — ${rotuloLado(h)}, ${ac.days.length} dias`,
            pad: { l: 76, r: 62, t: 24, b: 42 }
          });
          ch.heat(M, { cmap: norm ? 'divergent' : 'viridis', origin: 'top', zmin: ac.zmin, zmax: ac.zmax, smooth: false });
          const passo = Math.max(1, Math.ceil(ac.days.length / 14));
          const nDiasA = ac.days.length;
          ch.axes({
            grid: false, xticks: [0, 6, 12, 18, 24, 30, 36, 42, 48],
            xfmt: v => String(v % 24).padStart(2, '0') + 'h',
            yticks: ac.days.map((_, i) => nDiasA - i - .5).filter((_, i) => i % passo === 0),
            yfmt: v => (ac.days[nDiasA - Math.ceil(v)] || '').slice(5).split('-').reverse().join('/')
          });
          ch.vline(24, { color: COL.ink, width: 1.2, dash: [4, 3] });
          ch.colorbar({ label: norm ? '% mediana do dia' : 'u.a.' });

          node.appendChild(table(['item', 'valor', 'leitura'], [
            ['dias registrados', String(ac.days.length), `bin de ${ac.binMin} min · ${norm ? 'cada dia normalizado pela própria mediana' : 'escala absoluta'}`],
            ['deriva do horário do pico', isFinite(ac.medianDriftHoursPerDay) ? `${f(ac.medianDriftHoursPerDay, 2)} h/dia` : '—',
              isFinite(ac.totalDriftHours) ? `acumula ${f(Math.abs(ac.totalDriftHours), 1)} h no período` : '—'],
            ['acrofase por dia', ac.acrophaseByDay.filter(isFinite).slice(0, 8).map(v => f(v, 1) + 'h').join(' · ') + (ac.days.length > 8 ? ' …' : ''),
              'média circular do perfil, ponderada — não o bin de máximo, que salta com ruído']
          ]));
          node.appendChild(el('div', {
            class: Math.abs(ac.medianDriftHoursPerDay) >= 0.15 ? 'warnbox' : 'note',
            html: `<b>Deriva de fase.</b> ${ac.driftNote}. ${ac.note}.`
          }));
          node.appendChild(exportRow([
            { label: '⤓ PNG actograma', fn: () => P.downloadCanvas(box.canvas, 'F25a_actograma') },
            {
              label: '⤓ CSV actograma', fn: () => P.downloadText(P.toCSV(ac.rows.flatMap(r =>
                r.values.map((v, i) => ({ dia: r.day, bin: i, hora: +((i + 0.5) * ac.binMin / 60).toFixed(3), valor: v })))),
                'F25_actograma.csv', 'text/csv')
            }
          ]));
        }
      }

      /* ---------------- (b) banda-controle ----------------------------- */
      node.appendChild(el('h4', { class: 'qc-title', html: '<b>(b) O padrão diurno é específico da banda?</b>' }));
      const espectros = (d.snapshots || []).filter(s => s.f && s.f.length && s.p).map(s => ({ t: s.t, f: s.f, p: s.p }));
      const cb = C.controlBandDiurnal(espectros, offMin(), {
        markerBand: [pb.lo, pb.hi], controlBand: [cLo, cHi], nBins: 12, nPermutations: 1500
      });
      if (!cb.ok) {
        node.appendChild(el('div', { class: 'empty', html: `${cb.reason}.` }));
        node.appendChild(el('div', {
          class: 'note', html: `<b>Por que esta pergunta importa.</b> Um padrão diurno na potência do marcador pode ser ` +
            `ritmo neural — ou postura, movimento, impedância que muda com a temperatura, qualquer coisa que module o ` +
            `sinal <b>inteiro</b>. O teste é ver se a mesma variação aparece numa banda que não deveria carregar o ` +
            `biomarcador. Sem espectros datados suficientes, esta verificação não pode ser feita, e a variação diurna ` +
            `do Timeline <b>não pode</b> ser atribuída à banda.`
        }));
      } else {
        const b2 = plotBox(node, 250);
        const todos = cb.markerProfile.concat(cb.controlProfile).filter(isFinite);
        const ch2 = new P.Chart(b2.canvas, {
          width: b2.width, height: b2.height, xlim: [0, 24],
          ylim: [Math.min.apply(null, todos) * 0.95, Math.max.apply(null, todos) * 1.08],
          xlabel: 'hora local', ylabel: 'potência (normalizada pela média da própria banda)',
          title: `(b) perfil diurno — marcador ${pb.lo}–${pb.hi} Hz vs. controle ${cLo}–${cHi} Hz`,
          pad: { l: 76, r: 14, t: 24, b: 42 }
        });
        ch2.axes({ xticks: [0, 4, 8, 12, 16, 20, 24], xfmt: v => String(v).padStart(2, '0') + 'h' });
        (cb.cluster && cb.cluster.clusters || []).filter(c => c.significant).forEach(c => {
          const a = cb.hours[c.startIdx] - 12 / cb.nBins, b = cb.hours[c.endIdx] + 12 / cb.nBins;
          ch2.span(a, b, { color: COL.accent, alpha: .13, label: 'cluster significativo' });
        });
        ch2.line(cb.hours, cb.markerProfile, { color: hcol(h || 'Left'), width: 2, label: `marcador ${pb.lo}–${pb.hi} Hz` });
        ch2.line(cb.hours, cb.controlProfile, { color: COL.muted, width: 1.6, dash: [5, 3], label: `controle ${cLo}–${cHi} Hz` });
        ch2.legend({ x: ch2.x0 + 8, y: ch2.y1 + 6 });

        const cl = cb.cluster;
        node.appendChild(table(['item', 'valor', 'o que significa'], [
          ['espectros com hora', `${cb.nSpectra} em ${cb.nDays} dia(s)`, `${cb.nPerBin.filter(v => v > 0).length} de ${cb.nBins} bins de hora preenchidos`],
          ['amplitude diurna do marcador', f(cb.markerAmplitude, 3), 'pico a vale do perfil normalizado'],
          ['amplitude diurna do controle', f(cb.controlAmplitude, 3), 'a mesma medida, na banda que não deveria carregar o biomarcador'],
          ['razão de amplitudes', isFinite(cb.amplitudeRatio) ? `${f(cb.amplitudeRatio, 2)}×` : '—', 'quanto o marcador varia a mais que o controle'],
          ['clusters testados', cl ? String(cl.clusters.length) : '—', cl ? `${cl.nPermutations} permutações, limiar |t| ≥ ${cl.clusterThreshold}, semente ${cl.seed}` : '—'],
          ['clusters significativos', cl ? String(cl.clusters.filter(c => c.significant).length) : '—',
            cl && cl.clusters.length ? cl.clusters.slice(0, 3).map(c => `${f(cb.hours[c.startIdx], 0)}–${f(cb.hours[c.endIdx], 0)}h p=${f(c.p, 3)}`).join(' · ') : (cl ? cl.reason : '—')]
        ]));
        node.appendChild(el('div', {
          class: cb.bandSpecific ? 'note' : 'warnbox',
          html: `<b>Veredito: ${cb.verdict}.</b> ${cb.interpretation}.`
        }));
        if (cl && cl.clusters.length) node.appendChild(el('div', {
          class: 'note', html: `<b>O que o teste de cluster não diz.</b> ${cl.caveat}`
        }));
        node.appendChild(exportRow([
          { label: '⤓ PNG perfis', fn: () => P.downloadCanvas(b2.canvas, 'F25b_banda_controle') },
          {
            label: '⤓ CSV perfis', fn: () => P.downloadText(P.toCSV(cb.hours.map((x, i) => ({
              hora: x, marcador: cb.markerProfile[i], controle: cb.controlProfile[i], n: cb.nPerBin[i],
              banda_marcador: `${pb.lo}-${pb.hi}`, banda_controle: `${cLo}-${cHi}`
            }))), 'F25_banda_controle.csv', 'text/csv')
          }
        ]));
      }
    }
  },

  /* ----------------------------------------------------------------- F26 */
  {
    id: 'F26', title: 'Longitudinal — impedância, confiabilidade e uso do aparelho',
    sub: 'o que mudou entre sessões antes de atribuir a mudança ao cérebro',
    has: d => true,
    render(node, d) {
      const ps = activeFiles().map(x => x.parsed);
      const limiar = opt('F26', 'thr', 25);
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlNumber('mudança de impedância que marca (%)', limiar, 5, 100, 5, v => setOpt('F26', 'thr', v))
      ]));

      /* ---- impedância -------------------------------------------------- */
      node.appendChild(el('h4', { class: 'qc-title', html: '<b>(a) Deriva de impedância</b>' }));
      const imp = C.impedanceDrift(ps, { changePct: limiar });
      if (!imp.ok) node.appendChild(el('div', { class: 'empty', text: imp.reason }));
      else {
        const box = plotBox(node, 260);
        const todos = imp.contacts.flatMap(c => c.series.map(s => s.ohm));
        const xs = imp.contacts.flatMap(c => c.series.map(s => isFinite(s.days) ? s.days : 0));
        const ch = new P.Chart(box.canvas, {
          width: box.width, height: box.height,
          xlim: [Math.min.apply(null, xs) - 5, Math.max.apply(null, xs) + 5],
          ylim: [0, Math.max.apply(null, todos) * 1.12],
          xlabel: 'dias desde o implante', ylabel: 'impedância (Ω)',
          title: `(a) impedância monopolar por contato — ${imp.nSessions} sessões`,
          pad: { l: 72, r: 14, t: 24, b: 42 }
        });
        ch.axes();
        imp.contacts.forEach(c => {
          const marcado = c.flagged;
          ch.line(c.series.map(s => isFinite(s.days) ? s.days : 0), c.series.map(s => s.ohm),
            { color: marcado ? COL.right : hcol(c.hemisphere), width: marcado ? 2 : .9 });
        });
        ch.legend({ x: ch.x0 + 8, y: ch.y1 + 6 });

        node.appendChild(table(['hemisfério', 'contato', 'n', 'primeira (Ω)', 'última (Ω)', 'variação', 'Ω/dia', 'R²'],
          imp.contacts.slice(0, 12).map(c => [
            { html: `<span class="hemi-${String(c.hemisphere)[0]}">${hname(c.hemisphere)}</span>` },
            c.contact, String(c.n), f(c.firstOhm, 0), f(c.lastOhm, 0),
            { html: c.flagged ? `<span class="sig">${c.changePct > 0 ? '+' : ''}${f(c.changePct, 1)}%</span>` : `${c.changePct > 0 ? '+' : ''}${f(c.changePct, 1)}%` },
            isFinite(c.slopeOhmPerDay) ? f(c.slopeOhmPerDay, 2) : '—',
            isFinite(c.r2) ? f(c.r2, 2) : '—'
          ])));
        node.appendChild(el('div', {
          class: imp.nFlagged ? 'warnbox' : 'note',
          html: `<b>Leitura.</b> ${imp.interpretation}`
        }));
      }

      /* ---- confiabilidade --------------------------------------------- */
      node.appendChild(el('h4', { class: 'qc-title', html: '<b>(b) A métrica é reprodutível o bastante para comparar?</b>' }));
      const sujeitos = subjects();
      const pacotes = sujeitos.map(s => {
        try { return C.extractMetrics(s.files.map(x => x.parsed), offMin(), { profileId: activeProfileId() }); }
        catch (e) { return null; }
      }).filter(Boolean);
      const rel = C.longitudinalReliability(pacotes, { hemisphere: 'Left' });
      if (!rel.ok) {
        node.appendChild(el('div', { class: 'empty', html: rel.reason }));
        /* com um sujeito, ao menos descreve a variação entre sessões */
        const b = exportBundle();
        if (b && b.acute.length > 1) {
          const campos = [['beta_peak_hz', 'pico beta (Hz)'], ['aperiodic_exponent', 'expoente aperiódico'], ['burst_rate_hz', 'taxa de bursts (/s)']];
          node.appendChild(table(['métrica', 'hemisfério', 'n sessões', 'mediana', 'variação (máx − mín)', 'coef. de variação'],
            ['Left', 'Right'].flatMap(hh => campos.map(([k, rot]) => {
              const v = b.acute.filter(r => r.hemisphere === hh && isFinite(r[k])).map(r => r[k]);
              if (v.length < 2) return null;
              const med = C.median(v), amp = Math.max.apply(null, v) - Math.min.apply(null, v);
              const cv = med !== 0 ? 100 * C.sd(v) / Math.abs(med) : NaN;
              return [rot, { html: `<span class="hemi-${hh[0]}">${hname(hh)}</span>` }, String(v.length), f(med, 3), f(amp, 3), isFinite(cv) ? f(cv, 1) + ' %' : '—'];
            }).filter(Boolean))));
          node.appendChild(el('div', {
            class: 'note', html: `<b>O que isto é e o que não é.</b> A tabela descreve <i>quanto</i> a métrica variou ` +
              `entre as sessões desta pessoa. Ela <b>não</b> diz se a métrica distingue pacientes: para isso é preciso ` +
              `variância ENTRE sujeitos, e portanto ao menos três pessoas com duas sessões cada. Uma variação de 10% pode ` +
              `ser excelente (se as pessoas diferem entre si em 100%) ou inútil (se diferem em 10%).`
          }));
        }
      } else {
        node.appendChild(table(['métrica', 'ICC(2,1)', 'ICC(3,1)', 'IC 95%', 'n × k', 'leitura'],
          rel.fields.map(r => r.ok
            ? [r.label, f(r.icc21, 3), f(r.icc31, 3), `[${f(r.ci95[0], 2)} – ${f(r.ci95[1], 2)}]`, `${r.n} × ${r.k}`,
              { html: r.ciSpansCategories ? `<span class="ns">${r.interpretation} (IC largo)</span>` : `<span class="sig">${r.interpretation}</span>` }]
            : [r.label, '—', '—', '—', '—', r.reason])));
        node.appendChild(el('div', { class: 'note', html: `<b>Qual ICC.</b> ${rel.note}` }));
        rel.fields.filter(r => r.ok && r.ciSpansCategories).forEach(r => node.appendChild(el('div', {
          class: 'warnbox', html: `<b>${r.label}.</b> ${r.caveat}.`
        })));
      }

      /* ---- uso e bateria ---------------------------------------------- */
      node.appendChild(el('h4', { class: 'qc-title', html: '<b>(c) Uso do aparelho e bateria</b>' }));
      const ub = C.usageAndBattery(ps);
      if (!ub.ok) node.appendChild(el('div', { class: 'empty', text: ub.reason }));
      else {
        node.appendChild(table(['sessão', 'bateria', 'meses estimados', 'terapia acumulada (h)', 'desde o último retorno (h)', 'uso por grupo'],
          ub.rows.map(r => [
            String(r.sessionStart || '').slice(0, 10) || r.file,
            isFinite(r.batteryPct) ? f(r.batteryPct, 0) + ' %' : '—',
            isFinite(r.batteryMonths) ? f(r.batteryMonths, 0) : '—',
            isFinite(r.therapyHoursTotal) ? f(r.therapyHoursTotal, 0) : '—',
            isFinite(r.therapyHoursSinceFU) ? f(r.therapyHoursSinceFU, 0) : '—',
            r.groupUsage.length ? r.groupUsage.map(g => `${g.id}: ${f(g.pct, 0)}%`).join(' · ') : '—'
          ])));
        node.appendChild(el('div', {
          class: 'note',
          html: `<b>Uso.</b> ${ub.adherenceNote}.` +
            (isFinite(ub.batteryDropPctPerMonth) ? ` Bateria caindo ${f(ub.batteryDropPctPerMonth, 1)} pontos percentuais por mês.` : '') +
            ` ${ub.caveat}`
        }));
        /* custo de bateria do streaming: ~1 dia de longevidade por hora no PC */
        {
          const segStream = d.bsTimeDomain.reduce((a, t2) => a + (t2.data ? t2.data.length / (t2.fsEff || t2.fs || 250) : 0), 0);
          if (segStream > 0) {
            const bc = C.PRACTICE.streamingBatteryCost(segStream, (d.all[0].device || {}).model || '');
            node.appendChild(el('div', { class: 'note', html: `<b>Custo do streaming.</b> ${bc.reading} [doi:10.1080/17582024.2024.2404386].` }));
          }
        }
      }

      node.appendChild(exportRow([
        {
          label: '⤓ CSV impedância', fn: () => {
            if (!imp.ok) return alert(imp.reason);
            P.downloadText(P.toCSV(imp.contacts.flatMap(c => c.series.map(s => ({
              hemisferio: c.hemisphere, contato: c.contact, dias_desde_implante: s.days, ohm: s.ohm,
              variacao_pct_total: c.changePct, ohm_por_dia: c.slopeOhmPerDay, marcado: c.flagged ? 1 : 0
            })))), 'F26_impedancia.csv', 'text/csv');
          }
        }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Por que esta figura vem antes de qualquer comparação entre visitas.</b> ` +
          `Comparar o beta de hoje com o de seis meses atrás só faz sentido se o que mudou for o cérebro, e não a ` +
          `medida. Impedância sobe com encapsulamento glial e altera o divisor de tensão, portanto a amplitude ` +
          `registrada; troca de contato de sensing muda o que se mede; versões de firmware mudam a escala do Timeline. ` +
          `E antes de tudo isso: se a métrica não for reprodutível, a diferença observada pode ser só ruído de medida.`
      }));
    }
  },

  /* ----------------------------------------------------------------- F38 */
  /* Survey longitudinal. Sugestão de Rubens Cury: acompanhar o espectro do
     MESMO par bipolar através de Surveys de sessões sucessivas — pouco útil
     na decisão do dia, valioso como dado de estudo (estabilidade do pico,
     deriva de magnitude, evolução pós-implante). Exige ≥2 Session Reports do
     mesmo paciente carregados juntos.                                       */
  {
    id: 'F38', title: 'Survey longitudinal — o mesmo par através das sessões',
    sub: 'espectros sobrepostos por data · trajetória do pico e da magnitude · exige ≥2 Session Reports do mesmo paciente',
    has: d => d.montage.length > 0,
    render(node, d) {
      /* uma linha por (arquivo, montagem), com a data da sessão */
      const regs = d.all.flatMap(p => (p.montage || []).map(m => ({
        idHash: (p.patient || {}).idHash || '?',
        date: String((p.meta || {}).sessionStart || '').slice(0, 10) || p.fileName,
        hemisphere: m.hemisphere, channel: m.label, f: m.f, mag: m.mag,
        peakF: m.peakF, peakMag: m.peakMag, artifact: m.artifact
      })));
      const datas = Array.from(new Set(regs.map(r => r.date))).sort();
      if (datas.length < 2) {
        return node.appendChild(el('div', {
          class: 'empty', html: 'Esta figura compara Surveys de <b>sessões diferentes</b> do mesmo paciente. ' +
            `Há ${datas.length} sessão carregada — arraste os Session Reports das outras visitas (JSON) para ativá-la.`
        }));
      }
      /* pacientes misturados: comparação inválida, e o aviso vem antes do gráfico */
      const hashes = Array.from(new Set(regs.map(r => r.idHash)));
      if (hashes.length > 1) node.appendChild(el('div', {
        class: 'warnbox', html: `<b>Atenção: ${hashes.length} pacientes diferentes entre os arquivos carregados.</b> ` +
          'Survey longitudinal só faz sentido dentro do mesmo paciente — as curvas abaixo misturam indivíduos ' +
          'e não devem ser lidas como evolução temporal.'
      }));

      const hemis = Array.from(new Set(regs.map(r => r.hemisphere)));
      const h = opt('F38', 'hemi', hemis[0]);
      /* canal padrão: o que aparece em mais sessões (empate: maior pico) */
      const canais = Array.from(new Set(regs.filter(r => r.hemisphere === h).map(r => r.channel)));
      const contagem = c => new Set(regs.filter(r => r.hemisphere === h && r.channel === c).map(r => r.date)).size;
      const canalPadrao = canais.slice().sort((a, b) => contagem(b) - contagem(a))[0];
      const canal = opt('F38', 'ch', canalPadrao);
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('hemisfério', hemis.map(x => ({ value: x, label: rotuloLado(x) })), h, v => setOpt('F38', 'hemi', v)),
        ctrlSelect('par bipolar', canais.map(c => ({ value: c, label: `${c} (${contagem(c)} sessões)` })), canal, v => setOpt('F38', 'ch', v))
      ]));

      const serie = regs.filter(r => r.hemisphere === h && r.channel === canal)
        .sort((a, b) => a.date < b.date ? -1 : 1);
      if (serie.length < 2) return node.appendChild(el('div', { class: 'empty', text: `O par ${canal} aparece em só ${serie.length} sessão.` }));

      const pb = activeProfile().primaryBand;
      /* pico COMPUTADO na banda primária — o mesmo critério em toda sessão,
         em vez do pico reportado pelo aparelho (que muda de regra com o fw) */
      const linhas = serie.map(r => {
        let pf = NaN, pv = -Infinity;
        r.f.forEach((x, k) => { if (x >= pb.lo && x <= pb.hi && r.mag[k] > pv) { pv = r.mag[k]; pf = x; } });
        const area = C.bandPower(r.f, r.mag, pb.lo, pb.hi);
        return { date: r.date, peakHz: pf, peakMag: pv, bandArea: area, deviceHz: r.peakF, artifact: r.artifact };
      });

      /* (a) espectros sobrepostos, do mais antigo (claro) ao mais recente (escuro) */
      const box = plotBox(node, 250);
      {
        const fmax = 60;
        const ymax = Math.max.apply(null, serie.flatMap(r => r.mag.filter((_, k) => r.f[k] <= fmax))) * 1.12;
        const ch = new P.Chart(box.canvas, {
          width: box.width, height: box.height, xlim: [0, fmax], ylim: [0, ymax],
          xlabel: 'frequência (Hz)', ylabel: 'magnitude (µVp)',
          title: `Survey de ${canal} — ${serie.length} sessões, da mais antiga (clara) à mais recente (escura)`,
          pad: { l: 62, r: 14, t: 24, b: 42 }
        });
        ch.axes();
        ch.span(pb.lo, pb.hi, { color: CORBETA, alpha: .08, label: pb.label });
        serie.forEach((r, i) => {
          const t01 = serie.length > 1 ? i / (serie.length - 1) : 1;
          const base = h === 'Left' ? [27, 74, 114] : [156, 48, 80];
          const cor = `rgb(${base.map(c => Math.round(235 - (235 - c) * (0.35 + 0.65 * t01))).join(',')})`;
          ch.line(r.f, r.mag, { color: cor, width: 1 + t01, label: r.date });
        });
        ch.legend({ x: ch.x1 - 118, y: ch.y1 + 6 });
      }

      /* (b) trajetória do pico: frequência e magnitude por sessão */
      const boxT = plotBox(node, 190);
      {
        const xs = linhas.map((_, i) => i);
        const ch = new P.Chart(boxT.canvas, {
          width: boxT.width, height: boxT.height, xlim: [-0.5, linhas.length - 0.5], ylim: [pb.lo - 2, pb.hi + 2],
          xlabel: 'sessão', ylabel: `pico em ${pb.label} (Hz)`,
          title: 'trajetória do pico — a estabilidade é a informação', pad: { l: 62, r: 54, t: 24, b: 46 }
        });
        ch.axes({ xticks: xs, xfmt: v => (linhas[Math.round(v)] || { date: '' }).date.slice(5) });
        ch.line(xs, linhas.map(x => x.peakHz), { color: hcol(h), width: 1.6 });
        linhas.forEach((x, i) => ch.marker(i, x.peakHz, { color: hcol(h), size: 4.5 }));
        /* magnitude normalizada no eixo direito (escala relativa, declarada) */
        const mmax = Math.max.apply(null, linhas.map(x => x.peakMag));
        ch.line(xs, linhas.map(x => pb.lo - 2 + (x.peakMag / mmax) * (pb.hi - pb.lo + 4) * .3), { color: COL.accent, width: 1, dash: [3, 2], label: 'magnitude (escala relativa)' });
        ch.legend({ x: ch.x0 + 8, y: ch.y1 + 6 });
      }

      node.appendChild(table(['sessão', `pico ${pb.label} (Hz)`, 'magnitude (µVp)', `área ${pb.label}`, 'pico do aparelho (Hz)', 'artefato'],
        linhas.map(x => [x.date, x.peakHz, x.peakMag, x.bandArea, isFinite(x.deviceHz) ? x.deviceHz : '—', x.artifact || '—'])));

      {
        const freqs = linhas.map(x => x.peakHz).filter(isFinite);
        const spread = freqs.length > 1 ? Math.max.apply(null, freqs) - Math.min.apply(null, freqs) : NaN;
        node.appendChild(el('div', {
          class: 'note', html: `<b>Leitura.</b> Dispersão da frequência de pico entre sessões: <b>${f(spread, 1)} Hz</b>. ` +
            `Pico estável (≲1–2 Hz) sustenta tratar a frequência como traço do paciente — condição para fixar a banda de ` +
            `sensing e comparar potências ao longo do tempo; o veredito formal por ICC está na F16. Utilidade clínica ` +
            `imediata é limitada (a decisão do dia usa o Survey do dia); o valor é de <b>estudo</b>: estabilidade do ` +
            `biomarcador, deriva pós-implante e efeito de reprogramações sobre o espectro. Magnitudes entre sessões só ` +
            `são comparáveis sob a MESMA configuração de sensing — confira os blocos na F32. ` +
            `[Survey: ~20 s por par, bins de 0,98 Hz — Medtronic UC202012929cEN FY24, p. 4]`
        }));
      }
      node.appendChild(exportRow([
        { label: '⤓ PNG', fn: () => P.downloadCanvas(box.canvas, 'F38_survey_longitudinal') },
        {
          label: '⤓ CSV (R-compatible)', fn: () => P.downloadText(P.toCSV(linhas.map(x => ({
            session_date: x.date, hemisphere: h, channel: canal,
            peak_hz: x.peakHz, peak_uvp: x.peakMag, band_area: x.bandArea,
            band_lo_hz: pb.lo, band_hi_hz: pb.hi,
            device_peak_hz: isFinite(x.deviceHz) ? x.deviceHz : '', artifact: x.artifact || ''
          }))), 'F38_survey_longitudinal.csv', 'text/csv')
        }
      ]));
    }
  },

  /* ----------------------------------------------------------------- F27 */
  {
    id: 'F27', title: 'Coorte — todos os registros carregados lado a lado',
    sub: 'tabela por sujeito, estatísticas de grupo e prevalência com IC de Wilson',
    has: () => S.files.length > 0,
    render(node, d) {
      const subs = subjects();
      const pacotes = subs.map(s => {
        try { return C.extractMetrics(s.files.map(x => x.parsed), offMin(), { profileId: activeProfileId() }); }
        catch (e) { return null; }
      }).filter(Boolean);
      const co = C.cohortSummary(pacotes, {});
      if (!co) return node.appendChild(el('div', { class: 'empty', text: 'Nenhum registro com métricas extraíveis.' }));

      node.appendChild(el('div', {
        class: co.descriptiveOnly ? 'warnbox' : 'note',
        html: `<b>${co.nSubjects} sujeito(s), ${co.nHemispheres} hemisfério(s).</b> ${co.note}. ${co.caveat}`
      }));

      /* prevalência de pico */
      const pv = co.prevalence;
      node.appendChild(el('h4', { class: 'qc-title', html: '<b>Prevalência de pico na banda primária</b> — a estatística que muda o cálculo amostral de um estudo' }));
      node.appendChild(table(['recorte', 'k / n', 'proporção', 'IC 95% (Wilson)', 'referência'], [
        ['por hemisfério', `${pv.byHemisphere.k} / ${pv.byHemisphere.n}`, isFinite(pv.byHemisphere.pct) ? f(pv.byHemisphere.pct, 1) + ' %' : '—',
          `${f(100 * pv.byHemisphere.ci95[0], 1)}–${f(100 * pv.byHemisphere.ci95[1], 1)} %`, pv.reference],
        ['bilateral', `${pv.bilateral.k} / ${pv.bilateral.n}`, isFinite(pv.bilateral.pct) ? f(pv.bilateral.pct, 1) + ' %' : '—',
          `${f(100 * pv.bilateral.ci95[0], 1)}–${f(100 * pv.bilateral.ci95[1], 1)} %`, pv.ciMethod]
      ]));

      /* tabela por sujeito */
      node.appendChild(el('h4', { class: 'qc-title', html: '<b>Por sujeito e hemisfério</b>' }));
      node.appendChild(table(
        ['sujeito', 'hemi.', 'pico?', 'pico (Hz)', 'rel. (%)', 'χ aperiód.', 'burst/s', 'MESOR', 'amp. 24 h', 'acrofase', '% beta alto', 'dias'],
        co.rows.map(r => [
          r.subjectId,
          { html: `<span class="hemi-${String(r.hemisphere)[0]}">${hname(r.hemisphere)}</span>` },
          { html: r.hasPeak === null ? '—' : r.hasPeak ? '<span class="sig">sim</span>' : '<span class="ns">não</span>' },
          f(r.peakHz, 1), f(r.betaRelPct, 1), f(r.aperiodicExponent, 2), f(r.burstRate, 2),
          f(r.mesor, 1), f(r.amp24, 2), isFinite(r.acrophase) ? f(r.acrophase, 1) + ' h' : '—',
          isFinite(r.offPct) ? f(r.offPct, 1) + ' %' : '—', isFinite(r.nDays) ? String(r.nDays) : '—'
        ])));

      /* estatísticas de grupo */
      node.appendChild(el('h4', { class: 'qc-title', html: '<b>Estatísticas de grupo</b> — mediana [IQR], por hemisfério' }));
      node.appendChild(table(['métrica', 'todos', 'esquerdo', 'direito'],
        co.stats.map(e => {
          const fmt = r => !r ? '—' : r.circular
            ? `${f(r.mean, 1)} h (R = ${f(r.concentration, 2)}, n = ${r.n})`
            : `${f(r.median, 2)} [${f(r.q1, 2)}; ${f(r.q3, 2)}] (n = ${r.n})`;
          return [e.label, fmt(e.all), fmt(e.left), fmt(e.right)];
        })));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Acrofase é grandeza circular.</b> Média aritmética de horários é incorreta — 23 h e 1 h ` +
          `não têm média 12 h. As linhas de acrofase trazem a média circular e a concentração R (0 = espalhado por todo o ` +
          `ciclo, 1 = todos no mesmo horário).`
      }));

      node.appendChild(exportRow([
        {
          label: '⤓ CSV da coorte', fn: () => P.downloadText(P.toCSV(co.rows.map(r => ({
            sujeito: r.subjectId, hemisferio: r.hemisphere,
            tem_pico: r.hasPeak === null ? '' : (r.hasPeak ? 1 : 0),
            pico_hz: r.peakHz, relativa_pct: r.betaRelPct, expoente_aperiodico: r.aperiodicExponent,
            burst_taxa_hz: r.burstRate, burst_duracao_ms: r.burstMeanMs,
            mesor: r.mesor, amplitude_24h: r.amp24, acrofase_h: r.acrophase,
            pct_beta_alto: r.offPct, dias_timeline: r.nDays
          }))), 'coorte_por_hemisferio.csv', 'text/csv')
        },
        {
          label: '⤓ JSON da coorte', fn: () => P.downloadText(JSON.stringify({
            generated_at: new Date().toISOString(), n_subjects: co.nSubjects,
            descriptive_only: co.descriptiveOnly, note: co.note,
            prevalence: co.prevalence, subjects: co.subjects, stats: co.stats
          }, null, 2), 'coorte.json', 'application/json')
        }
      ]));
    }
  },

  /* ----------------------------------------------------------------- F28 */
  {
    id: 'F28', title: 'Matriz hora × dia — estados ON/OFF ligados à sua integral',
    sub: 'diário de Hauser e a MESMA grade no Timeline crônico · barra empilhada por dia · marcas de tomada',
    has: d => Object.keys(d.trend).length || (S.diary && S.diary.parsed && S.diary.parsed.ok),
    render(node, d) {
      const temDiario = !!(S.diary && S.diary.parsed && S.diary.parsed.ok);
      const hemis = Object.keys(d.trend);
      const fonte = opt('F28', 'src', temDiario ? 'diary' : 'lfp');
      const soVigilia = opt('F28', 'vig', false);

      /* ---- barra de controle, com a importação do diário -------------- */
      const barra = el('div', { class: 'ctrls' });
      barra.appendChild(el('input', {
        type: 'file', accept: '.csv,.tsv,.txt,text/csv', id: 'diaryFile', style: 'display:none',
        onchange: e => { const fl = e.target.files && e.target.files[0]; e.target.value = ''; if (fl) carregaDiario(fl); }
      }));
      const fontes = [];
      if (temDiario) fontes.push({ value: 'diary', label: 'diário de Hauser (CSV)' });
      if (hemis.length) fontes.push({ value: 'lfp', label: 'Timeline do LFP' });
      if (fontes.length > 1) barra.appendChild(ctrlSelect('fonte', fontes, fonte, v => setOpt('F28', 'src', v)));
      barra.appendChild(ctrlCheck('só vigília', soVigilia, v => setOpt('F28', 'vig', v)));
      barra.appendChild(el('button', {
        class: 'btn' + (temDiario ? '' : ' primary'),
        text: temDiario ? '↻ trocar diário' : '+ carregar diário (CSV)',
        onclick: () => { const i = document.getElementById('diaryFile'); if (i) i.click(); }
      }));
      if (S.diary) barra.appendChild(el('button', {
        class: 'btn', text: '× remover diário',
        onclick: () => { S.diary = null; setOpt('F28', 'src', 'lfp'); }
      }));

      const usaDiario = fonte === 'diary' && temDiario;
      let cond = null, hemi = null, binMin = 30, metodo = 'kmeans', escala = 'cat';
      if (usaDiario) {
        const conds = S.diary.parsed.conditions;
        cond = opt('F28', 'cond', conds[0]);
        if (conds.indexOf(cond) < 0) cond = conds[0];
        if (conds.length > 1) barra.appendChild(ctrlSelect('condição', conds, cond, v => setOpt('F28', 'cond', v)));
      } else if (hemis.length) {
        hemi = opt('F28', 'hemi', hemis[0]);
        binMin = opt('F28', 'bin', 30);
        metodo = opt('F28', 'thr', 'kmeans');
        escala = opt('F28', 'esc', 'cat');
        barra.appendChild(ctrlSelect('hemisfério', hemis.map(x => ({ value: x, label: rotuloLado(x) })), hemi, v => setOpt('F28', 'hemi', v)));
        barra.appendChild(ctrlSelect('bin', [{ value: 10, label: '10 min' }, { value: 30, label: '30 min' }, { value: 60, label: '60 min' }], binMin, v => setOpt('F28', 'bin', +v)));
        barra.appendChild(ctrlSelect('escala', [{ value: 'cat', label: 'categórica (limiar)' }, { value: 'cont', label: 'contínua (potência)' }], escala, v => setOpt('F28', 'esc', v)));
        barra.appendChild(ctrlSelect('limiar', [
          { value: 'kmeans', label: 'k-médias (2 grupos)' }, { value: 'percentile', label: 'percentil' }, { value: 'fixed', label: 'valor fixo' }
        ], metodo, v => setOpt('F28', 'thr', v)));
        if (metodo === 'percentile') barra.appendChild(ctrlNumber('percentil', opt('F28', 'pct', 50), 5, 95, 5, v => setOpt('F28', 'pct', v)));
        if (metodo === 'fixed') barra.appendChild(ctrlNumber('limiar (u.a.)', opt('F28', 'lim', 40), 0, 1e6, 1, v => setOpt('F28', 'lim', v)));
      }
      const horarios = opt('F28', 'doses', '');
      barra.appendChild(ctrlText('tomadas (h)', horarios, 'ex.: 07:00, 11:00, 15:00, 19:00', v => setOpt('F28', 'doses', v)));
      node.appendChild(barra);

      if (usaDiario && S.diary) node.appendChild(el('div', {
        class: 'seal', text: `${S.diary.name} · ${S.diary.parsed.nRows} bins de ${S.diary.parsed.binMin} min · ` +
          `${S.diary.parsed.conditions.length} condição(ões) · ${S.diary.parsed.note}`
      }));
      if (S.diary && !S.diary.parsed.ok) node.appendChild(el('div', { class: 'warnbox', html: `<b>Diário não lido.</b> ${S.diary.parsed.reason}.` }));

      /* horários fixos digitados pelo usuário (o diário não traz a tomada) */
      const dosesFixas = String(horarios || '').split(/[;,]/).map(s => {
        const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(s);
        return m ? (+m[1]) + (m[2] ? +m[2] / 60 : 0) : NaN;
      }).filter(v => isFinite(v) && v >= 0 && v < 24);

      /* ================= (a) a matriz e a sua integral ================== */
      let grade = null, comp = null, doseInfo = null, tg = null;
      if (usaDiario) {
        const p = S.diary.parsed;
        grade = C.diaryGrid(p.rows, { condition: cond, binMin: p.binMin });
        if (!grade.ok) return node.appendChild(el('div', { class: 'empty', text: grade.reason }));
        comp = C.dailyComposition(grade, { awakeOnly: soVigilia });
        const ids = C.DIARY_STATES.filter(s => !soVigilia || s.awake).map(s => s.id);
        const paleta = {}; C.DIARY_STATES.forEach(s => { paleta[s.id] = s; });
        const linhas = comp.perDay.map(dd => ids.map(k => ({ state: k, hours: dd.hours[k] || 0 })));
        const bxa = painelMatriz(node, {
          days: grade.days, nBins: grade.nBins, cells: grade.cells, states: grade.cells,
          rows: linhas, barMax: soVigilia ? Math.max(4, Math.ceil(Math.max.apply(null, comp.perDay.map(x => x.total)))) : 24,
          palette: paleta, legend: C.DIARY_STATES.filter(s => !soVigilia || s.awake).map(s => ({ label: s.label, color: s.color })),
          doseRows: grade.days.map(() => dosesFixas),
          rowLabel: (dia) => (/^\d+$/.test(String(dia)) ? 'Dia ' + dia : String(dia)),
          title: `(a) ${cond} — ${grade.days.length} dias · bin de ${grade.binMin} min · ${soVigilia ? 'só vigília' : '24 h'}`
        });
        node.appendChild(el('div', {
          class: 'note', html: `<b>Como ler.</b> Cada linha é um dia, cada célula um bin de ${grade.binMin} min, e o Dia 1 fica no topo. ` +
            `À direita, na mesma linha, a barra empilhada daquele dia — a <b>integral</b> da própria linha. ` +
            `Passe o cursor sobre uma célula: acendem juntas todas as células daquele dia naquele estado e o segmento que elas somam. ` +
            `${dosesFixas.length ? `Os ▼ marcam as tomadas informadas (${dosesFixas.map(h => f(h, 1) + 'h').join(', ')}).` : 'Informe os horários das tomadas no campo acima para ver os ▼.'}`
        }));
        node.appendChild(exportRow([
          { label: '⤓ PNG 2× da matriz', fn: () => bxa.exportar2x('F28a_matriz_hora_dia') },
          {
            label: '⤓ CSV da matriz', fn: () => P.downloadText(P.toCSV(grade.days.flatMap((dia, i) =>
              grade.cells[i].map((v, j) => ({
                condition: cond, day: dia, bin_index: j, hour_decimal: +((j + 0.5) * grade.binMin / 60).toFixed(3),
                state: v == null ? '' : v, bin_min: grade.binMin
              })))), 'F28_matriz.csv', 'text/csv')
          }
        ]));
        if (grade.pctMissing > 0 || grade.nConflicts) node.appendChild(el('div', {
          class: 'warnbox', html: `<b>Contabilidade do que falta.</b> ${f(grade.pctMissing, 1)}% das células do período não têm registro ` +
            `(${grade.nMissing} de ${grade.nCells}) e ficam <b>vazias</b>, nunca preenchidas pelo vizinho. ` +
            (grade.nConflicts ? `${grade.note}. ` : '') +
            (comp.nDaysExcluded ? `${comp.nDaysExcluded} dia(s) ficaram fora da média por cobertura insuficiente.` : '')
        }));
      } else if (hemis.length) {
        const limpo = C.removeOutliersMAD(d.trend[hemi], 'lfp', 4).kept;
        tg = C.timelineGrid(limpo, offMin(), {
          binMin, thresholdMethod: metodo, pct: opt('F28', 'pct', 50), threshold: opt('F28', 'lim', 40)
        });
        if (!tg.ok) return node.appendChild(el('div', { class: 'empty', text: tg.reason }));
        const paleta = {}; C.LFP_STATES.forEach(s => { paleta[s.id] = s; });
        const hBin = tg.binMin / 60;
        const linhas = tg.states.map(l => ['LFP_low', 'LFP_high'].map(k => ({ state: k, hours: l.filter(v => v === k).length * hBin })));
        const cmap = P.CMAPS.magma;
        doseInfo = C.doseMarkers(d.snapshots, offMin(), { pattern: /medica|levodopa|dose/i });
        const bxa = painelMatriz(node, {
          days: tg.days, nBins: tg.nBins,
          cells: escala === 'cont' ? tg.values : tg.states, states: tg.states,
          continuous: escala === 'cont',
          contColor: v => cmap((v - tg.zmin) / Math.max(1e-9, tg.zmax - tg.zmin)),
          rows: linhas, barMax: 24, palette: paleta,
          legend: escala === 'cont'
            ? [{ label: `potência ${f(tg.zmin, 0)} (escuro) → ${f(tg.zmax, 0)} (claro)`, color: cmap(0.75) }]
            : C.LFP_STATES.slice(0, 2).map(s => ({ label: s.label + ` (limiar ${f(tg.threshold, 1)})`, color: s.color })),
          doseRows: tg.days.map(dia => (doseInfo.ok && doseInfo.byDay[dia]) || dosesFixas),
          rowLabel: dia => String(dia).slice(5).split('-').reverse().join('/'),
          title: `(a) Timeline — ${rotuloLado(hemi)} · ${tg.days.length} dias · bin de ${tg.binMin} min`
        });
        node.appendChild(el('div', {
          class: 'note', html: `<b>A mesma grade, outro dado.</b> Esta é a estrutura do diário de Hauser aplicada ao BrainSense Timeline: ` +
            `dias × bins de potência beta. A barra à direita é a integral da linha — horas acima e abaixo do limiar. ` +
            `Limiar por <b>${tg.thresholdDetail}</b>.` +
            (doseInfo.ok ? ` Os ▼ vêm de ${doseInfo.n} evento(s) "${doseInfo.doses[0].name}" marcados pelo paciente em ${doseInfo.nDays} dia(s).`
              : ` ${doseInfo.reason}.`)
        }));
        node.appendChild(el('div', { class: 'warnbox', html: `<b>Limite deste eixo.</b> ${tg.caveat}.` }));
        node.appendChild(exportRow([
          { label: '⤓ PNG 2× da matriz', fn: () => bxa.exportar2x('F28a_matriz_timeline') },
          {
            label: '⤓ CSV da matriz', fn: () => P.downloadText(P.toCSV(tg.days.flatMap((dia, i) =>
              tg.values[i].map((v, j) => ({
                day: dia, bin_index: j, hour_decimal: +((j + 0.5) * tg.binMin / 60).toFixed(3),
                power: v, state: tg.states[i][j] || '', threshold: tg.threshold, threshold_method: tg.thresholdMethod,
                bin_min: tg.binMin, hemisphere: hemi
              })))), 'F28_matriz_timeline.csv', 'text/csv')
          }
        ]));
        if (tg.pctMissing > 0) node.appendChild(el('div', {
          class: 'seal' + (tg.pctMissing > 20 ? ' warn' : ''),
          text: `${f(100 - tg.pctMissing, 1)}% das células com dado · ${tg.nMissing} de ${tg.nCells} bins sem registro, deixados vazios`
        }));
      }

      /* ============ (b) barras empilhadas: média por condição ========== */
      if (usaDiario) {
        node.appendChild(el('h4', { class: 'qc-title', html: '<b>(b) Média por condição — o formato de desfecho primário</b>' }));
        const p = S.diary.parsed;
        const cmp = p.conditions.length > 1
          ? C.compareConditions(p.rows, { binMin: p.binMin, awakeOnly: soVigilia, paired: opt('F28', 'par', false) })
          : null;
        const conds = cmp && cmp.ok ? cmp.conditions
          : [{ condition: cond, byState: comp.byState, nDays: comp.nDaysUsed, meanTotal: comp.meanTotal }];
        const ids = C.DIARY_STATES.filter(s => !soVigilia || s.awake).map(s => s.id);
        const corE = k => (C.DIARY_STATES.find(s => s.id === k) || {}).color || '#999';
        const totais = conds.map(c => ids.reduce((a, k) => a + ((c.byState[k] && c.byState[k].mean) || 0), 0));
        const ymax = Math.max.apply(null, totais.concat([1])) * 1.16;
        const bb = plotBox(node, 320);
        const cb = new P.Chart(bb.canvas, {
          width: bb.width, height: 320, xlim: [0, conds.length], ylim: [0, ymax],
          ylabel: soVigilia ? 'horas de vigília por dia' : 'horas por dia (24 h)',
          title: `(b) média por condição — ${soVigilia ? 'recorte de vigília' : '24 h incluindo sono'}`,
          pad: { l: 72, r: 14, t: 26, b: 78 }
        });
        cb.axes({ xticks: conds.map((_, i) => i + 0.5), xfmt: v => (conds[Math.floor(v)] || {}).condition || '', ny: 6 });
        conds.forEach((c, i) => {
          let acc = 0, topoOff = NaN;
          ids.forEach(k => {
            const m = (c.byState[k] && c.byState[k].mean) || 0;
            if (!(m > 0)) return;
            cb.rect(i + 0.28, acc, i + 0.72, acc + m, { fill: corE(k), stroke: '#FFFFFF', lineWidth: 1.4 });
            /* o rótulo do OFF sai para fora quando o segmento é fino: dentro
               dele ficaria por cima da barra de erro, que mora no mesmo topo */
            const sem = (c.byState.Off && c.byState.Off.sem) || 0;
            const cabeDentro = m >= ymax * 0.055 && !(k === 'Off' && m < ymax * 0.055 + 2 * sem);
            if (cabeDentro) cb.text(cb.X(i + 0.5), cb.Y(acc + m / 2), f(m, 1) + ' h',
              { align: 'center', baseline: 'middle', color: '#FFFFFF', font: '600 11.5px ui-monospace, Menlo, monospace' });
            else if (k === 'Off') cb.text(cb.X(i + 0.74) + 6, cb.Y(acc + m / 2), f(m, 1) + ' h',
              { align: 'left', baseline: 'middle', color: corE(k), font: '600 11.5px ui-monospace, Menlo, monospace' });
            acc += m;
            if (k === 'Off') topoOff = acc;         // topo do segmento, não o valor absoluto
          });
          /* Barra de erro SÓ no segmento OFF — é como o desfecho é reportado.
             Ela vai no TOPO do segmento: no recorte de vigília o OFF começa em
             zero e as duas coisas coincidem, mas no recorte de 24 h o sono está
             embaixo, e ancorar no valor absoluto poria a barra dentro do sono. */
          const off = c.byState.Off;
          if (off && isFinite(off.sem) && off.sem > 0 && isFinite(topoOff)) {
            const x = i + 0.5;
            cb.line([x, x], [topoOff - off.sem, topoOff + off.sem], { color: COL.ink, width: 1.4 });
            cb.line([x - 0.07, x + 0.07], [topoOff - off.sem, topoOff - off.sem], { color: COL.ink, width: 1.4 });
            cb.line([x - 0.07, x + 0.07], [topoOff + off.sem, topoOff + off.sem], { color: COL.ink, width: 1.4 });
          }
        });
        cb.swatches(C.DIARY_STATES.filter(s => !soVigilia || s.awake).map(s => ({ label: s.label, color: s.color })), { y: 320 - 34, width: bb.width });
        node.appendChild(el('div', {
          class: 'note', html: `<b>Por que a barra de erro fica só no OFF.</b> É o desfecho primário de LCIG, apomorfina e opicapona: ` +
            `"horas OFF em vigília". Os outros segmentos têm dispersão própria, mas pôr barra em todos sugere que os erros são ` +
            `independentes — e não são: os estados de um mesmo dia somam um total fixo, então o erro de um é o erro do outro com sinal trocado. ` +
            `Aqui a barra é o EPM de ${(conds[0].byState.Off || {}).n || 0} dia(s) por condição.`
        }));
        if (cmp && cmp.ok) {
          node.appendChild(table(['comparação', 'valor', 'leitura'], [
            ['Δ tempo OFF', `${f(cmp.deltaOff, 2)} h/dia`, `${cmp.from} → ${cmp.to}${soVigilia ? ', em vigília' : ', em 24 h'}`],
            ['método', cmp.test ? cmp.test.method : '—', cmp.paired ? 'pareado por escolha explícita' : 'não pareado (padrão conservador)'],
            ['IC 95%', cmp.test && cmp.test.ci95 ? `${f(cmp.test.ci95[0], 2)} a ${f(cmp.test.ci95[1], 2)} h` : '—', 'aproximação normal sobre o erro-padrão da diferença'],
            ['p', { html: cmp.test && cmp.test.p != null ? pHtml(cmp.test.p) : '—' }, cmp.test && cmp.test.exact ? 'enumeração completa das partições — p exato' : 'permutação com semente fixa']
          ]));
          node.appendChild(el('div', { class: 'note', html: `<b>${cmp.interpretation}.</b> ${cmp.caveat}.` }));
          if (p.conditions.length > 1) node.appendChild(el('div', { class: 'ctrls' }, [
            ctrlCheck('tratar os dias como pareados entre condições', opt('F28', 'par', false), v => setOpt('F28', 'par', v))
          ]));
        }
        node.appendChild(exportRow([
          { label: '⤓ PNG barras', fn: () => P.downloadCanvas(bb.canvas, 'F28b_barras') },
          {
            label: '⤓ CSV composição', fn: () => P.downloadText(P.toCSV(comp.perDay.map(dd => Object.assign({
              condition: cond, day: dd.day, total_h: dd.total, coverage: dd.coverage,
              n_missing_bins: dd.nMissing, awake_only: soVigilia ? 1 : 0
            }, dd.hours))), 'F28_composicao_diaria.csv', 'text/csv')
          }
        ]));
      }

      /* ================== (c) perfil circadiano ======================== */
      node.appendChild(el('h4', { class: 'qc-title', html: '<b>(c) Perfil circadiano — onde no dia o estado se concentra</b>' }));
      const perfil = usaDiario ? C.circadianStateProfile(grade)
        : (tg ? C.circadianStateProfile({ ok: true, binMin: tg.binMin, nBins: tg.nBins, days: tg.days, cells: tg.states }) : null);
      if (!perfil || !perfil.ok) node.appendChild(el('div', { class: 'empty', text: 'sem grade para o perfil circadiano' }));
      else {
        const ids = usaDiario ? C.DIARY_STATES.map(s => s.id) : ['LFP_low', 'LFP_high'];
        const corE = k => ((usaDiario ? C.DIARY_STATES : C.LFP_STATES).find(s => s.id === k) || {}).color || '#999';
        const rotE = k => ((usaDiario ? C.DIARY_STATES : C.LFP_STATES).find(s => s.id === k) || {}).label || k;
        const bc = plotBox(node, 300);
        const cc = new P.Chart(bc.canvas, {
          width: bc.width, height: 300, xlim: [0, 24], ylim: [0, 100],
          xlabel: 'hora local', ylabel: '% dos dias no estado',
          title: `(c) perfil circadiano — ${perfil.nDays} dias, bin de ${perfil.binMin} min`,
          pad: { l: 66, r: 14, t: 26, b: 78 }
        });
        cc.axes({ grid: false, xticks: [0, 3, 6, 9, 12, 15, 18, 21, 24], xfmt: v => String(v).padStart(2, '0') + 'h' });
        let base = perfil.hours.map(() => 0);
        ids.forEach(k => {
          const topo = perfil.hours.map((_, i) => {
            const v = perfil.props[k] ? perfil.props[k][i] : NaN;
            return isFinite(v) ? base[i] + v : NaN;
          });
          cc.area(perfil.hours, base, topo, { color: corE(k), alpha: .92 });
          base = topo.map((v, i) => isFinite(v) ? v : base[i]);
        });
        dosesFixas.forEach(h => cc.vline(h, { color: '#FFFFFF', width: 1.2, dash: [2, 2] }));
        cc.swatches(ids.map(k => ({ label: rotE(k), color: corE(k) })), { y: 300 - 34, width: bc.width });
        const chave = usaDiario ? 'Off' : 'LFP_high';
        const pico = usaDiario ? perfil.peakOffHour : (() => {
          let melhor = NaN, v = -Infinity;
          (perfil.props[chave] || []).forEach((x, i) => { if (isFinite(x) && x > v) { v = x; melhor = perfil.hours[i]; } });
          return melhor;
        })();
        node.appendChild(el('div', {
          class: 'note', html: `<b>O que esta figura responde que a barra não responde.</b> ` +
            (usaDiario
              ? `A hora com maior proporção de OFF é <b>${isFinite(perfil.peakOffHour) ? f(perfil.peakOffHour, 1) + ' h' : '—'}</b> ` +
                `(${isFinite(perfil.peakOffPct) ? f(perfil.peakOffPct, 0) + '% dos dias' : '—'}). ` +
                `OFF concentrado antes da primeira dose sugere <i>delayed-on</i> ou OFF matinal; concentrado no fim da tarde, <i>wearing-off</i>; ` +
                `espalhado por todo o dia, flutuação imprevisível. O total de horas é o mesmo nos três, a conduta não é.`
              : `A hora com maior proporção de dias com beta acima do limiar é <b>${isFinite(pico) ? f(pico, 1) + ' h' : '—'}</b>. ` +
                `Isto é o perfil do biomarcador, não do estado clínico — a leitura clínica depende da concordância medida no painel (d).`) +
            ` ${perfil.note}.`
        }));
        node.appendChild(exportRow([
          { label: '⤓ PNG perfil', fn: () => P.downloadCanvas(bc.canvas, 'F28c_perfil_circadiano') },
          {
            label: '⤓ CSV perfil', fn: () => P.downloadText(P.toCSV(perfil.hours.map((h, i) => {
              const l = { hora: h, n_dias: perfil.nPerBin[i] };
              ids.forEach(k => { l['pct_' + k] = perfil.props[k] ? perfil.props[k][i] : NaN; });
              return l;
            })), 'F28_perfil_circadiano.csv', 'text/csv')
          }
        ]));
      }

      /* ============ (d) diário × LFP na mesma grade ==================== */
      if (temDiario && hemis.length) {
        node.appendChild(el('h4', { class: 'qc-title', html: '<b>(d) O diário e o LFP na mesma grade — concordância auditável</b>' }));
        const p = S.diary.parsed;
        const hemiA = hemi || hemis[0];
        const gd = C.diaryGrid(p.rows, { condition: cond || p.conditions[0], binMin: p.binMin });
        const tl = C.timelineGrid(C.removeOutliersMAD(d.trend[hemiA], 'lfp', 4).kept, offMin(), {
          binMin: p.binMin, thresholdMethod: metodo, pct: opt('F28', 'pct', 50), threshold: opt('F28', 'lim', 40)
        });
        const ag = (gd.ok && tl.ok) ? C.diaryVsLfpAgreement(gd, tl, {}) : { ok: false, reason: 'grades incompletas' };
        if (!ag.ok) node.appendChild(el('div', { class: 'empty', text: ag.reason }));
        else {
          node.appendChild(table(['medida', 'valor', 'o que significa'], [
            ['bins comparados', `${ag.n}`, `alinhamento ${ag.alignment} · confiança ${ag.alignmentConfidence}`],
            ['concordância bruta', `${f(ag.agreement, 1)}%`, `esperada só pelo acaso: ${f(ag.expected, 1)}%`],
            ['kappa de Cohen', `${f(ag.kappa, 3)}`, ag.kappaCI ? `IC 95% ${f(ag.kappaCI[0], 2)} a ${f(ag.kappaCI[1], 2)} — concordância ${ag.strength}` : ag.strength],
            ['beta alto quando o diário diz OFF', `${f(ag.sensitivity, 1)}%`, `${ag.table.offHigh} de ${ag.table.offHigh + ag.table.offLow} bins de OFF`],
            ['beta baixo quando o diário diz ON', `${f(ag.specificity, 1)}%`, `${ag.table.onLow} de ${ag.table.onHigh + ag.table.onLow} bins de ON`]
          ]));
          node.appendChild(el('div', {
            class: ag.kappa >= 0.4 ? 'note' : 'warnbox',
            html: `<b>Veredito: ${ag.verdict}.</b> ${ag.caveat}. Bins de sono ficaram de fora (${ag.nSleepBins}): ` +
              `o beta cai no sono por razões que não têm a ver com levodopa, e incluí-los infla a concordância.`
          }));
        }
      } else if (temDiario || hemis.length) node.appendChild(el('div', {
        class: 'note', html: `<b>Sobreposição diário × LFP.</b> Com o diário <i>e</i> o Timeline carregados ao mesmo tempo, esta figura ` +
          `mede célula a célula, na mesma grade, o quanto o beta acompanha o estado autorreportado — que é a verificação que torna ` +
          `a concordância auditável em vez de assumida. ` +
          (temDiario ? 'Falta um arquivo com BrainSense Timeline.' : 'Falta carregar o diário em CSV.')
      }));
    }
  },

  /* ----------------------------------------------------------------- F31 */
  {
    id: 'F31', title: 'Passaporte do biomarcador — o que a sessão aguda calibra no crônico',
    sub: 'par bipolar, pico, banda e SNR versionados · confronto com a configuração vigente do aparelho',
    has: d => d.montage.length || d.sensingSetup.length || d.signalCheck.length,
    render(node, d) {
      const pb = profileBands().primary || { lo: 13, hi: 35 };
      const crit = opt('F31', 'crit', 'aperiodic');
      const modo = opt('F31', 'bandmode', 'apriori');
      const larg = opt('F31', 'larg', 5);
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('critério de escolha do par', [
          { value: 'aperiodic', label: 'área acima do fundo 1/f' },
          { value: 'raw', label: 'área bruta na banda' },
          { value: 'peak', label: 'magnitude do pico' }
        ], crit, v => setOpt('F31', 'crit', v)),
        ctrlSelect('banda', [
          { value: 'apriori', label: `a priori ${pb.lo}–${pb.hi} Hz` },
          { value: 'peak', label: 'centrada no pico do paciente' }
        ], modo, v => setOpt('F31', 'bandmode', v)),
        modo === 'peak' ? ctrlNumber('largura (Hz)', larg, 2, 20, 1, v => setOpt('F31', 'larg', v)) : el('span')
      ]));

      const pass = C.biomarkerPassport(activeFiles()[0].parsed, {
        criterion: crit, bandSearch: [pb.lo, pb.hi], bandMode: modo, peakBandwidthHz: larg
      });
      if (!pass.ok) return node.appendChild(el('div', { class: 'empty', text: pass.reason }));

      /* ---------------- (a) o passaporte ------------------------------- */
      const linhas = [];
      ['Left', 'Right'].forEach(h => {
        const b = pass.byHemisphere[h];
        if (!b || b.channel == null) { linhas.push([`${rotuloLado(h)}`, '—', '—', '—', { html: '<i>sem espectro neste arquivo</i>' }]); return; }
        linhas.push([
          `${rotuloLado(h)}`,
          `${b.label} (#${b.rank} de ${b.nCandidates})`,
          isFinite(b.peakHz) ? `${f(b.peakHz, 2)} Hz` : '—',
          `${f(b.bandLo, 1)}–${f(b.bandHi, 1)} Hz`,
          {
            html: b.usable
              ? `<b style="color:var(--ok)">utilizável</b> · SNR ${f(b.snrDb, 2)} dB`
              : `<b style="color:var(--warn)">não utilizável</b> — ${b.reason || 'motivo não declarado'}`
          }
        ]);
      });
      node.appendChild(table(['hemisfério', 'par bipolar', 'pico', 'banda', 'veredito'], linhas));

      /* o detalhe metodológico de cada hemisfério, que é onde mora a ressalva */
      ['Left', 'Right'].forEach(h => {
        const b = pass.byHemisphere[h];
        if (!b || b.channel == null) return;
        node.appendChild(table([`${rotuloLado(h)} — como este número foi obtido`, 'valor', 'o que significa'], [
          ['definição do SNR', `${f(b.snrDb, 2)} dB`, b.snrDefinition || '—'],
          ['pico sobrevive ao fundo 1/f?', b.peakSurvivesAperiodic ? 'sim' : 'não',
            isFinite(b.peakExcessOverBackgroundPct) ? `excesso de ${f(b.peakExcessOverBackgroundPct, 0)}% sobre o fundo aperiódico` : '—'],
          ['expoente aperiódico', f(b.aperiodicExponent, 3), `R² do ajuste ${f(b.aperiodicR2, 3)}${b.aperiodicR2 < 0.5 ? ' — abaixo de 0,5, o ajuste não é confiável' : ''}`],
          ['origem do pico', b.peakSource || '—', b.bandNote || '—'],
          ['suspeita de ECG', b.ecgSuspected ? 'SIM' : 'não',
            b.ecgSuspected ? 'este canal pode carregar artefato cardíaco — confira na aba Qualidade antes de usar' : 'nenhum indício nas verificações possíveis']
        ]));
      });

      /* ---------------- (b) sugestão vs. aparelho ---------------------- */
      node.appendChild(el('h4', { class: 'qc-title', html: '<b>(b) O que o aparelho está registrando é o que a sessão calibrou?</b>' }));
      const sug = C.passportSensingSuggestion(pass);
      const cfg = C.sensingConfigOf(activeFiles()[0].parsed);
      const m = (cfg && cfg.ok) ? C.passportMatchesConfig(pass, cfg) : null;

      if (sug && sug.ok) {
        node.appendChild(table(['hemisfério', 'sugestão de sensing', 'confiança', 'por quê'],
          ['Left', 'Right'].map(h => {
            const s = sug.byHemisphere[h];
            if (!s) return [`${rotuloLado(h)}`, '—', '—', 'sem passaporte utilizável'];
            return [`${rotuloLado(h)}`,
              `${f(s.centerFreq, 2)} Hz · ${s.label || s.channel}`,
              s.confidence, s.rationale];
          })));
      }
      if (m && m.ok) {
        node.appendChild(el('div', {
          class: m.match ? 'note' : 'warnbox',
          html: `<b>${m.verdict}.</b> ${m.consequence || ''}`
        }));
        const difs = [];
        ['Left', 'Right'].forEach(h => {
          const bh = m.byHemisphere && m.byHemisphere[h];
          (bh && bh.differences || []).forEach(dd => difs.push([
            `${rotuloLado(h)}`, dd.field,
            String(dd.passport == null ? '—' : dd.passport),
            String(dd.device == null ? '—' : dd.device),
            dd.matters ? 'invalida a comparação de escala' : 'não invalida'
          ]));
        });
        if (difs.length) node.appendChild(table(['hemisfério', 'campo', 'passaporte', 'aparelho', 'consequência'], difs));
      } else {
        node.appendChild(el('div', {
          class: 'note', html: `Este arquivo não declara a configuração de sensing vigente (falta <code>BrainSenseLfp</code> com ` +
            `<code>TherapySnapshot</code>), então não há como confrontar a sugestão com o que o aparelho está de fato registrando.`
        }));
      }

      node.appendChild(el('div', {
        class: 'note', html: `<b>Por que este objeto existe.</b> A sessão aguda é o que <b>define</b> o biomarcador; o registro ` +
          `crônico apenas o acompanha. Sem guardar qual par bipolar, qual pico e qual banda originaram a série, comparar dois ` +
          `meses de Timeline é comparar duas variáveis diferentes com o mesmo nome. A impressão digital <code>${pass.fingerprint}</code> ` +
          `identifica esta calibração: se ela mudar entre duas análises, os números não são comparáveis. ` +
          `${pass.fingerprintNote || ''}`
      }));
      /* --- o par do passaporte, desenhado no eletrodo do paciente -------- */
      {
        const marcas = {};
        ['Left', 'Right'].forEach(h => {
          const b = pass.byHemisphere[h];
          if (!b || b.channel == null) return;
          const ids = C.contactsOfChannel(b.channel);
          if (ids.length) marcas[h] = marcasDeContatos(ids, b.usable ? 'sensing' : 'flag');
        });
        if (Object.keys(marcas).length) {
          node.appendChild(el('h4', { class: 'qc-title', html: '<b>Onde o biomarcador foi definido</b>' }));
          painelEletrodosBilateral(node, marcas, { altura: 250 });
          node.appendChild(el('div', {
            class: 'lead-legenda',
            html: `<span style="color:${P.LEAD_CORES.sensing}">■</span> par utilizável · ` +
              `<span style="color:${P.LEAD_CORES.flag}">■</span> par escolhido mas NÃO utilizável`
          }));
        }
      }

      node.appendChild(el('div', {
        class: 'note', html: '<b>Qual critério o APARELHO usa.</b> No BrainSense Setup o dispositivo escolhe ' +
          'automaticamente o <b>maior pico do canal</b>, desde que esse pico esteja na faixa de <b>beta ou gama</b> e ' +
          'ultrapasse <b>1,1 µVp</b>. Esse limiar é do fabricante, não deste software — e o critério do aparelho não é ' +
          'o mesmo usado aqui, que corrige pelo fundo aperiódico antes de escolher. Divergência entre a sugestão desta ' +
          'figura e a configuração vigente pode ser exatamente isso, e não erro de nenhum dos dois. ' +
          '[Medtronic UC202012929cEN FY24, p. 6]'
      }));
      if (pass.controversy) node.appendChild(el('div', { class: 'note', html: `<b>Controvérsia declarada.</b> ${pass.controversy}` }));
      if (pass.caveat) node.appendChild(el('div', { class: 'warnbox', html: `<b>Limite.</b> ${pass.caveat}` }));

      node.appendChild(el('div', {
        class: 'seal', text: `${pass.quality.nSpectra} espectro(s) · ${pass.quality.nHemispheresUsable} de ` +
          `${pass.quality.nHemispheresWithSpectrum} hemisfério(s) utilizável(is) · ECG avaliado em ${pass.quality.ecgEvaluated} · ` +
          `impressão digital ${pass.fingerprint}`
      }));
      node.appendChild(exportRow([
        {
          label: '⤓ Passaporte (JSON)', fn: () => P.downloadText(JSON.stringify(Object.assign({}, pass, {
            suggestion: sug, deviceConfig: cfg, match: m
          }), null, 2), `passaporte_${pass.fingerprint}.json`, 'application/json')
        },
        {
          label: '⤓ CSV', fn: () => P.downloadText(P.toCSV(['Left', 'Right'].map(h => {
            const b = pass.byHemisphere[h] || {};
            return {
              hemisphere: h, channel: b.channel || '', label: b.label || '',
              peak_hz: b.peakHz, band_lo_hz: b.bandLo, band_hi_hz: b.bandHi,
              snr_db: b.snrDb, aperiodic_exponent: b.aperiodicExponent, aperiodic_r2: b.aperiodicR2,
              peak_survives_aperiodic: b.peakSurvivesAperiodic ? 1 : 0,
              ecg_suspected: b.ecgSuspected ? 1 : 0, usable: b.usable ? 1 : 0,
              rank: b.rank, n_candidates: b.nCandidates,
              criterion: pass.params && pass.params.criterion, fingerprint: pass.fingerprint
            };
          })), 'F31_passaporte.csv', 'text/csv')
        }
      ]));
    }
  },


  /* ----------------------------------------------------------------- F32 */
  {
    id: 'F32', title: 'Blocos de configuração e pontos de mudança',
    sub: 'a série crônica partida onde o aparelho deixou de medir a mesma variável · degraus de nível e os marcos que os explicam',
    has: d => Object.keys(d.trend).length,
    render(node, d) {
      const hemis = Object.keys(d.trend);
      const h = opt('F32', 'hemi', hemis[0]);
      const atrib = opt('F32', 'atrib', 'retrospectiva');
      const agreg = opt('F32', 'agreg', 'median');
      const tolDias = opt('F32', 'tol', 2);
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('hemisfério', hemis.map(x => ({ value: x, label: `${rotuloLado(x)}` })), h, v => setOpt('F32', 'hemi', v)),
        ctrlSelect('atribuição temporal', [
          { value: 'retrospectiva', label: 'retrospectiva — a sessão descreve o período anterior' },
          { value: 'prospectiva', label: 'prospectiva — a sessão abre o período seguinte' }
        ], atrib, v => setOpt('F32', 'atrib', v)),
        ctrlSelect('resumo do dia', [
          { value: 'median', label: 'mediana' }, { value: 'mean', label: 'média' }
        ], agreg, v => setOpt('F32', 'agreg', v)),
        ctrlNumber('tolerância do marco (dias)', tolDias, 0, 10, 1, v => setOpt('F32', 'tol', v))
      ]));

      const blocos = C.configBlocks(d.all, offMin(), { attribution: atrib });
      const rows = d.trend[h] || [];
      const seg = C.segmentTrendByConfig(rows, blocos);

      /* ---------------- (a) a série, partida onde precisa ser -------------- */
      const finitos = rows.filter(r => isFinite(r.t) && isFinite(r.lfp));
      if (!finitos.length) return node.appendChild(el('div', { class: 'empty', text: 'nenhum ponto do Timeline com data e valor utilizáveis neste hemisfério' }));
      const tmin = Math.min(...finitos.map(r => r.t)), tmax = Math.max(...finitos.map(r => r.t));
      const vmax = Math.max(...finitos.map(r => r.lfp));
      const box = plotBox(node, 300);
      const ch = new P.Chart(box.canvas, {
        width: box.width, height: box.height, xlim: [tmin, tmax], ylim: [0, vmax * 1.15],
        xlabel: 'data local', ylabel: 'potência LFP (u.a.)',
        title: `${rotuloLado(h)} — ${seg.nSegments || 0} segmento(s) de configuração`,
        pad: { l: 62, r: 20, t: 24, b: 42 }
      });
      ch.axes({ nx: 7, xfmt: v => new Date(v + offMin() * 60000).toISOString().slice(5, 10).split('-').reverse().join('/') });

      const paleta = ['#2C6E9B', '#B5651D', '#4C8C4A', '#8E5AA0', '#B03A48', '#7A7A2E'];
      (seg.segments || []).forEach((s, i) => {
        const pts = (s.rows || []).filter(r => isFinite(r.t) && isFinite(r.lfp));
        if (!pts.length) return;
        const cor = s.blockIndex == null ? '#8A8F98' : paleta[s.blockIndex % paleta.length];
        const xs = pts.map(r => r.t), ys = pts.map(r => r.lfp);
        ch.scatter(xs, ys, { color: cor, size: 1.1, alpha: .25 });
        /* a linha NUNCA atravessa a fronteira: cada segmento é uma linha própria */
        ch.line(xs, movingMedian(ys, 6), {
          color: cor, width: 1.8,
          label: s.blockIndex == null ? 'sem configuração conhecida' : `bloco ${s.blockIndex + 1}`
        });
      });
      /* fronteiras: faixa vertical larga, para que a descontinuidade seja vista */
      (blocos.blocks || []).forEach((b, i) => {
        if (i === 0 || !isFinite(b.startT)) return;
        ch.span(b.startT - 3 * 36e5, b.startT + 3 * 36e5, { color: '#B03A48', alpha: .16 });
      });
      ch.legend({ x: ch.x0 + 8, y: ch.y1 + 6 });

      if (blocos.ok && blocos.nBlocks > 1) node.appendChild(el('div', {
        class: 'warnbox',
        html: `<b>A série está partida em ${blocos.nBlocks} blocos e as linhas não se conectam de propósito.</b> ` +
          'Atravessar a fronteira com uma linha contínua sugeriria que os dois trechos medem a mesma coisa. ' +
          'Não medem: o par bipolar ou a frequência central mudou entre eles.'
      }));
      const aviso = C.crossBlockWarning(blocos);
      if (aviso && aviso.message) node.appendChild(el('div', {
        class: aviso.safe ? (aviso.level === 'atencao' ? 'note' : 'note') : 'warnbox',
        html: `<b>Comparação entre períodos — ${aviso.level}.</b> ${aviso.message}`
      }));
      if (!blocos.ok) node.appendChild(el('div', {
        class: 'note', html: `<b>Sem blocos de configuração.</b> ${blocos.reason} — a série abaixo foi tratada como um ` +
          'único trecho, o que só é legítimo se a configuração de fato não mudou, e este arquivo não permite verificar isso.'
      }));

      /* ---------------- (b) tabela de blocos ------------------------------ */
      if ((blocos.blocks || []).length) node.appendChild(table(
        ['bloco', 'período atribuído', 'configuração', 'n pontos', 'faltantes', 'dias'],
        blocos.blocks.map((b, i) => {
          const s = (seg.segments || []).find(x => x.blockIndex === i) || {};
          return [
            { html: `<span style="color:${paleta[i % paleta.length]}">■</span> ${i + 1}` },
            `${b.startT ? new Date(b.startT + offMin() * 60000).toISOString().slice(0, 10) : '—'} → ` +
            `${b.endT ? new Date(b.endT + offMin() * 60000).toISOString().slice(0, 10) : '—'}`,
            b.summary || '—',
            s.n == null ? 0 : s.n,
            isFinite(s.pctMissing) ? `${f(s.pctMissing, 1)}%` : '—',
            isFinite(s.nDaysObserved) ? f(s.nDaysObserved, 1) : '—'
          ];
        })));

      if ((blocos.changes || []).length) node.appendChild(table(
        ['dia', 'hemisfério', 'o que mudou', 'de', 'para', 'gravidade', 'consequência'],
        blocos.changes.map(c => [
          c.dayLocal || '—', c.hemisphere === 'Ambos' ? 'ambos' : hname(c.hemisphere), c.field,
          String(c.from == null ? '—' : c.from), String(c.to == null ? '—' : c.to),
          { html: c.severity === 'quebra' ? '<b style="color:var(--warn)">quebra</b>' : c.severity },
          c.consequence || '—'
        ])));
      if ((blocos.undeclared || []).length) node.appendChild(el('div', {
        class: 'note', html: `<b>Não verificável.</b> ${blocos.undeclared.length} campo(s) não puderam ser comparados entre ` +
          'sessões porque ao menos uma delas não os declara. Isso não é "sem mudança", é "não dá para saber": ' +
          (blocos.undeclared.slice(0, 4).map(u => `${u.field}${u.hemisphere && u.hemisphere !== 'Ambos' ? ' (' + hname(u.hemisphere) + ')' : ''}`).join(', ')) +
          (blocos.undeclared.length > 4 ? ` e mais ${blocos.undeclared.length - 4}` : '') + '.'
      }));

      /* ---------------- (c) pontos de mudança de nível -------------------- */
      node.appendChild(el('h4', { class: 'qc-title', html: '<b>(c) O nível mudou por degrau? E existe marco que explique?</b>' }));
      const cp = C.changePointsInTime(finitos, { offMin: offMin(), aggregation: agreg });
      if (!cp.ok) {
        node.appendChild(el('div', { class: 'note', html: `<b>Não avaliado.</b> ${cp.reason}` }));
      } else {
        /* marcos conhecidos: mudanças de configuração e eventos do aparelho */
        const marcos = (blocos.changes || []).filter(c => isFinite(c.t))
          .map(c => ({ t: c.t, label: `${c.field} (${c.severity})` }))
          .concat((d.eventLogs || []).filter(e => isFinite(e.t)).map(e => ({ t: e.t, label: [e.kind, e.detail].filter(Boolean).join(' · ') || 'evento' })));
        const an = C.annotateChangePoints(cp.points, marcos, { toleranceDays: tolDias });
        (an.annotated || []).forEach(a => ch.vline(a.t, { color: a.explained ? '#4C8C4A' : '#B03A48', width: 1.4, dash: [4, 3] }));
        node.appendChild(table(['dia da mudança', 'variação', 'p', 'marco mais próximo', 'distância (dias)', 'explicado?'],
          (an.annotated || []).map(a => [
            a.dayKey, f(a.delta, 3), { html: pHtml(a.p) },
            a.nearestMarker || '—', isFinite(a.deltaDays) ? f(a.deltaDays, 1) : '—',
            { html: a.explained ? 'sim' : '<b style="color:var(--warn)">não</b>' }
          ])));
        node.appendChild(el('div', { class: an.nUnexplained ? 'warnbox' : 'note', html: `<b>Leitura.</b> ${an.reading}` }));
        node.appendChild(el('div', { class: 'note', html: `<b>Limite.</b> ${an.caveat}` }));
        node.appendChild(el('div', { class: 'note', html: `<b>Método.</b> ${cp.note} ${cp.method || ''} ` +
          `Significância por ${cp.nPermutations || 0} permutações da própria janela; ${cp.nDays} dias analisados.` }));
      }

      node.appendChild(el('div', {
        class: 'seal', text: `${blocos.nSessionsUsable || 0} de ${blocos.nSessionsRead || 0} sessão(ões) com configuração ` +
          `legível · atribuição ${blocos.attribution} · largura de banda ${f(blocos.bandwidthHz, 1)} Hz (${blocos.bandwidthSource})`
      }));
      if (blocos.caveat) node.appendChild(el('div', { class: 'note', html: `<b>Parâmetro assumido.</b> ${blocos.caveat}` }));
      node.appendChild(exportRow([
        { label: '⤓ PNG', fn: () => P.downloadCanvas(box.canvas, 'F32_blocos_configuracao') },
        {
          label: '⤓ CSV — série segmentada', fn: () => P.downloadText(P.toCSV((seg.segments || []).flatMap(s =>
            (s.rows || []).map(r => ({
              hemisphere: h, block_index: s.blockIndex == null ? '' : s.blockIndex + 1,
              config: s.configSummary || '', utc: new Date(r.t).toISOString(),
              local: new Date(r.t + offMin() * 60000).toISOString().slice(0, 19),
              lfp: isFinite(r.lfp) ? r.lfp : '', missing: isFinite(r.lfp) ? 0 : 1
            })))), 'F32_serie_segmentada.csv', 'text/csv')
        },
        {
          label: '⤓ JSON — blocos e mudanças', fn: () => P.downloadText(JSON.stringify({
            blocks: blocos, segmentation: Object.assign({}, seg, { segments: (seg.segments || []).map(s => Object.assign({}, s, { rows: undefined })) })
          }, null, 2), 'F32_blocos.json', 'application/json')
        }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: '<b>Por que esta figura vem antes de qualquer comparação longitudinal.</b> O confundidor mais ' +
          'comum de um registro crônico do Percept não é fisiológico: é o próprio aparelho ter passado a medir outra coisa. ' +
          'Trocar o par bipolar ou a frequência central muda o valor absoluto da potência sem que nada mude no paciente. ' +
          'Comparar "seis semanas atrás" com "hoje" atravessando essa fronteira produz uma diferença que parece clínica e é ' +
          'de instrumentação.'
      }));
    }
  },

  /* ----------------------------------------------------------------- F36 */
  /* TIDAL-DT — limiares de dual threshold derivados do Timeline crônico.
     A pedido do projeto, os textos de UI DESTA figura são em inglês; os
     comentários seguem em pt-BR como o resto do repositório. O núcleo vive em
     core/metrics/tidal.js (namespace C.TIDAL) — a figura só orquestra.      */
  {
    id: 'F36', title: 'Assistente de limiares de aDBS (TIDAL-DT)',
    sub: 'Timeline-derived automated limits for dual threshold · Hampel → wake/sleep → GMM/BIC → controller simulation',
    has: d => Object.keys(d.trend).length,
    render(node, d) {
      avisoDeAlvo(node, 'O TIDAL-DT deriva limiares do método de percentis diurnos validado em beta subtalâmico (Busch et al. 2025; ADAPT-START 2026)');
      const T = C.TIDAL;
      const hemis = Object.keys(d.trend);
      const device = opt('F36', 'device', 'PC');
      const iMin = parseFloat(opt('F36', 'imin', ''));
      const iMax = parseFloat(opt('F36', 'imax', ''));
      const hw = opt('F36', 'hw', T.DEFAULTS.hampelWindow);
      const hk = opt('F36', 'hk', T.DEFAULTS.hampelK);
      const minValid = opt('F36', 'minvalid', 100 * T.DEFAULTS.minValidDayFrac);
      const maxRej = opt('F36', 'maxrej', 100 * T.DEFAULTS.maxRejectedDayFrac);
      const step = device === 'RC' ? T.DEFAULTS.stepRC : T.DEFAULTS.stepPC;

      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('device', [{ value: 'PC', label: 'Percept PC (0.1 mA steps)' }, { value: 'RC', label: 'Percept RC (0.01 mA steps)' }],
          device, v => setOpt('F36', 'device', v)),
        ctrlText('min current (mA)', opt('F36', 'imin', ''), 'clinician input', v => setOpt('F36', 'imin', v)),
        ctrlText('max current (mA)', opt('F36', 'imax', ''), 'clinician input', v => setOpt('F36', 'imax', v)),
        el('button', { class: 'btn', text: 'Run self-test', onclick: () => setOpt('F36', 'selftest', Date.now()) })
      ]));
      /* Advanced settings — os parâmetros que mudam número ficam editáveis e
         declarados, nunca enterrados em constante */
      {
        const det = el('details', { class: 'evid' });
        det.appendChild(el('summary', { text: 'Advanced settings' }));
        det.appendChild(el('div', { class: 'ctrls' }, [
          ctrlNumber('Hampel window (samples)', hw, 4, 48, 2, v => setOpt('F36', 'hw', v)),
          ctrlNumber('Hampel k (×MAD)', hk, 1, 6, .5, v => setOpt('F36', 'hk', v)),
          ctrlNumber('min valid samples per day (%)', minValid, 30, 100, 5, v => setOpt('F36', 'minvalid', v)),
          ctrlNumber('max rejected per day (%)', maxRej, 5, 50, 5, v => setOpt('F36', 'maxrej', v))
        ]));
        node.appendChild(det);
      }

      /* self-test sintético: recuperar limiares conhecidos com erro < 10% */
      if (opt('F36', 'selftest', 0)) {
        const st = T.selfTest();
        node.appendChild(el('div', {
          class: st.pass ? 'note' : 'warnbox',
          html: `<b>Self-test ${st.pass ? 'PASS' : 'FAIL'}.</b> Synthetic Timeline (circadian cycle + 4-h medication ` +
            `cycles + 1% outliers, deterministic seed): proposed ${st.proposed.lower}/${st.proposed.upper} vs ground truth ` +
            `${st.truth.lower}/${st.truth.upper} LFP — error ${st.errLowerPct}% / ${st.errUpperPct}% (acceptance < 10%). ` +
            `Wake window recovered: ${st.wake[0]}–${st.wake[1]} h (truth ${st.truth.wake[0]}–${st.truth.wake[1]} h).`
        }));
      }

      const csvRows = [];
      hemis.forEach(h => {
        node.appendChild(el('h3', { class: 'qc-title', html: `<span class="hemi-${h[0]}">${rotuloLado(h)}</span> — TIDAL-DT proposal` }));

        /* mudança de configuração no meio do registro: segmenta e usa apenas o
           segmento mais longo (desempate: o mais recente), declarando isso */
        let rows = d.trend[h];
        let segNote = null;
        const blocos = C.configBlocks(d.all, offMin());
        const segm = C.segmentTrendByConfig(rows, blocos);
        if (segm && segm.segments && segm.segments.length > 1) {
          const comDados = segm.segments.filter(s => s.rows && s.rows.length);
          if (comDados.length > 1) {
            const escolhido = comDados.reduce((a, b) =>
              b.rows.length > a.rows.length || (b.rows.length === a.rows.length && b.rows[0].t > a.rows[0].t) ? b : a);
            rows = escolhido.rows;
            segNote = `Sensing configuration changed mid-record: ${comDados.length} segments found; using the longest, most ` +
              `recent one (${escolhido.rows.length} samples). Thresholds are only valid for the configuration they were derived from.`;
          }
        }
        if (segNote) node.appendChild(el('div', { class: 'warnbox', html: `<b>Segmented record.</b> ${segNote}` }));

        const res = T.runPipeline(rows, offMin(), {
          hampelWindow: hw, hampelK: hk,
          minValidDayFrac: minValid / 100, maxRejectedDayFrac: maxRej / 100,
          iMin, iMax, step
        });
        if (!res.ok) {
          node.appendChild(el('div', { class: 'warnbox', html: `<b>Cannot propose thresholds.</b> ${res.reason}` }));
          if (res.days && res.days.excluded.length) node.appendChild(table(['excluded day', 'reason'],
            res.days.excluded.map(x => [x.day, x.reason])));
          return;
        }
        const p = res.proposal;

        /* (a) histograma do log-beta de vigília + curvas do GMM + limiares */
        const box = plotBox(node, 240);
        {
          const xs = res.wakeRows.map(r => r.x).filter(isFinite);
          const lo = Math.min.apply(null, xs), hi = Math.max.apply(null, xs);
          const nb = 42, bw = (hi - lo) / nb || 1;
          const cont = new Float64Array(nb);
          xs.forEach(v => cont[Math.min(nb - 1, Math.floor((v - lo) / bw))]++);
          const ymax = Math.max.apply(null, Array.from(cont));
          const ch = new P.Chart(box.canvas, {
            width: box.width, height: box.height, xlim: [lo, hi], ylim: [0, ymax * 1.15],
            xlabel: 'log10(LFP+1), wake only', ylabel: 'samples', title: `wake histogram, GMM and proposed thresholds — ${p.method}`,
            pad: { l: 58, r: 14, t: 24, b: 40 }
          });
          ch.axes({ nx: 6 });
          const ctx = ch.ctx;
          ctx.fillStyle = h === 'Left' ? 'rgba(27,74,114,.35)' : 'rgba(156,48,80,.35)';
          for (let i = 0; i < nb; i++) {
            const x0 = ch.X(lo + i * bw), x1 = ch.X(lo + (i + 1) * bw);
            ctx.fillRect(x0 + .5, ch.Y(cont[i]), Math.max(1, x1 - x0 - 1), ch.Y(0) - ch.Y(cont[i]));
          }
          if (p.gmm2 && p.bimodal) {
            const g = p.gmm2, N = xs.length;
            const dens = (x, m, s, w) => w * N * bw * Math.exp(-0.5 * ((x - m) / s) ** 2) / (s * Math.sqrt(2 * Math.PI));
            const gx = [], g1 = [], g2 = [];
            for (let i = 0; i <= 160; i++) {
              const x = lo + (hi - lo) * i / 160;
              gx.push(x); g1.push(dens(x, g.means[0], g.sigmas[0], g.weights[0])); g2.push(dens(x, g.means[1], g.sigmas[1], g.weights[1]));
            }
            ch.line(gx, g1, { color: COL.accent, width: 1.6, label: 'component 1 (medicated ON)' });
            ch.line(gx, g2, { color: CORBETA, width: 1.6, label: 'component 2 (OFF)' });
          }
          ch.vline(Math.log10(p.lower + 1), { color: COL.ok, width: 1.6, dash: [5, 3] });
          ch.vline(Math.log10(p.upper + 1), { color: COL.Right, width: 1.6, dash: [5, 3] });
          ch.text(ch.X(Math.log10(p.lower + 1)) + 4, ch.y1 + 12, `lower ${p.lower}`, { color: COL.ok });
          ch.text(ch.X(Math.log10(p.upper + 1)) + 4, ch.y1 + 24, `upper ${p.upper}`, { color: COL.Right });
          ch.legend({ x: ch.x0 + 8, y: ch.y1 + 6 });
        }

        /* (b) heatmap dia × hora com a máscara de vigília */
        {
          const dias = res.days.used;
          const alt = Math.max(90, 16 + dias.length * 9);
          const boxH = plotBox(node, alt);
          const cv = boxH.canvas;
          cv.width = boxH.width; cv.height = alt;
          cv.style.height = alt + 'px';
          const ctx = cv.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, alt);
          const mL = 64, mT = 8, wPlot = cv.width - mL - 8, hRow = (alt - mT - 18) / Math.max(1, dias.length);
          const porDiaBin = new Map();
          res.allRows.forEach(r => {
            const dk = C.localDayKey(r.t, offMin());
            if (!porDiaBin.has(dk)) porDiaBin.set(dk, new Float64Array(144).fill(NaN));
            porDiaBin.get(dk)[Math.min(143, Math.floor(C.localHour(r.t, offMin()) * 6))] = isFinite(r.x) ? r.x : (r.artifact ? -1 : NaN);
          });
          const todos = res.cleanRows.map(r => r.x);
          const vlo = C.quantile(todos, .02), vhi = C.quantile(todos, .98);
          dias.forEach((dk, i) => {
            const linha = porDiaBin.get(dk) || new Float64Array(144).fill(NaN);
            for (let b = 0; b < 144; b++) {
              const v = linha[b];
              const x = mL + b / 144 * wPlot, y = mT + i * hRow;
              if (!isFinite(v)) { ctx.fillStyle = '#EEF1F4'; }
              else if (v === -1) { ctx.fillStyle = '#C24A63'; }
              else {
                const f = Math.max(0, Math.min(1, (v - vlo) / (vhi - vlo || 1)));
                const c = Math.round(235 - f * 195);
                ctx.fillStyle = `rgb(${c},${Math.round(c * 1.02)},${Math.min(255, c + 40)})`;
              }
              ctx.fillRect(x, y, Math.ceil(wPlot / 144), Math.ceil(hRow));
            }
            ctx.fillStyle = '#5C7284'; ctx.font = '9px ui-monospace,monospace'; ctx.textAlign = 'right';
            ctx.fillText(dk.slice(5), mL - 4, mT + i * hRow + hRow * .8);
          });
          /* máscara de vigília: bordas verticais */
          const [wa, wb] = res.wake.wake;
          ctx.strokeStyle = '#0C6E6B'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
          [wa, wb].forEach(hh => {
            const x = mL + hh / 24 * wPlot;
            ctx.beginPath(); ctx.moveTo(x, mT); ctx.lineTo(x, mT + dias.length * hRow); ctx.stroke();
          });
          ctx.setLineDash([]);
          ctx.fillStyle = '#0E1A24'; ctx.textAlign = 'left'; ctx.font = '10px ui-monospace,monospace';
          ctx.fillText(`day × hour heatmap · wake mask ${res.wake.wake[0]}–${res.wake.wake[1]} h (${res.wake.method}) · red = artifact`, mL, alt - 5);
          try { cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', `day-by-hour heatmap with wake mask ${res.wake.wake[0]} to ${res.wake.wake[1]} hours`); } catch (e) { }
        }

        /* (c) série temporal com os limiares sobrepostos */
        {
          const boxS = plotBox(node, 190);
          const xs = res.cleanRows.map(r => r.t), ys = res.cleanRows.map(r => r.lfp);
          const ymax = Math.max.apply(null, ys.filter(isFinite)) * 1.1;
          const ch = new P.Chart(boxS.canvas, {
            width: boxS.width, height: boxS.height, xlim: [xs[0], xs[xs.length - 1]], ylim: [0, ymax],
            xlabel: 'local date', ylabel: 'LFP (native units)', title: 'cleaned Timeline with proposed thresholds',
            pad: { l: 62, r: 12, t: 22, b: 38 }
          });
          ch.axes({ nx: 6, xfmt: v => new Date(v + offMin() * 60000).toISOString().slice(5, 10) });
          ch.line(xs, ys, { color: hcol(h), width: .7 });
          ch.hline(p.lower, { color: COL.ok, width: 1.4, dash: [5, 3] });
          ch.hline(p.upper, { color: COL.Right, width: 1.4, dash: [5, 3] });
          const tuned = opt('F36', 'tune_' + h, null);
          if (tuned) {
            ch.hline(tuned.lower, { color: COL.ok, width: 1, dash: [2, 3] });
            ch.hline(tuned.upper, { color: COL.Right, width: 1, dash: [2, 3] });
          }
        }

        /* (d) métricas da simulação */
        const s = res.sim;
        const alvo = T.DEFAULTS.targets, acc = T.DEFAULTS.accept;
        const okz = (v, [a, b]) => v >= a && v <= b;
        node.appendChild(table(['metric', 'value', 'target', 'acceptance', 'status'], [
          ['% time below lower', f(s.pctBelow, 1) + '%', alvo.below + '%', `${acc.below[0]}–${acc.below[1]}%`, okz(s.pctBelow, acc.below) ? '✓' : '✗'],
          ['% time within band', f(s.pctWithin, 1) + '%', alvo.within + '%', `${acc.within[0]}–${acc.within[1]}%`, okz(s.pctWithin, acc.within) ? '✓' : '✗'],
          ['% time above upper', f(s.pctAbove, 1) + '%', alvo.above + '%', `${acc.above[0]}–${acc.above[1]}%`, okz(s.pctAbove, acc.above) ? '✓' : '✗'],
          ['zone transitions per day', s.transitionsPerDay, '—', '—', ''],
          ['% time saturated at current limits', s.hasCurrent ? f(s.pctSaturated, 1) + '%' : 'enter current limits above', 'low', '—',
            s.hasCurrent ? (s.pctSaturated < 25 ? '✓' : '✗') : '○']
        ]));
        if (!s.hasCurrent) node.appendChild(el('div', {
          class: 'note', html: `<b>Current limits are clinician input.</b> Min/max stimulation current is a safety decision ` +
            `this module does not automate — enter both fields above to simulate the current trajectory and saturation.`
        }));
        const foraDasFaixas = !okz(s.pctBelow, acc.below) || !okz(s.pctWithin, acc.within) || !okz(s.pctAbove, acc.above);
        if (foraDasFaixas) {
          const linhaTune = el('div', { class: 'ctrls' });
          linhaTune.appendChild(el('button', {
            class: 'btn', text: 'Auto-tune (±15% grid search)', onclick: () => {
              const at = T.autoTune(res.wakeRows.map(r => r.lfp), p, {
                iMin, iMax, step, dayKeys: res.wakeRows.map(r => C.localDayKey(r.t, offMin()))
              });
              setOpt('F36', 'tune_' + h, { lower: at.lower, upper: at.upper, cost: at.cost, baseCost: at.baseCost });
            }
          }));
          const tuned = opt('F36', 'tune_' + h, null);
          if (tuned) linhaTune.appendChild(el('span', {
            class: 'exphint', text: `auto-tuned: ${tuned.lower}/${tuned.upper} (cost ${f(tuned.cost, 1)} vs ${f(tuned.baseCost, 1)} at proposal)`
          }));
          node.appendChild(linhaTune);
        }

        /* (d2) armadilhas da prática real (ADAPT-START / van Rheede) — camada
           de leitura clínica FORA do espelho JS↔R do TIDAL (C.PRACTICE)     */
        {
          const PR2 = C.PRACTICE;
          /* meta de janela de amplitude ≥ 0,7 mA */
          const wc = PR2.amplitudeWindowCheck(iMin, iMax);
          if (wc.ok && !wc.meetsTarget) node.appendChild(el('div', {
            class: 'warnbox', html: `<b>Amplitude window below target.</b> ${wc.widthMa} mA between current limits — ` +
              `ADAPT-START's empirical target is ≥${wc.targetMa} mA of working range (ceiling 1.5 mA in that study). ` +
              `A narrow window gives the controller little room to modulate.`
          }));
          /* congelamento entre limiares + cDBS de dois níveis */
          if (s.hasCurrent && s.trajectory) {
            const trap = PR2.dualThresholdTrap(s.trajectory, {
              iMin, iMax, dayKeys: res.wakeRows.map(r => C.localDayKey(r.t, offMin()))
            });
            if (trap.ok) node.appendChild(el('div', {
              class: trap.functionallyCdbs ? 'warnbox' : 'note',
              html: `<b>Dual-threshold behavior check${trap.functionallyCdbs ? ' — TWO-LEVEL cDBS PATTERN' : ''}.</b> ` +
                `Simulated current pinned at the limits ${f(trap.pctPinnedHigh + trap.pctPinnedLow, 0)}% of the time ` +
                `(${f(trap.pctPinnedHigh, 0)}% ceiling / ${f(trap.pctPinnedLow, 0)}% floor), ${trap.fullSwingsPerDay} full ` +
                `limit-to-limit crossings per day. ` +
                (trap.functionallyCdbs
                  ? `This is the pattern ADAPT-START described as functionally a two-level cDBS, not an aDBS. `
                  : ``) +
                `Freeze caveat: between the thresholds the amplitude HOLDS its last value — a signal that retreats to the ` +
                `intermediate band without crossing the lower threshold leaves stimulation stuck at the ceiling [Cascino 2026].`
            }));
          }
          /* deriva de distribuição — vigilância pós-configuração */
          const dr = PR2.distributionDrift(res.wakeRows.map(r => ({ t: r.t, x: r.x })), offMin(), {});
          node.appendChild(el('div', {
            class: dr.ok && dr.drift ? 'warnbox' : 'note',
            html: `<b>Distribution drift check${dr.ok ? (dr.drift ? ' — DRIFT' : ' — stable') : ''}.</b> ` +
              (dr.ok
                ? `Last ${dr.recent.nDays} days vs reference (${dr.reference.nDays} days), wake log-power percentiles: ` +
                  `P25 ${dr.shiftPct.p25 > 0 ? '+' : ''}${dr.shiftPct.p25}% · P50 ${dr.shiftPct.p50 > 0 ? '+' : ''}${dr.shiftPct.p50}% · ` +
                  `P75 ${dr.shiftPct.p75 > 0 ? '+' : ''}${dr.shiftPct.p75}% (warn at ±${dr.params.warnPct}%). ` +
                  (dr.drift ? `Thresholds derived from the reference window may occupy a different zone today — re-check before ` +
                    `interpreting adaptation; chronic artifact above threshold reproduces cDBS at the ceiling [van Rheede 2022]. ` +
                    `Cascino: the stimulation-amplitude trace over time is a more reliable indicator than 10-min averages.` : ``)
                : `Not verifiable: ${dr.reason}.`)
          }));
          /* limite informacional do controlador só-beta */
          node.appendChild(el('div', {
            class: 'note', html: `<b>Single-biomarker ceiling.</b> Beta bursts alone explained 16% of hemibody impairment ` +
              `variance; a model with ALL spectral states (theta, alpha, low/high-beta) explained 50% [Khawaldeh 2022, ` +
              `doi:10.1093/brain/awab264]. A beta-only controller discards most of the information in the signal — a limit ` +
              `of the commercial mode itself, stated here so the proposal is read at its true size.`
          }));
        }

        /* (e) medication-cycle check */
        {
          const doseInfo = C.doseMarkers(d.snapshots, offMin(), { pattern: /medica|levodopa|dose/i });
          const mc = doseInfo.ok
            ? T.medicationCycleCheck(res.cleanRows, doseInfo.doses.map(x => x.t), p)
            : { ok: false, reason: doseInfo.reason };
          node.appendChild(el('div', {
            class: mc.ok && mc.verdict === 'warn' ? 'warnbox' : 'note',
            html: `<b>Medication-cycle check${mc.ok ? ' — ' + mc.verdict.toUpperCase() : ''}.</b> ` +
              (mc.ok
                ? `Mean log-beta trajectory ±90 min around ${mc.nEvents} intake event(s): Δ(post−pre) = ${f(mc.deltaLog, 3)} log units` +
                (isFinite(mc.separationLog) ? ` against a component separation of ${f(mc.separationLog, 3)}` : '') + `. ${mc.note}.`
                : `Not verifiable: ${mc.reason}.`)
          }));
        }

        /* resumo numérico + linha do CSV */
        node.appendChild(table(['field', 'value'], [
          ['method', p.method],
          ['lower / upper threshold (native LFP)', `${p.lower} / ${p.upper}`],
          ['Ashman d · BIC k=1 · BIC k=2', `${p.ashman} · ${f(p.gmm1.bic, 1)} · ${f(p.gmm2 ? p.gmm2.bic : NaN, 1)}`],
          ['wake window', `${res.wake.wake[0]}–${res.wake.wake[1]} h (${res.wake.method}${isFinite(res.wake.r2) ? `, cosinor R²=${f(res.wake.r2, 2)}` : ''})`],
          ['days used / excluded', `${res.days.used.length} / ${res.days.excluded.length}`],
          ['artifacts rejected (Hampel)', `${res.nArtifacts} (window ${res.hampel.window}, k=${res.hampel.k})`]
        ]));
        if (res.days.excluded.length) node.appendChild(table(['excluded day', 'reason'],
          res.days.excluded.map(x => [x.day, x.reason])));
        csvRows.push(T.tidalCsvRow(h, res));
      });

      /* metodologia e limitação declaradas na própria figura */
      node.appendChild(el('div', {
        class: 'note', html: `<b>Method.</b> Reference method is manual 25/75 diurnal percentiles of Timeline beta ` +
          `[doi:10.1038/s41531-025-01124-7]; in-clinic streaming is not representative of chronic beta. Time of day explains ` +
          `~41% of beta variance, so sleep is excluded [doi:10.1038/s41531-022-00350-7; doi:10.1038/s41467-023-41128-6]. ` +
          `Non-representative days are excluded and listed [doi:10.1038/s41531-026-01269-z]. ` +
          `<b>Declared limitation:</b> the real controller triggers on >1.2 s epochs with ~2.5/5 min ramps ` +
          `[doi:10.1038/s41531-024-00772-5]; the Timeline is 10-min averages, so this simulation estimates zone occupancy ` +
          `and saturation, not the fine current trajectory. <b>${C.TIDAL.DISCLAIMER}</b>`
      }));

      if (csvRows.length) node.appendChild(exportRow([
        {
          label: '⤓ CSV (R-compatible)', fn: () => P.downloadText(
            P.toCSV(csvRows), 'TIDAL_DT_thresholds.csv', 'text/csv')
        },
        {
          label: '⤓ Export report (print/PDF)', fn: () => {
            const fig = document.getElementById('fig-F36');
            if (fig && fig.scrollIntoView) fig.scrollIntoView();
            if (typeof window.print === 'function') window.print();
          }
        }
      ]));
    }
  },

  /* ----------------------------------------------------------------- F33 */
  {
    id: 'F33', title: 'Agenda da próxima sessão',
    sub: 'o que o crônico observou e não explica, transformado em protocolo agudo · com o que cada protocolo decidiria',
    has: d => Object.keys(d.trend).length,
    render(node, d) {
      const hemis = Object.keys(d.trend);
      const hemi = opt('F33', 'hemi', '');
      const agreg = opt('F33', 'agreg', 'median');
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('hemisfério', [{ value: '', label: 'automático (o com mais dias)' }]
          .concat(hemis.map(x => ({ value: x, label: `${rotuloLado(x)}` }))), hemi, v => setOpt('F33', 'hemi', v)),
        ctrlSelect('resumo do dia', [
          { value: 'median', label: 'mediana' }, { value: 'mean', label: 'média' }
        ], agreg, v => setOpt('F33', 'agreg', v))
      ]));

      const p0 = activeFiles()[0] && activeFiles()[0].parsed;
      const doseInfo = C.doseMarkers(d.snapshots, offMin(), { pattern: /medica|levodopa|dose/i });
      const blocos = C.configBlocks(d.all, offMin(), {});
      const passe = p0 ? C.biomarkerPassport(p0, {}) : null;
      const cfgAtual = p0 ? C.sensingConfigOf(p0) : null;
      const casa = (passe && passe.ok && cfgAtual && cfgAtual.ok) ? C.passportMatchesConfig(passe, cfgAtual) : null;
      const marcos = (blocos.changes || []).filter(c => isFinite(c.t)).map(c => ({ t: c.t, label: `${c.field} (${c.severity})` }))
        .concat((d.eventLogs || []).filter(e => isFinite(e.t)).map(e => ({ t: e.t, label: [e.kind, e.detail].filter(Boolean).join(' · ') || 'evento' })));

      const ag = C.sessionAgenda({
        rows: d.trend, offMin: offMin(),
        doseTimes: doseInfo.ok ? doseInfo.doses.map(x => x.t) : [],
        markers: marcos, blocks: blocos, passport: passe, passportMatch: casa,
        alarm: alarmeDoRegistro()
      }, { hemisphere: hemi || undefined, aggregation: agreg });

      if (!ag.ok) return node.appendChild(el('div', { class: 'empty', text: ag.reason }));

      node.appendChild(el('div', { class: 'note', html: `<b>${ag.summary}</b> ${ag.incompletenessNote}` }));

      const corPrio = { alta: 'var(--warn)', 'média': 'var(--accent)', baixa: 'var(--muted)' };
      (ag.items || []).forEach((it, i) => {
        const card = el('div', { class: 'agenda-item' });
        card.appendChild(el('div', {
          class: 'tit',
          html: `<span class="prio" style="border-color:${corPrio[it.priority] || 'var(--muted)'};color:${corPrio[it.priority] || 'var(--muted)'}">` +
            `${it.priority}</span> ${i + 1}. ${it.finding}`
        }));
        card.appendChild(el('div', { class: 'campo', html: `<b>Protocolo sugerido.</b> ${it.suggestedProtocol}` }));
        card.appendChild(el('div', { class: 'campo', html: `<b>O que ficaria decidido.</b> ${it.whatItWouldSettle}` }));
        if (it.caveat) card.appendChild(el('div', { class: 'campo lim', html: `<b>Limite.</b> ${it.caveat}` }));
        const ev = Object.keys(it.evidence || {})
          .filter(k => it.evidence[k] != null && it.evidence[k] !== '')
          .map(k => [k, { html: `<code>${typeof it.evidence[k] === 'object' ? JSON.stringify(it.evidence[k]) : String(it.evidence[k])}</code>` }]);
        if (ev.length) {
          const det = el('details', { class: 'evid' });
          det.appendChild(el('summary', { text: `evidência numérica (confiança ${it.confidence})` }));
          det.appendChild(table(['medida', 'valor'], ev));
          card.appendChild(det);
        }
        node.appendChild(card);
      });

      if (!(ag.items || []).length) node.appendChild(el('div', {
        class: 'note', html: '<b>Nenhum achado nas verificações que este arquivo permitiu.</b> Isso não é um atestado de ' +
          'normalidade: é a lista abaixo de tudo o que <i>não</i> pôde ser verificado que diz o quanto essa frase vale.'
      }));

      if ((ag.notChecked || []).length) {
        node.appendChild(el('h4', { class: 'qc-title', html: '<b>O que não foi possível verificar neste arquivo</b>' }));
        node.appendChild(table(['verificação', 'por que não', 'o que seria necessário'],
          ag.notChecked.map(n => [n.id, n.whyNot, n.whatWouldBeNeeded])));
      }

      node.appendChild(el('div', { class: 'note', html: `<b>Artefato.</b> ${ag.artifactNote}` }));
      node.appendChild(el('div', { class: 'warnbox', html: `<b>Natureza desta lista.</b> ${ag.disclaimer}` }));
      node.appendChild(el('div', {
        class: 'seal', text: `hemisfério ${hname(ag.params.hemisphere)} (${ag.params.hemisphereNote}) · ` +
          `${ag.params.nDays} dia(s) · ${ag.params.nDoseMarks} marca(s) de dose · ${ag.params.nMarkers} marco(s) · ` +
          `${ag.nChecksRun}/${ag.nChecksTotal} verificações · agenda v${ag.version}`
      }));
      node.appendChild(exportRow([
        { label: '⤓ Agenda (JSON)', fn: () => P.downloadText(JSON.stringify(ag, null, 2), 'F33_agenda.json', 'application/json') },
        {
          label: '⤓ CSV', fn: () => P.downloadText(P.toCSV((ag.items || []).map(it => ({
            id: it.id, priority: it.priority, confidence: it.confidence, finding: it.finding,
            suggested_protocol: it.suggestedProtocol, what_it_would_settle: it.whatItWouldSettle,
            evidence: JSON.stringify(it.evidence)
          }))), 'F33_agenda.csv', 'text/csv')
        }
      ]));
      node.appendChild(el('div', {
        class: 'note', html: '<b>A direção que falta na maioria dos softwares.</b> É pacífico que a sessão de consultório ' +
          'calibra o registro domiciliar — é ela que define par, pico e banda (F31). O caminho de volta quase nunca é ' +
          'feito: os trinta dias de vida livre observam o que nenhuma consulta observa, e o que eles encontram de anômalo ' +
          'só se resolve com um experimento. Esta lista é esse caminho de volta, e nada nela é conduta.'
      }));
    }
  },


  /* ----------------------------------------------------------------- F34 */
  {
    id: 'F34', title: 'ODR e features por janela — dinâmica multi-banda do registro agudo',
    sub: 'Oscillatory Dynamics Ratio nas duas formulações · bandas z-scored · coerência inter-STN · variação espectral',
    has: d => d.bsTimeDomain.length || d.montageTD.length,
    render(node, d) {
      avisoDeAlvo(node, 'O ODR e as features por janela replicam um protocolo derivado em registros do núcleo subtalâmico (Habets et al., Brain 2026)');
      const janela = opt('F34', 'win', 10);
      const sobrep = opt('F34', 'ov', 0);
      const form = opt('F34', 'form', 'log');
      const fonteG = opt('F34', 'gamma', 'peak');
      const tolEnt = opt('F34', 'tol', 2.5);
      const semGama = opt('F34', 'nogamma', false);

      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('janela', [
          { value: 5, label: '5 s' }, { value: 10, label: '10 s (artigo)' }, { value: 30, label: '30 s' }
        ], janela, v => setOpt('F34', 'win', +v)),
        ctrlSelect('sobreposição', [
          { value: 0, label: 'sem sobreposição' }, { value: 0.5, label: '50%' }, { value: 0.75, label: '75%' }
        ], sobrep, v => setOpt('F34', 'ov', +v)),
        ctrlSelect('formulação do ODR', [
          { value: 'log', label: 'logarítmica (estável)' },
          { value: 'literal', label: 'literal do artigo (instável)' }
        ], form, v => setOpt('F34', 'form', v)),
        ctrlSelect('origem da gama', [
          { value: 'peak', label: 'pico individual ± 2,5 Hz' },
          { value: 'broad', label: 'banda larga 60–90 Hz' }
        ], fonteG, v => setOpt('F34', 'gamma', v)),
        ctrlNumber('tolerância f_stim/2 (Hz)', tolEnt, 0.5, 10, 0.5, v => setOpt('F34', 'tol', v)),
        ctrlCheck('permitir variante sem gama', semGama, v => setOpt('F34', 'nogamma', v))
      ]));

      /* --- montagem dos hemisférios a partir do registro bruto ------------ */
      const brutos = (d.bsTimeDomain.length ? d.bsTimeDomain : d.montageTD);
      const hemis = {};
      brutos.forEach(td => {
        if (!hemis[td.hemisphere] && td.data && td.data.length) hemis[td.hemisphere] = {
          x: td.data, fs: td.fsEff || td.fs, t0: td.t0, record: td, label: td.label
        };
      });
      if (!Object.keys(hemis).length) return node.appendChild(el('div', {
        class: 'empty', text: 'nenhum canal com sinal bruto no domínio do tempo neste arquivo'
      }));

      const p0 = activeFiles()[0] && activeFiles()[0].parsed;
      const odr = C.odrSeries({ hemispheres: hemis, parsed: p0 }, {
        windowS: janela, overlap: sobrep, formulation: form, gammaSource: fonteG,
        entrainToleranceHz: tolEnt, allowWithoutGamma: semGama
      });

      /* ---------------- (a) série do ODR --------------------------------- */
      node.appendChild(el('h4', { class: 'qc-title', html: '<b>(a) ODR ao longo do registro — as duas formulações</b>' }));
      let boxA = null;
      if (!odr.ok) {
        /* recusa mostra o MOTIVO no lugar da curva, nunca uma curva vazia */
        node.appendChild(el('div', { class: 'warnbox', html: `<b>O ODR não foi calculado.</b> ${odr.reason}` }));
      } else {
        const xs = odr.windows.map(w => w.tCenterS);
        const yl = odr.windows.map(w => w.odrLog);
        const yt = odr.windows.map(w => w.odrLiteral);
        const todos = yl.concat(yt).filter(isFinite);
        const lo = Math.min.apply(null, todos), hi = Math.max.apply(null, todos);
        boxA = plotBox(node, 240);
        const ch = new P.Chart(boxA.canvas, {
          width: boxA.width, height: boxA.height,
          xlim: [Math.min.apply(null, xs), Math.max.apply(null, xs)],
          ylim: [lo - 0.1 * (hi - lo) - 0.1, hi + 0.1 * (hi - lo) + 0.1],
          xlabel: 'tempo do registro (s)', ylabel: 'ODR (z)',
          title: `ODR por janela de ${odr.params.windowS} s · ${odr.nHemispheres} hemisfério(s)`,
          pad: { l: 62, r: 20, t: 24, b: 42 }
        });
        ch.axes({ nx: 8 });
        ch.hline(0, { color: COL.rule, width: 1, dash: [3, 3] });
        ch.line(xs, yt, { color: COL.muted, width: 0.9, label: 'literal (z(θ)·z(γ)/z(β))' });
        ch.line(xs, yl, { color: COL.accent, width: 2, label: 'logarítmica (padrão)' });

        /* marcas de tomada, quando existirem, no eixo de tempo do registro */
        const t0ms = hemis[odr.hemispheres[0]].t0 ? Date.parse(hemis[odr.hemispheres[0]].t0) : NaN;
        const doses = C.doseMarkers(d.snapshots, offMin(), { pattern: /medica|levodopa|dose/i });
        if (isFinite(t0ms) && doses.ok) {
          const dentro = doses.doses.map(x => (x.t - t0ms) / 1000).filter(s => s >= xs[0] && s <= xs[xs.length - 1]);
          dentro.forEach(s => ch.marker(s, hi, { shape: 'tridown', size: 7, color: COL.warn, halo: true }));
          if (dentro.length) ch.text(ch.x0 + 8, ch.Y(hi) - 14, `▼ ${dentro.length} tomada(s) marcada(s)`, { color: COL.warn });
        }
        ch.legend({ x: ch.x0 + 8, y: ch.y1 + 6 });

        node.appendChild(el('div', {
          class: 'note', html: `<b>Por que duas curvas.</b> ${odr.formulationNote}`
        }));
        if (odr.unilateralWarning) node.appendChild(el('div', { class: 'warnbox', html: `<b>Um lado só.</b> ${odr.unilateralWarning}` }));
        (odr.hemispheres || []).forEach(h => {
          const bh = odr.byHemisphere[h];
          if (bh && bh.withoutGamma) node.appendChild(el('div', {
            class: 'warnbox', html: `<b>${rotuloLado(h)} — variante sem gama.</b> ${bh.withoutGammaNote}`
          }));
          if (bh && bh.entrainmentChecked === false) node.appendChild(el('div', {
            class: 'warnbox', html: `<b>${rotuloLado(h)} — não verificado.</b> ${bh.entrainmentNote}`
          }));
        });
      }

      /* ---------------- (b) as três bandas z-scored ----------------------- */
      node.appendChild(el('h4', { class: 'qc-title', html: '<b>(b) Qual termo está movendo o ODR</b>' }));
      let boxB = null;
      const primeiro = odr.ok ? odr.byHemisphere[odr.hemispheres[0]] : null;
      if (!primeiro) {
        node.appendChild(el('div', { class: 'note', text: 'sem série de bandas para mostrar — o ODR não foi calculado' }));
      } else {
        const xs = primeiro.windows.map(w => w.tCenterS);
        const series = [
          { id: 'zThetaLog', label: 'θ 4–8 Hz', color: '#2F6E8E' },
          { id: 'zGammaLog', label: primeiro.gammaSource === 'broad' ? 'γ larga 60–90 Hz' : `γ pico ${f(primeiro.gamma.peakHz, 1)} Hz`, color: '#8E3B4E' },
          { id: 'zLowBetaLog', label: 'β↓ 12–20 Hz', color: '#B8912A' }
        ];
        const tudo = series.flatMap(s => primeiro.windows.map(w => w[s.id])).filter(isFinite);
        boxB = plotBox(node, 220);
        const ch = new P.Chart(boxB.canvas, {
          width: boxB.width, height: boxB.height,
          xlim: [xs[0], xs[xs.length - 1]],
          ylim: [Math.min.apply(null, tudo) - 0.3, Math.max.apply(null, tudo) + 0.3],
          xlabel: 'tempo do registro (s)', ylabel: 'z (log potência)',
          title: `${rotuloLado(primeiro.hemisphere)} — bandas z-scored ao longo do registro`,
          pad: { l: 62, r: 20, t: 24, b: 42 }
        });
        ch.axes({ nx: 8 });
        ch.hline(0, { color: COL.rule, width: 1, dash: [3, 3] });
        series.forEach(s => ch.line(xs, primeiro.windows.map(w => w[s.id]), { color: s.color, width: 1.6, label: s.label }));
        ch.legend({ x: ch.x0 + 8, y: ch.y1 + 6 });
        node.appendChild(el('div', {
          class: 'note', html: '<b>Sem este painel o ODR é caixa-preta.</b> Ele sobe tanto porque teta e gama subiram ' +
            'quanto porque beta caiu, e as três leituras clínicas são diferentes. A curva de baixo é o que o denominador ' +
            'está fazendo.'
        }));
      }

      /* ---------------- (c) coerência inter-STN --------------------------- */
      node.appendChild(el('h4', { class: 'qc-title', html: '<b>(c) Coerência inter-STN</b>' }));
      const gBand = primeiro && primeiro.gammaBand ? primeiro.gammaBand : null;
      const coer = (hemis.Left && hemis.Right)
        ? C.interSTNCoherence(hemis.Left, hemis.Right, {
          windowS: janela, overlap: sobrep, gammaBand: gBand,
          stimRateHz: primeiro ? primeiro.stimRateHz : undefined
        })
        : { ok: false, reason: 'este arquivo tem sinal bruto de um hemisfério só — a coerência inter-STN exige os dois lados no mesmo registro' };

      let boxC = null;
      if (!coer.ok) {
        node.appendChild(el('div', { class: 'note', html: `<b>Não calculada.</b> ${coer.reason}` }));
      } else {
        boxC = plotBox(node, 240);
        const ms = coer.meanSpectrum;
        const fmax = 90;
        const idx = ms.f.map((v, i) => i).filter(i => ms.f[i] <= fmax);
        const ch = new P.Chart(boxC.canvas, {
          width: boxC.width, height: boxC.height, xlim: [0, fmax], ylim: [0, 1],
          xlabel: 'frequência (Hz)', ylabel: 'coerência',
          title: `espectro médio de coerência entre os dois STN (${ms.nWindows} janelas)`,
          pad: { l: 62, r: 20, t: 24, b: 42 }
        });
        ch.axes({ nx: 8 });
        /* bandas do ODR marcadas ao fundo */
        [['theta', '#2F6E8E'], ['lowBeta', '#B8912A']].forEach(([id, cor]) => {
          const b = coer.bands.find(x => x.id === id);
          if (b) ch.span(b.lo, b.hi, { color: cor, alpha: 0.08 });
        });
        ch.line(idx.map(i => ms.f[i]), idx.map(i => ms.cxy[i]), { color: COL.accent, width: 1.8, label: 'coerência de magnitude' });
        ch.line(idx.map(i => ms.f[i]), idx.map(i => Math.abs(ms.imag[i])), { color: COL.warn, width: 1.3, dash: [4, 3], label: '|parte imaginária|' });
        const w0 = coer.windows.find(w => isFinite(w.expectedNullCoherence));
        if (w0) {
          ch.hline(w0.expectedNullCoherence, { color: COL.muted, width: 1, dash: [2, 3] });
          ch.text(ch.x1 - 150, ch.Y(w0.expectedNullCoherence) - 5, `1/L = ${f(w0.expectedNullCoherence, 3)} (nula)`, { color: COL.muted });
          const lb = coer.bands.find(x => x.id === 'lowBeta');
          const thr = w0.byBand && w0.byBand.lowBeta ? w0.byBand.lowBeta.threshold : NaN;
          if (isFinite(thr)) {
            ch.hline(thr, { color: COL.Right, width: 1, dash: [5, 3] });
            ch.text(ch.x1 - 150, ch.Y(thr) - 5, `limiar da banda ${f(thr, 3)}`, { color: COL.Right });
          }
          void lb;
        }
        ch.legend({ x: ch.x0 + 8, y: ch.y1 + 6 });

        node.appendChild(table(
          ['banda', 'coer. média (pico)', 'coer. média (banda)', 'imag. média', 'janelas > limiar', 'fase ~0', 'veredito'],
          Object.keys(coer.byBand).map(id => {
            const b = coer.byBand[id];
            return [
              id + (b.sharedCardiacContamination ? ' ⚠' : ''),
              b.meanCoherence, b.meanBandCoherence, b.meanImag,
              `${b.nAboveThreshold}/${b.nWindows}`,
              b.nVolumeConductionSuspected,
              { html: b.interpretable ? b.verdict : `<b style="color:var(--warn)">${b.verdict}</b>` }
            ];
          })));

        const ecg = coer.confounders.sharedCardiac;
        node.appendChild(el('div', {
          class: ecg.detected ? 'warnbox' : 'note',
          html: `<b>Confundidores de fase zero.</b> ${coer.confounders.sharedStimulation.note}. ${ecg.note}`
        }));
        node.appendChild(el('div', { class: 'note', html: `<b>Limiar.</b> ${coer.nullNote}. ${coer.imagNote}.` }));
        node.appendChild(el('div', { class: 'note', html: `<b>O que o artigo mostrou.</b> ${coer.articleNote}` }));
      }

      /* ---------------- (d) variação espectral ---------------------------- */
      node.appendChild(el('h4', { class: 'qc-title', html: '<b>(d) Variação espectral (CV do envelope) por banda</b>' }));
      const cvs = {};
      Object.keys(hemis).forEach(h => {
        cvs[h] = C.odrSpectralVariation(hemis[h], {
          windowS: janela, overlap: sobrep,
          gammaBand: odr.ok && odr.byHemisphere[h] ? odr.byHemisphere[h].gammaBand : null
        });
      });
      const cvRef = cvs[primeiro ? primeiro.hemisphere : Object.keys(hemis)[0]];
      let boxD = null;
      if (!cvRef || !cvRef.ok) {
        node.appendChild(el('div', { class: 'note', text: (cvRef && cvRef.reason) || 'variação espectral não calculável neste registro' }));
      } else {
        const ids = Object.keys(cvRef.byBand).filter(id => cvRef.byBand[id].ok);
        const xs = cvRef.byBand[ids[0]].windows.map(w => w.tCenterS);
        const tudo = ids.flatMap(id => cvRef.byBand[id].windows.map(w => w.cv)).filter(isFinite);
        boxD = plotBox(node, 210);
        const cores = { theta: '#2F6E8E', lowBeta: '#B8912A', gammaPeak: '#8E3B4E' };
        const ch = new P.Chart(boxD.canvas, {
          width: boxD.width, height: boxD.height,
          xlim: [xs[0], xs[xs.length - 1]],
          ylim: [0, Math.max.apply(null, tudo) * 1.15],
          xlabel: 'tempo do registro (s)', ylabel: 'CV do envelope',
          title: `variação espectral por janela de ${cvRef.windowS} s`,
          pad: { l: 62, r: 20, t: 24, b: 42 }
        });
        ch.axes({ nx: 8 });
        ids.forEach(id => ch.line(xs, cvRef.byBand[id].windows.map(w => w.cv), {
          color: cores[id] || COL.accent, width: 1.6, label: id
        }));
        ch.legend({ x: ch.x0 + 8, y: ch.y1 + 6 });
        node.appendChild(el('div', {
          class: 'note', html: `<b>Método.</b> ${cvRef.byBand[ids[0]].edgePolicy}. ${cvRef.note} — por isso a janela ` +
            `usada (${cvRef.windowS} s) sai em toda exportação.`
        }));
      }

      /* ---------------- limitações, fronteira e exportação ---------------- */
      node.appendChild(table(['item', 'no artigo', 'no Percept', 'consequência'],
        C.ODR_LIMITACOES.map(l => [l.item, l.artigo, l.percept, l.consequencia])));

      node.appendChild(el('div', {
        class: 'warnbox', html: '<b>Limitações desta implementação.</b> Estas features reproduzem as de Habets et al. ' +
          '(Brain 2026) com as limitações do registro de Percept: <b>sem SSD</b> — um par bipolar por hemisfério, em ' +
          'vez de decomposição espectro-espacial para otimizar razão sinal-ruído — e, tipicamente, <b>com estimulação ' +
          'ligada</b>, ao contrário do protocolo original, que foi conduzido com estimulação desligada e eletrodos ' +
          'externalizados. Os valores absolutos não são comparáveis com os do artigo. No estudo original, o ODR como ' +
          'preditor univariado atingiu acurácia balanceada de <b>0,61 (DP 0,14)</b>, com detecção significativa em ' +
          '<b>8 de 21 sujeitos</b>.'
      }));
      node.appendChild(el('div', {
        class: 'warnbox', html: '<b>A fronteira desta figura.</b> Sem rótulo clínico, ela descreve a dinâmica das ' +
          'features ao longo do tempo. Ela <b>não afirma detecção de discinesia</b>: para isso seria necessário um ' +
          'rótulo importado — diário, vídeo ou escala aplicada no momento — que não faz parte do que o arquivo do ' +
          'Percept contém.'
      }));

      const entrada = {
        odr, cv: cvs, coh: coer.ok ? coer : null,
        channels: Object.keys(hemis).reduce((a, h) => { a[h] = hemis[h].label; return a; }, {}),
        fs: Object.keys(hemis).reduce((a, h) => { a[h] = hemis[h].fs; return a; }, {})
      };
      const tab = odr.ok ? C.windowedFeatureTable(entrada) : { ok: false, rows: [] };
      if (tab.ok) node.appendChild(el('div', {
        class: 'seal', text: `${tab.rows.length} linha(s) · janela ${odr.params.windowS} s · sobreposição ` +
          `${odr.params.overlap} · formulação ${odr.formulationUsed} · gama ${odr.params.gammaSource} · ` +
          `ρ(log × literal) = ${odr.spearmanLogVsLiteral}`
      }));

      const botoes = [];
      if (boxA) botoes.push({ label: '⤓ PNG — ODR', fn: () => P.downloadCanvas(boxA.canvas, 'F34a_odr') });
      if (boxB) botoes.push({ label: '⤓ PNG — bandas', fn: () => P.downloadCanvas(boxB.canvas, 'F34b_bandas_z') });
      if (boxC) botoes.push({ label: '⤓ PNG — coerência', fn: () => P.downloadCanvas(boxC.canvas, 'F34c_coerencia') });
      if (boxD) botoes.push({ label: '⤓ PNG — CV', fn: () => P.downloadCanvas(boxD.canvas, 'F34d_cv') });
      if (tab.ok) botoes.push({
        label: '⤓ CSV — features por janela',
        fn: () => P.downloadText(C.windowedFeatureCsv(entrada, ''), 'F34_features_por_janela.csv', 'text/csv')
      });
      if (odr.ok) botoes.push({
        label: '⤓ JSON', fn: () => P.downloadText(JSON.stringify({
          odr: Object.assign({}, odr, {
            byHemisphere: Object.keys(odr.byHemisphere).reduce((a, h) => {
              a[h] = Object.assign({}, odr.byHemisphere[h], { windows: undefined });
              return a;
            }, {})
          }),
          coherenceSummary: coer.ok ? { byBand: coer.byBand, confounders: coer.confounders, pairing: coer.pairing } : coer,
          limitations: C.ODR_LIMITACOES, expectation: C.ODR_EXPECTATIVA
        }, null, 2), 'F34_odr.json', 'application/json')
      });
      if (botoes.length) node.appendChild(exportRow(botoes));
    }
  },

  /* ------------------------------------------------------------------ F35 */
  /* MRDS — (des)sincronização relacionada ao movimento.

     POR QUE EXISTE. O protocolo de Alves et al. (Mov Disord 2025) contrasta
     potência sob movimento e em repouso, antes e depois de uma intervenção. É
     um desenho que o Percept sustenta sozinho: duas épocas de tempo-domínio
     por momento, sem sinal externo. O que o Percept NÃO tem é rótulo de
     tarefa — qual época é repouso e qual é movimento é declarado por quem
     analisa, e essa declaração entra na proveniência.

     A figura separa deliberadamente os dois níveis. O MRDS sozinho é o
     contraste movimento-repouso, e artefato de movimento entra inteiro nele;
     só o ΔMRDS = pós - basal cancela modulação motora reprodutível.         */
  {
    id: 'F35', title: 'MRDS — (des)sincronização relacionada ao movimento',
    sub: 'repouso vs movimento por hemisfério · ΔMRDS entre momentos · decomposição banda-larga vs específica',
    has: d => (d.bsTimeDomain.length + d.indefiniteStreaming.length + d.montageTD.length) > 0,
    render(node, d) {
      avisoDeAlvo(node, 'O MRDS com bandas β 13–35 e γ 35–100 Hz replica um protocolo derivado em registros do núcleo subtalâmico (Alves et al., Mov Disord 2025)');
      const regs = d.indefiniteStreaming.concat(d.bsTimeDomain, d.montageTD)
        .map((t, i) => Object.assign({}, t, { idx: i, dur: t.data.length / t.fs }));
      if (!regs.length) return node.appendChild(el('div', { class: 'empty', text: 'Sem registro de tempo-domínio.' }));

      const modo = opt('F35', 'modo', regs.length >= 2 ? 'registros' : 'janelas');
      const escopo = opt('F35', 'z', 'session');
      const exato = opt('F35', 'nfft', true);
      const janelaS = opt('F35', 'win', 4);
      const piso = opt('F35', 'piso', 5);

      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('desenho', [
          { value: 'registros', label: 'gravações separadas (uma por condição)' },
          { value: 'janelas', label: 'janelas dentro de uma gravação' }
        ], modo, v => setOpt('F35', 'modo', v)),
        ctrlSelect('z-score', [
          { value: 'session', label: 'por sessão (uma escala para todas as épocas)' },
          { value: 'record', label: 'por gravação (variância 1 em cada época)' },
          { value: 'none', label: 'sem normalização (µV²/Hz)' }
        ], escopo, v => setOpt('F35', 'z', v)),
        ctrlNumber('janela de Welch (s)', janelaS, 1, 20, 1, v => setOpt('F35', 'win', v)),
        ctrlCheck('NFFT exato do protocolo (0,25 Hz)', exato, v => setOpt('F35', 'nfft', v)),
        ctrlNumber('piso de efeito (%)', piso, 1, 50, 1, v => setOpt('F35', 'piso', v))
      ]));

      /* ---- atribuição das épocas às células do desenho ------------------ */
      const unidades = [];
      const atrib = opt('F35', 'atrib', {});
      if (modo === 'registros') {
        const linhas = regs.map(r => {
          const val = atrib[r.idx] || '';
          return [
            `${r.label || r.channel} · ${hname(r.hemisphere)}`,
            `${f(r.dur, 0)} s`,
            r.t0 ? String(r.t0).slice(11, 19) : '—',
            {
              html: '', node: ctrlSelect('', [{ value: '', label: '— não usar —' }]
                .concat(C.MRDS_CELLS.map(c => ({ value: c.key, label: c.label }))),
                val, v => { const a = Object.assign({}, atrib); a[r.idx] = v; setOpt('F35', 'atrib', a); })
            }
          ];
        });
        node.appendChild(tabelaComControles(
          ['gravação', 'duração', 'hora', 'condição no desenho'], linhas));

        /* agrupa por hemisfério: cada hemisfério é uma unidade pareada */
        const porHemi = {};
        regs.forEach(r => {
          const cel = atrib[r.idx];
          if (!cel) return;
          const h = r.hemisphere || '?';
          porHemi[h] = porHemi[h] || { id: h, subject: sujeitoAtual() || 'sujeito', hemisphere: h, cells: {}, fs: r.fs, quality: {} };
          porHemi[h].cells[cel] = r.data;
          porHemi[h].quality[cel] = { lossPct: r.packets ? r.packets.pctMissing : NaN, dur: r.dur };
        });
        Object.keys(porHemi).forEach(h => unidades.push(porHemi[h]));
      } else {
        const iSel = opt('F35', 'reg', 0);
        const r = regs[Math.min(iSel, regs.length - 1)];
        node.appendChild(el('div', { class: 'ctrls' }, [
          ctrlSelect('gravação', regs.map(x => ({ value: x.idx, label: `${x.label || x.channel} · ${hname(x.hemisphere)} · ${f(x.dur, 0)} s` })),
            r.idx, v => setOpt('F35', 'reg', +v))
        ]));
        const meio = Math.round(r.dur / 2);
        const jan = opt('F35', 'janelas', {
          rest_baseline: [0, meio], move_baseline: [meio, Math.round(r.dur)],
          rest_post: [0, 0], move_post: [0, 0]
        });
        node.appendChild(tabelaComControles(['condição', 'de (s)', 'até (s)'],
          C.MRDS_CELLS.map(c => {
            const v = jan[c.key] || [0, 0];
            const mk = (i) => ctrlNumber('', v[i], 0, Math.ceil(r.dur), 1, nv => {
              const j = Object.assign({}, jan); j[c.key] = i === 0 ? [nv, v[1]] : [v[0], nv];
              setOpt('F35', 'janelas', j);
            });
            return [c.label, { node: mk(0) }, { node: mk(1) }];
          })));
        const u = { id: r.hemisphere || 'unidade', subject: sujeitoAtual() || 'sujeito', hemisphere: r.hemisphere || '?', cells: {}, fs: r.fs, quality: {} };
        C.MRDS_CELLS.forEach(c => {
          const v = jan[c.key] || [0, 0];
          const a = Math.max(0, Math.round(v[0] * r.fs)), b = Math.min(r.data.length, Math.round(v[1] * r.fs));
          if (b - a >= r.fs * janelaS) { u.cells[c.key] = r.data.slice(a, b); u.quality[c.key] = { dur: (b - a) / r.fs }; }
        });
        if (Object.keys(u.cells).length) unidades.push(u);
      }

      const temPar = unidades.some(u => u.cells.rest_baseline && u.cells.move_baseline);
      if (!temPar) {
        node.appendChild(el('div', {
          class: 'note', html: `<b>Falta a atribuição.</b> O JSON do Percept <b>não carrega rótulo de tarefa</b>: ` +
            `qual época é repouso e qual é movimento tem de ser declarado acima. O par mínimo é ` +
            `<i>repouso · basal</i> e <i>movimento · basal</i>, no mesmo hemisfério. O eixo pós é opcional — ` +
            `sem ele só o primeiro nível é calculável.`
        }));
        return;
      }

      const res = C.mrdsDesign(unidades, {
        zscoreScope: escopo,
        windowSamples: Math.round(janelaS * (unidades[0].fs || 250)),
        exactNfft: exato, relativeFloor: piso / 100
      });

      /* ---- (a) PSD por condição, no formato do painel A/B do artigo ----- */
      const u0 = res.units.find(u => u.baseline && u.baseline.ok) || res.units[0];
      const box = plotBox(node, 260);
      {
        const psd = u0.psd;
        const todos = ['rest_baseline', 'move_baseline', 'rest_post', 'move_post'].filter(k => psd[k] && psd[k].p);
        let ymax = 0;
        todos.forEach(k => { const r = psd[k]; for (let i = 0; i < r.f.length; i++) if (r.f[i] >= 2 && r.f[i] <= 100 && r.p[i] > ymax) ymax = r.p[i]; });
        const ch = new P.Chart(box.canvas, {
          width: box.width, height: box.height, xlim: [2, 100], ylim: [0, ymax * 1.1],
          xlabel: 'frequência (Hz)', ylabel: `densidade de potência (${res.unit === 'µV²/Hz' ? 'µV²/Hz' : 'ad.'})`,
          title: `PSD por condição — ${rotuloLado(u0.hemisphere)}`, pad: { l: 66, r: 14, t: 24, b: 42 }
        });
        ch.axes({ nx: 6 });
        C.MRDS_BANDS.forEach(b => ch.span(b.lo, b.hi, { color: b.key === 'beta' ? CORBETA : '#8E3B4E', alpha: .07, label: b.label }));
        const cor = { rest_baseline: '#1B4A72', move_baseline: '#9C3050', rest_post: '#4E86B8', move_post: '#C9748C' };
        const rot = { rest_baseline: 'repouso · basal', move_baseline: 'movimento · basal', rest_post: 'repouso · pós', move_post: 'movimento · pós' };
        todos.forEach(k => ch.line(Array.from(psd[k].f), Array.from(psd[k].p), {
          color: cor[k], width: 1.5, dash: /post/.test(k) ? [4, 3] : null, label: rot[k]
        }));
        ch.legend({ x: ch.x1 - 150, y: ch.y1 + 6 });
      }

      /* ---- (b) MRDS por banda e por unidade ---------------------------- */
      const boxB = plotBox(node, 230);
      {
        const uns = res.units.filter(u => u.baseline && u.baseline.ok);
        const nB = res.bands.length;
        const vals = [];
        uns.forEach(u => res.bands.forEach(b => {
          const x = u.baseline.bands.find(z => z.key === b.key);
          if (x && isFinite(x.mrds)) vals.push(x.mrds);
          const pos = u.post && u.post.ok ? u.post.bands.find(z => z.key === b.key) : null;
          if (pos && isFinite(pos.mrds)) vals.push(pos.mrds);
        }));
        const lim = Math.max(0.2, Math.max.apply(null, vals.map(Math.abs).concat([0.2])) * 1.15);
        const ch = new P.Chart(boxB.canvas, {
          width: boxB.width, height: boxB.height, xlim: [-.5, nB - .5], ylim: [-lim, lim],
          xlabel: 'banda', ylabel: 'MRDS (adimensional)',
          title: 'MRDS por banda — negativo = dessincronização com o movimento', pad: { l: 66, r: 14, t: 24, b: 42 }
        });
        ch.axes({ nx: nB, xticks: res.bands.map((_, i) => i), xfmt: v => (res.bands[Math.round(v)] || {}).label || '' });
        ch.hline(0, { color: '#5C7284', width: 1 });
        uns.forEach((u, iu) => {
          const dx = (iu - (uns.length - 1) / 2) * 0.16;
          res.bands.forEach((b, ib) => {
            const a = u.baseline.bands.find(z => z.key === b.key);
            const c = u.post && u.post.ok ? u.post.bands.find(z => z.key === b.key) : null;
            if (a && isFinite(a.mrds)) ch.marker(ib + dx - .05, a.mrds, { color: '#1B4A72', size: 5 });
            if (c && isFinite(c.mrds)) {
              ch.marker(ib + dx + .05, c.mrds, { color: '#9C3050', size: 5 });
              ch.line([ib + dx - .05, ib + dx + .05], [a.mrds, c.mrds], { color: '#8A97A3', width: 1 });
            }
          });
        });
        ch.marker(-.42, lim * .88, { color: '#1B4A72', size: 5 });
        ch.text(ch.X(-.36), ch.Y(lim * .88) + 4, 'basal', { color: '#1B4A72' });
        if (res.hasBothMoments) {
          ch.marker(-.42, lim * .72, { color: '#9C3050', size: 5 });
          ch.text(ch.X(-.36), ch.Y(lim * .72) + 4, 'pós', { color: '#9C3050' });
        }
      }

      /* ---- (c) tabela: MRDS, decomposição e ΔMRDS ---------------------- */
      const linhasT = [];
      res.units.forEach(u => [['basal', u.baseline], ['pós', u.post]].forEach(([mom, par]) => {
        if (!par || !par.ok) return;
        par.bands.forEach(b => {
          /* o Δ é propriedade do PAR de momentos, não de um momento: repeti-lo
             nas duas linhas leria como se cada momento tivesse o seu */
          const dl = (mom === 'pós' && u.delta) ? u.delta.find(x => x.key === b.key) : null;
          linhasT.push([
            { html: `<span class="hemi-${String(u.hemisphere)[0]}">${hname(u.hemisphere)}</span>` }, mom, b.label,
            `${f(100 * b.mrds, 1)}%`, `${f(100 * b.mrdsRelative, 1)}%`, `${f(100 * par.mrdsTotal, 1)}%`,
            dl && isFinite(dl.delta) ? `${f(100 * dl.delta, 1)} pp` : '—',
            { html: `${par.nSegmentsRest}/${par.nSegmentsMove}`, cls: 'num' }
          ]);
        });
      }));
      node.appendChild(table(['hemisfério', 'momento', 'banda', 'MRDS', 'MRDS relativo', 'MRDS total',
        'ΔMRDS pós−basal', 'n seg. rep/mov'], linhasT));

      /* ---- (d) o que o número quer dizer -------------------------------- */
      {
        const v0 = (u0.baseline && u0.baseline.verdict) || {};
        if (v0.ok) node.appendChild(el('div', {
          class: v0.broadband && !v0.bandSpecific.length ? 'warnbox' : 'note',
          html: `<b>Banda larga ou específica?</b> ${v0.verdict}. A decomposição é exata: ` +
            `1 + MRDS = (1 + MRDS relativo) × (1 + MRDS total). O fator total é o que muda em ` +
            `<i>todo</i> o espectro — escala, ganho, artefato de movimento; só o fator relativo é ` +
            `candidato a (des)sincronização específica de banda.`
        }));
        const vr = u0.baseline ? u0.baseline.varianceRatio : NaN;
        node.appendChild(el('div', {
          class: 'note', html: `<b>Normalização.</b> ${res.normalizationNote || res.units[0].normalization.note}. ` +
            `Razão de variâncias movimento/repouso: <b>${f(vr, 4)}</b>` +
            (escopo === 'record' ? ' — igual a 1 por construção, e é essa a consequência de normalizar por gravação.' : '.')
        }));
      }

      /* ---- (e) estatística, com o piso de p declarado -------------------- */
      if (res.hasBothMoments && !Object.keys(res.tests).length) {
        node.appendChild(el('div', {
          class: 'note', html: `<b>Sem teste pareado.</b> O ΔMRDS está calculado, mas com ` +
            `${res.nUnits} unidade(s) não existe comparação pareada — um par precisa de ao menos duas ` +
            `unidades. O número acima descreve este registro; não é inferência.`
        }));
      } else if (res.hasBothMoments) {
        const linhasS = res.bands.map(b => {
          const t = res.tests[b.key] || {};
          return [b.label, { html: String(t.n || 0), cls: 'num' }, f(t.mean, 3), f(t.sd, 3),
            isFinite(t.p) ? pTag(t.p) : '—',
            t.tTest && isFinite(t.tTest.p) ? pTag(t.tTest.p) : '—',
            isFinite(t.minAchievableP) ? pTag(t.minAchievableP) : '—'];
        });
        node.appendChild(table(['banda', 'n unidades', 'ΔMRDS médio', 'DP', 'p (permutação exata)',
          'p (t pareado)', 'menor p possível'], linhasS));
        const t0 = res.tests[res.bands[0].key] || {};
        if (t0.underpowered) node.appendChild(el('div', {
          class: 'warnbox', html: `<b>O n limita o p antes do dado.</b> ${t0.reason}. ` +
            (t0.testsDisagree
              ? `O t pareado devolve ${pTag(t0.tTest.p)} para os mesmos números — a diferença entre os dois ` +
                `é <b>inteiramente</b> a suposição de normalidade, que ${t0.n} pontos não sustentam nem refutam.`
              : '')
        }));
        if (t0.subjectNote) node.appendChild(el('div', { class: 'warnbox', html: `<b>Pseudorreplicação.</b> ${t0.subjectNote}.` }));
      } else {
        node.appendChild(el('div', {
          class: 'warnbox', html: `<b>Só o primeiro nível.</b> Sem as épocas do momento pós-intervenção, ` +
            `o que existe é o contraste movimento−repouso. Ele <b>não</b> é corrigido para artefato de ` +
            `movimento: é justamente o contraste em que o artefato entra. O que cancela modulação motora ` +
            `reprodutível é o ΔMRDS = pós − basal, e para isso são necessárias as quatro épocas.`
        }));
      }

      /* ---- (f) o que o aparelho impõe sobre as bandas ------------------- */
      {
        const hp = (d.all[0] && d.all[0].filters) ? d.all[0].filters.highPassConfigurableHz : NaN;
        node.appendChild(el('div', {
          class: 'note', html: `<b>O aparelho antes do método.</b> ${C.HARDWARE_FILTERS.gammaCaveat}. ` +
            (isFinite(hp) && hp >= 10
              ? `<b>Além disso, o passa-alta está em ${hp} Hz</b>: a borda inferior de β (13 Hz) cai na ` +
                `transição do filtro. ${C.HARDWARE_FILTERS.highPass10Caveat}.`
              : '') + ` [${C.HARDWARE_FILTERS.source}]`
        }));
        node.appendChild(el('div', {
          class: 'note', html: `<b>Protocolo.</b> Welch com janela de ${f(janelaS, 0)} s, sobreposição de 50%, ` +
            `NFFT ${exato ? 'exato' : 'em potência de 2'} — resolução de ${f(u0.baseline ? u0.baseline.df : NaN, 3)} Hz. ` +
            `Bandas β ${C.MRDS_BANDS[0].lo}–${C.MRDS_BANDS[0].hi} Hz e γ ${C.MRDS_BANDS[1].lo}–${C.MRDS_BANDS[1].hi} Hz. ` +
            `Referência do desenho: ${C.MRDS_PROTOCOL.source}. Esta é uma ferramenta de pesquisa: a atribuição ` +
            `das épocas às condições é declarada por quem analisa e sai em toda exportação.`
        }));
      }

      node.appendChild(exportRow([
        { label: '⤓ PNG (PSD)', fn: () => P.downloadCanvas(box.canvas, 'F35_psd_mrds') },
        { label: '⤓ PNG (MRDS)', fn: () => P.downloadCanvas(boxB.canvas, 'F35_mrds') },
        {
          label: '⤓ CSV', fn: () => P.downloadText(
            C.mrdsMeta(res) + '\n' + P.toCSV(C.mrdsTable(res)), 'F35_mrds.csv', 'text/csv')
        },
        {
          label: '⤓ JSON', fn: () => P.downloadText(JSON.stringify({
            version: C.MRDS_VERSION, protocol: C.MRDS_PROTOCOL,
            zscoreScope: res.zscoreScope, unit: res.unit,
            nUnits: res.nUnits, nSubjects: res.nSubjects,
            assignment: modo === 'registros' ? atrib : opt('F35', 'janelas', {}),
            assignmentMode: modo,
            rows: C.mrdsTable(res), tests: res.tests,
            limitations: C.MRDS_LIMITACOES
          }, null, 2), 'F35_mrds.json', 'application/json')
        }
      ]));
    }
  },

  /* ----------------------------------------------------------------- F30 */
  {
    id: 'F30', title: 'Espectrograma — análise tempo-frequência no padrão do BRAVO',
    sub: 'Welch · STFT · emulação do PSD de bordo · wavelet · autorregressivo, com escala de densidade do scipy',
    has: d => d.bsTimeDomain.length || d.montageTD.length,
    render(node, d) {
      const tds = d.bsTimeDomain.concat(d.montageTD);
      if (!tds.length) return node.appendChild(el('div', { class: 'empty', text: 'Sem sinal bruto no tempo neste registro.' }));

      const iSinal = Math.min(opt('F30', 'sig', 0), tds.length - 1);
      const td = tds[iSinal];
      const metodo = opt('F30', 'met', 'welch');
      const janela = opt('F30', 'win', 1.0);
      const sobrep = opt('F30', 'ovl', 0.5);
      const resHz = opt('F30', 'res', 0.5);
      const fMax = opt('F30', 'fmax', 100);
      const cmin = opt('F30', 'cmin', -20), cmax = opt('F30', 'cmax', 20);
      const paleta = opt('F30', 'cmap', 'jet');
      const normalizar = opt('F30', 'norm', false);
      const modoNorm = opt('F30', 'nmode', 'divide');
      const semUmSobreF = opt('F30', 'aper', false);
      const auto = opt('F30', 'auto', true);
      const info = C.TF_METHODS.find(m => m.id === metodo) || C.TF_METHODS[0];

      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('sinal', tds.map((t, i) => ({ value: i, label: `${t.label} (${hname(t.hemisphere)}) · ${(t.data.length / t.fs).toFixed(0)} s` })), iSinal, v => setOpt('F30', 'sig', +v)),
        ctrlSelect('método', C.TF_METHODS.map(m => ({ value: m.id, label: m.label })), metodo, v => setOpt('F30', 'met', v)),
        ctrlNumber('janela (s)', janela, 0.125, 8, 0.125, v => setOpt('F30', 'win', v)),
        ctrlNumber('sobreposição (s)', sobrep, 0, 7.875, 0.125, v => setOpt('F30', 'ovl', v)),
        ctrlNumber('resolução (Hz)', resHz, 0.1, 5, 0.1, v => setOpt('F30', 'res', v)),
        ctrlNumber('f máx (Hz)', fMax, 10, 125, 5, v => setOpt('F30', 'fmax', v)),
        ctrlSelect('cores', [{ value: 'jet', label: 'Jet (paridade com o BRAVO)' }, { value: 'viridis', label: 'Viridis (recomendado)' }, { value: 'magma', label: 'Magma' }, { value: 'pretoazul', label: 'Preto → azul' }], paleta, v => setOpt('F30', 'cmap', v)),
        ctrlCheck('limites automáticos', auto, v => setOpt('F30', 'auto', v)),
        auto ? el('span') : ctrlNumber('mín (dB)', cmin, -120, 60, 5, v => setOpt('F30', 'cmin', v)),
        auto ? el('span') : ctrlNumber('máx (dB)', cmax, -60, 120, 5, v => setOpt('F30', 'cmax', v)),
        ctrlCheck('remover tendência 1/f', semUmSobreF, v => setOpt('F30', 'aper', v)),
        ctrlCheck('normalizar por linha de base', normalizar, v => setOpt('F30', 'norm', v)),
        normalizar ? ctrlSelect('normalização', [{ value: 'divide', label: 'divisão' }, { value: 'subtract', label: 'subtração (log)' }], modoNorm, v => setOpt('F30', 'nmode', v)) : el('span')
      ]));

      qualitySeal(node, td);

      const params = {
        method: metodo, windowS: janela, overlapS: sobrep, freqRes: resHz,
        detrendAperiodic: semUmSobreF, normalize: normalizar,
        mode: modoNorm, log: modoNorm === 'subtract',
        fMax: Math.min(fMax, td.fs / 2)
      };
      const chave = `${S.subject}|${iSinal}|${JSON.stringify(params)}`;
      const spec = _tfCache.get(chave);
      if (!spec) {
        /* ainda não calculado: dispara no trabalhador e redesenha quando voltar.
           O cálculo não pode acontecer aqui — `render` é síncrono, e uma FFT por
           época em minutos de sinal congelaria a aba. */
        calculaEspectrograma(chave, td, params);
        return node.appendChild(el('div', {
          class: 'calc', html: `calculando o espectrograma <b>${info.label}</b> em segundo plano…<br>` +
            `<b>a interface não travou:</b> o cálculo roda num trabalhador e a figura aparece sozinha quando terminar`
        }));
      }
      if (!spec.ok) return node.appendChild(el('div', { class: 'empty', text: spec.reason }));

      const dB = info.db && !(normalizar && modoNorm === 'subtract');
      const tm = C.tfMatrix(spec, { fMax: Math.min(fMax, td.fs / 2), dB });
      const planos = tm.matrix.flatMap(l => Array.from(l)).filter(isFinite).sort((a, b) => a - b);
      if (!planos.length) return node.appendChild(el('div', { class: 'empty', text: 'todas as épocas foram descartadas por dados faltantes' }));
      const zmin = auto ? planos[Math.floor(planos.length * 0.02)] : cmin;
      const zmax = auto ? planos[Math.floor(planos.length * 0.98)] : cmax;

      /* ---------------- (a) o espectrograma ---------------------------- */
      const box = plotBox(node, 340, 'svbox');
      const tip = el('div', { class: 'svtip' });
      if (box.box && box.box.appendChild) box.box.appendChild(tip);
      const dur = spec.times[spec.times.length - 1];
      const ch = new P.Chart(box.canvas, {
        width: box.width, height: 340, xlim: [spec.times[0], dur], ylim: [tm.freqs[0], tm.freqs[tm.freqs.length - 1]],
        xlabel: 'tempo (s)', ylabel: 'frequência (Hz)',
        title: `${info.label} — ${td.label} (${hname(td.hemisphere)}) · ${spec.nEpochsValid} de ${spec.nEpochs} épocas`,
        pad: { l: 72, r: 76, t: 26, b: 44 }
      });
      ch.heat(tm.matrix, { cmap: paleta, zmin, zmax, smooth: opt('F30', 'suave', true) });
      ch.axes({ grid: false });
      ch.colorbar({ label: dB ? `10·log₁₀(${spec.unit}) [dB]` : spec.unit });

      /* épocas descartadas por perda de pacote: hachura, não potência falsa */
      const passoT = spec.times.length > 1 ? spec.times[1] - spec.times[0] : 0.5;
      let nHach = 0;
      spec.times.forEach((t, i) => {
        if (!spec.flagged[i]) return;
        nHach++;
        ch.span(t - passoT / 2, t + passoT / 2, { color: '#FFFFFF', alpha: .55 });
      });

      /* estimulação e eventos sobre o eixo do tempo, como no BRAVO */
      const lfpPar = (d.bsLfp || []).find(r => r.startISO && td.t0 && Math.abs(new Date(r.startISO) - new Date(td.t0)) < 5000
        && r.series && r.series[td.hemisphere]);
      if (lfpPar) {
        const s = lfpPar.series[td.hemisphere];
        const mas = s.ma.filter(isFinite);
        if (mas.length) {
          const lo = Math.min.apply(null, mas), hi = Math.max.apply(null, mas);
          if (hi > lo + 1e-6) {
            /* a amplitude vira uma linha no topo do painel, na escala do eixo */
            const y0 = tm.freqs[tm.freqs.length - 1] * 0.86, y1 = tm.freqs[tm.freqs.length - 1] * 0.98;
            const ys = s.ma.map(v => isFinite(v) ? y0 + (v - lo) / (hi - lo) * (y1 - y0) : NaN);
            ch.line(s.t, ys, { color: '#FFFFFF', width: 2.2 });
            ch.line(s.t, ys, { color: COL.ink, width: 1.1, label: `estimulação ${f(lo, 1)}–${f(hi, 1)} mA` });
            ch.legend({ x: ch.x0 + 8, y: ch.y1 + 4 });
          }
          /* degraus de amplitude: linha vertical onde a corrente muda */
          for (let i = 1; i < s.ma.length; i++) {
            if (isFinite(s.ma[i]) && isFinite(s.ma[i - 1]) && Math.abs(s.ma[i] - s.ma[i - 1]) > 0.05)
              ch.vline(s.t[i], { color: '#FFFFFF', width: 1.4, dash: [3, 3] });
          }
        }
      }

      /* eventos marcados pelo paciente que caem dentro deste segmento */
      let nEventos = 0;
      if (td.t0) {
        const base = new Date(td.t0).getTime();
        (d.snapshots || []).forEach(evn => {
          const rel = (evn.t - base) / 1000;
          if (!(rel >= spec.times[0] && rel <= dur)) return;
          nEventos++;
          ch.vline(rel, { color: '#FFFFFF', width: 2.4, dash: null });
          ch.vline(rel, { color: COL.warn, width: 1.3, dash: null, label: evn.name });
        });
      }

      /* hover: frequência, tempo e potência do bin sob o cursor */
      const achaIdx = (arr, v) => { let b = 0, dist = Infinity; for (let i = 0; i < arr.length; i++) { const dd = Math.abs(arr[i] - v); if (dd < dist) { dist = dd; b = i; } } return b; };
      box.canvas.addEventListener('mousemove', ev => {
        const r = box.canvas.getBoundingClientRect();
        const px = ev.clientX - r.left, py = ev.clientY - r.top;
        const t = ch.invX(px), fq = ch.invY(py);
        if (t < spec.times[0] || t > dur || fq < tm.freqs[0] || fq > tm.freqs[tm.freqs.length - 1]) { tip.style.display = 'none'; return; }
        const it = achaIdx(spec.times, t), ifq = achaIdx(tm.freqs, fq);
        const v = tm.matrix[ifq][it];
        tip.innerHTML = `<b>${f(tm.freqs[ifq], 2)} Hz</b> · ${f(spec.times[it], 2)} s<br>` +
          (isFinite(v) ? `${f(v, 2)} ${dB ? 'dB' : spec.unit}` : '<i>época descartada</i>') +
          (spec.missing[it] > 0 ? `<br><i>${f(100 * spec.missing[it], 1)}% de amostras faltantes</i>` : '');
        tip.style.display = 'block';
        tip.style.left = Math.max(4, Math.min(px + 14, box.width - 180)) + 'px';
        tip.style.top = Math.max(4, py - 46) + 'px';
      });
      box.canvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; });

      /* ---------------- método declarado ------------------------------- */
      const p = spec.params;
      node.appendChild(table(['parâmetro', 'valor', 'o que significa'], [
        ['método', info.label, spec.pipeline.join(' → ')],
        ['janela', p.nperseg ? `${p.nperseg} amostras (${f(p.nperseg / p.fs, 3)} s)` : '—', p.window ? `janela ${p.window}` : '—'],
        ['passo entre épocas', `${f(p.stepS, 3)} s`, p.noverlap != null ? `sobreposição de ${p.noverlap} amostras` : `sobreposição de ${f(janela - p.stepS, 3)} s`],
        ['NFFT', p.nfft ? String(p.nfft) : '—', p.nfft ? `resolução ${f(p.fs / p.nfft, 3)} Hz${p.nfft !== p.nperseg ? ` · zero-pad de ${p.nperseg} para ${p.nfft}` : ''}` : '—'],
        ['escala', p.scaling === 'density' ? 'densidade (µV²/Hz)' : p.scaling === 'magnitude' ? 'magnitude |FFT| (µV)' : 'potência (µV²)',
          p.scaling === 'density' ? 'convenção do scipy.signal.welch: |X|²/(fs·Σw²), ×2 fora de DC e Nyquist' : 'sem normalização por densidade'],
        ['fs usada', `${f(p.fs, 4)} Hz`, td.fsEff && Math.abs(td.fsEff - td.fs) > 0.001 ? `efetiva medida pelos ticks (nominal ${td.fs} Hz)` : 'nominal'],
        ['épocas descartadas', `${spec.nEpochs - spec.nEpochsValid} de ${spec.nEpochs} (${f(spec.pctEpochsFlagged, 1)}%)`,
          `tolerância de dados faltantes: ${f(100 * (p.maxMissingFrac || 0), 0)}% por época`],
        ['limites de cor', `${f(zmin, 1)} a ${f(zmax, 1)} ${dB ? 'dB' : spec.unit}`,
          auto ? 'percentis 2 e 98 do próprio registro — desligue "limites automáticos" para os −20 a +20 dB fixos do BRAVO'
            : 'fixos, como no BRAVO (padrão −20 a +20 dB)'],
        ['mapa de cores', paleta === 'jet' ? 'Jet' : paleta === 'viridis' ? 'Viridis' : paleta,
          paleta === 'jet' ? 'paridade visual com o BRAVO; não é perceptualmente uniforme e some na impressão em cinza'
            : 'perceptualmente uniforme — o recomendado quando a figura não precisa parear com uma publicação antiga']
      ].concat(metodo === 'ar' ? [['ordem AR mediana', String(p.medianOrder), `escolhida por ${p.orderCriterion}, máximo ${p.maxOrder}`]] : [])
        .concat(spec.aperiodic ? [['expoente 1/f', f(spec.aperiodic.exponent, 3), `R² = ${f(spec.aperiodic.r2, 3)} em ${spec.aperiodic.fitLo}–${spec.aperiodic.fitHi} Hz · ${spec.aperiodic.method}`]] : [])
        .concat(spec.normalization ? [['linha de base', `${f(spec.normalization.baselineWindowS[0], 1)}–${f(spec.normalization.baselineWindowS[1], 1)} s`, `${spec.normalization.nEpochs} épocas · modo ${spec.normalization.mode}`]] : [])));

      if (spec.caveat) node.appendChild(el('div', { class: 'warnbox', html: `<b>Limite deste método.</b> ${spec.caveat}.` }));
      if (nHach) node.appendChild(el('div', {
        class: 'warnbox', html: `<b>${nHach} época(s) com perda de pacote</b> aparecem como faixa branca, não como potência. ` +
          `Preencher a lacuna com zero e desenhar o resultado seria inventar um número — e é justamente na perda de pacote que o espectro mais mente.`
      }));
      const potDois = p.nfft && (p.nfft & (p.nfft - 1)) === 0;
      node.appendChild(el('div', {
        class: 'note', html: `<b>Paridade com o BRAVO.</b> O BRAVO calcula estes espectrogramas em Python com <code>scipy</code>, num servidor. ` +
          `Aqui o mesmo cálculo roda no seu navegador, sem rede e sem <code>scipy</code>. ` +
          (p.scaling === 'density'
            ? `A escala é a densidade do <code>scipy.signal.welch</code> — <b>|X|²/(fs·Σw²)</b>, com fator 2 fora de DC e de Nyquist — e as janelas são periódicas, ` +
              `como o <code>scipy.signal.get_window</code> devolve por padrão. Conferido contra a identidade de Parseval: a integral da densidade sobre a ` +
              `frequência devolve a potência do sinal com erro de arredondamento. `
            : '') +
          (p.nfft && !potDois
            ? `<b>NFFT = round(fs/resolução) = ${p.nfft}</b> não é potência de dois, e por isso a FFT usa o algoritmo de <b>Bluestein</b>: ` +
              `completar com zeros até ${C.nextPow2(p.nfft)} seria mais rápido, mas mudaria o eixo de frequência e nenhum bin coincidiria com os do BRAVO.`
            : p.nfft
              ? `Com NFFT = ${p.nfft}, que é potência de dois, a transformada usa a FFT radix-2 direta — o Bluestein só entra quando a resolução pedida gera um NFFT arbitrário.`
              : 'Este método não passa por FFT de janela: a resolução vem da própria wavelet.')
      }));

      /* ---------------- (b) paridade com o próprio aparelho ------------- */
      if (lfpPar && metodo === 'percept') {
        node.appendChild(el('h4', { class: 'qc-title', html: '<b>(b) O que o aparelho reportou vs. o que o sinal bruto diz</b>' }));
        const s = lfpPar.series[td.hemisphere];
        const centro = ((lfpPar.therapy.perHemi || {})[td.hemisphere] || {}).centerFreq;
        if (!isFinite(centro)) node.appendChild(el('div', { class: 'empty', text: 'a frequência central de sensing não está declarada neste registro' }));
        else {
          const lo = centro - 2.5, hi = centro + 2.5;
          const ks = [];
          spec.freqs.forEach((fq, k) => { if (fq >= lo && fq <= hi) ks.push(k); });
          const emul = spec.times.map((t, i) => {
            let acc = 0, m = 0;
            ks.forEach(k => { const v = spec.power[i][k]; if (isFinite(v)) { acc += v; m++; } });
            return m ? acc / m : NaN;
          });
          /* o aparelho reporta a 2 Hz; a emulação a 50 Hz — compara no tempo do aparelho */
          const pares = [];
          s.t.forEach((t, j) => {
            if (!isFinite(s.lfp[j])) return;
            const i = achaIdx(spec.times, t);
            if (Math.abs(spec.times[i] - t) > 0.3 || !isFinite(emul[i])) return;
            pares.push({ t, dispositivo: s.lfp[j], emulado: emul[i] });
          });
          if (pares.length < 10) node.appendChild(el('div', { class: 'empty', text: `só ${pares.length} pontos comparáveis` }));
          else {
            const r = C.pearson(pares.map(x => x.emulado), pares.map(x => x.dispositivo));
            const reg = C.linreg(pares.map(x => x.emulado), pares.map(x => x.dispositivo));
            const b2 = plotBox(node, 260);
            const xs = pares.map(x => x.emulado), ys = pares.map(x => x.dispositivo);
            const ch2 = new P.Chart(b2.canvas, {
              width: b2.width, height: 260,
              xlim: [0, Math.max.apply(null, xs) * 1.05], ylim: [0, Math.max.apply(null, ys) * 1.05],
              xlabel: `emulação de bordo — média |FFT| em ${f(lo, 1)}–${f(hi, 1)} Hz`, ylabel: 'potência reportada pelo aparelho',
              title: `(b) paridade de dispositivo — ${pares.length} pontos pareados`, pad: { l: 76, r: 14, t: 26, b: 46 }
            });
            ch2.axes();
            ch2.scatter(xs, ys, { color: hcol(td.hemisphere), size: 2.4, alpha: .5 });
            const x0 = 0, x1 = Math.max.apply(null, xs);
            ch2.line([x0, x1], [reg.intercept, reg.intercept + reg.slope * x1], { color: COL.ink, width: 1.8, label: `y = ${f(reg.slope, 2)}·x + ${f(reg.intercept, 1)}` });
            ch2.legend({ x: ch2.x0 + 8, y: ch2.y1 + 6 });
            node.appendChild(table(['medida', 'valor', 'leitura'], [
              ['correlação de Pearson', f(r, 4), r > 0.9 ? 'a emulação reproduz a dinâmica do que o aparelho reportou' : r > 0.7 ? 'concordância parcial — verifique a banda e o ganho' : 'a emulação NÃO reproduz o valor do aparelho neste registro'],
              ['R² da regressão', f(reg.r2, 4), 'quanto da variação do valor do aparelho a emulação explica'],
              ['inclinação', f(reg.slope, 3), 'o fator de escala que falta entre a emulação e a unidade interna do aparelho'],
              ['ganho usado', f(spec.params.gain, 6), 'constante 1/54 do BRAVO — empírica, sem documentação do fabricante'],
              ['banda comparada', `${f(lo, 1)}–${f(hi, 1)} Hz`, `centro de sensing declarado: ${f(centro, 2)} Hz`]
            ]));
            node.appendChild(el('div', {
              class: r > 0.9 ? 'note' : 'warnbox',
              html: `<b>O que esta comparação estabelece e o que não estabelece.</b> Uma correlação alta mostra que a emulação segue a ` +
                `mesma <i>dinâmica</i> do cálculo de bordo. Ela <b>não</b> valida a escala absoluta: a inclinação de ${f(reg.slope, 2)} é o fator que ` +
                `sobra entre a magnitude |FFT| com ganho 1/54 e a unidade interna que o aparelho reporta, e essa unidade não é documentada. ` +
                `Use a emulação para comparar épocas entre si, não para afirmar um valor absoluto de potência.`
            }));
          }
        }
      } else if (lfpPar) node.appendChild(el('div', {
        class: 'note', html: `<b>Paridade com o aparelho.</b> Este registro tem, além do sinal bruto, a potência que o próprio Percept calculou a bordo. ` +
          `Escolha o método <b>PSD do Percept</b> acima para comparar os dois — é a única verificação possível de que a emulação reproduz o cálculo do firmware.`
      }));

      /* ---------------- exportações ------------------------------------ */
      {
        const ids = C.contactsOfChannel(td.channel || td.label);
        if (ids.length) {
          node.appendChild(el('h4', { class: 'qc-title', html: '<b>Qual par gerou este espectrograma</b>' }));
          painelEletrodo(node, {
            hemisphere: td.hemisphere || 'Left',
            highlight: marcasDeContatos(ids, 'sensing'),
            subtitle: `par ${ids.join('–')} · ${td.label}`,
            altura: 230
          });
        }
      }
      node.appendChild(exportRow([
        { label: '⤓ PNG', fn: () => P.downloadCanvas(box.canvas, `F30_espectrograma_${metodo}`) },
        { label: '⤓ CSV (formato longo)', fn: () => P.downloadText(csvEspectrograma(spec, tm, td, dB), `F30_spectrogram_${metodo}.csv`, 'text/csv') },
        {
          label: '⤓ CSV (formato largo)', fn: () => P.downloadText(
            '# ' + metaEspectrograma(spec, td).join('\n# ') + '\n' +
            ['Time_s'].concat(tm.freqs.map(x => 'f_' + x.toFixed(3))).join(',') + '\n' +
            spec.times.map((t, i) => [t.toFixed(4)].concat(tm.matrix.map(l => isFinite(l[i]) ? l[i].toFixed(6) : '')).join(',')).join('\n'),
            `F30_spectrogram_wide_${metodo}.csv`, 'text/csv')
        }
      ]));
    }
  },

  /* ----------------------------------------------------------------- F29 */
  {
    id: 'F29', title: 'Resposta à levodopa alinhada às tomadas',
    sub: 'curva medida com IC por bootstrap · significância por surrogados de deslocamento circular',
    has: d => Object.keys(d.trend).length && d.snapshots.length,
    render(node, d) {
      const hemis = Object.keys(d.trend);
      const h = opt('F29', 'hemi', hemis[0]);
      const pre = opt('F29', 'pre', 60), post = opt('F29', 'post', 240);
      const doseInfo = C.doseMarkers(d.snapshots, offMin(), { pattern: /medica|levodopa|dose/i, eventName: opt('F29', 'ev', null) || undefined });
      const nomes = Array.from(new Set(d.snapshots.map(s => s.name).filter(Boolean)));
      node.appendChild(el('div', { class: 'ctrls' }, [
        ctrlSelect('hemisfério', hemis.map(x => ({ value: x, label: rotuloLado(x) })), h, v => setOpt('F29', 'hemi', v)),
        ctrlSelect('evento de tomada', nomes.length ? nomes : ['—'], opt('F29', 'ev', '') || (doseInfo.ok ? doseInfo.doses[0].name : nomes[0]), v => setOpt('F29', 'ev', v)),
        ctrlNumber('pré (min)', pre, 20, 180, 10, v => setOpt('F29', 'pre', v)),
        ctrlNumber('pós (min)', post, 60, 480, 30, v => setOpt('F29', 'post', v))
      ]));
      if (!doseInfo.ok) return node.appendChild(el('div', { class: 'empty', html: `${doseInfo.reason}.` }));

      const limpo = C.removeOutliersMAD(d.trend[h], 'lfp', 4).kept;
      const rl = C.levodopaResponse(limpo, doseInfo.doses.map(x => x.t), offMin(), {
        preMin: pre, postMin: post, binMin: 10, nSurrogates: 300, nBootstrap: 800
      });
      if (!rl.ok) return node.appendChild(el('div', { class: 'empty', text: rl.reason }));

      const box = plotBox(node, 320);
      const todos = rl.curve.concat(rl.ciLow, rl.ciHigh).filter(isFinite);
      const ch = new P.Chart(box.canvas, {
        width: box.width, height: 320, xlim: [-pre, post],
        ylim: [Math.min.apply(null, todos) * 0.96, Math.max.apply(null, todos) * 1.04],
        xlabel: 'minutos em relação à tomada marcada', ylabel: '% da linha de base pré-dose',
        title: `resposta do beta à levodopa — ${rotuloLado(h)} · ${rl.nTrials} de ${rl.nDoses} tomadas com cobertura`,
        pad: { l: 72, r: 14, t: 26, b: 46 }
      });
      ch.axes();
      ch.span(-pre, 0, { color: COL.muted, alpha: .07, label: 'linha de base' });
      ch.area(rl.offsets, rl.ciLow, rl.ciHigh, { color: hcol(h), alpha: .2, label: 'IC 95% (bootstrap)' });
      ch.line(rl.offsets, rl.curve, { color: hcol(h), width: 2.6, label: 'mediana das tomadas' });
      ch.hline(100, { color: COL.muted, dash: [2, 2] });
      if (isFinite(rl.responseThresholdPct)) ch.hline(rl.responseThresholdPct, { color: COL.warn, dash: [5, 3], label: 'limiar de resposta' });
      ch.vline(0, { color: COL.ink, width: 1.6, dash: null, label: 'tomada' });
      if (rl.detected) {
        if (isFinite(rl.latencyMin)) ch.vline(rl.latencyMin, { color: COL.accent, width: 1.2, dash: [3, 3], label: `latência ${rl.latencyMin} min` });
        ch.marker(rl.timeToNadirMin, rl.nadirPct, { shape: 'o', size: 4, color: COL.accent, label: `nadir ${f(rl.dropPct, 0)}%` });
      }
      ch.legend({ x: ch.x1 - 190, y: ch.y1 + 6 });

      node.appendChild(table(['medida', 'valor', 'como foi definida'], [
        ['tomadas alinhadas', `${rl.nTrials} de ${rl.nDoses}`, `cobertura média de ${f(rl.coverage, 0)}% dos bins na janela −${pre}/+${post} min`],
        ['queda máxima', `${f(rl.dropPct, 1)}%`, `nadir em ${rl.timeToNadirMin} min após a marca`],
        ['significância', { html: pHtml(rl.p) }, `${rl.nSurrogates} surrogados por ${rl.surrogateMethod}`],
        ['queda que o ritmo diurno já explica', isFinite(rl.surrogateDropPct) ? `${f(rl.surrogateDropPct, 1)}%` : '—', 'mediana da queda nos surrogados — é o piso contra o qual a queda observada tem de se destacar'],
        ['latência', rl.detected && isFinite(rl.latencyMin) ? `${rl.latencyMin} min` : 'não reportada', rl.detected ? 'primeiro bin abaixo do limiar por dois bins seguidos' : 'só é reportada quando a curva se separa do acaso'],
        ['duração do efeito', rl.detected && isFinite(rl.durationMin) ? `${rl.durationMin} min${rl.censored ? ' (censurado)' : ''}` : 'não reportada', 'trecho contíguo abaixo do limiar que contém o nadir'],
        ['limiar de resposta', isFinite(rl.responseThresholdPct) ? `${f(rl.responseThresholdPct, 1)}%` : '—', `100 − 2·DP da própria curva antes da dose (DP = ${f(rl.baselineSD, 2)})`]
      ]));
      node.appendChild(el('div', {
        class: rl.detected ? 'note' : 'warnbox',
        html: `<b>${rl.detected ? 'Resposta detectada' : 'Sem resposta demonstrável'}.</b> ${rl.interpretation}.`
      }));
      node.appendChild(el('div', {
        class: 'warnbox', html: `<b>Hora do dia e efeito da dose são confundíveis.</b> ${rl.confound}.`
      }));
      node.appendChild(el('div', {
        class: 'note', html: `<b>Por que surrogado por deslocamento circular.</b> O beta é fortemente autocorrelacionado: ` +
          `sortear horas ao acaso destrói essa estrutura e faz qualquer queda parecer significativa. Deslocar todas as marcas ` +
          `pelo mesmo intervalo preserva a autocorrelação e mantém o número e o espaçamento das tomadas — o que muda é só a fase. ` +
          `Semente ${rl.seed}, ${rl.nBootstrap} reamostragens de bootstrap. <b>${rl.caveat}.</b>`
      }));
      node.appendChild(el('div', {
        class: 'seal', text: `${doseInfo.n} tomadas marcadas em ${doseInfo.nDays} dias · mediana de ${f(doseInfo.dosesPerDay, 1)} por dia · ` +
          (isFinite(doseInfo.medianIntervalH) ? `intervalo mediano de ${f(doseInfo.medianIntervalH, 1)} h · ` : 'sem duas tomadas no mesmo dia para estimar intervalo · ') +
          doseInfo.note
      }));
      node.appendChild(exportRow([
        { label: '⤓ PNG', fn: () => P.downloadCanvas(box.canvas, 'F29_resposta_levodopa') },
        {
          label: '⤓ CSV da curva', fn: () => P.downloadText(P.toCSV(rl.offsets.map((o, i) => ({
            offset_min: o, mediana_pct: rl.curve[i], ic_baixo: rl.ciLow[i], ic_alto: rl.ciHigh[i],
            q1: rl.q1[i], q3: rl.q3[i], n_tomadas: rl.nTrials, p: rl.p, limiar_pct: rl.responseThresholdPct,
            hemisferio: h, semente: rl.seed
          }))), 'F29_resposta_levodopa.csv', 'text/csv')
        }
      ]));
    }
  }
];

/* segmentosPorLacuna(ts, limiarMs) — índices [ini, fim) das corridas contíguas
   de uma série temporal. Existe para que a linha do gráfico levante a caneta
   na lacuna: uma reta atravessando horas sem amostra é imputação silenciosa
   feita com tinta, e o contrato do projeto proíbe imputar em silêncio. */
function segmentosPorLacuna(ts, limiarMs) {
  const segs = []; let ini = 0;
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - ts[i - 1] > limiarMs) { segs.push([ini, i]); ini = i; }
  }
  if (ts.length) segs.push([ini, ts.length]);
  return segs;
}

const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/* ---------------------------------------------------- painéis dia a dia ---
   POR QUE EXISTE. No gráfico contínuo, 30 dias em 900 px dão 30 px por dia:
   o padrão diurno vira serrilha e o dia atípico não se distingue. Empilhando
   um painel por dia civil sobre o MESMO eixo de horas, a comparação passa a
   ser vertical — o olho alinha 3h da manhã de segunda com 3h de terça, que é
   a comparação que a pergunta clínica pede.

   Entrada: porDia[h] = saída de C.splitByLocalDay para aquele hemisfério.
   Devolve {canvases, dias} para a exportação em PNG.                       */
function desenhaDiaADia(node, hemis, porDia, o) {
  const grade = el('div', { class: 'dias-grid' });
  node.appendChild(grade);
  const canvases = [], dias = [];
  /* a lista de dias é a mesma nos dois hemisférios (splitByLocalDay recebeu a
     faixa unificada), mas um hemisfério sem nenhuma amostra devolve lista
     vazia — então a referência é a mais longa, não a do primeiro */
  const refs = hemis.map(h => porDia[h].days).reduce((a, b) => b.length > a.length ? b : a, []);
  refs.forEach((_, iDia) => {
    const dayKey = refs[iDia].dayKey;
    const doDia = {};
    hemis.forEach(h => { doDia[h] = (porDia[h].days[iDia] || { rows: [], hours: [], values: [], segments: [], empty: true }); });
    const vazioTotal = hemis.every(h => doDia[h].empty);

    /* Escala vertical: compartilhada por padrão. Cada painel com escala
       própria lê melhor a FORMA do dia, e mente sobre a ALTURA — dois dias com
       potências muito diferentes ficam com picos do mesmo tamanho. */
    let ymax = o.vmax;
    if (!o.mesmaEscala) {
      const vs = hemis.flatMap(h => doDia[h].values).filter(isFinite);
      ymax = vs.length ? Math.max.apply(null, vs) : o.vmax;
    }
    const cel = el('div', { class: 'dia-cel' });
    grade.appendChild(cel);
    const dt = new Date(dayKey + 'T12:00:00Z');
    const rotulo = `${dayKey.slice(8, 10)}/${dayKey.slice(5, 7)} · ${DIAS_SEMANA[dt.getUTCDay()]}`;
    const box = plotBox(cel, 150);
    const ch = new P.Chart(box.canvas, {
      width: box.width, height: box.height, xlim: [0, 24], ylim: [0, (ymax || 1) * 1.12],
      xlabel: 'hora local', ylabel: 'LFP (u.a.)', title: rotulo, pad: { l: 52, r: o.showMa ? 40 : 12, t: 22, b: 34 }
    });
    ch.axes({ nx: 5, xticks: [0, 6, 12, 18, 24], xfmt: v => `${v}h` });
    ch.span(0, 6, { color: '#1B3A5C', alpha: .05 });
    ch.span(22, 24, { color: '#1B3A5C', alpha: .05 });

    if (vazioTotal) {
      ch.text((ch.x0 + ch.x1) / 2 - 44, (ch.y0 + ch.y1) / 2, 'sem dado neste dia', { color: '#8A97A3' });
    } else {
      hemis.forEach(h => {
        const dd = doDia[h];
        if (dd.empty) return;
        ch.scatter(dd.hours, dd.values, { color: hcol(h), size: 1.0, alpha: .30 });
        dd.segments.forEach(seg => {
          const sx = dd.hours.slice(seg.from, seg.to + 1), sy = dd.values.slice(seg.from, seg.to + 1);
          const yy = o.smooth > 1 ? movingMedian(sy, o.smooth) : sy;
          ch.line(sx, yy, { color: hcol(h), width: o.smooth > 1 ? 1.5 : .8 });
        });
      });
      if (o.showMa) hemis.forEach(h => {
        const dd = doDia[h];
        if (dd.empty) return;
        dd.segments.forEach(seg => ch.line(
          dd.hours.slice(seg.from, seg.to + 1),
          dd.rows.slice(seg.from, seg.to + 1).map(r => r.ma / o.maMax * ymax * .28),
          { color: COL.accent, width: 1, dash: [3, 2] }));
      });
    }
    canvases.push(box.canvas); dias.push(dayKey);

    /* A legenda de cada painel diz quanto dele é medida — sem isso, um dia com
       4 h de registro e um dia completo têm a mesma aparência de "dia". */
    const cob = hemis.map(h => doDia[h].empty ? `${hname(h)}: sem dado`
      : `${hname(h)}: ${f(100 * doDia[h].coverage, 0)}% do dia`
      + (doDia[h].segments.length > 1 ? `, ${doDia[h].segments.length} trechos` : '')).join(' · ');
    cel.appendChild(el('div', { class: 'dia-legenda', text: cob }));
    cel.appendChild(el('button', {
      class: 'btn mini', text: '⤓ PNG', onclick: () => P.downloadCanvas(box.canvas, `F8_dia_${dayKey}`)
    }));
  });
  return { canvases, dias };
}

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
      /* arquivo recuperado de exportação interrompida: o aviso mora ao lado do
         nome do arquivo, porque é dele que a ressalva é — não da análise */
      const tr = p.truncated;
      const meta = [
        el('b', { text: fl.name.replace(/^Report_Json_Session_Report_/, '').replace(/\.json$/, '') }),
        el('span', { text: `${p.patient.idHash} · ${n} modalidades` })
      ];
      if (tr) meta.push(el('span', {
        class: 'trunc-tag',
        title: `${tr.reason}. ${tr.rule}. ${tr.advice}`,
        text: `⚠ recuperado — ${f(tr.pctLost, 2)}% do arquivo perdido no fim`
      }));
      ul.appendChild(el('li', { class: tr ? 'truncado' : '' }, [
        el('div', { class: 'meta' }, meta),
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
        el('button', { class: 'btn primary', text: t('⤓ Relatório clínico (PDF)'), onclick: gerarPdfNativo }),
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
      ['⤓ Relatório PDF', 'arquivo escrito pelo próprio software — igual em qualquer navegador', gerarPdfNativo, 'primary'],
      ['⤓ Relatório pela impressora', 'usa a caixa de impressão do navegador (layout depende dela)', generateReport],
      ['⤓ JSON para estatística', 'variáveis-chave por sessão · paciente · implante', exportJSON],
      ['⤓ CSV — métricas agudas', 'pico β, aperiódico, bursts (sessão × hemisfério)', exportAcuteCSV],
      ['⤓ CSV — métricas crônicas', 'circadiano e limiares de aDBS (Timeline)', exportChronicCSV],
      ['⤓ CSV — Timeline bruto', 'amostras de 10 min, formato longo para R', exportSession],
      ['⤓ Todas as figuras (PNG)', 'baixa cada gráfico individualmente', downloadAllFigures],
      ['⤓ Checklist PERCEPT-REPORT (.md)', 'itens mínimos de reporte, preenchidos automaticamente', () => exportChecklist('md')],
      ['⤓ Checklist PERCEPT-REPORT (.docx)', 'mesmo conteúdo, pronto para material suplementar', () => exportChecklist('docx')],
      ['⤓ Manifesto de proveniência', 'todos os parâmetros efetivos + hash citável da análise', exportManifest],
      ['⤓ Pacote completo (.zip)', 'métricas, EDF, BIDS-like, manifesto, checklist e todas as figuras', exportarPacote, 'primary']
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
/* ======================================================== ABAS ===========
   A HIERARQUIA QUE ORGANIZA O SOFTWARE NÃO É DE VISUALIZAÇÃO, É DE INFERÊNCIA.

   O registro crônico e o registro agudo do Percept não são o mesmo sinal em
   janelas diferentes. Diferem no desenho (observacional vs. experimental), na
   inferência que sustentam (associação vs. causa dirigida pelo desenho), na
   amostragem (densa no tempo e pobre no espectro vs. o contrário), na unidade
   de análise (timestamp/dia/dose vs. ensaio/evento/condição) e no confundidor
   que os mata (mudança de configuração vs. ruído de sincronização).

   Tratá-los como abas distintas, cada uma com o seu cabeçalho de orientação, é
   o que impede a falácia recorrente da literatura de Percept: usar um achado
   agudo de dez minutos de consultório para interpretar uma tendência crônica de
   seis semanas, ou o contrário, como se fossem medidas da mesma quantidade.

   As duas camadas se encontram na aba PONTE — onde o agudo calibra a escala do
   crônico (passaporte do biomarcador), o crônico pauta a próxima sessão aguda
   (agenda), e a escolha de limiar de aDBS precisa das duas ao mesmo tempo.   */

const ABAS = [
  {
    id: 'inicio', label: 'Início', sub: 'por onde começar', especial: 'triagem',
    orient: {
      titulo: 'O que este arquivo responde',
      texto: [
        'Cada Session Report contém modalidades diferentes, conforme o que foi executado na consulta. ' +
        'Abaixo está o que <b>este</b> conjunto de arquivos permite perguntar — e o que ele não permite.',
        'Escolha a pergunta; o aplicativo leva você à figura que a responde.'
      ]
    }
  },
  {
    id: 'agudo', label: 'Agudo', sub: 'sessão · experimento', camada: 'agudo',
    figuras: ['F1', 'F2', 'F5', 'F6', 'F7', 'F12', 'F18', 'F19', 'F20', 'F21', 'F22', 'F24', 'F30', 'F34', 'F35'],
    orient: {
      titulo: 'Registro agudo — sessão controlada',
      camada: 'agudo · experimental',
      texto: [
        'Aqui o sinal é <b>denso no espectro e esparso no tempo</b>: a série temporal completa, tipicamente a 250 Hz, ' +
        'durante minutos. A unidade de análise é o ensaio, o evento ou a condição, e a inferência é dirigida pelo desenho — ' +
        'você manipulou alguma coisa e mede o que aconteceu.',
        'É a camada que <b>define o biomarcador</b>: qual par bipolar, qual frequência de pico, qual largura de banda, ' +
        'qual a razão sinal-ruído, se há contaminação por ECG, e se o pico sobrevive à separação do componente aperiódico. ' +
        'Esse produto vira o <b>passaporte</b> na aba Ponte.'
      ],
      tabela: [
        ['Responde bem', 'dinâmica de bursts, acoplamento fase-amplitude, resposta aguda a rampa de amplitude ou a levodopa, correlatos de tarefa, gama de discinesia'],
        ['Não responde', 'qualquer coisa que exija dias — ritmo circadiano, flutuação em vida real, adesão, estabilidade do biomarcador'],
        ['Risco dominante', 'n baixo e ruído de sincronização; sem TTL, a latência do Bluetooth tem jitter real']
      ],
      limite: 'Um achado de dez minutos de consultório <b>não interpreta</b> uma tendência de seis semanas. ' +
        'Se a sua pergunta é sobre dias, ela está na aba Crônico.'
    }
  },
  {
    id: 'cronico', label: 'Crônico', sub: 'dias · vida real', camada: 'cronico',
    figuras: ['F8', 'F32', 'F9', 'F40', 'F37', 'F39', 'F41', 'F13', 'F10', 'F25', 'F28', 'F29'],
    orient: {
      titulo: 'Registro crônico — vida real, sem supervisão',
      camada: 'crônico · observacional',
      texto: [
        'Aqui o sinal é <b>denso no tempo e pobre no espectro</b>: um escalar por bin de dez minutos, numa banda escolhida ' +
        '<i>a priori</i>, durante semanas ou meses, no domicílio. A unidade de análise é o timestamp, o dia ou a dose, e a ' +
        'inferência é associativa — ninguém manipulou nada.',
        'É a única camada que enxerga ritmo circadiano, flutuação motora em ambiente natural, resposta a cada tomada de ' +
        'levodopa em vida livre, adesão e estabilidade do biomarcador ao longo de meses.'
      ],
      tabela: [
        ['Responde bem', 'ritmo circadiano, arquitetura de sono inferida, flutuações e ciclo medicamentoso, habituação, deriva do nível basal'],
        ['Não responde', 'resolução espectral (o bin já vem colapsado numa banda), dinâmica de bursts, acoplamento fase-amplitude, latência abaixo de dez minutos'],
        ['Risco dominante', 'confundimento por mudança de configuração de sensing entre consultas — invisível no gráfico, fatal para a leitura']
      ],
      limite: 'Antes de comparar dois períodos, confira os <b>blocos de configuração</b> (F32). Se o par bipolar ou a ' +
        'frequência central mudaram, a série antes e depois não é a mesma variável.'
    }
  },
  {
    id: 'ponte', label: 'Ponte', sub: 'calibração · aDBS · agenda', camada: 'ponte',
    figuras: ['F31', 'F11', 'F23', 'F36', 'F33'],
    orient: {
      titulo: 'A ponte entre as camadas',
      camada: 'agudo ↔ crônico',
      texto: [
        '<b>Sentido descendente — calibração.</b> A sessão aguda define o biomarcador e produz o <b>passaporte</b>: par bipolar, ' +
        'frequência de pico, largura de banda, razão sinal-ruído, contaminação por ECG. Esse objeto vira a configuração de sensing ' +
        'e a referência de escala do registro crônico seguinte. Sem esse vínculo, comparar dois meses de Timeline é comparar duas ' +
        'variáveis diferentes com o mesmo nome.',
        '<b>Sentido ascendente — hipótese.</b> O crônico detecta o anômalo e não explica: uma queda reprodutível às 3h, uma dose ' +
        'que deixou de responder, uma assimetria emergente. A <b>agenda</b> transforma isso na pauta da próxima sessão aguda.',
        '<b>Convergência — aDBS.</b> A escolha de limiar precisa das duas camadas: o agudo estabelece a relação entre nível de beta ' +
        'e estado motor observado; o crônico estabelece a distribuição real daquele biomarcador em vida livre, que é o que determina ' +
        'qual fração do dia o limiar será cruzado. Definir limiar só com dado de consultório é erro previsível de generalização.'
      ],
      limite: 'Esta aba é a única em que atravessar as camadas é legítimo — porque aqui o cruzamento é <b>o método</b>, ' +
        'e não uma extrapolação silenciosa.'
    }
  },
  {
    id: 'qualidade', label: 'Qualidade', sub: 'posso confiar?', camada: null,
    figuras: ['F17', 'F15', 'F16', 'F3', 'F4'],
    orient: {
      titulo: 'Posso confiar neste sinal?',
      texto: [
        'Artefato cardíaco no LFP é <b>sistemático</b>, depende do lado de implante do gerador, e produz um pico espúrio ' +
        'convincente que ninguém reconhece olhando o espectro. O mesmo vale para harmônico de estimulação, alias e ganho saturado.',
        'O alarme no topo desta aba ordena por gravidade e emite um veredito de uso por canal. ' +
        'Ausência de verificação <b>não é</b> ausência de artefato: o que não pôde ser verificado neste arquivo aparece listado como tal.'
      ],
      limite: 'Um canal com veredito <b>não interprete</b> deve ficar fora de toda leitura das outras abas, ' +
        'inclusive das figuras que ele alimenta em silêncio.'
    }
  },
  {
    id: 'coorte', label: 'Coorte', sub: 'n pacientes', camada: null,
    figuras: ['F27', 'F38', 'F26'],
    orient: {
      titulo: 'Muitos registros, inferência de grupo',
      texto: [
        'A unidade de análise deixa de ser o paciente e passa a ser a amostra. Carregue uma pasta inteira com <b>+ pasta</b>: ' +
        'os arquivos são agrupados por sujeito, e o resultado é uma tabela <i>tidy</i>, não quarenta relatórios.',
        'Comparar o beta de hoje com o de seis meses atrás só faz sentido se o que mudou foi o cérebro, e não a medida — ' +
        'daí a confiabilidade entre sessões (ICC) e a deriva de impedância ficarem aqui, e não na aba Crônico.'
      ],
      limite: 'Prevalência e estatística de grupo com n pequeno saem com intervalo de confiança largo <b>de propósito</b>. ' +
        'O intervalo é o resultado; a estimativa pontual sozinha, não.'
    }
  },
  {
    id: 'relatorio', label: 'Relatório', sub: 'uma página', especial: 'relatorio',
    orient: {
      titulo: 'O que sai daqui para o prontuário',
      texto: [
        'Uma página datada e reprodutível: identificação do dispositivo, eletrodo, impedâncias, grupo ativo, espectro por ' +
        'hemisfério, sugestão de banda de sensing e as ressalvas que couberem.',
        'Toda exportação pode vir com o <b>manifesto de proveniência</b> — hash do arquivo de origem, versão do software, ' +
        'parâmetros de cada figura e sementes dos procedimentos aleatórios. É o que torna a análise refazível meses depois.'
      ],
      limite: 'Ferramenta de pesquisa e apoio à decisão. <b>Não é dispositivo médico</b> e não substitui o software ' +
        'regulado do fabricante.'
    }
  }
];

const abaPorId = id => ABAS.find(a => a.id === id) || ABAS[0];
function abaAtual() {
  const a = abaPorId(S.aba || 'inicio');
  return a;
}
function setAba(id, foco) {
  if (S.aba === id) return;
  S.aba = id;
  salvarPref('aba', id);
  renderTabs();
  renderFigures();
  const main = document.getElementById('figs');
  if (main && main.scrollIntoView) main.scrollIntoView({ block: 'start' });
  if (foco && main && main.focus) main.focus();
}

/* Figuras desta aba que existem e estão liberadas pelo modo atual. A aba é um
   recorte de ASSUNTO; o modo é um recorte de PROFUNDIDADE. Os dois se compõem. */
function figurasDaAba(aba, d) {
  if (!aba.figuras) return [];
  const permitidas = new Set(figurasVisiveis().map(f => f.id));
  return aba.figuras
    .map(id => FIGURES.find(f => f.id === id))
    .filter(f => f && permitidas.has(f.id))
    .map(f => ({ fig: f, ok: d ? !!f.has(d) : false }));
}

function renderTabs() {
  const nav = document.getElementById('tabs');
  if (!nav) return;
  nav.innerHTML = '';
  const temArquivo = S.files.length > 0;
  const d = temArquivo ? ds() : null;
  ABAS.forEach((aba, i) => {
    if (aba.id === 'ponte') nav.appendChild(el('div', { class: 'sep' }));
    const figs = figurasDaAba(aba, d);
    const nProntas = figs.filter(x => x.ok).length;
    const vazia = temArquivo && aba.figuras && nProntas === 0;
    const b = el('button', {
      type: 'button', role: 'tab', id: 'tab-' + aba.id,
      class: vazia ? 'vazia' : '',
      'aria-selected': String(S.aba === aba.id),
      'aria-controls': 'figs',
      title: vazia ? 'nenhuma figura desta aba tem dado neste registro' : '',
      onclick: () => setAba(aba.id, true)
    }, [
      el('b', { text: t(aba.label) }),
      el('i', { text: aba.sub })
    ]);
    if (aba.figuras && temArquivo) b.appendChild(el('span', { class: 'cnt', text: String(nProntas) }));
    nav.appendChild(b);
    void i;
  });
}

/* Cabeçalho de orientação: a primeira coisa dentro de cada aba diz que camada é
   aquela, que inferência ela sustenta e qual fronteira não deve ser cruzada. */
function cabecalhoOrientacao(aba) {
  const o = aba.orient;
  if (!o) return null;
  const classe = aba.camada === 'agudo' ? 'agudo' : aba.camada === 'cronico' ? 'cronico'
    : aba.camada === 'ponte' ? 'ponte' : aba.id === 'qualidade' ? 'qc' : '';
  const box = el('section', { class: 'orient ' + classe, 'aria-label': 'orientação da aba' });
  if (o.camada) box.appendChild(el('span', { class: 'cam ' + classe, text: o.camada }));
  box.appendChild(el('h2', { text: o.titulo }));
  (o.texto || []).forEach(p => box.appendChild(el('p', { html: p })));
  if (o.tabela) {
    const dl = el('dl');
    o.tabela.forEach(([k, v]) => { dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', { text: v })); });
    box.appendChild(dl);
  }
  if (o.limite) box.appendChild(el('p', { class: 'lim', html: '<b>Fronteira.</b> ' + o.limite }));
  return box;
}

/* ------------------------------------------------------------- triagem ----
   TEMPO ATÉ O PRIMEIRO INSIGHT. O usuário clínico não vem escolher janela de
   Welch — vem com uma pergunta. Esta grade lista as perguntas em português de
   consultório e de bancada, diz quais delas ESTE conjunto de arquivos responde,
   e leva direto à figura. A pergunta que o dado não sustenta aparece desativada
   com o motivo, o que é informação e não obstáculo: saber que o arquivo não tem
   Timeline é metade do caminho para pedir o exportador certo na próxima consulta. */
const PERGUNTAS = [
  {
    id: 'candidato', persona: 'clinico',
    q: 'Este paciente é candidato a sensing?',
    ajuda: 'Existe pico do marcador identificável em algum par bipolar, em cada hemisfério, acima do fundo aperiódico?',
    aba: 'agudo', fig: 'F1',
    tem: d => d.montage.length || d.sensingSetup.length,
    falta: 'este registro não tem Survey nem SignalTest — é preciso um arquivo com LFPMontage ou SenseChannelTests'
  },
  {
    id: 'banda', persona: 'clinico',
    q: 'Que frequência central e largura de banda configurar?',
    ajuda: 'A sugestão sai do passaporte do biomarcador, com a confiança declarada e a ressalva de que quem confirma é o profissional no programador.',
    aba: 'ponte', fig: 'F31',
    tem: d => d.montage.length || d.sensingSetup.length,
    falta: 'sem Survey não há como escolher par bipolar nem medir o pico'
  },
  {
    id: 'janela', persona: 'clinico',
    q: 'A rampa de amplitude sugere qual janela terapêutica?',
    ajuda: 'Curva de supressão do marcador contra a corrente entregue, com o modelo de ajuste declarado.',
    aba: 'agudo', fig: 'F7',
    tem: d => d.bsLfp.length,
    falta: 'este registro não tem BrainSense Streaming com estimulação (BrainSenseLfp)'
  },
  {
    id: 'biologico', persona: 'clinico',
    q: 'A mudança ao longo das semanas é biológica ou é troca de configuração?',
    ajuda: 'Segmentação do Timeline em blocos de configuração comparável, com os pontos de mudança de nível e os marcos que os explicam.',
    aba: 'cronico', fig: 'F32',
    tem: d => Object.keys(d.trend).length,
    falta: 'este registro não tem Timeline crônico (DiagnosticData.LFPTrendLogs)'
  },
  {
    id: 'ondeoff', persona: 'clinico',
    q: 'Onde no dia o OFF se concentra?',
    ajuda: 'Matriz hora × dia: OFF matinal por delayed-on, vespertino por wearing-off, ou picado — distinção que a barra empilhada destrói.',
    aba: 'cronico', fig: 'F28',
    tem: d => Object.keys(d.trend).length || (S.diary && S.diary.parsed && S.diary.parsed.ok),
    falta: 'é preciso o Timeline crônico ou um diário de Hauser em CSV'
  },
  {
    id: 'dose', persona: 'clinico',
    q: 'Como o marcador responde a cada dose de levodopa?',
    ajuda: 'Latência até o nadir, profundidade da supressão, duração do efeito e variabilidade entre doses — em vida real, não no consultório.',
    aba: 'cronico', fig: 'F29',
    tem: d => Object.keys(d.trend).length && d.snapshots.length,
    falta: 'é preciso o Timeline crônico e eventos de medicação marcados pelo paciente no aparelho'
  },
  {
    id: 'adbs', persona: 'clinico',
    q: 'É candidato a DBS adaptativa, e com que limiar?',
    ajuda: 'Elegibilidade com critérios explícitos, e o limiar candidato sobreposto à distribuição real do biomarcador em vida livre.',
    aba: 'ponte', fig: 'F23',
    tem: d => Object.keys(d.trend).length,
    falta: 'sem Timeline não há distribuição em vida livre contra a qual julgar um limiar'
  },
  {
    id: 'confio', persona: 'clinico',
    q: 'Posso confiar neste sinal?',
    ajuda: 'Alarme de artefato por canal, com veredito de uso e o que não pôde ser verificado neste arquivo.',
    aba: 'qualidade', fig: 'F17',
    tem: () => true, falta: ''
  },
  {
    id: 'ritmo', persona: 'pesquisa',
    q: 'Há ritmo circadiano, e ele é específico da banda?',
    ajuda: 'Cosinor com IC por bootstrap de dias inteiros, métricas não paramétricas da cronobiologia, e o teste contra uma banda-controle.',
    aba: 'cronico', fig: 'F9',
    tem: d => Object.keys(d.trend).length,
    falta: 'é preciso o Timeline crônico com ao menos dois dias'
  },
  {
    id: 'tf', persona: 'pesquisa',
    q: 'Como o espectro muda ao longo do registro?',
    ajuda: 'Espectrograma por cinco estimadores, com a escala de densidade do scipy e época com perda de pacote marcada, nunca preenchida.',
    aba: 'agudo', fig: 'F30',
    tem: d => d.bsTimeDomain.length || d.montageTD.length,
    falta: 'é preciso sinal bruto no domínio do tempo'
  },
  {
    id: 'bursts', persona: 'pesquisa',
    q: 'Onde cada rajada começa e termina?',
    ajuda: 'Wavelet de Morlet com delimitação separada da detecção, e limiar por percentil ou pelo fundo aperiódico.',
    aba: 'agudo', fig: 'F20',
    tem: d => d.bsTimeDomain.length || d.montageTD.length,
    falta: 'é preciso sinal bruto no domínio do tempo'
  },
  {
    id: 'externo', persona: 'pesquisa',
    q: 'A oscilação é do cérebro ou é o movimento entrando pelo eletrodo?',
    ajuda: 'Importa IMU, EMG ou ECG externo, alinha, e mede coerência com limiar corrigido — declarando a incerteza residual do alinhamento.',
    aba: 'agudo', fig: 'F24',
    tem: d => d.bsTimeDomain.length || d.montageTD.length,
    falta: 'é preciso sinal bruto de LFP para comparar com o sinal externo'
  },
  {
    id: 'agenda', persona: 'pesquisa',
    q: 'O que investigar na próxima sessão?',
    ajuda: 'O crônico detecta o anômalo e não explica. A agenda transforma cada anomalia em protocolo agudo e diz o que ficaria decidido.',
    aba: 'ponte', fig: 'F33',
    tem: d => Object.keys(d.trend).length,
    falta: 'é preciso o Timeline crônico para detectar o que merece investigação'
  },
  {
    id: 'coorte', persona: 'pesquisa',
    q: 'Como está a coorte inteira?',
    ajuda: 'Tabela tidy por sujeito e hemisfério, prevalência de pico com IC de Wilson, estatísticas de grupo. Carregue uma pasta com + pasta.',
    aba: 'coorte', fig: 'F27',
    tem: () => true, falta: ''
  }
];

function painelTriagem(main, d) {
  const cabec = cabecalhoOrientacao(abaPorId('inicio'));
  if (cabec) main.appendChild(cabec);

  /* Arquivo recuperado de exportação interrompida: o aviso vem ANTES de
     qualquer pergunta, porque muda a leitura de tudo o que vem depois — uma
     modalidade pode estar ausente por não ter sido gravada ou por ter ficado
     do lado perdido do corte, e essas duas coisas não são a mesma. */
  {
    const chk = avisoDeAlvo(null, null);
    if (chk) chk.warnings.forEach(w => main.appendChild(el('div', { class: 'warnbox', html: `<b>Alvo × perfil.</b> ${w}` })));
    if (chk && chk.stnMethodCaveat) main.appendChild(el('div', {
      class: 'note', html: `<b>Alvo declarado fora do STN.</b> Os rótulos das figuras seguem o alvo do arquivo, e ` +
        `as figuras de protocolo subtalâmico (F34, F35, F36) declaram a extrapolação quando abertas.`
    }));
  }

  (d.all || []).filter(p2 => p2 && p2.truncated).forEach(p2 => {
    const t = p2.truncated;
    main.appendChild(el('div', {
      class: 'warnbox', html: `<b>Arquivo recuperado: a exportação foi interrompida.</b> ` +
        `<code>${p2.fileName}</code> termina no meio de um valor — provavelmente a transferência ou a ` +
        `exportação no programador foi cortada. O aplicativo aproveitou o prefixo íntegro: ` +
        `<b>${f(100 - t.pctLost, 2)}% do arquivo</b> foi lido (${(t.bytesLost / 1024).toFixed(0)} kB perdidos no fim). ` +
        (t.droppedIncompleteRecord
          ? `A gravação que estava sendo escrita no instante do corte foi <b>descartada</b> — meia gravação ` +
            `pareceria uma gravação curta legítima e entraria nas análises como se fosse completa. `
          : '') +
        `<b>Uma modalidade ausente aqui pode ter ficado do lado perdido do corte</b>, e não significa que ela ` +
        `não foi registrada. Reexporte o Session Report no programador para ter o arquivo completo.`
    }));
  });

  /* inventário do que veio no arquivo — antes das perguntas, porque é o que
     explica por que algumas delas estão desativadas */
  const mods = [
    ['Survey / espectro', d.montage.length + d.sensingSetup.length + d.signalCheck.length],
    ['sinal bruto no tempo', d.bsTimeDomain.length + d.montageTD.length + (d.electrodeIdentifier || []).length + (d.indefiniteStreaming || []).length],
    ['streaming com estimulação', d.bsLfp.length],
    ['Timeline crônico', Object.keys(d.trend).length],
    ['eventos marcados', d.snapshots.length],
    ['impedâncias', Object.keys(d.impedance || {}).length]
  ];
  main.appendChild(el('div', { class: 'card' }, [
    el('h3', {}, ['O que veio nestes arquivos']),
    el('div', { class: 'body' }, [
      table(['modalidade', 'presente'], mods.map(([k, n]) => [k, n ? `sim (${n})` : '—'])),
      el('div', {
        class: 'note', html: `<b>Por que isto importa.</b> As perguntas abaixo que aparecem desativadas não estão ` +
          `com defeito: o arquivo não traz a modalidade que as responderia. Saber disso agora é o que permite pedir a ` +
          `exportação certa na próxima consulta.`
      })
    ])
  ]));

  ['clinico', 'pesquisa'].forEach(persona => {
    const doGrupo = PERGUNTAS.filter(p => p.persona === persona);
    main.appendChild(el('h3', {
      class: 'qc-title',
      html: persona === 'clinico'
        ? '<b>Perguntas de consultório</b> — um paciente, uma decisão, agora'
        : '<b>Perguntas de bancada</b> — método, incerteza e reprodutibilidade'
    }));
    const grade = el('div', { class: 'triagem' });
    doGrupo.forEach(p => {
      const disponivel = !!p.tem(d);
      const alvo = FIGURES.find(f => f.id === p.fig);
      const card = el('button', {
        class: 'qcard' + (disponivel ? '' : ' na'), type: 'button',
        disabled: disponivel ? null : 'disabled',
        onclick: () => { if (disponivel) irPara(p.aba, p.fig); }
      }, [
        el('b', { text: p.q }),
        el('span', { text: p.ajuda }),
        el('em', { text: disponivel ? `${p.aba} · ${p.fig}${alvo ? ' — ' + alvo.title : ''}` : p.falta })
      ]);
      grade.appendChild(card);
    });
    main.appendChild(grade);
  });
}

/* Leva à aba e abre a figura pedida. É a única forma de navegação cruzada: a
   triagem, os alarmes e a agenda apontam para figuras, e o usuário nunca
   precisa saber em que aba elas moram. */
function irPara(abaId, figId) {
  S.aba = abaId;
  salvarPref('aba', abaId);
  renderTabs();
  renderFigures().then(() => {
    if (!figId) return;
    const det = document.getElementById('fig-' + figId);
    if (!det) return;
    det.open = true;
    if (!_renderizadas.has(figId)) renderFigureAsync(figId);
    if (det.scrollIntoView) det.scrollIntoView({ block: 'start' });
  });
}

/* ------------------------------------------------- alarme de artefato ----
   POR QUE ELE APARECE NO TOPO DE TODA ABA, E NÃO SÓ NA DE QUALIDADE. Um canal
   contaminado por ECG contamina a leitura de onde quer que ela seja feita — o
   espectro da aba Agudo, a série da aba Crônico, o limiar da aba Ponte. Deixar
   o aviso guardado numa aba que o usuário clínico talvez nunca abra seria
   escondê-lo. Aqui ele acompanha o usuário, compacto fora da aba de qualidade
   e completo dentro dela.

   A contabilidade é memoizada porque a varredura roda detecção de picos R sobre
   o sinal bruto e não pode repetir a cada troca de aba. */
let _alarmeCache = null, _alarmeChave = null;
function alarmeDoRegistro() {
  if (!S.files.length) return null;
  const chave = chaveAnalise();
  if (_alarmeCache && _alarmeChave === chave) return _alarmeCache;
  let saida = null;
  try {
    const porArquivo = activeFiles().map(x => C.artifactAlarm(x.parsed, {}));
    /* junta os arquivos do sujeito ativo num alarme só: o usuário quer saber se
       ALGUM canal está comprometido, não abrir seis painéis */
    const alarms = porArquivo.flatMap(a => (a && a.alarms) || []);
    const notChecked = porArquivo.flatMap(a => (a && a.notChecked) || []);
    const nCrit = alarms.filter(a => a.severity === 'critico').length;
    const nAt = alarms.filter(a => a.severity === 'atencao').length;
    saida = {
      ok: porArquivo.some(a => a && a.ok),
      level: nCrit ? 'critico' : nAt ? 'atencao' : 'limpo',
      alarms: alarms.sort((a, b) => {
        const peso = s => s === 'critico' ? 0 : s === 'atencao' ? 1 : 2;
        return peso(a.severity) - peso(b.severity);
      }),
      nCritical: nCrit, nWarning: nAt,
      notChecked, nFiles: porArquivo.length,
      params: (porArquivo[0] || {}).params || {}
    };
  } catch (e) {
    saida = { ok: false, level: 'limpo', alarms: [], notChecked: [], erro: String((e && e.message) || e) };
  }
  _alarmeChave = chave; _alarmeCache = saida;
  return saida;
}

function cartaoAlarme(al, completo) {
  const cls = al.level === 'critico' ? '' : al.level === 'atencao' ? ' atencao' : ' limpo';
  const box = el('section', { class: 'alarme' + cls, role: 'alert' });
  const titulo = al.level === 'critico'
    ? `${al.nCritical} problema(s) que impedem a leitura de um ou mais canais`
    : al.level === 'atencao'
      ? `${al.nWarning} ressalva(s) sobre a qualidade do sinal`
      : 'nenhum artefato detectado nas verificações possíveis';
  box.appendChild(el('h3', { text: '⚠ ' + titulo }));

  /* fora da aba de qualidade mostra só os críticos, com um atalho */
  const mostrar = completo ? al.alarms : al.alarms.filter(a => a.severity === 'critico').slice(0, 3);
  const ul = el('ul');
  mostrar.forEach(a => {
    const vcls = /não interprete/i.test(a.verdict || '') ? 'nao'
      : /ressalva/i.test(a.verdict || '') ? 'ressalva' : 'pode';
    ul.appendChild(el('li', {}, [
      el('span', { class: 'tit', text: `${a.title}${a.channel ? ' — ' + a.channel : ''}` }),
      el('span', { class: 'pl', text: a.plain }),
      a.evidence ? el('span', { class: 'ev', text: a.evidence }) : el('span'),
      el('span', { class: 'vd ' + vcls, text: a.verdict || '—' }),
      completo && a.whatToDo ? el('span', { class: 'ev', text: '→ ' + a.whatToDo }) : el('span')
    ]));
  });
  if (mostrar.length) box.appendChild(ul);

  const restantes = al.alarms.length - mostrar.length;
  const partes = [];
  if (!completo && restantes > 0) partes.push(`${restantes} outro(s) item(ns) na aba Qualidade`);
  if (al.notChecked && al.notChecked.length) {
    partes.push(`<b>${al.notChecked.length} verificação(ões) não foi(ram) possível(is) neste arquivo</b> — ` +
      `ausência de verificação não é ausência de artefato`);
  }
  if (partes.length || !completo) {
    const rod = el('div', { class: 'rodape', html: partes.join(' · ') || '' });
    if (!completo) {
      rod.appendChild(el('br'));
      rod.appendChild(el('button', {
        class: 'btn', text: 'abrir o painel de qualidade',
        onclick: () => irPara('qualidade', 'F17'), style: 'margin-top:7px'
      }));
    }
    box.appendChild(rod);
  }
  if (completo && al.notChecked && al.notChecked.length) {
    box.appendChild(el('div', {
      class: 'rodape', html: '<b>Não verificado neste arquivo:</b> ' +
        al.notChecked.map(x => `${x.check} (${x.whyNot})`).join(' · ')
    }));
  }
  return box;
}

/* ------------------------------------------------------------ relatório ---
   A aba que entrega o produto do usuário clínico: uma página datada, com o que
   o prontuário precisa, e todas as exportações reunidas num lugar só em vez de
   espalhadas pelo painel lateral. */
function painelRelatorio(main, d) {
  const b = exportBundle();
  const p0 = (activeFiles()[0] || {}).parsed;
  if (!p0) { main.appendChild(el('div', { class: 'empty', text: 'nenhum registro carregado' })); return; }

  /* cabeçalho de identificação — pseudonimizado, como em toda a aplicação */
  const perfil = activeProfile();
  const s0 = (b && b.subject) || {};
  main.appendChild(el('div', { class: 'card' }, [
    el('h3', {}, ['Identificação do registro']),
    el('div', { class: 'body' }, [
      table(['campo', 'valor'], [
        ['identificador (hash)', p0.patient.idHash],
        ['diagnóstico declarado', s0.diagnosis || '—'],
        ['dispositivo', `${(p0.device || {}).model || '—'} · fw ${(p0.device || {}).firmware || '—'}`],
        ['data de implante', String((p0.device || {}).implantDate || '—').slice(0, 10)],
        ['perfil de análise', `${perfil.label} · banda ${perfil.primaryBand.label} (${perfil.primaryBand.lo}–${perfil.primaryBand.hi} Hz)`],
        ['sessões carregadas', String(activeFiles().length)],
        ['fuso aplicado', `UTC${offMin() >= 0 ? '+' : '−'}${String(Math.floor(Math.abs(offMin()) / 60)).padStart(2, '0')}:${String(Math.abs(offMin()) % 60).padStart(2, '0')}`],
        ['gerado em', new Date().toLocaleString('pt-BR')]
      ])
    ])
  ]));

  /* leituras em linguagem clínica — as mesmas do modo clínico */
  const leituras = leiturasClinicas();
  if (leituras && leituras.readings && leituras.readings.length) {
    const card = el('div', { class: 'card' }, [el('h3', {}, ['Leitura em linguagem clínica'])]);
    const body = el('div', { class: 'body' });
    if (leituras.semaforo) body.appendChild(el('div', {
      class: 'semaforo ' + (leituras.semaforo.cor || 'cinza'),
      html: `<i></i><div><b>${leituras.semaforo.rotulo}</b><span>${leituras.semaforo.frase}</span></div>`
    }));
    leituras.readings.forEach(l => {
      const nv = el('div', { class: 'leitura ' + (l.nivel || '') });
      nv.appendChild(el('h4', { text: l.titulo }));
      nv.appendChild(el('p', { text: l.frase }));
      if (l.numeros) nv.appendChild(el('span', { class: 'num', text: l.numeros }));
      if (l.parametro) nv.appendChild(el('span', { class: 'par', text: 'parâmetros: ' + l.parametro }));
      if (l.ressalva) nv.appendChild(el('p', { class: 'res', html: '<b>Ressalva.</b> ' + l.ressalva }));
      if (l.figura) nv.appendChild(el('button', {
        class: 'btn', text: `ver ${l.figura}`, style: 'margin-top:6px',
        onclick: () => { const a = ABAS.find(x => (x.figuras || []).includes(l.figura)); irPara(a ? a.id : 'agudo', l.figura); }
      }));
      body.appendChild(nv);
    });
    if (leituras.disclaimer) body.appendChild(el('div', { class: 'note', text: leituras.disclaimer }));
    card.appendChild(body);
    main.appendChild(card);
  }

  /* exportações reunidas */
  main.appendChild(el('div', { class: 'card' }, [
    el('h3', {}, ['Exportar']),
    el('div', { class: 'body' }, [
      el('div', { class: 'note', html: `Toda exportação pode vir com o <b>manifesto de proveniência</b>: hash SHA-256 dos ` +
        `arquivos de origem, versão do software, parâmetros de cada figura e sementes dos procedimentos aleatórios. ` +
        `É o que permite refazer esta análise meses depois e obter os mesmos números.` }),
      exportRow([
        { label: '⤓ Relatório clínico (PDF)', fn: () => gerarPdfNativo() },
        { label: '⤓ Pacote completo (.zip)', fn: () => exportarPacote() },
        { label: '⤓ CSV — métricas agudas', fn: () => exportAcuteCSV() },
        { label: '⤓ CSV — métricas crônicas', fn: () => exportChronicCSV() },
        { label: '⤓ CSV — Timeline bruto', fn: () => exportSession() },
        { label: '⤓ JSON para estatística', fn: () => exportJSON() },
        { label: '⤓ Manifesto de proveniência', fn: () => exportManifest() },
        { label: 'imprimir / PDF do navegador', fn: () => window.print() }
      ])
    ])
  ]));
  void d;
}

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
  const aba = abaAtual();

  /* O alarme de artefato aparece no TOPO de toda aba que consome sinal, e não
     só na aba de qualidade: um canal contaminado por ECG contamina a leitura
     de onde quer que ela seja feita. */
  if (aba.id !== 'inicio') {
    const al = alarmeDoRegistro();
    if (al && al.level !== 'limpo') main.appendChild(cartaoAlarme(al, aba.id === 'qualidade'));
  }

  if (aba.especial === 'triagem') { painelTriagem(main, d); return; }

  const cabec = cabecalhoOrientacao(aba);
  if (cabec) main.appendChild(cabec);

  if (aba.especial === 'relatorio') { painelRelatorio(main, d); return; }

  const figs = figurasDaAba(aba, d);
  if (!figs.length) {
    main.appendChild(el('div', {
      class: 'empty', html: ehClinico()
        ? `O modo <b>clínico</b> não mostra nenhuma figura desta aba para o perfil de doença ativo. ` +
          `Troque para <b>pesquisa</b> no topo da página para ver todas.`
        : 'Nenhuma figura desta aba está disponível.'
    }));
    return;
  }
  const abrir = [];
  figs.forEach(({ fig, ok }) => {
    const det = el('details', { class: 'fig ' + (ok ? 'ready' : 'na'), id: 'fig-' + fig.id });
    /* abre o que dá para ler de imediato: no modo clínico, tudo o que tem dado;
       no de pesquisa, a primeira figura pronta da aba, que é a porta de entrada */
    if (ok && (ehClinico() || abrir.length === 0)) abrir.push(fig);
    det.appendChild(el('summary', {}, [el('header', {}, [
      el('span', { class: 'chev', text: '▸' }),
      el('span', { class: 'id', text: fig.id }),
      el('span', { class: 'ttl' }, [el('b', { text: t(fig.title) }), el('span', { text: fig.sub })]),
      el('span', { class: 'state', text: ok ? t('dados presentes') : t('sem dados') })
    ])]));
    det.appendChild(el('div', { class: 'content', id: 'content-' + fig.id }));
    det.addEventListener('toggle', () => {
      if (det.open && !_renderizadas.has(fig.id)) renderFigureAsync(fig.id);
    });
    main.appendChild(det);
  });
  await proximoQuadro();
  if (Prog.ativo) Prog.expect(abrir.length);
  for (const fig of abrir) {
    if (Prog.ativo) await Prog.step(`figura ${fig.id} — ${fig.title}`);
    else await proximoQuadro();
    const det = document.getElementById('fig-' + fig.id);
    if (det) det.open = true;
    renderFigure(fig.id);
  }
}

/* ------------------------------------------------------- primeiros passos */
function primeiraVisita() { return !lerPrefs().tutorialVisto; }

function cartaoPrimeirosPassos() {
  const c = el('div', { class: 'onboard', id: 'onboard' }, [
    el('h3', { text: 'Primeiros passos' }),
    el('ol', {}, [
      el('li', { html: 'Baixe do programador Percept o <b>Session Report em JSON</b> — não o PDF — e solte o arquivo aqui. Pode soltar vários da mesma pessoa de uma vez.' }),
      el('li', { html: 'A aba <b>Início</b> lista as perguntas que <i>estes</i> arquivos respondem. Escolha a pergunta e o aplicativo leva à figura.' }),
      el('li', { html: 'As abas separam <b>registro agudo</b> (sessão, experimento, denso no espectro) de <b>registro crônico</b> (dias, vida real, denso no tempo). A aba <b>Ponte</b> é onde as duas se encontram — calibração, limiar de aDBS e agenda da próxima sessão.' }),
      el('li', { html: 'No <b>modo clínico</b> cada aba mostra só o essencial, com leitura em linguagem simples. No <b>modo pesquisa</b> aparecem todas as figuras, todos os parâmetros e todas as exportações.' }),
      el('li', { html: 'Cada número vem com o <b>parâmetro que o produziu</b> e a <b>ressalva</b> que ele exige. Quando o dado não sustenta uma conclusão, o texto diz isso em vez de mostrar um valor.' })
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
    renderTabs();
    await renderFigures();
    if (proprio) await Prog.finish('figuras prontas');
  } catch (e) {
    if (proprio) Prog.fail(e);
    throw e;
  }
}

/* Carrega o CSV/TSV de um sinal externo (IMU, EMG, ECG) e reabre a F24. */
async function carregaExterno(file) {
  Prog.begin('Carregando sinal externo').expect(2);
  try {
    await Prog.step(`lendo ${file.name}`);
    const texto = await lerTexto(file);
    await Prog.step('interpretando colunas, tempo e frequência de amostragem');
    const out = await Trabalhador.chamar('parseExternalCsv', [texto, {}]);
    Instrumentacao.registra(`parseExternalCsv ${file.name}`, out.ms, out.ondeRodou);
    S.external = { name: file.name, parsed: out.r };
    await Prog.finish(out.r && out.r.ok ? 'sinal externo pronto' : 'arquivo não reconhecido');
  } catch (e) {
    Prog.fail(e);
    S.external = { name: file.name, parsed: { ok: false, reason: String((e && e.message) || e) } };
  }
  _renderizadas.delete('F24');
  renderFigureAsync('F24');
}

/* Diário de Hauser (Onda 9). O arquivo é lido no próprio navegador, como todo o
   resto — e como ele não carrega identificador, nada precisa ser pseudonimizado
   aqui: o esquema de colunas só tem rótulo de paciente, condição, dia e estado. */
async function carregaDiario(file) {
  Prog.begin('Carregando diário').expect(2);
  try {
    await Prog.step(`lendo ${file.name}`);
    const texto = await lerTexto(file);
    await Prog.step('interpretando colunas, bins e estados');
    const out = await Trabalhador.chamar('parseDiaryCsv', [texto, {}]);
    Instrumentacao.registra(`parseDiaryCsv ${file.name}`, out.ms, out.ondeRodou);
    S.diary = { name: file.name, parsed: out.r };
    await Prog.finish(out.r && out.r.ok ? `diário pronto — ${out.r.nRows} bins` : 'arquivo não reconhecido');
  } catch (e) {
    Prog.fail(e);
    S.diary = { name: file.name, parsed: { ok: false, reason: String((e && e.message) || e) } };
  }
  ['F28', 'F29'].forEach(id => _renderizadas.delete(id));
  renderFigureAsync('F28');
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
  Instrumentacao.limpa();
  Prog.begin(`Carregando ${files.length} arquivo${files.length > 1 ? 's' : ''}`).expect(files.length * 2 + 2);
  try {
    for (const file of files) {
      await Prog.step(`lendo ${file.name}${mb(file.size)}`);
      let texto;
      try { texto = await lerTexto(file); }
      catch (e) { Prog.falhaEtapa(e.message); continue; }
      await Prog.step(`interpretando ${file.name} — JSON e modalidades do Percept`);
      try {
        /* o texto vai inteiro para o trabalhador: JSON.parse e extração saem da
           thread principal, e a interface continua respondendo */
        const out = await Trabalhador.chamar('parsePerceptText', [texto, file.name]);
        Instrumentacao.registra(`parse ${file.name}`, out.ms, out.ondeRodou);
        const parsed = out.r;
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
    const ondeCalcula = Trabalhador.estado === 'indisponível'
      ? `na <b>thread principal</b>${Trabalhador.motivo ? ` (trabalhador indisponível: ${Trabalhador.motivo})` : ''}`
      : 'em um <b>trabalhador de segundo plano</b>, com a interface livre';
    if (rod) rod.innerHTML = `Registro com <b>${nTrend.toLocaleString('pt-BR')}</b> pontos de Timeline e ` +
      `<b>${nBruto.toLocaleString('pt-BR')}</b> amostras de sinal bruto. Todo o cálculo acontece neste navegador, ` +
      `${ondeCalcula} — etapas anunciadas acima estão <b>calculando</b>, não travadas.`;
    await Prog.step('montando painel do registro');
    renderRail();
    renderTabs();
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

/* Versão assíncrona: calcula no trabalhador e AQUECE o mesmo cache que
   `exportBundle()` consulta. Quem chama de dentro de um fluxo assíncrono
   (exportações, relatório, leituras clínicas) usa esta; os pontos síncronos que
   vierem depois acertam o cache e não recalculam nada. */
async function exportBundleAsync() {
  const ps = activeFiles().map(x => x.parsed);
  if (!ps.length) return null;
  const chave = chaveAnalise();
  if (_bundleCache && _bundleChave === chave) return _bundleCache;
  const out = await Trabalhador.chamar('extractMetrics', [ps, offMin(), { profileId: activeProfileId() }]);
  Instrumentacao.registra('extractMetrics', out.ms, out.ondeRodou);
  _bundleCache = out.r; _bundleChave = chave;
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

/* Mesma coisa, com o painel de QC (caro) e as métricas no trabalhador. */
async function leiturasClinicasAsync() {
  const ps = activeFiles().map(x => x.parsed);
  if (!ps.length) return null;
  const chave = chaveAnalise();
  if (_leiturasCache && _leiturasChave === chave) return _leiturasCache;
  const b = await exportBundleAsync();
  const pb = activeProfile().primaryBand;
  let painel = null;
  try {
    const out = await Trabalhador.chamar('qcPanel', [ps, { band: [pb.lo, pb.hi] }]);
    Instrumentacao.registra('qcPanel', out.ms, out.ondeRodou);
    painel = out.r;
  } catch (e) { painel = null; }
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
  const b = await comEtapa('Exportando JSON', 'calculando métricas de todas as sessões', exportBundleAsync);
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
  const b = await comEtapa('Exportando CSV de métricas agudas', 'calculando espectro, aperiódico e bursts por sessão', exportBundleAsync);
  if (!b) return alert('Carregue ao menos um arquivo antes de exportar.');
  if (!b.acute.length) return alert('Nenhuma métrica aguda (espectro ou sinal bruto) nos arquivos carregados.');
  P.downloadText(P.toCSV(b.acute, unionKeys(b.acute)), `percept_${b.subject.id}_metricas_agudas.csv`, 'text/csv');
}
async function exportChronicCSV() {
  if (!S.files.length) return alert('Carregue ao menos um arquivo antes de exportar.');
  const b = await comEtapa('Exportando CSV de métricas crônicas', 'ajustando cosinor e limiares sobre o Timeline', exportBundleAsync);
  if (!b) return alert('Carregue ao menos um arquivo antes de exportar.');
  if (!b.chronic.length) return alert('Nenhum dado de Timeline (crônico) nos arquivos carregados.');
  P.downloadText(P.toCSV(b.chronic, unionKeys(b.chronic)), `percept_${b.subject.id}_metricas_cronicas.csv`, 'text/csv');
}

/* ------------------------------------------ pacote único (Onda 6) --------
   Um ZIP com tudo o que a análise produziu: métricas, sinal em EDF, estrutura
   BIDS-like, manifesto de proveniência com hash, checklist e as figuras em PNG.
   O ZIP é escrito sem compressão (método "store"), porque comprimir exigiria
   deflate — e a dependência zero vale também aqui. */
async function exportarPacote() {
  if (!S.files.length) return alert('Carregue ao menos um arquivo antes de exportar o pacote.');
  const ps = activeFiles().map(x => x.parsed);
  Prog.begin('Montando o pacote completo').expect(7);
  const arquivos = [];
  const texto = (nome, conteudo) => arquivos.push({ name: nome, data: conteudo });
  try {
    await Prog.step('calculando as métricas');
    const b = await exportBundleAsync();
    if (b) {
      texto('metricas/percept_metricas.json', JSON.stringify({
        export: { tool: 'Percept LFP Studio', generated_at: new Date().toISOString(), timezone_offset_min: offMin() },
        subject: b.subject, sessions: b.sessions, acute: b.acute, chronic: b.chronic
      }, null, 2));
      if (b.acute.length) texto('metricas/metricas_agudas.csv', P.toCSV(b.acute, unionKeys(b.acute)));
      if (b.chronic.length) texto('metricas/metricas_cronicas.csv', P.toCSV(b.chronic, unionKeys(b.chronic)));
    }

    await Prog.step('escrevendo o Timeline em formato longo');
    const dd = ds();
    const linhas = [];
    Object.keys(dd.trend).forEach(h => dd.trend[h].forEach(r => linhas.push({
      hemisferio: h, utc: new Date(r.t).toISOString(),
      hora_local_decimal: +C.localHour(r.t, offMin()).toFixed(4),
      dia_local: C.localDayKey(r.t, offMin()), lfp: r.lfp, mA: r.ma
    })));
    if (linhas.length) texto('metricas/timeline_longo.csv', P.toCSV(linhas));

    await Prog.step('convertendo o sinal bruto para EDF');
    const tds = dd.bsTimeDomain.concat(dd.montageTD);
    if (tds.length) {
      const sinais = tds.map(td => ({
        label: td.label, data: td.data, fs: td.fsEff || td.fs, unit: 'uV',
        prefilter: 'passa-alta do dispositivo (nao exposta no Session Report)'
      }));
      const edf = C.writeEdf(sinais, {
        startMs: isFinite(td0Ms(tds[0])) ? td0Ms(tds[0]) : Date.now(),
        patientId: (b && b.subject.id) || 'sub-x'
      });
      if (edf) {
        arquivos.push({ name: 'sinal/percept.edf', data: edf.bytes });
        texto('sinal/percept_edf_metadados.json', JSON.stringify(edf.meta, null, 2));
      }
    }

    await Prog.step('montando a estrutura BIDS-like');
    const bids = C.buildBidsLike(ps, { includeSignalTsv: false, appVersion: '0.6.0' });
    (bids || []).forEach(a => texto('bids/' + a.path, a.content));

    await Prog.step('reunindo a proveniência e o hash citável');
    const prov = await buildProvenance();
    const man = prov.manifest();
    man.manifestHash = await prov.hash();
    texto('proveniencia/manifesto.json', JSON.stringify(man, null, 2));
    try {
      const ck = C.generateChecklist(man, b, activeProfile());
      texto('proveniencia/PERCEPT-REPORT.md', ck.markdown);
    } catch (e) { Prog.falhaEtapa(String(e && e.message || e)); }

    await Prog.step('desenhando e exportando as figuras');
    await renderAllReady();
    const d2 = ds();
    figurasVisiveis().forEach(fig => {
      if (!fig.has(d2)) return;
      const no = document.getElementById('content-' + fig.id);
      const cvs = no ? Array.from(no.querySelectorAll('canvas')) : [];
      cvs.forEach((cv, j) => {
        try {
          const url = cv.toDataURL('image/png');
          const bin = atob(url.split(',')[1]);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          arquivos.push({ name: `figuras/${fig.id}${cvs.length > 1 ? '_' + (j + 1) : ''}.png`, data: bytes });
        } catch (e) { /* canvas vazio ou bloqueado: segue sem essa figura */ }
      });
    });

    await Prog.step('fechando o ZIP');
    texto('LEIA-ME.txt',
      'PACOTE DE ANÁLISE — Percept LFP Studio\n' +
      '=====================================\n\n' +
      `Gerado em ${new Date().toISOString()}\n` +
      `Registro: ${(b && b.subject.id) || '—'} · perfil: ${activeProfile().label}\n` +
      `Fuso aplicado: UTC${offMin() >= 0 ? '+' : '−'}${String(Math.floor(Math.abs(offMin()) / 60)).padStart(2, '0')}:${String(Math.abs(offMin()) % 60).padStart(2, '0')}\n\n` +
      'metricas/     métricas por sessão e por hemisfério, em CSV e JSON\n' +
      'sinal/        sinal bruto em EDF+ e os metadados da conversão\n' +
      'bids/         estrutura BIDS-like (NÃO é um dataset BIDS conforme — ver dataset_description.json)\n' +
      'proveniencia/ manifesto com todos os parâmetros efetivos, hash citável e checklist PERCEPT-REPORT\n' +
      'figuras/      cada gráfico em PNG\n\n' +
      'AMOSTRAS AUSENTES: a perda de pacote é preservada como NaN em todo o pipeline. No EDF, que não tem\n' +
      'representação para dado ausente, essas amostras foram escritas no mínimo digital e a lista de lacunas\n' +
      'está em sinal/percept_edf_metadados.json. Remascare antes de qualquer análise.\n\n' +
      'Ferramenta de pesquisa e apoio à decisão. Não substitui o julgamento clínico nem o software regulado\n' +
      'do fabricante.\n');
    const zip = C.makeZip(arquivos);
    const blob = new Blob([zip], { type: 'application/zip' });
    const a = document.createElement('a');
    a.download = `percept_pacote_${(b && b.subject.id) || 'analise'}.zip`;
    a.href = URL.createObjectURL(blob); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
    await Prog.finish(`pacote com ${arquivos.length} arquivos`);
  } catch (e) { Prog.fail(e); }
}
function td0Ms(td) {
  if (!td) return NaN;
  if (isFinite(td.firstPacketMs)) return td.firstPacketMs;
  if (td.firstPacketDateTime) return Date.parse(td.firstPacketDateTime);
  if (isFinite(td.t0)) return td.t0;
  return NaN;
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
  const inst = Instrumentacao.resumo();
  const prov = C.createProvenance({
    appVersion: '0.6.0',
    now: new Date().toISOString(),
    profileId: perfil.id, profileLabel: perfil.label,
    timezoneOffsetMin: offMin(),
    timezoneBreaks: []
  });
  /* instrumentação: onde cada passo pesado foi calculado e quanto levou.
     Não é enfeite — é o que permite dizer, meses depois, que o número saiu de
     um cálculo completo e não de um caminho degradado. */
  prov.record('runtime.instrumentation', {
    workerState: inst.workerState,
    workerUnavailableReason: inst.workerReason,
    stepsInWorker: inst.nInWorker, stepsTotal: inst.nSteps,
    totalComputeMs: inst.totalMs,
    steps: inst.steps
  }, { note: 'tempos medidos nesta sessão do navegador; não afetam os valores, apenas os documentam' });
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
      /* itens do PERCEPT-REPORT que o white paper resolve — ver
         docs/auditoria-whitepaper.md (B1, B4) */
      const flt = p.filters || null;
      prov.record('parse.timeDomain', {
        channel: td.label, fsNominal: td.fs,
        fsEffective: isFinite(td.fsEff) ? +td.fsEff.toFixed(4) : null,
        driftMsTotal: td.timing && isFinite(td.timing.driftMsTotal) ? +td.timing.driftMsTotal.toFixed(2) : null,
        /* B1/B4 — o valor está no JSON, em Groups → GroupSettings */
        hardwareFilters: flt ? flt.description : C.hardwareFilterDescription(NaN),
        highPassConfigurableHz: flt && isFinite(flt.highPassConfigurableHz) ? flt.highPassConfigurableHz : null,
        blankingUs: flt && isFinite(flt.senseBlankingUs) ? flt.senseBlankingUs : null,
        blankingSource: flt ? flt.senseBlankingSource : null,
        lowBandUsable: flt ? flt.lowBandUsable : null
      }, { nIn: est.n, nOut: est.nValid, nDropped: est.nNan, dropReason: 'perda de pacotes (NaN)' });
      const pk = td.packets || {};
      prov.record('io.analyzePackets', {
        method: pk.method, reliable: pk.reliable,
        pctMissing: isFinite(pk.pctMissing) ? +pk.pctMissing.toFixed(3) : null,
        nGaps: (pk.gaps || []).length, policy: 'NaN, sem interpolação nem concatenação',
        /* A2/A3/E2 — por que este método, e com que critério */
        stream: pk.stream, interleavedSequences: pk.interleavedSequences,
        sequenceCap: pk.sequenceCap, deviceModel: pk.deviceModel,
        gapCriterion: pk.gapCriterion, ticksNote: pk.ticksNote,
        whySequencesUnused: pk.whySequencesUnused
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

  /* --- conformidade declarada com o white paper do fabricante ----------- */
  {
    const p0f = d.all[0] || {};
    const flt0 = p0f.filters || null;
    const cens = C.censoringSummary(d.all);
    prov.record('whitepaper.compliance', {
      document: 'Medtronic UC202012929cEN, Percept (PC and RC) Neurostimulators with BrainSense Technology — ' +
        'DBS Sensing White Paper, FY24',
      itemsFollowed: [
        'A1 valor negativo do Timeline e do FFTBinData tratado como CENSURA (p. 24, 25), com contabilidade separada da perda de pacote',
        'A2 cap de volta de GlobalSequences por modelo: 255 no Percept PC, 65 535 no RC (p. 21–24)',
        'A3 sequências de BrainSenseTimeDomain e BrainSenseLfp são intercaladas; nesses fluxos o método é por ticks (p. 23, 24)',
        'A4 volta de TicksInMses em 65 536 × 50 ms, e ausência de volta durante streaming (p. 24)',
        'A5 estado da estimulação por modalidade, com CalibrationTests em ON e SenseChannelTests em OFF (p. 15)',
        'A6 FirstPacketDateTime com resolução de 1 s: piso de incerteza de ±1000 ms no alinhamento por carimbo (p. 21–24)',
        'B1 cadeia de filtros: 2× passa-baixa 100 Hz, passa-alta 1 Hz fixo, segundo passa-alta 1 ou 10 Hz (p. 11)',
        'B2 largura da banda de potência de aproximadamente 5 Hz (p. 6, 7)',
        'B3 potência do Timeline = soma do quadrado da magnitude na banda, ≈ AUC (p. 21, 24)',
        'B4 blanking e passa-alta lidos de Groups → GroupSettings (p. 26)',
        'B5 FullyReadForSession distingue ausência de registro de ausência de leitura (p. 18)',
        'C1 IndefiniteStreaming (Record Streaming) parseado: 3 canais por lead, estimulação desligada (p. 16, 23)',
        'C2 Thresholds (domínio de potência) parseado (p. 16, 21)',
        'D2 limiares de impedância do fabricante: curto < 250 Ω (1x4) ou < 350 Ω (SenSight), aberto > 10 kΩ (p. 4)',
        'D3 o snapshot de evento cobre os 30 s DEPOIS do botão, e não tem domínio do tempo (p. 8)',
        'D4 protocolo de sincronização com marcador de baixa frequência no início E no fim (p. 12)',
        'D5 capacidades por modelo e sobrescrita do dia mais antigo (p. 7, 8)',
        'D6 a potência de 2 Hz é média única, não sobreposta (p. 9)',
        'D7 Survey: ~20 s por canal, bins de 0,98 Hz com centros de 0 a 96,68 Hz (p. 4)',
        'D8 critério do aparelho para escolher a banda: maior pico em beta ou gama acima de 1,1 µVp (p. 6)',
        'E2 critério de descontinuidade do pseudocódigo do fabricante (p. 28), com a unidade corrigida'
      ],
      notInDocument: [
        'a constante de ganho 1/54 da emulação do PSD de bordo não aparece neste white paper — busca feita e registrada',
        'a largura EXATA da banda integrada por registro não é declarada no JSON'
      ],
      deviceModel: (p0f.device && p0f.device.model) || null,
      deviceModelNumber: (p0f.device && p0f.device.modelNumber) || null,
      deviceStateSource: 'tabela documentada modalidade → estado (UC202012929cEN, p. 4, 10, 15, 17)',
      hardwareFilters: flt0 ? flt0.description : null,
      highPassConfigurableHz: flt0 && isFinite(flt0.highPassConfigurableHz) ? flt0.highPassConfigurableHz : null,
      fullyReadForSession: p0f.meta ? p0f.meta.fullyRead : null,
      timelineCensoredPct: cens.ok ? cens.pctCensored : null,
      auditDoc: 'docs/auditoria-whitepaper.md'
    });
  }

  /* --- Onda 12: features por janela, com os parâmetros EFETIVOS --------- */
  const brutosProv = d.bsTimeDomain.length ? d.bsTimeDomain : d.montageTD;
  if (brutosProv.length) {
    const o34 = S.opts.F34 || {};
    const janelaP = o34.win || 10, sobrepP = o34.ov || 0;
    const hemisP = {};
    brutosProv.forEach(td => {
      if (!hemisP[td.hemisphere] && td.data && td.data.length) hemisP[td.hemisphere] = {
        x: td.data, fs: td.fsEff || td.fs, t0: td.t0, record: td, label: td.label
      };
    });
    const odrP = C.odrSeries({ hemispheres: hemisP, parsed: d.all[0] }, {
      windowS: janelaP, overlap: sobrepP,
      formulation: o34.form || 'log', gammaSource: o34.gamma || 'peak',
      entrainToleranceHz: o34.tol || 2.5, allowWithoutGamma: !!o34.nogamma
    });
    const lado0 = odrP.ok ? odrP.byHemisphere[odrP.hemispheres[0]] : null;
    const gP = lado0 ? lado0.gamma : null;
    prov.record('metrics.odr', {
      windowS: janelaP, overlap: sobrepP,
      bands: { theta: [4, 8], lowBeta: [12, 20] },
      gammaSearch: (C.ODR_BANDS && [60, 90]), gammaHalfWidthHz: 2.5,
      gammaSource: lado0 ? lado0.gammaSource : (o34.gamma || 'peak'),
      gammaPeakHz: gP && isFinite(gP.peakHz) ? gP.peakHz : NaN,
      gammaBroad: '60–90',
      formulation: odrP.ok ? odrP.formulationUsed : (o34.form || 'log'),
      spearmanLogVsLiteral: odrP.ok ? odrP.spearmanLogVsLiteral : NaN,
      literalEscapeFraction: odrP.ok ? odrP.literalEscapeFraction : NaN,
      zPolicy: 'z-score de cada banda ao longo do registro inteiro; na formulação log, sobre log10 da potência',
      entrainToleranceHz: o34.tol || 2.5,
      entrainmentChecked: lado0 ? !!lado0.entrainmentChecked : false,
      subharmonicHz: gP && gP.subharmonicHz != null ? gP.subharmonicHz : null,
      entrainedDominant: gP ? !!gP.entrainedDominant : null,
      deviceState: lado0 && lado0.deviceState
        ? `${lado0.deviceState.state} (${lado0.deviceState.amplitudeMa} mA, ${lado0.deviceState.rateHz} Hz; confiança ${lado0.deviceState.confidence})`
        : null,
      refused: !odrP.ok, refusalReason: odrP.ok ? null : odrP.reason
    }, { figure: 'F34', nIn: brutosProv.length, nOut: odrP.ok ? odrP.nValidWindows : 0 });

    prov.record('dsp.spectralVariation', {
      bands: { theta: [4, 8], lowBeta: [12, 20], gammaPeak: lado0 ? lado0.gammaBand : null },
      windowS: janelaP, overlap: sobrepP,
      edgePolicy: 'filtro e envelope sobre o registro inteiro, fatiados depois — sem transiente de borda por janela',
      envelope: 'Hilbert', minMeanFrac: 0.02,
      windowNote: 'o CV cresce com o comprimento da janela; comparar CVs de janelas diferentes é erro'
    }, { figure: 'F34' });

    if (hemisP.Left && hemisP.Right) {
      const cP = C.interSTNCoherence(hemisP.Left, hemisP.Right, {
        windowS: janelaP, overlap: sobrepP, gammaBand: lado0 ? lado0.gammaBand : null
      });
      const w0 = cP.ok ? cP.windows.find(w => isFinite(w.expectedNullCoherence)) : null;
      const lb = cP.ok ? cP.byBand.lowBeta : null;
      prov.record('dsp.windowedCoherence', {
        windowS: janelaP, overlap: sobrepP,
        nperseg: cP.ok ? cP.coherenceParams.nperseg : null,
        alpha: cP.ok ? cP.coherenceParams.alpha : 0.05,
        nSegmentsEffective: w0 ? w0.nSegmentsEffective : null,
        expectedNullCoherence: w0 ? w0.expectedNullCoherence : null,
        thresholdPerBin: w0 ? w0.thresholdPerBin : null,
        thresholdBandCorrected: w0 && w0.byBand.lowBeta ? w0.byBand.lowBeta.threshold : null,
        correction: 'Šidák sobre o número de bins da banda',
        nVolumeConductionSuspected: lb ? lb.nVolumeConductionSuspected : null,
        sharedCardiacDetected: cP.ok ? !!(cP.confounders.sharedCardiac || {}).detected : null,
        pairingOk: cP.ok, pairingReason: cP.ok ? null : cP.reason
      }, { figure: 'F34' });
    }
  }

  /* ---- MRDS: só entra na proveniência se houver atribuição DECLARADA -----
     Nenhum item do bloco MRDS é derivável do arquivo. Se ninguém declarou
     quais épocas são repouso e quais são movimento, o passo não existe, e o
     checklist mostra os itens como não verificáveis — que é a resposta certa,
     e melhor do que um valor plausível vindo de palpite.                   */
  {
    const o35 = S.opts.F35 || {};
    const regsP = d.indefiniteStreaming.concat(d.bsTimeDomain, d.montageTD);
    const unidadesP = [];
    if (o35.modo === 'janelas' && regsP.length) {
      const r = regsP[Math.min(o35.reg || 0, regsP.length - 1)];
      const jan = o35.janelas || {};
      const u = { id: r.hemisphere || 'unidade', subject: sujeitoAtual() || 'sujeito', hemisphere: r.hemisphere || '?', cells: {}, fs: r.fs };
      C.MRDS_CELLS.forEach(c => {
        const v = jan[c.key] || [0, 0];
        const a = Math.max(0, Math.round(v[0] * r.fs)), b2 = Math.min(r.data.length, Math.round(v[1] * r.fs));
        if (b2 - a >= r.fs * (o35.win || 4)) u.cells[c.key] = r.data.slice(a, b2);
      });
      if (u.cells.rest_baseline && u.cells.move_baseline) unidadesP.push(u);
    } else if (o35.atrib && Object.keys(o35.atrib).length) {
      const porH = {};
      regsP.forEach((r, i) => {
        const cel = o35.atrib[i];
        if (!cel) return;
        const h = r.hemisphere || '?';
        porH[h] = porH[h] || { id: h, subject: sujeitoAtual() || 'sujeito', hemisphere: h, cells: {}, fs: r.fs };
        porH[h].cells[cel] = r.data;
      });
      Object.keys(porH).forEach(h => { if (porH[h].cells.rest_baseline && porH[h].cells.move_baseline) unidadesP.push(porH[h]); });
    }
    if (unidadesP.length) {
      const mres = C.mrdsDesign(unidadesP, {
        zscoreScope: o35.z || 'session',
        windowSamples: Math.round((o35.win || 4) * (unidadesP[0].fs || 250)),
        exactNfft: o35.nfft !== false, relativeFloor: (o35.piso || 5) / 100
      });
      const u0 = mres.units[0];
      const par0 = u0.baseline || u0.post;
      const t0 = mres.tests[(mres.bands[0] || {}).key] || {};
      const larga = mres.units.filter(u => {
        const v = (u.baseline && u.baseline.verdict) || {};
        return v.ok && v.broadband && !v.bandSpecific.length;
      }).length;
      prov.record('metrics.mrds', {
        formula: 'MRDS_x = (P_movimento_x − P_repouso_x) / P_repouso_x',
        secondLevel: 'ΔMRDS = MRDS(pós) − MRDS(basal)',
        protocol: C.MRDS_PROTOCOL.source,
        assignmentMode: o35.modo === 'janelas' ? 'janelas dentro de uma gravação' : 'gravações separadas',
        assignmentSource: 'declarada por quem analisa — o JSON do Percept não carrega rótulo de tarefa',
        cellsDeclared: unidadesP.reduce((a, u) => a + Object.keys(u.cells).length, 0),
        nUnits: mres.nUnits, nSubjects: mres.nSubjects,
        zscoreScope: mres.zscoreScope,
        zscoreConsequence: u0.normalization.note,
        unit: mres.unit,
        windowSamples: (u0.psd.rest_baseline || u0.psd.rest_post || {}).windowSamples,
        overlap: (u0.psd.rest_baseline || u0.psd.rest_post || {}).overlap,
        nfft: par0 ? par0.nfft : null,
        resolutionHz: par0 ? +par0.df.toFixed(4) : null,
        bands: C.MRDS_BANDS.map(b => `${b.key} ${b.lo}–${b.hi} Hz`).join(', '),
        hasBothMoments: mres.hasBothMoments,
        relativeFloor: (o35.piso || 5) / 100,
        nBroadbandOnly: larga,
        varianceRatio: par0 && isFinite(par0.varianceRatio) ? +par0.varianceRatio.toFixed(5) : null,
        pairedTest: isFinite(t0.p) ? 'permutação pareada exata por troca de sinal (enumerada)' : null,
        pairedP: isFinite(t0.p) ? t0.p : NaN,
        pairedPtTest: t0.tTest && isFinite(t0.tTest.p) ? +t0.tTest.p.toFixed(5) : NaN,
        minAchievableP: isFinite(t0.minAchievableP) ? t0.minAchievableP : NaN,
        testsDisagree: !!t0.testsDisagree,
        deviceCaveat: C.HARDWARE_FILTERS.gammaCaveat,
        limitations: C.MRDS_LIMITACOES
      }, { figure: 'F35', nIn: regsP.length, nOut: mres.nUnits });
    }
  }
  return prov;
}

async function exportChecklist(formato) {
  if (!S.files.length) return alert('Carregue ao menos um arquivo antes de gerar o checklist.');
  Prog.begin('Gerando checklist PERCEPT-REPORT').expect(3);
  await Prog.step('reunindo a proveniência da análise');
  const prov = await buildProvenance();
  await Prog.step('calculando as métricas do registro');
  const b = await exportBundleAsync();
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
/* ------------------------------------- relatório em PDF NATIVO (Onda 8.2) --
   O `window.print()` produzia um arquivo diferente conforme o navegador, a
   impressora virtual e as margens configuradas. Aqui o PDF é escrito byte a
   byte pelo próprio software: o mesmo registro gera o mesmo arquivo sempre. */
async function gerarPdfNativo() {
  if (!S.files.length) return alert('Carregue ao menos um Session Report antes de gerar o relatório.');
  Prog.begin('Gerando PDF');
  try {
    await renderAllReady();
    Prog.expect(3);
    await Prog.step('calculando as métricas e as leituras');
    const b = await exportBundleAsync();
    let leituras = null;
    try { leituras = await leiturasClinicasAsync(); } catch (e) { Prog.falhaEtapa(String(e && e.message || e)); }

    await Prog.step('montando o documento');
    const perfil = activeProfile();
    const s0 = b ? b.subject : {};
    const off = offMin();
    const blocos = [];
    blocos.push({
      type: 'kv', rows: [
        ['identificador', s0.id], ['diagnóstico', s0.diagnosis],
        ['dispositivo', `${s0.device_model || '—'} · fw ${s0.firmware || '—'}`],
        ['data de implante', s0.implant_date],
        ['alvos', (s0.targets || []).map(x => `${(x.hemisphere || '')[0]}:${x.target}`).join('  ')],
        ['perfil de doença', `${perfil.label} · banda primária ${perfil.primaryBand.label} (${perfil.primaryBand.lo}–${perfil.primaryBand.hi} Hz)`],
        ['fuso aplicado', `UTC${off >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`],
        ['sessões', String((b && b.sessions.length) || 0)]
      ]
    });
    if (leituras) {
      blocos.push({ type: 'h1', text: 'Leitura em linguagem clínica' });
      const sf = leituras.semaforo;
      blocos.push({ type: 'p', text: `Qualidade do sinal — ${sf.rotulo}. ${sf.frase}` });
      leituras.readings.forEach(l => {
        blocos.push({ type: 'h2', text: l.titulo });
        blocos.push({ type: 'p', text: l.frase });
        if (l.numeros) blocos.push({ type: 'note', text: l.numeros });
        if (l.parametro) blocos.push({ type: 'note', text: 'parâmetros usados: ' + l.parametro });
        if (l.ressalva) blocos.push({ type: 'note', text: 'Ressalva. ' + l.ressalva });
      });
      blocos.push({ type: 'note', text: leituras.disclaimer });
    }
    if (b && b.acute.length) {
      blocos.push({ type: 'h1', text: 'Métricas agudas — por sessão e hemisfério' });
      blocos.push({
        type: 'table',
        cols: ['hemisfério', 'sessão', 'd. impl.', 'pico (Hz)', 'pico?', 'aperiódico', 'burst/s', 'dur. (ms)'],
        widths: [0.13, 0.16, 0.09, 0.12, 0.09, 0.14, 0.12, 0.15],
        rows: b.acute.map(r => [hname(r.hemisphere), r.session_date_local || '—', r.days_since_implant,
          r.beta_peak_hz, r.has_beta_peak ? 'sim' : 'não', r.aperiodic_exponent, r.burst_rate_hz, r.burst_mean_ms])
      });
    }
    if (b && b.chronic.length) {
      blocos.push({ type: 'h1', text: 'Métricas crônicas (Timeline) — por hemisfério' });
      blocos.push({
        type: 'table',
        cols: ['hemisfério', 'dias (n)', 'MESOR', 'amp. 24 h', 'acrofase', 'p*', '<lim %', 'entre %', '>lim %'],
        widths: [0.13, 0.13, 0.11, 0.12, 0.11, 0.12, 0.09, 0.1, 0.09],
        rows: b.chronic.map(r => [hname(r.hemisphere), `${r.n_days} (${r.n_points})`, r.mesor, r.amp_24h,
          isFinite(r.acrophase_24h) ? r.acrophase_24h + ' h' : '—',
          isFinite(r.cosinor_p_adj_ar1) ? (r.cosinor_p_adj_ar1 < 0.001 ? '<0,001' : r.cosinor_p_adj_ar1.toFixed(3)) : '—',
          r.pct_below, r.pct_between, r.pct_above])
      });
    }
    blocos.push({
      type: 'note',
      text: 'Ferramenta de pesquisa e apoio à decisão. Não substitui o julgamento clínico nem o software regulado ' +
        'do fabricante. Todos os parâmetros efetivos desta análise estão no manifesto de proveniência.'
    });

    /* figuras: o canvas já entrega JPEG, que entra no PDF sem recodificação */
    const d2 = ds();
    const figs = [];
    figurasVisiveis().forEach(fig => {
      if (!fig.has(d2)) return;
      const no = document.getElementById('content-' + fig.id);
      const cvs = no ? Array.from(no.querySelectorAll('canvas')) : [];
      cvs.forEach((cv, j) => {
        try {
          figs.push({
            id: fig.id + (cvs.length > 1 ? ` (${j + 1}/${cvs.length})` : ''),
            title: fig.title, dataUrl: cv.toDataURL('image/jpeg', 0.9),
            width: cv.width, height: cv.height,
            caption: j === 0 ? fig.sub : ''
          });
        } catch (e) { /* canvas vazio: segue */ }
      });
    });

    await Prog.step(`escrevendo o PDF (${figs.length} figuras)`);
    const pdf = C.buildPdf({
      title: 'Relatório de análise de LFP subtalâmico',
      subtitle: `Percept LFP Studio · registro ${s0.id || '—'} · gerado em ${new Date().toLocaleString('pt-BR')}`,
      footer: 'Percept LFP Studio — ferramenta de pesquisa e apoio à decisão',
      blocks: blocos, figures: figs
    });
    const blob = new Blob([pdf.bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.download = `relatorio_${s0.id || 'analise'}.pdf`;
    a.href = URL.createObjectURL(blob); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
    await Prog.finish(`PDF com ${pdf.meta.pages} páginas`);
    return pdf.meta;
  } catch (e) { Prog.fail(e); }
}

async function generateReport() {
  if (!S.files.length) return alert('Carregue ao menos um Session Report antes de gerar o relatório.');
  Prog.begin('Gerando relatório PDF');
  await renderAllReady();
  Prog.expect(3);
  await Prog.step('calculando o resumo de métricas da capa');
  const bundle = await exportBundleAsync();
  await Prog.step('escrevendo as leituras em linguagem clínica');
  try { await leiturasClinicasAsync(); } catch (e) { Prog.falhaEtapa(String(e && e.message || e)); }
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
  if (prefs.idioma) S.lang = C.setLanguage(prefs.idioma);
  /* a aba volta como o usuário deixou, mas nunca numa aba de figura antes de
     haver arquivo: sem dado, a única aba com o que mostrar é a de triagem */
  if (prefs.aba && ABAS.some(a => a.id === prefs.aba)) S.aba = prefs.aba;
  aplicarAparencia();
  /* tema `auto` acompanha o sistema em tempo real: quem troca o modo escuro do
     SO no meio da sessão não precisa recarregar */
  try {
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    if (mq && mq.addEventListener) mq.addEventListener('change', () => { if (aparenciaAtual().tema === 'auto') aplicarAparencia(); });
  } catch (e) { /* sem matchMedia: fica no tema claro */ }
  const liga = (id, attr, fn) => {
    const g = document.getElementById(id);
    if (!g) return;
    g.addEventListener('click', ev => {
      const b = ev.target && ev.target.closest ? ev.target.closest('button') : null;
      if (!b || !b.getAttribute(attr)) return;
      fn(b.getAttribute(attr));
    });
  };
  liga('segTema', 'data-tema', setTema);
  liga('segMaterial', 'data-material', setMaterial);
  /* a altura do cromo muda com a largura da janela (ferramentas quebram), com
     a troca de idioma (rótulos mudam de comprimento) e com a condensação ao
     rolar: medir uma vez não basta */
  medirCromo();
  /* Condensação: um único limiar, com histerese, para a barra não piscar em
     torno do ponto de corte quando o dedo hesita no trackpad. */
  {
    const c = document.getElementById('chrome');
    let densa = false, agendado = false;
    const avaliar = () => {
      agendado = false;
      if (!c || !c.classList) return;
      const y = window.pageYOffset || (document.documentElement && document.documentElement.scrollTop) || 0;
      const alvo = densa ? y > 24 : y > 56;
      if (alvo === densa) return;
      densa = alvo;
      c.classList[densa ? 'add' : 'remove']('densa');
      medirCromo();
    };
    window.addEventListener('scroll', () => {
      if (agendado) return;
      agendado = true;
      (window.requestAnimationFrame || setTimeout)(avaliar, 16);
    }, { passive: true });
  }
  try {
    if (typeof ResizeObserver === 'function') new ResizeObserver(medirCromo).observe(document.getElementById('chrome'));
    else window.addEventListener('resize', medirCromo);
  } catch (e) { window.addEventListener('resize', medirCromo); }
  /* o popover fecha ao clicar fora — comportamento esperado de menu */
  document.addEventListener('click', ev => {
    const p = document.getElementById('popAparencia');
    if (p && p.open && p.contains && !p.contains(ev.target)) p.open = false;
  });

  marcarModo();
  renderTabs();
  aplicarIdiomaMoldura();
  const si = document.getElementById('idioma');
  if (si) si.addEventListener('change', e => setIdioma(e.target.value));

  /* Robustez: erro não tratado em qualquer lugar aparece no painel de processo
     em vez de sumir no console. Falha visível é corrigível; falha silenciosa
     vira "o programa não fez nada". */
  window.addEventListener('error', ev => {
    if (!ev || !ev.message) return;
    Prog.begin('Erro inesperado').expect(1);
    Prog.rotulo = String(ev.message);
    Prog.fail(new Error(`${ev.message}${ev.filename ? ' (' + String(ev.filename).split('/').pop() + ':' + ev.lineno + ')' : ''}`));
  });
  window.addEventListener('unhandledrejection', ev => {
    const m = ev && ev.reason ? (ev.reason.message || String(ev.reason)) : 'promessa rejeitada';
    Prog.begin('Erro inesperado').expect(1);
    Prog.rotulo = m;
    Prog.fail(new Error(m));
  });
  $('#fileInput').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });
  $('#btnExport').addEventListener('click', exportSession);
  $('#btnPrint').addEventListener('click', generateReport);
  $('#tz').addEventListener('change', e => {
    S.tzOverride = e.target.value === 'auto' ? null : parseInt(e.target.value, 10);
    renderAll('Aplicando fuso horário');
  });
  const bp = document.getElementById('btnPasta');
  const di = document.getElementById('dirInput');
  if (bp && di) {
    bp.addEventListener('click', () => di.click());
    di.addEventListener('change', e => { const fs = Array.from(e.target.files || []); e.target.value = ''; handleFiles(fs); });
  }
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
window.__PLS__ = { FIGURES, ABAS, setAba, aplicarAparencia, medirCromo, aparenciaAtual, setTema, setMaterial, TEMAS, MATERIAIS, abaAtual, irPara, renderTabs, figurasDaAba, painelTriagem, alarmeDoRegistro, PERGUNTAS, buildProvenance, carregaExterno, carregaDiario, painelMatriz, csvEspectrograma, metaEspectrograma, calculaEspectrograma, exportarPacote, gerarPdfNativo, setIdioma, ds, invalidarDs, S, renderRail, renderFigure, renderFigureAsync, renderAllReady, handleFiles, offMin, exportBundle, exportBundleAsync, buildReportCover, Prog, proximoQuadro, setModo, modoAtual, figurasVisiveis, leiturasClinicas, leiturasClinicasAsync, PIPELINES, rodarPipeline, preencherSemaforo, inserirLeituras, Trabalhador, Instrumentacao };
})();
