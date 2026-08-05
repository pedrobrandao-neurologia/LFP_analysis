# Percept LFP Studio

**Análise de potenciais de campo local (LFP) do Medtronic Percept™ — em um arquivo, no seu navegador, sem rede.**

[English version](README.en.md) · [Arquitetura](docs/arquitetura.md) · [Perfis de doença](docs/perfis.md) · [Validação](docs/validacao.md) · [Padrão de reporte](docs/PERCEPT-REPORT.md)

---

## O que é

Um aplicativo web de **arquivo único** (`index.html`, 1372 KB) que lê os *Session Reports* em JSON exportados do programador do neuroestimulador Medtronic Percept™ e produz **34 figuras interativas** organizadas em sete abas, métricas quantitativas, relatório clínico em PDF e exportações prontas para estatística.

Abre com **duplo clique**. Não instala nada, não precisa de servidor, não faz uma única requisição de rede.

```
Report_Json_Session_Report_20250106T120000.json  →  arraste para a página  →  pronto
```

O repositório traz duas peças complementares:

| | O quê | Para quê |
|---|---|---|
| **Percept LFP Studio** | aplicativo web progressivo (PWA) em arquivo único | inspeção em consultório, exploração interativa, figuras para apresentação |
| **`R/percept_lfp.R`** | 1.280 linhas em R | análise definitiva para publicação: modelos mistos, GAMM, figuras em 300 dpi |

Os dois leem o mesmo arquivo e produzem em grande parte as mesmas figuras.

### Três coisas que definem o projeto

**1. Nada sai do seu computador.** O arquivo do paciente é lido pelo `FileReader` do próprio navegador e processado em memória. Não há servidor, não há CDN, não há telemetria, não há analytics. Nome, data de nascimento, `PatientId` e número de série do neuroestimulador **nunca saem do parser** — a jusante, tudo o que existe é um `subject_id` hasheado (SHA-256 truncado). Nenhuma exportação, log ou mensagem de erro pode conter identificador direto, e há um *hook* de pre-commit que bloqueia commits com dados identificadores.

**2. Zero dependência.** FFT, filtros, wavelet, multitaper, estatística, escritor de PDF, escritor de EDF+, compressor ZIP e toda a camada gráfica são escritos do zero neste repositório. Não há `npm install`, não há `<script src="https://...">`, não há biblioteca de terceiros no código que roda no navegador. O que entra no navegador é o que está no repositório — e é auditável linha a linha.

**3. Toda métrica carrega o parâmetro que a produziu.** Um número derivado de escolha — percentil de burst, banda, limiar, número de componentes de SVD — sai sempre acompanhado do parâmetro usado, do indicador de qualidade disponível (n de amostras válidas, % de dados faltantes, R² do ajuste) e da ressalva metodológica pertinente. Quando o dado não sustenta uma conclusão, o software **diz isso** em vez de produzir um número frágil.

---

## Como usar

1. Abra `index.html` (duplo clique) ou acesse a versão publicada em GitHub Pages.
2. Arraste um ou mais arquivos `Report_Json_Session_Report_*.json` para a página.
3. As figuras aparecem. O painel lateral traz a matriz de modalidades presentes, o perfil de doença, o semáforo de qualidade de sinal e os botões de exportação.

Carregue **vários arquivos da mesma pessoa** ao mesmo tempo: as séries do Timeline crônico são concatenadas e desduplicadas automaticamente, e cada figura escolhe a fonte adequada. O botão **+ pasta** ingere um diretório inteiro de uma vez (modo coorte).

### Sete abas, e a hierarquia que elas codificam

A navegação é organizada em abas porque a diferença entre registro **agudo** e registro **crônico** não é de escala temporal — é epistemológica, e tratá-la como filtro de visualização é a origem de boa parte dos erros que circulam na literatura de Percept.

|  | Registro agudo | Registro crônico |
|---|---|---|
| Desenho | experimental, controlado | observacional, ecológico |
| Inferência | causal, dirigida pelo desenho | associação em variação naturalística |
| Amostragem | esparsa no tempo, rica no espectro (~250 Hz) | densa no tempo, pobre no espectro (um escalar por bin) |
| Unidade de análise | *trial* / evento / condição | *timestamp* / dia / dose |
| Estrutura interna | array epocado | tabela longa irregular com lacunas |
| Ambiente | consultório, supervisionado | domicílio, sem supervisão |
| Risco dominante | baixo *n*, ruído de sincronização | confundimento por mudança de configuração |

