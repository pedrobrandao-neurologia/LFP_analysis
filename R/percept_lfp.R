## =============================================================================
##  percept_lfp.R — leitura, análise estatística e figuras de LFP do Percept PC
##  Medtronic Percept PC / RC · Session Report JSON
##
##  Uso mínimo:
##      source("percept_lfp.R")
##      p  <- percept_read("Report_Json_Session_Report_20250105T161809.json")
##      tr <- percept_trend(p)                       # BrainSense Timeline
##      res <- pipeline_circadiano(tr, hemi = "Right")
##      print(res$tabela); res$figuras$heatmap
##
##  Pipeline completo (todos os arquivos de uma pasta, um paciente por vez):
##      out <- percept_relatorio("pasta/com/jsons", saida = "resultados")
##
##  Dependências obrigatórias: jsonlite, ggplot2
##  Recomendadas (vêm com o R):  nlme, mgcv
##  Opcionais:                    patchwork, scales
## =============================================================================

## ---------------------------------------------------------------- 0. SETUP --

.dep <- function(pkg, obrigatorio = TRUE) {
  ok <- requireNamespace(pkg, quietly = TRUE)
  if (!ok && obrigatorio)
    stop(sprintf("O pacote '%s' é necessário. Instale com install.packages('%s').", pkg, pkg),
         call. = FALSE)
  ok
}
.dep("jsonlite"); .dep("ggplot2")
.TEM_NLME      <- .dep("nlme",      FALSE)
.TEM_MGCV      <- .dep("mgcv",      FALSE)
.TEM_PATCHWORK <- .dep("patchwork", FALSE)

## Paleta consistente com a PWA -------------------------------------------------
PERCEPT_COR <- c(Left = "#1B4A72", Right = "#9C3050",
                 tinta = "#0E1A24", suave = "#5C7284", destaque = "#0C6E6B",
                 alerta = "#A8621B", ok = "#2C7A4B")
PERCEPT_BANDAS <- data.frame(
  banda = c("delta", "theta", "alpha", "beta_baixo", "beta_alto", "gama"),
  rotulo = c("\u03b4", "\u03b8", "\u03b1", "\u03b2\u2193", "\u03b2\u2191", "\u03b3"),
  lo = c(1, 4, 8, 13, 20, 35),
  hi = c(4, 8, 13, 20, 35, 100),
  cor = c("#3B3F73", "#2F6E8E", "#2E8B7A", "#B8912A", "#C4652B", "#8E3B4E"),
  stringsAsFactors = FALSE
)

tema_percept <- function(base_size = 11) {
  ggplot2::theme_minimal(base_size = base_size) +
    ggplot2::theme(
      text            = ggplot2::element_text(colour = PERCEPT_COR[["tinta"]]),
      plot.title      = ggplot2::element_text(face = "bold", size = base_size * 1.05),
      plot.subtitle   = ggplot2::element_text(colour = PERCEPT_COR[["suave"]], size = base_size * .88),
      plot.caption    = ggplot2::element_text(colour = PERCEPT_COR[["suave"]], size = base_size * .78,
                                              hjust = 0),
      panel.grid.minor = ggplot2::element_blank(),
      panel.grid.major = ggplot2::element_line(colour = "#E1E8ED", linewidth = .3),
      panel.border    = ggplot2::element_rect(colour = "#C7D3DC", fill = NA, linewidth = .4),
      axis.text       = ggplot2::element_text(colour = PERCEPT_COR[["suave"]], size = base_size * .82),
      strip.text      = ggplot2::element_text(face = "bold", size = base_size * .85),
      legend.position = "bottom",
      legend.key.height = grid::unit(.35, "cm")
    )
}

## Utilitários -----------------------------------------------------------------
.tail <- function(x) if (is.character(x) && length(x) && grepl("\\.", x[1]))
  sub(".*\\.", "", x) else x
.pluck <- function(l, ..., .default = NULL) {
  ks <- c(...)
  for (k in ks) {
    if (is.null(l) || !is.list(l) || !(k %in% names(l))) return(.default)
    l <- l[[k]]
  }
  if (is.null(l)) .default else l
}
.num <- function(x, .default = NA_real_) {
  if (is.null(x) || length(x) == 0) return(.default)
  suppressWarnings(as.numeric(x[[1]]))
}
.chr <- function(x, .default = NA_character_) {
  if (is.null(x) || length(x) == 0) return(.default)
  as.character(x[[1]])
}
.t_utc <- function(s) as.POSIXct(sub("Z$", "", sub("T", " ", s)), tz = "UTC")

#' Converte offset "-02:00" em segundos
.offset_seg <- function(s) {
  if (is.null(s) || is.na(s) || !nzchar(s)) return(NA_real_)
  m <- regmatches(s, regexec("^([+-])(\\d{2}):(\\d{2})$", s))[[1]]
  if (length(m) != 4) return(NA_real_)
  sinal <- if (m[2] == "-") -1 else 1
  sinal * (as.numeric(m[3]) * 3600 + as.numeric(m[4]) * 60)
}

## ------------------------------------------------------------- 1. LEITURA ---

#' Lê um Session Report JSON do Percept
#' @param arquivo caminho do .json
#' @param pseudonimizar remove nome/ID/número de série do objeto retornado
#' @return lista com metadados e todas as modalidades encontradas
percept_read <- function(arquivo, pseudonimizar = TRUE) {
  j <- jsonlite::fromJSON(arquivo, simplifyVector = FALSE)
  pi_ <- .pluck(j, "PatientInformation", "Final", .default = .pluck(j, "PatientInformation", "Initial"))
  di  <- .pluck(j, "DeviceInformation",  "Final", .default = .pluck(j, "DeviceInformation",  "Initial"))
  off <- .offset_seg(.chr(.pluck(j, "ProgrammerUtcOffset")))

  id_bruto <- paste0(.chr(.pluck(pi_, "PatientId"), ""), "|", .chr(.pluck(pi_, "PatientDateOfBirth"), ""))
  id_hash  <- paste0("sub-", substr(.hash_fnv(id_bruto), 1, 8))

  out <- list(
    arquivo = basename(arquivo),
    meta = list(
      inicio = .chr(.pluck(j, "SessionDate")),
      fim    = .chr(.pluck(j, "SessionEndDate")),
      fuso   = .chr(.pluck(j, "ProgrammerTimezone")),
      offset_seg = off,
      versao_programador = .chr(.pluck(j, "ProgrammerVersion"))
    ),
    paciente = list(
      id       = id_hash,
      sexo     = .tail(.chr(.pluck(pi_, "PatientGender"))),
      diagnostico = .tail(.chr(.pluck(pi_, "Diagnosis")))
    ),
    dispositivo = list(
      modelo   = .chr(.pluck(di, "Neurostimulator")),
      firmware = .chr(.pluck(di, "ProductVersion")),
      implante = .chr(.pluck(di, "ImplantDate")),
      bateria_pct = .num(.pluck(j, "BatteryInformation", "BatteryPercentage")),
      horas_terapia = .num(.pluck(di, "AccumulatedTherapyOnTimeSinceImplant"))
    ),
    bruto = j
  )
  if (!pseudonimizar) {
    out$paciente$nome <- paste(.chr(.pluck(pi_, "PatientFirstName"), ""),
                               .chr(.pluck(pi_, "PatientLastName"), ""))
    out$paciente$nascimento <- .chr(.pluck(pi_, "PatientDateOfBirth"))
  } else {
    ## remove identificadores diretos do objeto bruto mantido em memória
    for (k in c("Initial", "Final")) {
      if (!is.null(out$bruto$PatientInformation[[k]])) {
        out$bruto$PatientInformation[[k]]$PatientFirstName <- NULL
        out$bruto$PatientInformation[[k]]$PatientLastName  <- NULL
        out$bruto$PatientInformation[[k]]$PatientId        <- id_hash
      }
      if (!is.null(out$bruto$DeviceInformation[[k]]))
        out$bruto$DeviceInformation[[k]]$NeurostimulatorSerialNumber <- "REMOVIDO"
    }
  }
  out$disponibilidade <- percept_inventario(out)
  class(out) <- c("percept", "list")
  out
}

.hash_fnv <- function(s) {
  ## FNV-1a de 32 bits em aritmetica de dupla precisao (exata ate 2^53)
  h <- 2166136261
  for (ch in utf8ToInt(s)) {
    h <- bitwXor(as.integer(h %% 65536), ch) + (h %/% 65536) * 65536
    h <- (h * 16777619) %% 4294967296
  }
  paste0(substr(sprintf("%010.0f", h), 3, 10))
}

#' Inventário: quais modalidades existem no arquivo
percept_inventario <- function(p) {
  j <- p$bruto
  n <- function(x) if (is.null(x)) 0L else length(x)
  data.frame(
    modalidade = c("SensingSetup (Signal Test)", "MostRecentInSessionSignalCheck",
                   "LFPMontage (Survey espectros)", "LfpMontageTimeDomain (Survey bruto)",
                   "BrainSenseTimeDomain (streaming bruto)", "BrainSenseLfp (streaming potência)",
                   "LFPTrendLogs (Timeline)", "LfpFrequencySnapshotEvents",
                   "PatientEvents / EventSummary", "Impedance", "EventLogs"),
    n = c(
      length(percept_sensing(p)),
      n(j$MostRecentInSessionSignalCheck),
      n(j$LFPMontage),
      n(j$LfpMontageTimeDomain),
      n(j$BrainSenseTimeDomain),
      n(j$BrainSenseLfp),
      n(.pluck(j, "DiagnosticData", "LFPTrendLogs")),
      n(.pluck(j, "DiagnosticData", "LfpFrequencySnapshotEvents")),
      n(.pluck(j, "PatientEvents", "Final", .default = .pluck(j, "PatientEvents", "Initial"))),
      n(j$Impedance),
      n(.pluck(j, "DiagnosticData", "EventLogs"))
    ),
    stringsAsFactors = FALSE
  )
}

