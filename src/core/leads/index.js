/* leads/index.js — geometria dos eletrodos de DBS, em escala real.

   POR QUE ISTO EXISTE. Toda figura deste software fala de contatos — "par 1-3",
   "catodo em 2b", "contato 0 com impedância alta" — e até aqui esses nomes eram
   só texto. Um par bipolar "0-3" no eletrodo 3389 abrange 7,5 mm; no 3391, 24 mm.
   São situações anatômicas diferentes com o mesmo rótulo, e quem lê o gráfico não
   tem como saber qual está vendo. Um desenho em escala, com os contatos em uso
   marcados, resolve isso sem que ninguém precise decorar tabela de modelo.

   O QUE ESTE MÓDULO É. Dados de geometria e leitura de nome de canal. Nenhum
   desenho: quem desenha é a camada de plotagem, que recebe estas medidas em
   MILÍMETROS e decide a escala em pixels. Nenhuma dependência — é a camada mais
   baixa possível.

   O QUE ELE NÃO SABE, E DIZ QUE NÃO SABE. O ÂNGULO REAL dos segmentos no crânio
   depende da rotação do eletrodo no implante, e essa informação não está no JSON
   do Percept: ela vem do marcador radiopaco na radiografia intraoperatória. O
   desenho usa a convenção do fabricante (marcador proximal alinhado a 1a/2a,
   distal a 1b/2b, a→b→c anti-horário visto da extremidade proximal) como
   REFERÊNCIA DE NOMENCLATURA, e a saída declara que a orientação anatômica não
   é derivável deste arquivo. `LeadConfiguration` traz um valor de orientação em
   graus para eletrodos SenSight (UC202012929cEN FY24, p. 26), que esta versão
   não usa — está registrado em docs/auditoria-whitepaper.md (item C3).

   Unidades: todas as dimensões em MILÍMETROS; ângulos em graus.

   Fontes das medidas:
     Medtronic. Manual de implante dos eletrodos 3387/3389 (2020).
     Medtronic. Manual de implante SenSight B33005/B33015 (2021).
     Medtronic. UC202012929cEN FY24 (nomenclatura dos contatos no JSON,
       compatibilidade e orientação do SenSight).
   O modelo 3391 é a exceção declarada: as medidas vêm de catálogo e da
   literatura, não do manual conferido, e saem marcadas com
   `dimensionsVerified: false`.                                              */

/* ------------------------------------------------------------- modelos --- */

const LEAD_COMUM_ANEL = {
  family: 'ring',
  nContacts: 4,
  bodyDiameterMm: 1.27,
  contactMaterial: 'platina-irídio',
  bodyMaterial: 'poliuretano',
  connector: 'quadripolar in-line: contatos de 2,3 mm espaçados 4,3 mm, extensão de 16,6 mm',
  conductorOhms: '< 100 Ω',
  dimensionsVerified: true,
  source: 'Medtronic, manual de implante 3387/3389 (2020)'
};

const LEAD_COMUM_SEG = {
  family: 'directional',
  nLevels: 4,
  architecture: '1-3-3-1',
  bodyDiameterMm: 1.36,
  tipMm: 1.0,
  levelHeightMm: 1.5,
  segmentSpanDeg: 120,
  contactMaterial: 'platina-irídio',
  connector: '8 contatos in-line, espaçados 2,2 mm (17,5 mm no total)',
  lengthsCm: [33, 42],
  extension: 'B34000 (compatibilidade fechada, só com Percept PC/RC)',
  cannulaIdMinMm: [1.42, 1.57],
  burrHoleMm: 14,
  dimensionsVerified: true,
  source: 'Medtronic, manual de implante SenSight B33005/B33015 (2021)'
};

