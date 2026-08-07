## =============================================================================
##  tidal_dt.R — TIDAL-DT: Timeline-Derived Automated Limits for Dual Threshold
##  Validação cruzada independente do módulo homônimo do Percept LFP Studio.
##
##  Replica EXATAMENTE o pipeline do app (src/core/metrics/tidal.js), função a
##  função, com os mesmos defaults — os nomes espelham 1:1 o namespace TIDAL
##  do JavaScript para que a seção de métodos de um artigo cite uma única
##  descrição válida para as duas implementações:
##      JS  hampelFilter()           R  hampel_filter()
##      JS  fitCosinor()             R  fit_cosinor()
##      JS  detectWakeWindow()       R  detect_wake_window()
##      JS  fitGMM1D()               R  fit_gmm_1d()
##      JS  proposeThresholds()      R  propose_thresholds()
##      JS  simulateDualThreshold()  R  simulate_dual_threshold()
##      JS  autoTune()               R  auto_tune()
##
##  Uso:
##      source("R/tidal_dt.R")
##      tidal_run("Report_Json_Session_Report_XXXX.json")      # JSON do Percept
##      tidal_run("timeline.csv")                              # CSV t,lfp[,hemisphere]
##      tidal_selftest()                                       # dataset sintético idêntico ao do app
##
##  Critério de aceite: tidal_selftest() aqui e o botão "Run self-test" no app
##  usam O MESMO gerador determinístico (LCG minstd + Box-Muller, semente 42);
##  os limiares propostos pelas duas implementações devem divergir < 2%.
##
##  Referências: Busch 2025 doi:10.1038/s41531-025-01124-7 · van Rheede 2022
##  doi:10.1038/s41531-022-00350-7 · Yin 2023 doi:10.1038/s41467-023-41128-6 ·
##  ADAPT-START 2026 doi:10.1038/s41531-026-01269-z · Stanslaski 2024
##  doi:10.1038/s41531-024-00772-5.
##
##  Disclaimer: Decision-support tool. Proposed thresholds require clinician
##  review, in-clinic confirmation and iterative refinement based on clinical
##  response. Not a medical device.
##
##  Dependências: jsonlite (leitura de JSON), mclust (GMM). Opcionais: zoo,
##  ggplot2, patchwork (figuras). Nenhuma é carregada no source(); cada função
##  exige a sua quando executa.
## =============================================================================

.tidal_dep <- function(pkg) {
  if (!requireNamespace(pkg, quietly = TRUE))
    stop(sprintf("Package '%s' is required here. install.packages('%s')", pkg, pkg), call. = FALSE)
}

TIDAL_DEFAULTS <- list(
  hampel_window = 12L, hampel_k = 3,
  min_valid_day_frac = 0.70, max_rejected_day_frac = 0.20, min_days = 3L,
  cosinor_r2_floor = 0.10, fallback_wake = c(8, 22),
  ashman_min = 2, fallback_percentiles = c(30, 70),
  targets = c(below = 20, within = 60, above = 20),
  accept = list(below = c(10, 35), within = c(45, 75), above = c(10, 35)),
  step_pc = 0.1, step_rc = 0.01,
  autotune_span_pct = 15, autotune_step_pct = 1
)

TIDAL_CSV_COLUMNS <- c(
  "hemisphere", "method", "lower_threshold_lfp", "upper_threshold_lfp",
  "mu1_log", "sigma1_log", "mu2_log", "sigma2_log", "ashman_d", "bic_k1", "bic_k2",
  "pct_below", "pct_within", "pct_above", "transitions_per_day",
  "days_used", "days_excluded", "wake_window"
)

## ------------------------------------------------------------ etapa 1 -------