print.percept <- function(x, ...) {
  cat("Percept Session Report:", x$arquivo, "\n")
  cat("  registro   :", x$paciente$id, "|", x$paciente$diagnostico, "\n")
  cat("  dispositivo:", x$dispositivo$modelo, "· fw", x$dispositivo$firmware,
      "· implante", substr(x$dispositivo$implante, 1, 10), "\n")
  cat("  sessão     :", x$meta$inicio, "| fuso", x$meta$fuso, "\n\n")
  d <- x$disponibilidade
  d <- d[d$n > 0, , drop = FALSE]
  if (nrow(d)) {
    cat("  modalidades presentes:\n")
    for (i in seq_len(nrow(d))) cat(sprintf("    %-42s %s\n", d$modalidade[i], d$n[i]))
  } else cat("  nenhuma modalidade de LFP encontrada.\n")
  invisible(x)
}

## ---- 1.1 BrainSense Timeline (LFPTrendLogs) ---------------------------------

#' Extrai o Timeline em data.frame longo, com hora local decimal
#' @param p objeto percept
#' @param offset_seg sobrescreve o offset do arquivo (segundos)
percept_trend <- function(p, offset_seg = NULL) {
  tl <- .pluck(p$bruto, "DiagnosticData", "LFPTrendLogs")
  if (is.null(tl) || !length(tl)) return(NULL)
  off <- if (!is.null(offset_seg)) offset_seg else p$meta$offset_seg
  if (is.na(off)) off <- -3 * 3600
  linhas <- list()
  for (hk in names(tl)) {
    hemi <- .tail(hk)
    for (dia in names(tl[[hk]])) {
      reg <- tl[[hk]][[dia]]
      if (!length(reg)) next
      linhas[[length(linhas) + 1]] <- data.frame(
        hemisferio = hemi,
        t_utc = .t_utc(vapply(reg, function(r) .chr(r$DateTime), character(1))),
        lfp   = vapply(reg, function(r) .num(r$LFP), numeric(1)),
        mA    = vapply(reg, function(r) .num(r$AmplitudeInMilliAmps), numeric(1)),
        stringsAsFactors = FALSE
      )
    }
  }
  if (!length(linhas)) return(NULL)
  d <- do.call(rbind, linhas)
  d <- d[!duplicated(d[, c("hemisferio", "t_utc")]), ]
  d <- d[order(d$hemisferio, d$t_utc), ]
  d$t_local  <- d$t_utc + off
  d$dia      <- as.Date(format(d$t_local, tz = "UTC"))
  d$hora     <- as.numeric(format(d$t_local, "%H", tz = "UTC")) +
                as.numeric(format(d$t_local, "%M", tz = "UTC")) / 60
  d$offset_seg <- off
  d$id <- p$paciente$id
  rownames(d) <- NULL
  attr(d, "offset_seg") <- off
  d
}

## ---- 1.2 Survey / espectros -------------------------------------------------

#' Espectros do BrainSense Survey (LFPMontage): um data.frame longo
percept_montagem <- function(p) {
  m <- p$bruto$LFPMontage
  if (is.null(m) || !length(m)) return(NULL)
  out <- lapply(m, function(r) {
    f <- unlist(r$LFPFrequency); v <- unlist(r$LFPMagnitude)
    if (!length(f)) return(NULL)
    data.frame(
      hemisferio = .tail(.chr(r$Hemisphere)),
      canal      = .tail(.chr(r$SensingElectrodes)),
      artefato   = .tail(.chr(r$ArtifactStatus)),
      pico_Hz    = .num(r$PeakFrequencyInHertz),
      pico_uVp   = .num(r$PeakMagnitudeInMicroVolt),
      frequencia = as.numeric(f),
      magnitude  = as.numeric(v),
      stringsAsFactors = FALSE)
  })
  out <- do.call(rbind, out[!vapply(out, is.null, logical(1))])
  out$canal <- .rotulo_canal(out$canal)
  out
}

.rotulo_canal <- function(x) {
  s <- gsub("_(LEFT|RIGHT)(_RING|_SEGMENT)?$", "", x)
  s <- gsub("_AND_", "-", s); s <- gsub("_", "", s)
  s <- gsub("ZERO", "0", s); s <- gsub("ONE", "1", s)
  s <- gsub("TWO", "2", s);  s <- gsub("THREE", "3", s)
  gsub("([0-3])([ABC])", "\\1\\L\\2", s, perl = TRUE)
}

#' PSDs do canal de sensing configurado (Signal Test dentro de Groups)
percept_sensing <- function(p) {
  gs <- .pluck(p$bruto, "Groups", "Final", .default = .pluck(p$bruto, "Groups", "Initial"))
  if (is.null(gs)) return(list())
  res <- list()
  for (g in gs) {
    scs <- .pluck(g, "ProgramSettings", "SensingChannel")
    if (is.null(scs)) next
    for (sc in scs) {
      cr <- .pluck(sc, "SensingSetup", "ChannelSignalResult")
      if (is.null(cr) || is.null(cr$SignalFrequencies)) next
      res[[length(res) + 1]] <- list(
        hemisferio = .tail(.chr(sc$HemisphereLocation)),
        canal      = .tail(.chr(sc$Channel)),
        f_alvo     = .num(.pluck(sc, "SensingSetup", "FrequencyInHertz")),
        media_ms   = .num(.pluck(sc, "SensingSetup", "AveragingDurationInMilliSeconds")),
        limiar_inf = .num(sc$LowerLfpThreshold),
        limiar_sup = .num(sc$UpperLfpThreshold),
        medido_inf = .num(sc$MeasuredLowerLfp),
        medido_sup = .num(sc$MeasuredUpperLfp),
        artefato   = .tail(.chr(cr$ArtifactStatus)),
        espectro   = data.frame(frequencia = as.numeric(unlist(cr$SignalFrequencies)),
                                magnitude  = as.numeric(unlist(cr$SignalPsdValues)))
      )
    }
  }
  res
}

## ---- 1.3 Domínio do tempo ---------------------------------------------------

#' Séries brutas a 250 Hz (BrainSenseTimeDomain / LfpMontageTimeDomain)
percept_sinal <- function(p, campo = c("BrainSenseTimeDomain", "LfpMontageTimeDomain")) {
  campo <- match.arg(campo)
  arr <- p$bruto[[campo]]
  if (is.null(arr) || !length(arr)) return(list())
  lapply(arr, function(r) {
    x <- as.numeric(unlist(r$TimeDomainData))
    list(canal = .tail(.chr(r$Channel)),
         rotulo = .rotulo_canal(.tail(.chr(r$Channel))),
         fs = .num(r$SampleRateInHz, 250),
         ganho = .num(r$Gain),
         inicio = .chr(r$FirstPacketDateTime),
         x = x, n = length(x), duracao_s = length(x) / .num(r$SampleRateInHz, 250))
  })
}

#' Streaming de potência com estimulação (BrainSenseLfp)
percept_streaming <- function(p) {
  arr <- p$bruto$BrainSenseLfp
  if (is.null(arr) || !length(arr)) return(list())
  lapply(arr, function(r) {
    rows <- r$LfpData
    tick0 <- .num(rows[[1]]$TicksInMs, 0)
    tsec  <- vapply(rows, function(x) (.num(x$TicksInMs) - tick0) / 1000, numeric(1))
    lado <- list()
    for (h in c("Left", "Right")) {
      lfp <- vapply(rows, function(x) .num(.pluck(x, h, "LFP"), 0), numeric(1))
      mA  <- vapply(rows, function(x) .num(.pluck(x, h, "mA"),  0), numeric(1))
      if (any(lfp != 0)) lado[[h]] <- data.frame(t_s = tsec, lfp = lfp, mA = mA)
    }
    ts <- r$TherapySnapshot
    list(canal = .tail(.chr(r$Channel)), fs = .num(r$SampleRateInHz, 2),
         inicio = .chr(r$FirstPacketDateTime), series = lado,
         terapia = lapply(c("Left", "Right"), function(h) {
           z <- ts[[h]]; if (is.null(z)) return(NULL)
           list(hemisferio = h, f_alvo = .num(z$FrequencyInHertz),
                limiar_inf = .num(z$LowerLfpThreshold), limiar_sup = .num(z$UpperLfpThreshold),
                media_ms = .num(z$AveragingDurationInMilliSeconds))
         }))
  })
}

