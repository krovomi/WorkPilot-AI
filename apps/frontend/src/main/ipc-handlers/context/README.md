# Context IPC handlers

The project context (index, refresh) and the project's memory, as the
Context page's tabs show them. Memory is the shared brain — one Obsidian vault
every agent reads and writes (`apps/backend/brain/project_memory.py`) — and
these handlers read it through the backend (`/api/brain/*`), never from disk.

| File | What it does |
|---|---|
| `index.ts` | `registerContextHandlers`: registers the three modules below |
| `project-context-handlers.ts` | `CONTEXT_GET`, `CONTEXT_REFRESH_INDEX` — the project index |
| `memory-status-handlers.ts` | `CONTEXT_MEMORY_STATUS` — where the vault is and whether it exists yet |
| `memory-data-handlers.ts` | `CONTEXT_GET_MEMORIES`, `CONTEXT_SEARCH_MEMORIES` — the Memories tab |
| `brain-memory.ts` | the `backendFetch` calls those handlers share (`/api/brain/status`, `/api/brain/memories`) |
| `utils.ts` | `.env` parsing, project and global settings loading, backend source lookup |

History: these handlers used to read LadybugDB when Graphiti was switched on
and `<spec>/memory/` files otherwise. Graphiti was removed in audit lot L7.