| Aba | Camada | O que mora ali |
|---|---|---|
| **Início** | — | Triagem por pergunta: 14 perguntas de clínico e de pesquisador; cada uma diz se **este** arquivo a responde e leva direto à figura, ou explica o que falta |
| **Agudo** | experimental | Espectro, montagem, domínio do tempo, espectrograma, wavelet, PAC, gama, sinal externo, rampa de estimulação |
| **Crônico** | observacional | Timeline, blocos de configuração, ritmo circadiano, estados ON/OFF, matriz hora × dia, resposta à levodopa |
| **Ponte** | as duas | Passaporte do biomarcador (descendente), agenda da próxima sessão (ascendente), limiar de aDBS sobre o histograma real de 30 dias (convergência) |
| **Qualidade** | transversal | Alarme de artefato, reprodutibilidade do pico, integridade de eletrodos, painel de QC |
| **Coorte** | grupo | Tabela *tidy* por sujeito e hemisfério, prevalência com IC de Wilson |
| **Relatório** | — | O que sai daqui para o prontuário e para o manuscrito |

Cada aba abre com um cabeçalho de orientação que declara **a camada de inferência**, o que ela responde bem, o que ela não responde por mais dados que tenha, o risco dominante, e — obrigatoriamente — **a fronteira que não deve ser cruzada**. A falácia recorrente na área é usar um achado agudo de dez minutos para interpretar uma tendência crônica de seis semanas, ou o contrário, como se fossem medidas da mesma quantidade.

### Dois modos

| Modo | Para quê | O que mostra |
|---|---|---|
| **Clínico** | Consulta, decisão de programação | O subconjunto de figuras que responde às perguntas de consultório, escolhido pelo perfil de doença, mais leituras em linguagem simples |
| **Pesquisa** | Análise, publicação | Todas as 34 figuras, todos os controles de parâmetro, todas as exportações |

Os mesmos números, as mesmas ressalvas e os mesmos parâmetros declarados nos dois modos — o modo clínico esconde figuras, nunca esconde incerteza. A preferência fica no `localStorage` (apenas a preferência de interface; nenhum dado de paciente é gravado).

### Perfis de doença

O software não assume que todo paciente é de Parkinson. Cinco perfis mudam a banda primária, o método de busca de pico, a normalização, as figuras do modo clínico e o glossário:

| Perfil | Alvo | Banda primária | Particularidade |
|---|---|---|---|
| Doença de Parkinson | STN / GPi | beta 13–35 Hz | Detector ON/OFF; matriz do diário de Hauser |
| Distonia | GPi | teta-alfa 4–12 Hz | Controle para tremor cefálico; série de sintomas importável |
| Tremor essencial | VIM | tremor 4–10 Hz | Frequência fundamental detectada no espectro |
| Epilepsia | ANT | banda larga | Sem pressuposto de pico |
| Genérico | qualquer | configurável | Todas as bandas ajustáveis |

O perfil é sugerido pelo conteúdo do JSON (alvo do eletrodo, banda de sensing) e pode ser trocado a qualquer momento.

---

## As 34 figuras

### Sinal agudo — espectro e domínio do tempo

| # | Figura | Precisa de | Responde |
|---|---|---|---|
| **F1** | Espectro anotado e **varredura do Survey** | `LFPMontage`, `SenseChannelTests` | Onde está o pico do marcador e **em qual par de contatos ele é mais forte** — todos os pares bipolares de um hemisfério aparecem juntos em gráfico de cumeeira, ordenados, com o melhor destacado e a lista das 3 melhores combinações |
| **F2** | Decomposição periódico / aperiódico | qualquer espectro | Quanto do pico é oscilação de verdade e quanto é o fundo 1/f |
| **F5** | Mapa da montagem — canal × frequência | `LFPMontage` | Qual combinação de contatos tem o marcador mais forte, em mapa de calor |
| **F6** | Domínio do tempo — traçado, espectrograma, bursts | `BrainSenseTimeDomain` | Como o sinal se comporta segundo a segundo; onde estão as rajadas |
| **F18** | Espectro **multitaper** com intervalo de confiança | sinal bruto | O pico sobrevive quando a incerteza é declarada? |
| **F19** | **specparam** completo — reta ou joelho, largura, R² | sinal bruto | Separação rigorosa de periódico e aperiódico, com seleção de modelo por AIC |
| **F20** | **Wavelet de Morlet** — escalograma e bursts delimitados | sinal bruto | Onde cada rajada **começa e termina**, e se a duração é do cérebro ou da resolução escolhida |
| **F21** | **PAC** — acoplamento fase-amplitude e comodulograma | sinal bruto (fs ≥ 250 Hz) | Se a amplitude do gama acompanha a fase do beta |
| **F22** | Gama fina vs. gama *entrained* em f_stim/2 | espectro até 95 Hz | Se um pico de gama é endógeno ou eco da própria estimulação |
| **F30** | **Espectrograma no padrão do BRAVO** | sinal bruto | Como o espectro muda ao longo do registro, por cinco métodos, com a escala de densidade do `scipy` |
| **F34** | **ODR e features por janela** | sinal bruto | Como teta, gama de pico e beta baixo se movem juntos ao longo do registro, com a coerência entre os dois STN e a variação espectral do envelope |
| **F35** | MRDS — movimento vs repouso, ΔMRDS entre momentos | `BrainSenseTimeDomain`, `IndefiniteStreaming` | Se o movimento dessincroniza o beta, e se uma intervenção muda isso |