#' Snapshots espectrais disparados por evento do paciente
percept_snapshots <- function(p) {
  ev <- .pluck(p$bruto, "DiagnosticData", "LfpFrequencySnapshotEvents")
  if (is.null(ev) || !length(ev)) return(NULL)
  out <- list()
  off <- if (is.na(p$meta$offset_seg)) -3 * 3600 else p$meta$offset_seg
  for (e in ev) {
    sub <- e$LfpFrequencySnapshotEvents
    if (is.null(sub)) next
    for (hk in names(sub)) {
      h <- sub[[hk]]
      if (is.null(h$FFTBinData)) next
      out[[length(out) + 1]] <- data.frame(
        t_utc   = .t_utc(.chr(e$DateTime)),
        evento  = .chr(e$EventName),
        hemisferio = .tail(hk),
        frequencia = as.numeric(unlist(h$Frequency)),
        magnitude  = as.numeric(unlist(h$FFTBinData)),
        stringsAsFactors = FALSE)
    }
  }
  if (!length(out)) return(NULL)
  d <- do.call(rbind, out)
  d$t_local <- d$t_utc + off
  d
}

#' Impedâncias
percept_impedancia <- function(p) {
  im <- p$bruto$Impedance
  if (is.null(im) || !length(im)) return(NULL)
  h <- im[[1]]$Hemisphere
  if (is.null(h)) return(NULL)
  out <- list()
  for (hh in h) {
    hemi <- .tail(.chr(hh$Hemisphere))
    for (tipo in c("Monopolar", "Bipolar")) {
      lst <- .pluck(hh, "SessionImpedance", tipo)
      if (is.null(lst)) next
      out[[length(out) + 1]] <- data.frame(
        hemisferio = hemi, tipo = tolower(tipo),
        a = sub("^Sen[Ss]ight_?", "", vapply(lst, function(e) .tail(.chr(e$Electrode1)), character(1))),
        b = sub("^Sen[Ss]ight_?", "", vapply(lst, function(e) .tail(.chr(e$Electrode2)), character(1))),
        ohm = vapply(lst, function(e) .num(e$ResultValue), numeric(1)),
        stringsAsFactors = FALSE)
    }
  }
  do.call(rbind, out)
}

## ------------------------------------------------- 2. PRÉ-PROCESSAMENTO -----

#' Remoção robusta de outliers: mediana ± k·MAD
remover_outliers <- function(d, coluna = "lfp", k = 4, por = "hemisferio") {
  f <- function(sub) {
    v <- sub[[coluna]]
    med <- stats::median(v, na.rm = TRUE)
    dmad <- stats::mad(v, na.rm = TRUE)
    if (!is.finite(dmad) || dmad == 0) dmad <- .Machine$double.eps
    sub$outlier <- !is.finite(v) | abs(v - med) > k * dmad
    attr(sub, "mediana") <- med; attr(sub, "mad") <- dmad
    sub
  }
  if (is.null(por) || !(por %in% names(d))) return(f(d))
  partes <- split(d, d[[por]])
  res <- do.call(rbind, lapply(partes, f))
  rownames(res) <- NULL
  res
}

## Escolha de normalização ------------------------------------------------------
#' @param metodo "nenhuma", "log", "z", "pct_mediana_dia", "pct_mediana_global"
normalizar <- function(d, coluna = "lfp", metodo = "pct_mediana_dia") {
  v <- d[[coluna]]
  d$valor <- switch(metodo,
    nenhuma = v,
    log     = log(pmax(v, .Machine$double.eps)),
    z       = as.numeric(scale(v)),
    pct_mediana_global = 100 * v / stats::median(v, na.rm = TRUE),
    pct_mediana_dia = {
      med <- tapply(v, d$dia, stats::median, na.rm = TRUE)
      100 * v / as.numeric(med[as.character(d$dia)])
    },
    stop("método de normalização desconhecido"))
  attr(d, "normalizacao") <- metodo
  d
}

## ------------------------------------------------------------------ 3. DSP --

#' Densidade espectral de potência pelo método de Welch (base R)
welch_psd <- function(x, fs, nperseg = 512, overlap = 0.5, detrend = TRUE) {
  x <- as.numeric(x); x <- x[is.finite(x)]
  nperseg <- min(nperseg, length(x))
  passo <- max(1, floor(nperseg * (1 - overlap)))
  w <- 0.5 - 0.5 * cos(2 * pi * (0:(nperseg - 1)) / (nperseg - 1))
  U <- sum(w^2) * fs
  nb <- nperseg %/% 2 + 1
  inicios <- seq(1, length(x) - nperseg + 1, by = passo)
  acc <- numeric(nb)
  idx <- seq_len(nperseg); idx_c <- idx - mean(idx); sxx <- sum(idx_c^2)
  for (s in inicios) {
    seg <- x[s:(s + nperseg - 1)]
    if (detrend) {
      b <- sum(idx_c * seg) / sxx
      seg <- seg - mean(seg) - b * idx_c
    } else seg <- seg - mean(seg)
    X <- stats::fft(seg * w)[seq_len(nb)]
    pw <- (Mod(X)^2) / U
    if (nb > 2) pw[2:(nb - 1)] <- 2 * pw[2:(nb - 1)]
    acc <- acc + pw
  }
  data.frame(frequencia = (0:(nb - 1)) * fs / nperseg,
             psd = acc / length(inicios))
}

#' Potência integrada numa banda
potencia_banda <- function(f, p, lo, hi) {
  i <- f >= lo & f <= hi
  if (!any(i)) return(NA_real_)
  df <- stats::median(diff(f))
  sum(p[i]) * df
}

#' Tabela de bandas com potência absoluta e relativa
tabela_bandas <- function(f, p, total = c(1, 100)) {
  tot <- potencia_banda(f, p, total[1], total[2])
  b <- PERCEPT_BANDAS
  b$absoluta <- mapply(function(lo, hi) potencia_banda(f, p, lo, hi), b$lo, b$hi)
  b$relativa_pct <- 100 * b$absoluta / tot
  b$pico_Hz <- mapply(function(lo, hi) {
    i <- which(f >= lo & f <= hi)
    if (!length(i)) NA_real_ else f[i[which.max(p[i])]]
  }, b$lo, b$hi)
  b
}

#' Parametrização espectral: separa componente aperiódica (1/f) da periódica.
#' Aproximação do specparam/FOOOF por regressão robusta iterativa em log-log.
ajustar_aperiodico <- function(f, p, fmin = 2, fmax = 95, n_iter = 6) {
  ok <- f >= fmin & f <= fmax & p > 0 & is.finite(p)
  if (sum(ok) < 8) return(NULL)
  lf <- log10(f[ok]); lp <- log10(p[ok])
  manter <- rep(TRUE, length(lf))
  cf <- c(0, 0)
  for (i in seq_len(n_iter)) {
    fit <- stats::lm(lp[manter] ~ lf[manter])
    cf <- stats::coef(fit)
    res <- lp - (cf[1] + cf[2] * lf)
    s <- stats::sd(res[manter]); if (!is.finite(s) || s == 0) break
    novo <- res < 1.0 * s
    if (identical(novo, manter)) break
    manter <- novo
  }
  modelo <- 10^(cf[1] + cf[2] * lf)
  periodico <- p[ok] - modelo
  ss <- sum((lp - (cf[1] + cf[2] * lf))^2)
  st <- sum((lp - mean(lp))^2)
  list(offset = unname(cf[1]), expoente = unname(-cf[2]),
       r2 = 1 - ss / st,
       dados = data.frame(frequencia = f[ok], observado = p[ok],
                          aperiodico = modelo, periodico = periodico))
}

#' Filtro passa-banda de fase zero implementado por FFT
filtro_passa_banda <- function(x, fs, lo, hi) {
  n <- length(x)
  N <- 2^ceiling(log2(n))
  xx <- c(as.numeric(x), rep(0, N - n))
  X <- stats::fft(xx)
  f <- (0:(N - 1)) * fs / N
  f[f > fs / 2] <- fs - f[f > fs / 2]
  X[f < lo | f > hi] <- 0
  Re(stats::fft(X, inverse = TRUE) / N)[seq_len(n)]
}

#' Envelope pela transformada de Hilbert
envelope_hilbert <- function(x) {
  n <- length(x)
  N <- 2^ceiling(log2(n))
  xx <- c(as.numeric(x), rep(0, N - n))
  X <- stats::fft(xx)
  H <- rep(0, N); H[1] <- 1
  if (N %% 2 == 0) { H[2:(N/2)] <- 2; H[N/2 + 1] <- 1 } else H[2:((N + 1)/2)] <- 2
  Mod(stats::fft(X * H, inverse = TRUE) / N)[seq_len(n)]
}

#' Detecção de bursts sobre o envelope
#' @param percentil limiar sobre a distribuição do envelope (75 é o padrão da literatura)
#' @param dur_min_ms exclui flutuações curtas de ruído (100 ms é o padrão)
detectar_bursts <- function(env, fs, percentil = 75, dur_min_ms = 100) {
  thr <- stats::quantile(env, percentil / 100, na.rm = TRUE, names = FALSE)
  acima <- env > thr
  d <- diff(c(FALSE, acima, FALSE))
  ini <- which(d == 1); fim <- which(d == -1) - 1
  dur_ms <- (fim - ini + 1) * 1000 / fs
  keep <- dur_ms >= dur_min_ms
  ini <- ini[keep]; fim <- fim[keep]; dur_ms <- dur_ms[keep]
  amp <- if (length(ini)) mapply(function(a, b) mean(env[a:b]), ini, fim) else numeric(0)
  total_s <- length(env) / fs
  faixas <- cut(dur_ms, breaks = c(0, 200, 350, 500, 650, 800, Inf),
                labels = c("<200", "200-350", "350-500", "500-650", "650-800", ">800"),
                right = FALSE)
  list(
    limiar = thr,
    bursts = data.frame(inicio_s = (ini - 1) / fs, fim_s = fim / fs,
                        duracao_ms = dur_ms, amplitude = amp),
    n = length(ini),
    taxa_por_s = length(ini) / total_s,
    duracao_mediana_ms = if (length(dur_ms)) stats::median(dur_ms) else NA_real_,
    duracao_media_ms   = if (length(dur_ms)) mean(dur_ms) else NA_real_,
    probabilidade = sum(dur_ms) / 1000 / total_s,
    histograma = as.data.frame(table(faixa = faixas), stringsAsFactors = FALSE)
  )
}

