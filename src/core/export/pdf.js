/* export/pdf.js — escritor de PDF do zero.

   POR QUE. Até aqui o relatório saía por `window.print()`: o resultado dependia
   do navegador, da impressora virtual e das margens que o usuário tinha
   configurado, e num mesmo computador dois cliques podiam produzir arquivos
   diferentes. Um relatório que vai para prontuário ou para material suplementar
   precisa ser o MESMO arquivo sempre. Aqui o PDF é escrito byte a byte.

   O QUE ESTÁ IMPLEMENTADO: PDF 1.4, páginas A4, texto em Helvetica e
   Helvetica-Bold (fontes base-14, que não precisam ser embutidas), quebra de
   linha com as LARGURAS REAIS dos glifos, tabelas simples, e figuras embutidas
   como JPEG via filtro DCTDecode — o canvas já entrega JPEG, então a imagem
   entra sem recodificação e sem precisar de deflate.

   CODIFICAÇÃO. O texto sai em WinAnsiEncoding, que cobre o Latin-1 inteiro e
   portanto todo o português. Os poucos sinais tipográficos fora do Latin-1 que
   este software usa (travessão, aspas curvas, reticências, ≥, ≤, ×, ·) são
   mapeados para o equivalente WinAnsi ou para um substituto ASCII — e o que
   ainda assim não couber vira '?', em vez de corromper o deslocamento do
   arquivo.

   O QUE NÃO ESTÁ: compressão de fluxo (exigiria deflate, e a dependência zero
   vale aqui também), fontes embutidas, PDF/A. O arquivo é maior do que
   precisaria ser; em troca, é escrito sem nenhuma biblioteca.

   Referência: ISO 32000-1 (PDF 1.7), seções 7 (sintaxe) e 9 (texto).        */

/* Larguras da Helvetica em milésimos de em, ASCII 32–126. */
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

/* Fora do Latin-1: mapeia para o byte WinAnsi correspondente, ou para ASCII. */
const MAPA = {
  '—': '\x97', '–': '\x96', '‘': '\x91', '’': '\x92',
  '“': '\x93', '”': '\x94', '…': '\x85', '•': '\x95',
  '≥': '>=', '≤': '<=', '≈': '~', '·': '\xB7',
  '→': '->', '←': '<-', '×': '\xD7', 'χ': 'chi',
  'β': 'beta', 'α': 'alfa', 'θ': 'teta', 'δ': 'delta',
  'γ': 'gama', 'μ': '\xB5', '²': '\xB2', '³': '\xB3',
  '⁰': '0', '°': '\xB0', '−': '-', ' ': ' ',
  '●': '*', '✓': 'v', '✗': 'x', '↧': '', '⤓': '', '▸': '>', '▶': '>',
  '↔': '<->', '↑': '^', '↓': 'v', '≠': '!=', '∈': 'em', '∞': 'inf',
  'ρ': 'rho', 'η': 'eta', 'τ': 'tau', 'σ': 'sigma', 'λ': 'lambda', 'ω': 'omega',
  'φ': 'phi', 'Δ': 'delta', 'Σ': 'soma', 'π': 'pi', 'ψ': 'psi', 'ε': 'epsilon',
  '½': '\xBD', '¼': '\xBC', '¾': '\xBE', '‰': '\x89', '†': '\x86', '‡': '\x87',
  '\u2212': '-', '\u2009': ' ', '\u200B': '', '\u00AD': ''
};

/* Diagnóstico: quais caracteres de um texto NÃO têm representação e virariam
   '?'. Existe para que a lacuna do mapa seja mensurável em teste, e não
   descoberta por alguém lendo o PDF. */
export function unmappedChars(txt) {
  const fora = new Set();
  for (const ch of String(txt == null ? '' : txt)) {
    if (ch.codePointAt(0) < 256) continue;
    if (MAPA[ch] != null) continue;
    fora.add(ch);
  }
  return Array.from(fora);
}

