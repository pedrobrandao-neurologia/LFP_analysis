# TIDAL-DT — Timeline-Derived Automated Limits for Dual Threshold

Módulo: `src/core/metrics/tidal.js` (namespace `PerceptCore.TIDAL`) · Figura: **F36**
(aba Ponte) · Espelho em R: `R/tidal_dt.R` · Validação cruzada no CI.

## O que propõe

Limiares inferior e superior de LFP para o modo **dual threshold** do aDBS
BrainSense (Percept PC/RC), derivados do BrainSense Timeline
(`DiagnosticData.LFPTrendLogs`, médias de 10 min em unidades nativas). Todo o
processamento é local, sem dependência nova.

O método de referência é manual — percentis 25/75 do beta **diurno** do Timeline,
com refinamento clínico (Busch 2025, doi:10.1038/s41531-025-01124-7). O TIDAL-DT
automatiza a derivação mantendo cada decisão auditável; streaming de consultório
não entra, porque não representa o beta de longo prazo.

## Pipeline (por hemisfério, independente)

1. **Limpeza robusta.** `x = log10(LFP+1)`; Hampel deslizante (janela 12 ≈ 2 h,
   k = 3×1,4826·MAD); dias com <70% de amostras ou >20% de rejeição são
   excluídos **e listados com o motivo** (ADAPT-START,
   doi:10.1038/s41531-026-01269-z). Parâmetros editáveis em *Advanced settings*.
2. **Vigília sem actigrafia.** Cosinor 24+12 h; vigília provisória = maior
   trecho circular acima da mesor; bordas refinadas por change-point (SSE + BIC)
   em ±3 h. R² < 0,1 → janela fixa 08:00–22:00, **rotulada como fallback**. A
   hora do dia explica ~41% da variância do beta (van Rheede 2022,
   doi:10.1038/s41531-022-00350-7; Yin 2023, doi:10.1038/s41467-023-41128-6).
3. **GMM e limiares.** EM univariado com inicialização determinística (k-means
   nos quartis); k escolhido por BIC; bimodalidade exige também d de Ashman > 2.
   Bimodal: inferior = μ₁ + 0,5σ₁, superior = cruzamento das densidades
   ponderadas. Unimodal: percentis 30/70 rotulados
   `percentile fallback (unimodal distribution)`. Conversão 10^x − 1, inteiro.
   Havendo eventos de tomada, o *medication-cycle check* verifica a migração
   alto→baixo em ±90 min e sela pass/warn.
4. **Simulação do controlador.** Na resolução de 10 min — **limitação
   declarada**: o dispositivo real dispara com >1,2 s e rampa em ~2,5/5 min
   (Stanslaski 2024, doi:10.1038/s41531-024-00772-5); a simulação estima
   ocupação de zonas (alvo 20/60/20, aceitação 10–35/45–75/10–35), transições
   por dia e saturação nos limites de corrente. **Os limites min/max de
   corrente são entrada do clínico** — decisão de segurança não automatizada.
   Fora das faixas, o *Auto-tune* busca em grade ±15% (passos de 1%)
   minimizando distância ao alvo + penalidade de saturação.

## Casos-limite

- Sem Timeline → a figura não aparece.
- < 3 dias utilizáveis após a limpeza → **bloqueia** citando o ADAPT-START.
- Mudança de configuração de sensing no meio do registro → segmenta pelos
  blocos de configuração (F32) e usa só o segmento mais longo e mais recente,
  declarando isso.
- Um só hemisfério → processa o que existe.

## Reprodutibilidade 1:1 com o R

`R/tidal_dt.R` replica o pipeline função a função, com nomes espelhados
(`hampelFilter`↔`hampel_filter`, `fitGMM1D`↔`fit_gmm_1d`, …) e os mesmos
defaults. O gerador sintético usa um LCG minstd (48271 mod 2³¹−1) com
Box–Muller sem cache: a aritmética cabe em 2⁵³, então **a sequência é idêntica
bit a bit em JavaScript e em R** — mesmo dataset, sem transferir arquivo.

Critério de aceite, executado no CI a cada push: o self-test no app e
`Rscript R/tidal_dt.R --selftest` devem propor limiares divergindo **< 2%**.
Medido: JS 29/37, R 29/37 — divergência 0,00% (verdade de campo 29/38; erro do
pipeline 0% e 2,6%, aceite < 10%). O GMM do R usa `mclust::Mclust` quando
disponível, com EM em base R (espelho do app) como fallback declarado.

## Exportações

CSV com cabeçalhos exatos:
`hemisphere, method, lower_threshold_lfp, upper_threshold_lfp, mu1_log,
sigma1_log, mu2_log, sigma2_log, ashman_d, bic_k1, bic_k2, pct_below,
pct_within, pct_above, transitions_per_day, days_used, days_excluded,
wake_window`. Relatório imprimível via CSS print, com dias excluídos, método,
parâmetros, referências e o disclaimer:

> Decision-support tool. Proposed thresholds require clinician review,
> in-clinic confirmation and iterative refinement based on clinical response.
> Not a medical device.