#' Curva de sensibilidade ao limiar (mostra por que o percentil deve ser pré-registrado)
curva_limiar <- function(env, fs, percentis = seq(55, 90, by = 5), dur_min_ms = 100) {
  data.frame(percentil = percentis,
             duracao_media_ms = vapply(percentis, function(q)
               detectar_bursts(env, fs, q, dur_min_ms)$duracao_media_ms, numeric(1)),
             n = vapply(percentis, function(q)
               detectar_bursts(env, fs, q, dur_min_ms)$n, numeric(1)))
}

#' Remoção do artefato cardíaco por subtração de template do QRS
remover_ecg <- function(x, fs) {
  bp  <- filtro_passa_banda(x, fs, 5, 30)
  env <- envelope_hilbert(bp)
  thr <- stats::quantile(env, .98, names = FALSE)
  cand <- which(env > thr)
  if (!length(cand)) return(list(limpo = x, n_batimentos = 0, bpm = NA_real_, aplicado = FALSE))
  refr <- round(0.4 * fs); picos <- cand[1]
  for (i in cand[-1]) if (i - picos[length(picos)] > refr) picos <- c(picos, i)
  half <- round(0.25 * fs)
  picos <- picos[picos - half >= 1 & picos + half <= length(x)]
  if (length(picos) < 8) return(list(limpo = x, n_batimentos = length(picos), bpm = NA_real_, aplicado = FALSE))
  M <- vapply(picos, function(p) x[(p - half):(p + half)], numeric(2 * half + 1))
  tpl <- rowMeans(M); tpl <- tpl - mean(tpl)
  y <- x
  for (p in picos) y[(p - half):(p + half)] <- y[(p - half):(p + half)] - tpl
  rr <- diff(picos) / fs
  list(limpo = y, n_batimentos = length(picos),
       bpm = 60 / stats::median(rr), template = tpl, picos = picos, aplicado = TRUE)
}

## ---------------------------------------------------------- 4. ESTATÍSTICA --

#' Cosinor por mínimos quadrados, com harmônicos opcionais.
#' Devolve MESOR, amplitude e acrofase (hora do pico) para cada período.
#' @param periodos vetor de períodos em horas (24 e, opcionalmente, 12)
cosinor <- function(hora, y, periodos = c(24, 12)) {
  ok <- is.finite(hora) & is.finite(y)
  hora <- hora[ok]; y <- y[ok]
  if (length(y) < 2 * length(periodos) + 3) return(NULL)
  X <- data.frame(y = y)
  termos <- character(0)
  for (i in seq_along(periodos)) {
    tau <- periodos[i]
    X[[paste0("cos", i)]] <- cos(2 * pi * hora / tau)
    X[[paste0("sin", i)]] <- sin(2 * pi * hora / tau)
    termos <- c(termos, paste0("cos", i), paste0("sin", i))
  }
  fml <- stats::as.formula(paste("y ~", paste(termos, collapse = " + ")))
  fit <- stats::lm(fml, data = X)
  cf  <- stats::coef(fit); sm <- summary(fit)
  comp <- do.call(rbind, lapply(seq_along(periodos), function(i) {
    b <- unname(cf[paste0("cos", i)]); g <- unname(cf[paste0("sin", i)])
    acro_rad <- atan2(-g, b)
    if (acro_rad > 0) acro_rad <- acro_rad - 2 * pi
    ## ATENÇÃO: em R, %% tem precedência maior que *. Os parênteses são obrigatórios.
    acro_h <- (((-acro_rad) / (2 * pi)) * periodos[i]) %% periodos[i]
    data.frame(periodo_h = periodos[i], amplitude = sqrt(b^2 + g^2),
               acrofase_h = acro_h, beta = b, gama = g)
  }))
  ## autocorrelação AR(1) dos resíduos e n efetivo
  r <- stats::residuals(fit)
  rho <- if (length(r) > 2) sum(r[-1] * r[-length(r)]) / sum(r^2) else 0
  n_eff <- length(r) * (1 - rho) / (1 + rho)
  fstat <- sm$fstatistic
  p_bruto <- stats::pf(fstat[1], fstat[2], fstat[3], lower.tail = FALSE)
  p_ajust <- stats::pf(fstat[1] * max(0.02, n_eff / length(r)), fstat[2],
                       max(2, round(n_eff) - length(cf)), lower.tail = FALSE)
  list(modelo = fit, mesor = unname(cf[1]), componentes = comp,
       r2 = sm$r.squared, F = unname(fstat[1]),
       p = unname(p_bruto), rho_ar1 = rho, n = length(y), n_efetivo = n_eff,
       p_ajustado_ar1 = unname(p_ajust),
       predizer = function(h) {
         v <- cf[1]
         for (i in seq_along(periodos))
           v <- v + cf[paste0("cos", i)] * cos(2 * pi * h / periodos[i]) +
                    cf[paste0("sin", i)] * sin(2 * pi * h / periodos[i])
         unname(v)
       })
}

#' Cosinor de efeitos mistos com estrutura AR(1) — modelo recomendado
#' para dados de Timeline (medidas a cada 10 min, fortemente autocorrelacionadas).
#' Random intercept por dia; para vários pacientes, use `agrupar = "id"`.
cosinor_misto <- function(d, valor = "valor", agrupar = "dia", periodos = c(24, 12),
                          ar1 = TRUE) {
  if (!.TEM_NLME) {
    warning("Pacote 'nlme' indisponível: retornando cosinor de efeitos fixos.")
    return(cosinor(d$hora, d[[valor]], periodos))
  }
  dd <- d[is.finite(d$hora) & is.finite(d[[valor]]), , drop = FALSE]
  dd$.y <- dd[[valor]]
  dd$.g <- factor(dd[[agrupar]])
  termos <- character(0)
  for (i in seq_along(periodos)) {
    dd[[paste0("cos", i)]] <- cos(2 * pi * dd$hora / periodos[i])
    dd[[paste0("sin", i)]] <- sin(2 * pi * dd$hora / periodos[i])
    termos <- c(termos, paste0("cos", i), paste0("sin", i))
  }
  dd <- dd[order(dd$.g, dd$hora), ]
  dd$.idx <- stats::ave(seq_len(nrow(dd)), dd$.g, FUN = seq_along)
  fml <- stats::as.formula(paste(".y ~", paste(termos, collapse = " + ")))
  corr <- if (ar1) nlme::corAR1(form = ~ .idx | .g) else NULL
  fit <- try(nlme::lme(fml, random = ~ 1 | .g, data = dd,
                       correlation = corr, method = "REML",
                       control = nlme::lmeControl(opt = "optim", msMaxIter = 200)),
             silent = TRUE)
  if (inherits(fit, "try-error")) {
    warning("lme não convergiu; tentando sem estrutura AR(1).")
    fit <- try(nlme::lme(fml, random = ~ 1 | .g, data = dd, method = "REML"), silent = TRUE)
    if (inherits(fit, "try-error")) return(NULL)
  }
  cf <- nlme::fixef(fit)
  comp <- do.call(rbind, lapply(seq_along(periodos), function(i) {
    b <- unname(cf[paste0("cos", i)]); g <- unname(cf[paste0("sin", i)])
    acro_rad <- atan2(-g, b); if (acro_rad > 0) acro_rad <- acro_rad - 2 * pi
    acro_h <- (((-acro_rad) / (2 * pi)) * periodos[i]) %% periodos[i]
    data.frame(periodo_h = periodos[i], amplitude = sqrt(b^2 + g^2), acrofase_h = acro_h)
  }))
  tt <- summary(fit)$tTable
  list(modelo = fit, mesor = unname(cf[1]), componentes = comp,
       tabela_efeitos = tt,
       phi_ar1 = tryCatch(unname(stats::coef(fit$modelStruct$corStruct, unconstrained = FALSE)),
                          error = function(e) NA_real_),
       n = nrow(dd), n_grupos = nlevels(dd$.g))
}

#' Intervalos de confiança por bootstrap de blocos (reamostra DIAS inteiros,
#' preservando a autocorrelação intradiária).
cosinor_bootstrap <- function(d, valor = "valor", periodos = 24, n_boot = 500, semente = 1) {
  set.seed(semente)
  dias <- unique(d$dia)
  if (length(dias) < 3) return(NULL)
  M <- matrix(NA_real_, n_boot, 3,
              dimnames = list(NULL, c("mesor", "amplitude", "acrofase_h")))
  for (b in seq_len(n_boot)) {
    sel <- sample(dias, length(dias), replace = TRUE)
    sub <- do.call(rbind, lapply(sel, function(dd) d[d$dia == dd, , drop = FALSE]))
    cs <- cosinor(sub$hora, sub[[valor]], periodos)
    if (is.null(cs)) next
    M[b, ] <- c(cs$mesor, cs$componentes$amplitude[1], cs$componentes$acrofase_h[1])
  }
  M <- M[stats::complete.cases(M), , drop = FALSE]
  ic <- function(v) stats::quantile(v, c(.025, .975), names = FALSE)
  list(n_boot = nrow(M), n_dias = length(dias),
       mesor_ic = ic(M[, "mesor"]), amplitude_ic = ic(M[, "amplitude"]),
       acrofase_ic = .ic_circular(M[, "acrofase_h"]), amostras = M)
}

