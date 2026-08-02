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

## Figuras

A coluna **Leitura clínica** resume, em uma frase, o que cada figura diz ao médico.

| ID | Figura (técnico) | Fonte necessária | Leitura clínica |
|----|------------------|------------------|-----------------|
| F1 | Espectro anotado (linear + log-log), tabela de bandas | Signal Test, Survey ou Signal Check | Onde está a força do sinal e onde fica o **pico beta** (marcador de rigidez/lentidão). |
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

Cada figura exporta PNG e os dados subjacentes em CSV.

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
specparam/FOOOF.

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
tests/run.mjs              suíte de 118 testes
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

118 testes cobrindo parser, DSP tolerante a lacunas, integridade de pacotes, estatística, camada gráfica,
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
