# AGENTS.md — index du frontend

Electron + React + TypeScript + Vite + Zustand + Tailwind. ~570 composants, ~110 stores, ~180
modules de handlers IPC. Ce fichier donne les points d'entrée.

> Règles (normatif) : [`docs/rules/frontend.md`](../../docs/rules/frontend.md), sécurité Electron :
> règle S6 de [`docs/rules/security.md`](../../docs/rules/security.md) · Racine :
> [`../../AGENTS.md`](../../AGENTS.md) · Contribution : [`CONTRIBUTING.md`](CONTRIBUTING.md)

## Les trois processus

| Dossier | Processus | Rôle |
|---|---|---|
| `src/main/` | main Electron | disque, git, worktrees, lancement du backend, terminaux, handlers IPC (`src/main/ipc-handlers/`) |
| `src/preload/` | preload | expose l'API IPC au renderer via `contextBridge` (`src/preload/api/`) |
| `src/renderer/` | renderer | l'UI React ; aucun accès système, tout passe par l'IPC |
| `src/shared/` | — | types, constantes (`constants/ipc.ts`), i18n (`i18n/locales/{en,fr}/`), utilitaires |

## Fichiers volumineux — ne pas ouvrir en entier

| Fichier | Lignes | Voisins / index |
|---|---|---|
| `src/main/claude-profile/usage-monitor.ts` | ~4 600 | une seule classe |
| `src/main/ipc-handlers/task/worktree-handlers.ts` | ~3 600 | `worktree-ide-terminal.ts`, `worktree-git-refs.ts`, `worktree-pr-helpers.ts` |
| `src/main/app-emulator-service.ts` | ~3 250 | — |
| `src/renderer/components/KanbanBoard.tsx` | ~3 250 | [`kanban/AGENTS.md`](src/renderer/components/kanban/AGENTS.md) ; colonnes dans `kanban/KanbanColumn.tsx` |
| `src/main/ipc-handlers/task/execution-handlers.ts` | ~3 100 | — |
| `src/main/ipc-handlers/github/pr-handlers.ts` | ~2 350 | `pr-graphql.ts`, `pr-logs.ts`, `pr-ci-wait.ts` |
| `src/renderer/stores/task-store.ts` | ~1 850 | — |

Chercher le symbole (`grep -n`), lire le voisinage, éditer. Rien ne bloque une lecture complète :
c'est une discipline, pas un garde-fou.

## Où ajouter quoi

| Je veux… | Je touche |
|---|---|
| un canal IPC | `src/shared/constants/ipc.ts`, `src/shared/types/ipc.ts`, `src/preload/api/`, `src/main/ipc-handlers/` (contrat : `ipc-channel-parity.test.ts`) |
| un écouteur d'événements du main | `src/renderer/stores/global-listeners.ts` — jamais un `useEffect` de page |
| un texte visible | une clé dans `src/shared/i18n/locales/en/` **et** `fr/` |
| une détection d'OS ou d'exécutable | `src/main/platform/` |
| une couleur ou un thème | `src/shared/constants/themes.ts` |

## Sécurité