export const LEAD_MODELS = {
  '3389': Object.assign({}, LEAD_COMUM_ANEL, {
    id: '3389', label: 'Medtronic 3389',
    tipMm: 1.5, contactHeightMm: 1.5, spacingMm: 0.5, arrayLengthMm: 7.5,
    lengthsCm: [28, 40],
    typicalTargets: 'STN, GPi (alvos compactos)'
  }),
  '3387': Object.assign({}, LEAD_COMUM_ANEL, {
    id: '3387', label: 'Medtronic 3387',
    tipMm: 1.5, contactHeightMm: 1.5, spacingMm: 1.5, arrayLengthMm: 10.5,
    lengthsCm: [28, 40],
    typicalTargets: 'VIM, ANT (epilepsia), GPi, alvos mais extensos'
  }),
  '3391': Object.assign({}, LEAD_COMUM_ANEL, {
    id: '3391', label: 'Medtronic 3391',
    tipMm: 1.5, contactHeightMm: 3.0, spacingMm: 4.0, arrayLengthMm: 24.0,
    lengthsCm: [28, 40],
    typicalTargets: 'VC/VS e alvos alongados; maior área por contato → impedâncias menores',
    /* a honestidade que o resto do software exige também vale para uma medida */
    dimensionsVerified: false,
    source: 'catálogo e literatura — NÃO conferido no manual de implante; confirme antes de publicar'
  }),
  'B33005': Object.assign({}, LEAD_COMUM_SEG, {
    id: 'B33005', label: 'Medtronic SenSight B33005',
    spacingMm: 0.5, arrayLengthMm: 7.5,
    surfaceAreaCm2: { 33: 13.55, 42: 17.26 },
    typicalTargets: 'STN, GPi (equivalente direcional do 3389)'
  }),
  'B33015': Object.assign({}, LEAD_COMUM_SEG, {
    id: 'B33015', label: 'Medtronic SenSight B33015',
    spacingMm: 1.5, arrayLengthMm: 10.5,
    surfaceAreaCm2: { 33: 13.55, 42: 17.26 },
    typicalTargets: 'alvos mais extensos (equivalente direcional do 3387)'
  })
};

/* ---------------------------------------------------- resolução do modelo - */

/* leadSpec(model) — resolve a string de modelo do JSON para uma especificação.

   O campo `LeadConfiguration.Model` do Percept traz coisas como
   "LeadModelDef.B33005" ou "Model 3389". Nunca inventa: modelo não reconhecido
   devolve `identified: false` com o texto original, e quem desenha mostra um
   esquema genérico com o aviso de que a geometria não é a real.             */
export function leadSpec(model) {
  const bruto = String(model == null ? '' : model);
  const s = bruto.toUpperCase().replace(/[^A-Z0-9]/g, '');
  /* o sufixo M (ex.: B3300533M) indica marcadores bilaterais e não muda a
     geometria dos contatos — é registrado e não altera a escolha do modelo */
  const bilateral = /B330(05|15)\d*M$/.test(s);
  const achado = ['B33005', 'B33015', '3389', '3387', '3391'].find(k => s.indexOf(k) >= 0);
  if (!achado) return {
    identified: false, id: null, label: bruto || '(modelo não declarado)',
    raw: bruto,
    reason: bruto
      ? `o modelo "${bruto}" não está entre os que este software conhece (3387, 3389, 3391, B33005, B33015)`
      : 'o arquivo não declara o modelo do eletrodo em LeadConfiguration'
  };
  return Object.assign({}, LEAD_MODELS[achado], {
    identified: true, raw: bruto,
    bilateralMarkers: bilateral,
    bilateralNote: bilateral
      ? 'sufixo M: dois marcadores bilaterais adicionais para distinguir hemisférios na radiografia'
      : null,
    reason: null
  });
}

/* leadsOf(parsed) — modelo por hemisfério, direto do LeadConfiguration. */
export function leadsOf(parsed) {
  const out = {};
  ((parsed && parsed.leads) || []).forEach(l => {
    if (!l || !l.hemisphere) return;
    out[l.hemisphere] = {
      hemisphere: l.hemisphere,
      target: l.target || null,
      port: l.port || null,
      spec: leadSpec(l.model)
    };
  });
  return out;
}

/* -------------------------------------------------- nomes dos contatos --- */

const LEAD_NUM = { ZERO: 0, ONE: 1, TWO: 2, THREE: 3 };

/* contactsOfChannel(channel) — quais contatos um nome de canal referencia.

   Aceita as formas que aparecem no JSON do Percept:
     ZERO_THREE_LEFT              → ['0', '3']
     ONE_AND_THREE_RIGHT          → ['1', '3']
     ONE_C_AND_TWO_C_LEFT         → ['1c', '2c']
     ZERO_A_AND_TWO_LEFT_RING     → ['0a', '2']
   Devolve [] quando não reconhece — nunca adivinha.                        */
