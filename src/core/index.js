/* core/index.js — barrel do núcleo.
   Monta o objeto PerceptCore com EXATAMENTE a mesma superfície pública de antes
   do refactor modular (Prompt 0.1), para que app.js e a suíte de testes não mudem.
   Ver docs/arquitetura.md para o mapa de módulos e a regra de dependência. */

import { parsePercept, MODALITIES, prettyChannel, parseUtcOffsetMin, localHour, localDayKey, hashId } from './io/parse.js';
import { parseIntList, unwrapCounter, unwrapTicks, analyzePackets, insertNaNGaps, effectiveFs, stitchStreams } from './io/packets.js';
import { nanStats, segmentsWithoutNan, interpolateForFilter, detrendLinearNaN } from './dsp/nan.js';
import { fft, nextPow2 } from './dsp/fft.js';
import { welchPSD, spectrogram, bandPower, bandTable, bandOf, BANDS } from './dsp/spectral.js';
import { bandpassFFT, hilbertEnvelope } from './dsp/filters.js';
import { detectBursts } from './dsp/bursts.js';
import { fitAperiodic } from './dsp/aperiodic.js';
import { ecgTemplateSubtract, removeEcg, cleanEcg } from './artifact/ecg.js';
import { detectRPeaks } from './artifact/rpeaks.js';
import { svdJacobi, lowRankApprox } from './artifact/svd.js';
import { ecgSuppressionRatio, betaPeakRecovery, bandPowerPreservation, correlation, validateEcgRemoval } from './artifact/validate.js';
import { mean, median, sd, variance, quantile, mad, removeOutliersMAD, linreg, pearson, histogram, ecdf, bimodalityCoefficient } from './stats/descriptive.js';
import { fPValue, tPValue, normCDF } from './stats/distributions.js';
import { cosinor, cosinorBootstrap, rayleigh, varianceByHour, diurnalProfile } from './stats/circadian.js';
import { eventAligned, permutationTest } from './stats/events.js';
import { detectStates, betaEnvelopeSeries, streamOnOff } from './stats/states.js';
import { peakInBand, pickSpectrum, spectralMetrics, burstMetrics, doseResponse, ecgMetrics } from './metrics/acute.js';
import { mergeTrend, collectThresholds, chronicMetrics, thresholdSummary } from './metrics/chronic.js';
import { extractMetrics, daysSince } from './metrics/extract.js';
import { PROFILES, PROFILE_IDS, getProfile, suggestProfile, bandsOf, normalizeSpectrum, detectTremorFrequency, spearman, movingAverageDays } from './profiles/index.js';
import { createProvenance, verifyManifest, sha256Hex, canonical } from './provenance/index.js';
import { generateChecklist, checklistDocx, CHECKLIST_ITEMS } from './report/checklist.js';
import { makeZip, makeDocx, crc32 } from './export/zip.js';

const API = {
  parsePercept, MODALITIES, BANDS, prettyChannel, parseUtcOffsetMin, localHour, localDayKey, hashId,
  fft, nextPow2, welchPSD, spectrogram, bandpassFFT, hilbertEnvelope, detectBursts, fitAperiodic,
  ecgTemplateSubtract, bandPower, bandTable, bandOf,
  mean, median, sd, variance, quantile, mad, removeOutliersMAD, linreg, pearson,
  cosinor, cosinorBootstrap, rayleigh, varianceByHour, diurnalProfile, eventAligned,
  permutationTest, thresholdSummary, histogram, ecdf, fPValue, tPValue, normCDF,
  peakInBand, daysSince, pickSpectrum, spectralMetrics, burstMetrics, doseResponse, ecgMetrics,
  mergeTrend, collectThresholds, chronicMetrics, extractMetrics,
  detectStates, betaEnvelopeSeries, streamOnOff, bimodalityCoefficient,
  /* integridade do sinal bruto (Onda 1 — L01, L02, L05, L07) */
  parseIntList, unwrapCounter, unwrapTicks, analyzePackets, insertNaNGaps, effectiveFs, stitchStreams,
  nanStats, segmentsWithoutNan, interpolateForFilter, detrendLinearNaN,
  /* artefato cardíaco: três métodos + validação quantificada (Onda 2 — L08, L10, L11, L12) */
  detectRPeaks, removeEcg, cleanEcg, svdJacobi, lowRankApprox,
  ecgSuppressionRatio, betaPeakRecovery, bandPowerPreservation, correlation, validateEcgRemoval,
  /* perfis de doença (Onda 5 — L37, L38, L39) */
  PROFILES, PROFILE_IDS, getProfile, suggestProfile, bandsOf, normalizeSpectrum,
  detectTremorFrequency, spearman, movingAverageDays,
  /* proveniência e padrão de reporte (Onda 7.2 — L49, L50) */
  createProvenance, verifyManifest, sha256Hex, canonical,
  generateChecklist, checklistDocx, CHECKLIST_ITEMS,
  makeZip, makeDocx, crc32
};

export default API;
export { API as PerceptCore };
