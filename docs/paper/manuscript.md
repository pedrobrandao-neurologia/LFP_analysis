# Title page

**Title**

Percept LFP Studio: offline, dependency-free analysis of implanted neurostimulator local field potentials with enforced uncertainty reporting

**Running head**

Offline LFP analysis for the Percept

**Authors**

Pedro Renato de Paula Brandão^1,2^

^1^ *[Affiliation 1 — department, institution, city, state, country]*
^2^ *[Affiliation 2, if applicable]*

**Corresponding author**

Pedro Renato de Paula Brandão
*[Full postal address]*
E-mail: pedrobrandao.neurologia@gmail.com
ORCID: *[0000-0000-0000-0000]*

**Keywords**

Deep brain stimulation; Local field potentials; Subthalamic nucleus; Signal processing, computer-assisted; Software; Reproducibility of results; Data anonymization

**Word count**

Abstract: 247 · Main text: 4 180 (excluding tables, legends and references) · Figures: 3 · Tables: 4 · References: 35

**Declarations (summary; full statements after the Conclusions)**

Funding: none. Conflicts of interest: none declared. Ethics approval: not required — no human participants or human data were used. Data and code availability: source code, synthetic dataset and validation harness are openly available at https://github.com/pedrobrandao-neurologia/LFP_analysis under the MIT license. Generative artificial intelligence was used during software implementation and manuscript preparation and is disclosed in Methods and Acknowledgments.

---

# Abstract

**Background.** Implanted neurostimulators with chronic sensing, notably the Medtronic Percept, now export local field potential (LFP) recordings as routine clinical data. Existing toolboxes require a scientific computing stack, and some route recordings through a server. Both are obstacles where these files are generated.

**New method.** Percept LFP Studio is a single-file browser application (868 KB) that parses Percept Session Report JSON files and produces 29 interactive analyses with no installation, no server and no network request. Signal processing, statistics, plotting and the PDF, EDF+ and ZIP writers are implemented from scratch with no third-party runtime dependency, and direct identifiers are discarded at the parser boundary. Three rules are enforced by the test suite: every parameter-dependent quantity is exported with its parameter, every quality indicator accompanies its metric, and missing samples propagate as NaN with explicit accounting rather than being imputed.

**Results.** Against synthetic signals with known ground truth, 87 of 87 pre-specified criteria passed: R-peak detection at 100% sensitivity and 0% false positives at −10 dB SNR, packet-loss detection with Jaccard index 1.00, peak-frequency error below 0.11 Hz, aperiodic-exponent error below 0.003. Spectral density scaling reproduced Parseval's identity exactly. The benchmark and a 249-test suite run in continuous integration.

**Comparison with existing methods.** Unlike perceive, PerceptToolbox, DBScope, py_neuromodulation and BRAVO, it needs no runtime and no server, and makes parameter and uncertainty disclosure mandatory.

**Conclusions.** LFP analysis is deployable without an installed scientific stack and without transmitting patient data. Validation on real recordings remains to be performed.

---

# 1. Introduction

Deep brain stimulation (DBS) devices that both stimulate and record have moved from research prototypes to routine clinical hardware. The Medtronic Percept family, approved in Europe in 2020 and in the United States shortly thereafter, streams local field potentials (LFPs) from the implanted lead and stores a chronic power trend sampled every ten minutes for months at a time [1,2]. For the first time, longitudinal electrophysiology from the human basal ganglia is generated as a by-product of ordinary clinical care, in volumes that no research protocol previously produced [3].

This has created an analytical bottleneck rather than resolving one. Subthalamic beta-band (13–35 Hz) power is the most studied candidate biomarker of the parkinsonian OFF state [4] and the control variable of the first adaptive DBS trials [5–8]. Its clinical use requires decisions that materially change the resulting number: which bipolar contact pair to interrogate, whether power is corrected for the aperiodic 1/f background [9,10], what threshold defines a burst [7], how packet loss is handled, and whether a diurnal pattern is specific to the marker band or reflects a global modulation of the recording [11]. Each of these is a documented controversy, and each is routinely reported without the parameter that produced it. A beta power value is not interpretable, and not comparable across centres, unless the choices behind it travel with it.

Several toolboxes address parts of this problem. *perceive* (Neumann laboratory) and *PerceptToolbox* [2] are MATLAB packages centred on parsing and packet-loss correction. *DBScope* [12] provides visualisation and quality control in R. *py_neuromodulation* [13] implements feature extraction as pluggable modules for decoding pipelines. *BRAVO* (Fixel Institute) offers a rich analysis suite including several spectrogram estimators, served through a Python/`scipy` back end. All are capable and actively maintained. All also share two properties that limit deployment at the point where these files are actually created: they require an installed scientific computing stack, and two of them assume a client–server architecture in which the recording is uploaded for processing. In hospital environments, installing MATLAB or a Python environment on a clinical workstation is frequently impossible, and transmitting an identifiable neurophysiological recording to any server — including a local one — triggers institutional review that can take longer than the clinical question allows.

We therefore asked whether a complete LFP analysis environment could be delivered with three constraints held simultaneously: no installation, no network traffic of any kind, and no third-party runtime dependency in the executed code. We further asked whether the same design could make methodological disclosure structural rather than discretionary — that is, whether the software could be built so that a parameter-dependent number *cannot* be exported without its parameter. This article describes the resulting tool, its architecture, and its validation against synthetic ground truth.

