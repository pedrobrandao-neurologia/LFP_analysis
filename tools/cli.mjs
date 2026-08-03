#!/usr/bin/env node
/* ==========================================================================
   Percept LFP Studio — linha de comando.

   Roda o MESMO núcleo que o navegador executa (lido de index.html, não de uma
   cópia paralela) sobre uma pasta de Session Reports, e escreve métricas, EDF,
   estrutura BIDS-like e o manifesto de proveniência. Serve para processar uma
   coorte inteira sem abrir a interface.

       node tools/cli.mjs <pasta> [opções]

   Opções:
     --out <dir>        pasta de saída (padrão: ./saida)
     --tz <min>         fuso em minutos (padrão: o declarado em cada arquivo)
     --profile <id>     pd | dystonia | et | epilepsy | generic
     --no-edf           não escrever EDF
     --no-bids          não escrever a estrutura BIDS-like
     --quiet            só o resumo final

   O que ele NÃO faz: figuras. Elas dependem de canvas, e desenhar em Node
   exigiria dependência gráfica — o que este projeto não tem. Use a interface
   para as figuras, ou o pacote ZIP que ela exporta.
   ========================================================================== */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { installDOM } from '../tests/shim.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opcao = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const tem = n => args.includes('--' + n);
const pasta = args.find(a => !a.startsWith('--') && (args.indexOf(a) === 0 || !args[args.indexOf(a) - 1].startsWith('--')));
const quieto = tem('quiet');
const log = (...a) => { if (!quieto) console.log(...a); };

if (!pasta) {
  console.error('uso: node tools/cli.mjs <pasta com Session Reports> [--out dir] [--tz min] [--profile id]');
  process.exit(2);
}
if (!fs.existsSync(pasta)) { console.error('pasta não encontrada: ' + pasta); process.exit(2); }

installDOM();
const html = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!scripts.length) { console.error('index.html sem os blocos de script — rode "cd src && node build.mjs"'); process.exit(1); }
(0, eval)(scripts[0]);
const C = globalThis.PerceptCore;

/* varre a pasta recursivamente */
function varre(dir, acc) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) varre(p, acc);
    else if (/\.json$/i.test(e.name)) acc.push(p);
  });
  return acc;
}
const arquivos = varre(pasta, []);
if (!arquivos.length) { console.error('nenhum .json em ' + pasta); process.exit(2); }
log(`\n${arquivos.length} arquivo(s) encontrado(s) em ${pasta}\n`);

const saida = opcao('out', path.join(process.cwd(), 'saida'));
fs.mkdirSync(saida, { recursive: true });
const perfil = opcao('profile', null);
const tzArg = opcao('tz', null);

const lidos = [];
const falhas = [];
arquivos.forEach(f => {
  try {
    const p = C.parsePerceptText(fs.readFileSync(f, 'utf8'), path.basename(f));
    lidos.push(p);
    log(`  ✓ ${path.basename(f)} — ${p.patient.idHash} · ${Object.keys(p.availability).filter(k => p.availability[k] > 0).length} modalidades`);
  } catch (e) {
    falhas.push({ file: path.basename(f), error: e.message });
    log(`  ✗ ${path.basename(f)} — ${e.message}`);
  }
});
if (!lidos.length) { console.error('nenhum arquivo pôde ser lido'); process.exit(1); }

/* agrupa por sujeito — nunca misturar pessoas */
const porSujeito = new Map();
lidos.forEach(p => {
  const id = p.patient.idHash;
  if (!porSujeito.has(id)) porSujeito.set(id, []);
  porSujeito.get(id).push(p);
});
log(`\n${porSujeito.size} sujeito(s) distinto(s)\n`);

const escreve = (rel, conteudo) => {
  const dest = path.join(saida, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, conteudo);
  return dest;
};
const toCSV = (linhas, cabecalho) => {
  if (!linhas.length) return '';
  const cols = cabecalho || Array.from(linhas.reduce((s, r) => { Object.keys(r).forEach(k => s.add(k)); return s; }, new Set()));
  const esc = v => v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  return [cols.join(',')].concat(linhas.map(r => cols.map(c => esc(r[c])).join(','))).join('\n') + '\n';
};