/* Converte para bytes WinAnsi. Devolve string cujos códigos são todos < 256. */
function winAnsi(txt) {
  let out = '';
  for (const ch of String(txt == null ? '' : txt)) {
    const c = ch.codePointAt(0);
    if (c < 256) { out += ch; continue; }
    out += (MAPA[ch] != null) ? MAPA[ch] : '?';
  }
  return out;
}
const escapa = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/* Largura de um texto, em pontos. */
export function textWidth(txt, size, bold) {
  const tab = bold ? W_BOLD : W_REG;
  let w = 0;
  const s = winAnsi(txt);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    w += (c >= 32 && c <= 126) ? tab[c - 32] : 556;   /* acentuadas ≈ base */
  }
  return w * size / 1000;
}

/* Quebra o texto em linhas que cabem em `larg`. */
function quebra(txt, size, bold, larg) {
  const palavras = String(txt).split(/\s+/).filter(Boolean);
  const linhas = [];
  let atual = '';
  palavras.forEach(p => {
    const teste = atual ? atual + ' ' + p : p;
    if (textWidth(teste, size, bold) <= larg) atual = teste;
    else {
      if (atual) linhas.push(atual);
      /* palavra sozinha maior que a linha: corta */
      let resto = p;
      while (textWidth(resto, size, bold) > larg && resto.length > 1) {
        let n = resto.length;
        while (n > 1 && textWidth(resto.slice(0, n), size, bold) > larg) n--;
        linhas.push(resto.slice(0, n)); resto = resto.slice(n);
      }
      atual = resto;
    }
  });
  if (atual) linhas.push(atual);
  return linhas.length ? linhas : [''];
}

/* Decodifica um data URL de JPEG para bytes. */
function jpegDeDataUrl(url) {
  const i = String(url).indexOf(',');
  if (i < 0) return null;
  const bin = (typeof atob === 'function') ? atob(url.slice(i + 1))
    : Buffer.from(url.slice(i + 1), 'base64').toString('binary');
  const b = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) b[k] = bin.charCodeAt(k);
  return b;
}

/* buildPdf(doc) → Uint8Array
   doc: {
     title, subtitle, footer,
     blocks: [ {type:'h1'|'h2'|'p'|'kv'|'table'|'note'|'pagebreak', ...} ],
     figures: [ {id, title, dataUrl, width, height, caption} ]
   }                                                                          */
