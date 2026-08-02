#!/usr/bin/env node
/* ==========================================================================
   Gerador de sinal sintético COM GROUND TRUTH, para validação quantitativa.

   Diferente de tools/gerar_exemplo.mjs (que produz o dataset de demonstração
   do aplicativo, com todas as modalidades), este gerador produz sinais
   controlados e, ao lado de cada um, um arquivo `.truth.json` com TODOS os
   parâmetros verdadeiros — é o que permite medir desempenho em vez de afirmar
   intenção.

   Construção do sinal, como em Vivien et al., npj Parkinsons Dis 2026:
     • soma de senoides em teta e beta com amplitudes e frequências declaradas;
     • ruído 1/f com expoente configurável;
     • passa-alta em 0,01 Hz, simulando o filtro de hardware do Percept;
     • contaminação com artefato de ECG em SNR de −10 a +10 dB;
     • opcionalmente: perda de pacotes, deriva de fs efetiva e bursts de beta
       em instantes conhecidos.

   Uso:
     node tools/gerar_sintetico.mjs --preset pd|dystonia|et|epilepsy --out examples/
     node tools/gerar_sintetico.mjs --snr-sweep -10:5:10 --out benchmark/
     node tools/gerar_sintetico.mjs --packet-loss 0,1,5,10 --out benchmark/
   ========================================================================== */
import fs from 'fs';
import path from 'path';
import { fft, nextPow2 } from '../src/core/dsp/fft.js';

