# Arquitetura do núcleo

O núcleo do Percept LFP Studio vive em `src/core/**` como módulos ES por responsabilidade.
Antes do refactor (Prompt 0.1) era um único `src/percept-core.js` de 1.243 linhas, que não
sustentava as ondas de funcionalidade seguintes.

O refactor é **estritamente comportamental-neutro**: a superfície pública de `window.PerceptCore`
tem exatamente as mesmas 56 chaves de antes, e os 57 testes passam **sem nenhuma modificação na
suíte** — esse foi o critério de aceitação.

## Mapa de módulos

```
src/core/
  index.js                  barrel: monta e exporta o objeto PerceptCore (superfície pública)
  io/
    parse.js                parsePercept, hashId, normElec, prettyChannel, parseUtcOffsetMin,
                            localHour, localDayKey, MODALITIES
    index.js                reexporta a camada io
  dsp/
    fft.js                  fft, nextPow2, hann, detrendLinear
    spectral.js             welchPSD, spectrogram, bandPower, bandTable, bandOf, BANDS
    filters.js              bandpassFFT, hilbertEnvelope
    bursts.js               detectBursts, burstHistogram
    aperiodic.js            fitAperiodic, findPeaks
  artifact/
    ecg.js                  ecgTemplateSubtract
  stats/
    descriptive.js          mean, median, sd, variance, quantile, mad, removeOutliersMAD,
                            linreg, pearson, histogram, ecdf, bimodalityCoefficient
    distributions.js        logGamma, betacf, ibeta, fPValue, tPValue, normCDF, erf
    circadian.js            cosinor, olsSolve, cosinorBootstrap, circCI, rayleigh,
                            varianceByHour, diurnalProfile
    events.js               eventAligned, permutationTest
    states.js               detectStates, enforceMinDur, betaEnvelopeSeries, streamOnOff
  metrics/
    acute.js                pickSpectrum, spectralMetrics, burstMetrics, doseResponse, peakInBand
    chronic.js              mergeTrend, collectThresholds, chronicMetrics, thresholdSummary
    extract.js              extractMetrics, daysSince
```

## Regra de dependência

> `io` não importa `dsp`; `dsp` não importa `metrics`; `metrics` importa `dsp` e `stats`;
> **nada** importa `app`.

Estado atual (verificado):

| Camada | Importa de |
|---|---|
| `io/parse.js` | — (nada) |
| `stats/descriptive.js`, `stats/distributions.js` | — (nada) |
| `dsp/fft.js` | — (nada) |
| `dsp/spectral.js`, `dsp/filters.js` | `dsp` |
| `dsp/bursts.js`, `dsp/aperiodic.js` | `dsp`, `stats` |
| `artifact/ecg.js` | `dsp`, `stats` |
| `stats/circadian.js`, `stats/events.js`, `stats/states.js` | `stats`, `dsp`, `io` |
| `metrics/**` | `dsp`, `stats`, `io` |
| `metrics/survey.js` | `dsp` (aperiódico), `metrics/acute`, `stats` |
| `report/reading.js` | `profiles` (só o perfil; nenhuma dependência de DSP) |
| `stats/optimize.js` | `stats` (Levenberg-Marquardt compartilhado por `dsp` e `adbs`) |
| `dsp/multitaper.js`, `dsp/specparam.js`, `dsp/wavelet.js`, `dsp/pac.js`, `dsp/gamma.js` | `dsp`, `stats` |

A camada de apresentação (`src/app.js`, `src/percept-plot.js`) é consumidora do núcleo e nunca é
importada por ele.

A Onda 3 forçou uma extração: o Levenberg-Marquardt vivia dentro de `adbs/doseresponse.js`, e o
specparam completo precisa do mesmo ajustador — mas `dsp` não pode importar `adbs`. O otimizador
foi para `stats/optimize.js`, camada que ambos podem importar sem violar a regra.

Corolário que a Onda 8.1 tornou explícito: **as frases em linguagem clínica também são núcleo**.
`report/reading.js` recebe a saída de `extractMetrics` e o painel de QC e devolve texto com
parâmetro e ressalva embutidos; `src/app.js` apenas o exibe. Interpretar dentro da interface
tornaria a leitura impossível de testar — e é justamente ela que o médico lê primeiro.

## Como o bundle único é gerado

O invariante do projeto é um `index.html` que abre por **duplo clique**, sem servidor e sem
bundler externo. `src/build.mjs` portanto:

1. Lê `src/core/index.js` como ponto de entrada e resolve o **grafo de imports** recursivamente.
2. Ordena os módulos topologicamente (dependências antes de quem depende delas), detectando ciclos
   e falhando com o caminho do ciclo.
3. Remove a sintaxe de módulo (`import`, `export ... from`, `export default`, `export {}`,
   e o prefixo `export` das declarações), preservando as declarações.
4. Concatena tudo num IIFE que publica `root.PerceptCore` — a mesma superfície de antes — e
   também `module.exports`, para o uso em Node pela suíte de testes.
5. Injeta o resultado no `index.template.html` junto com CSS, camada de plotagem e app.

Consequência prática: **nunca edite `index.html` à mão**. Edite `src/**` e rode
`cd src && node build.mjs`. A CI verifica a sincronia.

## Como adicionar um módulo novo

1. Crie o arquivo na camada correta e exporte as funções com `export function ...`.
2. Importe o que precisar respeitando a regra de dependência acima.
3. Se a função for parte da API pública, importe-a em `core/index.js` e adicione ao objeto `API`.
4. Rode `cd src && node build.mjs && cd .. && node tests/run.mjs`.

Cada função de método científico documenta em comentário o que calcula, a referência bibliográfica
e as unidades de entrada e saída (ver `CLAUDE.md`).