| Garde | Où | Test |
|---|---|---|
| Fenêtre principale : isolation, sandbox, pas de Node | `src/main/index.ts` (`createWindow`) | — |
| Webviews : préférences imposées, schémas de `src` autorisés | `src/main/security/webview-policy.ts` | `webview-policy.test.ts` |
| Navigation et nouvelles fenêtres | `src/main/index.ts` (`setupExternalLinkHandler`, `setupWebviewGuards`) | — |
| Permissions (micro de la dictée) | `src/main/security/dictation-permission.ts` | `dictation-permission.test.ts` |
| URL externes, protocoles en liste fermée | `src/main/open-external.ts` (`openExternalUrl`) | `open-external.test.ts` |
| Variables d'environnement venues d'un dépôt | `src/main/claude-code-settings/env-sanitizer.ts` ([SECURITY.md](src/main/claude-code-settings/SECURITY.md)) | `env-sanitizer.test.ts` |
| Secrets au repos : `safeStorage`, `0600` et bannière sans trousseau | `src/main/secret-storage.ts`, via `src/main/settings-utils.ts`, `src/main/services/profile/profile-manager.ts`, `src/main/claude-profile/token-encryption.ts` | `secret-storage.test.ts`, `settings-utils-secrets.test.ts`, `profile-secrets.test.ts` |
| Trousseau Linux sans bureau déclaré (WSL) : `--password-store=gnome-libsecret` si un Secret Service tourne | `src/main/linux-password-store.ts`, appelé avant `ready` par `src/main/index.ts` | `linux-password-store.test.ts` |
| `.workpilot/.env` de projet : jetons `enc:`, 0600, ignoré par git | `src/main/project-env-file.ts`, `src/shared/constants/project-env-secrets.json` | `project-env-file.test.ts`, `tests/test_project_env_secrets.py` |
| Config de projet liée au projet pour lequel elle a été lue (une sauvegarde n'écrit jamais les réglages d'un autre projet) | `src/renderer/hooks/useProjectEnvConfig.ts`, ref de `project-settings/hooks/useProjectSettings.ts` | `hooks/__tests__/useProjectEnvConfig.test.ts` |
| `.env` du backend : jeton `enc:` une fois packagé, lisible par Python depuis les sources (0600, signalé) | `src/main/source-env.ts` (`writeSourceEnvFile`, `loadBackendEnv`) | `source-env.test.ts`, `source-env-handlers.test.ts` |
| Aucun identifiant stocké ne parvient au renderer : réglages, profils API et Claude, `.env` du backend masqués (`MASKED_SECRET`) ; une clé masquée ne sert qu'à son URL enregistrée ; tests de connexion dans le main | `src/main/utils/masked-secret.ts`, `src/main/settings-secrets.ts`, `src/main/claude-profile/renderer-view.ts`, `ipc-handlers/profile-handlers.ts` | `source-env-handlers.test.ts`, `profile-handlers.test.ts`, `renderer-view.test.ts`, `providerService.test.ts` |
| État du bac à sable de l'OS reçu du backend : validé (zod), gardé par tâche, affiché sur la carte quand les commandes ne sont pas isolées | `src/main/task-sandbox.ts`, `src/main/ipc-handlers/task-sandbox-handlers.ts`, `src/renderer/components/task-sandbox/` ([os-sandbox.md](../../docs/architecture/os-sandbox.md)) | `task-sandbox.test.ts`, `TaskSandboxNotice.test.tsx` |
| Approbation à distance : un plan seulement, jeton à usage unique de 30 min, chat et utilisateur configurés, tâche encore en attente au moment de l'appui ; aucun port ouvert (polling) | `src/main/needs-you/`, `src/main/notification-service.ts` ([needs-you.md](../../docs/architecture/needs-you.md)) | `needs-you/__tests__/`, `notification-service.test.ts` |
| Chemins d'outils des réglages (`pythonPath`, `gitPath`, `claudePath`…) : nom nu de l'outil ou exécutable nommé comme lui, hors projet et hors dossier temporaire | `src/main/security/tool-path-policy.ts` (appelé par `SETTINGS_SAVE`) | `tool-path-policy.test.ts`, `source-env-handlers.test.ts` |
| Expéditeur d'un appel IPC : seule la page de l'app (fichier local ou serveur de dev), dans le cadre principal de la fenêtre principale | `src/main/security/ipc-sender-policy.ts` (posé par `ipc-setup.ts`, avant le contrôle des dossiers) | `ipc-sender-policy.test.ts` |
| Chemins reçus du renderer : résolus (liens compris) puis rattachés à un projet enregistré ou à un dossier choisi dans une boîte native ; dossiers de projet contrôlés avant chaque handler (`DIRECTORY_ARGS`) ; aucun exécutable choisi par le renderer | `src/main/security/renderer-path.ts`, `src/main/security/ipc-path-policy.ts` (posé par `ipc-setup.ts`), `src/main/python-feature-services.ts` | `renderer-path.test.ts`, `ipc-path-policy.test.ts`, `renderer-path-refusals.test.ts`, `no-renderer-interpreter.test.ts` |
| Redaction des logs (fichier, console, rapports de debug) | `src/main/app-logger.ts`, `src/shared/utils/secret-redaction.ts` | `secret-redaction.test.ts`, `app-logger-redaction.test.ts` |
| Environnement sans identifiants pour le code d'un autre (serveur de dev, mobile, Ollama) | `src/main/utils/child-env.ts` | `utils/__tests__/child-env.test.ts` |
| Environnement d'un runner Python lancé par une vue (provider choisi, aucun identifiant hérité) | `src/main/utils/python-runner-env.ts` | `utils/__tests__/python-runner-env.test.ts`, `ipc-handlers/__tests__/runner-env-inheritance.test.ts` |
| Identifiants (trousseau, fichiers restreints) | `src/main/claude-profile/credential-utils.ts` | `credential-utils.test.ts` |
| Assainissement texte / URL | `src/main/ipc-handlers/shared/sanitize.ts` | `sanitize.test.ts` |
| Échappement shell | `src/shared/utils/shell-escape.ts` | — |
| Chemins dans un worktree | `src/main/worktree-paths.ts` (`isPathWithinBase`) | — |
| CSP du renderer | `src/renderer/index.html` | — |
| Passthrough IPC générique : liste fermée de canaux | `src/preload/api/modules/generic-ipc-api.ts` | `generic-ipc-allowlist.test.ts` |
| Aucune commande venue du renderer : la release passe ses notes à `gh` sur stdin, aucun canal n'ouvre un terminal sur une commande reçue | `src/main/ipc-handlers/github/release-handlers.ts`, `src/preload/api/modules/shell-api.ts` | `release-handlers.test.ts`, `no-renderer-command.test.ts` |
| Ouvrir un dossier dans l'IDE ou le terminal : dossier résolu et rattaché à un projet, lanceur lu dans les réglages, AppleScript par argv, `cmd.exe` cité | `src/main/ipc-handlers/task/worktree-ide-terminal.ts`, `src/main/ipc-handlers/task/launch-args.ts` | `worktree-open-launchers.test.ts` |
| Détails de PR Azure DevOps : script statique, URL validée passée en argv, PAT du `.workpilot/.env` | `src/main/ipc-handlers/pr-details-handlers.ts` | `pr-details-azure-script.test.ts` |
| Best-of-N : le renderer nomme la tâche et des moteurs, validés ici puis par le runner ; les noms de variante sont dérivés du nom de la tâche et revérifiés avant de devenir un chemin ou une branche ; rien n'est adopté ni supprimé sans confirmation | `src/main/ipc-handlers/task/best-of-n-handlers.ts`, `apps/backend/best_of_n/` ([best-of-n.md](../../docs/architecture/best-of-n.md)) | `best-of-n-handlers.test.ts`, `tests/best_of_n/` |

Le passthrough générique (`invoke` / `send` / `on`) ne transmet que les canaux de ses listes et
refuse les autres. Historique : une feature migrée vers un module typé retire ses entrées ; un
nouveau canal n'y entre jamais.

## Tests

| Type | Où | Commande |
|---|---|---|
| Unitaires | `src/**/__tests__/`, `*.test.ts(x)` | `pnpm test` (Vitest) |
| Intégration | `src/__tests__/integration/` | `pnpm test` |
| E2E | `e2e/` | `pnpm run test:e2e` (Playwright) |