### Sinal crônico — dias e semanas

| # | Figura | Precisa de | Responde |
|---|---|---|---|
| **F8** | Timeline crônico — série multi-dia **ou um painel por dia civil** | `LFPTrendLogs` | Como o marcador se comporta ao longo de semanas, e como é cada dia por dentro |
| **F9** | **Ritmo circadiano** — heatmap dia × hora, polar, cosinor | `LFPTrendLogs` (≥ 2 dias) | Se há ritmo de 24 h, qual a amplitude, a que horas é o pico — com IC por bootstrap de dias inteiros |
| **F10** | Resposta alinhada a evento | Timeline + eventos marcados | O que acontece com o marcador em torno do que o paciente registrou |
| **F12** | Espectros por tipo de evento | `LfpFrequencySnapshotEvents` | Se OFF, discinesia e "tomou medicação" têm espectros distintos |
| **F13** | Estados ON/OFF pela amplitude do beta | Timeline ou streaming | Se o beta separa dois estados, e quão bem (bimodalidade de Sarle, separação em DP) |
| **F25** | **Actograma** duplo-plot e **banda-controle** | Timeline + snapshots datados | Se o horário do pico deriva entre os dias, e se o padrão diurno é **específico da banda** |
| **F28** | **Matriz hora × dia** — ON/OFF ligados à sua integral | Timeline e/ou diário de Hauser em CSV | Onde no dia o OFF cai: matinal por *delayed-on*, vespertino por *wearing-off*, ou picado — a informação que a barra empilhada destrói |
| **F29** | Resposta à levodopa alinhada às tomadas | Timeline + eventos de medicação | Se o beta cai depois da dose, com que latência e por quanto tempo — ou se isso não se separa do ritmo diurno |
| **F32** | **Blocos de configuração e pontos de mudança** | Timeline + ≥ 1 sessão com sensing declarado | Se a mudança ao longo das semanas é biológica ou é o aparelho ter passado a medir outra coisa — a série é **partida** na fronteira e a linha se recusa a atravessá-la |

### A ponte entre as camadas

| # | Figura | Precisa de | Responde |
|---|---|---|---|
| **F31** | **Passaporte do biomarcador** | Survey, Signal Test ou sinal bruto | *(descendente — calibração)* Qual par bipolar, qual pico, qual banda e qual SNR a sessão aguda definiu, com impressão digital versionada, e se a configuração vigente do aparelho ainda reproduz isso |
| **F33** | **Agenda da próxima sessão** | Timeline crônico | *(ascendente — geração de hipótese)* O que o crônico observou e não explica, transformado em protocolo agudo, com o que cada protocolo **decidiria**. Nunca conduta terapêutica |

Oito checagens automáticas alimentam a agenda: assimetria interhemisférica emergente, perda da resposta à dose, anomalia circadiana reprodutível, deriva do nível basal, configuração instável, passaporte desatualizado, cobertura pobre e ritmo fragmentado. Cada uma sai com achado, evidência numérica, protocolo sugerido, o que ficaria decidido e a confiança — e toda checagem que o dado não permitiu sai em `notChecked` com o motivo e o que seria necessário.

### Estimulação, aDBS e limiares

| # | Figura | Precisa de | Responde |
|---|---|---|---|
| **F7** | Streaming com estimulação — potência × amplitude | `BrainSenseLfp` | Se a potência do marcador cai com a corrente, e com que curva |
| **F11** | Distribuição da potência e limiares de aDBS | Timeline | Quanto tempo o sinal passaria acima, entre e abaixo de limiares candidatos |
| **F23** | **aDBS — elegibilidade e simulador de limiar** | Timeline + espectro | Se este paciente é candidato a estimulação adaptativa, com critérios explícitos, e o que aconteceria com cada par de limiares |

