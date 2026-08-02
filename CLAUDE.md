# CLAUDE.md — contrato de desenvolvimento do Percept LFP Studio

## Invariantes — nunca violar

1. **ZERO REDE.** Nenhuma requisição HTTP, nenhum CDN, nenhuma dependência de runtime, nenhuma
   telemetria. Todo cálculo acontece no navegador do usuário. Se uma funcionalidade parecer exigir
   rede, ela está fora de escopo — proponha alternativa local e pare.
2. **ZERO DEPENDÊNCIA** de biblioteca de terceiros no código que roda no navegador. FFT, filtros,
   estatística e plotagem são escritos do zero neste repositório. Dependências de
   desenvolvimento (test runner, linter) são aceitáveis apenas se não entrarem no bundle.
3. **PSEUDONIMIZAÇÃO NA BORDA.** Nome, data de nascimento, PatientId e número de série do
   neuroestimulador nunca saem do parser. Toda estrutura a jusante recebe apenas `subject_id`
   hasheado. Nenhuma exportação, log ou mensagem de erro pode conter identificador direto.
4. **index.html É GERADO.** Nunca edite `index.html` à mão. Edite `src/` e rode `cd src && node build.mjs`.
   A CI falha se estiverem dessincronizados.
5. **TESTE ANTES DE COMMIT.** `node tools/gerar_exemplo.mjs examples && node tests/run.mjs` precisa
   passar. Toda funcionalidade nova entra com teste. Nenhum teste existente pode ser removido ou
   afrouxado para fazer código novo passar.
6. **NÃO É DISPOSITIVO MÉDICO.** Ferramenta de pesquisa e apoio à decisão. Nenhuma string de UI, de
   relatório ou de documentação pode sugerir uso diagnóstico ou substituição do software regulado
   do fabricante.

## Honestidade metodológica — é o diferencial deste software

- Toda métrica derivada de escolha de parâmetro (percentil de burst, banda, limiar, número de
  componentes de SVD) exporta o parâmetro usado junto com o valor.
- Toda métrica exporta indicador de qualidade quando existir: n de amostras válidas, % de dados
  faltantes, R² do ajuste, flag de artefato.
- Nunca imputar dado faltante silenciosamente. Perda de pacote é NaN, e NaN é propagado com
  contabilidade explícita.
- Quando um método tem controvérsia documentada na literatura (definição de limiar de burst,
  Hilbert vs wavelet, escolha de banda a priori vs maior pico), a UI oferece a escolha, registra
  qual foi usada e cita a controvérsia.
- Prefira reportar "não é possível determinar com este dado" a produzir um número frágil.

## Estilo

- JavaScript ES2020+, módulos, sem transpilação. Comentários e UI em pt-BR; nomes de identificador
  em inglês para termos técnicos consagrados (`welchPSD`, `betaEnvelope`).
- Funções puras sempre que possível; estado concentrado no objeto de app.
- Cada função de método científico documenta em comentário: o que calcula, a referência
  bibliográfica e as unidades de entrada e saída.

## Referências de arquitetura (leitura, não dependência)

`perceive` (Charité, MATLAB) — perda de pacote, interpolação de QRS, saída BIDS-like, um extrator
por modalidade. `PerceptToolbox` (Thenaisie) — `correct4MissingSamples`. `DBSsync` (Vivien) — picos R
em duas passagens, SVD, fs efetiva, sincronização por artefato de estimulação. `BRAVO` (Fixel) —
`checkMissingPackage`, `extractPredictionModel`. `NeoDBS`/`DBScope` — janelas Individual vs Combined.
`py_neuromodulation` — features como módulos plugáveis.

## Mapa de módulos (ver docs/arquitetura.md)

O núcleo vive em `src/core/**` como módulos ES por responsabilidade. Regra de dependência:
`io` não importa `dsp`; `dsp` não importa `metrics`; `metrics` importa `dsp` e `stats`; nada importa
`app`. `src/build.mjs` resolve o grafo de imports e concatena em ordem topológica num `index.html`
único e autocontido. `src/core/index.js` é o barrel que monta `window.PerceptCore`.
