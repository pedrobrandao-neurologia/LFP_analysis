# Percept LFP Studio

**Local field potential (LFP) analysis for the Medtronic Percept™ — one file, in your browser, with no network.**

[Versão em português](README.md) · [Architecture](docs/arquitetura.md) · [Disease profiles](docs/perfis.md) · [Validation](docs/validacao.md) · [Reporting standard](docs/PERCEPT-REPORT.md)

> The application interface is available in Portuguese and English. Methodological text inside each figure remains in Portuguese — see *Declared limitations*.

---

## What it is

A **single-file** web application (`index.html`, 1297 KB) that reads the JSON *Session Reports* exported from the Medtronic Percept™ clinician programmer and produces **33 interactive figures** organised into seven tabs, quantitative metrics, a clinical PDF report and statistics-ready exports.

Opens by **double-click**. Nothing to install, no server required, and it never issues a single network request.

```
Report_Json_Session_Report_20250106T120000.json  →  drop it on the page  →  done
```

The repository ships two complementary pieces:

| | What | For what |
|---|---|---|
| **Percept LFP Studio** | single-file progressive web app (PWA) | clinic-side inspection, interactive exploration, presentation figures |
| **`R/percept_lfp.R`** | 1,280 lines of R | publication-grade analysis: mixed models, GAMMs, 300 dpi figures |

Both read the same file and produce largely the same figures.

### Three things that define the project

**1. Nothing leaves your computer.** The patient file is read by the browser's own `FileReader` and processed in memory. There is no server, no CDN, no telemetry, no analytics. Name, date of birth, `PatientId` and neurostimulator serial number **never leave the parser** — everything downstream sees only a hashed `subject_id` (truncated SHA-256). No export, log or error message can contain a direct identifier, and a pre-commit hook blocks commits containing identifying data.

**2. Zero dependencies.** FFT, filters, wavelets, multitaper, statistics, the PDF writer, the EDF+ writer, the ZIP compressor and the entire plotting layer are written from scratch in this repository. There is no `npm install`, no `<script src="https://...">`, no third-party library in the code that runs in the browser. What reaches the browser is what is in the repository — auditable line by line.

**3. Every metric carries the parameter that produced it.** Any number that follows from a choice — burst percentile, band, threshold, number of SVD components — is reported together with the parameter used, the available quality indicator (n of valid samples, % missing data, fit R²) and the relevant methodological caveat. When the data do not support a conclusion, the software **says so** instead of producing a fragile number.

---

## How to use it

1. Open `index.html` (double-click), or use the GitHub Pages deployment.
2. Drop one or more `Report_Json_Session_Report_*.json` files onto the page.
3. Figures appear. The side rail shows the matrix of available modalities, the disease profile, the signal-quality traffic light and the export buttons.

Load **several files from the same person** at once: chronic Timeline series are concatenated and de-duplicated automatically, and each figure picks the appropriate source. The **+ folder** button ingests a whole directory (cohort mode).

### Seven tabs, and the hierarchy they encode

Navigation is organised into tabs because the difference between an **acute** and a **chronic** recording is not one of time scale — it is epistemological, and treating it as a display filter is the source of much of the error circulating in the Percept literature.

|  | Acute recording | Chronic recording |
|---|---|---|
| Design | experimental, controlled | observational, ecological |
| Inference | causal, driven by the design | association within naturalistic variation |
| Sampling | sparse in time, rich in spectrum (~250 Hz) | dense in time, poor in spectrum (one scalar per bin) |
| Unit of analysis | trial / event / condition | timestamp / day / dose |
| Internal structure | epoched array | irregular long table with gaps |
| Setting | clinic, supervised | home, unsupervised |
| Dominant risk | low *n*, synchronisation noise | confounding by configuration change |

| Tab | Layer | What lives there |
|---|---|---|
| **Home** | — | Question-first triage: 14 clinician and researcher questions; each states whether **this** file answers it and jumps straight to the figure, or explains what is missing |
| **Acute** | experimental | Spectrum, montage, time domain, spectrogram, wavelet, PAC, gamma, external signal, stimulation ramp |
| **Chronic** | observational | Timeline, configuration blocks, circadian rhythm, ON/OFF states, hour × day matrix, levodopa response |
| **Bridge** | both | Biomarker passport (descending), agenda for the next session (ascending), candidate aDBS threshold over the real 30-day histogram (convergence) |
| **Quality** | transversal | Artefact alarm, peak reproducibility, electrode integrity, QC panel |
| **Cohort** | group | Tidy table by subject and hemisphere, prevalence with Wilson CI |
| **Report** | — | What leaves this software for the chart and for the manuscript |