/* ------------------------------------------------------------- utilidades */
const args = process.argv.slice(2);
const arg = (nome, def) => {
  const i = args.indexOf('--' + nome);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const OUT = arg('out', 'benchmark');
const FS_NOMINAL = 250;
const DUR_S = parseFloat(arg('duracao', '60'));

/* gerador pseudoaleatório determinístico (mesma semente → mesmo arquivo) */
let _s = 20260802;
const rnd = () => { _s |= 0; _s = _s + 0x6D2B79F5 | 0;
  let t = Math.imul(_s ^ _s >>> 15, 1 | _s);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/* ------------------------------------------------------- perfis de doença */
const PRESETS = {
  pd:       { label: 'Doença de Parkinson (STN)', picos: [{ f: 18, amp: 2.4 }, { f: 6, amp: 0.9 }], expoente: 1.5, diagnosis: 'ParkinsonsDisease', alvo: 'Stn' },
  dystonia: { label: 'Distonia (GPi)', picos: [{ f: 5.7, amp: 2.2 }, { f: 22, amp: 0.7 }], expoente: 1.3, diagnosis: 'Dystonia', alvo: 'Gpi', tremorHz: 4.0 },
  et:       { label: 'Tremor essencial (VIM)', picos: [{ f: 4.5, amp: 2.0 }, { f: 9.0, amp: 0.9 }], expoente: 1.4, diagnosis: 'EssentialTremor', alvo: 'Vim', tremorHz: 4.5 },
  epilepsy: { label: 'Epilepsia (ANT)', picos: [{ f: 10, amp: 1.8 }, { f: 4, amp: 1.2 }], expoente: 1.6, diagnosis: 'Epilepsy', alvo: 'Ant' }
};

/* --------------------------------------------------- componentes do sinal */

/* Ruído com espectro 1/f^expoente, gerado no domínio da frequência. */
function ruido1f(n, expoente) {
  const N = nextPow2(n);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = gauss();
  fft(re, im, false);
  for (let k = 1; k <= N / 2; k++) {
    const g = Math.pow(k, -expoente / 2);
    re[k] *= g; im[k] *= g;
    if (k < N / 2) { re[N - k] *= g; im[N - k] *= g; }
  }
  re[0] = im[0] = 0;                       // sem componente DC
  fft(re, im, true);
  const out = re.slice(0, n);
  /* normaliza para desvio-padrão 1 */
  let m = 0; for (let i = 0; i < n; i++) m += out[i];
  m /= n;
  let v = 0; for (let i = 0; i < n; i++) v += (out[i] - m) ** 2;
  v = Math.sqrt(v / n) || 1;
  for (let i = 0; i < n; i++) out[i] = (out[i] - m) / v;
  return out;
}

/* Passa-alta em 0,01 Hz, simulando o filtro de hardware do Percept. */
function passaAlta(x, fsHz, corte) {
  const N = nextPow2(x.length);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < x.length; i++) re[i] = x[i];
  fft(re, im, false);
  const df = fsHz / N;
  for (let k = 0; k <= N / 2; k++) {
    if (k * df < corte) {
      re[k] = im[k] = 0;
      if (k > 0 && k < N / 2) { re[N - k] = im[N - k] = 0; }
    }
  }
  fft(re, im, true);
  return re.slice(0, x.length);
}

/* Complexo QRS paramétrico (~100 ms), bifásico. */
function qrsTemplate(fsHz) {
  const L = Math.round(0.1 * fsHz), t = new Float64Array(L);
  for (let i = 0; i < L; i++) {
    const u = (i / L - 0.5) * 8;
    t[i] = Math.exp(-u * u / 2) * (1 - 0.55 * u * u);
  }
  return t;
}

/* --------------------------------------------------------- sinal completo */
/* Retorna { limpo, sujo, truth } com todos os parâmetros verdadeiros. */
export function gerarSinal(opts) {
  opts = opts || {};
  const preset = PRESETS[opts.preset || 'pd'];
  const fsReal = opts.fsReal || 249.99;          // fs efetiva real (deriva)
  const n = Math.round(DUR_S * FS_NOMINAL);
  const snrDb = isFinite(opts.snrDb) ? opts.snrDb : 0;
  const bpm = opts.bpm || 62;

  /* 1. oscilações declaradas + ruído 1/f + passa-alta de hardware */
  const osc = new Float64Array(n);
  preset.picos.forEach(p => {
    const fase = rnd() * 2 * Math.PI;
    for (let i = 0; i < n; i++) osc[i] += p.amp * Math.sin(2 * Math.PI * p.f * i / fsReal + fase);
  });
  const ruido = ruido1f(n, preset.expoente);
  let limpo = new Float64Array(n);
  for (let i = 0; i < n; i++) limpo[i] = osc[i] + 0.8 * ruido[i];

  /* 2. bursts de beta em instantes conhecidos (para medir F1 de burst) */
  const burstsTruth = [];
  if (opts.bursts !== false) {
    const fBurst = preset.picos[0].f;
    let t = 3.0;
    while (t < DUR_S - 3) {
      const dur = 0.25 + 0.35 * rnd();                  // 250–600 ms
      const i0 = Math.round(t * FS_NOMINAL), i1 = Math.round((t + dur) * FS_NOMINAL);
      for (let i = i0; i < i1 && i < n; i++) {
        const janela = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i - i0) / (i1 - i0));
        limpo[i] += 2.2 * janela * Math.sin(2 * Math.PI * fBurst * i / fsReal);
      }
      burstsTruth.push({ startS: +t.toFixed(4), endS: +(t + dur).toFixed(4), durationMs: +(dur * 1000).toFixed(1) });
      t += dur + 1.2 + 1.6 * rnd();
    }
  }

  /* 3. tremor mecânico (distonia/TE): cai sobre a banda teta-alfa */
  if (preset.tremorHz && opts.tremor !== false) {
    for (let i = 0; i < n; i++) limpo[i] += 0.7 * Math.sin(2 * Math.PI * preset.tremorHz * i / fsReal + 1.1);
  }

  limpo = passaAlta(limpo, FS_NOMINAL, 0.01);

  /* 4. artefato de ECG no SNR pedido */
  const qrs = qrsTemplate(FS_NOMINAL);
  let iMax = 0; qrs.forEach((v, i) => { if (v > qrs[iMax]) iMax = i; });
  const rrBase = Math.round(FS_NOMINAL * 60 / bpm);
  const rPeaks = [];
  let pos = rrBase;
  for (let b = 0; pos < n - rrBase; b++) {
    rPeaks.push(pos + iMax);
    pos += Math.round(rrBase * (1 + 0.08 * Math.sin(b * 1.7) + 0.04 * Math.sin(b * 0.53)));
  }
  const artef = new Float64Array(n);
  rPeaks.forEach(p => { for (let k = 0; k < qrs.length; k++) { const i = p - iMax + k; if (i >= 0 && i < n) artef[i] += qrs[k]; } });
  let pS = 0, pA = 0;
  for (let i = 0; i < n; i++) { pS += limpo[i] * limpo[i]; pA += artef[i] * artef[i]; }
  pS /= n; pA /= n;
  const ganho = pA > 0 ? Math.sqrt((pS / Math.pow(10, snrDb / 10)) / pA) : 0;
  const sujo = new Float64Array(n);
  for (let i = 0; i < n; i++) sujo[i] = limpo[i] + ganho * artef[i];

  /* 5. empacotamento: perda de pacotes e ticks com a fs efetiva real */
  const SZ = 63;
  const nPacotes = Math.floor(n / SZ);
  const pctPerda = isFinite(opts.packetLossPct) ? opts.packetLossPct : 0;
  const perdidos = new Set();
  if (pctPerda > 0) {
    const alvo = Math.round(nPacotes * pctPerda / 100);
    let g = 0;
    while (perdidos.size < alvo && g++ < nPacotes * 4) {
      const p = 2 + Math.floor(rnd() * (nPacotes - 4));
      perdidos.add(p);
    }
  }
  const dados = [], packetSizes = [], ticksMs = [], sequences = [];
  const idxPerdidos = [];
  for (let p = 0; p < nPacotes; p++) {
    if (perdidos.has(p)) {
      for (let k = 0; k < SZ; k++) idxPerdidos.push(p * SZ + k);
      continue;
    }
    for (let k = 0; k < SZ; k++) dados.push(+sujo[p * SZ + k].toFixed(4));
    packetSizes.push(SZ);
    ticksMs.push(Math.round(p * SZ / fsReal * 1000));
    sequences.push(p % 256);
  }

  const truth = {
    generator: 'gerar_sintetico.mjs',
    preset: opts.preset || 'pd', presetLabel: preset.label,
    fsNominal: FS_NOMINAL, fsEffectiveReal: fsReal,
    durationS: DUR_S, nSamplesTotal: n,
    peaks: preset.picos, aperiodicExponent: preset.expoente,
    highpassHz: 0.01,
    ecg: { snrDb, bpm, gain: +ganho.toFixed(6), rPeakIndices: rPeaks, nBeats: rPeaks.length, qrsPeakOffset: iMax },
    packets: { size: SZ, nPackets: nPacotes, lostPacketIndices: Array.from(perdidos).sort((a, b) => a - b),
               lostSampleIndices: idxPerdidos, pctLoss: pctPerda },
    bursts: burstsTruth,
    tremorHz: preset.tremorHz || null,
    cleanReference: Array.from(limpo).map(v => +v.toFixed(4))
  };
  return { limpo, sujo, truth, dados, packetSizes, ticksMs, sequences, preset };
}

