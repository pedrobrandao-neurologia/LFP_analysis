# PERCEPT-REPORT — itens mínimos de reporte para estudos de LFP com dispositivos de sensing

**Proposta de checklist.** Versão 0.1, agosto de 2026.

---

## Justificativa

Revisões recentes do campo registram uma lacuna específica e verificável: **não existe padrão de
reporte** para estudos de potenciais de campo local registrados por neuroestimuladores com sensing.
Não há equivalente ao CONSORT para ensaios, ao STROBE para estudos observacionais ou ao PRISMA para
revisões.

A consequência é concreta e documentada:

- **Parâmetros de estimativa espectral** (janela de Welch, sobreposição, `nfft`) variam entre grupos
  e frequentemente não são reportados — o que impede reproduzir e comparar potências absolutas.
- **Critérios de exclusão de artefato** raramente são explicitados. Hammer et al. mostraram que
  habilitar a estimulação **mesmo a 0 mA** já introduz artefatos ausentes no estado OFF; sem declarar
  o estado do dispositivo, comparações entre registros são inválidas.
- **Método de normalização** muda o resultado (relativa, corrigida pelo aperiódico, desvio-padrão em
  6–96 Hz) e é omitido com frequência.
- **Tratamento de outliers e de dados faltantes** no domínio crônico varia, e a perda de pacotes de
  Bluetooth costuma nem ser mencionada, embora todos os grupos que a tratam concordem que a
  concatenação por cima da lacuna invalida a série.
- **Definição de burst** (banda, percentil de limiar, duração mínima, método) altera
  sistematicamente a duração média reportada — é uma controvérsia ativa, não um detalhe.

Um checklist mínimo não resolve a heterogeneidade metodológica, mas torna a heterogeneidade
**visível e comparável**, que é o primeiro passo para meta-análise.

## Como este checklist se diferencia

Ele é **gerado automaticamente**. `generateChecklist()` percorre o manifesto de proveniência da
análise e preenche cada item com **o valor efetivamente usado** — não o default documentado, o que
de fato entrou na conta. O que o software não consegue extrair é marcado como *"não determinado —
informe manualmente"*, nunca deixado em branco.

Na implementação atual, **30 dos 41 itens** são preenchidos sem intervenção a partir de um único
Session Report; os demais dependem de módulos ainda não implementados (inferência de estado do
dispositivo, artefatos de movimento) ou de informação que só o autor tem.

## Os itens

### 1. Dispositivo e aquisição

| # | Item | Fundamentação |
|---|---|---|
| 1.1 | Modelo do neuroestimulador (PC vs RC) | as propriedades de sinal diferem; o RC permite recarga ativa pós-pulso, com efeito potencial sobre contaminação por ECG |
| 1.2 | Versão de firmware | a escala do valor de LFP do Timeline muda entre versões (µVp vs contagens brutas) |
| 1.3 | Versão do programador | determina o formato do JSON e os campos disponíveis |
| 1.4 | Alvo e modelo de eletrodo | STN/GPi/VIM/ANT têm biomarcadores distintos; eletrodos direcionais mudam a montagem |
| 1.5 | Par bipolar de registro | registrar em contatos que flanqueiam o de estimulação minimiza artefato |
| 1.6 | Frequência de amostragem **nominal** | 250 Hz no Percept |
| 1.7 | Frequência de amostragem **efetiva medida** | Vivien et al.: 249,985–250,024 Hz, com deriva de até ~65 ms em 11 min |
| 1.8 | Filtros de hardware | condicionam o espectro em baixas frequências |
| 1.9 | Janela de blanking do sensing | define a censura espectral em torno da frequência de estimulação |
| 1.10 | **Estado do dispositivo em cada registro** (OFF / ON-0 mA / ON-terapêutico) | Hammer et al. 2022: ON-0 mA já introduz artefato ausente no OFF |
| 1.11 | Parâmetros de estimulação (amplitude, frequência, largura de pulso, contatos) | determinam artefato, aliasing e a frequência de entrainment (f/2) |
| 1.12 | Frequência-alvo do sensing e largura da janela | o Timeline registra uma banda de 5 Hz centrada nela |

### 2. Integridade do dado

| # | Item | Fundamentação |
|---|---|---|
| 2.1 | **Taxa de perda de pacotes e como foi tratada** | consenso entre `perceive`, `PerceptToolbox`, BRAVO e DBSsync: inserir NaN, nunca concatenar |
| 2.2 | n de amostras válidas e excluídas | permite julgar a confiabilidade das métricas derivadas |
| 2.3 | Deriva temporal estimada | invalida análise alinhada a evento em alta resolução |
| 2.4 | Fuso horário e transições tratadas | van Rheede et al. corrigiram manualmente horário de verão; é fonte silenciosa de erro circadiano |

### 3. Artefatos

