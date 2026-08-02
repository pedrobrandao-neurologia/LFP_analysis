/* io/timezone.js — fuso robusto: horário de verão e viagens como quebra.

   POR QUE ISTO EXISTE. Os timestamps do Percept estão em UTC e o app aplicava um
   único offset global. van Rheede et al. tiveram de corrigir manualmente as
   transições de horário de verão; é fonte SILENCIOSA de erro em análise
   circadiana — a acrofase sai deslocada em 1 h sem qualquer aviso.

   A análise circadiana passa a rodar POR SEGMENTO de offset constante, nunca
   cruzando uma quebra. Tabela de transições embutida (sem rede) para Brasil
   (até 2019, quando o horário de verão foi extinto), União Europeia e EUA; para
   o resto, entrada manual.                                                    */

const DIA = 864e5;

/* n-ésimo domingo de um mês (n = 1..5; -1 = último), às `horaUtc` UTC. */
function domingoDe(ano, mes, n, horaUtc) {
  if (n > 0) {
    const d = new Date(Date.UTC(ano, mes, 1));
    const desloc = (7 - d.getUTCDay()) % 7;
    return Date.UTC(ano, mes, 1 + desloc + (n - 1) * 7, horaUtc);
  }
  const ultimo = new Date(Date.UTC(ano, mes + 1, 0));
  return Date.UTC(ano, mes, ultimo.getUTCDate() - ultimo.getUTCDay(), horaUtc);
}

/* Transições conhecidas por região, no intervalo de anos pedido.
   Cada transição: { t (ms UTC), deltaMin, label }.                           */
export function dstTransitions(regiao, anoIni, anoFim) {
  const out = [];
  for (let a = anoIni; a <= anoFim; a++) {
    if (regiao === 'BR') {
      /* Brasil: horário de verão extinto em 2019 (Decreto 9.772/2019).
         Antes disso: início no 3º domingo de outubro, fim no 3º domingo de
         fevereiro (adiado uma semana quando coincidia com o Carnaval). */
      if (a <= 2018) out.push({ t: domingoDe(a, 9, 3, 3), deltaMin: +60, label: `início do horário de verão ${a}` });
      if (a <= 2019) out.push({ t: domingoDe(a, 1, 3, 2), deltaMin: -60, label: `fim do horário de verão ${a}` });
    } else if (regiao === 'EU') {
      /* UE: último domingo de março e de outubro, às 01:00 UTC */
      out.push({ t: domingoDe(a, 2, -1, 1), deltaMin: +60, label: `início do horário de verão ${a} (UE)` });
      out.push({ t: domingoDe(a, 9, -1, 1), deltaMin: -60, label: `fim do horário de verão ${a} (UE)` });
    } else if (regiao === 'US') {
      /* EUA: 2º domingo de março e 1º domingo de novembro, 2h local (~7h UTC) */
      out.push({ t: domingoDe(a, 2, 2, 7), deltaMin: +60, label: `início do horário de verão ${a} (EUA)` });
      out.push({ t: domingoDe(a, 10, 1, 6), deltaMin: -60, label: `fim do horário de verão ${a} (EUA)` });
    }
  }
  return out.filter(x => isFinite(x.t)).sort((a, b) => a.t - b.t);
}

/* Quebras candidatas detectadas a partir dos PRÓPRIOS dados: um salto na
   distribuição de amostras por hora local sugere que o offset mudou (viagem
   entre fusos, ou transição não prevista pela tabela).                        */
