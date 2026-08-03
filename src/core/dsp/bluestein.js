/* dsp/bluestein.js — FFT de tamanho ARBITRÁRIO (algoritmo de Bluestein).

   POR QUE PRECISA EXISTIR. O espectrograma no padrão do BRAVO define a
   resolução de frequência e deriva o tamanho da transformada dela:
   `NFFT = round(fs / freq_res)`. Com o BrainSense a 250 Hz e resolução de
   0,5 Hz isso dá NFFT = 500 — que não é potência de dois. A FFT radix-2 que o
   resto do software usa não aceita 500.

   AS DUAS SAÍDAS POSSÍVEIS, E POR QUE ESTA. Dava para completar com zeros até
   512 e usar a radix-2; seria mais simples e mais rápido. Mas aí o eixo de
   frequência passa a ser k·fs/512 em vez de k·fs/500, e nenhum bin coincide
   com os do BRAVO — a comparação entre os dois softwares deixaria de ser
   ponto a ponto e viraria interpolação. Como o objetivo declarado é paridade
   numérica verificável, o eixo tem de ser idêntico, e por isso aqui está
   Bluestein: ele calcula a DFT de QUALQUER N exatamente, ao custo de uma
   convolução feita com três FFTs de tamanho potência de dois.

   COMO FUNCIONA. Da identidade nk = (n² + k² − (k−n)²)/2 sai

       X[k] = e^{−iπk²/N} · Σₙ ( x[n]·e^{−iπn²/N} ) · e^{+iπ(k−n)²/N}

   que é uma convolução linear entre a sequência modulada `a` e o núcleo
   quadrático `b`. A convolução linear vira circular completando ambas com
   zeros até M ≥ 2N−1 potência de dois, e aí a radix-2 resolve.

   PRECISÃO. O ângulo é πn²/N, e n² estoura a precisão de ponto flutuante
   antes de N ficar grande. Reduzir n² módulo 2N antes de dividir mantém o
   ângulo com erro de arredondamento constante em qualquer N.

   Custo: O(M log M) com M = próxima potência de dois ≥ 2N−1. Para N = 500,
   M = 1024 — três FFTs de 1024 por transformada.

   Referência: Bluestein LI. IEEE Trans Audio Electroacoust 1970;18:451-5.
   Rabiner LR, Schafer RW, Rader CM. Bell Syst Tech J 1969;48:1249-92 (chirp-z). */

import { fft, nextPow2 } from './fft.js';

/* fftBluestein(re, im, inverse) — DFT no lugar, para N arbitrário.
   Mesma convenção da `fft` radix-2: sinal negativo no expoente na direta, e a
   inversa divide por N.                                                      */
export function fftBluestein(re, im, inverse) {
  const N = re.length;
  if (N < 2) return;
  const sinal = inverse ? 1 : -1;
  const M = nextPow2(2 * N - 1);

  /* cos/sen de πn²/N, com n² reduzido módulo 2N para não perder dígitos */
  const cosQ = new Float64Array(N), sinQ = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    const q = (n * n) % (2 * N);
    const ang = Math.PI * q / N;
    cosQ[n] = Math.cos(ang); sinQ[n] = Math.sin(ang);
  }

  /* a[n] = x[n] · e^{sinal·iπn²/N} */
  const ar = new Float64Array(M), ai = new Float64Array(M);
  for (let n = 0; n < N; n++) {
    const c = cosQ[n], s = sinal * sinQ[n];
    ar[n] = re[n] * c - im[n] * s;
    ai[n] = re[n] * s + im[n] * c;
  }
  /* b[n] = e^{−sinal·iπn²/N}, simétrico e periodizado em M */
  const br = new Float64Array(M), bi = new Float64Array(M);
  br[0] = cosQ[0]; bi[0] = -sinal * sinQ[0];
  for (let n = 1; n < N; n++) {
    const c = cosQ[n], s = -sinal * sinQ[n];
    br[n] = c; bi[n] = s;
    br[M - n] = c; bi[M - n] = s;
  }

  fft(ar, ai, false);
  fft(br, bi, false);
  for (let i = 0; i < M; i++) {
    const r = ar[i] * br[i] - ai[i] * bi[i];
    const m = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = r; ai[i] = m;
  }
  fft(ar, ai, true);

  /* desmodula e devolve os N primeiros */
  for (let k = 0; k < N; k++) {
    const c = cosQ[k], s = sinal * sinQ[k];
    const r = ar[k] * c - ai[k] * s;
    const m = ar[k] * s + ai[k] * c;
    re[k] = inverse ? r / N : r;
    im[k] = inverse ? m / N : m;
  }
}

/* fftAny(re, im, inverse) — despacha: radix-2 quando N é potência de dois
   (mais rápido e sem erro de convolução), Bluestein no resto.               */
export function fftAny(re, im, inverse) {
  const N = re.length;
  if (N > 1 && (N & (N - 1)) === 0) fft(re, im, inverse);
  else fftBluestein(re, im, inverse);
}

/* dftDireta(re, im) — DFT O(N²) por definição. NÃO é usada no pipeline: existe
   como referência independente contra a qual a Bluestein é conferida nos
   testes. Uma FFT rápida errada e um teste escrito a partir dela concordariam
   entre si; a definição não deixa. */
export function dftDireta(re, im) {
  const N = re.length;
  const or_ = new Float64Array(N), oi = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    let sr = 0, si = 0;
    for (let n = 0; n < N; n++) {
      const ang = -2 * Math.PI * ((n * k) % N) / N;
      const c = Math.cos(ang), s = Math.sin(ang);
      sr += re[n] * c - im[n] * s;
      si += re[n] * s + im[n] * c;
    }
    or_[k] = sr; oi[k] = si;
  }
  return { re: or_, im: oi };
}
