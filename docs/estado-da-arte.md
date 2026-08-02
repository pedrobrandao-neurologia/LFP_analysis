# LFP subtalâmico via Medtronic Percept™ PC
## Parte I — Mapa estrutural do arquivo | Parte II — Estado da arte em representação gráfica e análise estatística

*Documento técnico preparatório para desenvolvimento de pipeline de visualização*
Arquivo analisado: `Report_Json_Session_Report_20250106T132153.json`

> **Nota antes de tornar público.** A Parte I descreve uma sessão clínica real
> (datas, impedâncias, parâmetros de estimulação e firmware de um caso concreto).
> Não há identificadores diretos, mas revise se esse nível de detalhe é adequado
> ao seu contexto antes de publicar o repositório — ou substitua a Parte I pela
> análise do dataset sintético (`examples/exemplo_sintetico.json`).

---

# PARTE I — ANATOMIA DO ARQUIVO

## 1.1 Metadados de sessão

| Campo | Valor |
|---|---|
| `SessionDate` / `SessionEndDate` | 2025-01-04T12:59:12Z → 13:00:43Z (**91 segundos**) |
| `ProgrammerTimezone` / `ProgrammerUtcOffset` | Horário de Verão de Brasília / **−02:00** |
| `ProgrammerVersion` | 3.0.1098 |
| `Neurostimulator` / `Model` | Percept PC / B35200 |
| `ImplantDate` | 2024-11-27 (sessão a **38 dias** do implante) |
| Eletrodos | **B33005 SenSight** (direcionais 1-3-3-1), bilateral, `LeadLocation = Stn` |
| `AccumulatedTherapyOnTimeSinceImplant` | 3442 h |
| `BatteryPercentage` | 99% |

**Grupo ativo (A, 100% de uso), configuração terapêutica:**

| Parâmetro | STN esquerdo | STN direito |
|---|---|---|
| Contatos ativos | 1a+1b+1c (anel virtual, −21/64 cada) | 2a+2b+2c (anel virtual, −21/64 cada) |
| Amplitude | 0,5 mA | 0,9 mA (0,3 × 3) |
| Largura de pulso / frequência | 60 µs / 125 Hz | 60 µs / 125 Hz |
| Sensing | — | **habilitado**, canal 1–3 |

**Parâmetros de sensing (`SensingSetup`), STN direito:**
`FrequencyInHertz = 16,6 Hz` · `AveragingDurationInMilliSeconds = 3000` · `LowerLfpThreshold = 20,0` · `UpperLfpThreshold = 30,0` · `SuspendAmplitude = 1,0 mA` · `HighPassFilterInHertz = 1` · `SensingBlankingDuration = 2000 µs` · `ArtifactStatus = ARTIFACT_NOT_PRESENT`

---

## 1.2 O que existe de dado neurofisiológico neste arquivo

Uma varredura completa das 119 chaves únicas identificou **exatamente um espectro de potência**, replicado em três locais (`Groups.Initial`, `Groups.Final`, `GroupHistory[0].Groups[0]`) — todos idênticos:

```
Groups → Final[0] → ProgramSettings → SensingChannel[0]
       → SensingSetup → ChannelSignalResult
           ├── Channel: ONE_THREE_RIGHT
           ├── ArtifactStatus: ARTIFACT_NOT_PRESENT
           ├── SignalFrequencies: [0,00 … 96,68] Hz — 100 bins, Δf = 0,977 Hz
           ├── SignalPsdValues:   [100 valores em µVp/√Hz]
           ├── PeakFrequencies:   [17]
           └── PeakValues:        [3,898]
```

Δf = 0,977 Hz ≙ 250/256, confirmando **FFT de 256 pontos sobre sinal amostrado a 250 Hz** — a assinatura do *BrainSense Signal Test* (varredura automática de ~20 s por canal, executada com estimulação desligada).

Interpretação clínica direta: pico beta-baixo em **17 Hz com 3,90 µVp** no canal 1–3 do STN direito, sem artefato detectado. A janela de sensing crônico foi centrada em 16,6 Hz (± 2,5 Hz → 14,1–19,1 Hz), coerente com o pico. Os limiares de aDBS (20/30) estão preenchidos, mas `MeasuredUpperLfp = MeasuredLowerLfp = 0`, ou seja, **os limiares não foram calibrados a partir de medida real** — foram valores padrão/manuais.

