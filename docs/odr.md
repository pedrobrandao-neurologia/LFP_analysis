# ODR, coerência inter-STN e variação espectral por janela

Documentação da Onda 12 do **Percept LFP Studio**: as três *features* por janela que
o registro do Percept sustenta sozinho, sem sinal externo e sem rótulo clínico.

Fundamentação: Habets JGV, Merk T, Mathiopoulou V, et al. *Movement dependent neural
substates within levodopa-induced dyskinesia in Parkinson's disease.* **Brain** 2026;
doi:10.1093/brain/awag256.

---

## 1. O que foi implementado, e o que ficou de fora

| Implementado | Onde | Por quê é possível aqui |
|---|---|---|
| Potência por banda por janela | `dsp/features.js` → `windowedBandPower` | precisa só do sinal bruto |
| Variação espectral (CV do envelope) | `dsp/features.js` → `spectralVariation` | idem |
| Coerência inter-STN por janela | `dsp/features.js` → `windowedCoherence`; `metrics/windowed.js` → `interSTNCoherence` | precisa dos dois hemisférios no mesmo registro |
| ODR | `metrics/odr.js` → `odrSeries` | combina as três bandas acima |

**Fora do escopo desta onda**, e a razão é a mesma para os três: dependem de dado que
o arquivo do Percept não contém.

- **Detecção de movimento** — exige acelerometria sincronizada.
- **Rótulo de discinesia** — exige escala aplicada no momento, ou vídeo.
- **Classificador** — exige rótulo para treinar e para validar.

A figura F34 escreve essa fronteira na interface, não só aqui: sem rótulo clínico, ela
descreve a dinâmica das *features* ao longo do tempo, e **não afirma detecção de
discinesia**.

---

## 2. A tabela de limitações — está na saída, não em nota de rodapé

Exportada como `ODR_LIMITACOES`, mostrada na F34 e escrita no bloco de metadados de
todo CSV.

| Item | No artigo | No Percept | Consequência |
|---|---|---|---|
| Otimização de SNR | SSD (decomposição espectro-espacial) por banda, por eletrodo | um par bipolar por hemisfério | **SSD não é implementável.** A sensibilidade cai, sobretudo em gama. |
| Estimulação | desligada durante todo o protocolo | tipicamente ligada | gama *entrained* em f_stim/2 cairia dentro do numerador — há guarda que recusa o cálculo |
| Condição de registro | eletrodos externalizados, janela perioperatória | gerador implantado, registro crônico | o efeito de lesão subtalâmica agudo presente no artigo está ausente aqui |
| Referência do ODR | calculado sobre componentes SSD | calculado sobre o bipolar bruto | os valores absolutos **não são comparáveis** com os do artigo |

**Desempenho esperado.** No estudo original, o ODR como preditor univariado atingiu
**acurácia balanceada média de 0,61 (DP 0,14), com detecção significativa em 8 de 21
sujeitos** — e isso com SSD, estimulação desligada e rótulo validado por vídeo. É um
marcador exploratório. Uma série suave e crescente sugere uma confiabilidade que ele
não tem, e é por isso que esse número aparece na figura.

---

## 3. O ODR e o problema da fórmula literal

### 3.1 A definição

```
ODR = (θ × γpico) / β_baixo
```

com θ = 4–8 Hz, β baixo = 12–20 Hz e γpico = pico individual de gama ± 2,5 Hz. Sobe
quando teta e gama sobem e quando beta cai.

### 3.2 Por que a versão literal é instável

A fórmula original é uma razão de **potências**. O artigo, porém, aplica z-score a cada
banda ao longo do registro antes de combinar. E um valor z-scored **cruza zero por
construção**: a média de um z-score é exatamente zero, então o denominador z(β) passa
perto de zero necessariamente, e várias vezes, em qualquer registro.

Duas consequências, ambas fatais para a leitura:

1. **A razão explode.** Quando z(β) → 0, o ODR literal → ±∞. Não é ruído: é a fórmula.
2. **O sinal se inverte.** Quando z(β) muda de sinal, o ODR troca de sinal sem que nada
   tenha mudado na fisiologia. Um "ODR negativo" nessas janelas não significa nada.

### 3.3 A demonstração algébrica de que a versão logarítmica é a mesma razão