export function detectOffsetBreaks(rows, offMin, opts) {
  opts = opts || {};
  const minDias = opts.minDays || 3;
  if (!rows || rows.length < 48 * minDias) return [];
  /* centroide circular da hora local por dia; um degrau grande indica mudança */
  const porDia = new Map();
  rows.forEach(r => {
    const dia = Math.floor((r.t + offMin * 60000) / DIA);
    const h = ((r.t + offMin * 60000) % DIA) / 36e5;
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(h);
  });
  const dias = Array.from(porDia.keys()).sort((a, b) => a - b);
  if (dias.length < 2 * minDias) return [];
  /* usa a hora do MÍNIMO diário do sinal como âncora de fase (proxy estável) */
  const fase = dias.map(d => {
    const hs = porDia.get(d);
    const ang = hs.map(h => 2 * Math.PI * h / 24);
    const c = ang.reduce((a, x) => a + Math.cos(x), 0) / ang.length;
    const s = ang.reduce((a, x) => a + Math.sin(x), 0) / ang.length;
    let m = Math.atan2(s, c); if (m < 0) m += 2 * Math.PI;
    return { dia: d, hora: m / (2 * Math.PI) * 24, n: hs.length };
  });
  const quebras = [];
  for (let i = minDias; i < fase.length - minDias; i++) {
    const antes = fase.slice(Math.max(0, i - minDias), i).map(x => x.hora);
    const depois = fase.slice(i, i + minDias).map(x => x.hora);
    const md = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
    let delta = md(depois) - md(antes);
    while (delta > 12) delta -= 24; while (delta < -12) delta += 24;
    if (Math.abs(delta) >= 0.75) {
      const t = fase[i].dia * DIA - offMin * 60000;
      if (!quebras.length || t - quebras[quebras.length - 1].t > 5 * DIA)
        quebras.push({ t, deltaMin: Math.round(delta * 60), label: 'quebra detectada nos dados', source: 'dados' });
    }
  }
  return quebras;
}

/* resolveOffsets(rows, {tzRegion, manualOffsetMin, breaks}) → offset por amostra
   e a lista efetiva de quebras aplicadas.                                     */
export function resolveOffsets(rows, opts) {
  opts = opts || {};
  const base = isFinite(opts.manualOffsetMin) ? opts.manualOffsetMin : -180;
  if (!rows || !rows.length) return { offsets: [], breaks: [], base };
  const t0 = rows[0].t, t1 = rows[rows.length - 1].t;
  const anoIni = new Date(t0).getUTCFullYear(), anoFim = new Date(t1).getUTCFullYear();
  const tabela = opts.tzRegion ? dstTransitions(opts.tzRegion, anoIni, anoFim).filter(x => x.t > t0 && x.t < t1) : [];
  const detectadas = opts.detect === false ? [] : detectOffsetBreaks(rows, base, opts);
  /* quebras manuais do usuário têm precedência */
  const todas = (opts.breaks || []).concat(tabela.map(x => Object.assign({ source: 'tabela' }, x)), detectadas)
    .sort((a, b) => a.t - b.t);
  /* remove duplicatas próximas (tabela e detecção apontando a mesma transição) */
  const efetivas = [];
  todas.forEach(q => {
    const ult = efetivas[efetivas.length - 1];
    if (ult && Math.abs(q.t - ult.t) < 3 * DIA) return;
    efetivas.push(q);
  });
  const offsets = new Array(rows.length);
  let acumulado = 0, qi = 0;
  for (let i = 0; i < rows.length; i++) {
    while (qi < efetivas.length && rows[i].t >= efetivas[qi].t) { acumulado += efetivas[qi].deltaMin; qi++; }
    offsets[i] = base + acumulado;
  }
  return { offsets, breaks: efetivas, base };
}

/* segmentByOffset(rows, opts) → segmentos de offset constante.
   A análise circadiana roda por segmento; nunca através de uma quebra.        */
export function segmentByOffset(rows, opts) {
  const { offsets, breaks, base } = resolveOffsets(rows, opts);
  if (!rows.length) return { segments: [], breaks, base };
  const segments = [];
  let ini = 0;
  for (let i = 1; i <= rows.length; i++) {
    if (i === rows.length || offsets[i] !== offsets[ini]) {
      segments.push({
        offsetMin: offsets[ini], rows: rows.slice(ini, i),
        startT: rows[ini].t, endT: rows[i - 1].t,
        nDays: Math.max(1, Math.round((rows[i - 1].t - rows[ini].t) / DIA))
      });
      ini = i;
    }
  }
  return { segments, breaks, base };
}