Também há dado quantitativo em:
- **`Impedance`** — 8 monopolares + 28 bipolares **por hemisfério** (bilateral). `ImpedanceStatus = INVESTIGATE`: contatos 0 (2035 Ω) e 3 (1444 Ω) do STN esquerdo destoam dos segmentados (4042–5042 Ω), padrão esperado para contatos de anel vs. segmentados, mas que merece verificação seriada.
- **`DiagnosticData.EventLogs`** — 10 eventos (início/fim de sessão, teste de integridade, mudança de grupo, `TherapyStatus ON/OFF` em 04/01 às 11:42 e 12:12 UTC). Permite reconstruir a linha do tempo da consulta.
- **`GroupUsagePercentage`**, `AccumulatedTherapyOnTime`, `BatteryInformation` — adesão e uso.

---

## 1.3 ⚠ O que **não** existe — e por quê isso é decisivo

Nenhum dos campos que carregam séries temporais de LFP está presente:

| Campo ausente | Modalidade | O que traria |
|---|---|---|
| `BrainSenseTimeDomain` | BrainSense Streaming (bruto) | Sinal a 250 Hz, ~µV, base para PSD, espectrograma, bursts |
| `BrainSenseLfp` | BrainSense Streaming (potência) | Potência da banda a 2 Hz **com estimulação ligada** + amplitude de estimulação sincronizada |
| `LfpMontageTimeDomain` / `LFPMontage` | BrainSense Survey | 6 canais bipolares × hemisfério — mapeamento espacial do pico |
| `IndefiniteStreaming` | Survey indefinido | Registro multicanal simultâneo prolongado |
| `DiagnosticData.LFPTrendLogs` | **BrainSense Timeline** | **Potência média a cada 10 min, por dias–meses** |
| `DiagnosticData.LfpFrequencySnapshotEvents` | Patient Events | PSD disparada pelo paciente em eventos sintomáticos |
| `EventSummary` / `PatientEvents` | Marcadores | Contagem/tipo de eventos registrados pelo paciente |
| `MostRecentInSessionSignalCheck` | (presente, porém **vazio**: `[]`) | Signal check da própria sessão |

**Consequência prática:** o objetivo declarado — *representar graficamente LFPs ao longo de períodos temporais* — **não é executável com este arquivo**. O que existe é um único instantâneo espectral de ~20 s. Não há eixo de tempo.

Isso não é falha do arquivo: é o perfil típico de uma **sessão curta de programação** (91 s de conexão), em que o clínico verificou o grupo, testou integridade e desconectou, sem executar streaming nem habilitar/baixar Timeline. Ver §5 para o checklist de captura.

### Nota de conformidade (LGPD)
O arquivo contém identificadores diretos em `PatientInformation` (nome completo, data de nascimento, `PatientId`) e `DeviceInformation.NeurostimulatorSerialNumber`. Antes de qualquer uso em pesquisa, versionamento em repositório, compartilhamento ou processamento em serviço de terceiros, é obrigatória a **pseudonimização** desses campos (o `perceive` implementa desidentificação automática com renomeação para `sub-XXX`). Recomenda-se manter a chave de reidentificação em arquivo separado e de acesso restrito.

---

# PARTE II — ESTADO DA ARTE

## 2.1 Premissas de aquisição do Percept que condicionam toda análise

- Amostragem de **250 Hz**; filtro passa-baixas de 100 Hz e passa-altas de 1 Hz ou 10 Hz (configurável — aqui, 1 Hz). Banda útil efetiva ≈ 1–100 Hz, com Nyquist em 125 Hz.
- Registro **bipolar** entre contatos que flanqueiam o contato de estimulação (0–2, 1–3), para rejeição de modo comum do artefato de estimulação.
- No **Timeline**, o dispositivo registra a potência média de uma janela de **5 Hz** ao redor da frequência-alvo, amostrada **a cada 10 minutos**, com *timestamp* em **UTC** — o que exige conversão explícita para hora local antes de qualquer análise circadiana (aqui, UTC−02:00 no verão / UTC−03:00 no restante do ano; a mudança de horário deve ser tratada como quebra na série).
- A unidade nativa é **µVp** (pico), não µV²/Hz — atenção ao rotular eixos e ao comparar com literatura de LFP externalizado.