### Qualidade, artefato e integridade

| # | Figura | Precisa de | Responde |
|---|---|---|---|
| **F3** | Integridade de eletrodos | `Impedance` | Se algum contato está fora de faixa |
| **F4** | Linha do tempo da sessão e parâmetros | `EventLogs`, `Groups` | O que foi feito na consulta e em que ordem |
| **F15** | **Limpeza de artefato cardíaco** — três métodos e validação | sinal bruto | Se há QRS no LFP, qual método o remove melhor **neste registro**, e quanto de sinal neural sobreviveu |
| **F16** | QC — reprodutibilidade do pico entre registros | ≥ 2 sessões | Se o pico de hoje é o mesmo de antes ou mudou a medida |
| **F17** | **Painel de controle de qualidade** | qualquer | O semáforo: o que é verificável neste arquivo, o que não é, e por quê |

### Sinais externos e coorte

| # | Figura | Precisa de | Responde |
|---|---|---|---|
| **F24** | Sinal externo — IMU, EMG, ECG: alinhamento e **coerência** | sinal bruto + CSV/TSV externo | Se a oscilação do LFP é do cérebro ou é o próprio movimento entrando pelo eletrodo |
| **F26** | Longitudinal — impedância, **ICC**, uso do aparelho | ≥ 2 sessões | Se o que mudou entre visitas foi o cérebro ou a medida |
| **F27** | **Coorte** — todos os registros lado a lado | ≥ 1 registro | Prevalência de pico com IC de Wilson, tabela por sujeito, estatísticas de grupo |

Cada figura exporta PNG e os dados subjacentes em CSV.

---

## Métodos implementados

Tudo abaixo é código próprio, escrito neste repositório, sem biblioteca externa.

### Leitura e integridade do sinal

- **Parser** de todas as modalidades do Session Report: `LFPMontage`, `LfpMontageTimeDomain`, `BrainSenseTimeDomain`, `BrainSenseLfp`, `DiagnosticData.LFPTrendLogs`, `LfpFrequencySnapshotEvents`, `Impedance`, `Groups`/`SensingSetup`, `EventLogs`, `GroupUsagePercentage`, `BatteryInformation`.
- **Perda de pacotes** detectada por `GlobalSequences` ou `TicksInMses`, com lacunas inseridas como **NaN** — nunca interpoladas em silêncio. A contabilidade (% faltante, maior lacuna contígua) acompanha toda métrica derivada.
- **Frequência de amostragem efetiva** medida pelos ticks, com aviso de deriva temporal quando ela importa para alinhamento a evento ou sincronização externa.
- **Fuso horário robusto**: detecção de transições de horário de verão e de quebras de *offset*, com segmentação quando necessário.
- **Estado do dispositivo** inferido (estimulação ligada/desligada, grupo ativo) e verificação de comparabilidade entre registros.

### Processamento de sinal

| Método | Detalhe |
|---|---|
| **FFT** | Radix-2 Cooley-Tukey; **Bluestein (chirp-z)** para N arbitrário |
| **Welch PSD** | Hann periódica, sobreposição 50%, detrend por segmento, tolerante a NaN |
| **Multitaper** | DPSS/Slepian por matriz tridiagonal (Percival & Walden), bisseção de Sturm, iteração inversa com algoritmo de Thomas; IC por *jackknife* |
| **specparam / FOOOF** | Ajuste aperiódico robusto, gaussianas limitadas iterativas, refino Levenberg-Marquardt simultâneo, seleção reta vs. joelho por AIC |
| **Wavelet** | CWT de Morlet por convolução via FFT, cone de influência como NaN |
| **Bursts** | Detecção e **delimitação** separadas; limiar por percentil ou pelo fundo aperiódico 1/f |
| **PAC** | Índice de modulação de Tort, comodulograma, surrogados por deslocamento temporal, coerência imaginária, simetria pico-vale |
| **Coerência** | Magnitude quadrática por espectro cruzado de Welch, nulo 1/L, correção de Šidák por banda, atraso por inclinação de fase e por fase do pico |
| **Filtros** | Passa-banda por FFT, envelope de Hilbert, notch com sugestão automática da frequência de rede |
| **Espectrograma** | Welch por época, STFT (Hamming), emulação do PSD de bordo do Percept, wavelet, autorregressivo (Yule-Walker + BIC) |

### Artefato cardíaco

