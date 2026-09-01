# Arquitetura do sono estimada do LFP crônico (F39)

Reprodução adaptada de **Averna A, Bernasconi E, Colombo A, et al. Decoding
sleep architecture from ambulatory basal ganglia signals in Parkinson's
disease. *Mov Disord* 2026 (doi:10.1002/mds.70493)** — para o caso em que **não
há sensor vestível**, que é o caso da maioria dos pacientes com Percept fora de
protocolo de pesquisa.

## O que o artigo fez

18 pacientes com DP e Percept, 4–8 semanas de BrainSense Timeline (potência
média por 10 min numa banda de ±2,5 Hz), com **três biomarcadores**: beta num
STN, e no outro STN **FTG** (62,5 Hz = metade da frequência de estimulação) ou
**baixa frequência** (7,81 ± 2,5 Hz, ou pico alfa). Um Apple Watch fazia o
estadiamento de referência (Awake/REM/Core/Deep, épocas de 30 s, rebaixadas a
10 min pelo estágio mais frequente). A potência era **z-scored dentro de cada
intervalo de sono**. Um classificador supervisionado (RUSBoost) era treinado
com os rótulos do relógio — validação dentro do paciente (2/3 → 1/3) e
leave-one-patient-out.

Achados que este módulo herda como conhecimento:

- beta e FTG **sobem** na vigília noturna e no REM e **caem** no sono profundo;
- a baixa frequência faz o **oposto** — é máxima no NREM profundo;
- vigília×sono decodifica bem (sensibilidade ≈ 86–90%); estágios individuais
  decodificam pior (REM é o mais difícil; Core vs Deep é apertado);
- z-scores medianos de grupo por estágio: **Fig. 3C** do artigo.

## O que este módulo faz sem o sensor

| Função do sensor no artigo | Substituto local declarado |
|---|---|
| Delimitar o intervalo de sono de cada noite | Detector circadiano do TIDAL-DT (cosinor 24+12 h + change-point), ancorado no tipo de maior dinâmica circadiana (beta > FTG > low; a low é invertida antes do ajuste, porque o vale dela é a vigília) — **ou** horários habituais informados pelo usuário, que é exatamente a informação com que o artigo configurava o relógio |
| Rotular épocas para treinar o classificador | Nenhum treino: classificação **não supervisionada por centróide mais próximo** no espaço dos z-scores, com centróides digitalizados da Fig. 3C (aproximação visual declarada e exportada) |

O resto segue o artigo: épocas de 10 min, z-score **por intervalo de sono**,
tipagem do biomarcador pela frequência de sensing (low < 13 Hz ≤ beta < 35 Hz ≤
FTG, fronteiras meio-abertas coerentes com `bandPower`), média bilateral quando
os dois hemisférios registram o mesmo tipo.

## Honestidade

- **Margem de decisão exportada.** Época com diferença < 0,15 z entre o 1º e o
  2º centróide é marcada `low_confidence`, desenhada translúcida e contada.
- **Só beta** (o caso mais comum): REM e vigília noturna são pouco separáveis
  (beta alto em ambos) e Core–Deep distam ~0,25 z. A figura declara isso em
  ressalva permanente, não em tooltip.
- **Sensing sem frequência declarada** é tratado como beta **com aviso** — a
  suposição fica na tabela de biomarcadores e no CSV.
- **Época sem amostra é NaN**; noite com cobertura < 70% sai do agregado com o
  motivo listado; agregado com < 3 noites utilizáveis é marcado insuficiente.
- **Alvo fora do STN** dispara o aviso de extrapolação: no GPi o beta se
  **sustenta** durante o sono (Yin 2023, doi:10.1038/s41467-023-41128-6) e os
  centróides subtalâmicos não se transferem.
- **Não é polissonografia.** Épocas de 10 min apagam microdespertares por
  construção; o desempenho esperado é inferior ao dos modelos treinados do
  artigo. Ferramenta de pesquisa.

## Auto-teste

`SLEEP.selfTest()` planta um hipnograma sintético (profundo no início da
noite, REM no fim, dois despertares) com o RNG determinístico do TIDAL e exige:
acurácia ≥ 85% com os três biomarcadores, ≥ 80% com beta+low e ≥ 70% de
separação vigília×profundo no modo só-beta. Valores medidos na suíte:
96,3% / 88,9% / 94,1%.

## Contrato de exportação

CSV por época (`SLEEP_CSV_COLUMNS`, cabeçalhos em inglês): `night_local,
epoch_index, epoch_utc, epoch_local_hour, z_beta, z_low, z_ftg, stage,
margin_z, low_confidence, combo, sleep_window_local, sleep_window_method,
epoch_min, centroid_source, version`. CSV por noite: TST estimado, latência,
WASO, despertares, transições/h, % por estágio, % de baixa confiança, mais os
parâmetros da janela de sono.

## Referências

1. Averna A, et al. *Mov Disord* 2026. doi:10.1002/mds.70493
2. Colombo A, et al. *Mov Disord* 2025;40:881–895. doi:10.1002/mds.30160
3. Christensen E, et al. *J Sleep Res* 2019;28:e12806. doi:10.1111/jsr.12806
4. Chen Y, et al. *IEEE Trans Neural Syst Rehabil Eng* 2019;27:118–128.
5. Yin Z, et al. *Nat Commun* 2023;14:5434. doi:10.1038/s41467-023-41128-6
6. van Rheede JJ, et al. *npj Parkinsons Dis* 2022;8:88. doi:10.1038/s41531-022-00350-7
7. Baumgartner AJ, et al. *Sleep* 2025;48:zsaf005. doi:10.1093/sleep/zsaf005
