# LFP_analysis

Ferramentas para leitura, visualização e análise estatística de **potenciais de campo local (LFP)**
registrados pelo neuroestimulador **Medtronic Percept PC/RC** no núcleo subtalâmico de pacientes
com doença de Parkinson.

O repositório contém duas peças que se complementam:

| | O quê | Para quê |
|---|---|---|
| **Percept LFP Studio** | aplicativo web progressivo (PWA) em arquivo único | inspeção rápida em consultório, exploração interativa, figuras para apresentação |
| **`R/percept_lfp.R`** | 61 funções em R | análise definitiva para publicação: modelos mistos, GAMM, figuras em 300 dpi |

Ambos leem o mesmo arquivo — o `Report_Json_Session_Report_*.json` exportado do programador — e
produzem em grande parte as mesmas figuras (F1–F12, descritas em [`docs/estado-da-arte.md`](docs/estado-da-arte.md));
o aplicativo inclui ainda a **F13**, detecção automática de estados **ON/OFF** pela amplitude do beta.

> **Como ler este README.** Cada bloco traz a explicação **técnica** — o que a função faz e como calcula —
> e, em linguagem simples, **o que cada variável significa para o médico** que vai ler o aplicativo ou o
> relatório em PDF. O [Glossário clínico das variáveis](#glossário-clínico-das-variáveis) reúne todas as
> medidas com essa dupla leitura. Nada aqui é diagnóstico: são marcadores de pesquisa e apoio à decisão.

---

## Privacidade

**Nenhum dado sai do dispositivo.** A PWA não faz uma única requisição de rede: não há CDN,
não há biblioteca externa, não há telemetria. Parser, FFT, Welch, Hilbert, cosinor, bootstrap
e toda a plotagem foram escritos do zero justamente para eliminar essa superfície.

Os Session Reports contêm **nome completo, data de nascimento, identificador de prontuário e
número de série do neuroestimulador**. O `.gitignore` deste repositório bloqueia esses arquivos
por padrão — confira antes de qualquer `git add -A`. Tanto a PWA quanto o script R
pseudonimizam os identificadores automaticamente ao ler.

---

## Uso rápido

### Aplicativo

Abra `index.html` no navegador e arraste os arquivos JSON. Funciona por duplo clique, sem servidor.

Publicado no GitHub Pages, instala como aplicativo e passa a funcionar **offline**:
*Settings → Pages → Deploy from branch → `main` / `(root)`.*

Para testar localmente com service worker ativo:

```bash
python3 -m http.server 8080   # depois abra http://localhost:8080
```

### R

```r
source("R/percept_lfp.R")

p  <- percept_read("caminho/para/Report_Json_Session_Report_20250106.json")
p                                    # inventário do que o arquivo contém

tr <- percept_trend(p)               # BrainSense Timeline em data.frame longo
res <- pipeline_circadiano(tr, hemi = "Right")
print(res$tabela)
res$figuras$heatmap

## modelo recomendado para publicação: efeitos mistos com estrutura AR(1)
m <- cosinor_misto(res$dados, valor = "valor", agrupar = "dia", ar1 = TRUE)
summary(m$modelo)

## relatório completo de uma pasta, gravando PNG em 300 dpi e CSV
percept_relatorio("pasta/com/jsons", saida = "resultados")
```

### Dataset sintético

Para experimentar sem dados de paciente:

```bash
node tools/gerar_exemplo.mjs examples
```

Gera `examples/exemplo_sintetico.json` (~1,3 MB) com 21 dias de Timeline bilateral,
120 s de sinal bruto a 250 Hz com artefato cardíaco, rampa de estimulação, survey de 30 canais
e 32 snapshots por evento. Ritmo circadiano, pico beta e autocorrelação são injetados com
valores conhecidos — a suíte de testes verifica que o pipeline os recupera.

---

## Dois modos de uso

O alternador no cabeçalho decide **o que é mostrado**, nunca **como é calculado**: os mesmos
números, as mesmas ressalvas, os mesmos parâmetros declarados nos dois modos. A escolha fica
guardada no navegador (apenas a preferência de interface — nenhum dado de paciente é gravado).

### Modo clínico — o que sai da consulta

- **Seis figuras**, escolhidas pelo **perfil de doença** (campo `clinicalFigures` em
  `src/core/profiles/index.js`): em Parkinson, F1 · F6 · F8 · F9 · F11 · F13; em distonia e
  tremor essencial, F13 sai (o detector de estados é definido sobre beta e não descreve essas
  condições) e entra F5, o mapa de canais.
- **Leitura em linguagem simples no topo de cada figura**, gerada em `src/core/report/reading.js`
  a partir das métricas — a interface não interpreta nada por conta própria. Cada leitura traz
  quatro partes fixas: a frase, os números, **os parâmetros que produziram aqueles números** e a
  **ressalva** que eles exigem.
- **Semáforo de qualidade do sinal** — a versão de uma linha do painel F17, que sempre informa
  quantos itens **não são verificáveis** com aquele dado: ausência de informação não é aprovação.
- **Um botão de exportação**: o relatório clínico em PDF, com as leituras na capa.

Quando o dado não sustenta uma conclusão, a leitura diz isso — *"não há Timeline suficiente deste
lado para descrever o ritmo de 24 horas"* — e indica o que capturar na próxima sessão. Nenhuma
leitura sugere diagnóstico, prognóstico ou substituição do software regulado do fabricante; há
teste automatizado varrendo todo o texto exposto ao usuário atrás desses termos.

### Modo pesquisa — tudo

Todas as figuras, todos os controles de parâmetro, as nove exportações (CSV, JSON, PNG, checklist
PERCEPT-REPORT, manifesto de proveniência) e os **pipelines de um clique**:

| pipeline | abre | entrega |
| --- | --- | --- |
| Triagem de elegibilidade a aDBS | F23, F16, F17 | CSV de métricas crônicas |
| Perfil circadiano completo | F8, F9, F11, F12 | CSV de métricas crônicas |
| Auditoria de qualidade do sinal | F15, F16, F17 | manifesto de proveniência com o hash citável |

Um pipeline não decide nada por você: os parâmetros continuam sendo os das figuras, e vão
declarados na exportação.

---

## Figuras

A coluna **Leitura clínica** resume, em uma frase, o que cada figura diz ao médico.

| ID | Figura (técnico) | Fonte necessária | Leitura clínica |
|----|------------------|------------------|-----------------|
| F1 | **Varredura do Survey** (todos os pares bipolares por hemisfério) + espectro anotado do par escolhido | Signal Test, Survey ou Signal Check | Em **qual par de contatos** o marcador é mais forte, sem abrir um a um — e onde está o **pico beta** naquele par. |
| F2 | Decomposição periódico/aperiódico | qualquer espectro ou sinal bruto | Separa o **pico verdadeiro** do "fundo" 1/f — confirma se o beta é oscilação real. |
| F3 | Impedâncias monopolares e matriz bipolar | `Impedance` | Integridade dos contatos do eletrodo e sua estabilidade ao longo do tempo. |
| F4 | Linha do tempo da sessão, grupos, parâmetros de sensing | `EventLogs`, `Groups` | O que foi **programado** (grupos, contatos, sensing) e quando. |
| F5 | Mapa canal × frequência do Survey + ranking de picos | `LFPMontage` | Qual par de contatos **capta melhor o beta** — escolha do sensing crônico. |
| F6 | Traçado, espectrograma, envelope, bursts, sensibilidade ao limiar | `BrainSenseTimeDomain` | Sinal cru e **rajadas de beta** (bursts), alvo do aDBS de limiar único. |
| F7 | Potência × amplitude de estimulação, dose-resposta | `BrainSenseLfp` | Se **aumentar a estimulação reduz o beta** (resposta esperada). |
| F8 | Timeline crônico multi-dia, bilateral | `LFPTrendLogs` | Como o beta **varia ao longo dos dias**, nos dois lados. |
| F9 | Heatmap dia × hora, perfil diurno, polar, cosinor | `LFPTrendLogs` (≥ 2 dias) | **Ritmo dia↔noite** do beta e a hora do pico. |
| F10 | Resposta alinhada a evento (−60/+180 min) | `LFPTrendLogs` + snapshots | Resposta do beta a um **evento marcado** (ex.: tomar levodopa). |
| F11 | Distribuição de potência e limiares de aDBS | `LFPTrendLogs` | **Quanto tempo** o beta passa em cada faixa — define limiares do aDBS. |
| F12 | Espectros medianos por tipo de evento | `LfpFrequencySnapshotEvents` | Compara o espectro entre **tipos de evento** do paciente. |
| **F13** | **Estados ON/OFF pela amplitude do beta** | `BrainSenseTimeDomain` ou `LFPTrendLogs` | Divide o registro em **ON (baixo beta)** e **OFF (alto beta)** automaticamente. |
| **F15** | **Limpeza de artefato cardíaco — 3 métodos + validação** | `BrainSenseTimeDomain` ou `LfpMontageTimeDomain` | Quanto do sinal é **batimento cardíaco**, e se a limpeza tirou o artefato **sem tirar o sinal**. |
| **F16** | **QC — reprodutibilidade do pico entre registros** | `LFPMontage` (≥ 2 registros) | O mesmo canal, medido de novo, **dá o mesmo pico**? |
| **F17** | **Painel de controle de qualidade** | qualquer arquivo | Semáforo do checklist de artefatos, item a item, **com o que não é verificável declarado**. |
| **F23** | **aDBS — elegibilidade e simulador de limiar** | `LFPMontage` e/ou `LFPTrendLogs` | **É elegível a aDBS?** E, se for, **que limiares** — com duty cycle e transições/h simulados. |
| **F18** | **Espectro multitaper (DPSS) com IC por jackknife** | `BrainSenseTimeDomain` ou `LfpMontageTimeDomain` | O pico do espectro **com barra de incerteza**, e se ele muda conforme o método de estimativa. |
| **F19** | **specparam completo — reta ou joelho, largura, R²** | qualquer espectro | O expoente do fundo 1/f e os picos **com largura e qualidade de ajuste**, sem os quais o número não é reportável. |
| **F20** | **Wavelet de Morlet — escalograma e bursts delimitados** | `BrainSenseTimeDomain` | As rajadas **onde começam e onde terminam**, e se a duração medida é do cérebro ou da escolha de resolução. |
| **F21** | **PAC — acoplamento fase-amplitude e comodulograma** | `BrainSenseTimeDomain` (fs ≥ 250 Hz) | Se a **amplitude do gama acompanha a fase do beta** — marcador de interação entre ritmos, elevado no OFF. |
| **F22** | **Gama finamente sintonizada vs. entrained em f_stim/2** | qualquer espectro que chegue a 95 Hz | Se um pico de gama é **endógeno** (associado a ON/discinesia) ou **eco da própria estimulação**. |
| **F24** | **Sinal externo (IMU/EMG/ECG) — alinhamento e coerência** | `BrainSenseTimeDomain` + CSV/TSV externo | Se a oscilação do LFP é **do cérebro** ou é o próprio movimento entrando pelo eletrodo. |
| **F25** | **Actograma duplo-plot e banda-controle** | `LFPTrendLogs` (≥ 2 dias) + snapshots datados | Se o horário do pico **deriva entre os dias** e se o padrão diurno é **específico da banda**. |
| **F26** | **Longitudinal — impedância, confiabilidade e uso** | ≥ 2 sessões | Se o que mudou entre visitas foi **o cérebro ou a medida**. |
| **F27** | **Coorte — todos os registros lado a lado** | ≥ 1 registro | Prevalência de pico com **IC de Wilson**, tabela por sujeito e estatísticas de grupo. |

Cada figura exporta PNG e os dados subjacentes em CSV.

---

## Coorte, pacote único e linha de comando

**Ingestão de pasta.** O botão `+ pasta` lê todos os `.json` de um diretório, incluindo subpastas, e
agrupa por sujeito pseudonimizado. Registros de pessoas diferentes nunca são agregados — o software
detecta e obriga a escolher.

**Modo coorte (F27).** Tabela por sujeito × hemisfério, estatísticas de grupo e a **prevalência de
pico na banda primária** — a estatística que muda o cálculo amostral de um estudo e que quase nunca
é reportada. O IC é de **Wilson**, não de Wald: com 2 de 2 hemisférios, Wald daria [100 %; 100 %] e
Wilson dá **[34,2 %; 100 %]**, que é a verdade. Abaixo de 5 sujeitos o resumo sai marcado como
**descritivo** e nenhum teste de grupo é aplicado. Acrofase entra como grandeza **circular** — 23 h
e 1 h não têm média 12 h.

**Pacote completo (.zip).** Um arquivo com tudo o que a análise produziu, escrito sem compressão
(método *store*, porque *deflate* exigiria dependência):

```
metricas/       CSV e JSON por sessão e hemisfério, mais o Timeline em formato longo
sinal/          o sinal bruto em EDF+ e os metadados da conversão
bids/           estrutura BIDS-like
proveniencia/   manifesto com todos os parâmetros efetivos, hash citável e checklist PERCEPT-REPORT
figuras/        cada gráfico em PNG
LEIA-ME.txt
```

**EDF+ escrito do zero.** EDF é o formato que EEGLAB, FieldTrip, MNE e Brainstorm abrem. O problema
que ele *não* resolve — e que aqui não é escondido — é que o formato armazena inteiros de 16 bits e
**não tem representação para dado ausente**. A política adotada: as amostras faltantes recebem o
**mínimo digital**, valor que fica fora da faixa física por construção (a faixa é calculada só sobre
amostras válidas, com margem); a lista de lacunas acompanha o arquivo em JSON; e o campo de
pré-filtragem de cada canal declara a política em texto. Escrever NaN como zero, o que a maioria dos
conversores faz, seria criar sinal onde não há. Verificado: erro máximo de reconstrução de
**1,7 × 10⁻³ µV** (menor que um passo de quantização) e **zero** colisões entre amostras válidas e a
marca de ausente.

**BIDS-like, e o nome é literal.** O que sai é a estrutura de diretórios, a nomenclatura e os
arquivos de metadados do BIDS-iEEG, com os campos disponíveis preenchidos e os ausentes marcados
`n/a`. Não é um dataset BIDS conforme, porque o Session Report do Percept não traz coordenadas de
eletrodo, sistema de referência anatômica nem protocolo de tarefa — e o `dataset_description.json`
diz isso.

**Linha de comando.** Processa uma coorte inteira sem abrir a interface, rodando **o mesmo núcleo**
que o navegador executa (lido de `index.html`, não de uma cópia paralela):

```bash
node tools/cli.mjs <pasta> --out saida [--tz -180] [--profile pd] [--no-edf] [--no-bids]
```

Escreve métricas por sujeito, EDF por sessão, a estrutura BIDS-like, o resumo da coorte e um
`execucao.json` com o que foi lido, o que falhou e por quê. Não gera figuras: elas dependem de
canvas, e desenhar em Node exigiria dependência gráfica — a CLI declara isso em vez de omitir.

---

## Exportação para pesquisa clínica

O painel **Exportar** (barra lateral) reúne quatro formas de tirar os dados do app, todas geradas
localmente, sem rede:

| Formato | O quê | Uso |
|---|---|---|
| **Gráficos individuais** | PNG de cada figura + CSV dos dados subjacentes (botões em cada figura) e **“Todas as figuras (PNG)”** para baixar tudo de uma vez | apresentações, manuscritos |
| **Relatório PDF** | capa com identificação do caso (paciente pseudonimizado, dispositivo, **data de implante**, alvos, fuso), **resumo de métricas-chave** agudas e crônicas, seguido de todas as figuras com métodos — via *imprimir → salvar em PDF* | prontuário, discussão de caso, anexo de relatório |
| **CSV de métricas** | tabela *tidy* pronta para planilha, em dois níveis: **agudas** (uma linha por sessão × hemisfério) e **crônicas** (uma linha por sujeito × hemisfério) | análise estatística em R/Python/Excel |
| **JSON para estatística** | mesmo conteúdo em estrutura aninhada (`subject`, `sessions`, `acute`, `chronic`) | pipelines programáticos |

**Variáveis-chave nomeadas por paciente, sessão e data de implante.** Cada linha exportada carrega
`subject_id`, `implant_date`, `session_date_local`, `days_since_implant` e `hemisphere`, de modo que
os desfechos ficam prontos para modelos longitudinais sem reprocessamento. As variáveis incluem:

- **Agudas (sessão × hemisfério):** pico beta (Hz e magnitude), potência relativa β↓/β↑, presença de
  pico beta (`has_beta_peak` — critério de elegibilidade a aDBS), pico teta-alfa (relevante em distonia),
  expoente e offset aperiódicos (specparam/FOOOF), taxa/duração/probabilidade de bursts (com o percentil
  registrado), inclinação dose-resposta quando há rampa de estimulação e, no streaming, a fração do tempo
  em **alto beta (estado OFF)**.
- **Crônicas (Timeline):** n de pontos/dias, mediana e IQR, MESOR, amplitude e acrofase de 24 h,
  R² e *p* do cosinor **corrigido para autocorrelação AR(1)**, η² da hora do dia, *R* e *p* de Rayleigh,
  a distribuição da potência frente aos limiares de aDBS (% abaixo/entre/acima, p10/p90) e a **segmentação
  automática em estados ON/OFF** (% do tempo em OFF, número e duração dos episódios).

Os identificadores de paciente já saem pseudonimizados do parser (`sub-XXXXXXXX`); nenhum nome, data de
nascimento, prontuário ou número de série é incluído nas exportações.

---

## Perfis de doença

O software deixou de falar uma doença só. Bandas, normalização, leitura clínica e glossário vêm do
**perfil ativo**, sugerido automaticamente pelo `Diagnosis` e pelo `LeadLocation` do JSON:

| Perfil | Banda primária | Normalização | Sinal externo recomendado |
|---|---|---|---|
| Parkinson (STN/GPi) | beta 13–35 Hz | corrigida pelo aperiódico | — |
| **Distonia (GPi)** | **teta-alfa 4–12 Hz** | **`sd_6_96hz`** | **IMU** |
| **Tremor essencial (VIM)** | **frequência do tremor** (medida) | relativa | **acelerômetro** |
| Epilepsia (ANT) | teta 4–8 Hz | relativa | — |
| Genérico | definida pelo usuário | relativa | — |

Tabela completa, justificativa de cada escolha e armadilhas específicas em
[`docs/perfis.md`](docs/perfis.md). O perfil usado sai em `profile_id` em toda linha exportada.

---

## Glossário clínico das variáveis

Cada variável abaixo aparece nas tabelas do aplicativo, no CSV/JSON e no relatório em PDF. A ideia é que
tanto **quem programa o DBS** quanto **quem faz a análise estatística** leiam a mesma linha e entendam.

> **A intuição do beta.** O beta (13–35 Hz) é o "ritmo do freio" dos núcleos da base. Ele tende a ficar
> **alto quando a medicação está no fim (OFF)** e mais sintomas aparecem, e **cai quando a levodopa faz
> efeito (ON)** ou sob estimulação eficaz. Quase tudo aqui gira em torno de medir esse beta de formas
> diferentes. **Atenção:** são *correlatos* de estado clínico, não a verdade — movimento e a própria
> estimulação alteram o beta.

### Espectro e picos (medidas agudas)

| Variável (CSV/JSON) | O que é, em linguagem simples | Como é medido | O que sugere clinicamente |
|---|---|---|---|
| `beta_peak_hz`, `beta_peak_mag` | A **frequência** e a **força** do beta mais forte | máximo do espectro entre 13–35 Hz | beta forte acompanha estado OFF / mais rigidez e lentidão; cai com levodopa e estimulação eficaz |
| `has_beta_peak` | **Existe** um pico beta nítido? (sim/não) | pico no resíduo após remover o fundo 1/f | pré-requisito para programar **aDBS guiado por beta**; parte dos hemisférios simplesmente não tem pico |
| `low_beta_rel_pct`, `high_beta_rel_pct` | Quanto do sinal está no beta **baixo** (13–20) e **alto** (20–35) | potência relativa por banda | o beta baixo é o que mais responde à levodopa |
| `theta_alpha_peak_hz` | Pico entre **4–12 Hz** | máximo do espectro em 4–12 Hz | biomarcador na **distonia** (GPi); em Parkinson costuma refletir tremor/ruído |
| `gamma_peak_hz` | Pico entre **55–95 Hz** | máximo do espectro em 55–95 Hz | gama "finamente sintonizada" liga-se a melhora motora e a discinesia |

### Componente aperiódico — specparam/FOOOF (medidas agudas)

| Variável | Em linguagem simples | Como é medido | O que sugere |
|---|---|---|---|
| `aperiodic_exponent` (χ) | A **inclinação do "fundo"** do espectro (parte não oscilatória) | regressão robusta em escala log-log | relacionado ao balanço excitação/inibição da rede; use como métrica de apoio |
| `aperiodic_offset` | A **altura geral** desse fundo | idem | potência de banda larga |
| `aperiodic_r2` | **Quão bem** o fundo foi ajustado | R² do modelo | indica se a separação "pico × fundo" é confiável |

### Bursts de beta (medidas agudas)

| Variável | Em linguagem simples | Como é medido | O que sugere |
|---|---|---|---|
| `burst_rate_hz` | Quantas **rajadas** de beta por segundo | envelope de Hilbert + limiar no percentil | rajadas frequentes acompanham mais sintoma motor |
| `burst_mean_ms`, `burst_prob_pct` | **Duração média** das rajadas e **fração do tempo** em rajada | idem | rajadas longas são o alvo do **aDBS de limiar único** |
| `burst_percentile` | O **percentil** usado como limiar (registro) | parâmetro do método | muda o resultado sistematicamente — **pré-registre-o** |

### Resposta à estimulação (medidas agudas)

| Variável | Em linguagem simples | Como é medido | O que sugere |
|---|---|---|---|
| `dose_slope`, `dose_r2` | **Quanto o beta cai** por mA de estimulação | regressão potência × amplitude | inclinação negativa forte = **supressão beta dose-dependente** (sinal de estimulação eficaz) |

### Ritmo circadiano — Timeline (medidas crônicas)

| Variável | Em linguagem simples | Como é medido | O que sugere |
|---|---|---|---|
| `mesor` | O **nível médio** do beta no ciclo de 24 h | cosinor (24+12 h) | linha de base do dia |
| `amp_24h` | O **tamanho** da oscilação dia↔noite | idem | ritmo forte sugere modulação circadiana real do beta |
| `acrophase_24h` | A **hora do pico** de beta | idem | quando o "freio" está mais ativo — costuma ser de manhã |
| `cosinor_p`, `cosinor_p_adj_ar1` | O ritmo de 24 h é **real**? | teste do cosinor; `*_adj_ar1` corrige a autocorrelação | use sempre o **corrigido** — o *p* bruto exagera a significância |
| `rho_ar1` | Quão "grudados" são pontos consecutivos | autocorrelação de 1ª ordem dos resíduos | valores altos (>0,9) são esperados a cada 10 min |
| `eta2_hour_pct` | **Quanto** da variação do beta a hora do dia explica | ANOVA por hora | fração da variância atribuível ao horário |
| `rayleigh_R`, `rayleigh_p` | O horário do pico **se repete** entre os dias? | teste de Rayleigh das acrofases diárias | ritmo consistente vs. disperso |

### Distribuição e limiares de aDBS — Timeline (medidas crônicas)

| Variável | Em linguagem simples | Como é medido | O que sugere |
|---|---|---|---|
| `lfp_median`, `lfp_iqr_low/high` | **Centro e dispersão** do beta crônico | mediana e quartis | resumo robusto da série |
| `pct_below`, `pct_between`, `pct_above` | **% do tempo** abaixo / entre / acima dos limiares | contagem frente aos limiares | se quase tudo cai numa faixa, o aDBS quase não modula |
| `p10`, `p90` | Candidatos **empíricos** a limiar | percentis 10 e 90 | pontos de partida para programar limiares |
| `thr_lower`, `thr_upper`, `thr_source` | Limiares usados e sua **origem** | do aparelho, senão Q1/Q3 dos dados | rastreabilidade da decisão |

### Estados ON/OFF pela amplitude do beta — F13 (agudas e crônicas)

| Variável | Em linguagem simples | Como é medido | O que sugere |
|---|---|---|---|
| `off_pct` / `stream_off_pct` | **% do tempo em alto beta** (estado OFF-like) | k-médias sobre a amplitude de beta | mais tempo em OFF sugere controle motor pior no período |
| `n_off_episodes`, `mean_off_min` | **Quantos** blocos de OFF e **quão longos** | segmentação com duração mínima | fragmentação e persistência dos períodos ruins |
| `beta_low_state`, `beta_high_state` | Nível **típico** de beta em ON e em OFF | centróides dos dois grupos | contraste absoluto entre os estados |
| `beta_state_sep` | O **contraste** entre os dois níveis | distância padronizada (tipo *d*) | maior = estados mais separados |
| `beta_bimodality` / `stream_beta_bimodality` | **Há mesmo dois estados?** | coeficiente de bimodalidade de Sarle | **> 0,555** sugere dois patamares reais; abaixo disso, a divisão ON/OFF é só descritiva |

### Artefato cardíaco e qualidade do sinal — F15 (medidas agudas)

| Variável | Em linguagem simples | Como é medido | O que sugere |
|---|---|---|---|
| `ecg_n_beats`, `ecg_bpm` | Quantos **batimentos cardíacos** aparecem no registro do cérebro | detecção de picos R em duas passagens por correlação de template | batimento visível no LFP = contaminação cardíaca presente |
| `ecg_detection_confidence` | O quanto se pode confiar nessa detecção | n de batimentos, regularidade do RR e destaque do QRS | confiança baixa pede **ECG externo** na próxima sessão |
| `ecg_suppression_db` | **Quanto artefato foi removido** (em dB) | 10·log₁₀(potência antes / depois) em 0,5–40 Hz | acima de 0 indica supressão efetiva |
| `ecg_beta_peak_recovery` | Se o **pico beta sobreviveu** à limpeza | proeminência depois ÷ antes (janela de ±5 Hz) | perto de 1 = preservado; muito abaixo = a limpeza levou o sinal junto |
| `ecg_cleaning_verdict` | Leitura conjunta das duas métricas acima | regra sobre supressão + recuperação | é o que autoriza (ou não) usar o sinal limpo |

> **Por que isso importa.** Contaminação cardíaca é critério de exclusão documentado (van Rheede et al. excluíram **2 de 12 STN** inteiros da série crônica) e causa reconhecida de **maladaptação em aDBS** (Busch et al.). Até aqui o app removia ECG **sem informar quanto removeu nem se preservou o pico** — agora as métricas de validação são saída obrigatória.

### Chaves de identificação (em toda linha exportada)

| Variável | Significado |
|---|---|
| `subject_id` | identificador pseudonimizado do paciente (`sub-XXXXXXXX`) |
| `implant_date` | data de implante do gerador |
| `session_date_local` | data da sessão (hora local) |
| `days_since_implant` | dias entre o implante e a sessão — eixo natural para acompanhamento longitudinal |
| `hemisphere`, `target` | lado (Left/Right) e alvo (STN/GPi/VIM) |

---

## Métodos

**Espectral** — Welch (Hann, sobreposição 50 %, detrend linear por segmento); espectrograma STFT;
parametrização periódico/aperiódico por regressão robusta iterativa em log-log, aproximando o
specparam/FOOOF (F1, F2).

**Varredura do Survey (F1)** — um Survey de eletrodo anelar rende 6 pares bipolares por
hemisfério; com eletrodo direcional passa de 15. Abrir um a um num menu para descobrir onde o
marcador é mais forte é trabalhoso e compara mal — o olho não guarda a curva anterior. A figura
mostra **todos os pares do hemisfério juntos**, cada um sobre a própria linha de base (gráfico de
cumeeira, *ridgeline*), que é o arranjo que evita a sobreposição das curvas. O par com mais
marcador fica destacado na cor do beta baixo; o mouse sobre qualquer curva revela a **combinação
de contatos** e os números daquele par; o clique abre esse par no detalhe abaixo. Uma tabela lista
os **três melhores de cada hemisfério**.

A ordenação usa, por padrão, a **área acima do fundo aperiódico** dentro da banda — e não a área
bruta. O motivo é direto: a magnitude bruta soma a oscilação COM o fundo 1/f, então um par com
impedância diferente ou mais ruído sobe sem ter mais oscilação. Há teste que constrói exatamente
esse caso e verifica que os dois critérios dão ordens diferentes. Quando o ajuste aperiódico de um
par não é utilizável (R² < 0,5), ele **não entra na ordenação** — vai para o fim da lista,
marcado: comparar sua área bruta com a área corrigida dos outros produziria uma ordem sem
significado. Pares repetidos entre sessões entram pela **mediana ponto a ponto**, para que um
registro contaminado por artefato não puxe o ranking.

Esta ordem descreve onde o marcador é mais forte no registro carregado. Não é, por si só, a
escolha do contato de estimulação: proximidade ao alvo, efeitos colaterais e janela terapêutica
entram na decisão e não estão neste dado — e a figura diz isso.

**Multitaper de Slepian (F18)** — as sequências DPSS são calculadas **do zero** pelo problema
tridiagonal simétrico de Percival & Walden: autovalores por bissecção com sequência de Sturm,
autovetores por iteração inversa com o algoritmo de Thomas, ortogonalização de Gram-Schmidt entre
ordens. A razão de concentração λ de cada taper sai por Parseval (integral de |V(f)|² dentro de
±W) e é **reportada** — tapers pouco concentrados vazam e são descartados com contagem explícita.
O multitaper aplica K janelas ortogonais ao **mesmo trecho**, em vez de picar o registro, o que
importa em streaming curto: num registro de 4 s o Welch se recusa por falta de segmentos e o
multitaper recupera a frequência de pico com erro < 0,02 Hz. IC 95 % por jackknife entre tapers em
escala logarítmica (Thomson & Chave).

**specparam completo (F19)** — o procedimento do artigo de Donoghue et al., não a aproximação:
ajuste aperiódico robusto (reajustado só sobre os pontos abaixo da primeira curva, para os picos
não puxarem a inclinação), busca **iterativa** de gaussianas com **limites de largura**, reajuste
**simultâneo** de todos os picos por Levenberg-Marquardt e reajuste final do aperiódico sobre o
espectro sem picos. Dois modos de aperiódico — reta (`b − χ·log₁₀f`) e **com joelho**
(`b − log₁₀(k + f^χ)`) — ajustados e comparados por **AIC**, de modo que a escolha fique
justificada por número. Recuperação medida contra ground truth: erro do expoente < 0,01,
do offset < 0,01, da frequência de pico < 0,01 Hz e da largura < 0,1 Hz.

**Wavelet de Morlet (F20)** — CWT complexa por convolução via FFT, com σ_t = n_ciclos/(2πf₀) e
normalização em energia. As bordas dentro do **cone de influência** (2σ de cada lado) voltam como
NaN: são desconhecidas, não zero. A delimitação de burst separa **detecção** (cruzar o limiar) de
**delimitação** (descer a uma fração dele, padrão 0,5) — sem isso a duração medida vira função do
limiar escolhido e comparações entre estudos deixam de significar algo. Junto vem a **curva de
sensibilidade ao número de ciclos**: se a duração média muda mais de 25 % entre 3 e 10 ciclos, ela
é do método, não do cérebro.

**Limiar de burst pela linha de base 1/f (F20)** — o percentil do próprio registro é circular: se
o paciente passa mais tempo em beta alto, o percentil sobe junto e "não há mais bursts". Um limiar
ancorado no **componente aperiódico** não se move com a atividade oscilatória. Medido: triplicar a
potência da banda muda o limiar aperiódico em 0,3 %. O preço é depender do ajuste, e por isso o R²
sai junto e o limiar é declarado frágil abaixo de 0,8.

**PAC — acoplamento fase-amplitude (F21)** — índice de modulação de Tort (divergência KL da
distribuição de amplitude por bin de fase em relação à uniforme) e **comodulograma**. Nada aqui
devolve MI cru sozinho: sempre vêm o **z contra surrogados** por deslocamento temporal (semente
fixa, reprodutível) e o p empírico. Junto roda a **checagem de forma de onda** (simetria pico-vale
de Cole & Voytek), porque uma onda não senoidal gera harmônicos que se acoplam à própria
fundamental — PAC espúrio, sem nenhuma interação entre redes. Validação: z = 24 em sinal acoplado
simulado, z ≈ 0 no controle sem acoplamento.

**Actograma e banda-controle (F25)** — o actograma é a representação clássica da cronobiologia:
cada linha traz o dia **e o dia seguinte lado a lado** (duplo-plot), o que torna visível a deriva
de fase — um ritmo que atrasa um pouco por dia aparece como faixa diagonal, coisa que o heatmap
simples esconde. A acrofase de cada dia é a **média circular do perfil ponderada pelo excesso
sobre o mínimo**, não o bin de máximo: com poucas amostras por bin, o argmax salta para o vizinho
por ruído e a "deriva" resultante é do estimador, não do ritmo. Recuperação medida: derivas
verdadeiras de 0, +0,25 e −0,5 h/dia estimadas em 0,05, 0,22 e −0,51.

A **banda-controle** responde à pergunta que separa ritmo de artefato: um padrão diurno na potência
do marcador pode ser ritmo neural — ou postura, movimento, impedância que muda com a temperatura,
qualquer coisa que module o sinal **inteiro**. O teste é ver se a mesma variação aparece numa banda
que não deveria carregar o biomarcador. A comparação entre os dois perfis é feita por **permutação
de cluster** ao longo do eixo de hora, não ponto a ponto.

**Permutação de cluster (`stats/cluster.js`)** — comparar 48 bins de hora ponto a ponto gera
dezenas de testes: Bonferroni destrói o poder, não corrigir produz achados onde só há ruído. O
teste troca a unidade de inferência — em vez de "este bin difere?", pergunta "existe uma **região
contígua** de diferença maior do que o acaso produziria?". E registra, junto do p, o que ele **não**
autoriza concluir: um cluster significativo diz que há diferença em algum lugar dentro dele, não
que ela vale para cada ponto, nem que as bordas do cluster são as bordas do efeito
(Sassenhagen & Draschkow 2019).

**Longitudinal (F26)** — comparar o beta de hoje com o de seis meses atrás só faz sentido se o que
mudou foi o cérebro, e não a medida:

- **Deriva de impedância** por contato monopolar, com inclinação em Ω/dia. Impedância sobe com
  encapsulamento glial e altera o divisor de tensão, portanto a amplitude registrada: uma queda de
  potência no mesmo contato, no mesmo período de um salto de impedância, não é achado neural.
- **ICC (`stats/icc.js`)** — ICC(2,1) *e* ICC(3,1) com IC de 95 % pelo método F. Os dois saem porque
  a escolha muda o número: o (3,1) ignora diferença sistemática entre sessões e dá valor maior; para
  test-retest o pertinente é o (2,1). Quando o IC atravessa categorias — comum com poucos sujeitos —
  o software diz que **o dado não distingue confiabilidade ruim de excelente**, em vez de reportar o
  ponto. Com menos de 3 sujeitos ele recusa e explica o motivo estatístico: não existe variância
  entre sujeitos para comparar com o ruído de medida.
- **Uso e bateria** a partir dos contadores acumulados, com a ressalva de que descrevem o aparelho,
  não a adesão do paciente.

**Sinal externo, sincronização e coerência (F24)** — várias perguntas de LFP só se respondem com
um segundo sinal. Em tremor: a oscilação do STN é do cérebro ou é o próprio tremor entrando pelo
eletrodo? Em distonia cervical: o pico teta-alfa do GPi é biomarcador ou é o tremor cefálico de
1–6 Hz batendo em cima dele? O importador lê CSV/TSV de qualquer origem (Delsys, APDM/Opal,
planilha, gravador genérico), descobre delimitador, cabeçalho, coluna de tempo e canais, e declara
a **frequência de amostragem inferida e a irregularidade dela**. Nada é interpolado: lacuna vira
NaN, linha malformada é descartada com contagem, unidade não declarada fica desconhecida.

*Sincronização* — três caminhos, do mais confiável ao menos, e o escolhido sai sempre declarado
com a evidência que o sustenta:

| método | como | quando confiar |
| --- | --- | --- |
| artefato de estimulação | liga/desliga produz um degrau nos **dois** sinais — é o mesmo evento físico | com ≥ 2 eventos concordando dentro de dezenas de ms |
| correlação cruzada de envelopes | procura o deslocamento que maximiza a correlação, testado contra surrogados | só quando o pico se destaca do nulo **e** é estreito |
| timestamp declarado | diferença entre as horas dos arquivos | nunca, sem confirmação — os relógios não são sincronizados entre si |

A correlação cruzada reporta a **largura do pico** como incerteza do alinhamento: o envelope de um
ritmo estreito é liso, então o máximo é raso e o deslocamento fica mal determinado mesmo com
correlação de 0,9. Reportar só o máximo esconderia isso.

*Coerência* — três armadilhas, todas tratadas:

1. **Coerência é inflada por poucos segmentos.** Sob a hipótese nula ela vale 1/L, não zero: com 4
   segmentos, dois ruídos independentes dão Cxy ≈ 0,25, que parece "coerência moderada". O limiar
   `1 − α^(1/(L−1))` sai sempre junto, com L corrigido para a sobreposição das janelas.
2. **Tomar o máximo sobre os bins da banda é comparação múltipla.** Há um segundo limiar, corrigido
   por Šidák sobre o número de bins — sem ele, ruído puro passa quase metade das vezes.
3. **Condução de volume e referência comum** produzem coerência com fase zero sem interação
   nenhuma. A **parte imaginária** da coerência (Nolte et al.) só sobrevive onde houve atraso de
   propagação, e é avaliada **na frequência em que há coerência**, não no seu próprio máximo ao
   longo da banda — onde a coerência é ruído, a parte imaginária também é.

Validado contra ground truth: atraso conhecido de 20, 40 e 60 ms recuperado com erro máximo de
**2,8 ms**; mistura instantânea sinalizada (fase 0,7°, imaginária 0,011) e acoplamento com atraso
não confundido com ela (fase 71°, imaginária 0,94); ruído independente **não** dá significativo.

**Gama endógena vs. entrained (F22)** — dois fenômenos na mesma faixa com leituras clínicas
**opostas**: a gama finamente sintonizada (60–90 Hz) acompanha o estado ON e discinesia; a gama
*entrained* é o engate 1:2 da rede com a própria estimulação, travado em f_stim/2. O
discriminador é aritmético e explícito (proximidade a f_stim/2, estreiteza, dobras de aliasing), e
**sem a frequência de estimulação o software se recusa a classificar** em vez de escolher a
interpretação mais interessante. A confirmação definitiva exige registrar o mesmo canal com duas
frequências de estimulação: se o pico acompanha f_stim/2, é entrained; se fica parado, é
endógeno — e `confirmEntrainment` faz esse teste.

**Bursts** — passa-banda de fase zero por FFT, envelope de Hilbert, limiar por percentil,
exclusão de bursts curtos, histograma de duração e **curva de sensibilidade ao percentil**
(o resultado depende sistematicamente dessa escolha — pré-registre-a).

**Artefato cardíaco** — detecção de QRS em 5–30 Hz e subtração de template.

**Circadiano** — cosinor com harmônicos de 24 e 12 h (MESOR, amplitude, acrofase);
IC 95 % por bootstrap de blocos reamostrando **dias inteiros**, o que preserva a autocorrelação
intradiária; ρ AR(1) dos resíduos com p corrigido por *n* efetivo; η² da hora do dia por ANOVA;
teste de Rayleigh das acrofases diárias. No R, `cosinor_misto()` ajusta o modelo de efeitos
mistos com `nlme::corAR1` e `gamm_circadiano()` oferece spline cíclica para ritmo não senoidal.

**Eventos** — média alinhada com normalização pela linha de base e teste de permutação.

**Estados ON/OFF (F13)** — a série de **amplitude de beta** — envelope de Hilbert do sinal bruto
(`betaEnvelopeSeries`) no streaming, ou a potência de 10 min do Timeline — é separada em dois níveis por
**k-médias (k = 2)** com inicialização determinística em Q1/Q3, limiar no ponto médio dos centróides e
limpeza morfológica de **duração mínima** para evitar oscilação (`detectStates`). Alto beta ≈ OFF, baixo
beta ≈ ON. O **coeficiente de bimodalidade de Sarle** (`bimodalityCoefficient`, > 0,555 sugere dois modos)
indica honestamente se de fato existem dois estados — ao contrário da distância entre clusters, que o
k-médias sempre infla. É um **correlato**: artefato de movimento infla o beta (falso OFF) e a própria
estimulação o reduz; em Parkinson o método rende mais no Timeline crônico, ao longo dos ciclos da levodopa.

---

## Armadilhas que o código trata explicitamente

1. **Fuso horário.** Os timestamps do Percept estão em UTC. Análise circadiana sem conversão
   para hora local está errada. Mudanças de horário de verão e viagens são quebras na série.
2. **Autocorrelação.** A cada 10 min, resíduos consecutivos têm ρ tipicamente > 0,9. O *p* do
   cosinor de efeitos fixos é anticonservador; use o modelo misto com AR(1).
3. **Acrofase é grandeza circular.** Média aritmética de horários é incorreta — use Rayleigh.
4. **Detrending diário** é obrigatório no heatmap circadiano, sob pena de a deriva entre dias
   mascarar o ritmo.
5. **Unidades.** O valor de LFP do Timeline muda de escala entre versões de firmware
   (µVp em algumas, contagens brutas em outras). É tratado como unidade arbitrária.
6. **Artefato de movimento** pode gerar padrão pseudo-diurno. Confirme com banda-controle.
7. **Pacientes distintos nunca são agregados** — a PWA detecta e obriga a escolher um registro.

---

## Desempenho e retorno de processo

Todo o cálculo roda na thread principal do navegador, no computador de quem usa. Um Session
Report com meses de Timeline (dezenas de milhares de pontos) e minutos de streaming (centenas de
milhares de amostras) leva alguns segundos para ser processado — e durante um cálculo em
JavaScript a página não repinta. Sem retorno visual, isso é indistinguível de travamento.

O aplicativo, por isso, **anuncia cada etapa antes de executá-la** e registra quanto cada uma
levou, num painel que não bloqueia a tela:

| etapa anunciada | o que está acontecendo |
| --- | --- |
| `lendo <arquivo> (N MB)` | leitura do disco pelo próprio navegador; nada sai do dispositivo |
| `interpretando <arquivo>` | `JSON.parse` e extração das modalidades do Percept, com pseudonimização na borda |
| `agregando séries do registro` | concatenação e desduplicação do Timeline entre arquivos do mesmo registro |
| `montando painel do registro` | matriz de disponibilidade, perfil de doença, opções de exportação |
| `figura Fx — <título>` | cálculo daquela figura, uma por vez |

Regras que decorrem disso:

- **Só três figuras são calculadas ao carregar** (F1, F8, F9). As demais só calculam quando
  abertas, e mostram o aviso *"calculando… o navegador não travou"* **antes** de o cálculo
  começar. Figuras que levam mais de 1,5 s informam, ao final, quanto levaram naquele registro.
- **Etapas lentas ficam marcadas na lista** com o tempo real medido. Uma espera longa é legível:
  dá para ver qual etapa custou o quê, em vez de olhar para uma tela parada.
- **Uma etapa que falha não derruba as demais** — ela é marcada como falha, com a mensagem de
  erro, e o carregamento continua.
- **Exportações e o relatório em PDF também anunciam suas etapas**, porque recalculam todas as
  métricas e todas as figuras.

### Trabalhador de segundo plano (Web Worker)

Anunciar cada etapa resolve o *"travou?"*, mas o cálculo continuava na thread principal — e
enquanto ele roda, a página não repinta e nada responde ao clique. Os três passos mais caros
(`parsePerceptText`, `extractMetrics`, `qcPanel`) agora rodam num **Web Worker**.

Sem quebrar o invariante do arquivo único: o worker **não vem de um arquivo separado**. O código
do núcleo já está no primeiro `<script>` da página e é lido de volta em tempo de execução
(`document.scripts[0].textContent`), concatenado a um pequeno despachante e transformado em Blob.
Nenhuma requisição de rede, nenhum arquivo adicional, nenhuma duplicação do bundle. O worker só
executa **funções próprias e nomeadas do núcleo** — nunca código vindo da interface.

Quando não dá (navegador sem `Worker`, `file://` restritivo), **não há degradação silenciosa**: o
motivo é registrado, aparece no rodapé do painel de processo e vai para o manifesto de
proveniência, e o cálculo roda na thread principal exatamente como antes.

Medido em Chromium com um registro de 5,4 MB, cronometrando o atraso de um timer de 25 ms durante
todo o carregamento:

| | mediana do bloqueio | pior bloqueio | bloqueio acumulado |
| --- | ---: | ---: | ---: |
| antes | 60 ms | 851 ms | 1549 ms |
| **com o trabalhador** | **1 ms** | **196 ms** | **419 ms** |

O que sobra é o desenho das figuras, que precisa mesmo da thread principal (canvas). O manifesto
de proveniência passou a registrar, para cada passo pesado, **quanto levou e onde foi calculado** —
é o que permite dizer, meses depois, que o número saiu do cálculo completo e não de um caminho
degradado.

O gargalo real do carregamento era o **bootstrap de blocos do cosinor** (F9). Ele foi
reescrito somando as **equações normais por dia**: como (XᵀX, Xᵀy) é aditivo sobre blocos
disjuntos, cada reamostragem de dias inteiros passou a ser a soma de matrizes pré-calculadas e a
solução de um sistema 5×5, em vez de reajustar o modelo sobre todas as amostras. O estimador é o
**mesmo** — os testes comparam contra o reajuste completo com a mesma sequência de sorteio e
exigem diferença < 10⁻⁸ — e o custo caiu de ~5,3 s para ~0,05 s em 26 000 pontos com 200
reamostragens. A reamostragem passou a usar semente fixa, então o IC é **reprodutível** entre
execuções, como o manifesto de proveniência exige.

Medido num arquivo de 8 MB (180 dias × 144 pontos × 2 hemisférios, mais 10 min de streaming a
250 Hz), em navegador real: **do arquivo solto ao primeiro gráfico, menos de 1,5 s**, com todas
as etapas visíveis.

---

## Checklist de captura

Para habilitar as figuras que aparecerem como "sem dados", na próxima sessão de programação:

1. **BrainSense Survey** bilateral, com estimulação desligada → F5, F6
2. **BrainSense Streaming** ≥ 60 s em repouso, com rampa de amplitude → F6, F7, F13
3. **BrainSense Timeline** habilitado nos **dois** hemisférios → F8, F9, F11, F13
4. **Registro de eventos pelo paciente** ativado, ≥ 5 dias de registro domiciliar → F10, F12
5. Baixar sempre o **JSON**, nunca só o PDF
6. Anotar mudanças de horário de verão e viagens entre fusos

---

## Estrutura

```
index.html                 aplicação completa, autocontida (gerada a partir de src/)
manifest.webmanifest       metadados da PWA
sw.js                      service worker (offline)
icon-*.png                 ícones
src/                       fontes editáveis da aplicação
  percept-core.js            parser do JSON, DSP, estatística, extração de métricas e estados ON/OFF
  percept-plot.js            biblioteca de plotagem em Canvas 2D
  app.js                     UI, renderizadores F1–F13 e exportação (PDF/CSV/JSON)
  styles.css                 folha de estilos
  index.template.html        template
  build.mjs                  gera index.html
R/percept_lfp.R            61 funções: leitura, DSP, estatística, figuras ggplot2
docs/estado-da-arte.md     revisão de literatura e mapa da estrutura do JSON
docs/Revisao_LFP_Parkinson.pdf  revisão sobre LFP na doença de Parkinson
tools/gerar_exemplo.mjs    gerador do dataset sintético
tests/run.mjs              suíte de 128 testes
examples/                  dataset sintético
```

Após editar qualquer arquivo em `src/`, rode `cd src && node build.mjs` e faça commit do
`index.html` regenerado — a integração contínua verifica que os dois estão sincronizados.

## Validação quantitativa

Além dos testes de regressão, o pipeline é medido contra **ground truth** conhecido:

```bash
node tests/benchmark.mjs --out benchmark
```

**56/56 critérios aprovados** — detecção de picos R com 100% de VP e 0% de FP, recuperação da fs
efetiva com erro de 0,0016 Hz, deteção de pacotes perdidos com Jaccard 1,00, F1 de burst 0,98.
Tabela completa, metodologia e **limitações honestas** em [`docs/validacao.md`](docs/validacao.md).

---

## Testes

```bash
node tools/gerar_exemplo.mjs examples
node tests/run.mjs
```

128 testes cobrindo parser, DSP tolerante a lacunas, integridade de pacotes, estatística, camada gráfica,
os 14 renderizadores, a extração de métricas, os estados ON/OFF e a remoção de artefato cardíaco
(varredura de SNR com ground truth).
e a detecção de estados ON/OFF.

---

## Reprodutibilidade e padrão de reporte

Toda análise pode exportar um **manifesto de proveniência** com os parâmetros **efetivamente
usados** em cada passo (não os default), o n de entrada e saída de cada etapa, o que foi descartado
e por quê, o SHA-256 de cada arquivo de entrada e um **hash final citável** como identificador de
versão de análise. `verifyManifest()` recarrega os mesmos arquivos, refaz a análise e **confirma que
os resultados batem** — reprodutibilidade verificável, não declarada.

Sobre esse manifesto o software gera o **PERCEPT-REPORT**, uma proposta de checklist de itens
mínimos de reporte para estudos de LFP com dispositivos de sensing — lacuna documentada do campo,
que não tem equivalente ao CONSORT/STROBE/PRISMA. **30 dos 41 itens são preenchidos
automaticamente**; o que o software não consegue extrair é marcado como *não determinado*, nunca
deixado em branco. Saída em Markdown e em **DOCX**, pronta para anexar como material suplementar.

Proposta completa, com a fundamentação de cada item, em
[`docs/PERCEPT-REPORT.md`](docs/PERCEPT-REPORT.md).

---

## Como citar

Ver [`CITATION.cff`](CITATION.cff).

**Para obter um DOI** (necessário para citação formal): conecte o repositório ao
[Zenodo](https://zenodo.org/account/settings/github/), publique um *release* com tag
(`git tag -a v0.5.0 -m "..." && git push --tags`), e o DOI é emitido automaticamente. Depois,
descomente e preencha os campos `doi` e `identifiers` em `CITATION.cff`. Sem DOI, ninguém cita.

## Aviso

Ferramenta de **pesquisa e apoio à decisão**. Não substitui o julgamento clínico nem o software
regulado do fabricante, e não é um dispositivo médico. Licença MIT — ver [`LICENSE`](LICENSE).