/* ------------------------------------------- empacotamento em JSON Percept */
function comoPerceptJson(sig, nome) {
  const T0 = Date.UTC(2025, 0, 6, 12, 0, 0);
  const p = sig.preset;
  return {
    SessionDate: iso(T0), SessionEndDate: iso(T0 + 3600e3),
    ProgrammerUtcOffset: '-03:00', ProgrammerTimezone: 'America/Sao_Paulo',
    PatientInformation: { Final: { PatientId: 'SINTETICO-' + nome, PatientDateOfBirth: '1960-01-01',
      PatientGender: 'PatientGenderDef.MALE', Diagnosis: 'DiagnosisTypeDef.' + p.diagnosis } },
    DeviceInformation: { Final: { Neurostimulator: 'Percept PC', NeurostimulatorSerialNumber: 'SIM-0001',
      ImplantDate: iso(Date.UTC(2024, 8, 12)), ProductVersion: '07.05.05',
      NeurostimulatorLocation: 'NeurostimulatorLocationDef.CHEST_LEFT' } },
    LeadConfiguration: { Final: [
      { Hemisphere: 'HemisphereLocationDef.Left', LeadLocation: 'LeadLocationDef.' + p.alvo, Model: 'LeadModelDef.LEAD_B33005', ElectrodeNumber: 'ElectrodeDef.ZERO_THREE' },
      { Hemisphere: 'HemisphereLocationDef.Right', LeadLocation: 'LeadLocationDef.' + p.alvo, Model: 'LeadModelDef.LEAD_B33005', ElectrodeNumber: 'ElectrodeDef.ZERO_THREE' }] },
    BrainSenseTimeDomain: [{
      Channel: 'ZERO_TWO_LEFT', Pass: 'Pass1', SampleRateInHz: FS_NOMINAL, Gain: 100,
      FirstPacketDateTime: iso(T0),
      GlobalPacketSizes: sig.packetSizes.join(','),
      TicksInMses: sig.ticksMs.join(','),
      GlobalSequences: sig.sequences.join(','),
      TimeDomainData: sig.dados
    }]
  };
}

