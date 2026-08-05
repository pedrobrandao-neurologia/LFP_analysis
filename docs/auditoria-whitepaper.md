# Auditoria — Percept LFP Studio contra o white paper de sensing da Medtronic

**Fonte:** Medtronic. *Percept™ (PC and RC) Neurostimulators with BrainSense™ Technology — DBS
Sensing White Paper.* UC202012929cEN, FY24.
Cópia em [`docs/referencias/UC202012929cEN_BrainSense_white_paper_Percept_PC_RC.pdf`](referencias/UC202012929cEN_BrainSense_white_paper_Percept_PC_RC.pdf).

Referências de página abaixo são as do rodapé do próprio documento.

Esta auditoria confronta o que o software **assume** com o que o fabricante **documenta**. Os
itens marcados **CONFIRMA** são tão importantes quanto os demais: são eles que permitem trocar
"assumido" por "documentado" na interface, e é isso que separa uma ressalva honesta de uma
ressalva desnecessária.

---

## Fase 1 — tabela de verificação

| # | Item | Categoria | Arquivo : função | Citação (p.) | Consequência para o usuário | Ação |
|---|---|---|---|---|---|---|
| **A1** | Dado censurado é negativo | **CONTRADIZ** | `io/parse.js` : `parsePercept` (Timeline e snapshots) | "Data may be censored to avoid artifacts, **censored data is negative**" (p. 24, `LfpTrendLogs`; p. 25, `FFTBinData`) | Valores de censura entravam como potência em **toda** a camada crônica: mediana e IQR (F8), cosinor (F9), IS/IV/M10/L5, `thresholdSummary` e as percentagens que guiam limiares de aDBS (F11, F23), `detectStates` (F13), pontos de mudança (F32), matriz hora × dia (F28), resposta à levodopa (F29), `chronicMetrics` e os espectros de evento (F12) | Negativo vira `NaN` com contabilidade **separada** de perda de pacote: `nCensored`, `pctCensored` |
| **A2** | Rollover de `GlobalSequences` depende do modelo | **CONTRADIZ** | `io/packets.js` : `analyzePackets` (`unwrapCounter(sequences, 256)`) | "Rolls over at **255** for Percept PC or **65,535** for Percept RC" (p. 21–24) | Num Percept RC (B35300) o cap 256 vê voltas onde não há, e a perda calculada é ficção | Cap por modelo (B35200 → 256; B35300 → 65 536); sem modelo identificável, **não escolher** — usar ticks e declarar |
| **A3** | Sequências de `BrainSenseTimeDomain` e `BrainSenseLfp` são **intercaladas** | **CONTRADIZ** | `io/packets.js` : `analyzePackets` (método `sequences`) | "Packets are **interleaved** with BrainSenseLfp packets" (p. 23); "interleaved with BrainSenseTimeDomain GlobalSequences" (p. 24) | Um salto de 1 é o comportamento **normal** — o número que falta é de um pacote de potência. O método `sequences` reportava perda maciça e falsa em todo BrainSense Streaming, degradando Welch, espectrograma, ODR, bursts e o selo de qualidade | Nesses dois fluxos, `TicksInMses` passa a ser o método preferencial; `sequences` fica para Survey, Signal Test, Calibration e Indefinite Streaming |
| **A4** | `TicksInMses`: cap fixo e sem volta em streaming | **PREENCHE LACUNA** | `io/packets.js` : `unwrapTicks` | "TicksInMs normally roll over every 2^16 ticks, or once every 54.61 minutes (65535 × 50 ms). However, **during streaming, TicksInMs will NOT roll over**" (p. 24) | A heurística de dois caps podia escolher o errado num registro curto | Cap documentado 65 536 × 50 ms; ausência de volta é o **caso esperado** em streaming; heurística só como recuo, marcada |
| **A5** | `CalibrationTests` é com estimulação **LIGADA** | **CONTRADIZ** | `io/devicestate.js` : `inferDeviceState` (`/survey\|montage\|signalcheck\|calibration/`) | "CalibrationTests — ... with **stim ON**" (p. 15); "SenseChannelTests — ... with stim **OFF**" (p. 15) | O par OFF/ON do mesmo paciente na mesma sessão era classificado como dois OFF: `statesComparable` não disparava o alerta de comparar espectros de estados diferentes | Tabela explícita modalidade → estado documentado, substituindo a expressão regular; confiança passa de `'fraca'` para `'documentada'` |
| **A6** | `FirstPacketDateTime` tem resolução de 1 s | **PREENCHE LACUNA** | `io/sync.js` : `alignByTimestamp` | "FirstPacketDatetime — ... **1 second resolution**" (p. 21–24) | O piso de incerteza é ±1 s **por construção**, antes de qualquer deriva de relógio — a recomendação de usar artefato de estimulação deixa de ser preferência e passa a ser necessidade | `quantizationMs: 1000` na saída e no texto da F24 |
| **B1** | Filtros de hardware | **PREENCHE LACUNA** + **REVELA AUSÊNCIA** | `export/edf.js`, `export/bids.js`, `report/checklist.js` : `hardware_filters` | "2 low pass filters at **100 Hz**, and two high pass filters. One high pass filter at **1 Hz**, and a second high pass filter at a user configurable **1 Hz or 10 Hz**" (p. 11); "GroupSettings – ... **highpassfilter**" (p. 26) | O software escrevia "não exposta no JSON" e o valor **está** em `Groups → GroupSettings`. Pior: com 10 Hz configurado, o termo teta do ODR e a leitura de banda lenta da distonia medem o joelho do filtro. E o duplo passa-baixa em 100 Hz atenua dentro da banda de gama de 60–90 Hz | Extrair o passa-alta efetivo; preencher os três lugares; **alarme** em `qc/alarm.js` quando for 10 Hz; ressalva de gama nas figuras que a leem |
| **B2** | Largura da banda de potência | **PREENCHE LACUNA** | `metrics/config.js` : `CFG_BAND_SOURCE` | "select a frequency band of interest (**approximately 5 Hz wide**)" (p. 6); "The clinician specified band is approximately 5 Hz wide" (p. 7) | A fonte era "assumida"; passa a ser documentada. A ressalva **permanece**: o documento diz *aproximadamente*, e a largura exata continua não declarada por registro | Trocar a origem para documentada, mantendo a ressalva com outra redação |
| **B3** | A unidade do "LFP" | **PREENCHE LACUNA** | todo o software ("u.a.") | "the **sum of the squared LFP magnitude at each frequency within the selected band**, similar to the Area Under the Curve" (p. 21, 24) | "u.a." escondia o mecanismo que a F32 já argumentava por raciocínio: a soma percorre os bins, então **mudar a largura da banda muda a escala** sem que nada mude no cérebro | Unidade passa a "soma do quadrado da magnitude na banda (≈ AUC), µVp²"; citar em `crossBlockWarning` |
| **B4** | Blanking em `GroupSettings` | **REVELA AUSÊNCIA** | `io/parse.js` (lê só do `TherapySnapshot`) | "GroupSettings – ... **sense blanking duration**" (p. 26) | Em sessão sem streaming o campo do PERCEPT-REPORT ficava vazio sem motivo | Extrair dos dois lugares, com precedência declarada |
| **B5** | `FullyReadForSession` | **REVELA AUSÊNCIA** | `io/parse.js` (lê `AbnormalEnd`, ignora este) | "If **false**, some structures may be **missing from the JSON file**" (p. 18) | A matriz de disponibilidade dizia "sem dados" onde o correto é "a leitura do dispositivo não foi concluída". É a distinção entre ausência de achado e ausência de verificação — violada por omissão de um campo | Parsear; a matriz e a aba Início passam a distinguir os dois casos; rodapé de captura ganha "Read All Events" |
| **C1** | `IndefiniteStreaming` não é parseado | **REVELA AUSÊNCIA** | `io/parse.js` : `td()`, `MODALITIES` | "IndefiniteStreaming — ... 'Record Streaming' ... (**3 channels per lead**) — stimulation is **off**" (p. 16, 23) | É o único modo com registro **longo, sem estimulação e com três canais simultâneos por hemisfério** — o dado ideal para o ODR sem o confundidor de gama *entrained*, e para coerência **dentro** do hemisfério. Não aparecia nem como ausente | Parsear como as demais séries; acrescentar a `MODALITIES`; liberar como fonte nas figuras de sinal bruto |
| **C2** | `Thresholds` não é parseado | **REVELA AUSÊNCIA** | `io/parse.js` | "Thresholds — This section contains the **power domain data** used to compute any sensing thresholds set in this session" (p. 16, 21) | O software lê os valores de limiar, não a série que os originou. O documento descreve o procedimento: amplitude baixa para o limiar superior, alta para o inferior (p. 6) | Parsear; usar em F11/F23 para mostrar em que ponto da curva cada limiar foi capturado |
| **C3** | Orientação do eletrodo SenSight | **REVELA AUSÊNCIA** | `io/parse.js` : `LeadConfiguration` | "the **lead orientation value in degrees** for SenSight leads" (p. 26) | Sem uso imediato | Registrado aqui para trabalho futuro com eletrodo direcional; **não implementado nesta auditoria** |
| **D1** | Os dois hemisférios do Survey não são simultâneos | **CONFIRMA** (guarda) + **PREENCHE LACUNA** | `metrics/windowed.js` : `pairableRecords` | "If a second lead is present, **another survey must be performed**" (p. 4); Streaming: "LFP data is streamed from **both hemispheres**" (p. 9) | A guarda de pareamento já recusava por `FirstPacketDateTime` diferente — e agora a razão tem fonte. O que faltava: pares do **mesmo** lead são simultâneos e servem para coerência intra-hemisférica, exceto entre **passagens** diferentes do survey de segmentos | Teste que trava a recusa entre hemisférios e entre passagens; texto da F1 |
| **D2** | Ausência de canal no Survey ≠ ausência de sinal | **CONTRADIZ** (limiares) | `metrics/survey.js` : `rankSurveyChannels`; F3 no `app.js` | "Sense channels with potential shorts (**<250 ohms** for 1x4, **<350 ohms** for SenSight) or opens (**>10 kohms**) are excluded"; "Sense channels with potential artifacts are **excluded**" (p. 4) | A F3 alertava abaixo de 500 Ω com "faixa habitual 500–2000 Ω"; os limiares do **dispositivo** são outros. E um par ausente do Survey pode ter sido excluído pelo aparelho, não estar sem sinal | Limiares de alarme do fabricante; faixa habitual só como referência de leitura, declarada |
| **D3** | O snapshot cobre os 30 s **depois** do botão | **CONTRADIZ** | F12 e F10 no `app.js` | "the neurostimulator measures approximately 30 seconds ... The 30 seconds of data is collected **after** the Patient Event is received"; "Time domain data of the snapshot is **not** stored" (p. 8) | Em janela alinhada a evento o snapshot representa `[0, +30 s]`, não `[−15, +15 s]` | Corrigir eixo e texto; documentar que o domínio do tempo do snapshot **não existe** |
| **D4** | Protocolo de sincronização do fabricante | **CONFIRMA** + **PREENCHE LACUNA** | `io/sync.js` : `alignByStimArtifact`; F24 | "Deliver low frequency (e.g. **50 Hz**) and low amplitude stimulation ... at the **start/end** of the streaming session"; "Update Device Time" com tablet em WIFI (p. 12) | O método já existia; faltava o protocolo com parâmetros e o marcador **no fim**, que é o que separa deriva de relógio de deslocamento fixo | Escrever o protocolo na F24 e como pendência de captura na agenda (F33) |
| **D5** | Capacidades e sobrescrita por modelo | **REVELA AUSÊNCIA** | `metrics/chronic.js`, F26, F32 | PC: 60 dias / 400 snapshots / 900 eventos; RC: 35 / 200 / 800. "the **oldest day will be overwritten**" (p. 7, 8) | Perto do limite, a ausência de dado antigo **não é ausência de registro** | Aviso quando o Timeline se aproximar do limite do modelo |
| **D6** | A potência de 2 Hz é média **não sobreposta** | **PREENCHE LACUNA** | F7 e reamostragem de `bsLfp` | "the power averaging duration is **not a moving average it is a unique average**, i.e. each average contains a unique set of data, **not overlapping**" (p. 9) | A resolução efetiva é a `AveragingDurationInMilliSeconds`, não os 2 Hz nominais | Declarar os dois números juntos |
| **D7** | Duração do Survey e eixo de frequência | **CONFIRMA** | `spectrogramPercept`, F1 | "about **20 seconds** of data ... frequency bins are **0.98 Hz** wide with centers from **0–96.68 Hz**" (p. 4) | — | Confirmado: 99 bins × 250/256 = 96,68 Hz. Citar a fonte no comentário |
| **D8** | O critério do próprio aparelho para escolher a banda | **PREENCHE LACUNA** | `metrics/passport.js` | "Automatically selects the largest peak ... if that peak is in the **beta or gamma** frequency range and exceeds a value of **1.1 µVp**" (p. 6) | O passaporte comparava a sugestão do software com a configuração vigente sem dizer qual critério o aparelho usou | Declarar o critério do fabricante e que o limiar de 1,1 µVp é dele, não do software |
| **E1** | Emulação do PSD de bordo | **CONFIRMA** (parcial) | `dsp/timefreq.js` : `spectrogramPercept` | bins de 0,98 Hz, centros 0–96,68 Hz (p. 4, 8) | — | NFFT 256 sobre 250 Hz confirmado. **A constante de ganho 1/54 não aparece em nenhum ponto deste white paper** — busca feita e registrada, para que ninguém repita o trabalho |
| **E2** | Pseudocódigo de timestamps por amostra | **CONTRADIZ** (critério) | `io/packets.js` : `analyzePackets` (intervalo modal) | `IF Difference in TicksInMses > (1 + GlobalPacketSizes)/SampleRateInHz` (p. 28) | O critério do fabricante é **absoluto** (tamanho do pacote + 1 amostra), o do software é **relativo** (múltiplo do intervalo modal). Divergem em registro com tamanho de pacote variável | Implementar o critério documentado, **corrigindo a inconsistência de unidade do original** (esquerda em ms, direita em s) |
| **E3** | Guarda de coerência do Survey | **CONFIRMA** | `metrics/windowed.js` : `pairableRecords` | ver D1 | — | Teste que trava a recusa |

