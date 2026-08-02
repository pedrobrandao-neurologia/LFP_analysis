# Perfis de doença

Até a Onda 5 o software falava **uma doença só**: bandas, leitura clínica, glossário e figuras
estavam cabeados em doença de Parkinson e STN. A revisão aponta que **distonia e tremor essencial
estão sub-representados em todas as ferramentas existentes** — é lacuna real do campo, e a mais
barata de ocupar.

Cada perfil é um objeto **declarativo, sem lógica** (`src/core/profiles/index.js`). A UI, o glossário,
o CSV exportado e o relatório leem o perfil ativo; nenhuma banda ou leitura clínica volta a ficar
fixa em `app.js`.

O perfil é **sugerido automaticamente** a partir do `Diagnosis` e do `LeadLocation` do JSON, e o
usuário confirma ou troca. O perfil usado é exportado em toda linha de métrica (`profile_id`) e
aparece na capa do relatório.

## Tabela comparativa

| | **Parkinson (STN/GPi)** | **Distonia (GPi)** | **Tremor essencial (VIM)** | **Epilepsia (ANT)** | **Genérico** |
|---|---|---|---|---|---|
| **Banda primária** | beta 13–35 Hz | **teta-alfa 4–12 Hz** | **frequência do tremor** (2–12 Hz, medida) | teta 4–8 Hz | definida pelo usuário |
| **Normalização** | corrigida pelo aperiódico | **`sd_6_96hz`** | relativa | relativa | relativa |
| **Seleção de banda crônica** | a priori (beta) | maior pico | maior pico | maior pico | maior pico |
| **Banda de burst** | 13–30 Hz | 4–12 Hz | 3–10 Hz | 4–13 Hz | 13–30 Hz |
| **Sinais externos recomendados** | — | **IMU** | **acelerômetro** | — | — |
| **Armadilha específica** | — | tremor cefálico (1–6 Hz) cai sobre o biomarcador | frequência não é banda fixa; artefato de EKG é crítico | caracterização inicial | — |

## Por que cada escolha

### Parkinson (STN/GPi) — o comportamento anterior, preservado

Banda primária **beta 13–35 Hz**, com subdivisão β↓ 13–20 e β↑ 20–35 — a subdivisão é
metodologicamente relevante porque a resposta à levodopa é diferencial (o beta baixo responde mais).
Normalização por **correção do componente aperiódico**; seleção de banda crônica **a priori**.
Todas as leituras clínicas do glossário anterior foram preservadas.

### Distonia (GPi)

- **Banda primária teta-alfa 4–12 Hz.** Thenaisie et al. descrevem frequência média de pico de
  **5,7 Hz (DP ± 2,1)**, com o pico máximo no par 0-3 em 6 de 8 GPi.
- **Normalização `sd_6_96hz`**: PSD por Welch → remoção do componente 1/f → divisão pelo
  desvio-padrão calculado **entre 6 e 96 Hz**. Essa normalização existe especificamente para
  minimizar a contaminação espectral por **movimentos distônicos fásicos e mioclonias**.
- **Aviso obrigatório sem IMU.** O tremor cefálico da distonia cervical ocorre a **1–6 Hz** e cai
  **diretamente** sobre o biomarcador teta-alfa do GPi. Sem canal de IMU para regredir o movimento,
  o risco de reportar artefato mecânico como biomarcador é real — o app exibe a ressalva e marca as
  métricas de teta-alfa.
- **Correlação sintoma-LFP**: `spearman()` com IC por bootstrap e `movingAverageDays()`
  (default 5 dias, como em Hubers et al., que reportam ρ = −0,69, p < 0,001 entre gravidade da
  distonia e potência do LFP no GPi contralateral).
- Nota registrada no glossário: em Hubers et al. **não foi possível detectar pico claro no GPi
  direito** — ausência de pico em um lado é achado comum e não invalida o outro.

### Tremor essencial (VIM)