.ic_circular <- function(horas, periodo = 24) {
  a <- 2 * pi * horas / periodo
  mu <- atan2(mean(sin(a)), mean(cos(a)))
  dv <- a - mu
  dv <- ((dv + pi) %% (2 * pi)) - pi
  q <- stats::quantile(dv, c(.025, .975), names = FALSE)
  env <- function(x) ((x / (2 * pi) * periodo) %% periodo)
  c(env(mu + q[1]), env(mu + q[2]))
}

#' Teste de Rayleigh: as acrofases diárias estão concentradas?
teste_rayleigh <- function(horas, periodo = 24) {
  horas <- horas[is.finite(horas)]
  n <- length(horas); if (n < 3) return(NULL)
  a <- 2 * pi * horas / periodo
  Cc <- mean(cos(a)); Ss <- mean(sin(a))
  R <- sqrt(Cc^2 + Ss^2); z <- n * R^2
  p <- exp(sqrt(1 + 4 * n + 4 * (n^2 - z^2)) - (1 + 2 * n))
  mu <- atan2(Ss, Cc); if (mu < 0) mu <- mu + 2 * pi
  list(n = n, R = R, z = z, p = min(1, p), hora_media = mu / (2 * pi) * periodo)
}

#' Variância explicada pela hora do dia (ANOVA de um fator com bins horários)
variancia_por_hora <- function(d, valor = "valor", n_bins = 24) {
  d <- d[is.finite(d[[valor]]), , drop = FALSE]
  g <- cut(d$hora, breaks = seq(0, 24, length.out = n_bins + 1), include.lowest = TRUE)
  fit <- stats::aov(d[[valor]] ~ g)
  s <- summary(fit)[[1]]
  ssb <- s[["Sum Sq"]][1]; ssw <- s[["Sum Sq"]][2]
  list(eta2 = ssb / (ssb + ssw), F = s[["F value"]][1], p = s[["Pr(>F)"]][1],
       df = c(s[["Df"]][1], s[["Df"]][2]), n = nrow(d))
}

#' Modelo aditivo com spline cíclica — ritmo de forma livre (não senoidal)
gamm_circadiano <- function(d, valor = "valor", k = 12) {
  if (!.TEM_MGCV) { warning("Pacote 'mgcv' indisponível."); return(NULL) }
  d$.y <- d[[valor]]; d$.dia <- factor(d$dia)
  fit <- mgcv::gam(.y ~ s(hora, bs = "cc", k = k) + s(.dia, bs = "re"),
                   data = d, knots = list(hora = c(0, 24)), method = "REML")
  list(modelo = fit, resumo = summary(fit),
       dev_expl = summary(fit)$dev.expl, edf = summary(fit)$edf[1])
}

#' Perfil diurno: mediana por bin dentro de cada dia, depois mediana entre dias
perfil_diurno <- function(d, valor = "valor", bin_min = 30) {
  n_bins <- round(24 * 60 / bin_min)
  d$bin <- pmin(n_bins, floor(d$hora * 60 / bin_min) + 1)
  agg <- stats::aggregate(d[[valor]], by = list(dia = d$dia, bin = d$bin),
                          FUN = stats::median, na.rm = TRUE)
  names(agg)[3] <- "valor"
  perfil <- stats::aggregate(valor ~ bin, data = agg, FUN = function(v)
    c(mediana = stats::median(v), q1 = stats::quantile(v, .25, names = FALSE),
      q3 = stats::quantile(v, .75, names = FALSE), n = length(v)))
  out <- data.frame(bin = perfil$bin, as.data.frame(perfil$valor))
  out$hora <- (out$bin - 0.5) * bin_min / 60
  list(matriz = agg, perfil = out, bin_min = bin_min)
}

#' Médias alinhadas a evento (p.ex. tomada de levodopa): janela -60/+180 min
alinhar_evento <- function(trend, tempos_evento, valor = "lfp",
                           pre_min = 60, pos_min = 180, bin_min = 10,
                           normalizar_base = TRUE) {
  offs <- seq(-pre_min, pos_min, by = bin_min)
  ensaios <- list()
  for (te in tempos_evento) {
    dm <- as.numeric(difftime(trend$t_utc, te, units = "mins"))
    i <- dm >= -pre_min - bin_min / 2 & dm <= pos_min + bin_min / 2
    if (!any(i)) next
    b <- round((dm[i] + pre_min) / bin_min) + 1
    v <- rep(NA_real_, length(offs))
    v[b[b >= 1 & b <= length(offs)]] <- trend[[valor]][i][b >= 1 & b <= length(offs)]
    if (sum(is.finite(v)) < 0.4 * length(v)) next
    if (normalizar_base) {
      base <- stats::median(v[offs < 0], na.rm = TRUE)
      if (is.finite(base) && base != 0) v <- 100 * v / base
    }
    ensaios[[length(ensaios) + 1]] <- data.frame(
      ensaio = length(ensaios) + 1, evento = te, offset_min = offs, valor = v)
  }
  if (!length(ensaios)) return(NULL)
  todos <- do.call(rbind, ensaios)
  resumo <- stats::aggregate(valor ~ offset_min, data = todos, FUN = function(v)
    c(mediana = stats::median(v, na.rm = TRUE),
      q1 = stats::quantile(v, .25, na.rm = TRUE, names = FALSE),
      q3 = stats::quantile(v, .75, na.rm = TRUE, names = FALSE)), na.action = stats::na.pass)
  resumo <- data.frame(offset_min = resumo$offset_min, as.data.frame(resumo$valor))
  list(ensaios = todos, resumo = resumo, n_ensaios = length(ensaios),
       pre_min = pre_min, pos_min = pos_min, normalizado = normalizar_base)
}

#' Teste de permutação para diferença de medianas/médias
teste_permutacao <- function(a, b, n_perm = 5000, estat = mean, semente = 1) {
  set.seed(semente)
  a <- a[is.finite(a)]; b <- b[is.finite(b)]
  obs <- abs(estat(a) - estat(b))
  pool <- c(a, b); na <- length(a)
  cnt <- sum(replicate(n_perm, {
    s <- sample(pool)
    abs(estat(s[seq_len(na)]) - estat(s[-seq_len(na)])) >= obs
  }))
  list(observado = obs, p = (cnt + 1) / (n_perm + 1), n_perm = n_perm)
}

#' Proporção de tempo em cada faixa de limiar de aDBS
resumo_limiares <- function(v, limiar_inf, limiar_sup) {
  v <- v[is.finite(v)]
  data.frame(
    n = length(v),
    abaixo_pct = 100 * mean(v < limiar_inf),
    entre_pct  = 100 * mean(v >= limiar_inf & v <= limiar_sup),
    acima_pct  = 100 * mean(v > limiar_sup),
    mediana = stats::median(v),
    q1 = stats::quantile(v, .25, names = FALSE),
    q3 = stats::quantile(v, .75, names = FALSE),
    p10 = stats::quantile(v, .10, names = FALSE),
    p90 = stats::quantile(v, .90, names = FALSE)
  )
}

## ---------------------------------------------------------------- 5. FIGURAS

#' F1 — espectro anotado (linear e log-log)
fig_espectro <- function(f, p, pico_Hz = NULL, f_alvo = NULL, titulo = "Espectro de potência",
                         log_log = FALSE) {
  d <- data.frame(frequencia = f, magnitude = p)
  d <- d[d$frequencia <= if (log_log) max(f) else 60, ]
  faixas <- PERCEPT_BANDAS[PERCEPT_BANDAS$lo < max(d$frequencia), ]
  g <- ggplot2::ggplot(d, ggplot2::aes(frequencia, magnitude))
  if (!log_log)
    g <- g + ggplot2::geom_rect(data = faixas, inherit.aes = FALSE,
      ggplot2::aes(xmin = lo, xmax = pmin(hi, max(d$frequencia)),
                   ymin = -Inf, ymax = Inf, fill = cor), alpha = .10) +
      ggplot2::scale_fill_identity()
  if (!is.null(f_alvo) && is.finite(f_alvo) && !log_log)
    g <- g + ggplot2::annotate("rect", xmin = f_alvo - 2.5, xmax = f_alvo + 2.5,
                               ymin = -Inf, ymax = Inf, fill = PERCEPT_COR[["alerta"]], alpha = .15)
  g <- g + ggplot2::geom_line(linewidth = .55, colour = PERCEPT_COR[["tinta"]])
  if (!is.null(pico_Hz) && is.finite(pico_Hz)) {
    yp <- d$magnitude[which.min(abs(d$frequencia - pico_Hz))]
    g <- g + ggplot2::annotate("point", x = pico_Hz, y = yp,
                               colour = PERCEPT_COR[["Right"]], size = 2) +
             ggplot2::annotate("text", x = pico_Hz, y = yp, hjust = -.2, vjust = -.6,
                               label = sprintf("%.1f Hz", pico_Hz), size = 3,
                               colour = PERCEPT_COR[["Right"]])
  }
  if (log_log) g <- g + ggplot2::scale_x_log10() + ggplot2::scale_y_log10()
  g + ggplot2::labs(title = titulo,
                    subtitle = if (log_log) "escala log-log (lineariza o componente 1/f)" else
                      "escala linear \u00b7 faixas: \u03b4 \u03b8 \u03b1 \u03b2\u2193 \u03b2\u2191 \u03b3",
                    x = "frequ\u00eancia (Hz)", y = "magnitude (\u00b5Vp/\u221aHz)") +
    tema_percept()
}

