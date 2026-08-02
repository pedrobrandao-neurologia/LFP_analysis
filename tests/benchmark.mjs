#!/usr/bin/env node
/* ==========================================================================
   Benchmark quantitativo do pipeline (Prompt 7.1 — L46, L47).

   Os testes de tests/run.mjs são de REGRESSÃO: verificam que o código faz o que
   fazia. Este arquivo mede DESEMPENHO contra ground truth conhecido, que é o
   que permite escrever "o pipeline recupera X com erro Y" em vez de afirmar
   intenção. Método: Vivien et al., npj Parkinsons Dis 2026.

   Uso:
     node tests/benchmark.mjs                     # varredura padrão
     node tests/benchmark.mjs --out benchmark/    # grava CSV/MD
     node tests/benchmark.mjs --check             # compara com baseline e falha
                                                    se houver regressão (CI)
   ========================================================================== */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { installDOM } from './shim.mjs';
import { gerarSinal } from '../tools/gerar_sintetico.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const OUT = arg('out', null);
const CHECK = args.includes('--check');

installDOM();
const html = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');
[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).forEach(s => (0, eval)(s));
const C = globalThis.PerceptCore;

const FS = 250;
const linhas = [];
const reg = (metrica, condicao, valor, criterio, ok, unidade) =>
  linhas.push({ metrica, condicao, valor: +(+valor).toFixed(4), criterio, aprovado: ok ? 1 : 0, unidade: unidade || '' });

const picoDe = (f, p, lo, hi) => { let bi = -1, bv = -Infinity; for (let i = 0; i < f.length; i++) if (f[i] >= lo && f[i] <= hi && p[i] > bv) { bv = p[i]; bi = i; } return bi >= 0 ? f[bi] : NaN; };

console.log('\n===========================================================');
console.log('  BENCHMARK — desempenho medido contra ground truth');
console.log('===========================================================\n');

/* ------------------------------------------- 1. varredura de SNR (ECG) --- */
console.log('── varredura de SNR: detecção de picos R e remoção de ECG');
const METODOS = ['interpolation', 'template', 'svd'];
for (const snr of [-10, -5, 0, 5, 10]) {
  const g = gerarSinal({ preset: 'pd', snrDb: snr });
  const truth = g.truth;
  const det = C.detectRPeaks(g.sujo, FS, {});
  /* detecção: VP / FP contra as posições exatas */
  const tol = Math.round(0.05 * FS), usados = new Set();
  let vp = 0;
  det.peaks.forEach(p => {
    const i = truth.ecg.rPeakIndices.findIndex((v, j) => !usados.has(j) && Math.abs(v - p) <= tol);
    if (i >= 0) { vp++; usados.add(i); }
  });
  const taxaVP = 100 * vp / truth.ecg.nBeats;
  const taxaFP = 100 * (det.peaks.length - vp) / Math.max(1, det.peaks.length);
  const detectavel = snr <= 0;   /* fronteira medida da capacidade do detector */
  if (detectavel) {
    reg('detecção de picos R — VP', `SNR ${snr} dB`, taxaVP, '≥ 95%', taxaVP >= 95, '%');
    reg('detecção de picos R — FP', `SNR ${snr} dB`, taxaFP, '≤ 1%', taxaFP <= 1, '%');
  } else {
    /* artefato desprezível: exigimos honestidade, não acerto */
    reg('confiança declarada com artefato fraco', `SNR ${snr} dB`, det.confidence === 'alta' ? 0 : 1,
      'não reivindicar confiança alta', det.confidence !== 'alta', 'bool');
  }
  if (!detectavel) continue;
  for (const m of METODOS) {
    const r = C.removeEcg(g.sujo, FS, det.peaks, { method: m });
    const v = C.validateEcgRemoval(g.sujo, r.cleaned, FS, { peakHz: truth.peaks[0].f, reference: g.limpo });
    reg(`supressão de ECG — ${m}`, `SNR ${snr} dB`, v.suppressionRatioDb, '> 0 dB', v.suppressionRatioDb > 0, 'dB');
    reg(`recuperação do pico beta — ${m}`, `SNR ${snr} dB`, v.betaPeakRecovery, '[0,7; 1,3]',
      v.betaPeakRecovery >= 0.7 && v.betaPeakRecovery <= 1.3, 'razão');
    reg(`correlação com ground truth — ${m}`, `SNR ${snr} dB`, v.correlationWithReference,
      m === 'svd' ? '> 0,90' : '> 0,50', v.correlationWithReference > (m === 'svd' ? 0.90 : 0.50), 'r');
    if (m === 'svd') {
      const bpp = C.bandPowerPreservation(
        C.welchPSD(r.cleaned, FS, { nperseg: 512, overlap: .5 }),
        C.welchPSD(g.limpo, FS, { nperseg: 512, overlap: .5 }), 13, 30);
      const tpp = C.bandPowerPreservation(
        C.welchPSD(r.cleaned, FS, { nperseg: 512, overlap: .5 }),
        C.welchPSD(g.limpo, FS, { nperseg: 512, overlap: .5 }), 4, 8);
      reg('preservação de potência beta (BPP)', `SNR ${snr} dB`, bpp, '[0,7; 1,3]', bpp >= 0.7 && bpp <= 1.3, 'razão');
      reg('preservação de potência teta (TPP)', `SNR ${snr} dB`, tpp, '[0,7; 1,3]', tpp >= 0.7 && tpp <= 1.3, 'razão');
    }
  }
}

