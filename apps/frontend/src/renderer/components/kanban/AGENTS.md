# AGENTS.md — index du Kanban

`KanbanBoard.tsx` fait ~3 250 lignes, `KanbanColumn.tsx` ~1 080. **Ne pas les ouvrir en entier.** Ce fichier donne les
points d'entrée : cibler la ligne, lire 40 lignes autour, éditer.

> Règles du frontend : [`docs/rules/frontend.md`](../../../../../../docs/rules/frontend.md) · Index frontend : [`apps/frontend/AGENTS.md`](../../../../AGENTS.md)

Les numéros de ligne dérivent à chaque modification. Ils indiquent un voisinage, pas une
adresse : confirmer avec `grep -n "<nom>" KanbanBoard.tsx` avant d'éditer.

## Fichiers du domaine

| Fichier | Lignes | Rôle |
|---|---|---|
| `../KanbanBoard.tsx` | ~3 250 | le tableau : drag-and-drop, sélection en masse, file d'attente, dialogues |
| `KanbanColumn.tsx` | ~1 080 | une colonne : `DroppableColumn`, `WipLimitPopover`, `SortableColumnWrapper`, comparateurs mémo, `COLUMN_RENDER_CAP` (lot L11) |
| `KanbanToolbar.tsx` | ~400 | barre d'outils au-dessus du tableau |
| `QuickCommandBar.tsx` | ~360 | palette `/slash` — lit `.agents/skills/` via le backend |
| `../RoadmapKanbanView.tsx` | ~350 | vue roadmap, tableau distinct |
| `../task-detail/TaskMobilePreview.tsx` | ~430 | onglet *Mobile* : plateforme, appareil, run, capture, logs |
| `../../stores/mobile-store.ts` | ~200 | plateforme / appareil / dernière capture sélectionnés |
| `../../stores/task-store.ts` | ~1 850 | état des tâches (Zustand) |
| `../../stores/kanban-settings-store.ts` | — | largeur, ordre, collapse, WIP par colonne |
| `../../../shared/constants/task.ts` | — | `TASK_STATUS_COLUMNS`, libellés de statut |
| `../../hooks/useKanbanAccessibility.ts` | — | annonces aria-live pour le drag-and-drop |

## Colonnes

`TASK_STATUS_COLUMNS` (`shared/constants/task.ts:13`) :
`backlog` · `queue` · `in_progress` · `ai_review` · `human_review` · `build_failed` · `done`

Deux statuts n'ont pas de colonne à eux et sont projetés par `getVisualColumn()` :
`pr_created → done`, `error → human_review`.

`IMPORT_ALLOWED_COLUMNS` restreint les cibles d'import (Azure DevOps / Jira) à
`backlog`, `queue`, `in_progress`. `VALID_BULK_TRANSITIONS` filtre les déplacements en masse.

## Carte de `KanbanBoard.tsx` et `KanbanColumn.tsx`

Les composants de colonne ont quitté `KanbanBoard.tsx` au lot L11 (audit F36), à
l'identique ; le tableau les importe depuis `kanban/KanbanColumn.tsx`.

| Fichier · zone | Ligne ~ | Contenu |
|---|---|---|
| `KanbanBoard.tsx` · constantes et gardes | 130-200 | `VALID_DROP_COLUMNS`, `IMPORT_ALLOWED_COLUMNS`, `VALID_BULK_TRANSITIONS`, `getVisualColumn` |
| `KanbanColumn.tsx` · `COLUMN_RENDER_CAP` | 58 | 60 cartes rendues par colonne |
| `KanbanColumn.tsx` · comparateurs mémo | 110-190 | `tasksAreEquivalent`, `droppableColumnPropsAreEqual` — **le rendu en dépend, y toucher se paie en perfs** |
| `KanbanColumn.tsx` · `WipLimitPopover` | 254 | réglage de la limite WIP d'une colonne |
| `KanbanColumn.tsx` · `DroppableColumn` | 346 | une colonne : en-tête, liste, cible de drop, redimensionnement |
| `KanbanColumn.tsx` · `SortableColumnWrapper` | 1045 | réordonnancement des colonnes |
| `KanbanBoard.tsx` · `KanbanBoard` | 204→fin | le composant exporté |

### À l'intérieur de `KanbanBoard`

| Bloc | Ligne ~ |
|---|---|
| Stores et préférences (projet, env, colonnes, filtres) | 204-290 |
| 13 `useEffect` (chargement des préférences, file d'attente, sync) | 290+ |
| État des dialogues (suppression, duplication, PR en masse, worktree, Azure, Jira) | 340-420 |
| Actions en masse : `handleBulkMove`, `handleConfirmDelete`, `handleUndoBulkDelete` | 745-860 |
| Actions par tâche : `handleDeleteTask`, `handleDuplicateTask`, `handleUndoDelete` | 885-1000 |
| Import (Azure DevOps / Jira) : `handleImportConfirm` | 1017 |
| Drag-and-drop : `handleDragStart` / `handleDragOver` / `handleDragEnd` | 1228, 1265, 1682 |
| Changement de statut : `handleStatusChange` | 1313 |
| File d'attente : `handleQueueAll`, `handleSaveQueueSettings` | 1458, 1490 |
| Colonnes : collapse, verrou, WIP, redimensionnement | 1800-1910 |
| JSX : dialogues et panneaux | 2800→fin |

## Règles du domaine

- **i18n** — namespaces `["tasks", "dialogs", "common"]`, plus `"mobile"` pour l'onglet
  Mobile et le badge de cible. Aucun texte en dur.
- **Accessibilité** — tout déplacement passe par `announce()` ; ne pas court-circuiter.
- **Rendu** — `COLUMN_RENDER_CAP = 60` borne les cartes affichées par colonne. Les
  comparateurs mémo sont le garde-fou perf du tableau ; les modifier sans mesurer régresse.
- **Vérité serveur** — la palette `/slash` résout le corps des commandes côté backend
  depuis `.agents/skills/`, pas dans le renderer.