---

# 2. Methods

## 2.1. Design constraints

Four constraints were fixed before implementation and enforced throughout by an executable development contract stored in the repository and by the automated test suite.

1. **Zero network.** No HTTP request, no content delivery network, no telemetry. All computation occurs in the user's browser.
2. **Zero runtime dependency.** No third-party library may enter the executed bundle. Development tooling (test runner) is permitted provided it does not ship.
3. **Pseudonymisation at the boundary.** Name, date of birth, `PatientId` and neurostimulator serial number are consumed and discarded inside the parser; every downstream structure receives only a hashed `subject_id`.
4. **Generated artefact.** The distributed `index.html` is generated from source and never edited by hand; continuous integration fails if the two are out of sync.

## 2.2. Software architecture

The application is written in ES2020 JavaScript without transpilation. The analytical core comprises 59 ES modules (~10 500 lines) in `src/core/`, organised by responsibility into layers: `io` (parsing, packet accounting, time zones, external file import), `dsp` (transforms, spectral estimation, filters, wavelets, coupling, coherence), `stats` (descriptive, distributions, circadian, events, clustering, reliability), `metrics` (acute, chronic, extraction, survey ranking, cohort, control band, diary), `artifact`, `qc`, `adbs`, `profiles`, `report`, `export`, `provenance` and `i18n`.

A one-directional dependency rule is enforced: `io` does not import `dsp`; `dsp` does not import `metrics`; `metrics` imports `dsp` and `stats`; nothing imports the presentation layer. A build script (`src/build.mjs`) resolves the import graph, orders modules topologically, detects cycles and identifier collisions, strips module syntax and concatenates the result into one self-contained HTML file of 868 KB. The presentation layer (`src/app.js`, 5 300 lines; `src/percept-plot.js`, 520 lines) consumes the core and is never imported by it.

Computationally heavy operations run in a Web Worker constructed at runtime from the page's own inlined core via a `Blob` URL, preserving the single-file constraint. The worker dispatcher executes only own properties of the core object, so that inherited members such as `constructor` cannot become entry points. When `Worker` or `Blob` is unavailable the call transparently falls back to the main thread, and the execution location is recorded and reported.

## 2.3. Input and signal integrity

The parser reads all modalities of the Percept Session Report: `LFPMontage`, `LfpMontageTimeDomain`, `BrainSenseTimeDomain`, `BrainSenseLfp`, `DiagnosticData.LFPTrendLogs`, `LfpFrequencySnapshotEvents`, `Impedance`, `Groups`/`SensingSetup`, `EventLogs`, `GroupUsagePercentage` and `BatteryInformation`.

Packet loss is reconstructed from `GlobalSequences` or, when absent, from `TicksInMses`. Detected gaps are inserted into the sample vector as NaN and are never interpolated; the resulting accounting (percentage missing, longest contiguous gap, detection method, and whether detection was possible at all) is attached to the record and travels with every derived metric. Effective sampling rate is estimated from the tick sequence, and temporal drift is flagged when it exceeds a threshold relevant to event alignment. Daylight-saving transitions and offset discontinuities are detected and, where necessary, the record is segmented.

## 2.4. Signal processing

All algorithms are original implementations. The discrete Fourier transform uses a radix-2 Cooley–Tukey routine, complemented by Bluestein's chirp-z algorithm [14,15] for arbitrary transform lengths — required because the BRAVO-compatible spectrogram derives its length from the requested frequency resolution (`NFFT = round(fs / Δf)`, giving 500 at 250 Hz and 0.5 Hz), which is not a power of two.

Welch's periodogram [16] uses a periodic Hann window with 50% overlap and per-segment linear detrending, and discards rather than pads segments containing NaN. Multitaper estimation follows the discrete prolate spheroidal sequence formulation of Percival and Walden [17,18], computing tapers from the tridiagonal eigenproblem by Sturm bisection with inverse iteration (Thomas algorithm) and normalising by Parseval-based concentration; confidence intervals are obtained by jackknife over tapers. Window functions are provided in both the periodic convention used for spectral estimation and the symmetric convention used by the device emulation, following Harris [19]; the two differ by a fraction of a percent in estimated power, which is enough for a cross-implementation comparison to fail without an evident cause. Spectral parameterisation implements the specparam/FOOOF model [9] with a robust aperiodic fit, iterative bounded Gaussian peak extraction, simultaneous Levenberg–Marquardt refinement of all parameters, and selection between fixed and knee aperiodic forms by AIC. Time-frequency decomposition offers Morlet wavelet convolution via FFT with the cone of influence returned as NaN, Welch-per-epoch and Hamming-windowed short-time Fourier estimation, an autoregressive (Yule–Walker with Levinson–Durbin recursion and BIC order selection [20]) estimator, and an emulation of the device's on-board magnitude spectrum.

Phase-amplitude coupling uses the Tort modulation index [21] with a comodulogram and time-shift surrogates. Magnitude-squared coherence with external signals is computed from the Welch cross-spectrum against the analytic 1/L null distribution, with Šidák correction over the bins of the tested band and delay estimated both from the phase slope and from the phase at the coherence peak.

A dedicated routine classifies gamma-band peaks as endogenous or as an artefact entrained at half the stimulation frequency, and refuses to classify when the stimulation frequency is not declared in the file [22].

