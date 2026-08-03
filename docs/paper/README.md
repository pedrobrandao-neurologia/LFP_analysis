# Manuscrito para o Journal of Neuroscience Methods

Pacote de submissão em preparação. Redigido segundo ICMJE 2024, com a estrutura de resumo exigida pelo JNM (Background / New method / Results / Comparison with existing methods / Conclusions).

| Arquivo | O que é |
|---|---|
| [`manuscript.md`](manuscript.md) | Manuscrito completo — fonte em Markdown, sob controle de versão |
| `manuscript.docx` | Mesmo conteúdo em DOCX, para o sistema de submissão (gerado por `gerar_docx.py`) |
| [`cover-letter.md`](cover-letter.md) | Carta de apresentação |
| `gerar_docx.py` | Converte o Markdown em DOCX (Times 12, espaço duplo, numeração de linha e de página) |

Gerar o DOCX:

```bash
pip install python-docx
python3 docs/paper/gerar_docx.py
```

---

## O que falta antes de submeter

Estas pendências exigem decisão ou informação que só o autor tem. Estão listadas aqui para que nenhuma passe despercebida.

### Obrigatórias

- [ ] **Verificar TODAS as 35 referências contra o original.** Elas foram compiladas sem acesso a base bibliográfica; volume, página e ano podem conter erro. Confira cada uma no PubMed e exporte a lista final de um gerenciador de referências no estilo numérico da Elsevier. Há um aviso explícito no topo da seção de referências do manuscrito — **remova-o depois de conferir**.
- [ ] **Preencher afiliação, endereço postal e ORCID** na *title page* (marcados com `[...]`).
- [ ] **Ler as *Instructions for Authors* do JNM** e conferir limites de palavras, formato de referência e ordem das seções. O JNM muda esses limites periodicamente.
- [ ] **Produzir as três figuras.** As legendas estão escritas no manuscrito; as figuras em si não existem ainda. A Figura 3 pode ser gerada a partir da saída de `node tests/benchmark.mjs --out benchmark/`.
- [ ] **Preencher o ICMJE Disclosure Form.**
- [ ] **Rodar detecção de plágio** (iThenticate/Turnitin) antes de submeter.

### Decisões suas

- [ ] **Coautoria.** O manuscrito está redigido com autor único. Se alguém participou de concepção, análise ou revisão crítica, os quatro critérios do ICMJE precisam ser avaliados — inclusive na direção que se costuma esquecer: quem preencheu os critérios e ficou de fora.
- [ ] **Declaração de uso de IA.** A redação atual é deliberadamente franca sobre o uso substancial de IA na implementação e na redação (Métodos §2.10 e declarações). Está de acordo com o ICMJE 2024. Se preferir outra formulação, ela precisa continuar cobrindo: qual ferramenta, em que etapa, e quem assume responsabilidade.
- [ ] **A limitação central** — ausência de validação em dado real — aparece no resumo, na discussão, nas conclusões e na cover letter. É a decisão editorial mais consequente do pacote. Suavizá-la aumentaria a chance de aceitação inicial e a de rejeição depois que um revisor perguntasse; a redação atual antecipa a pergunta.
- [ ] **Preprint.** Se pretende depositar no medRxiv/bioRxiv, informe ao JNM na submissão.

### Se preferir esperar

O manuscrito ficaria consideravelmente mais forte com uma validação em gravações reais — mesmo pequena — comparando a saída contra uma ferramenta estabelecida (`perceive` ou `DBScope`) sobre os mesmos arquivos, com concordância quantificada. Isso preencheria a única linha da Tabela 4 em que este trabalho perde para as alternativas. A alternativa é submeter agora como artigo de método e publicar a validação em seguida.

---

## Conformidade já verificada

| Item | Estado |
|---|---|
| Resumo | 247 palavras — dentro do limite habitual de 250 do JNM |
| Estrutura do resumo | Background / New method / Results / Comparison with existing methods / Conclusions, como o JNM exige |
| Corpo (Introdução → Conclusões) | ~4 190 palavras, sem tabelas, legendas e referências |
| Citações | 35, todas presentes na lista; nenhuma referência sem citação; numeradas por ordem de primeira aparição |
| Tabelas | 4, todas chamadas no texto |
| Figuras | 3 legendas escritas; **as figuras ainda não existem** |

## Testes de coerência aplicados

Conforme a doutrina de Gomes Pereira, os três testes obrigatórios foram rodados antes de fechar o texto:

1. **Título ↔ objetivo ↔ conclusão combinam?** Sim. O título anuncia análise offline sem dependência com reporte obrigatório de incerteza; o objetivo (fim da Introdução) pergunta se as três restrições podem coexistir e se a divulgação metodológica pode ser estrutural; a conclusão responde exatamente essas duas perguntas e nada além.
2. **Resumo ↔ corpo do texto.** Todo número do resumo aparece no corpo: 87/87 critérios, 100% de sensibilidade e 0% de falso-positivo a −10 dB, Jaccard 1,00, erro de pico < 0,11 Hz, erro de expoente < 0,003, 868 KB, 249 testes.
3. **Objetivo ↔ método.** O objetivo é demonstrar viabilidade arquitetural e validar as implementações; o método descreve a arquitetura e a estratégia de validação em duas vertentes. O que o método **não** permite concluir — desempenho em dado real — está declarado como limitação, não escondido.

E o teste do padrão do iniciante:

| Seção | Vício típico | Verificação |
|---|---|---|
| Introdução | excesso | 4 parágrafos, ~600 palavras, sem mini-revisão |
| Método | parcimônia | 10 subseções, equilibradas: arquitetura, integridade, DSP, estatística, reporte, exportação, validação, ética, IA |
| Resultados | redundância | Cada número aparece uma vez; o texto interpreta as tabelas em vez de repeti-las |
| Discussão | repetição | Comparação, implicações e limitações; sem reapresentar resultados |