- O biomarcador **não é uma banda fixa**: é a **frequência do tremor** daquele paciente e seus
  **supraharmônicos**. `detectTremorFrequency()` busca a fundamental em 2–12 Hz — **do acelerômetro
  quando houver** (mais confiável), senão do maior pico do LFP — e depois procura atividade em 2·f e
  3·f, reportando a razão supraharmônica/fundamental.
- As bandas do perfil são **derivadas** da frequência medida: f₀ ± 1 Hz e 2f₀ ± 1,5 Hz.
- **Coerência LFP–acelerômetro** na frequência do tremor e na supraharmônica é o método de validação
  central deste perfil: é o que distingue oscilação talâmica real de artefato mecânico.
- **Métrica de resposta é o desacoplamento**, não a supressão: Fung et al. mostram que a estimulação
  pode suprimir pouco a potência do LFP e ainda assim desacoplar tremor e LFP.
- Aviso permanente: com o PC+S, a ocorrência frequente de **artefatos de EKG** impediu a análise
  talâmica automática para closed-loop — verificar contaminação cardíaca (F15) é especialmente
  crítico aqui.

### Epilepsia (ANT)

Bandas padrão de EEG com ênfase em **ciclos de longo prazo**. Caracterização ainda inicial na
literatura — o perfil marca os resultados como exploratórios.

### Genérico configurável

Perfil aberto, com bandas, rótulos e leituras clínicas definíveis pelo usuário. É o que permite ao
software acompanhar **biomarcadores que ainda não existem na literatura**, e compartilhar a
definição entre centros como um JSON de perfil.

## Referências por perfil

**Parkinson** — Neumann W-J, et al. *Brain Stimul* 2021;14:1301-1306 · Mathiopoulou V, et al.
*Nat Commun* 2025;16:2956 · van Rheede JJ, et al. *npj Parkinsons Dis* 2022;8:88.

**Distonia** — Thenaisie Y, et al. *J Neural Eng* 2021;18:042002 · Hubers D, et al. *Mov Disord*
2025 · COMEDD study protocol. *Dystonia* 2026.

**Tremor essencial** — Buijink AWG, et al. *Clin Neurophysiol Pract* 2022;7:103-106 · Fung W, et al.
*Mov Disord* 2025 · *Sci Rep* 2023;13 (beta talâmico para closed-loop).

**Epilepsia** — *J Neural Eng* 2024. doi:10.1088/1741-2552/ad1dc3.

## Figuras do modo clínico

Cada perfil declara, em `clinicalFigures`, as seis figuras que o modo clínico mostra. É uma
escolha do perfil, não da interface — mostrar F13 (estados ON/OFF pela amplitude do beta) num
paciente com distonia sugeriria uma leitura que o dado não sustenta, já que o detector é definido
sobre beta.

| perfil | figuras do modo clínico |
| --- | --- |
| Parkinson | F1, F6, F8, F9, F11, F13 |
| Distonia | F1, F5, F6, F8, F9, F11 |
| Tremor essencial | F1, F5, F6, F8, F9, F11 |
| Epilepsia | F1, F5, F6, F8, F9, F11 |
| Genérico | F1, F6, F8, F9, F11, F13 |

Há teste que falha se um perfil declarar uma figura inexistente.

---

## Como adicionar um perfil

1. Acrescente uma entrada em `PROFILES` (`src/core/profiles/index.js`) com `bands`, `primaryBand`,
   `normalization`, `chronicBandSelection`, `glossary` e `references`.
2. Liste `diagnoses` e `targets` para que a sugestão automática funcione.
3. Se houver armadilha específica, declare em `warnings` com a condição (`no_imu`,
   `no_accelerometer`, `always`).
4. Rode `cd src && node build.mjs && cd .. && node tests/run.mjs` — a suíte verifica que **todos** os
   perfis carregam com estrutura completa e renderizam as figuras.