export function contactsOfChannel(channel) {
  if (!channel) return [];
  let s = String(channel).toUpperCase();
  s = s.replace(/^.*?DEF\./, '');                       /* SensingChannelDef. */
  s = s.replace(/_(LEFT|RIGHT)(_RING|_SEGMENT)?$/g, '').replace(/_(LEFT|RIGHT)$/g, '');
  /* o separador tem de sair ANTES da varredura: sem isso o "A" de "_AND_" é
     lido como o segmento a, e ONE_AND_THREE vira 1a-3 em vez de 1-3 */
  s = s.replace(/_AND_/g, '|');
  const achados = [];
  const re = /(ZERO|ONE|TWO|THREE)(?:_?([ABC])(?![A-Z]))?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = LEAD_NUM[m[1]];
    achados.push(String(n) + (m[2] ? m[2].toLowerCase() : ''));
  }
  /* A FORMA CURTA também precisa ser aceita. `prettyChannel` já converte
     ZERO_AND_THREE em "0-3" no parser, e é essa string que circula pelos
     rótulos das figuras — exigir só a forma verbosa faria o desenho sumir
     exatamente onde o rótulo é mais usado. */
  if (!achados.length) {
    const re2 = /(?:^|[^0-9a-z])([0-3])([abc])?(?![0-9])/gi;
    let m2;
    while ((m2 = re2.exec(String(channel).toLowerCase())) !== null) {
      achados.push(m2[1] + (m2[2] ? m2[2].toLowerCase() : ''));
    }
  }
  /* remove repetição preservando a ordem: "0-0" não é par */
  return achados.filter((v, i) => achados.indexOf(v) === i);
}

/* contactId → { level, segment } */
export function parseContactId(id) {
  const m = /^([0-3])([abc])?$/.exec(String(id || '').toLowerCase());
  if (!m) return null;
  return { level: +m[1], segment: m[2] || null, id: m[0] };
}

/* ------------------------------------------------------ geometria em mm -- */

/* leadGeometry(spec) — posição de cada contato ao longo do eletrodo.

   Origem em z = 0 na PONTA DISTAL. O contato 0 é o mais distal, logo acima da
   ponta romba. Para eletrodos direcionais, os níveis 1 e 2 devolvem três
   segmentos cada, com o ângulo central pela convenção do fabricante.

   Devolve também `totalMm` (ponta + arranjo), para que quem desenha possa
   escalar sem recalcular.                                                    */
export function leadGeometry(spec) {
  if (!spec || !spec.identified) return {
    ok: false, contacts: [], totalMm: NaN,
    reason: (spec && spec.reason) || 'modelo de eletrodo não identificado'
  };
  const h = spec.family === 'directional' ? spec.levelHeightMm : spec.contactHeightMm;
  const passo = h + spacingOf(spec);
  const contatos = [];
  for (let k = 0; k < 4; k++) {
    const z0 = spec.tipMm + k * passo;
    const z1 = z0 + h;
    const segmentado = spec.family === 'directional' && (k === 1 || k === 2);
    if (!segmentado) {
      contatos.push({
        id: String(k), level: k, segment: null, z0: +z0.toFixed(3), z1: +z1.toFixed(3),
        heightMm: h, ring: true, angleDeg: null, spanDeg: 360
      });
    } else {
      ['a', 'b', 'c'].forEach((seg, i) => contatos.push({
        id: String(k) + seg, level: k, segment: seg,
        z0: +z0.toFixed(3), z1: +z1.toFixed(3), heightMm: h, ring: false,
        /* a → b → c anti-horário visto da extremidade PROXIMAL; o ângulo é de
           NOMENCLATURA, não anatômico — ver o cabeçalho deste módulo */
        angleDeg: i * 120, spanDeg: spec.segmentSpanDeg
      }));
    }
  }
  return {
    ok: true,
    contacts: contatos,
    tipMm: spec.tipMm,
    arrayLengthMm: spec.arrayLengthMm,
    totalMm: +(spec.tipMm + spec.arrayLengthMm).toFixed(3),
    diameterMm: spec.bodyDiameterMm,
    family: spec.family,
    orientationNote: spec.family === 'directional'
      ? 'os ângulos são de NOMENCLATURA (marcador proximal → 1a/2a, distal → 1b/2b, a→b→c anti-horário visto da ' +
        'extremidade proximal). A orientação ANATÔMICA real depende da rotação no implante e NÃO está no JSON do ' +
        'Percept — ela vem do marcador radiopaco na radiografia intraoperatória'
      : 'todos os contatos são anéis de 360°: o campo é radialmente simétrico, e não há como afastar a corrente de ' +
        'uma estrutura vizinha sem reduzir a amplitude',
    reason: null
  };
}

function spacingOf(spec) { return spec.spacingMm; }

