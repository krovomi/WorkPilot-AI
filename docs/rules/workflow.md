# Règles de travail : commandes, git, CI, livraison

> **Normatif.** Ce qu'un agent ou un contributeur fait entre « j'ai modifié » et « c'est fusionné ».
> Version longue pour les humains : [`docs/CONTRIBUTING.md`](../CONTRIBUTING.md). Noyau :
> [`docs/CLAUDE.md`](../CLAUDE.md).

## Installer et lancer

Prérequis : Python 3.12+ avec `uv`, Node.js 20+ avec pnpm, Git.

```bash
pnpm run install:all        # backend (venv) + frontend
pnpm run dev                # backend + frontend, rechargement à chaud
pnpm start                  # build de production puis lancement
```

Les identifiants vont dans `.env-files/.env` (créé depuis `.env-files/.env.example` par
`install:all`, ignoré par git). Jeton Claude Code : `claude setup-token`.

### Backend (CLI)

```bash
cd apps/backend
python runners/spec_runner.py --interactive   # créer une spec
python runners/spec_runner.py --task "..."    # spec depuis une tâche
python run.py --list                          # lister les specs
python run.py --spec 001                      # build autonome
python run.py --spec 001 --qa                 # validation QA
python run.py --spec 001 --merge              # fusionner un build terminé
```

Référence complète : [`docs/CLI-USAGE.md`](../CLI-USAGE.md).

## Vérifier avant de pousser

| Pile | Commande | Outil |
|---|---|---|
| Backend | `pytest tests/ -v` depuis la racine (venv : `.venv/bin` ou `.venv/Scripts`) | pytest |
| Backend, lint | `ruff check apps/backend tests src` et `ruff format --check apps/backend tests src` | ruff `0.15.7` |
| Frontend | `cd apps/frontend && pnpm test` | Vitest |
| Frontend, types | `cd apps/frontend && pnpm run typecheck` | tsc |
| Frontend, lint | `pnpm run lint` | Biome `2.5.11` |
| E2E | `cd apps/frontend && pnpm run test:e2e` | Playwright |
| Comme le hook pre-push | `PRE_PUSH_FULL=1 pnpm run test:all` | — |

**Versions épinglées** : ruff `0.15.7`, Biome `2.5.11`. Toute autre version produit un diff que la
CI refuse. Un lockfile (`pnpm-lock.yaml`) se régénère par l'outil, jamais à la main.

Fichiers générés qui ont leur `--check` en CI — les régénérer, ne pas les éditer :
`scripts/skills_cli.py build`, `scripts/generate_model_catalog.py`, `scripts/vendor_archify.py`,
`scripts/vendor_watermarks.py`.

## Hooks git (`.husky/`)

`pnpm install` à la racine pose `core.hooksPath = .husky`.

| Hook | Ce qui tourne | Échappatoire |
|---|---|---|
| `pre-commit` | sur les fichiers indexés : ruff format + fix, Biome, scan des secrets (bloquant), puis les tests ciblés | `PRE_COMMIT_SKIP_TESTS=1` (tests seulement) |
| `commit-msg` | Conventional Commits, première ligne ≤ 100 caractères | — |
| `pre-push` | ruff, `skills_cli build --check`, Biome | `PRE_PUSH_FULL=1` ajoute pytest, tsc, Vitest ; `PRE_PUSH_SKIP=1` saute tout |

Un agent n'utilise ni `--no-verify` ni `PRE_PUSH_SKIP` pour faire passer un changement : il corrige.
Le scan des secrets porte sur tout fichier indexé, pas seulement Python et frontend ; un faux
positif se traite par la règle S1 de [`security.md`](security.md), jamais par `--no-verify`.

## Branches, commits, PR

- **Toute PR vise `develop`**, jamais `main` : `main` est la branche de release (seuls `hotfix/*`
  et `release/*` y vont, par les mainteneurs).
- Branche depuis `develop`, préfixée : `feature/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`.
- Commit : `type(scope)?: description` avec `type` parmi feat, fix, docs, style, refactor, perf,
  test, build, ci, chore, revert.
- Une PR fait une chose. Elle remplit le modèle (`.github/PULL_REQUEST_TEMPLATE.md`), y compris la
  section sécurité et la mention d'assistance IA.
- Un correctif de faille non publiée se décrit en termes neutres ([`SECURITY.md`](../SECURITY.md)).

## CI (`.github/workflows/`)

| Workflow | Vérifie |
|---|---|
| `ci.yml` | pytest et frontend (typecheck, tests, build) sur Linux, Windows, macOS |
| `lint.yml` | ruff, Biome, `--check` des fichiers vendorisés et des skills, évaluation des skills |
| `quality-security.yml` | CodeQL étendu, Bandit, pip-audit, pnpm audit |
| `codeql.yml` | CodeQL sur Actions, JS/TS, Python |

Une CI rouge se répare à la racine : pas de test sauté, désactivé ni mis en quarantaine, pas de
commit vide pour relancer.

## Livraison

`node scripts/bump-version.js patch|minor|major`, puis PR `develop` → `main` : la fusion déclenche
la release (tag, build, signature, publication). Détails : [`docs/RELEASE.md`](../RELEASE.md).
