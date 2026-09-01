/* core/index.js — barrel do núcleo.
   Monta o objeto PerceptCore com EXATAMENTE a mesma superfície pública de antes
   do refactor modular (Prompt 0.1), para que app.js e a suíte de testes não mudem.
   Ver docs/arquitetura.md para o mapa de módulos e a regra de dependência. */

import { parsePercept, parsePerceptText, salvageJson, MODALITIES, prettyChannel, parseUtcOffsetMin, localHour, localDayKey, hashId, HARDWARE_FILTERS, hardwareFilterDescription, IMPEDANCE_LIMITS, shortThresholdOhms } from './io/parse.js';
import { parseIntList, unwrapCounter, unwrapTicks, analyzePackets, insertNaNGaps, effectiveFs, stitchStreams, sequenceCapForModel, TICKS_ROLLOVER_MS, INTERLEAVED_STREAMS } from './io/packets.js';
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
import { eventAligned, permutationTest, permutationTwoSample } from './stats/events.js';
import { detectStates, betaEnvelopeSeries, streamOnOff } from './stats/states.js';
import { peakInBand, pickSpectrum, spectralMetrics, burstMetrics, doseResponse, ecgMetrics, deviceStateMetrics } from './metrics/acute.js';
import { mergeTrend, collectThresholds, chronicMetrics, thresholdSummary, censoringSummary, splitByLocalDay, dayRangeOf, wakePercentiles } from './metrics/chronic.js';
import { TIDAL } from './metrics/tidal.js';
import { SLEEP } from './metrics/sleep.js';
import { CHRONOTYPE } from './metrics/chronotype.js';
import { STUN } from './metrics/stun.js';
import { PRACTICE } from './adbs/practice.js';
import { MRDS_VERSION, MRDS_PROTOCOL, MRDS_BANDS, MRDS_TOTAL_BAND, MRDS_CELLS, MRDS_LIMITACOES, MRDS_COLUMNS, zscoreEpochs, mrdsEpochPSD, mrdsPair, mrdsBroadbandVerdict, mrdsDesign, mrdsSignFlipTest, mrdsTable, mrdsMeta, mrdsReading } from './metrics/mrds.js';
import { extractMetrics, daysSince } from './metrics/extract.js';
import { rankSurveyChannels } from './metrics/survey.js';
import { cohortSummary, wilsonCI } from './metrics/cohort.js';
import { PROFILES, PROFILE_IDS, getProfile, suggestProfile, bandsOf, normalizeSpectrum, detectTremorFrequency, spearman, movingAverageDays, TARGETS, normalizeTarget, hemisphereTargets, targetProfileCheck } from './profiles/index.js';
import { createProvenance, verifyManifest, sha256Hex, canonical } from './provenance/index.js';
import { generateChecklist, checklistDocx, CHECKLIST_ITEMS } from './report/checklist.js';
import { clinicalReadings, qcTrafficLight, odrReading } from './report/reading.js';
import { makeZip, makeDocx, crc32 } from './export/zip.js';
import { writeEdf } from './export/edf.js';
import { buildPdf, textWidth, unmappedChars } from './export/pdf.js';
import { t, setLanguage, getLanguage, IDIOMAS, translationCoverage } from './i18n/index.js';
import { buildBidsLike } from './export/bids.js';
import { inferDeviceState, statesComparable, documentedStimState, DOCUMENTED_STIM_STATE } from './io/devicestate.js';
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
import { alignByCrossCorrelation, alignByStimArtifact, alignByTimestamp, detectStimSteps, SYNC_PROTOCOL } from './io/sync.js';
import { clusterPermutation } from './stats/cluster.js';
import { fftBluestein, fftAny, dftDireta } from './dsp/bluestein.js';
import {
  hannPeriodic, hammingPeriodic, hannSymmetric, WINDOWS, TF_METHODS,
  spectrogramWelch, spectrogramSTFT, spectrogramPercept, spectrogramWavelet, spectrogramAR,
  levinsonDurbin, normalizeSpectrogram, removeAperiodicTrend, timeFrequency, tfMatrix
} from './dsp/timefreq.js';
import { sensingConfigOf, configBlocks, segmentTrendByConfig, crossBlockWarning, LFP_POWER_UNIT } from './metrics/config.js';
import { PASSPORT_VERSION, biomarkerPassport, passportSensingSuggestion, passportMatchesConfig, passportCompare } from './metrics/passport.js';
import { AGENDA_VERSION, sessionAgenda } from './metrics/agenda.js';
import { windowGrid, spectralVariation, windowedBandPower, windowedCoherence } from './dsp/features.js';
import { ODR_BANDS, ODR_LIMITACOES, ODR_EXPECTATIVA, gammaPeakOf, odrSeries, odrSpectralVariation } from './metrics/odr.js';
import {
  pairableRecords, interSTNCoherence, windowedFeatureTable, windowedFeatureMeta,
  windowedFeatureCsv, WINDOWED_COLUMNS
} from './metrics/windowed.js';
import { artifactAlarm } from './qc/alarm.js';
import { interdailyStability, intradailyVariability, m10l5, actigraphyPanel } from './stats/actigraphy.js';
import { changePoints, changePointsInTime, annotateChangePoints } from './stats/changepoint.js';
import { controlBandDiurnal, actogram } from './metrics/control.js';
import {
  DIARY_STATES, LFP_STATES, stateById, normalizeState, parseDiaryCsv, diaryGrid,
  dailyComposition, compareConditions, circadianStateProfile, timelineGrid,
  doseMarkers, diaryVsLfpAgreement, levodopaResponse
} from './metrics/diary.js';
import { icc } from './stats/icc.js';
import { impedanceDrift, usageAndBattery, longitudinalReliability } from './metrics/longitudinal.js';
import { assessEligibility, PREVALENCIA_BETA } from './adbs/eligibility.js';
import { simulateAdbs, thresholdSweep, suggestThresholds } from './adbs/simulate.js';
import { fitDoseResponse, MODELOS } from './adbs/doseresponse.js';
import { levenbergMarquardt, solveGaussJordan } from './stats/optimize.js';
import {
  LEAD_MODELS, leadSpec, leadsOf, contactsOfChannel, parseContactId,
  leadGeometry, leadSummary, leadSpan, expandContacts
} from './leads/index.js';