### Resumo por categoria

| Categoria | n |
|---|---|
| CONTRADIZ — o código calculava ou afirmava algo diferente do documentado | 7 |
| PREENCHE LACUNA — o código declarava "assumido" algo que o documento especifica | 8 |
| REVELA AUSÊNCIA — funcionalidade documentada que o software não lia | 6 |
| CONFIRMA — o código já estava de acordo, e agora pode declarar a fonte | 4 |

---

## Uma leitura que a auditoria teve de decidir

A frase "Data may be censored to avoid artifacts, censored data is negative" aparece, em
`LfpTrendLogs` (p. 24), logo **depois** da linha de `AmplitudeInMilliAmps`, e não há na página
uma marca tipográfica que diga se ela governa só a amplitude ou todo o bloco. Em
`LfpFrequencySnapshotEvents` (p. 25) ela aparece depois de `FFTBinData`, sozinha.

A decisão adotada é tratar negativo como censura **nos dois campos** do Timeline, pelo
argumento independente do texto: a potência do Timeline é definida como **soma de quadrados**
(p. 21, 24) e a amplitude de estimulação é uma corrente entregue — nenhuma das duas pode ser
negativa por construção. Um negativo em qualquer delas é censura, seja qual for a leitura
tipográfica correta. A ambiguidade fica registrada aqui, e a contabilidade sai separada por
campo (`nCensoredLfp`, `nCensoredMa`) para que quem discordar possa refazer a conta.

---

## O que continua sem fonte

- **A constante de ganho 1/54** da emulação do PSD de bordo (`spectrogramPercept`). Não
  aparece neste white paper. Permanece marcada como empírica e sem documentação do fabricante.
- **A largura exata da banda integrada por registro.** O documento diz "aproximadamente 5 Hz";
  o JSON declara a frequência central e não a largura. Uma mudança real de largura continua
  não sendo detectável a partir do arquivo.
- **A orientação do eletrodo SenSight** (C3) está documentada e disponível no JSON, mas não é
  usada por nenhuma análise desta versão.
