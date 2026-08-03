/* core/index.js — barrel do núcleo.
   Monta o objeto PerceptCore com EXATAMENTE a mesma superfície pública de antes
   do refactor modular (Prompt 0.1), para que app.js e a suíte de testes não mudem.
   Ver docs/arquitetura.md para o mapa de módulos e a regra de dependência. */

import { parsePercept, parsePerceptText, MODALITIES, prettyChannel, parseUtcOffsetMin, localHour, localDayKey, hashId } from './io/parse.js';
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
import { peakInBand, pickSpectrum, spectralMetrics, burstMetrics, doseResponse, ecgMetrics, deviceStateMetrics, deviceStateMetrics } from './metrics/acute.js';
import { mergeTrend, collectThresholds, chronicMetrics, thresholdSummary } from './metrics/chronic.js';
import { extractMetrics, daysSince } from './metrics/extract.js';
import { rankSurveyChannels } from './metrics/survey.js';
import { PROFILES, PROFILE_IDS, getProfile, suggestProfile, bandsOf, normalizeSpectrum, detectTremorFrequency, spearman, movingAverageDays } from './profiles/index.js';
import { createProvenance, verifyManifest, sha256Hex, canonical } from './provenance/index.js';
import { generateChecklist, checklistDocx, CHECKLIST_ITEMS } from './report/checklist.js';
import { clinicalReadings, qcTrafficLight } from './report/reading.js';
import { makeZip, makeDocx, crc32 } from './export/zip.js';
import { inferDeviceState, statesComparable } from './io/devicestate.js';
import { dstTransitions, detectOffsetBreaks, resolveOffsets, segmentByOffset } from './io/timezone.js';
import { detectRampArtifacts, removeRampArtifact, detectPolyphasic } from './artifact/ramp.js';
import { checkHarmonics } from './qc/harmonics.js';
import { peakReproducibility, screenChronicByEcg } from './qc/reproducibility.js';
import { qcPanel } from './qc/panel.js';
import { notchFFT, suggestLineFrequency } from './dsp/notch.js';
import { dpss, multitaperPSD, compareEstimators, spectralUncertainty } from './dsp/multitaper.js';
import { specparam, specparamCompare } from './dsp/specparam.js';
import { morletCWT, waveletBandEnvelope, waveletBursts, aperiodicBurstThreshold, burstDurationSensitivity } from './dsp/wavelet.js';
import { pacTort, tortMI, comodulogram, waveformAsymmetry, analytic } from './dsp/pac.js';
import { detectGamma, confirmEntrainment } from './dsp/gamma.js';
import { parseExternalCsv, resampleUniform } from './io/external.js';
import { coherence, coherenceBand } from './dsp/coherence.js';
import { alignByCrossCorrelation, alignByStimArtifact, alignByTimestamp, detectStimSteps } from './io/sync.js';
import { clusterPermutation } from './stats/cluster.js';
import { controlBandDiurnal, actogram } from './metrics/control.js';
import { icc } from './stats/icc.js';
import { impedanceDrift, usageAndBattery, longitudinalReliability } from './metrics/longitudinal.js';
import { assessEligibility, PREVALENCIA_BETA } from './adbs/eligibility.js';
import { simulateAdbs, thresholdSweep, suggestThresholds } from './adbs/simulate.js';
import { fitDoseResponse, MODELOS } from './adbs/doseresponse.js';
import { levenbergMarquardt, solveGaussJordan } from './stats/optimize.js';

const API = {
  parsePercept, parsePerceptText, MODALITIES, BANDS, prettyChannel, parseUtcOffsetMin, localHour, localDayKey, hashId,
  fft, nextPow2, welchPSD, spectrogram, bandpassFFT, hilbertEnvelope, detectBursts, fitAperiodic,
  ecgTemplateSubtract, bandPower, bandTable, bandOf,
  mean, median, sd, variance, quantile, mad, removeOutliersMAD, linreg, pearson,
  cosinor, cosinorBootstrap, rayleigh, varianceByHour, diurnalProfile, eventAligned,
  permutationTest, thresholdSummary, histogram, ecdf, fPValue, tPValue, normCDF,
  peakInBand, daysSince, pickSpectrum, spectralMetrics, burstMetrics, doseResponse, ecgMetrics, deviceStateMetrics,
  mergeTrend, collectThresholds, chronicMetrics, extractMetrics,
  /* ranking dos pares bipolares do Survey (F1) */
  rankSurveyChannels,
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
  /* leituras em linguagem clínica e semáforo de QC (Onda 8.1) */
  clinicalReadings, qcTrafficLight,
  makeZip, makeDocx, crc32,
  /* fidelidade e QC (Ondas 1.3 e 2.2 — L03, L04, L06, L13–L17, L19) */
  inferDeviceState, statesComparable,
  dstTransitions, detectOffsetBreaks, resolveOffsets, segmentByOffset,
  detectRampArtifacts, removeRampArtifact, detectPolyphasic,
  checkHarmonics, peakReproducibility, screenChronicByEcg, qcPanel,
  notchFFT, suggestLineFrequency,
  /* aDBS: elegibilidade, simulação e predição (Onda 4.2 — L34, L35, L36) */
  assessEligibility, PREVALENCIA_BETA,
  simulateAdbs, thresholdSweep, suggestThresholds,
  fitDoseResponse, levenbergMarquardt, solveGaussJordan, MODELOS,
  /* DSP avançada (Onda 3 — multitaper, specparam completo, wavelet, PAC, gama) */
  dpss, multitaperPSD, compareEstimators, spectralUncertainty,
  specparam, specparamCompare,
  morletCWT, waveletBandEnvelope, waveletBursts, aperiodicBurstThreshold, burstDurationSensitivity,
  pacTort, tortMI, comodulogram, waveformAsymmetry, analytic,
  detectGamma, confirmEntrainment,
  /* sinais externos, sincronização e coerência (Onda 2.3) */
  parseExternalCsv, resampleUniform, coherence, coherenceBand,
  alignByCrossCorrelation, alignByStimArtifact, alignByTimestamp, detectStimSteps,
  /* actograma, banda-controle e cluster (Onda 4.1) */
  clusterPermutation, controlBandDiurnal, actogram,
  /* confiabilidade longitudinal, impedância e uso (Onda 4.3) */
  icc, impedanceDrift, usageAndBattery, longitudinalReliability
};

export default API;
export { API as PerceptCore };