## Filtro de Hampel — mesma janela CENTRADA do JS: índices i-h .. i+h-1
## (h = window/2), MAD com constante 1,4826, MAD zero não rejeita.
## (zoo::rollapply produz janelas equivalentes com align="center"; o loop
## explícito garante identidade bit a bit com o app.)
hampel_filter <- function(x, window = TIDAL_DEFAULTS$hampel_window, k = TIDAL_DEFAULTS$hampel_k) {
  n <- length(x); h <- floor(window / 2)
  artifact <- logical(n); out <- x
  for (i in seq_len(n)) {
    v <- x[i]
    if (!is.finite(v)) next
    lo <- max(1L, i - h); hi <- min(n, i + h - 1L)
    win <- x[lo:hi]; win <- win[is.finite(win)]
    if (length(win) < 4) next
    med <- stats::median(win)
    madv <- 1.4826 * stats::median(abs(win - med))
    if (madv <= 1e-12) next
    if (abs(v - med) > k * madv) { artifact[i] <- TRUE; out[i] <- NA_real_ }
  }
  list(x = out, artifact = artifact, n_rejected = sum(artifact))
}

audit_days <- function(day_key, x0, artifact,
                       min_valid = TIDAL_DEFAULTS$min_valid_day_frac,
                       max_rej = TIDAL_DEFAULTS$max_rejected_day_frac) {
  used <- character(0); excluded <- data.frame(day = character(0), reason = character(0))
  for (dk in sort(unique(day_key))) {
    idx <- day_key == dk
    valid <- sum(is.finite(x0[idx]))
    rej <- sum(artifact[idx] & is.finite(x0[idx]))
    frac_valid <- valid / 144
    frac_rej <- if (valid > 0) rej / valid else 0
    if (frac_valid < min_valid)
      excluded <- rbind(excluded, data.frame(day = dk, reason = sprintf("only %.0f%% of samples present", 100 * frac_valid)))
    else if (frac_rej > max_rej)
      excluded <- rbind(excluded, data.frame(day = dk, reason = sprintf("%.0f%% rejected as artifact", 100 * frac_rej)))
    else used <- c(used, dk)
  }
  list(used = used, excluded = excluded)
}

## ------------------------------------------------------------ etapa 2 -------

fit_cosinor <- function(hours, x) {
  d <- data.frame(x = x,
                  c24 = cos(2 * pi * hours / 24), s24 = sin(2 * pi * hours / 24),
                  c12 = cos(2 * pi * hours / 12), s12 = sin(2 * pi * hours / 12))
  m <- stats::lm(x ~ c24 + s24 + c12 + s12, data = d)
  co <- stats::coef(m)
  at <- function(h) unname(co[1] + co[2] * cos(2 * pi * h / 24) + co[3] * sin(2 * pi * h / 24) +
                             co[4] * cos(2 * pi * h / 12) + co[5] * sin(2 * pi * h / 12))
  list(mesor = unname(co[1]), r2 = summary(m)$r.squared, at = at)
}

.change_point_1 <- function(seg) {
  n <- length(seg); if (n < 6) return(-1L)
  sse1 <- sum((seg - mean(seg))^2)
  best <- -1L; best_sse <- Inf
  for (c in 2:(n - 2)) {
    a <- seg[1:c]; b <- seg[(c + 1):n]
    sse <- sum((a - mean(a))^2) + sum((b - mean(b))^2)
    if (sse < best_sse) { best_sse <- sse; best <- c }
  }
  bic1 <- n * log(max(sse1, 1e-12) / n)
  bic2 <- n * log(max(best_sse, 1e-12) / n) + 2 * log(n)
  if (bic2 < bic1) best else -1L
}