Três métodos independentes, **com validação quantificada em vez de fé**: interpolação de QRS, subtração de *template* e SVD de baixa ordem. Detecção de picos R em duas passagens. Para cada método o software mede a supressão de ECG em dB, a recuperação do pico beta, a preservação da potência de banda e a correlação com o sinal limpo — e diz **qual venceu neste registro**, não qual é melhor em geral.

### Estatística

- **Cosinor** com harmônicos de 24 e 12 h; IC por **bootstrap de blocos de dias inteiros** (preserva a autocorrelação intradiária), acelerado por equações normais aditivas por dia, com semente fixa para reprodutibilidade.
- **Correção AR(1)** do p do cosinor por n efetivo; Rayleigh para acrofases diárias; η² por hora do dia.
- **Permutação de cluster** (Maris & Oostenveld) com a ressalva de Sassenhagen & Draschkow embutida na saída.
- **Permutação de duas amostras** com enumeração **exata** quando o número de partições permite, e semente fixa quando não.
- **ICC(2,1) e ICC(3,1)** com IC pelo método F — os dois, porque a escolha muda o número.
- **Cronobiologia não paramétrica** emprestada da actigrafia, porque o ritmo do beta muitas vezes não é senoidal e o cosinor subestima a amplitude quando não consegue seguir os cantos: **IS** (estabilidade interdiária), **IV** (variabilidade intradiária), **M10/L5** e **RA** (amplitude relativa, invariante à unidade). São descritivas — não testam nada; quem testa se o ritmo existe é o cosinor, e as duas leituras saem juntas.
- **Features por janela** no padrão de Habets et al. (*Brain* 2026): **ODR** = (θ × γpico)/β↓, **variação espectral** (CV do envelope de Hilbert) e **coerência inter-STN**, todas em janelas de 5/10/30 s. O ODR sai nas duas formulações — a logarítmica `z(log θ) + z(log γ) − z(log β)`, que é a mesma razão sem divisão, e a literal do artigo, que é instável porque divide por um valor z-scored que cruza zero por construção — com a correlação entre elas e a fração de janelas em que a literal escapa. Guardas: o cálculo é **recusado** quando o pico de gama cai em f_stim/2 (o numerador mediria a resposta da rede à própria estimulação, e as duas leituras clínicas são opostas), e a substituição do pico individual por gama de banda larga nunca é silenciosa. Ver [`docs/odr.md`](docs/odr.md).
- **Detecção de pontos de mudança** por segmentação binária com CUSUM de duas amostras sobre o valor diário, significância por permutação da própria janela, com opção de permutação em blocos para preservar autocorrelação — e anotação contra marcos conhecidos, separando degrau explicado de degrau órfão. *Não teste t entre "antes e depois".*
- **IC de Wilson** para proporções; bimodalidade de Sarle; kappa de Cohen com IC.

### Modelos e simulação

- **Elegibilidade para aDBS** com critérios explícitos e prevalência de referência.
- **Simulador de limiar**: o que aconteceria com cada par de limiares, medido no Timeline do próprio paciente.
- **Dose-resposta** por Levenberg-Marquardt, com escolha de modelo declarada.

---

## Honestidade metodológica — o que distingue este software

Estas regras estão no contrato de desenvolvimento do projeto ([`CLAUDE.md`](CLAUDE.md)) e são verificadas pela suíte de testes.

1. **Todo parâmetro é exportado junto com o valor.** Um burst detectado no percentil 75 sai com "percentil 75" ao lado. Trocar o percentil muda o número, e o leitor precisa saber qual foi usado.

2. **Todo indicador de qualidade disponível é exportado.** n de amostras válidas, % de dados faltantes, R² do ajuste, flag de artefato.

3. **Dado faltante nunca é imputado em silêncio.** Perda de pacote é NaN, e NaN é propagado com contabilidade explícita. Época de espectrograma com lacuna aparece como faixa branca, não como potência plausível.

4. **Controvérsia documentada vira escolha na interface.** Definição de limiar de burst, Hilbert vs. wavelet, banda a priori vs. maior pico, ICC(2,1) vs. ICC(3,1): a UI oferece a opção, registra qual foi usada e cita a controvérsia.

5. **"Não é possível determinar com este dado" é uma resposta válida** — e frequentemente a certa. Com menos de 3 sujeitos, o ICC é recusado com o motivo estatístico. Se a curva de resposta à levodopa não se separa do acaso, latência e duração **não são reportadas**.