**Artefatos que precisam de tratamento explícito:**

1. **Artefato cardíaco (QRS).** É o contaminante mais prevalente e desloca sistematicamente a PSD nas bandas teta, alfa e beta — precisamente as bandas de interesse. Três abordagens consolidadas: interpolação do QRS (implementada no `perceive`), subtração de *template* no domínio do tempo e decomposição por SVD com remoção do componente que reproduz o complexo QRS. Há estudo comparativo direto dos três métodos.
2. **Artefato de movimento.** Movimentos específicos degradam a qualidade do LFP e podem *gerar* padrões pseudo-diurnos. Fischer et al. demonstraram que parte da modulação diurna aparente em alguns pacientes decorre de artefato, não de fisiologia — o controle proposto é comparar a banda de interesse com uma banda-controle (p.ex. teta contralateral) e inspecionar registros durante movimentos padronizados.
3. **Outliers no Timeline.** Grandes *outliers* de LFP dificultam a interpretação do BrainSense Timeline; a recomendação atual (ADAPT-START) é registrar por períodos estendidos na vida real, permitindo excluir dias com dados artefatados ou não representativos.
4. **Aliasing de estimulação e sub-harmônicos.** Com 125 Hz de estimulação e Nyquist em 125 Hz, verificar sempre picos espúrios; a janela de *blanking* (2000 µs aqui) e o filtro passa-altas moldam o resíduo.

---

## 2.2 Catálogo de representações gráficas, por escala temporal

### Escala A — milissegundos a segundos (`BrainSenseTimeDomain`, `LfpMontageTimeDomain`)

| # | Representação | Especificação | Referência de método |
|---|---|---|---|
| A1 | **Traçado bruto** com marcação de QRS detectado e sinal pós-limpeza sobrepostos | 2 painéis (antes/depois), escala µV comum | Perceive; comparação de métodos de supressão de ECG |
| A2 | **PSD de Welch** | janela de Hamming 1 s, sobreposição 50%, média entre janelas | padrão na literatura de Percept |
| A3 | **PSD multitaper** | superior a FFT de janela única em relação viés–variância | Prerau et al., 2017 |
| A4 | **PSD em escala log-log** | revela o componente 1/f; é a forma canônica na literatura | Fischer et al., npj Parkinsons Dis 2022 (Fig. 1b) |
| A5 | **Decomposição periódico/aperiódico (specparam/FOOOF)** | 3 traçados: PSD observada, ajuste aperiódico (offset + expoente + *knee*), picos periódicos com centro/potência/largura | Donoghue et al., Nat Neurosci 2020 |
| A6 | **Espectrograma** | STFT ou multitaper deslizante; janela 512, sobreposição 75% (implementação do `LeadSense::brain_sense_spectrogram`) | LeadSense (R, CRAN) |
| A7 | **Envelope de Hilbert + detecção de bursts** | filtro ±3 Hz em torno do pico; envelope; limiar no **percentil 75**; exclusão de bursts < 100 ms | Tinkhauser/Lofredi; revisões metodológicas |
| A8 | **Perfil de duração de bursts** | histograma em janelas de 150 ms (200 → >800 ms), normalizado como % de bursts por faixa | Lofredi et al. 2019; Chen et al. 2023 |
| A9 | **Curva limiar-dependente** (duração média de burst vs. percentil de limiar) | expõe a não-monotonicidade e a sensibilidade metodológica | Yeh/Cagnan et al. 2020 |
| A10 | **Raincloud plot** (densidade + boxplot + pontos brutos) para amplitude/duração/probabilidade de burst por condição | evita ocultar a distribuição sob barras | boa prática de reporte |

> Nota metodológica sobre bursts: há controvérsia ativa sobre a definição de limiar (percentil da distribuição de amplitude vs. desvio da mediana). Uma alternativa é a **linha de base fisiológica** de Bronte-Stewart: comparar as durações de burst na banda beta com as de uma banda de sobreposição com ruído rosa 1/f do próprio paciente, o que dispensa a escolha arbitrária de percentil. Também há divergência entre Transformada de Hilbert e Wavelet Contínua — a HT tende a detectar bursts mais curtos que a CWT para o mesmo percentil, de modo que **o método deve ser pré-registrado e reportado explicitamente**.