Every tab opens with an orientation header declaring **the inference layer**, what it answers well, what it cannot answer no matter how much data it has, the dominant risk, and — mandatorily — **the boundary that must not be crossed**. The recurring fallacy in the field is using a ten-minute acute finding to interpret a six-week chronic trend, or the reverse, as if they measured the same quantity.

### Two modes

| Mode | For what | What it shows |
|---|---|---|
| **Clinical** | Consultation, programming decisions | The subset of figures that answers clinic questions, chosen by the disease profile, plus plain-language readings |
| **Research** | Analysis, publication | All 33 figures, all parameter controls, all exports |

The same numbers, the same caveats and the same declared parameters in both modes — clinical mode hides figures, never uncertainty. The preference is stored in `localStorage` (interface preference only; no patient data is ever written to disk).

### Disease profiles

The software does not assume every patient has Parkinson's disease. Five profiles change the primary band, the peak-search method, the normalisation, the clinical-mode figure set and the glossary:

| Profile | Target | Primary band | Distinctive feature |
|---|---|---|---|
| Parkinson's disease | STN / GPi | beta 13–35 Hz | ON/OFF detector; Hauser diary matrix |
| Dystonia | GPi | theta-alpha 4–12 Hz | Control for head tremor; importable symptom series |
| Essential tremor | VIM | tremor 4–10 Hz | Fundamental frequency detected from the spectrum |
| Epilepsy | ANT | broadband | No peak assumption |
| Generic | any | configurable | All bands adjustable |

The profile is suggested from the JSON content (lead target, sensing band) and can be changed at any time.

---

## The 33 figures

### Acute signal — spectrum and time domain

| # | Figure | Requires | Answers |
|---|---|---|---|
| **F1** | Annotated spectrum and **Survey sweep** | `LFPMontage`, `SenseChannelTests` | Where the marker peak is and **which contact pair carries it best** — all bipolar pairs of one hemisphere shown together as a ridgeline, ranked, best one highlighted, with the top-3 combinations listed |
| **F2** | Periodic / aperiodic decomposition | any spectrum | How much of the peak is real oscillation and how much is the 1/f background |
| **F5** | Montage map — channel × frequency | `LFPMontage` | Which contact combination has the strongest marker, as a heatmap |
| **F6** | Time domain — trace, spectrogram, bursts | `BrainSenseTimeDomain` | How the signal behaves second by second; where the bursts are |
| **F18** | **Multitaper** spectrum with confidence interval | raw signal | Does the peak survive once uncertainty is declared? |
| **F19** | Full **specparam** — fixed or knee, peak width, R² | raw signal | Rigorous periodic/aperiodic separation, with AIC model selection |
| **F20** | **Morlet wavelet** — scalogram and bracketed bursts | raw signal | Where each burst **starts and ends**, and whether the duration is the brain's or the chosen resolution's |
| **F21** | **PAC** — phase-amplitude coupling and comodulogram | raw signal (fs ≥ 250 Hz) | Whether gamma amplitude tracks beta phase |
| **F22** | Finely-tuned gamma vs. entrained gamma at f_stim/2 | spectrum reaching 95 Hz | Whether a gamma peak is endogenous or an echo of stimulation itself |
| **F30** | **Spectrogram following BRAVO** | raw signal | How the spectrum changes across the recording, by five methods, using the `scipy` density scaling |
| **F34** | **ODR and windowed features** | raw signal | How theta, peak gamma and low beta move together across the recording, with inter-STN coherence and the spectral variation of the envelope |

### Chronic signal — days and weeks

