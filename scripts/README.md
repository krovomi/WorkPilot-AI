# Scripts

Une ligne par fichier et par dossier de `scripts/`, et rien d'autre :
`tests/test_scripts_readme.py` échoue sur un script sans ligne et sur une ligne sans script.
« Appelé par » dit qui le lance ; un script qu'une personne lance à la main le dit aussi.

## Build, tests, hooks

| Script | Rôle | Appelé par |
|---|---|---|
| `install-backend.js` | Crée le venv du backend et installe ses dépendances. | `pnpm run install:backend` |
| `test-backend.js` | Lance pytest avec le Python du venv. | `pnpm run test:backend` |
| `pre-push.js` | Rejoue les contrôles essentiels de la CI avant un push (lint par défaut, `--full` pour les tests). | `.husky/pre-push`, `pnpm run test:all` |
| `staged-tests.js` | Lance seulement les tests liés aux fichiers indexés. | `.husky/pre-commit` |
| `lib/` | `test-selection.js` : choix des tests à partir des fichiers modifiés, partagé par les deux précédents. | `pre-push.js`, `staged-tests.js` |
| `check_encoding.py` | Signale une ouverture de fichier sans `encoding="utf-8"`. | à la main (écrit comme hook pre-commit, branché nulle part) |
| `validate-npm-scripts.js` | Vérifie que chaque script npm pointe vers un fichier qui existe. | `pnpm run validate:npm-scripts`, CI |
| `fix-electron.js` | Répare le binaire Electron sous Windows. | `pnpm run fix:electron`, `beta-release.yml` |
| `sync-backend-port-to-frontend-env.cjs` | Recopie le port du backend dans le `.env` du frontend. | `dev:vite` et `build` du frontend |
| `setup_windows_git_hooks.bat` | Active les hooks Husky sous Windows. | à la main |
| `kill_port_8765.py`, `kill_port_8765.sh`, `kill_port_8765.bat` | Libèrent le port du WebSocket (8765) quand un ancien backend le tient. | à la main |

## Skills, vendorisation, catalogues générés

| Script | Rôle | Appelé par |
|---|---|---|
| `skills_cli.py` | Le seul écrivain des sorties de skills (`build`, `--check`, `add`…). | `pnpm run skills:*`, CI |
| `skills_sync.py` | Compare les packs vendorisés à leur amont. | `skills-sync.yml` |
| `vendor_pack.py` | Vendorise un pack de skills amont dans `skills/<pack>/`. | à la main |
| `vendor_bmad.py` | Vendorise BMAD, version épinglée. | à la main, `--check` en CI |
| `vendor_ui_ux_pro_max.py` | Vendorise ui-ux-pro-max. | à la main |
| `vendor_archify.py` | Vendorise le moteur de rendu archify. | à la main, `--check` en CI |
| `vendor_watermarks.py` | Vendorise le nettoyeur de texte de watermarks-remover. | à la main, `--check` en CI |
| `generate_model_catalog.py` | Écrit les catalogues de modèles et de prix du frontend depuis le backend. | à la main ; `tests/cost_intelligence/test_catalog.py` vérifie la sortie |
| `sync_surface_globs.py` | Écrit l'ancre `&ui_surface` des workflows depuis `uiux.surface.UI_GLOBS`. | à la main ; `tests/test_uiux.py` vérifie la sortie |
| `wiki/` | Inventaires, récit et pages écrites à la main du wiki GitHub (`sync_wiki.py`, `generate_inventories.py`, `update_narrative.py`, `patches/`). | `wiki-inventories.yml`, `wiki-narrative.yml` |

## Release

| Script | Rôle | Appelé par |
|---|---|---|
| `changelog.py` | Valide les fragments de `changelog.d/` (`check`), montre les notes de la prochaine version (`preview`), les verse dans `CHANGELOG.md` (`release X.Y.Z "Titre"`). | `pre-push.js`, `tests/test_changelog_fragments.py` ; `release` à la main avant la release |
| `bump-version.js` | Change la version partout où elle est écrite. | `prepare-release.yml` |
| `update-readme.py` | Met à jour les badges et liens de téléchargement du README. | `release.yml`, `beta-release.yml` |
| `readme-screenshots/` | Régénère les captures du README dans `.github/assets/screenshots/` : `capture-desktop.cjs` (aperçu navigateur du renderer), `capture-mobile.cjs` (bundle web de l'app mobile), avec les données inventées de `demo-data.js` ; sans backend ni compte. | à la main |
| `validate-release.js` | Vérifie qu'une release est cohérente avant publication. | `bump-version.js` |
| `cleanup-version-branches.sh` | Supprime les anciennes branches de version. | à la main |
| `mobile_device_check.py` | Installe une app mobile sur un appareil réel et rend compte. | `mobile-device-check.yml`, à la main |

## Fusion intelligente des worktrees

| Script | Rôle | Appelé par |
|---|---|---|
| `smart-merge-manager.py` | Préserve les fichiers `.workpilot/` pendant un merge ou un rebase. | les trois suivants |
| `smart-merge.sh` | Enveloppe `git merge` / `git rebase` autour du gestionnaire. | à la main |
| `workpilot-merge-wrapper.py` | La même enveloppe, en Python. | à la main |
| `workpilot-auto-merge-hook.py` | Appelle le gestionnaire avant un merge automatisé. | à la main |
| `git-hooks/` | Hooks `post-merge`, `post-rebase`, `pre-merge-head` qui l'appellent. | `install-merge-hooks.sh` |
| `install-merge-hooks.sh`, `uninstall-merge-hooks.sh` | Posent et retirent ces hooks dans `.git/hooks`. | à la main |
| `test-smart-merge.sh` | Tests du gestionnaire. | à la main |
| `verify-backup.sh` | Vérifie les sauvegardes du gestionnaire. | à la main |

## Diagnostic

| Script | Rôle | Appelé par |
|---|---|---|
| `diagnose_and_fix_azure.ps1` | Diagnostique et corrige la configuration Azure DevOps (PowerShell 5.1+ ou 7+). | à la main |
| `diagnose_azure_config.py` | Diagnostique la configuration Azure DevOps. | à la main |
| `verify_azure_config.py` | Vérifie la configuration Azure DevOps. | à la main |
| `fix_azure_devops_config.py` | Corrige la configuration Azure DevOps. | à la main |
| `quality_cli.py` | Lance le Quality Scorer de la revue de code sur des fichiers. | `quality-handlers.ts` (main) |
| `audit_findings.py` | Écrit la carte `F<n>.js` de chaque constat `docs/audit/findings/F<n>.md` (`build`) ou vérifie qu'elles sont à jour (`check`). | `pre-push.js`, `tests/test_audit_findings.py` ; `build` à la main après un constat |
| `quality_baselines.py` | Plafonds par fichier des `except` aveugles (backend), des `biome-ignore` (frontend) et de la taille des fichiers de plus de 2 000 lignes dans `tests/baselines/` : `check`, et `update` qui ne fait que les baisser. | `pre-push.js`, `tests/test_quality_baselines.py` ; `update` à la main après une correction |
| `audit-large-files.js` | Liste les fichiers source de plus de 500 lignes. | à la main |
| `ai-pr-reviewer.md` | Prompt de revue de PR à coller dans un assistant. | à la main |
