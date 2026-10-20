---
applyTo: 'apps/frontend/src/preload/**/*.ts,apps/frontend/src/shared/types/ipc.ts,apps/frontend/src/shared/constants/ipc*.ts'
description: 'Conventions IPC WorkPilot AI : preload bridge, namespaces, types partagés main↔renderer.'
---

# IPC (preload bridge) — Instructions

> Résumé pour Copilot. Les règles normatives sont dans `docs/rules/frontend.md` et la règle S6 de `docs/rules/security.md` ; elles priment.

## Architecture

```
renderer  →  globalThis.electronAPI.<method>()  →  preload/api/*  →  ipcRenderer.invoke  →  main/ipc-handlers/*  →  ipcMain.handle
```

## Règles

1. **Pas** d'accès direct à `ipcRenderer` côté renderer — uniquement `globalThis.electronAPI` (contextBridge).
2. Chaque méthode exposée dans `preload/api/*` doit avoir :
   - Un **channel** dans `shared/constants/ipc.ts` ou `ipc-namespaces.ts`.
   - Un **type de retour** dans `shared/types/ipc.ts`.
   - Un **handler** dans `main/ipc-handlers/`.
3. Retours IPC suivent le pattern `{ success: boolean; data?: T; error?: string }` (cf. types existants).
4. Pas de `Buffer` ni d'objet non-sérialisable dans les payloads IPC.
5. `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` restent activés (`src/main/index.ts`, `createWindow`).
6. Aucun nouvel appel au passthrough générique `invoke(channel, …)` (`preload/api/modules/generic-ipc-api.ts`) : un canal = une méthode typée.
7. Le handler main revalide ses arguments ; un handler sensible vérifie l'expéditeur (`event.senderFrame`).

## Anti-patterns

- Ajouter une méthode `electronAPI.xxx` sans handler côté main → throw silencieux en prod.
- Passer une fonction ou une `Promise` dans un payload IPC.
- Bypasser le preload (`nodeIntegration: true`) — risque de sécurité majeur.