detect_wake_window <- function(hours, x,
                               r2_floor = TIDAL_DEFAULTS$cosinor_r2_floor,
                               fallback = TIDAL_DEFAULTS$fallback_wake) {
  fit <- fit_cosinor(hours, x)
  if (!is.finite(fit$r2) || fit$r2 < r2_floor)
    return(list(wake = fallback, method = "fallback fixed 08:00-22:00 (weak circadian fit)", r2 = fit$r2))
  nb <- 144L
  above <- vapply(seq_len(nb), function(i) fit$at((i - 1) / 6 + 1 / 12) > fit$mesor, logical(1))
  best_start <- -1L; best_len <- 0L
  for (s in seq_len(nb)) {
    if (!above[s] || above[((s - 2) %% nb) + 1]) next
    len <- 0L
    while (len < nb && above[((s - 1 + len) %% nb) + 1]) len <- len + 1L
    if (len > best_len) { best_len <- len; best_start <- s - 1L }
  }
  if (best_start < 0 || best_len == 0L || best_len == nb)
    return(list(wake = fallback, method = "fallback fixed 08:00-22:00 (no circadian trough)", r2 = fit$r2))
  wake_start <- best_start / 6; wake_end <- ((best_start + best_len) %% nb) / 6

  bin <- pmin(nb - 1L, floor(hours * 6))
  prof <- vapply(0:(nb - 1L), function(b) { v <- x[bin == b]; if (length(v)) mean(v) else NA_real_ }, numeric(1))
  refina <- function(h0) {
    c0 <- round(h0 * 6)
    idx <- ((c0 - 18):(c0 + 18)) %% nb
    seg <- prof[idx + 1L]; seg <- seg[is.finite(seg)]
    cp <- .change_point_1(seg)
    if (cp < 0) return(h0)
    (((c0 - 18 + cp) %% nb + nb) %% nb) / 6
  }
  list(wake = c(round(refina(wake_start), 2), round(refina(wake_end), 2)),
       method = "cosinor (24+12 h) + change-point refinement", r2 = fit$r2, mesor = fit$mesor)
}

in_wake <- function(h, wake) if (wake[1] < wake[2]) h >= wake[1] & h < wake[2] else h >= wake[1] | h < wake[2]

## ------------------------------------------------------------ etapa 3 -------

## GMM univariada. G=1 em base R (fechado); G=2 preferencialmente via
## mclust::Mclust (modelo "V"). Sem mclust instalado, cai para um EM em base R
## que espelha LINHA A LINHA o EM do app (mesma inicialização determinística
## por k-means nos quartis, mesmo piso de variância, mesma tolerância) — o
## fallback é declarado no campo `engine`. Em distribuição bem separada os
## dois EMs convergem para o mesmo ótimo; é o que o critério de aceite (<2%)
## verifica quando o mclust está presente.
.fit_gmm_em_base <- function(x) {
  n <- length(x)
  c1 <- unname(stats::quantile(x, .25, type = 7)); c2 <- unname(stats::quantile(x, .75, type = 7))
  if (!(c2 > c1)) c2 <- c1 + 1e-6
  for (it in 1:50) {
    a1 <- abs(x - c1) <= abs(x - c2)
    if (!any(a1) || all(a1)) break
    n1 <- mean(x[a1]); n2 <- mean(x[!a1])
    if (abs(n1 - c1) + abs(n2 - c2) < 1e-10) { c1 <- n1; c2 <- n2; break }
    c1 <- n1; c2 <- n2
  }
  w <- c(.5, .5); mu <- sort(c(c1, c2))
  v0 <- max(1e-6, (unname(stats::quantile(x, .75, type = 7)) - unname(stats::quantile(x, .25, type = 7)))^2 / 8)
  s2 <- c(v0, v0); ll <- -Inf
  for (it in 1:300) {
    la <- log(w[1]) + stats::dnorm(x, mu[1], sqrt(s2[1]), log = TRUE)
    lb <- log(w[2]) + stats::dnorm(x, mu[2], sqrt(s2[2]), log = TRUE)
    m <- pmax(la, lb)
    den <- m + log(exp(la - m) + exp(lb - m))
    r1 <- exp(la - den)
    ll_new <- sum(den)
    n1 <- sum(r1); n2 <- n - n1
    if (n1 < 1e-6 || n2 < 1e-6) break
    mu <- c(sum(r1 * x) / n1, sum((1 - r1) * x) / n2)
    s2 <- c(max(1e-8, sum(r1 * (x - mu[1])^2) / n1), max(1e-8, sum((1 - r1) * (x - mu[2])^2) / n2))
    w <- c(n1 / n, n2 / n)
    if (abs(ll_new - ll) < 1e-9 * abs(ll_new)) { ll <- ll_new; break }
    ll <- ll_new
  }
  if (mu[1] > mu[2]) { mu <- rev(mu); s2 <- rev(s2); w <- rev(w) }
  list(k = 2L, weights = w, means = mu, sigmas = sqrt(s2),
       log_lik = ll, bic = -2 * ll + 5 * log(n), engine = "base-R EM (mirror of the app)")
}