Partindo da razão de potências:

```
    ODR = (θ · γ) / β

    log ODR = log(θ · γ / β)
            = log θ + log γ − log β
```

O logaritmo é **estritamente monotônico**: `a > b ⟺ log a > log b` para a, b > 0. Logo,
ordenar janelas por `log ODR` é ordenar janelas por `ODR`. A transformação preserva
toda a informação de ordem, que é o que uma série temporal de um marcador exploratório
comunica.

O que muda é a **normalização**. Em vez de z-scorear as potências e depois dividir, o
z-score é aplicado sobre a potência **em log**:

```
    odrLog = z(log θ) + z(log γ) − z(log β)
```

Não há divisão, e portanto não há denominador que cruze zero. A série fica limitada e o
sinal só muda quando a combinação das três bandas de fato muda.

> **Nota sobre o que a transformação não preserva.** `z(log θ) + z(log γ) − z(log β)`
> não é igual a `z(log θ + log γ − log β)`: cada banda é padronizada pelo próprio
> desvio-padrão antes de somar, e as três bandas têm variabilidades diferentes ao longo
> do registro. Isso é uma escolha, e é a mesma que o artigo faz ao z-scorear cada banda
> separadamente. O efeito é dar peso igual às três bandas na combinação, em vez de deixar
> a banda mais variável dominar. O parâmetro sai declarado em `zPolicy`.

### 3.4 O que o software faz com as duas

Calcula **as duas** e reporta a divergência:

- `odrLog` — o padrão, pelo motivo acima;
- `odrLiteral` — a razão sobre as bandas z-scoradas, exatamente como escrita no artigo,
  para permitir comparação direta com a literatura;
- `spearmanLogVsLiteral` — a correlação de postos entre elas;
- `literalEscapeFraction` — a fração de janelas em que `|odrLiteral|` ultrapassa um
  intervalo declarado (`literalClip`, padrão 10), que é a **assinatura direta** do
  cruzamento de zero no denominador.

A divergência entre as duas **é propriedade da fórmula, não erro de implementação**, e a
saída diz isso com todas as letras em `formulationNote`.

**Verificado na suíte de testes:**

- `odrLog` correlaciona 0,992 (Spearman) com `log(θ·γ/β)` calculado diretamente das
  potências exportadas — a equivalência algébrica, medida e não afirmada;
- numa construção em que uma janela tem z(β) = 0,022, `max|odrLiteral| = 20,9` enquanto
  `max|odrLog| = 3,75`, e o módulo contabiliza o escape.

---

## 4. As guardas do ODR

### 4.1 Gama *entrained* em f_stim/2

Antes de usar o termo de gama, o módulo obtém a frequência de estimulação
(`inferDeviceState`, com varredura de reserva pelo `TherapySnapshot` do `BrainSenseLfp`
e pelo grupo ativo) e roda `detectGamma`.

**Se o pico dominante de gama cair dentro da tolerância de f_stim/2, o ODR não é
calculado.** O numerador estaria medindo a resposta subarmônica da rede à própria
estimulação — engate 1:2 —, e não gama endógena. As duas leituras clínicas são
**opostas**: gama finamente sintonizada é marcador pró-cinético; gama *entrained* não é
ritmo endógeno e não deve ser lida como estado motor.

Como escolha explícita do usuário, e marcada em toda a saída, fica disponível a variante:

```
odrSemGama = z(log θ) − z(log β)
```

com o aviso de que **não é o biomarcador do artigo** — o termo de gama é justamente o que
liga o ODR a discinesia — e não tem a mesma sustentação.

**Duas peneiras antes de aceitar um pico como γpico.** `detectGamma` aceita qualquer
saliência acima de 0,15 sobre o fundo aperiódico, o que descreve bem um espectro mas é
frouxo demais para definir a banda de um biomarcador. Aqui:

- `minGammaProminence` (padrão 0,5) — piso de saliência sobre o fundo aperiódico;
- `minPeakRatioToEntrained` (padrão 0,1) — quando gama endógena e *entrained* coexistem,
  a endógena só é aceita se não for migalha ao lado da outra. Um pico setenta mil vezes
  mais fraco que o subarmônico não é coexistência: é ruído ao lado de um artefato enorme,
  e usá-lo como γpico faria o ODR medir ruído enquanto o espectro é dominado pelo engate.