| # | Figure | Requires | Answers |
|---|---|---|---|
| **F8** | Chronic Timeline — multi-day series | `LFPTrendLogs` | How the marker behaves over weeks |
| **F9** | **Circadian rhythm** — day × hour heatmap, polar, cosinor | `LFPTrendLogs` (≥ 2 days) | Whether a 24 h rhythm exists, its amplitude and acrophase — with CI by whole-day block bootstrap |
| **F10** | Event-aligned response | Timeline + marked events | What happens to the marker around what the patient recorded |
| **F12** | Spectra by event type | `LfpFrequencySnapshotEvents` | Whether OFF, dyskinesia and "took medication" have distinct spectra |
| **F13** | ON/OFF states from beta amplitude | Timeline or streaming | Whether beta separates two states, and how well (Sarle's bimodality, separation in SD) |
| **F25** | Double-plotted **actogram** and **control band** | Timeline + dated snapshots | Whether the peak hour drifts across days, and whether the diurnal pattern is **band-specific** |
| **F28** | **Hour × day matrix** — ON/OFF linked to their integral | Timeline and/or Hauser diary CSV | *Where* in the day the OFF falls: morning delayed-on, afternoon wearing-off, or fragmented — the information stacked bars destroy |
| **F29** | Levodopa response aligned to intake marks | Timeline + medication events | Whether beta drops after the dose, with what latency and for how long — or whether that cannot be separated from the diurnal rhythm |
| **F32** | **Configuration blocks and change points** | Timeline + at least one session with declared sensing | Whether a change across weeks is biological or the device started measuring something else — the series is **split** at the boundary and the line refuses to cross it |

### The bridge between layers

| # | Figure | Requires | Answers |
|---|---|---|---|
| **F31** | **Biomarker passport** | Survey, Signal Test or raw signal | *(descending — calibration)* Which bipolar pair, which peak, which band and which SNR the acute session defined, with a versioned fingerprint, and whether the current device configuration still reproduces it |
| **F33** | **Agenda for the next session** | Chronic Timeline | *(ascending — hypothesis generation)* What the chronic record observed and cannot explain, turned into an acute protocol, stating what each protocol **would settle**. Never therapeutic conduct |

Eight automatic checks feed the agenda: emerging interhemispheric asymmetry, loss of dose response, reproducible circadian anomaly, baseline drift, unstable configuration, outdated passport, poor coverage and fragmented rhythm. Each returns a finding, numerical evidence, a suggested protocol, what it would settle, and a confidence — and every check the data did not permit goes into `notChecked` with the reason and what would be needed.

### Stimulation, aDBS and thresholds

| # | Figure | Requires | Answers |
|---|---|---|---|
| **F7** | Streaming with stimulation — power × amplitude | `BrainSenseLfp` | Whether marker power falls with current, and along which curve |
| **F11** | Power distribution and aDBS thresholds | Timeline | How much time the signal would spend above, between and below candidate thresholds |
| **F23** | **aDBS — eligibility and threshold simulator** | Timeline + spectrum | Whether this patient is a candidate for adaptive stimulation, with explicit criteria, and what each threshold pair would do |

### Quality, artefact and integrity

| # | Figure | Requires | Answers |
|---|---|---|---|
| **F3** | Electrode integrity | `Impedance` | Whether any contact is out of range |
| **F4** | Session timeline and parameters | `EventLogs`, `Groups` | What was done during the visit and in which order |
| **F15** | **Cardiac artefact removal** — three methods and validation | raw signal | Whether QRS contaminates the LFP, which method removes it best **in this recording**, and how much neural signal survived |
| **F16** | QC — peak reproducibility across recordings | ≥ 2 sessions | Whether today's peak is the same as before, or the measurement changed |
| **F17** | **Quality control panel** | any | The traffic light: what is verifiable in this file, what is not, and why |

### External signals and cohort

| # | Figure | Requires | Answers |
|---|---|---|---|
| **F24** | External signal — IMU, EMG, ECG: alignment and **coherence** | raw signal + external CSV/TSV | Whether the LFP oscillation is the brain's or the movement itself entering through the electrode |
| **F26** | Longitudinal — impedance, **ICC**, device usage | ≥ 2 sessions | Whether what changed between visits was the brain or the measurement |
| **F27** | **Cohort** — all records side by side | ≥ 1 record | Peak prevalence with Wilson CI, per-subject table, group statistics |

Every figure exports a PNG and the underlying data as CSV.

---

## Implemented methods

Everything below is original code written in this repository, with no external library.

### Parsing and signal integrity

- **Parser** for all Session Report modalities: `LFPMontage`, `LfpMontageTimeDomain`, `BrainSenseTimeDomain`, `BrainSenseLfp`, `DiagnosticData.LFPTrendLogs`, `LfpFrequencySnapshotEvents`, `Impedance`, `Groups`/`SensingSetup`, `EventLogs`, `GroupUsagePercentage`, `BatteryInformation`.
- **Packet loss** detected from `GlobalSequences` or `TicksInMses`, with gaps inserted as **NaN** — never silently interpolated. The accounting (% missing, longest contiguous gap) travels with every derived metric.
- **Effective sampling rate** measured from the ticks, with a drift warning when it matters for event alignment or external synchronisation.
- **Robust time zone** handling: detection of daylight-saving transitions and offset breaks, with segmentation when needed.
- **Device state** inferred (stimulation on/off, active group) and comparability between recordings checked.

### Signal processing

| Method | Detail |
|---|---|
| **FFT** | Radix-2 Cooley-Tukey; **Bluestein (chirp-z)** for arbitrary N |
| **Welch PSD** | Periodic Hann, 50% overlap, per-segment detrending, NaN-tolerant |
| **Multitaper** | DPSS/Slepian via the tridiagonal formulation (Percival & Walden), Sturm bisection, inverse iteration with the Thomas algorithm; jackknife CI |
| **specparam / FOOOF** | Robust aperiodic fit, iterative bounded Gaussians, simultaneous Levenberg-Marquardt refinement, fixed-vs-knee selection by AIC |
| **Wavelet** | Morlet CWT by FFT convolution, cone of influence as NaN |
| **Bursts** | Detection and **bracketing** kept separate; threshold by percentile or from the 1/f aperiodic background |
| **PAC** | Tort modulation index, comodulogram, time-shift surrogates, imaginary coherency, peak-trough waveform asymmetry |
| **Coherence** | Magnitude-squared from the Welch cross-spectrum, 1/L null, Šidák band correction, delay from phase slope and from peak phase |
| **Filters** | FFT band-pass, Hilbert envelope, notch with automatic line-frequency suggestion |
| **Spectrogram** | Welch per epoch, STFT (Hamming), Percept on-board PSD emulation, wavelet, autoregressive (Yule-Walker + BIC) |

### Cardiac artefact

Three independent methods, **with quantified validation instead of faith**: QRS interpolation, template subtraction and low-rank SVD. Two-pass R-peak detection. For each method the software measures ECG suppression in dB, beta-peak recovery, band-power preservation and correlation with the clean signal — and reports **which one won in this recording**, not which is best in general.

### Statistics

- **Cosinor** with 24 h and 12 h harmonics; CI by **whole-day block bootstrap** (preserving intraday autocorrelation), accelerated by additive per-day normal equations, with a fixed seed for reproducibility.
- **AR(1) correction** of the cosinor p-value via effective n; Rayleigh test for daily acrophases; η² by hour of day.
- **Cluster-based permutation** (Maris & Oostenveld) with the Sassenhagen & Draschkow caveat embedded in the output.
- **Two-sample permutation** with **exact** enumeration when the number of partitions allows, and a fixed seed when it does not.
- **Non-parametric chronobiology** borrowed from actigraphy, because the beta rhythm is often not sinusoidal and the cosinor underestimates amplitude when it cannot follow the corners: **IS** (interdaily stability), **IV** (intradaily variability), **M10/L5** and **RA** (relative amplitude, unit-invariant). These are descriptive — they test nothing; what tests whether a rhythm exists is the cosinor, and both readings are reported together.
- **Windowed features** following Habets et al. (*Brain* 2026): **ODR** = (θ × γpeak)/β↓, **spectral variation** (CV of the Hilbert envelope) and **inter-STN coherence**, all over 5/10/30 s windows. The ODR is reported in both formulations — the logarithmic `z(log θ) + z(log γ) − z(log β)`, which is the same ratio without a division, and the article's literal form, which is unstable because it divides by a z-scored value that crosses zero by construction — together with the correlation between them and the fraction of windows where the literal one escapes. Guards: the computation is **refused** when the gamma peak falls at f_stim/2 (the numerator would be measuring the network's response to its own stimulation, and the two clinical readings are opposite), and substituting broadband gamma for the individual peak is never silent. See [`docs/odr.md`](docs/odr.md).
- **Change-point detection** by binary segmentation with a two-sample CUSUM over the daily value, significance by permutation of the window itself, with optional block permutation to preserve autocorrelation — and annotation against known markers, separating an explained step from an orphan one. *Not a t-test between "before and after".*
- **ICC(2,1) and ICC(3,1)** with F-based CI — both, because the choice changes the number.
- **Wilson CI** for proportions; Sarle's bimodality coefficient; Cohen's kappa with CI.