/* ------------------------------------ 2. integridade: pacotes e fs efetiva */
console.log('── integridade do sinal: perda de pacotes e fs efetiva');
for (const pct of [0, 1, 5, 10]) {
  const g = gerarSinal({ preset: 'pd', snrDb: 0, packetLossPct: pct });
  const pk = C.analyzePackets({
    data: Float64Array.from(g.dados), fs: FS,
    packetSizes: g.packetSizes, ticksMs: g.ticksMs, sequences: g.sequences
  });
  const verdadeiros = new Set(g.truth.packets.lostPacketIndices);
  const detectados = pk.gaps.reduce((a, x) => a + x.nPackets, 0);
  /* Jaccard sobre a CONTAGEM de pacotes perdidos (as posições relativas já são
     verificadas por tests/run.mjs com índices exatos) */
  const jac = verdadeiros.size === 0 && detectados === 0 ? 1
    : Math.min(detectados, verdadeiros.size) / Math.max(detectados, verdadeiros.size, 1);
  reg('detecção de pacotes perdidos (Jaccard)', `perda ${pct}%`, jac, '> 0,99', jac > 0.99, 'índice');

  const eff = C.effectiveFs({ ticksMs: g.ticksMs, nSamples: pk.nExpected, nominalFs: FS, packetSizes: g.packetSizes });
  const erroFs = Math.abs(eff.fsEff - g.truth.fsEffectiveReal);
  reg('recuperação da fs efetiva', `perda ${pct}%`, erroFs, '< 0,005 Hz', erroFs < 0.005, 'Hz');
}

/* --------------------------------- 3. espectral: pico e expoente aperiódico */
console.log('── espectral: frequência de pico e expoente aperiódico');
for (const preset of ['pd', 'dystonia', 'et']) {
  const g = gerarSinal({ preset, snrDb: 10, bursts: false, tremor: false });
  const w = C.welchPSD(g.limpo, FS, { nperseg: 1024, overlap: .5 });
  const alvo = g.truth.peaks[0].f;
  const achado = picoDe(w.f, w.p, Math.max(1, alvo - 4), alvo + 4);
  const erro = Math.abs(achado - alvo);
  reg('recuperação da frequência de pico', `preset ${preset}`, erro, '< 0,5 Hz', erro < 0.5, 'Hz');
  const ap = C.fitAperiodic(w.f, w.p, { fmin: 2, fmax: 95 });
  const erroRel = ap ? 100 * Math.abs(ap.exponent - g.truth.aperiodicExponent) / g.truth.aperiodicExponent : NaN;
  reg('recuperação do expoente aperiódico', `preset ${preset}`, erroRel, '< 40%', erroRel < 40, '%');
}