### 4.2 Sem pico individual de gama

Se não houver pico destacado do fundo aperiódico entre 60 e 90 Hz, **a substituição por
gama de banda larga não é feita em silêncio**. O motivo é devolvido; a banda larga fica
disponível como parâmetro (`gammaSource: 'broad'`) e sai marcada em cada linha exportada,
na coluna `gamma_source`.

### 4.3 A frequência de estimulação não declarada

Quando o arquivo não declara f_stim, a conferência contra f_stim/2 **não pode ser feita**.
O cálculo prossegue, mas `entrainmentChecked` sai `false`, a coluna
`entrainment_checked` marca cada linha exportada, e a figura mostra o aviso. Verificação
não feita não é verificação com resultado negativo — e as duas leituras clínicas do achado
são opostas.

### 4.4 Qualidade do registro

Janela com perda acima de `maxNanPct` (padrão 5%) sai `NaN` com motivo, nunca calculada
sobre o que sobrou. O mesmo vale para as três *features*.

---

## 5. Variação espectral: por que a política de borda importa

`CV = DP(envelope de Hilbert) / média(envelope)`, sobre o sinal filtrado em banda.

**Por padrão, filtra e calcula o envelope uma vez sobre o registro inteiro, e só depois
fatia por janela.** Filtrar dentro de cada janela de 10 s introduz transiente de borda em
cada uma delas, e o transiente enviesa o CV de forma sistemática — não aleatória, e por
isso não desaparece na média.

O modo por janela isolada existe (`perWindow: true`) e descarta as bordas equivalentes a
`edgeCycles` ciclos da frequência inferior. Isso troca o viés do transiente por outro
efeito, de sinal oposto: a janela efetiva encolhe, e janela menor devolve CV menor. Os
dois modos **não são intercambiáveis**; a política usada sai em `edgePolicy`, e a suíte de
testes mede a diferença entre eles (≈ 5% no sinal de teste) para que ela não seja
descoberta depois por alguém interpretando um resultado.

**O CV depende do comprimento da janela.** Janela maior alcança mais da flutuação lenta do
envelope e devolve CV maior — no sinal de teste, 0,172 com 10 s e 0,342 com 30 s.
Comparar CVs de janelas diferentes é erro, e por isso `windowS` sai em toda saída: para
que a comparação indevida seja verificável em vez de invisível.

**Guarda de estabilidade.** O CV é indefinido quando a média do envelope tende a zero.
Abaixo de `minMeanFrac` × (mediana das médias de janela) o valor sai `NaN` com motivo, em
vez de um número grande sem significado.

---

## 6. Coerência inter-STN

### 6.1 O pareamento vem antes do cálculo

Só é calculada quando os dois canais vêm do **mesmo registro**: mesmo
`FirstPacketDateTime`, mesma fs efetiva, mesmo comprimento, mesma base de ticks. Canais de
sessões diferentes não têm base de tempo comum — a coerência entre eles não é "baixa" nem
"alta", é um número sem referente. `pairableRecords` recusa e nomeia os campos que não
bateram.

### 6.2 A coerência sob a nula NÃO é zero

Com **L** segmentos efetivos, a coerência esperada sob a hipótese nula é **1/L**. Numa
janela de 10 s a 250 Hz sobram poucos segmentos: com L = 13, dois ruídos independentes dão
coerência média de banda ≈ 0,05–0,13, e o pico da banda chega perto de 0,25. Um valor
desses parece "coerência moderada" para quem lê só o número.

Por isso cada valor sai com três acompanhantes obrigatórios:

- `nSegmentsEffective` — o L, já corrigido para a não independência da sobreposição;
- `expectedNullCoherence` — o 1/L;
- `thresholdBandCorrected` — o limiar de significância corrigido por **Šidák** sobre o
  número de bins da banda, porque tomar o máximo sobre os bins é comparação múltipla
  disfarçada.

A suíte de testes verifica que a coerência média de banda sob a nula fica perto de 1/L
(**e não de zero** — se der zero, o cálculo está errado) e que a fração acima do limiar
corrigido fica perto de α. **O teste falha se alguém trocar o limiar corrigido por um
limiar fixo.**

