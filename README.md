# LFP_analysis

Ferramentas para leitura, visualização e análise estatística de **potenciais de campo local (LFP)**
registrados pelo neuroestimulador **Medtronic Percept PC/RC** no núcleo subtalâmico de pacientes
com doença de Parkinson.

O repositório contém duas peças que se complementam:

| | O quê | Para quê |
|---|---|---|
| **Percept LFP Studio** | aplicativo web progressivo (PWA) em arquivo único | inspeção rápida em consultório, exploração interativa, figuras para apresentação |
| **`R/percept_lfp.R`** | 61 funções em R | análise definitiva para publicação: modelos mistos, GAMM, figuras em 300 dpi |

Ambos leem o mesmo arquivo — o `Report_Json_Session_Report_*.json` exportado do programador —
e produzem o mesmo conjunto de figuras, F1 a F12, descritas em [`docs/estado-da-arte.md`](docs/estado-da-arte.md).

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

| ID | Figura | Fonte necessária |
|----|--------|------------------|
| F1 | Espectro anotado (linear + log-log), tabela de bandas | Signal Test, Survey ou Signal Check |
| F2 | Decomposição periódico/aperiódico | qualquer espectro ou sinal bruto |
| F3 | Impedâncias monopolares e matriz bipolar | `Impedance` |
| F4 | Linha do tempo da sessão, grupos, parâmetros de sensing | `EventLogs`, `Groups` |
| F5 | Mapa canal × frequência do Survey + ranking de picos | `LFPMontage` |
| F6 | Traçado, espectrograma, envelope, bursts, sensibilidade ao limiar | `BrainSenseTimeDomain` |
| F7 | Potência × amplitude de estimulação, dose-resposta | `BrainSenseLfp` |
| F8 | Timeline crônico multi-dia, bilateral | `LFPTrendLogs` |
| F9 | Heatmap dia × hora, perfil diurno, polar, cosinor | `LFPTrendLogs` (≥ 2 dias) |
| F10 | Resposta alinhada a evento (−60/+180 min) | `LFPTrendLogs` + snapshots |
| F11 | Distribuição de potência e limiares de aDBS | `LFPTrendLogs` |
| F12 | Espectros medianos por tipo de evento | `LfpFrequencySnapshotEvents` |

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
  registrado), e inclinação dose-resposta quando há rampa de estimulação.
- **Crônicas (Timeline):** n de pontos/dias, mediana e IQR, MESOR, amplitude e acrofase de 24 h,
  R² e *p* do cosinor **corrigido para autocorrelação AR(1)**, η² da hora do dia, *R* e *p* de Rayleigh,
  e a distribuição da potência frente aos limiares de aDBS (% abaixo/entre/acima, p10/p90).

Os identificadores de paciente já saem pseudonimizados do parser (`sub-XXXXXXXX`); nenhum nome, data de
nascimento, prontuário ou número de série é incluído nas exportações.

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
2. **BrainSense Streaming** ≥ 60 s em repouso, com rampa de amplitude → F6, F7
3. **BrainSense Timeline** habilitado nos **dois** hemisférios → F8, F9, F11
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
  percept-core.js            parser do JSON, DSP, estatística e extração de métricas
  percept-plot.js            biblioteca de plotagem em Canvas 2D
  app.js                     UI, renderizadores F1–F12 e exportação (PDF/CSV/JSON)
  styles.css                 folha de estilos
  index.template.html        template
  build.mjs                  gera index.html
R/percept_lfp.R            61 funções: leitura, DSP, estatística, figuras ggplot2
docs/estado-da-arte.md     revisão de literatura e mapa da estrutura do JSON
docs/Revisao_LFP_Parkinson.pdf  revisão sobre LFP na doença de Parkinson
tools/gerar_exemplo.mjs    gerador do dataset sintético
tests/run.mjs              suíte de 47 testes
examples/                  dataset sintético
```

Após editar qualquer arquivo em `src/`, rode `cd src && node build.mjs` e faça commit do
`index.html` regenerado — a integração contínua verifica que os dois estão sincronizados.

## Testes

```bash
node tools/gerar_exemplo.mjs examples
node tests/run.mjs
```

52 testes cobrindo parser, DSP, estatística, camada gráfica, os 12 renderizadores e a extração de métricas.

---

## Como citar

Ver [`CITATION.cff`](CITATION.cff).

## Aviso

Ferramenta de **pesquisa e apoio à decisão**. Não substitui o julgamento clínico nem o software
regulado do fabricante, e não é um dispositivo médico. Licença MIT — ver [`LICENSE`](LICENSE).