fit_gmm_1d <- function(x, k) {
  x <- x[is.finite(x)]; n <- length(x)
  if (n < 10) return(NULL)
  if (k == 1) {
    mu <- mean(x); s2 <- max(1e-8, sum((x - mu)^2) / n)
    ll <- sum(stats::dnorm(x, mu, sqrt(s2), log = TRUE))
    return(list(k = 1L, weights = 1, means = mu, sigmas = sqrt(s2), log_lik = ll, bic = -2 * ll + 2 * log(n)))
  }
  if (requireNamespace("mclust", quietly = TRUE)) {
    ## Mclust() avalia mclustBIC sem qualificar o namespace: só carregar o
    ## namespace não basta, o pacote precisa estar ANEXADO ao search path.
    suppressMessages(require("mclust", quietly = TRUE, character.only = TRUE))
    fit <- mclust::Mclust(x, G = 2, modelNames = "V", verbose = FALSE)
    if (!is.null(fit)) {
      ord <- order(fit$parameters$mean)
      return(list(k = 2L,
                  weights = fit$parameters$pro[ord],
                  means = unname(fit$parameters$mean[ord]),
                  sigmas = sqrt(unname(fit$parameters$variance$sigmasq))[ord],
                  log_lik = fit$loglik, bic = -2 * fit$loglik + 5 * log(n), engine = "mclust::Mclust(V)"))
    }
  }
  .fit_gmm_em_base(x)
}

ashman_d <- function(g) if (is.null(g) || g$k != 2) NA_real_ else
  sqrt(2) * abs(g$means[2] - g$means[1]) / sqrt(g$sigmas[1]^2 + g$sigmas[2]^2)

density_crossing <- function(g) {
  m1 <- g$means[1]; m2 <- g$means[2]; s1 <- g$sigmas[1]; s2 <- g$sigmas[2]
  w1 <- g$weights[1]; w2 <- g$weights[2]
  A <- 1 / (2 * s1^2); B <- 1 / (2 * s2^2)
  a <- B - A; b <- 2 * A * m1 - 2 * B * m2
  cc <- B * m2^2 - A * m1^2 + log((w1 * s2) / (w2 * s1))
  dentro <- function(x) is.finite(x) && x > m1 && x < m2
  if (abs(a) < 1e-12) { x <- -cc / b; return(if (dentro(x)) x else NA_real_) }
  disc <- b^2 - 4 * a * cc
  if (disc >= 0) {
    r1 <- (-b + sqrt(disc)) / (2 * a); r2 <- (-b - sqrt(disc)) / (2 * a)
    if (dentro(r1)) return(r1)
    if (dentro(r2)) return(r2)
  }
  f <- function(x) log(w1) + stats::dnorm(x, m1, s1, log = TRUE) - log(w2) - stats::dnorm(x, m2, s2, log = TRUE)
  lo <- m1; hi <- m2
  if (f(lo) * f(hi) > 0) return(NA_real_)
  for (i in 1:80) { mid <- (lo + hi) / 2; if (f(lo) * f(mid) <= 0) hi <- mid else lo <- mid }
  (lo + hi) / 2
}

.to_native <- function(x) max(0, round(10^x - 1))

