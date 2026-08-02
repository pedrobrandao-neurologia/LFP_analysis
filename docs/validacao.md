# Validação quantitativa do pipeline

Este documento reporta **desempenho medido**, não intenção. É o que se cita em manuscrito e o que
um revisor lê primeiro.

A suíte `tests/run.mjs` é de **regressão**: verifica que o código faz o que fazia. Ela não diz se o
que ele faz está certo. `tests/benchmark.mjs` mede o pipeline contra **ground truth conhecido**,
gerado por `tools/gerar_sintetico.mjs`.

## Metodologia do sinal sintético

Construção conforme Vivien et al., npj Parkinsons Dis 2026:

- soma de senoides em teta e beta com **frequências e amplitudes declaradas**;
- **ruído 1/f** com expoente configurável, gerado no domínio da frequência;
- **passa-alta em 0,01 Hz**, simulando o filtro de hardware do Percept;
- contaminação com **artefato de ECG** (QRS bifásico paramétrico de ~100 ms) escalado para um
  **SNR alvo de −10 a +10 dB**, com **variabilidade de RR (HRV)**;
- **bursts de beta** em instantes e durações conhecidos;
- **perda de pacotes** em taxa configurável, com `GlobalPacketSizes`/`TicksInMses`/`GlobalSequences`
  coerentes, e **fs efetiva real** de 249,99 Hz (deriva).

Cada sinal vem com um `<nome>.truth.json` contendo: frequências e amplitudes de pico, expoente e
offset aperiódicos, **posições exatas dos picos R**, **índices exatos dos pacotes perdidos**, fs
efetiva real, instantes e durações dos bursts injetados, e o **sinal limpo de referência** para
cálculo de correlação.

```bash
node tools/gerar_sintetico.mjs --preset pd|dystonia|et|epilepsy --out examples/
node tools/gerar_sintetico.mjs --snr-sweep -10:5:10 --out benchmark/
node tools/gerar_sintetico.mjs --packet-loss 0,1,5,10 --out benchmark/
node tests/benchmark.mjs --out benchmark          # tabela de desempenho
node tests/benchmark.mjs --check                  # falha se regredir (CI)
```

## Desempenho atual — 87/87 critérios aprovados

A tabela completa, com valor por condição, está em [`benchmark/resultados.md`](../benchmark/resultados.md)
(regenerada a cada execução da CI). Resumo:

| Métrica | Critério | Resultado |
|---|---|---|
| Detecção de picos R — verdadeiros positivos | ≥ 95% | **100%** (SNR −10, −5 e 0 dB) |
| Detecção de picos R — falsos positivos | ≤ 1% | **0%** (SNR −10, −5 e 0 dB) |
| Razão de supressão de ECG | > 0 dB | 2,5–11,4 dB nos três métodos |
| Recuperação do pico beta | [0,7; 1,3] | 0,90–1,03 nos três métodos |
| Correlação com o ground truth (SVD) | > 0,90 | **0,968–0,969** |
| Preservação de potência beta (BPP) | [0,7; 1,3] | 0,90–0,91 |
| Preservação de potência teta (TPP) | [0,7; 1,3] | 0,96–0,98 |
| Detecção de pacotes perdidos (Jaccard) | > 0,99 | **1,00** (perda de 0, 1, 5 e 10%) |
| Recuperação da fs efetiva | < 0,005 Hz | **0,0016 Hz** |
| Recuperação da frequência de pico | < 0,5 Hz | 0,07–0,11 Hz (três perfis) |
| Recuperação do expoente aperiódico | < 40% | 0,5–2,0% |
| Detecção de bursts (F1) | > 0,80 | **0,98** |
| Confiança declarada com artefato fraco | não reivindicar "alta" | cumprido (SNR +5 e +10 dB) |

### DSP avançada (Onda 3)