6. **Ausência de verificação não é ausência de achado.** O alarme de artefato e a agenda da próxima sessão devolvem, junto com o que encontraram, a lista do que **não puderam** verificar e por quê. Um arquivo sem sinal bruto pode voltar "sem alarme" com treze verificações impossíveis; dizer só "sem alarme" seria mentir por omissão.

7. **A camada de inferência é declarada, e o cruzamento indevido é proibido.** Cada aba diz se o que está ali é observacional ou experimental e qual fronteira não deve ser cruzada. A série crônica se recusa a ser plotada como uma linha contínua atravessando uma mudança de configuração de sensing — porque dos dois lados da fronteira não é a mesma variável.

8. **A agenda sugere investigação, nunca conduta.** Todo protocolo sugerido passa por um filtro que rejeita verbo de prescrição, e o item sai marcado com `conductFree`. O software não sugere trocar contato, mudar amplitude, ajustar medicação nem programar aDBS.

9. **Não é dispositivo médico.** Ferramenta de pesquisa e apoio à decisão. Nenhuma string de interface, relatório ou documentação sugere uso diagnóstico ou substituição do software regulado do fabricante.

---

## Exportações

| Formato | Conteúdo |
|---|---|
| **PNG** | Qualquer figura; a matriz hora × dia exporta em 2× redesenhando, não esticando o bitmap |
| **CSV** | Métricas agudas, métricas crônicas, Timeline bruto, e os dados subjacentes de cada figura — cabeçalhos em inglês para os scripts em R |
| **JSON** | Pacote completo de métricas para análise estatística |
| **PDF nativo** | Relatório clínico escrito do zero (PDF 1.4, base-14 Helvetica, WinAnsiEncoding com larguras reais de glifo, figuras embutidas como JPEG) |
| **DOCX** | Checklist de reporte preenchido |
| **EDF+** | Sinal bruto no padrão europeu, com amostras faltantes no mínimo digital |
| **BIDS-like** | Estrutura iEEG derivada (não conformante — ver limitações) |
| **ZIP** | Pacote completo em um arquivo, com manifesto de proveniência |

### Manifesto de proveniência

Toda exportação pode vir acompanhada de um manifesto com hash SHA-256 dos arquivos de entrada, versão do software, parâmetros de cada figura, sementes dos procedimentos aleatórios e onde cada cálculo rodou (thread principal ou *Web Worker*). O manifesto é verificável: `verifyManifest()` refaz os hashes e diz se algo mudou.

### Linha de comando

`tools/cli.mjs` roda o mesmo núcleo sobre uma pasta inteira, sem navegador, produzindo CSV/JSON/EDF. Não gera figuras — e declara isso.

---

## Validação

### Benchmark quantitativo contra *ground truth*

`node tests/benchmark.mjs` gera sinais sintéticos com parâmetros conhecidos e mede o que o pipeline recupera. **87 critérios, todos aprovados.** Alguns:

| Métrica | Condição | Valor | Critério |
|---|---|---|---|
| Detecção de picos R — verdadeiros positivos | SNR −10 dB | 100% | ≥ 95% |
| Detecção de picos R — falsos positivos | SNR −10 dB | 0% | ≤ 1% |
| Correlação com o sinal limpo (SVD) | SNR −10 dB | 0,968 | > 0,90 |
| Detecção de pacotes perdidos (Jaccard) | perda de 0–10% | 1,00 | > 0,99 |
| Erro da frequência de amostragem efetiva | perda de 0–10% | 0,0016 Hz | < 0,005 Hz |
| Erro da frequência de pico | três perfis | 0,07–0,11 Hz | < 0,5 Hz |
| Erro do expoente aperiódico (specparam) | χ = 1; 1,5; 2,2 | 0,0013–0,0022 | < 0,10 |
| R² do modelo specparam | χ = 1; 1,5; 2,2 | 1,00 | > 0,95 |
| Ortonormalidade das DPSS | N=512, NW=4, K=7 | 0 | < 10⁻⁸ |
| F1 de bursts por wavelet | SNR 20 dB | 0,980 | > 0,75 |
| PAC — detecta acoplamento verdadeiro | beta→gama simulado | z = 23,7 | > 5 |
| PAC — rejeita controle sem acoplamento | sem acoplamento | z = −0,20 | < 3 |

O benchmark roda na integração contínua com `--check`, que **falha o build** se houver regressão em relação ao baseline.

### Verificação analítica do espectrograma

A escala de densidade é conferida contra identidades exatas, não contra outra implementação:

- **Parseval**: senóide de amplitude 3 → integral da PSD sobre a frequência = **4,5000**, exatamente A²/2.
- **Ruído branco**: PSD plana em σ²/(fs/2) — razão 0,99 em Welch, STFT e AR.
- **Bluestein contra a definição da DFT**: erro relativo máximo **2,3 × 10⁻¹⁴** em N ∈ {3, 7, 61, 250, 500}.
- **AR(2) conhecido**: o BIC escolhe ordem 2; o pico cai a 26,00 Hz contra 26,74 Hz teóricos.

### Suíte de regressão

`node tests/run.mjs` — **327 testes**, incluindo os 34 renderizadores de figura exercitados sobre um DOM mínimo simulado. Nenhum teste pode ser removido ou afrouxado para fazer código novo passar.

---

## Desenvolvimento

```bash
node tools/gerar_exemplo.mjs examples   # dataset sintético (nenhum dado real)
cd src && node build.mjs                # gera index.html a partir de src/
node tests/run.mjs                      # 327 testes
node tests/benchmark.mjs --check        # 87 critérios, falha se houver regressão
```

**`index.html` é gerado. Nunca edite à mão.** O núcleo vive em `src/core/**` como **59 módulos ES** por responsabilidade (~10.500 linhas). `src/build.mjs` resolve o grafo de imports, ordena topologicamente, detecta ciclos e colisões de identificador, e concatena tudo num arquivo autocontido. A CI falha se `index.html` estiver dessincronizado de `src/`.

Regra de dependência: `io` não importa `dsp`; `dsp` não importa `metrics`; `metrics` importa `dsp` e `stats`; **nada** importa `app`.

Instale o *hook* que bloqueia commits com dados identificadores:

```bash
cp tools/pre-commit .git/hooks/ && chmod +x .git/hooks/pre-commit
```

---

## Esquema do eletrodo, em escala e com os contatos em uso marcados

O modelo do eletrodo é **detectado automaticamente** no `LeadConfiguration` do JSON, e as figuras
que citam contatos passam a mostrar o eletrodo desenhado em escala real, com os contatos daquela
figura destacados:

| Figura | O que marca |
|---|---|
| **F1** — Survey | o par bipolar cujo espectro está sendo mostrado |
| **F3** — impedâncias | os contatos fora dos limites de curto ou circuito aberto do fabricante |
| **F6** — domínio do tempo | o par que gerou o traçado |
| **F7** — rampa de estimulação | catodo, anodo **e** o par de sensing, juntos |
| **F30** — espectrograma | o par que gerou o espectrograma |
| **F31** — passaporte | onde o biomarcador foi definido, nos dois hemisférios |

Modelos com geometria: **3387**, **3389**, **3391**, **SenSight B33005** e **B33015** — altura de
contato, espaçamento, extensão do arranjo, ponta distal e diâmetro do corpo, em milímetros, dos
manuais de implante (3387/3389, 2020; SenSight, 2021).

**Por que isso não é enfeite.** Um par "0-3" abrange **7,5 mm** num 3389, **10,5 mm** num 3387 e
**24 mm** num 3391 — mesmo rótulo, situações anatômicas diferentes. Sem o desenho, quem lê o
gráfico não tem como saber qual está vendo.

Três decisões de honestidade que valem registrar:

- **Modelo não reconhecido não vira eletrodo genérico.** O painel diz que não desenhou e por quê —
  um desenho errado seria pior do que nenhum.
- **Num eletrodo direcional não existe contato "1".** O nível 1 é 1a/1b/1c, e quando o aparelho
  registra em "1-3" ele usa os três segmentos em curto. O desenho marca os três e explica que é
  assim que o aparelho funciona.
- **A orientação anatômica dos segmentos não é afirmada.** Os ângulos a/b/c são de *nomenclatura*
  (convenção do fabricante); a rotação real no crânio vem do marcador radiopaco na radiografia
  intraoperatória e **não está no JSON**. O desenho diz isso.
- **As medidas do 3391 saem marcadas como não conferidas** — vêm de catálogo e da literatura, não
  do manual de implante.

As figuras vetoriais de referência de onde as proporções vieram estão em
[`docs/referencias/eletrodos/`](docs/referencias/eletrodos/), com a explicação de por que o
aplicativo redesenha em vez de embutir os SVG.

---

## Conformidade com o white paper do fabricante