### Escala B — minutos, com estimulação (`BrainSenseLfp` + `BrainSenseTimeDomain`)

| # | Representação | Especificação |
|---|---|---|
| B1 | **Potência da banda vs. tempo com amplitude de estimulação sobreposta** (eixo y duplo) | o gráfico central da programação guiada por sensing |
| B2 | **Curva dose-resposta** beta vs. mA | rampas de titulação; ajuste sigmoide ou linear por segmento; a supressão beta dose-dependente é achado replicado |
| B3 | **Espectrograma alinhado a evento** (início/fim da estimulação, início de movimento) | com barra de significância por *cluster-based permutation* |
| B4 | **Comparação por montagem/contato** — mapa contato × frequência (*heatmap*) do Survey | identifica o contato com maior pico beta; base para escolha de contato de sensing e, em parte, de estimulação |
| B5 | **Integração espacial com Lead-DBS** | projeção do pico beta sobre a reconstrução do eletrodo no atlas DISTAL |

### Escala C — horas a meses (`LFPTrendLogs` / BrainSense Timeline) — **o núcleo do pedido**

| # | Representação | Especificação | Referência |
|---|---|---|---|
| C1 | **Série temporal crua** de potência (µVp) por hemisfério, amostrada a 10 min, com remoção de *outliers* | Fischer et al. 2022, Fig. 1c |
| C2 | **Heatmap dia × hora** (linhas = dias, colunas = bins de 30 min), com **detrending por normalização de cada dia à sua mediana** | Fischer et al. 2022, Fig. 1d |
| C3 | **Gráfico de barras circular / polar** do ciclo de 24 h — mediana por bin de 30 min dentro de cada dia, depois mediana entre dias | Fischer et al. 2022, Fig. 1e |
| C4 | **Actograma duplo-plot** (48 h por linha), sobreposto a marcadores de sono/vigília ou actigrafia | análises de sono-vigília em Percept |
| C5 | **Curvas alinhadas a evento — resposta à levodopa** | janela de **−60 a +180 min** em torno da ingestão; média/mediana entre tomadas ± IC; permutação para significância | Ann Neurol 2025 |
| C6 | **Sobreposição beta × banda-controle** (p.ex. teta contralateral) na mesma escala | controle de artefato inespecífico | Fischer et al. 2022 |
| C7 | **Histograma / função de distribuição acumulada da potência**, com marcação dos limiares inferior e superior de aDBS e do % de tempo em cada faixa | ferramenta de decisão para programação de aDBS de duplo limiar | ADAPT-START, npj Parkinsons Dis 2026 |
| C8 | **Painel longitudinal multi-visita** — MESOR e amplitude circadiana por visita, com marcadores de mudança de LEDD/estimulação | acompanhamento crônico |
| C9 | **Timeline anotada** — potência + eventos do paciente + mudanças de grupo + `TherapyStatus` do `EventLogs` na mesma faixa temporal | integra `DiagnosticData` ao trend |

### Princípios de desenho que a literatura converge em adotar

- **Sempre por hemisfério e por canal**, nunca colapsados — a assimetria é informativa.
- **Escala log** para PSD; **escala linear** para trends de potência.
- **Detrending diário obrigatório** antes de qualquer heatmap circadiano, sob pena de a deriva de dias mascarar o ritmo.
- **Reportar o n de pontos válidos** após exclusão de outliers em cada figura.
- **Marcar explicitamente** o horário local, a frequência-alvo do sensing e o contato de registro em cada painel — sem isso a figura não é reprodutível.

---

## 2.3 Análise estatística sobre períodos temporais

### 2.3.1 Pré-processamento e normalização (decisão que precede o modelo)