export function buildPdf(doc) {
  doc = doc || {};
  const A4 = { w: 595.28, h: 841.89 };
  const M = { l: 48, r: 48, t: 54, b: 52 };
  const larguraUtil = A4.w - M.l - M.r;

  const paginas = [];           /* cada uma: { ops: [], imagens: [refIdx] } */
  let ops = [], imagensDaPagina = [];
  let y = A4.h - M.t;
  const imagens = [];           /* {bytes, w, h} */

  const novaPagina = () => {
    paginas.push({ ops, imagens: imagensDaPagina });
    ops = []; imagensDaPagina = []; y = A4.h - M.t;
  };
  const espaco = h => { if (y - h < M.b) novaPagina(); };
  const texto = (s, size, bold, cor, x) => {
    const t = escapa(winAnsi(s));
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${cor || '0 0 0'} rg ${(x == null ? M.l : x).toFixed(2)} ${y.toFixed(2)} Td (${t}) Tj ET`);
  };
  const paragrafo = (s, opt) => {
    opt = opt || {};
    const size = opt.size || 9.5, bold = !!opt.bold, lh = size * 1.38;
    const larg = larguraUtil - (opt.indent || 0);
    quebra(s, size, bold, larg).forEach(l => {
      espaco(lh);
      texto(l, size, bold, opt.color, M.l + (opt.indent || 0));
      y -= lh;
    });
  };
  const regra = () => {
    espaco(8);
    ops.push(`0.78 0.83 0.86 RG 0.7 w ${M.l} ${y.toFixed(2)} m ${(A4.w - M.r).toFixed(2)} ${y.toFixed(2)} l S`);
    y -= 8;
  };

  /* capa */
  texto(doc.title || 'Relatório', 17, true); y -= 22;
  if (doc.subtitle) { texto(doc.subtitle, 9.5, false, '0.35 0.42 0.48'); y -= 16; }
  regra();

  (doc.blocks || []).forEach(b => {
    if (b.type === 'pagebreak') { novaPagina(); return; }
    if (b.type === 'h1') { espaco(26); y -= 8; texto(b.text, 13, true); y -= 17; regra(); return; }
    if (b.type === 'h2') { espaco(20); y -= 5; texto(b.text, 10.5, true, '0.05 0.20 0.30'); y -= 15; return; }
    if (b.type === 'p') { paragrafo(b.text, { size: b.size || 9.5 }); y -= 4; return; }
    if (b.type === 'note') {
      paragrafo(b.text, { size: 8.4, color: '0.30 0.38 0.44', indent: 8 });
      y -= 5; return;
    }
    if (b.type === 'kv') {
      (b.rows || []).forEach(([k, v]) => {
        const lh = 12.6;
        const larguraChave = 132;
        const linhas = quebra(String(v == null ? '—' : v), 9, false, larguraUtil - larguraChave);
        espaco(lh * linhas.length);
        texto(String(k), 9, false, '0.42 0.50 0.56');
        linhas.forEach((l, i) => {
          if (i > 0) y -= lh;
          texto(l, 9, false, '0 0 0', M.l + larguraChave);
        });
        y -= lh;
      });
      y -= 5; return;
    }
    if (b.type === 'table') {
      const cols = b.cols || [], linhas = b.rows || [];
      const n = cols.length || 1;
      const larguras = b.widths && b.widths.length === n
        ? b.widths.map(w => w * larguraUtil)
        : new Array(n).fill(larguraUtil / n);
      const lh = 12;
      espaco(lh * 2);
      let x = M.l;
      cols.forEach((c, i) => { texto(String(c), 8.2, true, '0.28 0.36 0.42', x); x += larguras[i]; });
      y -= 4;
      ops.push(`0.78 0.83 0.86 RG 0.6 w ${M.l} ${y.toFixed(2)} m ${(A4.w - M.r).toFixed(2)} ${y.toFixed(2)} l S`);
      y -= lh - 2;
      linhas.forEach(linha => {
        /* altura da linha = maior número de linhas quebradas entre as células */
        const celulas = linha.map((c, i) => quebra(String(c == null ? '' : c), 8.2, false, larguras[i] - 6));
        const alt = lh * Math.max.apply(null, celulas.map(c => c.length));
        espaco(alt);
        let xx = M.l;
        celulas.forEach((cel, i) => {
          cel.forEach((l, j) => texto(l, 8.2, false, '0 0 0', xx, y - j * lh));
          /* o texto acima usa o y corrente; desenha manualmente cada linha */
          xx += larguras[i];
        });
        /* redesenha corretamente cada sublinha (o helper `texto` usa `y` global) */
        ops.length = ops.length - celulas.reduce((a, c) => a + c.length, 0);
        xx = M.l;
        celulas.forEach((cel, i) => {
          cel.forEach((l, j) => {
            const t = escapa(winAnsi(l));
            ops.push(`BT /F1 8.2 Tf 0 0 0 rg ${xx.toFixed(2)} ${(y - j * lh).toFixed(2)} Td (${t}) Tj ET`);
          });
          xx += larguras[i];
        });
        y -= alt;
      });
      y -= 8; return;
    }
  });

  /* figuras: uma por página, escalada para caber */
  (doc.figures || []).forEach(fig => {
    const bytes = jpegDeDataUrl(fig.dataUrl);
    if (!bytes) return;
    novaPagina();
    texto(`${fig.id} — ${fig.title || ''}`, 11.5, true); y -= 18;
    if (fig.caption) { paragrafo(fig.caption, { size: 8.6, color: '0.30 0.38 0.44' }); y -= 4; }
    const dispW = larguraUtil;
    const escala = Math.min(dispW / fig.width, (y - M.b) / fig.height);
    const w = fig.width * escala, h = fig.height * escala;
    const idx = imagens.length;
    imagens.push({ bytes, w: fig.width, h: fig.height });
    imagensDaPagina.push(idx);
    ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${M.l.toFixed(2)} ${(y - h).toFixed(2)} cm /Im${idx} Do Q`);
    y -= h + 10;
  });
  novaPagina();

  /* rodapé com número de página em todas */
  paginas.forEach((pg, i) => {
    const t = escapa(winAnsi(`${doc.footer || 'Percept LFP Studio'}  ·  página ${i + 1} de ${paginas.length}`));
    pg.ops.push(`BT /F1 7.6 Tf 0.45 0.52 0.58 rg ${M.l} ${(M.b - 22).toFixed(2)} Td (${t}) Tj ET`);
  });

  /* ---------------- montagem do arquivo ---------------------------------- */
  const objetos = [];                        /* strings ou {bin: Uint8Array} */
  const add = o => { objetos.push(o); return objetos.length; };   /* 1-based */

  const idCatalogo = add(null);              /* reservado */
  const idPaginas = add(null);
  const idF1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const idF2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  const idImagens = imagens.map(im => add({
    dict: `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>`,
    bin: im.bytes
  }));

  const idsPagina = [];
  paginas.forEach(pg => {
    const conteudo = pg.ops.join('\n');
    const idConteudo = add({ dict: `<< /Length ${winAnsi(conteudo).length} >>`, texto: conteudo });
    const xobj = pg.imagens.length
      ? ' /XObject << ' + pg.imagens.map(i => `/Im${i} ${idImagens[i]} 0 R`).join(' ') + ' >>'
      : '';
    idsPagina.push(add(
      `<< /Type /Page /Parent ${idPaginas} 0 R /MediaBox [0 0 ${A4.w.toFixed(2)} ${A4.h.toFixed(2)}] ` +
      `/Resources << /Font << /F1 ${idF1} 0 R /F2 ${idF2} 0 R >>${xobj} >> /Contents ${idConteudo} 0 R >>`));
  });

  objetos[idCatalogo - 1] = `<< /Type /Catalog /Pages ${idPaginas} 0 R >>`;
  objetos[idPaginas - 1] = `<< /Type /Pages /Count ${idsPagina.length} /Kids [${idsPagina.map(i => i + ' 0 R').join(' ')}] >>`;

  /* serializa */
  const partes = [];
  let tamanho = 0;
  const empurra = s => {
    if (typeof s === 'string') {
      const b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
      partes.push(b); tamanho += b.length;
    } else { partes.push(s); tamanho += s.length; }
  };

  empurra('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const offsets = new Array(objetos.length + 1).fill(0);
  objetos.forEach((o, i) => {
    offsets[i + 1] = tamanho;
    empurra(`${i + 1} 0 obj\n`);
    if (o && o.bin) { empurra(o.dict + '\nstream\n'); empurra(o.bin); empurra('\nendstream\n'); }
    else if (o && o.texto != null) { empurra(o.dict + '\nstream\n' + winAnsi(o.texto) + '\nendstream\n'); }
    else empurra(String(o) + '\n');
    empurra('endobj\n');
  });
  const inicioXref = tamanho;
  let xref = `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objetos.length; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  empurra(xref);
  empurra(`trailer\n<< /Size ${objetos.length + 1} /Root ${idCatalogo} 0 R >>\nstartxref\n${inicioXref}\n%%EOF\n`);

  const out = new Uint8Array(tamanho);
  let off = 0;
  partes.forEach(p => { out.set(p, off); off += p.length; });
  return {
    bytes: out,
    meta: {
      pages: paginas.length, objects: objetos.length, images: imagens.length,
      bytes: out.length, pageSize: 'A4', fonts: ['Helvetica', 'Helvetica-Bold'],
      note: 'PDF 1.4 sem compressão de fluxo; imagens embutidas como JPEG (DCTDecode). ' +
        'Texto em WinAnsiEncoding, que cobre todo o português.'
    }
  };
}
