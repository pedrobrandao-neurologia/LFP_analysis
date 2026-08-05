# MRDS — (des)sincronização relacionada ao movimento

Módulo: `src/core/metrics/mrds.js` · Figura: **F35** (aba Agudo) · Checklist: grupo
"Contraste movimento vs repouso (MRDS)"

## O que é

MRDS contrasta a potência de uma época de **movimento** com a de uma época de **repouso**,
normalizada pelo repouso:

```
MRDS_x = (PM_x − PR_x) / PR_x
```

onde `x` é o ritmo (β 13–35 Hz, γ 35–100 Hz), `PM` a potência sob movimento e `PR` a potência em
repouso. Unidade: adimensional. Negativo = dessincronização (a potência cai com o movimento);
positivo = sincronização.

**Protocolo de referência.** Alves ALM, Simões JS, Trajano da Silva LR, Fim Neto A, Godinho F,
Carra RB, et al. *Transcutaneous Spinal Magnetic Stimulation Affects Subthalamic Activity in
Parkinson's Disease.* Mov Disord 2025;40(11):2543–5. doi:10.1002/mds.70035.

Parâmetros do artigo, reproduzidos como padrão e todos editáveis: 180 s a 250 Hz, passa-banda
2–100 Hz, z-score por sessão, Welch com janela de 1000 amostras (4 s), sobreposição de 500 e NFFT
de 1000 — resolução de 0,25 Hz.

## Dois níveis, e por que eles são separados na tela

O MRDS **não** é um contraste corrigido para artefato de movimento. Ele *é* o contraste
movimento−repouso, e artefato de movimento entra inteiro nele: abrir e fechar a mão e caminhar
injetam artefato de banda larga, e a censura do próprio aparelho se concentra onde há movimento.

O que cancela modulação motora é o **segundo nível**:

```
ΔMRDS_x = MRDS_x(pós) − MRDS_x(basal)
```

Qualquer efeito do movimento presente nos dois momentos — inclusive artefato, desde que
reprodutível — subtrai. A figura calcula e apresenta os dois níveis separados, e quando só o
primeiro está disponível ela diz isso em vez de entregar o número sozinho.

Verificado em teste: com artefato idêntico (escala de 1,4×) nas épocas de movimento dos dois
momentos e queda real de β só no pós, o MRDS de β no basal é **+0,95** (artefato puro), e o
ΔMRDS de γ — banda sem efeito real — fica em **−0,012**, ou seja, o artefato cancela.

## Decomposição banda-larga vs específica de banda

Seja `S_x = P_x / P_total` a fração do espectro na banda `x`. Então, **sem aproximação**:

```
1 + MRDS_abs = (1 + MRDS_rel) × (1 + MRDS_total)
```

O fator `(1 + MRDS_total)` é o que muda em *todo* o espectro: escala global, ganho, artefato de
banda larga. O fator `(1 + MRDS_rel)` é o que muda a *forma* do espectro, e é o único candidato a
(des)sincronização específica de banda.

A identidade é verificada em teste com resíduo de 1×10⁻¹⁶. Sob escala pura de 1,5×, o MRDS
absoluto sobe ~1,25 em toda banda e o relativo fica em ~0 — e a figura emite o veredito de
mudança de banda larga.

## O escopo do z-score muda o número publicado

O artigo diz "z-scored for each recording session" sem definir se a sessão é a visita inteira ou
cada gravação. A diferença não é cosmética:

| escopo | consequência |
|---|---|
| `record` (por gravação) | a variância de cada época vira 1 por construção; a razão de variâncias movimento/repouso é **exatamente 1**, e o MRDS mede apenas redistribuição espectral |
| `session` (por sessão) | uma escala para todas as épocas da unidade; o MRDS mantém sentido de mudança de potência dentro da sessão |
| `none` | potência em µV²/Hz, comparável só dentro de um mesmo bloco de configuração de sensing |

