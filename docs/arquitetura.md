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
    bluestein.js            fftBluestein, fftAny, dftDireta (FFT de N arbitrário)
    timefreq.js             spectrogramWelch/STFT/Percept/Wavelet/AR, timeFrequency,
                            normalizeSpectrogram, removeAperiodicTrend, tfMatrix,
                            levinsonDurbin, janelas periódicas e simétricas
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
                            varianceByHour, diurnalProfile (unidade % ou razão)
    events.js               eventAligned, permutationTest, permutationTwoSample
    states.js               detectStates, enforceMinDur, betaEnvelopeSeries, streamOnOff
  metrics/
    acute.js                pickSpectrum, spectralMetrics, burstMetrics, doseResponse, peakInBand
    chronic.js              mergeTrend, collectThresholds, chronicMetrics, thresholdSummary
    extract.js              extractMetrics, daysSince
    diary.js                parseDiaryCsv, diaryGrid, dailyComposition, compareConditions,
                            circadianStateProfile, timelineGrid, doseMarkers,
                            diaryVsLfpAgreement, levodopaResponse, DIARY_STATES, LFP_STATES
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
| `io/external.js` | `stats` (nenhuma dependência de `dsp`) |
| `io/sync.js` | `dsp/filters`, `stats` |
| `dsp/coherence.js` | `dsp/fft`, `dsp/nan`, `stats` |
| `stats/cluster.js`, `stats/icc.js` | `stats` |
| `metrics/control.js` | `io/parse`, `dsp/spectral`, `stats/cluster` |
| `metrics/diary.js` | `io/parse`, `io/external` (leitor de CSV), `stats/states`, `stats/events` |
| `dsp/bluestein.js` | `dsp/fft` (radix-2 como motor da convolução) |
| `dsp/timefreq.js` | `dsp/fft`, `dsp/bluestein`, `dsp/wavelet`, `stats/descriptive` |
| `metrics/longitudinal.js` | `stats`, `stats/icc`, `metrics/extract` |
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

---

## O que o fabricante documenta

Esta seção existe para que ninguém volte a marcar como suposição algo que está escrito no white
paper de sensing da Medtronic — *Percept™ (PC and RC) Neurostimulators with BrainSense™
Technology — DBS Sensing White Paper*, **UC202012929cEN, FY24**, cópia em
[`docs/referencias/`](referencias/). A auditoria completa, com categoria e ação por item, está em
[`docs/auditoria-whitepaper.md`](auditoria-whitepaper.md).

### Fatos do dispositivo que o código passou a tratar como documentados

| Fato | Onde vive no código | p. |
|---|---|---|
| Valor negativo no `LfpTrendLogs` e no `FFTBinData` é **dado censurado**, não potência | `io/parse.js`; contabilidade em `metrics/chronic.js` → `censoringSummary` | 24, 25 |
| `GlobalSequences` rola em **255 no PC (B35200)** e **65 535 no RC (B35300)** | `io/packets.js` → `sequenceCapForModel` | 21–24 |
| As sequências de `BrainSenseTimeDomain` e `BrainSenseLfp` são **intercaladas entre si** | `io/packets.js` → `INTERLEAVED_STREAMS` | 23, 24 |
| `TicksInMses` rola a cada **65 536 × 50 ms**, e **não rola durante o streaming** | `io/packets.js` → `TICKS_ROLLOVER_MS`, `unwrapTicks` | 24 |
| `CalibrationTests` é com **estimulação LIGADA**; `SenseChannelTests`, desligada | `io/devicestate.js` → `DOCUMENTED_STIM_STATE` | 15 |
| `FirstPacketDateTime` tem resolução de **1 s** | `io/sync.js` → `alignByTimestamp.quantizationMs` | 21–24 |
| Cadeia de filtros: **2× passa-baixa 100 Hz**, passa-alta 1 Hz fixo, segundo passa-alta **1 ou 10 Hz** | `io/parse.js` → `HARDWARE_FILTERS`; alarme em `qc/alarm.js` | 11 |
| A banda de potência tem **aproximadamente 5 Hz** de largura | `metrics/config.js` → `CFG_BAND_SOURCE` | 6, 7 |
| O "LFP" é a **soma do quadrado da magnitude na banda** (≈ AUC) | `metrics/config.js` → `LFP_POWER_UNIT` | 21, 24 |
| `highpassfilter` e `sense blanking duration` vivem em `Groups → GroupSettings` | `io/parse.js` → `out.filters` | 26 |
| `FullyReadForSession: false` significa **estruturas faltando no arquivo** | `io/parse.js` → `meta.fullyRead` | 18 |
| `IndefiniteStreaming` é Record Streaming: **3 canais por lead, estimulação desligada** | `io/parse.js` → `out.indefiniteStreaming` | 16, 23 |
| `Thresholds` é a **série de potência** que originou os limiares | `io/parse.js` → `out.thresholdRuns` | 16, 21 |
| Curto **< 250 Ω** (1x4) ou **< 350 Ω** (SenSight); aberto **> 10 kΩ**; canais com artefato são **excluídos** | `io/parse.js` → `IMPEDANCE_LIMITS` | 4 |
| O snapshot cobre os **30 s DEPOIS** do botão, e **não tem domínio do tempo** | textos da F10 e F12 | 8 |
| Protocolo de sincronização com marcador de baixa frequência **no início e no fim** | `io/sync.js` → `SYNC_PROTOCOL` | 12 |
| Capacidade do Timeline: **60 dias no PC, 35 no RC**, com o **dia mais antigo sobrescrito** | aviso na F8 | 7 |
| A potência de 2 Hz é **média única, não sobreposta** | texto da F7 | 9 |
| Survey: ~**20 s** por canal, bins de **0,98 Hz**, centros de **0 a 96,68 Hz** | `dsp/timefreq.js`, texto da F1 | 4 |
| O aparelho escolhe a banda pelo **maior pico em beta ou gama acima de 1,1 µVp** | texto da F31 | 6 |
| Critério de descontinuidade do pseudocódigo do fabricante | `io/packets.js` → `gapCriterion` | 28 |