propose_thresholds <- function(wake_x,
                               ashman_min = TIDAL_DEFAULTS$ashman_min,
                               pcts = TIDAL_DEFAULTS$fallback_percentiles) {
  x <- wake_x[is.finite(wake_x)]
  if (length(x) < 30) return(list(ok = FALSE, reason = "too few wake samples"))
  g1 <- fit_gmm_1d(x, 1); g2 <- fit_gmm_1d(x, 2)
  ash <- ashman_d(g2)
  bimodal <- !is.null(g2) && !is.null(g1) && g2$bic < g1$bic && is.finite(ash) && ash > ashman_min
  if (bimodal) {
    lower_log <- g2$means[1] + 0.5 * g2$sigmas[1]
    upper_log <- density_crossing(g2)
    method <- "GMM dual-state (bimodal)"
    if (!is.finite(upper_log) || upper_log <= lower_log) {
      lower_log <- unname(stats::quantile(x, pcts[1] / 100, type = 7))
      upper_log <- unname(stats::quantile(x, pcts[2] / 100, type = 7))
      method <- "percentile fallback (degenerate density crossing)"
    }
  } else {
    lower_log <- unname(stats::quantile(x, pcts[1] / 100, type = 7))
    upper_log <- unname(stats::quantile(x, pcts[2] / 100, type = 7))
    method <- "percentile fallback (unimodal distribution)"
  }
  lower <- .to_native(lower_log); upper <- .to_native(upper_log)
  if (upper <= lower) upper <- lower + 1
  list(ok = TRUE, method = method, bimodal = bimodal, lower = lower, upper = upper,
       lower_log = lower_log, upper_log = upper_log, ashman = ash, gmm1 = g1, gmm2 = g2, n_wake = length(x))
}

## ------------------------------------------------------------ etapa 4 -------

zone_stats <- function(values, lower, upper, day_keys = NULL) {
  fin <- is.finite(values); v <- values[fin]
  z <- ifelse(v < lower, -1L, ifelse(v > upper, 1L, 0L))
  trans <- if (length(z) > 1) sum(diff(z) != 0) else 0L
  nd <- if (is.null(day_keys)) 1L else max(1L, length(unique(day_keys[fin])))
  list(n = length(v),
       pct_below = 100 * mean(z == -1), pct_within = 100 * mean(z == 0), pct_above = 100 * mean(z == 1),
       transitions = trans, transitions_per_day = round(trans / nd, 2), n_days = nd)
}

## Simulação na resolução de 10 min — LIMITAÇÃO DECLARADA: o controlador real
## dispara com >1,2 s acima do limiar e rampa em ~2,5/5 min (Stanslaski 2024);
## aqui cada amostra de 10 min vale um passo. Limites de corrente = entrada do
## clínico (decisão de segurança não automatizada).
simulate_dual_threshold <- function(values, lower, upper, i_min = NA, i_max = NA,
                                    step = TIDAL_DEFAULTS$step_pc, day_keys = NULL) {
  zonas <- zone_stats(values, lower, upper, day_keys)
  if (!is.finite(i_min) || !is.finite(i_max) || i_max <= i_min)
    return(c(list(ok = TRUE, has_current = FALSE), zonas))
  I <- round((i_min + i_max) / 2, 4); sat_low <- 0L; sat_high <- 0L; n <- 0L
  for (v in values) {
    if (!is.finite(v)) next
    n <- n + 1L
    if (v > upper) I <- min(i_max, round(I + step, 4))
    else if (v < lower) I <- max(i_min, round(I - step, 4))
    if (I <= i_min + 1e-9) sat_low <- sat_low + 1L
    else if (I >= i_max - 1e-9) sat_high <- sat_high + 1L
  }
  c(list(ok = TRUE, has_current = TRUE,
         pct_saturated = 100 * (sat_low + sat_high) / max(1L, n)), zonas)
}

auto_tune <- function(values, lower0, upper0, i_min = NA, i_max = NA,
                      step = TIDAL_DEFAULTS$step_pc, day_keys = NULL,
                      span_pct = TIDAL_DEFAULTS$autotune_span_pct,
                      step_pct = TIDAL_DEFAULTS$autotune_step_pct) {
  alvo <- TIDAL_DEFAULTS$targets
  custo <- function(m) abs(m$pct_below - alvo["below"]) + abs(m$pct_within - alvo["within"]) +
    abs(m$pct_above - alvo["above"]) + if (!is.null(m$pct_saturated)) 0.5 * m$pct_saturated else 0
  m0 <- simulate_dual_threshold(values, lower0, upper0, i_min, i_max, step, day_keys)
  best <- list(lower = lower0, upper = upper0, cost = unname(custo(m0)))
  base_cost <- best$cost
  for (fl in seq(1 - span_pct / 100, 1 + span_pct / 100, by = step_pct / 100))
    for (fu in seq(1 - span_pct / 100, 1 + span_pct / 100, by = step_pct / 100)) {
      lo <- round(lower0 * fl); hi <- round(upper0 * fu)
      if (hi <= lo) next
      m <- simulate_dual_threshold(values, lo, hi, i_min, i_max, step, day_keys)
      cc <- unname(custo(m))
      if (cc < best$cost - 1e-9) best <- list(lower = lo, upper = hi, cost = cc)
    }
  c(best, list(base_cost = base_cost, improved = best$cost < base_cost - 1e-9))
}