| Métrica | Critério | Resultado |
|---|---|---|
| Ortonormalidade das DPSS (N=512, NW=4, K=7) | < 1e−8 | **0** (exato até o ponto flutuante) |
| Concentração λ até a ordem 2NW−2 | > 0,99 | **0,995** |
| Pico por multitaper em registro de 4 s | < 0,5 Hz | **0,016 Hz** — o Welch se recusa (2 segmentos) |
| Pico por multitaper em 8 e 16 s | < 0,5 Hz | 0,016 e 0,077 Hz |
| specparam — expoente χ (três valores verdadeiros) | < 0,10 | **0,001–0,002** |
| specparam — offset | < 0,15 | 0,003–0,005 |
| specparam — frequência do pico | < 0,5 Hz | **0,005–0,007 Hz** |
| specparam — largura do pico | < 2,5 Hz | 0,06–0,10 Hz |
| specparam — R² do modelo | > 0,95 | **1,000** |
| Seleção de modelo aperiódico (joelho vs. reta) | acerto | **2/2** |
| Bursts por wavelet de Morlet (F1) | > 0,75 | **0,98** |
| PAC — detecta acoplamento simulado | z > 5 | **z = 23,7** |
| PAC — rejeita controle sem acoplamento | z < 3 | **z = −0,20** |
| Gama — classifica entrained em f_stim/2 | acerto | **1/1** |
| Gama — classifica endógena fora de f_stim/2 | acerto | **1/1** |
| Gama — recusa classificar sem f_stim | acerto | **1/1** |

### Comparação dos três métodos de remoção de ECG

É a comparação que Stam et al. e Vivien et al. fizeram e que nenhuma ferramenta reporta para si
mesma. A −10 dB, correlação com o sinal limpo verdadeiro:

| Método | Correlação | Supressão | Recuperação do pico β |
|---|---:|---:|---:|
| **SVD (k=2)** | **0,968** | 11,4 dB | 1,03 |
| Interpolação de QRS | 0,903 | 11,3 dB | 0,92 |
| Subtração de template | 0,620 | 7,3 dB | 0,90 |

O resultado é consistente com o SVD ser o método recomendado na literatura.

## Três achados que mudaram o código

Medir mudou decisões que teriam ficado erradas se seguíssemos os defaults herdados:

1. **Janela de ±0,06 s, não ±0,2 s.** A janela larga citada na referência degrada a preservação do
   pico beta nos três métodos — no SVD a recuperação cai de 0,86 para 0,56 —, porque a época passa a
   conter sinal cerebral além do artefato.
2. **k = 2 componentes de SVD por default.** Correlação com o ground truth de 0,97 contra 0,83 com
   k = 1, confirmando a recomendação de Vivien et al. de usar mais de um componente.
3. **Semeadura da detecção no estilo Pan-Tompkins** (passa-banda → derivada → quadrado → integração).
   O QRS é um transiente agudo; bursts de beta são oscilações sustentadas de amplitude comparável.
   Buscar máximos de amplitude no sinal cru confundia os dois: **a detecção a −5 dB subiu de 53%
   para 100%** de verdadeiros positivos ao trocar a semeadura.

## Limitações honestas

- **Sinal sintético não reproduz artefato de movimento real.** O tremor injetado é uma senoide;
  movimento real é não estacionário e de espectro largo. A validação da regressão por IMU exige dado
  real com cinemática concomitante (Onda 2.3, ainda não implementada).
- **O ground truth de burst depende da definição adotada.** O F1 de 0,98 mede concordância com os
  bursts *injetados* sob a definição de limiar por percentil. Métodos com outra definição
  (linha de base 1/f, bracketing por wavelet — Onda 3.2) produziriam outro número, e a divergência
  entre definições é justamente a controvérsia documentada na literatura.
- **A fronteira de detecção depende do conteúdo do sinal.** Medimos 100% de VP até 0 dB com o sinal
  do gerador (que inclui bursts). Num sinal mais simples a fronteira cai para −5 dB; num registro
  real com mais fontes de artefato pode ser diferente. Por isso o detector **reporta confiança e o
  motivo**, em vez de assumir que sempre acerta.
- **Não há validação cruzada contra o `perceive` ainda.** É o teste de sanidade mais barato que
  existe e está pendente (Onda 6.2 / L48).
- **O benchmark não cobre ainda** recuperação de MESOR/amplitude/acrofase circadianos contra ground
  truth (exige gerar Timeline com parâmetros declarados) nem a varredura de artefato de rampa.

## Regressão de desempenho na CI

`benchmark/baseline.json` guarda o resultado aprovado. A CI roda `node tests/benchmark.mjs --check`
e **falha se qualquer critério que passava deixar de passar** — degradação numérica silenciosa é
exatamente o que os testes de regressão comuns não pegam.