| # | Item | Fundamentação |
|---|---|---|
| 3.1 | Tipos de artefato avaliados | ECG, rampa de estimulação, polifásicos, movimento — a taxonomia de Hammer et al. |
| 3.2 | Método de detecção de picos R | passagem única por limiar e duas passagens por correlação têm desempenho muito diferente |
| 3.3 | Método de remoção de ECG e seus parâmetros | interpolação, template e SVD dão resultados distintos (Stam et al.) |
| 3.4 | **Métricas de validação da remoção** | razão de supressão em 0,5–40 Hz e recuperação da proeminência do pico beta (Vivien et al.) — sem elas não se sabe se a limpeza tirou o artefato ou o sinal |
| 3.5 | Critério de exclusão de época | determina quanto do registro entrou na conta |
| 3.6 | Tratamento de artefato de movimento | em distonia, o tremor cefálico de 1–6 Hz cai sobre o biomarcador teta-alfa |
| 3.7 | Verificação de harmônicos | pico com harmônicos de baixa frequência é suspeito de origem não oscilatória |

### 4. Análise espectral

| # | Item | Fundamentação |
|---|---|---|
| 4.1 | **Estimador e todos os parâmetros** (janela, sobreposição, nfft, tapers) | é o item mais frequentemente omitido e o que mais impede comparação |
| 4.2 | Método de normalização | relativa, corrigida pelo aperiódico e sd 6–96 Hz não são intercambiáveis |
| 4.3 | Parâmetros do specparam / ajuste aperiódico | faixa de ajuste, knee, limiares de pico |
| 4.4 | Definição exata das bandas | "beta" varia entre 12–30 e 13–35 Hz na literatura |

### 5. Bursts

| # | Item | Fundamentação |
|---|---|---|
| 5.1 | Método (Hilbert / wavelet / linha de base 1/f) | Hilbert e wavelet detectam durações sistematicamente diferentes |
| 5.2 | Banda usada | idem |
| 5.3 | **Percentil de limiar** | a duração média varia sistematicamente com ele — deve ser pré-registrado |
| 5.4 | Duração mínima | define o que conta como burst |
| 5.5 | Tratamento de bursts adjacentes a lacunas | duração desconhecida não pode entrar na média |

### 6. Domínio crônico

| # | Item | Fundamentação |
|---|---|---|
| 6.1 | n de dias e de pontos válidos | ADAPT-START sugere ≥ 3–5 dias para avaliar variabilidade circadiana |
| 6.2 | Método de remoção de outliers | mediana ± k×MAD vs média ± DP dão resultados distintos em distribuição assimétrica |
| 6.3 | Detrending | obrigatório no heatmap circadiano, sob pena de a deriva entre dias mascarar o ritmo |
| 6.4 | **Método do cosinor e correção de autocorrelação** | ρ AR(1) > 0,9 é típico a cada 10 min; o *p* de efeitos fixos é anticonservador |
| 6.5 | Tratamento da acrofase como grandeza circular | média aritmética de horários é incorreta |

### 7. Estatística

| # | Item | Fundamentação |
|---|---|---|
| 7.1 | Correção para comparação múltipla | bandas × hemisférios × janelas multiplicam testes rapidamente |
| 7.2 | n de permutações | determina a resolução do *p* empírico |
| 7.3 | Método de bootstrap | reamostrar dias inteiros preserva a autocorrelação intradiária; reamostrar pontos não |
| 7.4 | Software e versão | com o hash do manifesto, identifica a análise de forma única |

---

## Formulário em branco

Para uso manual, sem o software: copie a tabela acima, substitua a coluna "Fundamentação" por
"Valor usado" e preencha. Itens não aplicáveis devem ser marcados como tal — **em branco não é
resposta**.

## Manifesto de proveniência

O checklist é a face legível de um manifesto mais completo (`core/provenance/`), que registra:

- cabeçalho com versão do app, hash do bundle, perfil de doença ativo, fuso e quebras;
- por arquivo: nome, **SHA-256**, firmware, versão do programador, modelo do dispositivo;
- por passo de método: todos os parâmetros **efetivos**, n de entrada, n de saída, n descartado e o
  motivo;
- por figura: o grafo de passos que a produziu;
- seção de exclusões, com o critério e quem decidiu (automático ou usuário);
- **hash final do manifesto**, citável em manuscrito como identificador de versão de análise.

`verifyManifest(guardado, atual)` recarrega os mesmos arquivos, refaz a análise e confirma que
método, parâmetros e contagens batem — reportando cada divergência. É o que torna a alegação de
reprodutibilidade **verificável em vez de declarada**.

## Estado da proposta

Esta é uma **proposta**, não um padrão estabelecido. Foi construída a partir do que a literatura de
referência reporta e do que as revisões identificam como faltante, e está implementada e em uso no
Percept LFP Studio. Comentários, críticas e propostas de itens adicionais são bem-vindos como
*issues* no repositório.

O caminho natural de consolidação seria uma *letter* ou *methods paper* em `J Neural Eng`,
`Brain Stimulation` ou `npj Parkinson's Disease`, com validação em coorte multicêntrica.

## Referências

- Thenaisie Y, et al. *J Neural Eng* 2021;18:042002.
- Hammer LH, Kochanski RB, Starr PA, Little S. *Stereotact Funct Neurosurg* 2022;100:168-183.
- Stam MJ, et al. *Clin Neurophysiol* 2023;146:147-161.
- Neumann W-J, et al. *Brain Stimul* 2021;14:1301-1306.
- van Rheede JJ, et al. *npj Parkinsons Dis* 2022;8:88.
- Swinnen BEKS, et al. *J Neural Eng* 2025;22:014001.
- Vivien J, et al. *npj Parkinsons Dis* 2026;12:151.
- Cascino S, et al. *npj Parkinsons Dis* 2026 (ADAPT-START).