### O que continua sem fonte no documento

- **A constante de ganho 1/54** da emulação do PSD de bordo. A busca foi feita no documento
  inteiro e ela não aparece — está registrado no cabeçalho de `dsp/timefreq.js` para que ninguém
  repita o trabalho. Permanece marcada como empírica.
- **A largura exata da banda integrada por registro.** O documento diz *aproximadamente* 5 Hz; o
  JSON declara a frequência central e não a largura.
- **A orientação do eletrodo SenSight** está documentada e disponível no JSON (`LeadConfiguration`,
  p. 26), mas nenhuma análise desta versão a usa.

### Regra para quem for mexer aqui

Antes de escrever "assumido", "não exposto no JSON" ou "não documentado" em qualquer saída, procure
no white paper. Se estiver lá, cite a página. Se não estiver, escreva que a busca foi feita e onde
— é o que impede que a próxima pessoa gaste o mesmo tempo para chegar à mesma conclusão.

Um passo de proveniência, `whitepaper.compliance`, registra a versão do documento consultado e a
lista dos itens que o software declara seguir; um grupo do PERCEPT-REPORT
(*Features por janela*) e os itens `hardware_filters`, `blanking` e `device_state` passaram a ser
preenchidos a partir dele.

---

## Geometria dos eletrodos

`src/core/leads/index.js` é a camada mais baixa do núcleo: dados de geometria em **milímetros** e
leitura de nome de canal, sem nenhuma dependência e sem desenhar nada. Quem desenha é
`src/percept-plot.js` (`drawLead`, `drawLeadAxial`), que recebe as medidas e decide a escala em
pixels; quem monta o painel é `painelEletrodo` / `painelEletrodosBilateral` em `src/app.js`.

Modelos cobertos: 3387, 3389, 3391, SenSight B33005 e B33015. Fontes nos manuais de implante da
Medtronic (3387/3389, 2020; SenSight, 2021); o **3391 sai com `dimensionsVerified: false`** porque
suas medidas vêm de catálogo e da literatura.

Três invariantes desta camada:

1. **Modelo não identificado não produz geometria.** `leadGeometry` devolve `ok: false` com o
   motivo, e o painel diz que não desenhou — nunca substitui por um eletrodo genérico.
2. **Nível pedido num eletrodo direcional expande para os segmentos** (`expandContacts`), porque
   num 1-3-3-1 não existe contato anelar nos níveis 1 e 2: o aparelho usa os três segmentos em
   curto. A expansão sai declarada na legenda.
3. **A orientação anatômica não é afirmada.** Os ângulos a/b/c são de nomenclatura; a rotação real
   no crânio vem do marcador radiopaco e não está no JSON (o campo de orientação do SenSight
   existe em `LeadConfiguration` e não é usado nesta versão — item C3 da auditoria).

As figuras vetoriais de referência ficam em `docs/referencias/eletrodos/`, com um README que
explica por que o aplicativo redesenha em canvas em vez de embutir os SVG: eles são estáticos e não
sabem quais contatos estão em uso agora, que é justamente o ponto.