### Models and simulation

- **aDBS eligibility** with explicit criteria and reference prevalence.
- **Threshold simulator**: what each threshold pair would do, measured on the patient's own Timeline.
- **Dose-response** by Levenberg-Marquardt, with the model choice declared.

---

## Methodological honesty — what distinguishes this software

These rules live in the project's development contract ([`CLAUDE.md`](CLAUDE.md)) and are enforced by the test suite.

1. **Every parameter is exported alongside the value.** A burst detected at the 75th percentile is reported with "75th percentile" next to it. Changing the percentile changes the number, and the reader needs to know which one was used.

2. **Every available quality indicator is exported.** n of valid samples, % missing data, fit R², artefact flag.

3. **Missing data are never silently imputed.** Packet loss is NaN, and NaN is propagated with explicit accounting. A spectrogram epoch containing a gap is drawn as a white band, not as plausible power.

4. **Documented controversy becomes a choice in the interface.** Burst threshold definition, Hilbert vs. wavelet, a priori band vs. largest peak, ICC(2,1) vs. ICC(3,1): the UI offers the choice, records which was used, and cites the controversy.

5. **"This cannot be determined from these data" is a valid answer** — and often the correct one. With fewer than 3 subjects the ICC is refused with the statistical reason. If the levodopa response curve does not separate from chance, latency and duration are **not reported**.

