---
applyTo: 'apps/frontend/src/main/**/*.ts'
description: 'Conventions Electron main process WorkPilot AI : IPC handlers, services, file watchers, terminal manager.'
---

# Electron Main Process — Instructions

> Résumé pour Copilot. Les règles normatives sont dans `docs/rules/frontend.md` et la règle S6 de `docs/rules/security.md` ; elles priment.

## Stack

- **Electron** + TypeScript, build via **electron-vite**.
- IPC handlers organisés par domaine dans `apps/frontend/src/main/ipc-handlers/`.
- Services métier au niveau racine du dossier `main/` (un fichier par service).
- Terminal multi-PTY via `node-pty` (`terminal/`).

## Règles

1. **Tout** handler IPC est défini par `ipcMain.handle(channel, ...)` dans `ipc-handlers/` et exposé côté preload via `apps/frontend/src/preload/api/`.
2. Channels nommés via constantes de `apps/frontend/src/shared/constants/ipc.ts` ou `ipc-namespaces.ts`. **Jamais** de string littéral.
3. Tout type de réponse IPC est dans `apps/frontend/src/shared/types/ipc.ts`.
4. Logs via `app-logger.ts` — pas de `console.log` en prod.
5. Aucune commande shell construite par interpolation : arguments en tableau, sinon `escapeShellArg` (`shared/utils/shell-escape.ts`). Chaque handler revalide ses arguments (chemin résolu et contenu, URL via `openExternalUrl`).
6. Hot-reload via `electron-vite` ; les services doivent être idempotents au reload.

## Sections clés (gros services)

| Fichier | Rôle |
|---|---|
| `agent/agent-manager.ts` | Lifecycle des agents (start/stop/status) |
| `terminal-manager.ts` | Sessions PTY multi-terminal |
| `task-state-manager.ts` | Source de vérité tâches côté main |
| `file-watcher.ts` | chokidar wrappers |
| `ipc-setup.ts` | Bootstrap de tous les handlers IPC |

## Token-saving

- Beaucoup de fichiers > 500 lignes. Préférer `grep` ciblé.
- Voir `apps/frontend/AGENTS.md` pour la cartographie complète.

## Anti-patterns

- Importer du code `renderer/` dans `main/` — interdit (Electron isolation).
- Calculer un chemin de worktree hors `worktree-paths.ts`.
- Créer un handler IPC sans le déclarer dans `ipc-namespaces.ts`.
- Appeler `shell.openExternal` sur une chaîne reçue ; créer une fenêtre sans `contextIsolation`, `sandbox` et gardes de navigation.
- Transmettre `process.env` entier à un processus enfant, ou logger un jeton.