#' F2 — decomposição periódico/aperiódico
fig_specparam <- function(ap, titulo = "Parametriza\u00e7\u00e3o espectral") {
  d <- ap$dados
  ggplot2::ggplot(d, ggplot2::aes(frequencia)) +
    ggplot2::geom_ribbon(ggplot2::aes(ymin = aperiodico, ymax = pmax(observado, aperiodico)),
                         fill = PERCEPT_COR[["destaque"]], alpha = .22) +
    ggplot2::geom_line(ggplot2::aes(y = observado), linewidth = .55,
                       colour = PERCEPT_COR[["tinta"]]) +
    ggplot2::geom_line(ggplot2::aes(y = aperiodico), linewidth = .55, linetype = "dashed",
                       colour = PERCEPT_COR[["suave"]]) +
    ggplot2::scale_x_log10() + ggplot2::scale_y_log10() +
    ggplot2::labs(title = titulo,
                  subtitle = sprintf("expoente aperi\u00f3dico \u03c7 = %.2f \u00b7 offset = %.2f \u00b7 R\u00b2 = %.3f",
                                     ap$expoente, ap$offset, ap$r2),
                  x = "frequ\u00eancia (Hz)", y = "pot\u00eancia (log)",
                  caption = "\u00c1rea sombreada = componente peri\u00f3dico (oscila\u00e7\u00f5es acima do 1/f).") +
    tema_percept()
}

#' F5 — mapa da montagem: canal × frequência
fig_montagem <- function(mont, hemisferio = "Left", f_max = 60, normalizar_canal = FALSE) {
  d <- mont[mont$hemisferio == hemisferio & mont$frequencia <= f_max, ]
  if (normalizar_canal) {
    mx <- tapply(d$magnitude, d$canal, max, na.rm = TRUE)
    d$magnitude <- d$magnitude / as.numeric(mx[d$canal])
  }
  ordem <- names(sort(tapply(mont$pico_uVp[mont$hemisferio == hemisferio],
                             mont$canal[mont$hemisferio == hemisferio], max, na.rm = TRUE)))
  d$canal <- factor(d$canal, levels = ordem)
  ggplot2::ggplot(d, ggplot2::aes(frequencia, canal, fill = magnitude)) +
    ggplot2::geom_raster(interpolate = TRUE) +
    ggplot2::geom_vline(xintercept = c(13, 30), colour = "white", linetype = "dotted", linewidth = .3) +
    ggplot2::scale_fill_viridis_c(option = "magma",
                                  name = if (normalizar_canal) "norm." else "\u00b5Vp") +
    ggplot2::labs(title = sprintf("Survey \u2014 STN %s", ifelse(hemisferio == "Left", "esquerdo", "direito")),
                  subtitle = "linhas pontilhadas = banda beta (13\u201330 Hz)",
                  x = "frequ\u00eancia (Hz)", y = NULL) +
    tema_percept()
}

#' F6 — espectrograma
fig_espectrograma <- function(x, fs, janela = 256, salto = 64, f_max = 60,
                              titulo = "Espectrograma") {
  n <- length(x)
  inicios <- seq(1, n - janela + 1, by = salto)
  w <- 0.5 - 0.5 * cos(2 * pi * (0:(janela - 1)) / (janela - 1))
  U <- sum(w^2) * fs
  nb <- janela %/% 2 + 1
  fr <- (0:(nb - 1)) * fs / janela
  sel <- which(fr <= f_max)
  M <- vapply(inicios, function(s) {
    seg <- x[s:(s + janela - 1)]; seg <- seg - mean(seg)
    X <- stats::fft(seg * w)[seq_len(nb)]
    (2 * Mod(X)^2 / U)[sel]
  }, numeric(length(sel)))
  d <- expand.grid(frequencia = fr[sel], tempo = (inicios + janela / 2) / fs)
  d$db <- 10 * log10(pmax(as.numeric(M), 1e-12))
  lim <- stats::quantile(d$db, c(.05, .995), names = FALSE)
  ggplot2::ggplot(d, ggplot2::aes(tempo, frequencia, fill = db)) +
    ggplot2::geom_raster(interpolate = TRUE) +
    ggplot2::scale_fill_viridis_c(name = "dB", limits = lim, oob = scales::oob_squish) +
    ggplot2::labs(title = titulo, x = "tempo (s)", y = "frequ\u00eancia (Hz)") +
    tema_percept()
}

#' F8 — série temporal crônica
fig_timeline <- function(d, valor = "lfp", suavizar = 6, mostrar_outliers = FALSE) {
  dd <- if (!mostrar_outliers && "outlier" %in% names(d)) d[!d$outlier, ] else d
  dd <- dd[order(dd$hemisferio, dd$t_local), ]
  dd$y <- dd[[valor]]
  dd$suave <- as.numeric(stats::ave(dd$y, dd$hemisferio, FUN = function(v)
    as.numeric(stats::filter(v, rep(1 / suavizar, suavizar), sides = 2))))
  ggplot2::ggplot(dd, ggplot2::aes(t_local, y, colour = hemisferio)) +
    ggplot2::geom_point(alpha = .16, size = .35) +
    ggplot2::geom_line(ggplot2::aes(y = suave), linewidth = .55, na.rm = TRUE) +
    ggplot2::scale_colour_manual(values = PERCEPT_COR[c("Left", "Right")],
                                 labels = c(Left = "STN esquerdo", Right = "STN direito"),
                                 name = NULL) +
    ggplot2::labs(title = "BrainSense Timeline \u2014 pot\u00eancia cr\u00f4nica",
                  subtitle = sprintf("amostragem a cada 10 min \u00b7 m\u00e9dia m\u00f3vel de %d pontos (%d min)",
                                     suavizar, suavizar * 10),
                  x = "data/hora local", y = "pot\u00eancia LFP (u.a.)") +
    tema_percept()
}

#' F9a — heatmap dia × hora
fig_heatmap_dia_hora <- function(perfil, titulo = "Ritmo circadiano") {
  m <- perfil$matriz
  m$hora <- (m$bin - .5) * perfil$bin_min / 60
  ggplot2::ggplot(m, ggplot2::aes(hora, as.factor(dia), fill = valor)) +
    ggplot2::geom_raster() +
    ggplot2::scale_fill_gradient2(midpoint = stats::median(m$valor, na.rm = TRUE),
                                  low = "#213E6E", mid = "#EEEEEE", high = "#821E28",
                                  name = "% mediana do dia") +
    ggplot2::scale_x_continuous(breaks = seq(0, 24, 3),
                                labels = sprintf("%02dh", seq(0, 24, 3)), expand = c(0, 0)) +
    ggplot2::labs(title = titulo, subtitle = "cada linha \u00e9 um dia, normalizado pela pr\u00f3pria mediana",
                  x = "hora local", y = NULL) +
    tema_percept() +
    ggplot2::theme(axis.text.y = ggplot2::element_text(size = 6))
}

#' F9b — perfil diurno com IQR e ajuste cosinor
fig_perfil_diurno <- function(perfil, cs = NULL, cor = PERCEPT_COR[["Right"]]) {
  d <- perfil$perfil
  g <- ggplot2::ggplot(d, ggplot2::aes(hora)) +
    ggplot2::annotate("rect", xmin = 0, xmax = 6, ymin = -Inf, ymax = Inf,
                      fill = "#1B3A5C", alpha = .06) +
    ggplot2::annotate("rect", xmin = 22, xmax = 24, ymin = -Inf, ymax = Inf,
                      fill = "#1B3A5C", alpha = .06) +
    ggplot2::geom_ribbon(ggplot2::aes(ymin = q1, ymax = q3), fill = cor, alpha = .20) +
    ggplot2::geom_line(ggplot2::aes(y = mediana), colour = cor, linewidth = .8)
  if (!is.null(cs)) {
    h <- seq(0, 24, by = .25)
    g <- g + ggplot2::geom_line(data = data.frame(hora = h, y = cs$predizer(h)),
                                ggplot2::aes(hora, y), linetype = "dashed",
                                colour = PERCEPT_COR[["alerta"]], linewidth = .6)
  }
  g + ggplot2::scale_x_continuous(breaks = seq(0, 24, 4), labels = sprintf("%02dh", seq(0, 24, 4))) +
    ggplot2::labs(title = "Perfil diurno",
                  subtitle = "mediana entre dias \u00b7 faixa = IQR \u00b7 tracejado = ajuste cosinor",
                  x = "hora local", y = "% da mediana do dia") +
    tema_percept()
}

