/* provenance/index.js — manifesto de proveniência auditável e verificável.

   POR QUE ISTO EXISTE. A revisão registra explicitamente que NÃO EXISTE padrão
   de reporte para estudos de LFP com dispositivos de sensing: parâmetros de
   Welch, critérios de exclusão de artefato, método de normalização e tratamento
   de outliers variam entre grupos e frequentemente não são reportados. Um
   manifesto auditável + checklist gerado automaticamente é ao mesmo tempo
   funcionalidade e contribuição original publicável.

   O manifesto responde, para cada número que sai do software: qual método o
   produziu, com QUAIS PARÂMETROS EFETIVOS (não os default — os usados), sobre
   quantas amostras, descartando quantas e por quê.

   `verifyManifest` fecha o ciclo: com os mesmos arquivos e o mesmo manifesto, o
   software refaz a análise e confirma que os resultados batem. É o que torna a
   reprodutibilidade VERIFICÁVEL em vez de declarada.                          */

/* SHA-256 sem dependência: crypto.subtle é nativo no navegador e no Node. */
export async function sha256Hex(dado) {
  const bytes = typeof dado === 'string' ? new TextEncoder().encode(dado) : dado;
  const sub = (globalThis.crypto && globalThis.crypto.subtle) || null;
  if (!sub) return fallbackHash(bytes);          // ambiente sem WebCrypto
  const buf = await sub.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
/* Alternativa determinística quando não há WebCrypto (FNV-1a de 128 bits em
   quatro faixas). NÃO é SHA-256 — o manifesto declara qual foi usada. */
function fallbackHash(bytes) {
  const h = [2166136261, 16777619, 2246822519, 3266489917];
  for (let i = 0; i < bytes.length; i++)
    for (let k = 0; k < 4; k++) { h[k] ^= bytes[i] + k; h[k] = Math.imul(h[k], 16777619) >>> 0; }
  return h.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

const APP_VERSION = '0.5.0';

/* createProvenance({appVersion, bundleHash, profileId, timezone, ...}) */
export function createProvenance(cab) {
  cab = cab || {};
  const inicio = cab.now || null;                /* injetado: o núcleo não lê relógio */
  const estado = {
    header: {
      tool: 'Percept LFP Studio',
      appVersion: cab.appVersion || APP_VERSION,
      bundleHash: cab.bundleHash || null,
      generatedAt: inicio,
      profileId: cab.profileId || null,
      profileLabel: cab.profileLabel || null,
      timezoneOffsetMin: cab.timezoneOffsetMin,
      timezoneBreaks: cab.timezoneBreaks || [],
      hashAlgorithm: (globalThis.crypto && globalThis.crypto.subtle) ? 'SHA-256' : 'FNV-1a-128 (sem WebCrypto)'
    },
    files: [], steps: [], figures: {}, metrics: {}, exclusions: []
  };

  const api = {
    /* Registra um passo de método com os PARÂMETROS EFETIVOS. */
    record(step, params, meta) {
      const reg = {
        id: estado.steps.length + 1,
        step,
        params: params || {},
        nIn: meta && meta.nIn, nOut: meta && meta.nOut,
        nDropped: meta && meta.nDropped,
        dropReason: meta && meta.dropReason,
        figure: meta && meta.figure,
        note: meta && meta.note
      };
      estado.steps.push(reg);
      if (reg.figure) (estado.figures[reg.figure] = estado.figures[reg.figure] || []).push(reg.id);
      return reg.id;
    },
    /* Arquivo de entrada, já pseudonimizado — nunca identificador direto. */
    file(info) {
      estado.files.push({
        name: info.name, sha256: info.sha256 || null,
        subjectId: info.subjectId || null,
        firmware: info.firmware || null, programmerVersion: info.programmerVersion || null,
        deviceModel: info.deviceModel || null, implantDate: info.implantDate || null,
        deviceStates: info.deviceStates || [],
        modalities: info.modalities || {}
      });
    },
    /* Métrica exportada → passo que a produziu. */
    metric(nome, stepId, params) {
      estado.metrics[nome] = { stepId, params: params || {} };
    },
    /* Cada dado excluído, o critério e a decisão do usuário quando houve. */
    exclusion(o) {
      estado.exclusions.push({
        what: o.what, criterion: o.criterion, decidedBy: o.decidedBy || 'automático',
        n: o.n, reason: o.reason || null
      });
    },
    manifest() {
      return JSON.parse(JSON.stringify(estado));
    },
    /* Hash do manifesto inteiro, citável em manuscrito como identificador de
       versão de análise. Exclui `generatedAt` para ser estável entre execuções
       idênticas — o que muda o hash é o MÉTODO, não o relógio. */
    async hash() {
      const m = api.manifest();
      const semData = JSON.parse(JSON.stringify(m));
      delete semData.header.generatedAt;
      return sha256Hex(canonical(semData));
    },
    get steps() { return estado.steps; },
    get header() { return estado.header; }
  };
  return api;
}

/* Serialização canônica: chaves ordenadas, para que o hash não dependa da
   ordem de inserção das propriedades. */
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

/* verifyManifest(manifesto, recomputado)
   Compara o manifesto guardado com o de uma reexecução: mesmos passos, mesmos
   parâmetros efetivos, mesmos n. Retorna as divergências, se houver.        */
export function verifyManifest(guardado, recomputado) {
  const divergencias = [];
  const a = guardado || {}, b = recomputado || {};
  const passosA = a.steps || [], passosB = b.steps || [];

  if ((a.header || {}).appVersion !== (b.header || {}).appVersion)
    divergencias.push({ campo: 'appVersion', guardado: (a.header || {}).appVersion, atual: (b.header || {}).appVersion });
  if ((a.header || {}).profileId !== (b.header || {}).profileId)
    divergencias.push({ campo: 'profileId', guardado: (a.header || {}).profileId, atual: (b.header || {}).profileId });

  /* arquivos: o hash do conteúdo precisa bater */
  (a.files || []).forEach((fa, i) => {
    const fb = (b.files || [])[i];
    if (!fb) { divergencias.push({ campo: `files[${i}]`, guardado: fa.name, atual: '(ausente)' }); return; }
    if (fa.sha256 && fb.sha256 && fa.sha256 !== fb.sha256)
      divergencias.push({ campo: `files[${i}].sha256`, guardado: fa.sha256.slice(0, 12), atual: fb.sha256.slice(0, 12) });
  });

  if (passosA.length !== passosB.length)
    divergencias.push({ campo: 'nSteps', guardado: passosA.length, atual: passosB.length });

  passosA.forEach((pa, i) => {
    const pb = passosB[i];
    if (!pb) return;
    if (pa.step !== pb.step)
      divergencias.push({ campo: `steps[${i}].step`, guardado: pa.step, atual: pb.step });
    else if (canonical(pa.params) !== canonical(pb.params))
      divergencias.push({ campo: `steps[${i}].params (${pa.step})`, guardado: canonical(pa.params), atual: canonical(pb.params) });
    else if (isFinite(pa.nOut) && isFinite(pb.nOut) && pa.nOut !== pb.nOut)
      divergencias.push({ campo: `steps[${i}].nOut (${pa.step})`, guardado: pa.nOut, atual: pb.nOut });
  });

  return {
    ok: divergencias.length === 0,
    nDivergences: divergencias.length,
    divergences: divergencias.slice(0, 50),
    verdict: divergencias.length === 0
      ? 'análise reproduzida: método, parâmetros e contagens idênticos'
      : `${divergencias.length} divergência(s) — a análise NÃO é reprodução exata do manifesto`
  };
}