## --------------------------------------------------- pipeline completo ------

tidal_pipeline <- function(t_utc, lfp, off_min = 0, i_min = NA, i_max = NA,
                           step = TIDAL_DEFAULTS$step_pc, p = TIDAL_DEFAULTS) {
  ord <- order(t_utc); t_utc <- t_utc[ord]; lfp <- lfp[ord]
  t_loc <- t_utc + off_min * 60
  hours <- (as.numeric(t_loc) %% 86400) / 3600
  day_key <- format(as.POSIXct(as.numeric(t_loc), origin = "1970-01-01", tz = "UTC"), "%Y-%m-%d")
  x0 <- ifelse(is.finite(lfp) & lfp >= 0, log10(lfp + 1), NA_real_)
  ham <- hampel_filter(x0, p$hampel_window, p$hampel_k)
  dias <- audit_days(day_key, x0, ham$artifact, p$min_valid_day_frac, p$max_rejected_day_frac)
  if (length(dias$used) < p$min_days)
    return(list(ok = FALSE, reason = sprintf(
      "%d usable day(s) — ADAPT-START recommends >=3-5 days [doi:10.1038/s41531-026-01269-z]", length(dias$used)),
      days = dias))
  keep <- is.finite(ham$x) & day_key %in% dias$used
  wake <- detect_wake_window(hours[keep], ham$x[keep], p$cosinor_r2_floor, p$fallback_wake)
  wk <- keep & in_wake(hours, wake$wake)
  prop <- propose_thresholds(ham$x[wk], p$ashman_min, p$fallback_percentiles)
  if (!isTRUE(prop$ok)) return(list(ok = FALSE, reason = prop$reason, days = dias, wake = wake))
  sim <- simulate_dual_threshold(lfp[wk], prop$lower, prop$upper, i_min, i_max, step, day_key[wk])
  list(ok = TRUE, days = dias, wake = wake, proposal = prop, sim = sim,
       n_artifacts = ham$n_rejected, wake_lfp = lfp[wk], wake_x = ham$x[wk], wake_day = day_key[wk])
}

tidal_csv_row <- function(hemi, res) {
  p <- res$proposal; g <- p$gmm2; s <- res$sim
  data.frame(
    hemisphere = hemi, method = p$method,
    lower_threshold_lfp = p$lower, upper_threshold_lfp = p$upper,
    mu1_log = if (!is.null(g)) round(g$means[1], 5) else NA,
    sigma1_log = if (!is.null(g)) round(g$sigmas[1], 5) else NA,
    mu2_log = if (!is.null(g)) round(g$means[2], 5) else NA,
    sigma2_log = if (!is.null(g)) round(g$sigmas[2], 5) else NA,
    ashman_d = round(p$ashman, 3),
    bic_k1 = round(p$gmm1$bic, 2), bic_k2 = if (!is.null(g)) round(g$bic, 2) else NA,
    pct_below = round(s$pct_below, 2), pct_within = round(s$pct_within, 2), pct_above = round(s$pct_above, 2),
    transitions_per_day = s$transitions_per_day,
    days_used = length(res$days$used), days_excluded = nrow(res$days$excluded),
    wake_window = sprintf("%04.1f-%04.1f", res$wake$wake[1], res$wake$wake[2]),
    stringsAsFactors = FALSE
  )
}

## -------------------------------------------------- entrada JSON / CSV ------

