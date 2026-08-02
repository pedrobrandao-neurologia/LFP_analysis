# Como publicar este repositório na sua conta

O repositório já está **inicializado, com o primeiro commit feito**. Falta apenas criá-lo
no GitHub e enviar. Escolha um dos caminhos.

> **Já está no GitHub?** Se o repositório já foi enviado, pule para
> [Ativar o GitHub Pages](#ativar-o-github-pages) — é só ligar uma opção nas configurações.

## Ativar o GitHub Pages

O aplicativo é um site estático servido a partir da **raiz** do repositório (o `.nojekyll`
já desliga o processamento Jekyll). Escolha **uma** das opções:

- **Opção 1 — GitHub Actions (recomendada, publica sozinho).**
  *Settings → Pages → Build and deployment → Source → **GitHub Actions***.
  O fluxo [`.github/workflows/pages.yml`](.github/workflows/pages.yml) publica o site
  automaticamente a cada push na branch `main`. O endereço aparece ao final do job.

- **Opção 2 — Deploy from branch (clássica).**
  *Settings → Pages → Build and deployment → Source → **Deploy from branch** → `main` / `(root)`*.

Em qualquer opção a aplicação fica em `https://SEU_USUARIO.github.io/LFP_analysis/`.

## Caminho A — GitHub CLI (mais rápido)

Se ainda não tiver o `gh`: https://cli.github.com

```bash
cd LFP_analysis
gh auth login                 # autentica no navegador, sem colar token em lugar nenhum
gh repo create LFP_analysis --public --source=. --remote=origin --push
```

Pronto. Para ativar o aplicativo:

```bash
gh repo edit --enable-pages --pages-branch main
```

Ou pela interface: **Settings → Pages → Deploy from branch → `main` / `(root)`**.
A aplicação ficará em `https://SEU_USUARIO.github.io/LFP_analysis/`.

## Caminho B — pela interface do GitHub

1. https://github.com/new → nome `LFP_analysis` → **não** marque "Add a README",
   "Add .gitignore" nem "Choose a license" (já existem aqui).
2. Depois de criar, rode:

```bash
cd LFP_analysis
git remote add origin https://github.com/SEU_USUARIO/LFP_analysis.git
git branch -M main
git push -u origin main
```

3. **Settings → Pages → Deploy from branch → `main` / `(root)`**.

## Depois de publicar

- Ajuste `repository-code` em `CITATION.cff` com a URL real.
- Se quiser DOI para citar em artigo: conecte o repositório ao Zenodo
  (https://zenodo.org/account/settings/github/) e publique um *release* — o DOI sai automático.
- A integração contínua (`.github/workflows/ci.yml`) roda os 47 testes a cada push e
  verifica que `index.html` está sincronizado com `src/`.

## Instalar a proteção contra vazamento

O repositório traz um hook que bloqueia commits contendo dados identificadores do Percept.
Hooks não viajam pelo `git clone`, então instale-o em cada máquina:

```bash
cp tools/pre-commit .git/hooks/ && chmod +x .git/hooks/pre-commit
```

(No pacote que você recebeu ele **já está instalado** — reinstale apenas se clonar de novo.)

## ⚠ Antes de qualquer commit futuro

O `.gitignore` bloqueia `Report_Json_Session_Report_*.json`, `dados/`, `raw/`, `*.pdf` e `*.csv`.
Confira sempre com `git status` antes de `git add -A`. Para verificar que nada de paciente
entrou no histórico:

```bash
git log --all --name-only --pretty=format: | sort -u | grep -iE 'session_report|paciente' || echo "limpo"
```
