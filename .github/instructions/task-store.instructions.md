---
applyTo: 'apps/frontend/src/renderer/stores/task-store.ts,apps/frontend/src/renderer/stores/__tests__/task-store*.ts'
description: 'Conventions du task-store Zustand WorkPilot AI : actions IPC, lifecycle tâches, drafts, archivage. Charge uniquement sur task-store.ts.'
---

# task-store — Instructions ciblées

> **Fichier de ~1 850 lignes** ; les numéros ci-dessous dérivent, confirmer par `grep -n`. Préférer `grep` ciblé sur le nom d'action (`createTask`, `archiveTasks`, etc.) plutôt qu'un `view` complet.

## Sections principales (par ligne approximative)

| Section | Lignes | Fonctions clés |
|---|---|---|
| Activity tracking | ~120 | `recordTaskActivity`, `hasRecentActivity`, `clearTaskActivity` |
| Store Zustand | 262-950 | `useTaskStore` (state + setters internes) |
| CRUD asynchrone | 957-1115 | `loadTasks`, `createTask`, `startTask`, `stopTask`, `submitReview` |
| Persistance status | 1118-1205 | `PersistStatusResult`, `persistTaskStatus`, `forceCompleteTask`, `persistUpdateTask` |
| Recovery | 1206-1254 | `checkTaskRunning`, `recoverStuckTask` |
| Suppression / restauration | 1255-1508 | `deleteTask`, `restoreTask`, `getDeletedTaskBackup`, `deleteTasks` |
| Archivage | 1509-1556 | `archiveTasks` |
| Drafts (localStorage) | 1557-1639 | `saveDraft`, `loadDraft`, `clearDraft`, `hasDraft`, `isDraftEmpty` |
| Helpers lecture | 1640+ | `getTaskByGitHubIssue`, `isIncompleteHumanReview`, `getCompletedSubtaskCount`, `getTaskProgress` |

## Règles

1. **Toujours** appeler les actions async via les fonctions exportées (`createTask`, `archiveTasks`…), jamais via `useTaskStore.getState().set(...)`. Le store interne est privé.
2. **IPC** : passer par `globalThis.electronAPI` ; ne jamais bypasser le preload.
3. **Optimistic updates** : pattern `set local → IPC → rollback on error`. Conserver le snapshot pré-modification.
4. **Drafts** sont en `localStorage` keyé par `projectId`, pas en store.
5. **Activity tracking** est en `Map` mémoire — non persisté.
6. **`recoverStuckTask`** ne doit jamais être appelé silencieusement ; toujours notifier via toast.

## Tests

- `renderer/stores/__tests__/task-store-kanban-order.test.ts` couvre le tri kanban.
- Mock IPC via `vi.mock('globalThis')` patterns existants.