| Estratégia | Quando usar | Observação |
|---|---|---|
| Potência **relativa** (banda / potência total 5–95 Hz) | comparações entre pacientes/contatos | controla parcialmente ganho e impedância |
| **Correção do aperiódico** (specparam) e uso da potência do pico periódico | quando o interesse é a oscilação *per se* | evita confundir deslocamento broadband com mudança oscilatória |
| **z-score intra-hemisfério** | comparação de forma de curva | perde a escala absoluta |
| **% da mediana do dia** | heatmaps circadianos | padrão de Fischer et al. |
| **log-transformação** | potência é fortemente assimétrica à direita | melhora a adequação a modelos gaussianos |
| Remoção de outliers | Timeline | mediana ± k·MAD (robusto) preferível a média ± k·DP |

### 2.3.2 Modelos para ritmicidade circadiana

**Cosinor** é o arcabouço de referência. O modelo estima três parâmetros interpretáveis: **MESOR** (média ajustada ao ritmo), **amplitude** (metade da extensão da variação no ciclo) e **acrofase** (ângulo correspondente ao horário do pico).

Formulação linearizável:

```
y(t) = M + β·cos(2πt/τ) + γ·sin(2πt/τ) + ε
  amplitude = √(β² + γ²)      acrofase = atan2(−γ, β)      τ = 24 h
```

Extensões relevantes para o desenho típico (vários dias, vários pacientes, medidas repetidas):

- **Cosinor de efeitos mistos (LME/GLMM).** Permite interceptos e inclinações aleatórios por paciente/hemisfério e interação dos parâmetros circadianos com covariáveis (LEDD, amplitude de estimulação, estado de sono). O tratamento formal linear vs. não-linear está em Mikulich et al., *Stat Med* 2003.
- **Harmônicos múltiplos** (τ = 24 h + 12 h) quando o padrão é bimodal — comum em séries com pico matinal e vespertino.
- **Atenuação por deslocamento de fase individual.** Quando cada indivíduo tem acrofase própria, o modelo de efeitos mixtos com fase fixa **subestima a amplitude populacional** e enfraquece o teste de hipótese. Existem correções heurísticas em dois estágios (estimar deslocamentos individuais e reestimar o modelo populacional).
- **Estatística circular** para a acrofase: teste de Rayleigh para uniformidade, teste de Watson-Williams para comparar grupos. Média aritmética de horários é incorreta.

**Pacotes em R:** `cosinor` / `cosinor2` (cross-seccional), **`cosinoRmixedeffects`** (efeitos mistos com MESOR/amplitude/acrofase, integrado a `emmeans`, inferência por bootstrap), **`GLMMcosinor`** (linearização dentro do arcabouço GLMM, sobre `lme4`), `CircaCompare` (compara MESOR, amplitude e fase entre dois ritmos), `circular` (estatística angular).

### 2.3.3 Modelos alternativos e complementares

| Objetivo | Modelo | Nota |
|---|---|---|
| Quantificar quanto do sinal a hora do dia explica | **LMM com hora do dia como fator/spline**, R² marginal e condicional | Fischer et al. reportaram que a hora do dia explicou **41 ± 9%** da variância da potência beta (p < 0,001 em todos os pacientes) |
| Ritmo com forma livre (não senoidal) | **GAMM** com *cyclic cubic spline* sobre a hora | mais flexível que cosinor; interpretabilidade menor |
| Autocorrelação serial (crítico em 10 min de amostragem) | resíduos **AR(1)** ou ARMA dentro do LMM/GLS; ou modelo de espaço de estados | **ignorar autocorrelação infla o erro tipo I** — é o erro mais comum nessas análises |
| Efeito de intervenção pontual (ajuste de estimulação, início de fármaco) | **série temporal interrompida** (nível + inclinação) | permite inferência causal fraca em N-de-1 |
| Resposta a evento repetido (levodopa) | **análise alinhada a evento** com LMM (tempo × dose) ou permutação por cluster | janela −60/+180 min é a convenção atual |
| Comparação de curvas inteiras entre condições | **cluster-based permutation test** | controla comparação múltipla ao longo de tempo/frequência sem assumir independência |
| Duração de burst / tempo até evento | modelos de sobrevivência / distribuição exponencial vs. lei de potência | testa se bursts são processo memoryless |
| Classificação de estado (ON/OFF, sono/vigília) | LDA, regressão logística mista, ou detectores lineares duplos | precedente em aDBS crônico domiciliar |

### 2.3.4 Comparação múltipla e reprodutibilidade

