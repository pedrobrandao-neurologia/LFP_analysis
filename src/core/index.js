/* core/index.js — barrel do núcleo.
   Monta o objeto PerceptCore com EXATAMENTE a mesma superfície pública de antes
   do refactor modular (Prompt 0.1), para que app.js e a suíte de testes não mudem.
   Ver docs/arquitetura.md para o mapa de módulos e a regra de dependência. */

import { parsePercept, MODALITIES, prettyChannel, parseUtcOffsetMin, localHour, localDayKey, hashId } from './io/parse.js';
import { fft, nextPow2 } from './dsp/fft.js';
import { welchPSD, spectrogram, bandPower, bandTable, bandOf, BANDS } from './dsp/spectral.js';
import { bandpassFFT, hilbertEnvelope } from './dsp/filters.js';
import { detectBursts } from './dsp/bursts.js';
import { fitAperiodic } from './dsp/aperiodic.js';
import { ecgTemplateSubtract } from './artifact/ecg.js';
import { mean, median, sd, variance, quantile, mad, removeOutliersMAD, linreg, pearson, histogram, ecdf, bimodalityCoefficient } from './stats/descriptive.js';
import { fPValue, tPValue, normCDF } from './stats/distributions.js';
import { cosinor, cosinorBootstrap, rayleigh, varianceByHour, diurnalProfile } from './stats/circadian.js';
import { eventAligned, permutationTest } from './stats/events.js';
import { detectStates, betaEnvelopeSeries, streamOnOff } from './stats/states.js';
import { peakInBand, pickSpectrum, spectralMetrics, burstMetrics, doseResponse } from './metrics/acute.js';
import { mergeTrend, collectThresholds, chronicMetrics, thresholdSummary } from './metrics/chronic.js';
import { extractMetrics, daysSince } from './metrics/extract.js';

const API = {
  parsePercept, MODALITIES, BANDS, prettyChannel, parseUtcOffsetMin, localHour, localDayKey, hashId,
  fft, nextPow2, welchPSD, spectrogram, bandpassFFT, hilbertEnvelope, detectBursts, fitAperiodic,
  ecgTemplateSubtract, bandPower, bandTable, bandOf,
  mean, median, sd, variance, quantile, mad, removeOutliersMAD, linreg, pearson,
  cosinor, cosinorBootstrap, rayleigh, varianceByHour, diurnalProfile, eventAligned,
  permutationTest, thresholdSummary, histogram, ecdf, fPValue, tPValue, normCDF,
  peakInBand, daysSince, pickSpectrum, spectralMetrics, burstMetrics, doseResponse,
  mergeTrend, collectThresholds, chronicMetrics, extractMetrics,
  detectStates, betaEnvelopeSeries, streamOnOff, bimodalityCoefficient
};

export default API;
export { API as PerceptCore };