/* ------------------------------------------------------------------- CLI  */
function escrever(nome, sig) {
  fs.mkdirSync(OUT, { recursive: true });
  const jsonPath = path.join(OUT, nome + '.json');
  const truthPath = path.join(OUT, nome + '.truth.json');
  fs.writeFileSync(jsonPath, JSON.stringify(comoPerceptJson(sig, nome)));
  fs.writeFileSync(truthPath, JSON.stringify(sig.truth));
  const kb = f => (fs.statSync(f).size / 1024).toFixed(0);
  console.log(`  ${nome}.json (${kb(jsonPath)} KB) + ${nome}.truth.json (${kb(truthPath)} KB)`);
  return { jsonPath, truthPath };
}

function principal() {
  const sweep = arg('snr-sweep', null);
  const perdas = arg('packet-loss', null);
  const preset = arg('preset', null);

  if (sweep) {
    const [ini, passo, fim] = sweep.split(':').map(Number);
    console.log(`Varredura de SNR de ${ini} a ${fim} dB (passo ${passo}), preset ${preset || 'pd'}:`);
    for (let snr = ini; snr <= fim; snr += passo)
      escrever(`snr_${snr >= 0 ? 'p' : 'm'}${Math.abs(snr)}`, gerarSinal({ preset: preset || 'pd', snrDb: snr }));
  } else if (perdas) {
    console.log(`Varredura de perda de pacotes (${perdas}%), preset ${preset || 'pd'}:`);
    perdas.split(',').map(Number).forEach(pct =>
      escrever(`loss_${pct}`, gerarSinal({ preset: preset || 'pd', snrDb: 0, packetLossPct: pct })));
  } else {
    const ps = preset ? [preset] : Object.keys(PRESETS);
    console.log('Gerando um sinal por perfil de doença:');
    ps.forEach(p => escrever(`sintetico_${p}`, gerarSinal({ preset: p, snrDb: 0 })));
  }
  console.log(`\nCada .truth.json traz: frequências e amplitudes de pico, expoente aperiódico,`);
  console.log(`posições exatas dos picos R, índices exatos dos pacotes perdidos, fs efetiva real,`);
  console.log(`instantes e durações dos bursts injetados e o sinal limpo de referência.`);
}

if (import.meta.url === `file://${process.argv[1]}`) principal();
export { PRESETS };