- Ao testar múltiplas bandas × hemisférios × condições, aplicar FDR (Benjamini-Hochberg) ou permutação; relatar o método escolhido.
- Em desenhos N-de-1 ou de poucos pacientes, priorizar **estimativa com intervalo de confiança** sobre teste de hipótese dicotômico; bootstrap por paciente.
- Pré-registrar: definição de banda, método de detecção de burst, percentil de limiar, critério de exclusão de outlier, tratamento de fuso horário. Todas essas escolhas alteram o resultado de forma documentada na literatura.
- Reportar sempre: n de dias, n de pontos válidos/excluídos, versão do firmware (aqui 07.05.05), contato de sensing e frequência-alvo.

---

## 2.4 Sugestão de portfólio de figuras (o que construir, e com que dado)

| Figura proposta | Dado necessário | Disponível neste JSON? |
|---|---|---|
| **F1.** PSD anotada (linear + log-log) com banda beta, pico, janela de sensing | `ChannelSignalResult` | ✅ **sim** |
| **F2.** Decomposição periódico/aperiódico | `ChannelSignalResult` (ideal: time-domain) | ⚠ aproximável |
| **F3.** Mapa de integridade — impedância mono + bipolar, bilateral | `Impedance` | ✅ **sim** |
| **F4.** Linha do tempo da sessão + parâmetros de estimulação | `EventLogs`, `Groups`, `GroupHistory` | ✅ **sim** |
| **F5.** Heatmap contato × frequência (escolha de contato) | `LfpMontageTimeDomain` (Survey) | ❌ |
| **F6.** Espectrograma + envelope + bursts | `BrainSenseTimeDomain` | ❌ |
| **F7.** Beta vs. amplitude de estimulação (dose-resposta) | `BrainSenseLfp` | ❌ |
| **F8.** Série temporal crônica multi-dia | `LFPTrendLogs` | ❌ |
| **F9.** Heatmap dia × hora + polar circadiano | `LFPTrendLogs` | ❌ |
| **F10.** Resposta à levodopa alinhada a evento | `LFPTrendLogs` + `PatientEvents` | ❌ |
| **F11.** Distribuição de potência com limiares de aDBS | `LFPTrendLogs` | ❌ |

Foi gerada uma prova de conceito cobrindo **F1–F4** (arquivo `percept_estrutura_demo.png`), demonstrando que o pipeline de leitura e anotação está funcional; falta apenas o dado temporal.

---

## 2.5 Checklist de captura para viabilizar F5–F11

Na próxima sessão de programação:

1. **BrainSense Survey** — executar bilateralmente com estimulação desligada (gera `LfpMontageTimeDomain`, 6 canais/hemisfério). Base para F5 e para reavaliar a escolha do canal 1–3.
2. **BrainSense Streaming** — ≥ 60 s em repouso, com estimulação ON e OFF; se possível, rampa de amplitude (gera `BrainSenseTimeDomain` + `BrainSenseLfp`). Base para F6 e F7. Considerar registrar ECG simultâneo para validar a remoção do artefato cardíaco.
3. **Habilitar BrainSense Timeline** no grupo ativo, **em ambos os hemisférios** (atualmente só o direito tem sensing habilitado — isso impede qualquer comparação inter-hemisférica). Definir a frequência-alvo pelo pico do Survey.
4. **Ativar registro de eventos pelo paciente** (`PatientEvents`) para marcar tomadas de levodopa, períodos OFF e discinesia — indispensável para F10.
5. **Aguardar ≥ 5 dias** de registro domiciliar antes de baixar; 3 dias podem bastar, mas períodos maiores permitem descartar dias artefatados.
6. **Registrar o diário de medicação** em paralelo, com horários reais das tomadas.
7. **Baixar sempre o JSON completo** (não o PDF de relatório) e arquivar com hash e data.
8. Anotar mudanças de horário de verão e viagens entre fusos.

---

## 2.6 Stack técnico recomendado