const pacotes = [];
let nEdf = 0, nBids = 0;
porSujeito.forEach((ps, id) => {
  const off = tzArg != null ? parseInt(tzArg, 10)
    : (ps.find(p => p.meta && p.meta.utcOffsetMin != null) || { meta: {} }).meta.utcOffsetMin ?? -180;
  const b = C.extractMetrics(ps, off, perfil ? { profileId: perfil } : {});
  if (!b) return;
  pacotes.push(b);
  const dir = `sujeitos/${id}`;
  escreve(`${dir}/metricas.json`, JSON.stringify({
    export: { tool: 'Percept LFP Studio (CLI)', generated_at: new Date().toISOString(), timezone_offset_min: off },
    subject: b.subject, sessions: b.sessions, acute: b.acute, chronic: b.chronic
  }, null, 2));
  if (b.acute.length) escreve(`${dir}/metricas_agudas.csv`, toCSV(b.acute));
  if (b.chronic.length) escreve(`${dir}/metricas_cronicas.csv`, toCSV(b.chronic));

  if (!tem('no-edf')) {
    ps.forEach((p, i) => {
      const tds = (p.bsTimeDomain || []).concat(p.montageTD || []);
      if (!tds.length) return;
      const edf = C.writeEdf(tds.map(td => ({
        label: td.label, data: td.data, fs: td.fsEff || td.fs, unit: 'uV'
      })), { patientId: id, startMs: Date.parse(p.meta.sessionStart || '') || Date.now() });
      if (!edf) return;
      escreve(`${dir}/sinal/sessao-${String(i + 1).padStart(2, '0')}.edf`, Buffer.from(edf.bytes));
      escreve(`${dir}/sinal/sessao-${String(i + 1).padStart(2, '0')}_edf.json`, JSON.stringify(edf.meta, null, 2));
      nEdf++;
    });
  }
  log(`  ${id}: ${b.acute.length} linha(s) aguda(s), ${b.chronic.length} crônica(s), ${b.sessions.length} sessão(ões)`);
});

if (!tem('no-bids')) {
  const bids = C.buildBidsLike(lidos, { includeSignalTsv: false, appVersion: '0.6.0' });
  (bids || []).forEach(a => { escreve('bids/' + a.path, a.content); nBids++; });
}

/* coorte */
const co = C.cohortSummary(pacotes, {});
if (co) {
  escreve('coorte/coorte.json', JSON.stringify({
    generated_at: new Date().toISOString(), n_subjects: co.nSubjects,
    descriptive_only: co.descriptiveOnly, note: co.note, caveat: co.caveat,
    prevalence: co.prevalence, subjects: co.subjects, stats: co.stats
  }, null, 2));
  escreve('coorte/coorte_por_hemisferio.csv', toCSV(co.rows.map(r => ({
    sujeito: r.subjectId, hemisferio: r.hemisphere,
    tem_pico: r.hasPeak === null ? '' : (r.hasPeak ? 1 : 0),
    pico_hz: r.peakHz, relativa_pct: r.betaRelPct, expoente_aperiodico: r.aperiodicExponent,
    burst_taxa_hz: r.burstRate, burst_duracao_ms: r.burstMeanMs,
    mesor: r.mesor, amplitude_24h: r.amp24, acrofase_h: r.acrophase,
    pct_beta_alto: r.offPct, dias_timeline: r.nDays
  }))));
}

escreve('execucao.json', JSON.stringify({
  tool: 'Percept LFP Studio — CLI', generated_at: new Date().toISOString(),
  input: path.resolve(pasta), output: path.resolve(saida),
  nFiles: arquivos.length, nParsed: lidos.length, nFailed: falhas.length, failures: falhas,
  nSubjects: porSujeito.size, timezoneOverrideMin: tzArg != null ? parseInt(tzArg, 10) : null,
  profileOverride: perfil, edfWritten: nEdf, bidsFilesWritten: nBids,
  note: 'as figuras não são geradas na CLI: elas dependem de canvas, e desenhar em Node exigiria dependência ' +
    'gráfica. Use a interface, ou o pacote ZIP que ela exporta.'
}, null, 2));

console.log(`\n${'='.repeat(58)}`);
console.log(`  ${lidos.length}/${arquivos.length} arquivos lidos · ${porSujeito.size} sujeito(s)` +
  (co ? ` · ${co.nHemispheres} hemisfério(s)` : ''));
if (co) console.log(`  pico na banda primária: ${co.prevalence.byHemisphere.k}/${co.prevalence.byHemisphere.n} hemisférios` +
  ` (${co.prevalence.byHemisphere.pct}%, IC ${(100 * co.prevalence.byHemisphere.ci95[0]).toFixed(1)}–${(100 * co.prevalence.byHemisphere.ci95[1]).toFixed(1)}%)`);
if (falhas.length) console.log(`  ${falhas.length} arquivo(s) não puderam ser lidos — ver execucao.json`);
console.log(`  saída em ${path.resolve(saida)}`);
console.log('='.repeat(58) + '\n');
process.exit(falhas.length && !lidos.length ? 1 : 0);
