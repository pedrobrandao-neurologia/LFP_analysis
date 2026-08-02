/* Gera o index.html autocontido a partir dos fontes deste diretório.
   Uso:  cd src && node build.mjs

   O núcleo vive em core/** como módulos ES (ver docs/arquitetura.md). Como o
   invariante do projeto é um arquivo único que abre por duplo clique, sem
   servidor e sem bundler externo, este script resolve o grafo de imports por
   conta própria e concatena os módulos em ordem topológica de dependência,
   removendo as linhas de import/export e envolvendo tudo num IIFE que publica
   window.PerceptCore com a mesma superfície de sempre.                       */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');
const ler = f => fs.readFileSync(path.join(AQUI, f), 'utf8');

/* ------------------------------------------------- grafo de módulos ES -- */
const IMPORT_RE = /^\s*import\s+[^'"]*from\s*['"]([^'"]+)['"]\s*;?\s*$/gm;
const EXPORT_FROM_RE = /^\s*export\s+\*\s+from\s*['"]([^'"]+)['"]\s*;?\s*$/gm;

function deps(abs) {
  const src = fs.readFileSync(abs, 'utf8');
  const out = [];
  for (const re of [IMPORT_RE, EXPORT_FROM_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) out.push(path.resolve(path.dirname(abs), m[1]));
  }
  return out;
}

/* Percurso em profundidade: dependências antes de quem depende delas. */
function topoOrder(entryAbs) {
  const ordered = [], estado = new Map();          // 0 = visitando, 1 = pronto
  (function visit(abs, pilha) {
    if (estado.get(abs) === 1) return;
    if (estado.get(abs) === 0)
      throw new Error('ciclo de dependência: ' + pilha.concat(abs).map(p => path.relative(AQUI, p)).join(' → '));
    estado.set(abs, 0);
    deps(abs).forEach(d => visit(d, pilha.concat(abs)));
    estado.set(abs, 1);
    ordered.push(abs);
  })(entryAbs, []);
  return ordered;
}

/* Remove a sintaxe de módulo, preservando as declarações. */
function stripModuleSyntax(src) {
  return src
    .replace(IMPORT_RE, '')
    .replace(EXPORT_FROM_RE, '')
    .replace(/^\s*export\s+default\s+\w+\s*;?\s*$/gm, '')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/^(\s*)export\s+(async\s+function|function\s*\*|function|const|let|var|class)\b/gm, '$1$2');
}

const ENTRY = path.join(AQUI, 'core/index.js');
const modules = topoOrder(ENTRY);

/* Como os módulos são concatenados num único escopo, dois arquivos não podem
   declarar o mesmo identificador de topo. Detectamos isso AQUI, com o arquivo e
   o nome, em vez de deixar o bundle quebrar em tempo de execução. */
const DECL_RE = /^(?:export\s+)?(?:async\s+function|function\s*\*|function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
const donos = new Map(), colisoes = [];
modules.forEach(m => {
  const rel = path.relative(AQUI, m).replace(/\\/g, '/');
  const src = fs.readFileSync(m, 'utf8');
  DECL_RE.lastIndex = 0;
  let g;
  while ((g = DECL_RE.exec(src))) {
    const nome = g[1];
    if (donos.has(nome) && donos.get(nome) !== rel) colisoes.push({ nome, a: donos.get(nome), b: rel });
    else donos.set(nome, rel);
  }
});
if (colisoes.length) {
  console.error('Colisão de identificadores no bundle (mesmo escopo após concatenação):');
  colisoes.forEach(c => console.error(`  • "${c.nome}" declarado em ${c.a} e em ${c.b}`));
  console.error('Renomeie um dos dois — o bundle é um único escopo.');
  process.exit(1);
}
const nucleo = [
  '/* ==========================================================================',
  '   PERCEPT LFP STUDIO — núcleo (gerado de src/core/** por build.mjs)',
  '   Não edite este bloco no index.html: edite src/core/** e reconstrua.',
  '   ========================================================================== */',
  '(function (root) {',
  "'use strict';",
  modules.map(m => {
    const rel = path.relative(AQUI, m).replace(/\\/g, '/');
    return `/* ---------- ${rel} ---------- */\n` + stripModuleSyntax(fs.readFileSync(m, 'utf8')).trim();
  }).join('\n\n'),
  'if (typeof module !== "undefined" && module.exports) module.exports = API;',
  'root.PerceptCore = API;',
  '})(typeof globalThis !== "undefined" ? globalThis : this);'
].join('\n');

const html = ler('index.template.html')
  .replace('/*__CSS__*/',  () => ler('styles.css'))
  .replace('/*__CORE__*/', () => nucleo)
  .replace('/*__PLOT__*/', () => ler('percept-plot.js'))
  .replace('/*__APP__*/',  () => ler('app.js'));

const destino = path.join(RAIZ, 'index.html');
fs.writeFileSync(destino, html);
console.log(`index.html gerado (${(html.length / 1024).toFixed(1)} KB) — núcleo de ${modules.length} módulos`);