**R (preferencial para o fluxo de análise e figuras):**
- `LeadSense` (CRAN, 2025 — Bastos & Barbosa): leitura de JSON do BrainSense, `brain_sense_spectrogram()`, `impedance_summary()`, `lfp_data()`, `summary_long()`. Depende de `seewave` e `signal`.
- `jsonlite` para *parsing* direto e controle total do esquema.
- `ggplot2` + `patchwork` (painéis), `ggdist`/`gghalves` (raincloud), `scico`/`viridis` (mapas de cor perceptualmente uniformes).
- `signal`, `gsignal` (filtros Butterworth, Hilbert), `seewave` (espectrogramas).
- `cosinoRmixedeffects`, `GLMMcosinor`, `lme4`/`nlme`, `mgcv` (GAMM), `circular`, `emmeans`.

**Python:** `mne`, `specparam` (ex-FOOOF), `py_neuromodulation`, `scipy.signal`, `statsmodels`.

**MATLAB:** `perceive` (Neumann lab — conversão, desidentificação, limpeza de ECG, exporta para FieldTrip/BIDS) e `PerceptToolbox` (Thenaisie — `loadJSON`, `plotChannels`, `plotSpectrogram`, `plotPwelch`).

**HTML/JS (dashboard clínico interativo):** parsing nativo do JSON no browser + Plotly.js ou D3 — viável como PWA offline, sem envio de dado a servidor, o que resolve elegantemente a questão de privacidade. É o caminho natural dado o formato dos demais projetos do Nexo Cognitivo.

---

## Referências principais

1. Thenaisie Y, et al. Towards adaptive deep brain stimulation: clinical and technical notes on a novel commercial device for chronic brain sensing. *J Neural Eng*. 2021;18:042002.
2. Fischer P, et al. Diurnal modulation of subthalamic beta oscillatory power in Parkinson's disease patients during deep brain stimulation. *npj Parkinsons Dis*. 2022;8:88.
3. Donoghue T, et al. Parameterizing neural power spectra into periodic and aperiodic components. *Nat Neurosci*. 2020;23:1655–65.
4. Prerau MJ, et al. Sleep neurophysiological dynamics through the lens of multitaper spectral analysis. *Physiology*. 2017;32:60–92.
5. Lofredi R, et al. Beta bursts during continuous movements accompany the velocity decrement in Parkinson's disease patients. *Neurobiol Dis*. 2019.
6. Anderson RW, et al. A novel method for calculating beta band burst durations in Parkinson's disease using a physiological baseline. *J Neurosci Methods*. 2020;343:108811.
7. Lofredi R, et al. Subthalamic beta bursts correlate with dopamine-dependent motor symptoms in 106 Parkinson's patients. *npj Parkinsons Dis*. 2023;9:2.
8. Rêgo Ramos A, et al. Subthalamic low beta bursts differ in Parkinson's disease phenotypes. *Clin Neurophysiol*. 2022;140:45–58.
9. Mikulich SK, et al. Comparing linear and nonlinear mixed model approaches to cosinor analysis. *Stat Med*. 2003;22:3195–211.
10. Zhang H, et al. cosinoRmixedeffects: an R package for mixed-effects cosinor models. *BMC Bioinformatics*. 2021;22:553.
11. Parsons R, et al. CircaCompare: a method to estimate and statistically support differences in mesor, amplitude and phase between circadian rhythms. *Bioinformatics*. 2020;36:1208–12.
12. Neumann WJ, et al. *Perceive* toolbox. github.com/neuromodulation/perceive
13. Bastos P, Barbosa R. LeadSense: Medtronic Brain Sense Local Field Potential Analysis. CRAN, 2025. doi:10.32614/CRAN.package.LeadSense
14. Sand D, et al. Comparison of methods to suppress electrocardiographic artifacts in local field potential recordings. *bioRxiv*. 2022.
15. Medtronic™ recorded LFP pre-processing to remove noise and cardiac signals from neural recordings. *J Neural Eng*. 2025.
16. Beta power response after levodopa intake in Parkinson's disease patients with chronic sensing-enabled DBS. *Ann Neurol*. 2025.
17. Chronic adaptive deep brain stimulation in Parkinson's disease: ADAPT-START findings and programming principles. *npj Parkinsons Dis*. 2026.
18. Diurnal fluctuations of subthalamic nucleus local field potentials follow naturalistic sleep-wake behavior in Parkinson's disease. *SLEEP*. 2025;48:zsaf005.
19. Jimenez-Shahed J. Device profile of the Percept PC deep brain stimulation system. *Expert Rev Med Devices*. 2021;18:319–32.