#' F9c — perfil polar (24 h)
fig_polar <- function(perfil, acrofase_h = NULL, cor = PERCEPT_COR[["Right"]]) {
  d <- perfil$perfil
  g <- ggplot2::ggplot(d, ggplot2::aes(hora, mediana)) +
    ggplot2::geom_col(ggplot2::aes(fill = mediana), width = perfil$bin_min / 60 * .9) +
    ggplot2::scale_fill_viridis_c(option = "magma", guide = "none") +
    ggplot2::coord_polar(start = 0) +
    ggplot2::scale_x_continuous(limits = c(0, 24), breaks = seq(0, 21, 3),
                                labels = sprintf("%02dh", seq(0, 21, 3)))
  if (!is.null(acrofase_h) && is.finite(acrofase_h))
    g <- g + ggplot2::geom_vline(xintercept = acrofase_h, colour = cor, linewidth = .8)
  g + ggplot2::labs(title = "Ciclo de 24 h", x = NULL, y = NULL,
                    subtitle = if (!is.null(acrofase_h))
                      sprintf("linha = acrofase (%.1f h)", acrofase_h) else NULL) +
    tema_percept() +
    ggplot2::theme(axis.text.y = ggplot2::element_blank(),
                   panel.border = ggplot2::element_blank())
}

#' F10 — resposta alinhada a evento
fig_alinhado <- function(al, rotulo_evento = "evento", cor = PERCEPT_COR[["Right"]]) {
  ggplot2::ggplot(al$resumo, ggplot2::aes(offset_min)) +
    ggplot2::annotate("rect", xmin = -al$pre_min, xmax = 0, ymin = -Inf, ymax = Inf,
                      fill = PERCEPT_COR[["suave"]], alpha = .08) +
    ggplot2::geom_line(data = al$ensaios,
                       ggplot2::aes(offset_min, valor, group = ensaio),
                       colour = cor, alpha = .28, linewidth = .3, na.rm = TRUE) +
    ggplot2::geom_ribbon(ggplot2::aes(ymin = q1, ymax = q3), fill = cor, alpha = .22) +
    ggplot2::geom_line(ggplot2::aes(y = mediana), linewidth = .9,
                       colour = PERCEPT_COR[["tinta"]]) +
    ggplot2::geom_vline(xintercept = 0, colour = cor, linewidth = .7) +
    { if (al$normalizado) ggplot2::geom_hline(yintercept = 100, linetype = "dotted",
                                              colour = PERCEPT_COR[["suave"]]) } +
    ggplot2::labs(title = sprintf("Resposta alinhada a \u201c%s\u201d", rotulo_evento),
                  subtitle = sprintf("%d ocorr\u00eancias \u00b7 janela \u2212%d/+%d min \u00b7 bins de 10 min",
                                     al$n_ensaios, al$pre_min, al$pos_min),
                  x = "minutos em rela\u00e7\u00e3o ao evento",
                  y = if (al$normalizado) "% da linha de base" else "pot\u00eancia LFP") +
    tema_percept()
}

#' F11 — distribuição com limiares de aDBS
fig_limiares <- function(v, limiar_inf, limiar_sup, cor = PERCEPT_COR[["Right"]]) {
  d <- data.frame(valor = v[is.finite(v)])
  d$faixa <- ifelse(d$valor < limiar_inf, "abaixo",
             ifelse(d$valor > limiar_sup, "acima", "entre"))
  ggplot2::ggplot(d, ggplot2::aes(valor, fill = faixa)) +
    ggplot2::geom_histogram(bins = 44, colour = NA) +
    ggplot2::geom_vline(xintercept = c(limiar_inf, limiar_sup),
                        colour = PERCEPT_COR[["tinta"]], linewidth = .6) +
    ggplot2::scale_fill_manual(values = c(abaixo = "#93A7B5", entre = cor,
                                          acima = PERCEPT_COR[["alerta"]]), name = NULL) +
    ggplot2::labs(title = "Distribui\u00e7\u00e3o da pot\u00eancia e limiares de aDBS",
                  subtitle = "linhas verticais = limiares inferior e superior programados",
                  x = "pot\u00eancia LFP (u.a.)", y = "n de amostras de 10 min") +
    tema_percept()
}

#' F12 — espectros medianos por tipo de evento
fig_snapshots <- function(sn, hemisferio = "Right", f_max = 45) {
  d <- sn[sn$hemisferio == hemisferio & sn$frequencia <= f_max, ]
  ag <- stats::aggregate(magnitude ~ evento + frequencia, data = d, FUN = stats::median)
  n_ev <- stats::aggregate(t_utc ~ evento, data = unique(d[, c("evento", "t_utc")]),
                           FUN = length)
  names(n_ev)[2] <- "n"
  ag <- merge(ag, n_ev, by = "evento")
  ag$rotulo <- sprintf("%s (n=%d)", ag$evento, ag$n)
  ggplot2::ggplot(ag, ggplot2::aes(frequencia, magnitude, colour = rotulo)) +
    ggplot2::geom_line(linewidth = .7) +
    ggplot2::scale_colour_manual(values = unname(c(PERCEPT_COR[["Left"]], PERCEPT_COR[["Right"]],
      PERCEPT_COR[["destaque"]], PERCEPT_COR[["alerta"]], "#5B3E86", PERCEPT_COR[["ok"]])),
      name = NULL) +
    ggplot2::labs(title = sprintf("Espectros por evento \u2014 STN %s",
                                  ifelse(hemisferio == "Left", "esquerdo", "direito")),
                  subtitle = "mediana entre snapshots de cada tipo de evento",
                  x = "frequ\u00eancia (Hz)", y = "magnitude (\u00b5Vp)") +
    tema_percept()
}

## ------------------------------------------------------------ 6. PIPELINES --

#' Pipeline circadiano completo para um hemisfério
#' @return lista com tabela de resultados, modelos e figuras
pipeline_circadiano <- function(trend, hemi = "Right", k_mad = 4, bin_min = 30,
                                normalizacao = "pct_mediana_dia", periodos = c(24, 12),
                                n_boot = 300, usar_misto = TRUE) {
  d <- trend[trend$hemisferio == hemi, , drop = FALSE]
  if (!nrow(d)) stop("Hemisf\u00e9rio sem dados: ", hemi)
  d <- remover_outliers(d, "lfp", k = k_mad, por = NULL)
  n_out <- sum(d$outlier)
  d <- d[!d$outlier, , drop = FALSE]
  d <- normalizar(d, "lfp", normalizacao)

  cs   <- cosinor(d$hora, d$valor, periodos)
  if (is.null(cs)) stop("Dados insuficientes para ajustar o cosinor (n = ", nrow(d), ").")
  vh   <- variancia_por_hora(d, "valor")
  pf   <- perfil_diurno(d, "valor", bin_min)
  boot <- if (length(unique(d$dia)) >= 3) cosinor_bootstrap(d, "valor", 24, n_boot) else NULL
  misto <- if (usar_misto && .TEM_NLME && length(unique(d$dia)) >= 3)
    cosinor_misto(d, "valor", "dia", periodos, ar1 = TRUE) else NULL
  gam <- if (.TEM_MGCV && length(unique(d$dia)) >= 3) gamm_circadiano(d, "valor") else NULL

  ## acrofases diárias -> Rayleigh (hora do máximo em cada dia)
  m <- pf$matriz
  acro_dia <- vapply(split(m, m$dia), function(s)
    (s$bin[which.max(s$valor)] - .5) * bin_min / 60, numeric(1))
  ray <- teste_rayleigh(acro_dia)

  tabela <- data.frame(
    parametro = c("n pontos", "outliers removidos", "dias", "MESOR", "amplitude 24 h",
                  "acrofase 24 h", "R\u00b2 cosinor", "p cosinor", "rho AR(1)",
                  "p ajustado (n efetivo)", "eta\u00b2 hora do dia", "p ANOVA",
                  "Rayleigh R", "p Rayleigh"),
    valor = c(nrow(d), n_out, length(unique(d$dia)),
              round(cs$mesor, 3), round(cs$componentes$amplitude[1], 3),
              round(cs$componentes$acrofase_h[1], 2), round(cs$r2, 4),
              signif(cs$p, 3), round(cs$rho_ar1, 3), signif(cs$p_ajustado_ar1, 3),
              round(vh$eta2, 4), signif(vh$p, 3),
              if (is.null(ray)) NA else round(ray$R, 3),
              if (is.null(ray)) NA else signif(ray$p, 3)),
    stringsAsFactors = FALSE)
  if (!is.null(boot)) tabela <- rbind(tabela, data.frame(
    parametro = c("IC95% MESOR", "IC95% amplitude", "IC95% acrofase (h)"),
    valor = c(sprintf("[%.2f; %.2f]", boot$mesor_ic[1], boot$mesor_ic[2]),
              sprintf("[%.2f; %.2f]", boot$amplitude_ic[1], boot$amplitude_ic[2]),
              sprintf("[%.1f; %.1f]", boot$acrofase_ic[1], boot$acrofase_ic[2])),
    stringsAsFactors = FALSE))

  cor_h <- PERCEPT_COR[[hemi]]
  figuras <- list(
    heatmap = fig_heatmap_dia_hora(pf, sprintf("Ritmo circadiano \u2014 STN %s",
                                               ifelse(hemi == "Left", "esquerdo", "direito"))),
    perfil  = fig_perfil_diurno(pf, cs, cor_h),
    polar   = fig_polar(pf, cs$componentes$acrofase_h[1], cor_h)
  )
  list(dados = d, tabela = tabela, cosinor = cs, cosinor_misto = misto,
       bootstrap = boot, gamm = gam, rayleigh = ray, variancia_hora = vh,
       perfil = pf, figuras = figuras)
}

