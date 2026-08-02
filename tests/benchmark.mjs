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

/* ------------------------------- 5. DSP avançada (Onda 3) ---------------- */
console.log('\n── multitaper, specparam, wavelet, PAC e gama contra ground truth');
{
  let sem = 31415927;
  const rnd = () => { sem = (Math.imul(sem, 1664525) + 1013904223) >>> 0; return sem / 4294967296; };
  const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  /* multitaper × Welch em registro CURTO: é onde o multitaper deve ganhar */
  [4, 8, 16].forEach(seg => {
    const N = FS * seg, x = new Float64Array(N);
    for (let i = 0; i < N; i++) x[i] = Math.sin(2 * Math.PI * 21.5 * i / FS) + 1.2 * gauss();
    const mt = C.multitaperPSD(x, FS, { NW: 3 });
    const w = C.welchPSD(x, FS, { nperseg: 512, overlap: .5 });
    const eMt = Math.abs(picoDe(mt.f, mt.p, 12, 32) - 21.5);
    reg('pico por multitaper', `${seg} s de registro`, eMt, '< 0,5 Hz', eMt < 0.5, 'Hz');
    /* o Welch precisa de ao menos 3 segmentos; em registro curto ele se recusa,
       e é exatamente aí que o multitaper entrega estimativa — o benchmark
       registra a recusa em vez de omitir a linha */
    if (w.p) {
      const eW = Math.abs(picoDe(w.f, w.p, 12, 32) - 21.5);
      reg('pico por Welch (referência)', `${seg} s de registro`, eW, 'informativo', true, 'Hz');
    } else {
      reg('Welch se recusa (poucos segmentos)', `${seg} s de registro`, w.nSegments, 'informativo', true, 'segmentos');
    }
  });

  /* DPSS: ortonormalidade e concentração — propriedades matemáticas exatas */
  {
    const sl = C.dpss(512, 4, 7);
    let pior = 0;
    for (let a = 0; a < 7; a++) for (let b = a; b < 7; b++) {
      let d = 0; for (let i = 0; i < 512; i++) d += sl.tapers[a][i] * sl.tapers[b][i];
      pior = Math.max(pior, Math.abs(d - (a === b ? 1 : 0)));
    }
    reg('ortonormalidade das DPSS', 'N=512, NW=4, K=7', pior, '< 1e-8', pior < 1e-8, '');
    const menor = Math.min.apply(null, sl.concentrations.slice(0, 6));
    reg('concentração mínima até 2NW−2', 'N=512, NW=4', menor, '> 0,99', menor > 0.99, 'λ');
  }

  /* specparam: recuperação de expoente, offset, frequência e largura de pico */
  [[1.0, 0.8], [1.5, 1.2], [2.2, 1.5]].forEach(([chi, off]) => {
    const f = [], p = [];
    for (let k = 1; k <= 200; k++) {
      const x = k * 0.5;
      const logp = off - chi * Math.log10(x) + 0.6 * Math.exp(-Math.pow(x - 22, 2) / (2 * 3 * 3));
      f.push(x); p.push(Math.pow(10, logp));
    }
    const m = C.specparam(f, p, { fmin: 2, fmax: 95 });
    const eChi = Math.abs(m.exponent - chi);
    const eOff = Math.abs(m.offset - off);
    reg('specparam — expoente', `χ verdadeiro ${chi}`, eChi, '< 0,10', eChi < 0.10, '');
    reg('specparam — offset', `χ verdadeiro ${chi}`, eOff, '< 0,15', eOff < 0.15, '');
    const pk = m.peaks.reduce((a, b) => Math.abs(b.cf - 22) < Math.abs((a || { cf: 1e9 }).cf - 22) ? b : a, null);
    const eCf = pk ? Math.abs(pk.cf - 22) : NaN;
    const eBw = pk ? Math.abs(pk.bw - 6) : NaN;
    reg('specparam — frequência do pico', `χ verdadeiro ${chi}`, eCf, '< 0,5 Hz', eCf < 0.5, 'Hz');
    reg('specparam — largura do pico', `χ verdadeiro ${chi}`, eBw, '< 2,5 Hz', eBw < 2.5, 'Hz');
    reg('specparam — R² do modelo', `χ verdadeiro ${chi}`, m.r2, '> 0,95', m.r2 > 0.95, '');
  });

  /* seleção de modelo aperiódico: joelho quando há, reta quando não há */
  {
    const fj = [], pj = [];
    for (let k = 1; k <= 200; k++) { const x = k * 0.5; fj.push(x); pj.push(Math.pow(10, 1.5) / (10 + Math.pow(x, 2))); }
    const cj = C.specparamCompare(fj, pj, { fmin: 1, fmax: 95 });
    reg('seleção de modelo aperiódico', 'espectro com joelho', cj.best === 'knee' ? 1 : 0, '= 1', cj.best === 'knee', 'acerto');
    const fr = [], pr = [];
    for (let k = 1; k <= 200; k++) { const x = k * 0.5; fr.push(x); pr.push(Math.pow(10, 1.0 - 1.4 * Math.log10(x))); }
    const cr = C.specparamCompare(fr, pr, { fmin: 2, fmax: 95 });
    reg('seleção de modelo aperiódico', 'lei de potência pura', cr.best === 'fixed' ? 1 : 0, '= 1', cr.best === 'fixed', 'acerto');
  }

  /* bursts por wavelet contra o ground truth do gerador */
  {
    const g = gerarSinal({ preset: 'pd', snrDb: 20, tremor: false });
    const freqs = []; for (let ff = 13; ff <= 30; ff += 1.5) freqs.push(ff);
    const cwt = C.morletCWT(g.limpo, FS, freqs, { nCycles: 7 });
    const env = C.waveletBandEnvelope(cwt, 13, 30);
    const det = C.waveletBursts(env.env, FS, { percentile: 75, minDurationMs: 200, edgeFraction: 1.0 });
    const verdade = g.truth.bursts;
    const sobrepoe = (a, b) => Math.max(0, Math.min(a.startIdx / FS + a.durationMs / 1000, b.endS) - Math.max(a.startIdx / FS, b.startS)) > 0.05;
    let vp = 0; const usados = new Set();
    det.bursts.forEach(b => {
      const i = verdade.findIndex((v, j) => !usados.has(j) && sobrepoe(b, v));
      if (i >= 0) { vp++; usados.add(i); }
    });
    const prec = det.bursts.length ? vp / det.bursts.length : 0;
    const rec = verdade.length ? vp / verdade.length : 0;
    const f1 = (prec + rec) > 0 ? 2 * prec * rec / (prec + rec) : 0;
    reg('bursts por wavelet (F1)', 'SNR 20 dB, p75', f1, '> 0,75', f1 > 0.75, 'F1');
  }

  /* PAC: detecção com e sem acoplamento */
  {
    const monta = acoplado => {
      const N = FS * 60, x = new Float64Array(N);
      let fase = 0, env = 0.3;
      for (let i = 0; i < N; i++) {
        const fb = 20 + 1.5 * Math.sin(2 * Math.PI * 0.13 * i / FS) + 0.4 * gauss();
        fase += 2 * Math.PI * fb / FS;
        env = 0.94 * env + 0.06 * (rnd() < 0.02 ? 3 : 0.3);
        const mod = acoplado ? (1 + Math.cos(fase)) / 2 : (1 + Math.cos(2 * Math.PI * 3.3 * i / FS)) / 2;
        x[i] = 2 * env * Math.cos(fase) + 1.0 * mod * Math.sin(2 * Math.PI * 80 * i / FS) + 0.6 * gauss();
      }
      return x;
    };
    const a = C.pacTort(monta(true), FS, { phaseBand: [13, 30], ampBand: [50, 120], nSurrogates: 150 });
    const b = C.pacTort(monta(false), FS, { phaseBand: [13, 30], ampBand: [50, 120], nSurrogates: 150 });
    reg('PAC — detecta acoplamento verdadeiro', 'beta→gama simulado', a.z, '> 5', a.z > 5, 'z');
    reg('PAC — rejeita controle sem acoplamento', 'sem acoplamento', b.z, '< 3', b.z < 3, 'z');
  }

  /* gama: entrained vs. finamente sintonizada */
  {
    const espectro = picoHz => {
      const f = [], p = [];
      for (let k = 1; k <= 250; k++) {
        const x = k * 0.5;
        f.push(x);
        p.push(Math.pow(10, 1.0 - 1.4 * Math.log10(x) + 0.9 * Math.exp(-Math.pow(x - picoHz, 2) / (2 * 1.2 * 1.2))));
      }
      return { f, p };
    };
    const e = espectro(65);
    const ent = C.detectGamma(e.f, e.p, { stimRateHz: 130, tolHz: 2.5 });
    const ftg = C.detectGamma(e.f, e.p, { stimRateHz: 160, tolHz: 2.5 });
    const semF = C.detectGamma(e.f, e.p, {});
    reg('gama — classifica entrained em f_stim/2', 'pico 65 Hz, f_stim 130', ent.entrained ? 1 : 0, '= 1', !!ent.entrained, 'acerto');
    reg('gama — classifica endógena fora de f_stim/2', 'pico 65 Hz, f_stim 160', (ftg.ftg && !ftg.entrained) ? 1 : 0, '= 1', !!(ftg.ftg && !ftg.entrained), 'acerto');
    reg('gama — recusa sem f_stim', 'f_stim desconhecida', semF.entrained ? 0 : 1, '= 1', !semF.entrained, 'acerto');
  }
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