6. **Absence of verification is not absence of finding.** The artefact alarm and the session agenda return, alongside what they found, the list of what they **could not** check and why. A file with no raw signal may come back "no alarm" with thirteen impossible checks; reporting only "no alarm" would be lying by omission.

7. **The inference layer is declared, and improper crossing is forbidden.** Each tab states whether what it holds is observational or experimental, and which boundary must not be crossed. The chronic series refuses to be plotted as one continuous line across a sensing-configuration change — because on either side of that boundary it is not the same variable.

8. **The agenda suggests investigation, never conduct.** Every suggested protocol passes a filter that rejects prescriptive verbs, and each item is flagged `conductFree`. The software does not suggest changing contacts, amplitudes, medication or aDBS programming.

9. **Not a medical device.** A research and decision-support tool. No interface, report or documentation string suggests diagnostic use or replacement of the manufacturer's regulated software.

---

## Exports

| Format | Content |
|---|---|
| **PNG** | Any figure; the hour × day matrix exports at 2× by re-rendering, not by stretching the bitmap |
| **CSV** | Acute metrics, chronic metrics, raw Timeline, and the underlying data of each figure — English column headers for the R scripts |
| **JSON** | Complete metric package for statistical analysis |
| **Native PDF** | Clinical report written from scratch (PDF 1.4, base-14 Helvetica, WinAnsiEncoding with real glyph widths, figures embedded as JPEG) |
| **DOCX** | Filled reporting checklist |
| **EDF+** | Raw signal in the European standard, with missing samples at the digital minimum |
| **BIDS-like** | Derived iEEG structure (non-conformant — see limitations) |
| **ZIP** | Complete package in one file, with a provenance manifest |

### Provenance manifest

Every export can be accompanied by a manifest containing the SHA-256 hashes of the input files, the software version, the parameters of each figure, the seeds of every stochastic procedure, and where each computation ran (main thread or Web Worker). The manifest is verifiable: `verifyManifest()` recomputes the hashes and reports what changed.

### Command line

`tools/cli.mjs` runs the same core over an entire folder, without a browser, producing CSV/JSON/EDF. It does not generate figures — and says so.

---

## Validation

### Quantitative benchmark against ground truth

`node tests/benchmark.mjs` generates synthetic signals with known parameters and measures what the pipeline recovers. **87 criteria, all passing.** A selection:

| Metric | Condition | Value | Criterion |
|---|---|---|---|
| R-peak detection — true positives | SNR −10 dB | 100% | ≥ 95% |
| R-peak detection — false positives | SNR −10 dB | 0% | ≤ 1% |
| Correlation with the clean signal (SVD) | SNR −10 dB | 0.968 | > 0.90 |
| Packet-loss detection (Jaccard) | 0–10% loss | 1.00 | > 0.99 |
| Effective sampling-rate error | 0–10% loss | 0.0016 Hz | < 0.005 Hz |
| Peak-frequency error | three profiles | 0.07–0.11 Hz | < 0.5 Hz |
| Aperiodic-exponent error (specparam) | χ = 1, 1.5, 2.2 | 0.0013–0.0022 | < 0.10 |
| specparam model R² | χ = 1, 1.5, 2.2 | 1.00 | > 0.95 |
| DPSS orthonormality | N=512, NW=4, K=7 | 0 | < 10⁻⁸ |
| Wavelet burst F1 | SNR 20 dB | 0.980 | > 0.75 |
| PAC — detects true coupling | simulated beta→gamma | z = 23.7 | > 5 |
| PAC — rejects uncoupled control | no coupling | z = −0.20 | < 3 |

The benchmark runs in continuous integration with `--check`, which **fails the build** on any regression against the stored baseline.

### Analytic verification of the spectrogram

The density scaling is checked against exact identities rather than against another implementation:

- **Parseval**: a sinusoid of amplitude 3 → integral of the PSD over frequency = **4.5000**, exactly A²/2.
- **White noise**: flat PSD at σ²/(fs/2) — ratio 0.99 for Welch, STFT and AR.
- **Bluestein against the DFT definition**: maximum relative error **2.3 × 10⁻¹⁴** for N ∈ {3, 7, 61, 250, 500}.
- **Known AR(2)**: BIC selects order 2; the peak falls at 26.00 Hz against a theoretical resonance of 26.74 Hz.

### Regression suite

`node tests/run.mjs` — **309 tests**, including all 33 figure renderers exercised against a minimal simulated DOM. No existing test may be removed or weakened to make new code pass.

---

## Development

```bash
node tools/gerar_exemplo.mjs examples   # synthetic dataset (no real data)
cd src && node build.mjs                # generates index.html from src/
node tests/run.mjs                      # 309 tests
node tests/benchmark.mjs --check        # 87 criteria, fails on regression
```

**`index.html` is generated. Never edit it by hand.** The core lives in `src/core/**` as **59 ES modules** organised by responsibility (~10,500 lines). `src/build.mjs` resolves the import graph, sorts it topologically, detects cycles and identifier collisions, and concatenates everything into a self-contained file. CI fails if `index.html` is out of sync with `src/`.

Dependency rule: `io` does not import `dsp`; `dsp` does not import `metrics`; `metrics` imports `dsp` and `stats`; **nothing** imports `app`.

Install the hook that blocks commits containing identifying data:

```bash
cp tools/pre-commit .git/hooks/ && chmod +x .git/hooks/pre-commit
```

---

## Lead schematic, to scale, with the contacts in use marked

The lead model is **detected automatically** from `LeadConfiguration`, and every figure that names
contacts now shows the lead drawn to real scale with that figure's contacts highlighted: the
bipolar pair whose spectrum is shown (F1), the contacts outside the manufacturer's short/open
limits (F3), the pair behind a trace (F6) or a spectrogram (F30), cathode + anode + sensing pair
together (F7), and where the biomarker was defined (F31).

Models with geometry: **3387**, **3389**, **3391**, **SenSight B33005** and **B33015** — contact
height, spacing, array length, distal tip and body diameter in millimetres, from the implant
manuals (3387/3389, 2020; SenSight, 2021).

**Why this is not decoration.** A "0-3" pair spans **7.5 mm** on a 3389, **10.5 mm** on a 3387 and
**24 mm** on a 3391 — same label, different anatomical situations.

Three honesty decisions worth noting: an unrecognised model is **not** drawn as a generic lead (the
panel says so and why); on a directional lead there is **no contact "1"** — level 1 is 1a/1b/1c and
the device shorts all three, which is what the drawing shows and explains; and the **anatomical
orientation of the segments is never asserted** — the a/b/c angles are nomenclature, while the real
rotation comes from the radiopaque marker on the intraoperative radiograph and is not in the JSON.
The 3391 dimensions are flagged as **not verified against the implant manual**.