tidal_read_timeline <- function(path) {
  if (grepl("\\.csv$", path, ignore.case = TRUE)) {
    d <- utils::read.csv(path, stringsAsFactors = FALSE)
    if (!"hemisphere" %in% names(d)) d$hemisphere <- "Synthetic"
    return(d[, c("hemisphere", "t", "lfp")])
  }
  .tidal_dep("jsonlite")
  j <- jsonlite::fromJSON(path, simplifyVector = FALSE)
  tl <- j$DiagnosticData$LFPTrendLogs
  if (is.null(tl)) stop("No DiagnosticData.LFPTrendLogs in this JSON.")
  linhas <- list()
  for (hk in names(tl)) {
    hemi <- sub(".*[._]", "", hk)
    for (dia in names(tl[[hk]])) for (r in tl[[hk]][[dia]]) {
      lfp <- suppressWarnings(as.numeric(r$LFP))
      ## censura documentada do aparelho: valor negativo = amostra censurada
      if (is.finite(lfp) && lfp < 0) lfp <- NA_real_
      linhas[[length(linhas) + 1]] <- data.frame(
        hemisphere = hemi,
        t = as.numeric(as.POSIXct(gsub("Z$", "", r$DateTime), tz = "UTC", format = "%Y-%m-%dT%H:%M:%S")),
        lfp = lfp, stringsAsFactors = FALSE)
    }
  }
  do.call(rbind, linhas)
}

## ------------------------------------------- gerador sintético espelho ------

## LCG minstd + Box-Muller SEM cache, na mesma ordem de consumo do app:
## por amostra, 2 uniformes para a normal e 1 para a decisão de outlier.
## 48271 * (2^31 - 2) < 2^53, então a aritmética é exata em dupla precisão e a
## sequência é bit a bit idêntica à do JavaScript.
tidal_rng <- function(seed = 42) {
  s <- seed %% 2147483647; if (s <= 0) s <- s + 2147483646
  nxt <- function() { s <<- (s * 48271) %% 2147483647; s / 2147483647 }
  gauss <- function() sqrt(-2 * log(nxt())) * cos(2 * pi * nxt())
  list(nxt = nxt, gauss = gauss)
}

tidal_synthetic <- function(days = 7, seed = 42) {
  o <- list(sleep_mu = 1.10, sleep_sd = 0.05, low_mu = 1.45, low_sd = 0.06,
            high_mu = 1.75, high_sd = 0.07, wake_start = 8, wake_end = 23,
            outlier_p = 0.01, outlier_shift = 1.0)
  rng <- tidal_rng(seed)
  t0 <- 1736121600                                    # 2025-01-06T00:00Z, fixo
  n <- days * 144
  t <- numeric(n); lfp <- numeric(n); i <- 0L
  for (d in 0:(days - 1)) for (b in 0:143) {
    i <- i + 1L
    h <- b / 6
    z <- rng$gauss(); uo <- rng$nxt()
    x <- if (h >= o$wake_start && h < o$wake_end) {
      cyc <- (h - o$wake_start) %% 4
      if (cyc < 2) o$low_mu + o$low_sd * z else o$high_mu + o$high_sd * z
    } else o$sleep_mu + o$sleep_sd * z
    if (uo < o$outlier_p) x <- x + o$outlier_shift
    t[i] <- t0 + (d * 144 + b) * 600
    lfp[i] <- 10^x - 1
  }
  g_true <- list(k = 2L, weights = c(.5, .5), means = c(o$low_mu, o$high_mu), sigmas = c(o$low_sd, o$high_sd))
  list(t = t, lfp = lfp,
       truth = list(lower = .to_native(o$low_mu + 0.5 * o$low_sd),
                    upper = .to_native(density_crossing(g_true))))
}

tidal_selftest <- function() {
  syn <- tidal_synthetic()
  res <- tidal_pipeline(syn$t, syn$lfp, off_min = 0, i_min = 0, i_max = 5, step = 0.1)
  stopifnot(isTRUE(res$ok))
  err_lower <- 100 * abs(res$proposal$lower - syn$truth$lower) / syn$truth$lower
  err_upper <- 100 * abs(res$proposal$upper - syn$truth$upper) / syn$truth$upper
  cat(sprintf("TIDAL-DT self-test (R)\n proposed  %d / %d\n truth     %d / %d\n error     %.2f%% / %.2f%%\n",
              res$proposal$lower, res$proposal$upper, syn$truth$lower, syn$truth$upper, err_lower, err_upper))
  cat(sprintf(" wake window %.1f-%.1f h · method: %s\n",
              res$wake$wake[1], res$wake$wake[2], res$proposal$method))
  cat(" acceptance: JS and R proposals must diverge < 2%\n")
  invisible(list(res = res, truth = syn$truth, err = c(lower = err_lower, upper = err_upper),
                 row = tidal_csv_row("Synthetic", res)))
}