Cardiac artefact is addressed by three independent methods — QRS interpolation, template subtraction and low-rank SVD — following two-pass R-peak detection. Rather than asserting a preferred method, the software measures ECG suppression in decibels, beta-peak recovery ratio, band-power preservation and correlation with the artefact-free signal for each method, and reports which performed best in the recording at hand.

## 2.5. Statistical methods

Circadian rhythm is modelled by cosinor regression with 24 h and 12 h harmonics [23]. Confidence intervals use a block bootstrap resampling whole days, which preserves intraday autocorrelation; because least-squares normal equations are additive over disjoint blocks, per-day Gram matrices are accumulated once and each bootstrap replicate solves a small system, reducing computation from seconds to milliseconds without altering the estimator. The cosinor p-value is additionally corrected for AR(1) residual autocorrelation via an effective sample size. Daily acrophases are tested by the Rayleigh statistic.

Cluster-based permutation testing follows Maris and Oostenveld [24]; the output embeds the Sassenhagen and Draschkow caveat [25] that a significant cluster establishes a difference somewhere within it, not at any specific point, and does not license inference about its boundaries. Two-sample permutation testing enumerates all partitions exactly when their number is tractable (for example 3 432 partitions for 7 versus 7 days) and otherwise samples with a fixed seed. Reliability across sessions is quantified by both ICC(2,1) and ICC(3,1) with F-based confidence intervals [26,27], reported together because the choice changes the value and the appropriate model depends on the question. Proportions are reported with Wilson intervals [28]; agreement between self-report and biomarker uses Cohen's kappa with its standard error [29].

Every stochastic procedure takes an explicit seed, recorded in the export, so that a given input reproduces a given interval.

## 2.6. Enforced reporting rules

Three rules distinguish the tool and are verified by tests rather than left to discipline.

**Parameter disclosure.** Any quantity that depends on an analytic choice is emitted as a structure containing both the value and the parameter — burst percentile, band limits, threshold method, number of SVD components, aperiodic fit range, bootstrap seed. Exports and figure captions render both.

**Quality disclosure.** Where a quality indicator exists it accompanies the metric: number of valid samples, percentage missing, fit R², artefact flag, number of epochs discarded.

Where the analysis reproduces an established clinical instrument, the instrument's own conventions are followed: the hour × day state matrix uses the 30-minute bins and five categories of the Hauser diary [30], and the summary bars use the waking-hours restriction that serves as the primary endpoint in device-aided therapy trials [31].

**Refusal.** Where the data do not support an estimate, the software returns the reason rather than a number. Intraclass correlation with fewer than three subjects is refused with its statistical justification; a levodopa response curve that does not separate from a circular-shift surrogate distribution does not receive latency or duration landmarks; a spectrogram epoch containing packet loss is rendered as a blank band rather than as plausible power.

Where methodological controversy is documented, the interface offers the choice, records which option was used, and cites the controversy in the figure — for example burst threshold by percentile versus by the aperiodic background, Hilbert versus wavelet envelope, and a priori band versus largest observed peak.

## 2.7. Exports and provenance

Figures export as PNG and their underlying data as CSV with English column headers. Aggregate exports include CSV metric tables, a JSON package, an EDF+ file written from scratch [32] with missing samples encoded at the digital minimum, a BIDS-like directory following iEEG-BIDS logic [33,34], a DOCX reporting checklist, and a native PDF report implemented directly against the PDF 1.4 specification using base-14 Helvetica with WinAnsi encoding and real glyph widths. All can be bundled into a single ZIP produced by an original store-only compressor. Heat maps offer both a perceptually uniform colour map as the default and the rainbow map used by earlier literature, the latter provided only for visual comparability with published figures and labelled as such [35].

Any export may carry a provenance manifest containing SHA-256 hashes of the input files, software version, per-figure parameters, random seeds and the execution location of each computation. A verification routine recomputes the hashes and reports discrepancies.

## 2.8. Validation strategy

Because no real recordings were available for this report, validation proceeded along two axes that do not require them.

**Synthetic ground truth.** A generator produces LFP-like signals with specified beta peak frequency and amplitude, a 1/f background of specified exponent, burst structure with known onsets and offsets, cardiac artefact at a specified signal-to-noise ratio, packet loss at a specified rate, and phase-amplitude coupling of specified strength. Eighty-seven acceptance criteria with pre-specified thresholds compare recovered parameters against the generating values. The benchmark is executed in continuous integration with a `--check` flag that fails the build on regression against a stored baseline.

**Analytic identity.** Where a closed-form result exists, the implementation is compared against it rather than against another implementation, on the reasoning that an incorrect fast routine and a test written from that routine would agree with each other. Spectral density scaling was verified against Parseval's identity; the arbitrary-length transform against the O(N²) definition of the DFT; autoregressive spectral estimation against the analytic resonance of a known AR(2) process; and window functions against their closed forms in both periodic and symmetric conventions.

A separate regression suite of 249 tests exercises the parser, all algorithms, the export writers and all 29 figure renderers against a minimal simulated DOM. Interactive behaviour was additionally verified in a real browser (Chromium) driven through the DevTools Protocol.

## 2.9. Ethics

No human participants and no human data were involved in the development or validation reported here. All signals used were synthetic and generated by the deterministic routine described in Section 2.8. Ethics committee approval was therefore not required and was not sought. The application is a research and decision-support tool; it is not a medical device, is not intended for diagnosis, and does not replace the manufacturer's regulated software.

## 2.10. Use of generative artificial intelligence