### 6.3 Três confundidores de fase zero, medidos e reportados

| Confundidor | Por que produz coerência alta | Fase |
|---|---|---|
| Artefato de estimulação compartilhado | os dois hemisférios recebem o artefato do **mesmo** gerador | ~0 |
| Artefato cardíaco compartilhado | o QRS aparece nos dois lados; o batimento e seus harmônicos caem em delta, teta e alfa | ~0 |
| Condução de volume | mistura instantânea | ~0 |

O segundo é especialmente traiçoeiro aqui, porque o artigo relata aumento de coerência
**em teta** — exatamente onde caem os primeiros harmônicos do batimento. `detectRPeaks`
roda nos dois canais, e quando há contaminação compartilhada as bandas afetadas saem
marcadas com o harmônico e a frequência.

**O discriminante é a parte imaginária da coerência.** Ela é insensível a mistura
instantânea: só sobrevive o que tem defasagem, isto é, o que levou tempo para propagar.
Coerência alta com parte imaginária praticamente nula é compatível com os três
confundidores acima e **não deve ser reportada como acoplamento inter-hemisférico**. O
veredito de `coherenceBand` (`volumeConductionSuspected`) é propagado para cada janela e
para o resumo por banda.

**Verificado na suíte de testes:** um mesmo sinal copiado para os dois canais com atraso
zero dá coerência 1,00, parte imaginária 0,00 e o veredito de condução de volume em
12/12 janelas; com 8 ms de atraso, a parte imaginária sobe para 0,72 e o veredito não é
levantado em nenhuma.

### 6.4 O que o artigo mostrou

Coerência inter-subtalâmica **aumentou em teta** e **diminuiu em beta baixo** durante
períodos discinéticos sem movimento — o mesmo sentido dos padrões locais de cada STN.
Gama de pico mostrou aumento pequeno mas significativo; alfa e gama larga não diferiram.

---

## 7. Saída: tabela tidy, CSV e proveniência

`windowedFeatureTable` devolve **uma linha por janela × hemisfério**, com cabeçalhos em
inglês para os scripts em R. `windowedFeatureCsv` acrescenta um bloco de metadados em
comentário no topo, no mesmo padrão da F30: versão, janela, sobreposição, bandas, política
de z-score, definição do pico de gama, verificação contra f_stim/2, estado da estimulação
e a declaração de que o passo de SSD **não foi aplicado**.

Colunas (`WINDOWED_COLUMNS`): identificação da janela, potências por banda, z-scores, as
duas formulações do ODR, CVs, coerências e partes imaginárias, coerência sob a nula e
limiar da banda, estado do dispositivo, `gamma_source`, `entrainment_checked`,
`odr_valid` e `odr_reason`.

Passos registrados em `provenance/index.js` com os **parâmetros efetivos**:
`metrics.odr`, `dsp.spectralVariation` e `dsp.windowedCoherence`. Itens novos no
PERCEPT-REPORT, no grupo *Features por janela (ODR e coerência)*: janela e sobreposição,
definição do pico de gama, verificação contra f_stim/2, formulação usada e por quê,
política de normalização, estado da estimulação, e — para a coerência — segmentos
efetivos, limiar sob a nula e veredito de condução de volume.

---

## 8. Referências

- Habets JGV, Merk T, Mathiopoulou V, et al. Movement dependent neural substates within
  levodopa-induced dyskinesia in Parkinson's disease. **Brain** 2026;
  doi:10.1093/brain/awag256.
- Nolte G, Bai O, Wheaton L, Mari Z, Vorbach S, Hallett M. Identifying true brain
  interaction from EEG data using the imaginary part of coherency. **Clin Neurophysiol**
  2004;115:2292-2307.
- Halliday DM, Rosenberg JR, Amjad AM, Breeze P, Conway BA, Farmer SF. A framework for the
  analysis of mixed time series/point process data. **Prog Biophys Mol Biol**
  1995;64:237-278.
- Bortel R, Sovka P. Approximation of statistical distribution of magnitude squared
  coherence estimated with segment overlapping. **Signal Processing** 2007;87:1100-1117.
- Donoghue T, Haller M, Peterson EJ, et al. Parameterizing neural power spectra into
  periodic and aperiodic components. **Nat Neurosci** 2020;23:1655-1665.
