# Figuras de referência dos eletrodos

Esquemas em escala real dos eletrodos de DBS compatíveis com o Percept, montados a partir dos
manuais de implante da Medtronic (3387/3389, 2020; SenSight B33005/B33015, 2021). Escala
longitudinal e transversal idênticas, sem distorção; texto como texto, não convertido em curvas.

| Arquivo | Conteúdo |
|---|---|
| `eletrodo_medtronic_3387.svg` | anelar, espaçamento 1,5 mm, arranjo de 10,5 mm |
| `eletrodo_medtronic_3389.svg` | anelar, espaçamento 0,5 mm, arranjo de 7,5 mm |
| `eletrodo_medtronic_3391.svg` | anelar, contatos de 3,0 mm, arranjo de ~24 mm |
| `eletrodo_medtronic_b33005.svg` | SenSight direcional 1-3-3-1, espaçamento 0,5 mm |
| `eletrodo_medtronic_b33015.svg` | SenSight direcional 1-3-3-1, espaçamento 1,5 mm |
| `eletrodos_medtronic_comparativo.svg` | os cinco modelos lado a lado, na mesma escala |
| `eletrodos_medtronic_seccao_axial.svg` | corte transversal: nível anelar vs. nível segmentado |

## Por que o software não usa estes arquivos diretamente

Estas figuras são **estáticas**: elas não sabem qual par bipolar está sendo mostrado numa figura
específica. O ponto do desenho dentro do aplicativo é justamente **marcar quais contatos estão em
uso agora** — o par de sensing na F1, os contatos de estimulação na F7, os contatos fora dos
limites de impedância na F3 —, o que exige desenhar com estado.

Por isso o aplicativo redesenha o eletrodo no canvas a partir das mesmas medidas, que vivem como
dados em [`src/core/leads/index.js`](../../../src/core/leads/index.js). Assim o desenho:

- destaca contatos dinamicamente, por figura;
- exporta em PNG 2× pelo mesmo caminho do resto do software;
- não acrescenta ~65 KB de SVG ao arquivo único.

Estes SVG ficam como **referência visual** de onde as proporções vieram, e para reaproveitamento em
apresentações e manuscritos.

## Ressalva sobre o modelo 3391

As medidas do 3391 vêm de catálogo e da literatura, **não** do manual de implante conferido. No
código elas saem marcadas com `dimensionsVerified: false`, e o aplicativo mostra o aviso na figura.
Confirme antes de publicar.