/* expandContacts(ids, geo) — resolve um nível para os segmentos que ele contém.

   POR QUE ISTO É NECESSÁRIO E NÃO É COSMÉTICA. Num eletrodo direcional NÃO
   EXISTE um contato "1": o nível 1 é dividido em 1a, 1b e 1c. Quando o
   dispositivo registra ou estimula "1-3", ele está usando o NÍVEL 1 inteiro —
   os três segmentos em curto, funcionando como anel. Marcar só "1" no desenho
   não destacaria contato nenhum, e o gráfico diria, em silêncio, que o nível
   não está em uso.

   Devolve também `expanded`, para que a interface possa dizer que a marcação
   de um nível inteiro é o comportamento do aparelho e não uma escolha do
   software.                                                                  */
export function expandContacts(ids, geo) {
  if (!geo || !geo.ok) return { ids: (ids || []).slice(), expanded: [], note: null };
  const existentes = new Set(geo.contacts.map(c => c.id));
  const out = [], expandidos = [];
  (ids || []).forEach(raw => {
    const id = String(raw).toLowerCase();
    if (existentes.has(id)) { out.push(id); return; }
    const p = parseContactId(id);
    if (!p || p.segment) return;                    /* não existe e não é nível */
    const segs = geo.contacts.filter(c => c.level === p.level).map(c => c.id);
    if (!segs.length) return;
    segs.forEach(x => out.push(x));
    expandidos.push({ level: p.level, segments: segs });
  });
  const unicos = out.filter((v, i) => out.indexOf(v) === i);
  return {
    ids: unicos,
    expanded: expandidos,
    note: expandidos.length
      ? `o${expandidos.length > 1 ? 's' : ''} nível${expandidos.length > 1 ? 'eis' : ''} ` +
        expandidos.map(e => e.level).join(' e ') + ' aparece' + (expandidos.length > 1 ? 'm' : '') +
        ' com todos os segmentos marcados porque num eletrodo direcional não existe contato anelar nesse nível: ' +
        'o aparelho usa os três segmentos em curto, funcionando como anel'
      : null
  };
}

/* leadSummary(spec) — uma linha para o selo das figuras. */
export function leadSummary(spec) {
  if (!spec || !spec.identified) return (spec && spec.reason) || 'eletrodo não identificado';
  const g = leadGeometry(spec);
  return `${spec.label} · ${spec.family === 'directional' ? '8 contatos, arquitetura 1-3-3-1' : '4 contatos anelares'} · ` +
    `altura ${spec.family === 'directional' ? spec.levelHeightMm : spec.contactHeightMm} mm, ` +
    `espaçamento ${spec.spacingMm} mm, arranjo de ${spec.arrayLengthMm} mm · Ø ${spec.bodyDiameterMm} mm` +
    (spec.dimensionsVerified ? '' : ' · MEDIDAS NÃO CONFERIDAS NO MANUAL') +
    (g.ok ? '' : '');
}

/* leadSpan(spec, contatos) — a que distância física estão dois contatos.

   É o número que torna "par 0-3" interpretável: no 3389 são 7,5 mm de arranjo,
   no 3391 são 24 mm. O par tem o mesmo NOME e cobre territórios diferentes.  */
export function leadSpan(spec, ids) {
  const g = leadGeometry(spec);
  if (!g.ok) return { ok: false, reason: g.reason };
  const exp = expandContacts(ids, g);
  const alvo = exp.ids.map(x => g.contacts.find(c => c.id === x)).filter(Boolean);
  if (alvo.length < 2) return { ok: false, reason: 'são necessários dois contatos identificáveis' };
  const centros = alvo.map(c => (c.z0 + c.z1) / 2);
  const d = Math.max.apply(null, centros) - Math.min.apply(null, centros);
  const z0 = Math.min.apply(null, alvo.map(c => c.z0));
  const z1 = Math.max.apply(null, alvo.map(c => c.z1));
  return {
    ok: true,
    centerDistanceMm: +d.toFixed(3),
    coveredSpanMm: +(z1 - z0).toFixed(3),
    fromTipMm: [+z0.toFixed(3), +z1.toFixed(3)],
    ids: alvo.map(c => c.id),
    note: `os centros distam ${d.toFixed(1)} mm e o par abrange ${(z1 - z0).toFixed(1)} mm do eletrodo` +
      (spec.dimensionsVerified ? '' : ' (medidas do modelo não conferidas no manual)')
  };
}