Medido no mesmo sinal sintético: β absoluto **−0,614** com escopo de sessão contra **−0,439** com
escopo de gravação. O MRDS **relativo** é idêntico nos dois (−0,4310) — ele é invariante a escala,
e é por isso que serve de discriminante.

A figura oferece a escolha, declara qual foi usada, e mostra a razão de variâncias — o número que
prova a restrição.

## O aparelho antes do método

- Os **dois passa-baixas de 100 Hz** do Percept atenuam de forma crescente ao longo de 60–100 Hz.
  Um γ definido como 35–100 Hz é medido através de uma resposta em queda: a metade superior da
  banda chega ao arquivo já reduzida por projeto [UC202012929cEN FY24, p. 11].
- Com o **passa-alta configurável em 10 Hz**, a borda inferior de β (13 Hz) cai na transição do
  filtro, e a potência ali medida é o joelho do filtro.

Ambos aparecem como ressalva na figura, com o valor efetivo lido de `GroupSettings` quando o
arquivo o declara.

## Atribuição das épocas

O JSON do Percept **não carrega rótulo de tarefa**. Qual gravação (ou qual janela) é repouso e qual
é movimento é declarado por quem analisa, em dois modos:

- **gravações separadas** — cada passagem de tempo-domínio recebe uma célula do desenho 2×2;
  hemisférios viram unidades pareadas. É o formato do artigo.
- **janelas dentro de uma gravação** — intervalos em segundos dentro de um único registro
  contínuo, que é o formato mais comum num arquivo do Percept.

A atribuição entra no manifesto de proveniência e nos itens do checklist. **Sem ela, o passo
`metrics.mrds` não existe** e os sete itens do grupo voltam como "não determinado" — que é a
resposta correta, e melhor do que um valor plausível vindo de palpite.

## Estatística: o n limita o p antes do dado

O teste pareado é uma **permutação por troca de sinal, enumerada por inteiro** quando n ≤ 20: o p
é exato e determinístico, sem semente e sem Monte Carlo.

Com n unidades, o menor p bicaudal alcançável é `2/2ⁿ`. Com **n = 4** — quatro hemisférios, que é o
n do artigo — isso dá **0,125**: nenhum resultado pode atingir 0,05, independentemente do tamanho
do efeito. A figura declara esse piso.

O t pareado é reportado **ao lado** do p exato, e não no lugar dele. Nos mesmos quatro valores, o t
desce abaixo de 0,05 onde a permutação não consegue. Toda essa diferença é a suposição de
normalidade, que quatro pontos não sustentam nem refutam — e apresentar apenas o t esconderia essa
escolha dentro de um número.

**Pseudorreplicação.** Dois hemisférios do mesmo paciente não são observações independentes. O
resultado reporta `n_units` e `n_subjects` separados, e o p sobre hemisférios responde a uma
pergunta sobre hemisférios, não sobre pessoas.

## O que a figura NÃO reproduz do artigo

- **O Butterworth IIR de 6ª ordem.** Filtrar 2–100 Hz e depois ler a PSD por banda é quase idêntico
  a não filtrar: o filtro só molda um espectro que em seguida se integra por banda. A figura usa a
  faixa de análise diretamente na integração, e diz isso, em vez de escrever um IIR para parecer
  fiel.
- **O NFFT em potência de 2 é opcional.** Por padrão a figura usa NFFT exato de 1000 pontos, via
  transformada de Bluestein, reproduzindo os 0,25 Hz publicados. Desligando, o NFFT vai para 1024 e
  a resolução para 0,2441 Hz — a potência de β difere em 0,05%.

## Exportações

- **CSV** com cabeçalhos em inglês e bloco de metadados comentado: uma linha por unidade × momento
  × banda, carregando `zscore_scope`, `welch_window_samples`, `nfft`, `resolution_hz`, `n_units`,
  `n_subjects`, `paired_p_permutation`, `paired_p_ttest` e `min_achievable_p`.
- **JSON** com o mesmo conteúdo mais a atribuição declarada, o modo de atribuição e as limitações.