#' Pipeline do domínio do tempo (bursts, espectro, espectrograma)
pipeline_tempo <- function(sinal, banda = c(13, 20), percentil = 75, dur_min_ms = 100,
                           remover_cardiaco = FALSE) {
  x <- sinal$x; fs <- sinal$fs
  ecg <- NULL
  if (remover_cardiaco) { ecg <- remover_ecg(x, fs); x <- ecg$limpo }
  psd <- welch_psd(x, fs, nperseg = 512)
  ap  <- ajustar_aperiodico(psd$frequencia, psd$psd)
  bp  <- filtro_passa_banda(x, fs, banda[1], banda[2])
  env <- envelope_hilbert(bp)
  bu  <- detectar_bursts(env, fs, percentil, dur_min_ms)
  cl  <- curva_limiar(env, fs, dur_min_ms = dur_min_ms)
  tab <- data.frame(
    parametro = c("dura\u00e7\u00e3o (s)", "n bursts", "taxa (/s)", "dura\u00e7\u00e3o mediana (ms)",
                  "dura\u00e7\u00e3o m\u00e9dia (ms)", "probabilidade de burst (%)",
                  "pot\u00eancia beta 13\u201330", "expoente aperi\u00f3dico"),
    valor = c(round(length(x) / fs, 1), bu$n, round(bu$taxa_por_s, 3),
              round(bu$duracao_mediana_ms, 1), round(bu$duracao_media_ms, 1),
              round(100 * bu$probabilidade, 1),
              signif(potencia_banda(psd$frequencia, psd$psd, 13, 30), 4),
              if (is.null(ap)) NA else round(ap$expoente, 3)),
    stringsAsFactors = FALSE)
  if (!is.null(ecg)) tab <- rbind(tab, data.frame(
    parametro = c("batimentos detectados", "frequ\u00eancia card\u00edaca (bpm)"),
    valor = c(ecg$n_batimentos, round(ecg$bpm, 1)), stringsAsFactors = FALSE))
  list(psd = psd, aperiodico = ap, envelope = env, bursts = bu,
       curva_limiar = cl, ecg = ecg, tabela = tab,
       figuras = list(
         espectro = fig_espectro(psd$frequencia, psd$psd,
                                 pico_Hz = psd$frequencia[which.max(
                                   ifelse(psd$frequencia >= 8 & psd$frequencia <= 35, psd$psd, -Inf))],
                                 titulo = sprintf("PSD de Welch \u2014 %s", sinal$rotulo)),
         specparam = if (!is.null(ap)) fig_specparam(ap) else NULL,
         espectrograma = fig_espectrograma(x, fs,
                          titulo = sprintf("Espectrograma \u2014 %s", sinal$rotulo))))
}

#' Relatório completo de uma pasta com JSONs (um paciente por vez)
#' @param pasta diretório com os Session Reports
#' @param saida diretório para figuras (PNG) e tabelas (CSV); NULL não grava
percept_relatorio <- function(pasta, saida = NULL, hemi = NULL, offset_seg = NULL) {
  arqs <- list.files(pasta, pattern = "\\.json$", full.names = TRUE)
  if (!length(arqs)) stop("Nenhum .json encontrado em ", pasta)
  ps <- lapply(arqs, percept_read)
  ids <- vapply(ps, function(p) p$paciente$id, character(1))
  if (length(unique(ids)) > 1) {
    message("ATEN\u00c7\u00c3O: arquivos de ", length(unique(ids)),
            " registros distintos. Analisando apenas o primeiro: ", ids[1],
            "\n  Registros: ", paste(unique(ids), collapse = ", "))
    ps <- ps[ids == ids[1]]
  }
  for (p in ps) print(p)

  ## Timeline agregado e desduplicado
  trs <- lapply(ps, percept_trend, offset_seg = offset_seg)
  trs <- trs[!vapply(trs, is.null, logical(1))]
  trend <- if (length(trs)) {
    tt <- do.call(rbind, trs)
    tt <- tt[!duplicated(tt[, c("hemisferio", "t_utc")]), ]
    tt[order(tt$hemisferio, tt$t_utc), ]
  } else NULL

  res <- list(arquivos = ps, trend = trend)
  if (!is.null(trend)) {
    hemis <- if (is.null(hemi)) unique(trend$hemisferio) else hemi
    res$circadiano <- stats::setNames(lapply(hemis, function(h)
      try(pipeline_circadiano(trend, h), silent = TRUE)), hemis)
    res$timeline_fig <- fig_timeline(remover_outliers(trend))
  }
  sn <- lapply(ps, percept_snapshots)
  sn <- sn[!vapply(sn, is.null, logical(1))]
  if (length(sn)) res$snapshots <- do.call(rbind, sn)
  mo <- lapply(ps, percept_montagem)
  mo <- mo[!vapply(mo, is.null, logical(1))]
  if (length(mo)) res$montagem <- do.call(rbind, mo)
  sg <- unlist(lapply(ps, percept_sinal), recursive = FALSE)
  if (length(sg)) res$tempo <- try(pipeline_tempo(sg[[1]]), silent = TRUE)

  if (!is.null(saida)) {
    dir.create(saida, showWarnings = FALSE, recursive = TRUE)
    sv <- function(g, nome, w = 8, h = 5) {
      if (is.null(g) || inherits(g, "try-error")) return(invisible())
      ggplot2::ggsave(file.path(saida, paste0(nome, ".png")), g,
                      width = w, height = h, dpi = 300, bg = "white")
    }
    if (!is.null(res$timeline_fig)) sv(res$timeline_fig, "F8_timeline", 10, 4.5)
    for (h in names(res$circadiano %||% list())) {
      r <- res$circadiano[[h]]
      if (inherits(r, "try-error")) next
      sv(r$figuras$heatmap, paste0("F9a_heatmap_", h), 8, 6)
      sv(r$figuras$perfil,  paste0("F9b_perfil_",  h))
      sv(r$figuras$polar,   paste0("F9c_polar_",   h), 5.5, 5.5)
      utils::write.csv(r$tabela, file.path(saida, paste0("F9_estatistica_", h, ".csv")),
                       row.names = FALSE, fileEncoding = "UTF-8")
    }
    if (!is.null(res$montagem))
      for (h in unique(res$montagem$hemisferio)) sv(fig_montagem(res$montagem, h),
                                                    paste0("F5_survey_", h), 8, 5.5)
    if (!is.null(res$snapshots))
      for (h in unique(res$snapshots$hemisferio)) sv(fig_snapshots(res$snapshots, h),
                                                     paste0("F12_eventos_", h))
    if (!is.null(res$tempo) && !inherits(res$tempo, "try-error")) {
      sv(res$tempo$figuras$espectro, "F1_psd_welch")
      sv(res$tempo$figuras$specparam, "F2_specparam")
      sv(res$tempo$figuras$espectrograma, "F6_espectrograma", 10, 4.5)
      utils::write.csv(res$tempo$tabela, file.path(saida, "F6_bursts.csv"),
                       row.names = FALSE, fileEncoding = "UTF-8")
    }
    if (!is.null(trend))
      utils::write.csv(trend, file.path(saida, "timeline.csv"),
                       row.names = FALSE, fileEncoding = "UTF-8")
    message("Resultados gravados em: ", normalizePath(saida))
  }
  invisible(res)
}

`%||%` <- function(a, b) if (is.null(a)) b else a

## =============================================================================
##  NOTAS METODOLÓGICAS
##
##  1. FUSO HORÁRIO. Os timestamps do Percept estão em UTC. Toda análise
##     circadiana exige conversão para hora local (campo ProgrammerUtcOffset).
##     Mudanças de horário de verão e viagens devem ser tratadas como quebra
##     na série, não como continuidade.
##
##  2. AUTOCORRELAÇÃO. Com amostragem a cada 10 min, resíduos consecutivos são
##     fortemente correlacionados (rho tipicamente > 0,95). O p do cosinor de
##     efeitos fixos é anticonservador. Use `cosinor_misto(..., ar1 = TRUE)`
##     como modelo principal e reporte o phi estimado.
##
##  3. ACROFASE É GRANDEZA CIRCULAR. Média aritmética de horários é incorreta.
##     Use `teste_rayleigh()` e `.ic_circular()`.
##
##  4. NORMALIZAÇÃO. O heatmap circadiano exige detrending diário
##     (`normalizar(..., "pct_mediana_dia")`), sob pena de a deriva entre dias
##     mascarar o ritmo.
##
##  5. BURSTS. O percentil do limiar e a duração mínima alteram sistematicamente
##     o resultado — veja `curva_limiar()`. Pré-registre a escolha.
##
##  6. ARTEFATOS. Movimento pode gerar padrão pseudo-diurno. Compare a banda de
##     interesse com uma banda-controle e, quando possível, com actigrafia.
##
##  7. UNIDADES. O valor de LFP do Timeline varia de escala entre versões de
##     firmware (µVp em algumas, contagens brutas em outras). Trate como unidade
##     arbitrária e normalize antes de comparar entre pacientes ou visitas.
## =============================================================================