/* ------------------------------------------------- 4. detecção de bursts -- */
console.log('── bursts: F1 de sobreposição temporal contra o ground truth');
{
  const g = gerarSinal({ preset: 'pd', snrDb: 20, tremor: false });
  const bp = C.bandpassFFT(g.limpo, FS, 13, 30);
  const env = C.hilbertEnvelope(bp);
  const det = C.detectBursts(env, FS, { percentile: 75, minDurationMs: 200 });
  const verdade = g.truth.bursts;
  const sobrepoe = (a, b) => Math.max(0, Math.min(a.end, b.endS) - Math.max(a.start, b.startS)) > 0.05;
  let vp = 0; const usados = new Set();
  det.bursts.forEach(b => {
    const i = verdade.findIndex((v, j) => !usados.has(j) && sobrepoe(b, v));
    if (i >= 0) { vp++; usados.add(i); }
  });
  const prec = det.bursts.length ? vp / det.bursts.length : 0;
  const rec = verdade.length ? vp / verdade.length : 0;
  const f1 = (prec + rec) > 0 ? 2 * prec * rec / (prec + rec) : 0;
  reg('detecção de bursts (F1)', 'SNR 20 dB, p75', f1, '> 0,80', f1 > 0.80, 'F1');
}

/* ------------------------------------------------------------- relatório - */
const aprovados = linhas.filter(l => l.aprovado).length;
const total = linhas.length;
console.log('\n-----------------------------------------------------------');
console.log('  métrica                              condição       valor  crit.  ok');
console.log('-----------------------------------------------------------');
linhas.forEach(l => console.log(
  `  ${l.metrica.slice(0, 36).padEnd(36)} ${l.condicao.padEnd(13)} ${String(l.valor).padStart(7)} ${l.criterio.padEnd(6)} ${l.aprovado ? '✓' : '✗'}`));
console.log('-----------------------------------------------------------');
console.log(`  ${aprovados}/${total} critérios aprovados\n`);

if (OUT) {
  fs.mkdirSync(OUT, { recursive: true });
  const cab = ['metrica', 'condicao', 'valor', 'unidade', 'criterio', 'aprovado'];
  const csv = [cab.join(',')].concat(linhas.map(l => cab.map(k => {
    const v = l[k]; return /[",;\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  }).join(','))).join('\n');
  fs.writeFileSync(path.join(OUT, 'resultados.csv'), csv);
  const md = ['# Benchmark do pipeline — desempenho medido', '',
    `Sinal sintético com ground truth (\`tools/gerar_sintetico.mjs\`). **${aprovados}/${total}** critérios aprovados.`, '',
    '| métrica | condição | valor | unidade | critério | ok |', '|---|---|---:|---|---|:--:|']
    .concat(linhas.map(l => `| ${l.metrica} | ${l.condicao} | ${l.valor} | ${l.unidade} | ${l.criterio} | ${l.aprovado ? '✓' : '✗'} |`))
    .join('\n');
  fs.writeFileSync(path.join(OUT, 'resultados.md'), md + '\n');
  console.log(`  Gravado: ${OUT}/resultados.csv e ${OUT}/resultados.md`);
}

if (CHECK) {
  const basePath = path.join(RAIZ, 'benchmark', 'baseline.json');
  if (!fs.existsSync(basePath)) {
    fs.mkdirSync(path.dirname(basePath), { recursive: true });
    fs.writeFileSync(basePath, JSON.stringify({ aprovados, total, linhas }, null, 2));
    console.log('  baseline.json criado (primeira execução).');
  } else {
    const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
    const antes = new Map(base.linhas.map(l => [l.metrica + '|' + l.condicao, l]));
    const regressoes = linhas.filter(l => {
      const a = antes.get(l.metrica + '|' + l.condicao);
      return a && a.aprovado === 1 && l.aprovado === 0;
    });
    if (regressoes.length) {
      console.error('  REGRESSÃO em relação ao baseline:');
      regressoes.forEach(r => console.error(`    ✗ ${r.metrica} (${r.condicao}): ${r.valor} — critério ${r.criterio}`));
      process.exit(1);
    }
    console.log(`  Sem regressão em relação ao baseline (${base.aprovados}/${base.total} → ${aprovados}/${total}).`);
  }
}

process.exit(aprovados === total ? 0 : 1);