## --------------------------------------------------------- execução ---------

tidal_run <- function(path, off_min = -180, i_min = NA, i_max = NA,
                      device = c("PC", "RC"), out_csv = "tidal_dt_thresholds.csv",
                      out_pdf = "tidal_dt_report.pdf") {
  device <- match.arg(device)
  step <- if (device == "RC") TIDAL_DEFAULTS$step_rc else TIDAL_DEFAULTS$step_pc
  d <- tidal_read_timeline(path)
  linhas <- list(); figuras <- list()
  for (hemi in unique(d$hemisphere)) {
    dd <- d[d$hemisphere == hemi, ]
    res <- tidal_pipeline(dd$t, dd$lfp, off_min, i_min, i_max, step)
    if (!isTRUE(res$ok)) { message(sprintf("[%s] %s", hemi, res$reason)); next }
    linhas[[hemi]] <- tidal_csv_row(hemi, res)
    if (requireNamespace("ggplot2", quietly = TRUE)) figuras[[hemi]] <- .tidal_plots(hemi, res)
  }
  if (!length(linhas)) stop("No hemisphere produced a proposal.")
  tab <- do.call(rbind, linhas)[, TIDAL_CSV_COLUMNS]
  utils::write.csv(tab, out_csv, row.names = FALSE)
  print(tab)
  if (length(figuras) && requireNamespace("patchwork", quietly = TRUE)) {
    grDevices::pdf(out_pdf, width = 10, height = 12)
    for (fg in figuras) print(fg)
    grDevices::dev.off()
    message("Report written to ", out_pdf)
  }
  message("CSV written to ", out_csv,
          "\nDecision-support tool. Not a medical device. Clinician review required.")
  invisible(tab)
}

.tidal_plots <- function(hemi, res) {
  .tidal_dep("ggplot2"); g <- ggplot2::ggplot
  df <- data.frame(x = res$wake_x)
  p1 <- g(df, ggplot2::aes(x = x)) +
    ggplot2::geom_histogram(bins = 42, fill = "#1B4A72", alpha = .5) +
    ggplot2::geom_vline(xintercept = log10(res$proposal$lower + 1), colour = "#2C7A4B", linetype = 2) +
    ggplot2::geom_vline(xintercept = log10(res$proposal$upper + 1), colour = "#9C3050", linetype = 2) +
    ggplot2::labs(title = sprintf("%s — wake log-beta · %s", hemi, res$proposal$method),
                  x = "log10(LFP+1)", y = "samples") + ggplot2::theme_minimal()
  ds <- data.frame(i = seq_along(res$wake_lfp), lfp = res$wake_lfp)
  p2 <- g(ds, ggplot2::aes(i, lfp)) + ggplot2::geom_line(linewidth = .2, colour = "#0E1A24") +
    ggplot2::geom_hline(yintercept = res$proposal$lower, colour = "#2C7A4B", linetype = 2) +
    ggplot2::geom_hline(yintercept = res$proposal$upper, colour = "#9C3050", linetype = 2) +
    ggplot2::labs(title = "cleaned wake Timeline with thresholds", x = "wake sample", y = "LFP (native)") +
    ggplot2::theme_minimal()
  if (requireNamespace("patchwork", quietly = TRUE)) p1 / p2 else p1
}

## Linha de comando:  Rscript R/tidal_dt.R --selftest
##                    Rscript R/tidal_dt.R caminho/arquivo.json
if (sys.nframe() == 0 && !interactive()) {
  args <- commandArgs(trailingOnly = TRUE)
  if (length(args) && args[1] == "--selftest") tidal_selftest()
  else if (length(args)) tidal_run(args[1])
}