Reference vector figures in [`docs/referencias/eletrodos/`](docs/referencias/eletrodos/).

---

## Conformance with the manufacturer's white paper

The software was audited item by item against Medtronic's *DBS Sensing White Paper*
(**UC202012929cEN, FY24**, copy in [`docs/referencias/`](docs/referencias/)). The full report is in
[`docs/auditoria-whitepaper.md`](docs/auditoria-whitepaper.md).

The three corrections that changed numbers:

- **Censored data is negative.** The device flags with a negative sign the samples it discarded
  itself on suspicion of artefact (p. 24, 25). They were entering as power across the whole chronic
  layer — median, cosinor, aDBS thresholds, ON/OFF states, levodopa response. They now become `NaN`
  with accounting kept **separate** from packet loss, plus an alarm of their own.
- **BrainSense Streaming sequences are interleaved** between the raw-signal and power streams
  (p. 23, 24). A jump of 1 is normal behaviour — read as a continuous counter they reported
  **nearly 50% false loss** on every streaming recording, degrading Welch, spectrogram, ODR, bursts
  and the quality seal.
- **`CalibrationTests` runs with stimulation ON** (p. 15) and was classified as OFF. It is the
  OFF/ON pair from the same patient in the same session: the warning about comparing spectra from
  different states failed to fire exactly where it should.

The document also resolved a list of "assumed" items: the filter chain (2× low-pass at 100 Hz, a
fixed 1 Hz high-pass and a second one configurable at 1 or **10 Hz** — which at 10 Hz **removes
theta and delta** and now raises an alarm), the ~5 Hz band width, the Timeline unit (sum of squared
magnitude within the band), the blanking window, `FullyReadForSession`, the manufacturer's impedance
limits, and two modalities that were not being read at all: **`IndefiniteStreaming`** (Record
Streaming — long recordings, three channels per lead, **stimulation off**) and **`Thresholds`**.

---

## Declared limitations

These are not hidden flaws — they are the scope, and they are here because anyone using the software needs to know them first.

1. **No validation on real patient data has been published.** The entire benchmark uses synthetic signals with known ground truth and analytic identities. Agreement with clinical judgement, agreement with other toolboxes on the same recording, and cross-centre reproducibility **have not yet been measured**.

2. **The BIDS export is *BIDS-like*, not conformant.** The structure follows iEEG-BIDS logic but has not been run through the official validator.

3. **The English translation covers the interface frame and the figure titles**, not the methodological text inside them. A hasty translation of text explaining a methodological limitation is worse than text in another language.

4. **The Percept on-board PSD emulation uses an empirical constant (1/54)** inherited from BRAVO, undocumented by the manufacturer. It reproduces the *dynamics* of what the device reports; it does not validate the absolute scale.

5. **The 1/f detrending in the spectrogram is a robust log-log regression, not full FOOOF.** Full specparam is available in F19.

6. **The CLI does not generate figures.**

7. **The software is not a medical device** and does not replace the manufacturer's regulated software.

---

## Architectural references

Reading that informed the design — not dependencies:

- **perceive** (Neumann lab, Charité) — packet loss, QRS interpolation, BIDS-like output, one extractor per modality.
- **PerceptToolbox** (Thenaisie et al.) — `correct4MissingSamples`.
- **DBSsync** (Vivien et al.) — two-pass R-peak detection, SVD, effective fs, synchronisation via stimulation artefact.
- **BRAVO** (Fixel Institute) — `checkMissingPackage`, `extractPredictionModel`, and the spectrogram suite ported in F30.
- **DBScope** / **NeoDBS** — Individual vs. Combined windows.
- **py_neuromodulation** (Merk et al.) — features as pluggable modules.

---

## Citation

If this software is useful in your research, please cite the repository. A manuscript describing the tool is in preparation — see [`docs/paper/`](docs/paper/).

## License

MIT — see [`LICENSE`](LICENSE).

---

> **Notice.** A research and decision-support tool. **Not a medical device.** It is not intended for diagnosis and does not replace the neurostimulator manufacturer's regulated software. All clinical decisions remain the responsibility of the treating professional.
