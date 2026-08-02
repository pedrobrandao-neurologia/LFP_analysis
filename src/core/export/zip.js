/* export/zip.js — escritor ZIP mínimo, sem dependência.

   Método `store` (sem compressão): é válido, é simples e mantém o invariante de
   zero dependência. Usado para gerar o DOCX do checklist (um .docx é um ZIP com
   XML dentro) e, adiante, para o pacote único de exportação.                 */

const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = TABELA_CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const paraBytes = d => typeof d === 'string' ? new TextEncoder().encode(d) : d;

/* makeZip([{name, data}]) → Uint8Array */
export function makeZip(arquivos) {
  const locais = [], centrais = [];
  let offset = 0;

  const u16 = v => [v & 0xFF, (v >>> 8) & 0xFF];
  const u32 = v => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];

  arquivos.forEach(f => {
    const nome = paraBytes(f.name), dados = paraBytes(f.data);
    const crc = crc32(dados);
    const cabecalho = [].concat(
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(dados.length), u32(dados.length),
      u16(nome.length), u16(0));
    const bloco = new Uint8Array(cabecalho.length + nome.length + dados.length);
    bloco.set(cabecalho, 0); bloco.set(nome, cabecalho.length);
    bloco.set(dados, cabecalho.length + nome.length);
    locais.push(bloco);

    const central = [].concat(
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(dados.length), u32(dados.length),
      u16(nome.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
    const blocoC = new Uint8Array(central.length + nome.length);
    blocoC.set(central, 0); blocoC.set(nome, central.length);
    centrais.push(blocoC);
    offset += bloco.length;
  });

  const tamCentral = centrais.reduce((a, b) => a + b.length, 0);
  const fim = new Uint8Array([].concat(
    u32(0x06054b50), u16(0), u16(0), u16(arquivos.length), u16(arquivos.length),
    u32(tamCentral), u32(offset), u16(0)));

  const total = locais.reduce((a, b) => a + b.length, 0) + tamCentral + fim.length;
  const saida = new Uint8Array(total);
  let o = 0;
  locais.forEach(b => { saida.set(b, o); o += b.length; });
  centrais.forEach(b => { saida.set(b, o); o += b.length; });
  saida.set(fim, o);
  return saida;
}

/* Escapa texto para XML. */
export const xmlEscape = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/* makeDocx(blocos) → Uint8Array
   blocos: [{ tipo: 'h1'|'h2'|'p'|'li', texto }]
   DOCX mínimo (Office Open XML) escrito à mão — sem dependência.            */
export function makeDocx(blocos) {
  const par = b => {
    const estilo = b.tipo === 'h1' ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'
      : b.tipo === 'h2' ? '<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>'
      : b.tipo === 'li' ? '<w:pPr><w:ind w:left="360"/></w:pPr>' : '';
    const negrito = (b.tipo === 'h1' || b.tipo === 'h2') ? '<w:rPr><w:b/></w:rPr>' : '';
    const texto = b.tipo === 'li' ? '• ' + b.texto : b.texto;
    return `<w:p>${estilo}<w:r>${negrito}<w:t xml:space="preserve">${xmlEscape(texto)}</w:t></w:r></w:p>`;
  };
  const documento = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${blocos.map(par).join('')}</w:body></w:document>`;
  const tipos = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  return makeZip([
    { name: '[Content_Types].xml', data: tipos },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: documento }
  ]);
}