Software implementation and manuscript preparation were carried out with substantial assistance from a large language model (Claude, Anthropic) operating as a coding assistant within a version-controlled repository. All generated code was reviewed by the author, and every quantitative claim in this article derives from the automated benchmark and test harness, which are themselves openly available and independently executable. The author takes full responsibility for the content, the correctness of the implementation and the accuracy of the reported results. No artificial intelligence system is listed as an author.

---

# 3. Results

## 3.1. Delivered functionality

The application implements 29 figures spanning acute spectral analysis, chronic multi-day series, stimulation response, quality control, external-signal integration and cohort description (Table 1). Two operating modes are provided: a clinical mode that presents a profile-dependent subset with plain-language readings, and a research mode exposing all figures, all parameter controls and all exports. Both modes present identical numbers, identical caveats and identical declared parameters; clinical mode restricts which figures are shown, never which uncertainties are disclosed.

Five disease profiles (Parkinson's disease, dystonia, essential tremor, epilepsy, generic) alter the primary band, the peak-search method, the normalisation strategy and the clinical figure set. The profile is suggested from lead target and sensing configuration and can be overridden.

**Table 1.** Analytical coverage by domain.

| Domain | Figures | Principal outputs |
|---|---|---|
| Acute spectral | F1, F2, F5, F18, F19 | Peak frequency and magnitude; aperiodic-corrected band area; ranking of all bipolar pairs; multitaper CI; full specparam with model selection |
| Time-frequency | F6, F20, F30 | Spectrogram by five estimators; wavelet scalogram; burst detection and bracketing |
| Coupling and gamma | F21, F22, F24 | Tort modulation index and comodulogram; entrained versus endogenous gamma; coherence with external signals |
| Chronic | F8, F9, F10, F12, F13, F25 | Multi-day series; cosinor with bootstrap CI; event-aligned response; ON/OFF state detection; actogram; control-band specificity test |
| Motor state | F28, F29 | Hour × day state matrix linked to its integral; levodopa response with surrogate testing |
| Stimulation and aDBS | F7, F11, F23 | Dose–response; threshold distribution; eligibility assessment and threshold simulation |
| Quality and longitudinal | F3, F4, F15, F16, F17, F26 | Impedance; session timeline; artefact removal with quantified validation; peak reproducibility; QC panel; ICC and impedance drift |
| Cohort | F27 | Prevalence with Wilson CI; per-subject table; group statistics |

## 3.2. Benchmark against synthetic ground truth

All 87 pre-specified acceptance criteria passed. Table 2 reports the principal results.

**Table 2.** Selected benchmark results against synthetic ground truth. All criteria were pre-specified before measurement.

| Metric | Condition | Value | Criterion |
|---|---|---|---|
| R-peak detection, true positive rate | SNR −10 dB | 100% | ≥ 95% |
| R-peak detection, false positive rate | SNR −10 dB | 0% | ≤ 1% |
| ECG suppression, SVD | SNR −10 dB | 11.4 dB | > 0 dB |
| Correlation with artefact-free signal, SVD | SNR −10 dB | 0.968 | > 0.90 |
| Beta power preservation | SNR −10 dB | 0.904 | 0.7–1.3 |
| Theta power preservation | SNR −10 dB | 0.979 | 0.7–1.3 |
| Packet-loss detection, Jaccard index | 0–10% loss | 1.00 | > 0.99 |
| Effective sampling-rate error | 0–10% loss | 0.0016 Hz | < 0.005 Hz |
| Peak-frequency error | three disease profiles | 0.066–0.106 Hz | < 0.5 Hz |
| Aperiodic-exponent error, specparam | χ = 1.0, 1.5, 2.2 | 0.0013–0.0022 | < 0.10 |
| Peak-frequency error, specparam | χ = 1.0, 1.5, 2.2 | 0.005–0.007 Hz | < 0.5 Hz |
| Peak-width error, specparam | χ = 1.0, 1.5, 2.2 | 0.059–0.096 Hz | < 2.5 Hz |
| specparam model R² | χ = 1.0, 1.5, 2.2 | 1.00 | > 0.95 |
| Aperiodic model selection accuracy | knee vs. pure power law | 2/2 | 2/2 |
| DPSS orthonormality | N = 512, NW = 4, K = 7 | 0 | < 10⁻⁸ |
| DPSS minimum concentration to 2NW−2 | N = 512, NW = 4 | 0.995 | > 0.99 |
| Multitaper peak-frequency error | 4, 8, 16 s records | 0.016–0.077 Hz | < 0.5 Hz |
| Wavelet burst detection, F1 | SNR 20 dB, 75th percentile | 0.980 | > 0.75 |
| PAC, true coupling | simulated beta→gamma | z = 23.7 | > 5 |
| PAC, uncoupled control | no coupling | z = −0.20 | < 3 |
| Gamma classification, entrained | peak 65 Hz, f_stim 130 Hz | correct | correct |
| Gamma classification, endogenous | peak 65 Hz, f_stim 160 Hz | correct | correct |

Two results deserve comment. First, R-peak detection remained perfect down to −10 dB SNR, and above 0 dB the software declines to assert high confidence — a deliberate refusal encoded as an acceptance criterion, since at favourable SNR the artefact may be absent rather than undetected. Second, the aperiodic exponent was recovered with error below 0.003 across a threefold range of true exponents, which matters because the aperiodic component is increasingly interpreted as reflecting excitation–inhibition balance [10] and its estimate is sensitive to fitting range and model form.

## 3.3. Analytic verification

**Table 3.** Verification against closed-form results.

| Property verified | Test | Result |
|---|---|---|
| Spectral density scaling and one-sided factor | Integral of PSD over frequency for a sinusoid of amplitude A = 3 | 4.5000, exactly A²/2 |
| Density normalisation | Mean PSD of white noise with σ = 2, versus σ²/(fs/2) | ratio 0.991 (Welch), 0.992 (STFT), 0.983 (AR) |
| Arbitrary-length transform | Bluestein versus the O(N²) DFT definition, N ∈ {3, 7, 61, 250, 500} | max relative error 2.3 × 10⁻¹⁴ |
| Transform consistency | Bluestein versus radix-2 at N = 512 | max relative error 1.3 × 10⁻¹⁴ |
| Transform invertibility | Forward then inverse at N = 375 | max absolute error 6.4 × 10⁻¹⁴ |
| Autoregressive estimation | BIC order and spectral peak for a known AR(2) process | order 2 selected; peak 26.00 Hz vs. 26.74 Hz theoretical |
| Window conventions | Periodic and symmetric Hann and Hamming versus closed forms | exact |
| Circadian bootstrap acceleration | Accelerated versus direct refitting, identical draw sequence | difference 2 × 10⁻¹⁴ |

The Parseval result is the single most informative line in Table 3: recovering A²/2 exactly, rather than approximately, simultaneously validates the |X|²/(fs·Σw²) normalisation, the factor-of-two correction for one-sided spectra and its exclusion at DC and Nyquist. Any error in that chain would displace the integral.

## 3.4. Missing-data behaviour

Packet loss was injected at rates from 0% to 10% and detected with a Jaccard index of 1.00 against the true gap set, with effective sampling rate recovered to within 0.0016 Hz. Across the four windowed spectrogram estimators, every epoch containing a missing sample was flagged, returned as NaN, excluded from the valid-epoch count and rendered as a blank band; no epoch containing missing data returned a numeric power value. Welch spectral estimation discards rather than zero-pads affected segments and, when fewer than three segments remain, returns a stated reason instead of a spectrum.

## 3.5. Performance

On a synthetic record comprising 21 days of chronic Timeline (2 × 3 024 points), 120 s of raw signal at 250 Hz, 30 Survey spectra and 32 event snapshots, all 29 figures rendered in 6.3 s in Chromium. Moving the analytical core into a Web Worker reduced main-thread blocking from 1 549 ms to 419 ms. Accelerating the circadian block bootstrap through additive per-day normal equations reduced its computation from 5 319 ms to 53 ms with an estimator difference of 2 × 10⁻¹⁴. Spectrogram results are cached by the tuple of record, method and parameters, so that changing colour limits or colour map re-renders without recomputation.

## 3.6. Regression suite

The 249-test suite covers parsing (including malformed and empty JSON, which must be refused with a stated reason rather than crashing), all signal-processing routines, all statistical routines, all export writers, and all 29 figure renderers. Three properties are asserted as tests rather than documented as intentions: that no export or error message contains a direct identifier; that every figure title has an English translation; and that no character used anywhere in the application lacks a representation in the PDF encoding.

---

# 4. Discussion

## 4.1. Principal findings

A complete LFP analysis environment for an implanted neurostimulator can be delivered as a single browser file that requires no installation, no server and no third-party runtime, and it can be validated to a standard normally expected of a scientific toolbox. All 87 pre-specified criteria against synthetic ground truth passed, and the spectral scaling reproduced Parseval's identity exactly. The architectural constraints did not force analytical compromise: multitaper estimation, full spectral parameterisation, wavelet decomposition, phase-amplitude coupling, cluster-based permutation testing and block-bootstrap cosinor inference are all implemented and validated.

The design also demonstrates that methodological disclosure can be structural. Because every parameter-dependent quantity is emitted as a value–parameter pair, an export lacking its parameter is not a matter of author discipline but a structural impossibility. We regard this as the most transferable element of the work, and it is independent of the platform.

## 4.2. Comparison with existing methods

Table 4 summarises the comparison. The functional overlap with existing toolboxes is substantial, and this is by design: parsing logic, packet-loss accounting and QRS handling in this implementation were informed by reading *perceive*, *PerceptToolbox* [2], *DBSsync* and *BRAVO*, and the spectrogram suite deliberately reproduces the parameterisation of BRAVO so that results are comparable bin by bin. The distinction is not in the algorithms but in the deployment envelope and in what the software refuses to do.

**Table 4.** Comparison with existing Percept analysis toolboxes.

| Property | perceive | PerceptToolbox | DBScope | py_neuromodulation | BRAVO | This work |
|---|---|---|---|---|---|---|
| Runtime required | MATLAB | MATLAB | R | Python | Python server + browser | none |
| Installation | yes | yes | yes | yes | yes (server) | no |
| Network traffic | none | none | none | none | client–server | none |
| Third-party dependencies | MATLAB toolboxes | MATLAB toolboxes | CRAN packages | SciPy stack | SciPy, Plotly | none |
| Interactive figures | limited | limited | yes | limited | yes | yes (29) |
| Parameter disclosure | optional | optional | optional | optional | optional | enforced |
| Quality indicator with metric | partial | partial | yes | partial | partial | enforced |
| Refusal on insufficient data | no | no | partial | no | no | yes |
| Provenance manifest with hashes and seeds | no | no | no | no | no | yes |
| Published validation on real data | partial | yes [2] | yes | yes [13] | partial | **no** |

The final row is the most important, and it favours the alternatives. *PerceptToolbox*, *DBScope* and *py_neuromodulation* have been exercised on real patient recordings and reported in peer-reviewed literature [2,12,13]; the present tool has not. Feature breadth and validation depth are different currencies, and this work currently holds the former.

Two further asymmetries should be acknowledged. MATLAB- and Python-based toolboxes integrate directly into the scripted analysis pipelines that produce publications, whereas a browser application must export to reach that workflow — which is why CSV headers here are in English and a companion R script is distributed. And a server-based architecture such as BRAVO's can offer multi-user cohort management and persistent storage that a stateless browser page cannot.

## 4.3. Methodological implications

Three implementation decisions have consequences beyond this software.

First, **using Bluestein's algorithm rather than zero-padding to a power of two** preserves the frequency axis exactly. The commonly used alternative — padding 500 to 512 — changes the bin spacing from 0.500 Hz to 0.488 Hz, so that no bin coincides with the intended grid, and comparison between implementations becomes interpolation rather than identity. For a paper reporting a peak frequency to two decimal places this is not negligible.

Second, **the on-board PSD emulation carries an undocumented empirical gain constant** (1/54), inherited from BRAVO. Reproducing it makes the emulation comparable to what the device itself reports, and the software measures that agreement when both raw signal and device-reported power are present in the same file. But the constant is empirical and unpublished by the manufacturer, and the software states explicitly that agreement in dynamics does not validate absolute scale. Any absolute power value attributed to the Percept should be treated as being in an undocumented internal unit.

Third, **the circular-shift surrogate for levodopa response** exposes a confound that simpler analyses hide. Because medication is taken on a fixed daily schedule and beta power has a strong diurnal rhythm [11], dose effect and time of day occupy the same column of the experimental design. The software reports how much apparent post-dose decline the diurnal rhythm alone produces, and states that a non-significant result means *not separable*, not *no effect*. We suggest this reporting pattern is appropriate wherever chronic sensing is aligned to scheduled interventions.

## 4.4. Limitations

**No validation on real recordings.** This is the principal limitation and it constrains every claim in this report. The benchmark establishes that the implementations recover the parameters of signals whose parameters are known; it does not establish that they behave well on human recordings, that their outputs agree with those of other toolboxes on the same file, that derived metrics correlate with clinical state, or that results reproduce across centres and devices. The synthetic generator embodies the author's model of what a Percept recording looks like, and any systematic mismatch between that model and reality is invisible to the entire benchmark. A validation study on real recordings, with concurrent analysis by at least one established toolbox, is necessary before the tool is used for anything beyond exploration, and is the immediate priority for subsequent work.

**Browser execution imposes real ceilings.** Recordings of many hours at 250 Hz approach practical memory limits, and computation is single-threaded apart from one worker. The single-file constraint that makes deployment trivial also means the entire core is parsed at every page load.

**The BIDS export is BIDS-like, not conformant.** It follows iEEG-BIDS logic [33] but has not been through the official validator, and should not be presented as BIDS-compliant.

**Interface translation is partial.** English covers the interface frame and figure titles; the methodological text inside figures remains in Portuguese. This is a deliberate deferral — a poor translation of text explaining a methodological limitation is worse than untranslated text — but it is a barrier for non-Portuguese-speaking users, and it is disclosed in the application itself.

**The spectrogram's 1/f removal is a robust log-log regression, not full FOOOF.** Full specparam is available elsewhere in the application, but users comparing the two should not expect identical aperiodic estimates.

**Single-author development.** The code has not undergone external review, and the test suite, however extensive, was written by the same person who wrote the implementation. Independent code review would strengthen confidence in ways that self-testing cannot.

**Substantial use of generative artificial intelligence** in implementation is disclosed in Section 2.10. Its principal risk is plausible-looking but subtly incorrect numerical code. The mitigation adopted was to validate against analytic identities and ground truth rather than against expectation, and to keep the entire validation harness open and executable. Readers should treat the openly published benchmark, not the description in this article, as the evidence.

## 4.5. Future work

The immediate priority is a validation study on real Percept recordings comparing outputs against an established toolbox on identical files, with agreement quantified rather than asserted. Beyond that, three directions follow from the present design: translation of the methodological text, which requires clinical rather than linguistic expertise; independent external code review; and extension of the parser to other chronic-sensing platforms, for which the layered architecture and the parser boundary were designed but which has not been attempted.

---

# 5. Conclusions

Local field potential analysis for implanted neurostimulators can be delivered without an installed scientific computing stack and without transmitting patient recordings anywhere, while implementing and validating the full contemporary analytical repertoire. Percept LFP Studio achieves this in a single 868 KB browser file with no runtime dependencies, passing 87 of 87 pre-specified criteria against synthetic ground truth and reproducing spectral scaling identities exactly. Its more transferable contribution is architectural: by emitting every parameter-dependent quantity together with its parameter, its quality indicator and its caveat, and by refusing to produce a number when the data do not support one, the software makes methodological disclosure a structural property rather than an act of discipline. Validation on real recordings has not been performed and is required before clinical or research reliance.

---

# Declarations

**Ethics approval.** Not required. No human participants and no human data were involved. All signals used in development and validation were synthetic.

**Consent.** Not applicable.

**Funding.** This work received no specific grant from any funding agency in the public, commercial or not-for-profit sectors.

**Declaration of interests.** The author declares no competing interests. The author has no financial or other relationship with Medtronic or with the developers of any toolbox referenced in this article.

**Author contributions (CRediT).** Pedro Renato de Paula Brandão: Conceptualization, Methodology, Software, Validation, Formal analysis, Investigation, Data curation, Writing — original draft, Writing — review and editing, Visualization, Project administration.

**Use of generative artificial intelligence.** During the preparation of this work the author used Claude (Anthropic) for software implementation, for construction of the validation harness, and for drafting and language editing of this manuscript. All code and text were reviewed by the author, who takes full responsibility for the content of the publication. No artificial intelligence tool is listed as an author or cited as a reference. The full development history, including AI-assisted commits, is public in the repository.

**Data and code availability.** The complete source code, the deterministic synthetic dataset generator, the 249-test regression suite and the 87-criterion benchmark harness are openly available at https://github.com/pedrobrandao-neurologia/LFP_analysis under the MIT license. No patient data are included or required to reproduce any result reported here. All benchmark results in Tables 2 and 3 are regenerated by `node tests/benchmark.mjs` and `node tests/run.mjs`.

**Acknowledgments.** The author thanks the developers of *perceive*, *PerceptToolbox*, *DBSsync*, *DBScope*, *py_neuromodulation* and *BRAVO* for publishing their source code, which informed the architecture of this work.

---

# Figure legends

**Figure 1. Architecture and data flow.** (a) The Session Report JSON is read by the browser's `FileReader`; direct identifiers are consumed and discarded inside the parser, which emits a hashed `subject_id`. (b) Layered core of 59 ES modules with a one-directional dependency rule. (c) The build script resolves the import graph, orders it topologically and concatenates it into a single self-contained HTML file. (d) Heavy computation runs in a Web Worker constructed from the page's own inlined core, with transparent fallback to the main thread. No arrow crosses the network boundary.

**Figure 2. Enforced reporting in practice.** Representative figure output showing the value, the parameter that produced it, the available quality indicator and the methodological caveat rendered together. Left: burst metrics with threshold method and percentile declared. Centre: spectrogram in which epochs containing packet loss are rendered as blank bands rather than as power. Right: an analysis refused with a stated statistical reason rather than returned as a number.

**Figure 3. Validation against ground truth.** (a) Recovered versus true peak frequency across disease profiles. (b) Recovered versus true aperiodic exponent for χ = 1.0, 1.5 and 2.2. (c) R-peak detection sensitivity and false-positive rate across the SNR sweep, with the boundary beyond which the software declines to assert high confidence. (d) Integral of the estimated power spectral density versus the analytic signal power A²/2, verifying density scaling.

---

# References

> **Note to the author: every reference below must be verified against the original publication before submission.** They were compiled without access to a bibliographic database and volume, page and year fields may contain errors. Cross-check each entry in PubMed and export the final list from a reference manager in the Elsevier numbered style required by the *Journal of Neuroscience Methods*. References are numbered in order of first citation.

1. Krauss JK, Lipsman N, Aziz T, Boutet A, Brown P, Chang JW, et al. Technology of deep brain stimulation: current status and future directions. Nat Rev Neurol. 2021;17(2):75–87.

2. Thenaisie Y, Palmisano C, Canessa A, Keulen BJ, Capetian P, Jiménez MC, et al. Towards adaptive deep brain stimulation: clinical and technical notes on a novel commercial device for chronic brain sensing. J Neural Eng. 2021;18(4):042002.

3. Gilron R, Little S, Perrone R, Wilt R, de Hemptinne C, Yaroshinsky MS, et al. Long-term wireless streaming of neural recordings for circuit discovery and adaptive stimulation in individuals with Parkinson's disease. Nat Biotechnol. 2021;39(9):1078–1085.

4. Feldmann LK, Neumann WJ, Krause P, Lofredi R, Schneider GH, Kühn AA. Subthalamic beta band suppression reflects effective neuromodulation in chronic recordings. Eur J Neurol. 2021;28(7):2372–2377.

5. Neumann WJ, Turner RS, Blankertz B, Mitchell T, Kühn AA, Richardson RM. Toward electrophysiology-based intelligent adaptive deep brain stimulation for movement disorders. Neurotherapeutics. 2019;16(1):105–118.

6. Little S, Pogosyan A, Neal S, Zavala B, Zrinzo L, Hariz M, et al. Adaptive deep brain stimulation in advanced Parkinson disease. Ann Neurol. 2013;74(3):449–457.

7. Tinkhauser G, Pogosyan A, Little S, Beudel M, Herz DM, Tan H, et al. The modulatory effect of adaptive deep brain stimulation on beta bursts in Parkinson's disease. Brain. 2017;140(4):1053–1067.

8. Neumann WJ, Gilron R, Little S, Tinkhauser G. Adaptive deep brain stimulation: from experimental evidence toward practical implementation. Mov Disord. 2023;38(6):937–948.

9. Donoghue T, Haller M, Peterson EJ, Varma P, Sebastian P, Gao R, et al. Parameterizing neural power spectra into periodic and aperiodic components. Nat Neurosci. 2020;23(12):1655–1665.

10. Wiest C, Torrecillos F, Pogosyan A, Bange M, Muthuraman M, Groppa S, et al. The aperiodic exponent of subthalamic field potentials reflects excitation/inhibition balance in parkinsonism. eLife. 2023;12:e82467.

11. van Rheede JJ, Feldmann LK, Busch JL, Fleming JE, Mathiopoulou V, Denison T, et al. Diurnal modulation of subthalamic beta oscillatory power in Parkinson's disease patients during deep brain stimulation. npj Parkinsons Dis. 2022;8(1):88.

12. Oliveira AM, Coelho L, Carvalho E, Ferreira-Pinto MJ, Vaz R, Aguiar P. DBScope: a versatile computational toolbox for the visualization and analysis of sensing data from deep brain stimulation. Neuroinformatics. 2024;22(2):181–193.

13. Merk T, Peterson V, Lipski WJ, Blankertz B, Turner RS, Li N, et al. Electrocorticography is superior to subthalamic local field potentials for movement decoding in Parkinson's disease. eLife. 2022;11:e75126.

14. Bluestein LI. A linear filtering approach to the computation of discrete Fourier transform. IEEE Trans Audio Electroacoust. 1970;18(4):451–455.

15. Rabiner LR, Schafer RW, Rader CM. The chirp z-transform algorithm. IEEE Trans Audio Electroacoust. 1969;17(2):86–92.

16. Welch PD. The use of fast Fourier transform for the estimation of power spectra: a method based on time averaging over short, modified periodograms. IEEE Trans Audio Electroacoust. 1967;15(2):70–73.

17. Percival DB, Walden AT. Spectral analysis for physical applications: multitaper and conventional univariate techniques. Cambridge: Cambridge University Press; 1993.

18. Thomson DJ. Spectrum estimation and harmonic analysis. Proc IEEE. 1982;70(9):1055–1096.

19. Harris FJ. On the use of windows for harmonic analysis with the discrete Fourier transform. Proc IEEE. 1978;66(1):51–83.

20. Kay SM. Modern spectral estimation: theory and application. Englewood Cliffs: Prentice Hall; 1988.

21. Tort ABL, Komorowski R, Eichenbaum H, Kopell N. Measuring phase-amplitude coupling between neuronal oscillations of different frequencies. J Neurophysiol. 2010;104(2):1195–1210.

22. Swann NC, de Hemptinne C, Miocinovic S, Qasim S, Wang SS, Ziman N, et al. Gamma oscillations in the hyperkinetic state detected with chronic human brain recordings in Parkinson's disease. J Neurosci. 2016;36(24):6445–6458.

23. Cornelissen G. Cosinor-based rhythmometry. Theor Biol Med Model. 2014;11:16.

24. Maris E, Oostenveld R. Nonparametric statistical testing of EEG- and MEG-data. J Neurosci Methods. 2007;164(1):177–190.

25. Sassenhagen J, Draschkow D. Cluster-based permutation tests of MEG/EEG data do not establish significance of effect latency or location. Psychophysiology. 2019;56(6):e13335.

26. Shrout PE, Fleiss JL. Intraclass correlations: uses in assessing rater reliability. Psychol Bull. 1979;86(2):420–428.

27. Koo TK, Li MY. A guideline of selecting and reporting intraclass correlation coefficients for reliability research. J Chiropr Med. 2016;15(2):155–163.

28. Wilson EB. Probable inference, the law of succession, and statistical inference. J Am Stat Assoc. 1927;22(158):209–212.

29. Cohen J. A coefficient of agreement for nominal scales. Educ Psychol Meas. 1960;20(1):37–46.

30. Hauser RA, Friedlander J, Zesiewicz TA, Adler CH, Seeberger LC, O'Brien CF, et al. A home diary to assess functional status in patients with Parkinson's disease with motor fluctuations and dyskinesia. Clin Neuropharmacol. 2000;23(2):75–81.

31. Olanow CW, Kieburtz K, Odin P, Espay AJ, Standaert DG, Fernandez HH, et al. Continuous intrajejunal infusion of levodopa-carbidopa intestinal gel for patients with advanced Parkinson's disease: a randomised, controlled, double-blind, double-dummy study. Lancet Neurol. 2014;13(2):141–149.

32. Kemp B, Olivan J. European data format 'plus' (EDF+), an EDF alike standard format for the exchange of physiological data. Clin Neurophysiol. 2003;114(9):1755–1761.

33. Holdgraf C, Appelhoff S, Bickel S, Bouchard K, D'Ambrosio S, David O, et al. iEEG-BIDS, extending the Brain Imaging Data Structure specification to human intracranial electrophysiology. Sci Data. 2019;6(1):102.

34. Gorgolewski KJ, Auer T, Calhoun VD, Craddock RC, Das S, Duff EP, et al. The brain imaging data structure, a format for organizing and describing outputs of neuroimaging experiments. Sci Data. 2016;3:160044.

35. Borland D, Taylor MR. Rainbow color map (still) considered harmful. IEEE Comput Graph Appl. 2007;27(2):14–17.

**Software cited (not peer-reviewed publications):**

- perceive. Neumann Lab, Charité — Universitätsmedizin Berlin. https://github.com/neuromodulation/perceive
- BRAVO. Norman Fixel Institute for Neurological Diseases, University of Florida. https://github.com/Fixel-Institute/BRAVO
- py_neuromodulation. https://github.com/neuromodulation/py_neuromodulation