const API = {
  parsePercept, parsePerceptText, salvageJson, MODALITIES, BANDS, HARDWARE_FILTERS, hardwareFilterDescription, IMPEDANCE_LIMITS, shortThresholdOhms, prettyChannel, parseUtcOffsetMin, localHour, localDayKey, hashId,
  fft, nextPow2, welchPSD, spectrogram, bandpassFFT, hilbertEnvelope, detectBursts, fitAperiodic,
  ecgTemplateSubtract, bandPower, bandTable, bandOf,
  mean, median, sd, variance, quantile, mad, removeOutliersMAD, linreg, pearson,
  cosinor, cosinorBootstrap, rayleigh, varianceByHour, diurnalProfile, eventAligned,
  permutationTest, permutationTwoSample, thresholdSummary, histogram, ecdf, fPValue, tPValue, normCDF,
  peakInBand, daysSince, pickSpectrum, spectralMetrics, burstMetrics, doseResponse, ecgMetrics, deviceStateMetrics,
  mergeTrend, collectThresholds, chronicMetrics, censoringSummary, splitByLocalDay, dayRangeOf, wakePercentiles, extractMetrics,
  TIDAL,
  SLEEP,
  CHRONOTYPE,
  STUN,
  PRACTICE,
  MRDS_VERSION, MRDS_PROTOCOL, MRDS_BANDS, MRDS_TOTAL_BAND, MRDS_CELLS, MRDS_LIMITACOES, MRDS_COLUMNS,
  zscoreEpochs, mrdsEpochPSD, mrdsPair, mrdsBroadbandVerdict, mrdsDesign, mrdsSignFlipTest, mrdsTable, mrdsMeta, mrdsReading,
  /* ranking dos pares bipolares do Survey (F1) */
  rankSurveyChannels, cohortSummary, wilsonCI,
  detectStates, betaEnvelopeSeries, streamOnOff, bimodalityCoefficient,
  /* integridade do sinal bruto (Onda 1 — L01, L02, L05, L07) */
  parseIntList, unwrapCounter, unwrapTicks, analyzePackets, insertNaNGaps, effectiveFs, stitchStreams,
  sequenceCapForModel, TICKS_ROLLOVER_MS, INTERLEAVED_STREAMS,
  nanStats, segmentsWithoutNan, interpolateForFilter, detrendLinearNaN,
  /* artefato cardíaco: três métodos + validação quantificada (Onda 2 — L08, L10, L11, L12) */
  detectRPeaks, removeEcg, cleanEcg, svdJacobi, lowRankApprox,
  ecgSuppressionRatio, betaPeakRecovery, bandPowerPreservation, correlation, validateEcgRemoval,
  /* perfis de doença (Onda 5 — L37, L38, L39) */
  PROFILES, PROFILE_IDS, getProfile, suggestProfile, bandsOf, normalizeSpectrum,
  TARGETS, normalizeTarget, hemisphereTargets, targetProfileCheck,
  detectTremorFrequency, spearman, movingAverageDays,
  /* proveniência e padrão de reporte (Onda 7.2 — L49, L50) */
  createProvenance, verifyManifest, sha256Hex, canonical,
  generateChecklist, checklistDocx, CHECKLIST_ITEMS,
  /* leituras em linguagem clínica e semáforo de QC (Onda 8.1) */
  clinicalReadings, qcTrafficLight, odrReading,
  makeZip, makeDocx, crc32, writeEdf, buildBidsLike, buildPdf, textWidth, unmappedChars,
  /* idiomas (Onda 8.2) */
  t, setLanguage, getLanguage, IDIOMAS, translationCoverage,
  /* fidelidade e QC (Ondas 1.3 e 2.2 — L03, L04, L06, L13–L17, L19) */
  inferDeviceState, statesComparable, documentedStimState, DOCUMENTED_STIM_STATE,
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
  alignByCrossCorrelation, alignByStimArtifact, alignByTimestamp, detectStimSteps, SYNC_PROTOCOL,
  /* actograma, banda-controle e cluster (Onda 4.1) */
  clusterPermutation, controlBandDiurnal, actogram,
  /* hierarquia agudo/crônico: configuração de sensing e passaporte (Onda 11) */
  sensingConfigOf, configBlocks, segmentTrendByConfig, crossBlockWarning, LFP_POWER_UNIT,
  PASSPORT_VERSION, biomarkerPassport, passportSensingSuggestion, passportMatchesConfig, passportCompare,
  AGENDA_VERSION, sessionAgenda,
  /* features por janela: ODR, variação espectral e coerência inter-STN (Onda 12) */
  windowGrid, spectralVariation, windowedBandPower, windowedCoherence,
  ODR_BANDS, ODR_LIMITACOES, ODR_EXPECTATIVA, gammaPeakOf, odrSeries, odrSpectralVariation,
  pairableRecords, interSTNCoherence, windowedFeatureTable, windowedFeatureMeta,
  windowedFeatureCsv, WINDOWED_COLUMNS,
  /* alarme ativo de artefato, em linguagem de consultório (Onda 11) */
  artifactAlarm,
  /* cronobiologia não paramétrica e ponto de mudança (Onda 11) */
  interdailyStability, intradailyVariability, m10l5, actigraphyPanel,
  changePoints, changePointsInTime, annotateChangePoints,
  /* tempo-frequência no padrão do BRAVO (Onda 10) */
  fftBluestein, fftAny, dftDireta,
  hannPeriodic, hammingPeriodic, hannSymmetric, WINDOWS, TF_METHODS,
  spectrogramWelch, spectrogramSTFT, spectrogramPercept, spectrogramWavelet, spectrogramAR,
  levinsonDurbin, normalizeSpectrogram, removeAperiodicTrend, timeFrequency, tfMatrix,
  /* diário de Hauser, matriz hora × dia e resposta à levodopa (Onda 9) */
  DIARY_STATES, LFP_STATES, stateById, normalizeState, parseDiaryCsv, diaryGrid,
  dailyComposition, compareConditions, circadianStateProfile, timelineGrid,
  doseMarkers, diaryVsLfpAgreement, levodopaResponse,
  /* confiabilidade longitudinal, impedância e uso (Onda 4.3) */
  icc, impedanceDrift, usageAndBattery, longitudinalReliability,
  /* geometria dos eletrodos, em escala real (Onda 13) */
  LEAD_MODELS, leadSpec, leadsOf, contactsOfChannel, parseContactId,
  leadGeometry, leadSummary, leadSpan, expandContacts
};

export default API;
export { API as PerceptCore };
