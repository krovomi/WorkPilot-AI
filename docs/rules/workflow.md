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
| Backend, lint | `ruff check apps/backend tests src scripts` et `ruff format --check apps/backend tests src scripts` | ruff `0.15.7` |
| Frontend | `cd apps/frontend && pnpm test` | Vitest |
| Frontend, types | `cd apps/frontend && pnpm run typecheck` | tsc |
| Frontend, lint | `pnpm run lint` | Biome `2.5.11` |
| E2E | `cd apps/frontend && pnpm run build && pnpm run test:e2e` (Linux sans écran : `xvfb-run -a`) | Playwright |
| Comme le hook pre-push | `PRE_PUSH_FULL=1 pnpm run test:all` | — |

**Versions épinglées** : ruff `0.15.7`, Biome `2.5.11`. Toute autre version produit un diff que la
CI refuse. Biome n'est écrit qu'à un endroit, `apps/frontend/package.json`, que `lint.yml` lit et
que Dependabot ne bouge pas ; `tests/test_tool_pins.py` le tient égal à cette règle. ruff vise
Python 3.12 (`target-version` de `ruff.toml`), le plancher supporté.

**Lockfiles** : `pnpm-lock.yaml` et `apps/backend/requirements.lock` se régénèrent par l'outil,
jamais à la main. `apps/backend/requirements.txt` porte les plages ; le lock (versions exactes,
empreintes, toutes plateformes) est ce qu'installent la CI, l'image serveur et
`pnpm run install:backend`. Après avoir touché une plage : `pnpm run lock:python`
(`uv pip compile`, uv `0.11.32`) ; `lint.yml` régénère le lock et échoue sur toute différence.

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

- **Toute PR vise `develop`**, jamais `main` : `main` est la branche de release. Seule la PR de
  release `develop` → `main` y va (et, à défaut, un `hotfix/*`), par les mainteneurs.
- **Méthode de fusion** : squash permis vers `develop` ; vers `main`, **commit de merge seulement**
  (le ruleset de `main` refuse squash et rebase, `main-history-guard.yml` signale un push à un seul
  parent). Un squash vers `main` y écrit des commits que `develop` n'a pas : les deux branches
  divergent et la release suivante conflicte. Réparation : [`docs/RELEASE.md`](../RELEASE.md).
- Branche depuis `develop`, préfixée : `feature/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`.
- Commit : `type(scope)?: description` avec `type` parmi feat, fix, docs, style, refactor, perf,
  test, build, ci, chore, revert.
- Une PR fait une chose. Elle remplit le modèle (`.github/PULL_REQUEST_TEMPLATE.md`), y compris la
  section sécurité et la mention d'assistance IA.
- Un correctif de faille non publiée se décrit en termes neutres ([`SECURITY.md`](../SECURITY.md)).

## CI (`.github/workflows/`)

| Workflow | Vérifie |
|---|---|
| `ci.yml` | pytest (3.13 sur Linux, Windows, macOS ; 3.12 sur Linux) et frontend (typecheck, tests, build) ; chaque test pytest en échec est aussi une annotation du job, lisible sans ouvrir le journal ; `server-image` construit `deploy/Dockerfile.server`, migre un Postgres 16 avec l'image et attend `/health` |
| `lint.yml` | ruff (dont `scripts/`), Biome, fraîcheur de `requirements.lock`, `--check` des fichiers vendorisés et des skills, évaluation des skills |
| `quality-security.yml` | CodeQL étendu, Bandit, pip-audit, pnpm audit |
| `codeql.yml` | CodeQL sur Actions, JS/TS, Python |

`ci.yml` et `lint.yml` tournent sur tout changement sauf les quelques fichiers que rien ne lit
(`paths-ignore` : `CHANGELOG.md`, `LICENSE`, gabarits d'issue et de PR, `FUNDING.yml`) ; une liste
blanche oubliait ce que les tests se mettaient à lire. `tests/test_ci_triggers.py` garde la liste.

Une CI rouge se répare à la racine : pas de test sauté, désactivé ni mis en quarantaine, pas de
commit vide pour relancer.

Planchers et démarrage (plan du 29 octobre 2026, lot N2) :

- **Couverture** : pytest `--cov-fail-under=58` (`ci.yml`), Vitest `coverage.thresholds`
  (`apps/frontend/vitest.config.ts`, mesuré sur Linux). Ce sont des planchers sous le niveau
  mesuré : on les monte quand la suite grandit, on ne les baisse jamais pour merger.
- **Démarrage** : `apps/frontend/scripts/smoke-test.cjs` lance l'app avec `WORKPILOT_SMOKE_TEST=1`
  et exige que le renderer monte (`src/main/smoke-test.ts`) ; `ci.yml` le fait sur le build des
  trois OS, `release.yml` sur chaque app packagée avant publication (`--packaged`).
  `tests/test_smoke_test_wiring.py` garde ces étapes.
- **Actions** : chaque action externe est épinglée par SHA, version en commentaire ; Dependabot
  suit aussi `.github/actions/*` (`tests/test_action_pins.py`).
- **E2E** (lot N3) : le job `e2e` de `ci.yml` construit l'app et lance `pnpm run test:e2e` sous
  xvfb ; `ci-complete` l'attend. Chaque spec démarre l'app par `e2e/app-harness.ts` (HOME et
  profil jetables), aucun `test.skip`, et un test qui ne passe qu'au second essai fait échouer
  le job (`failOnFlakyTests`). `tests/test_e2e_wiring.py` le garde.

## Livraison

`node scripts/bump-version.js patch|minor|major` sur une branche issue de `develop`, PR vers
`develop`, puis PR `develop` → `main` fusionnée par commit de merge : la fusion déclenche la release
(tag, build, signature, publication). Le README de la version arrive sur `develop` et sur `main`
par un même commit ; aucune PR de réconciliation `main` → `develop`. Détails : [`docs/RELEASE.md`](../RELEASE.md).