O software foi auditado item a item contra o *DBS Sensing White Paper* da Medtronic
(**UC202012929cEN, FY24**, cópia em [`docs/referencias/`](docs/referencias/)). O relatório completo,
com categoria e ação por item, está em [`docs/auditoria-whitepaper.md`](docs/auditoria-whitepaper.md);
o resumo do que passou a ser tratado como documentado está em
[`docs/arquitetura.md`](docs/arquitetura.md#o-que-o-fabricante-documenta).

As três correções que mudavam número:

- **Dado censurado é negativo.** O aparelho marca com sinal negativo as amostras que ele próprio
  descartou por suspeita de artefato (p. 24, 25). Elas entravam como potência em toda a camada
  crônica — mediana, cosinor, limiares de aDBS, estados ON/OFF, resposta à levodopa. Agora viram
  `NaN` com contabilidade **separada** da perda de pacote, e um alarme próprio.
- **As sequências do BrainSense Streaming são intercaladas** entre o fluxo de sinal bruto e o de
  potência (p. 23, 24). Um salto de 1 é o comportamento normal — lidas como contador contínuo,
  reportavam **perda falsa de quase 50%** em todo registro de streaming, degradando Welch,
  espectrograma, ODR, bursts e o selo de qualidade.
- **`CalibrationTests` é com estimulação LIGADA** (p. 15), e estava classificado como desligada.
  É o par OFF/ON do mesmo paciente na mesma sessão: o alerta de comparar espectros de estados
  diferentes não disparava exatamente onde deveria.

E o que o documento resolveu de "assumido": a cadeia de filtros (2× passa-baixa 100 Hz, passa-alta
1 Hz fixo e um segundo configurável em 1 ou **10 Hz** — que, em 10 Hz, **elimina teta e delta** e
agora dispara alarme), a largura de banda de ~5 Hz, a unidade do Timeline (soma do quadrado da
magnitude na banda), o blanking, o `FullyReadForSession`, os limiares de impedância do fabricante,
e duas modalidades que não eram nem lidas: **`IndefiniteStreaming`** (Record Streaming — registro
longo, três canais por lead, **sem estimulação**) e **`Thresholds`**.

---

## Limitações declaradas

Estas não são falhas ocultas — são o escopo, e estão aqui porque quem for usar o software precisa saber delas antes.

1. **Nenhuma validação em dado de paciente real foi publicada.** Todo o benchmark é sobre sinal sintético com *ground truth* conhecido e sobre identidades analíticas. Concordância com julgamento clínico, com outras ferramentas sobre a mesma gravação, e reprodutibilidade entre centros **ainda não foram medidas**.

2. **A exportação BIDS é *BIDS-like*, não conformante.** A estrutura segue a lógica do iEEG-BIDS, mas não passou por validador oficial.

3. **A tradução para o inglês cobre a moldura da interface e os títulos das figuras**, não os textos metodológicos dentro delas. Uma tradução apressada de texto que explica limitação metodológica é pior do que texto em outro idioma.

4. **A emulação do PSD de bordo do Percept usa uma constante empírica (1/54)** herdada do BRAVO, sem documentação do fabricante. Ela reproduz a *dinâmica* do que o aparelho reporta; não valida a escala absoluta.

5. **A remoção de tendência 1/f no espectrograma é uma regressão log-log robusta, não o FOOOF completo.** O specparam completo está disponível na F19.

6. **A CLI não gera figuras.**

7. **O software não é dispositivo médico** e não substitui o software regulado do fabricante.

---

## Referências de arquitetura

Leituras que informaram o desenho — não são dependências:

- **perceive** (Neumann lab, Charité) — perda de pacote, interpolação de QRS, saída BIDS-like, um extrator por modalidade.
- **PerceptToolbox** (Thenaisie et al.) — `correct4MissingSamples`.
- **DBSsync** (Vivien et al.) — picos R em duas passagens, SVD, fs efetiva, sincronização por artefato de estimulação.
- **BRAVO** (Fixel Institute) — `checkMissingPackage`, `extractPredictionModel`, e o conjunto de espectrogramas portado na F30.
- **DBScope** / **NeoDBS** — janelas Individual vs. Combined.
- **py_neuromodulation** (Merk et al.) — features como módulos plugáveis.

---

## Citação

Se este software for útil na sua pesquisa, cite o repositório. Um manuscrito descrevendo a ferramenta está em preparação — ver [`docs/paper/`](docs/paper/).

## Licença

MIT — ver [`LICENSE`](LICENSE).

---

> **Aviso.** Ferramenta de pesquisa e apoio à decisão. **Não é dispositivo médico.** Não se destina a diagnóstico e não substitui o software regulado do fabricante do neuroestimulador. Toda decisão clínica é do profissional responsável.
