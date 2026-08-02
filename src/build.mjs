/* Gera o index.html autocontido a partir dos fontes deste diretório.
   Uso:  cd src && node build.mjs                                        */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');
const ler = f => fs.readFileSync(path.join(AQUI, f), 'utf8');

const html = ler('index.template.html')
  .replace('/*__CSS__*/',  () => ler('styles.css'))
  .replace('/*__CORE__*/', () => ler('percept-core.js'))
  .replace('/*__PLOT__*/', () => ler('percept-plot.js'))
  .replace('/*__APP__*/',  () => ler('app.js'));

const destino = path.join(RAIZ, 'index.html');
fs.writeFileSync(destino, html);
console.log(`index.html gerado (${(html.length / 1024).toFixed(1)} KB)`);
