---
feature: Colonnes « Échec » et « Abandonnée » du Kanban
summary: >-
  Deux colonnes calculées, pas deux statuts : « Échec » tient les runs finis en erreur, refusés
  par la QA ou à court de contexte, « Abandonnée » les tâches mises de côté avec une résolution à
  la Jira (ne sera pas fait, doublon, obsolète, remplacée, autre) et la tâche liée. Pipeline,
  XState et backend inchangés. Plus le drapeau « Bloquée » et l'abandon d'une carte dont la PR est
  fermée sans fusion.
---

# Colonnes « Échec » et « Abandonnée »

Demandé le 22 novembre 2026 (« des colonnes pour les tâches abandonnées, terminées avec fail ou
autres raisons non OK, comme dans Jira »), lot 1 de l'étude « Kanban agile ». Avant, une erreur se
dessinait sous « Révision humaine » et une tâche abandonnée restait grisée dans sa colonne.

## Des colonnes calculées

`TASK_STATUS_COLUMNS` (`shared/constants/task.ts`) liste dix colonnes ; `OUTCOME_COLUMNS`
(`failed`, `abandoned`) ne sont **pas** des `TaskStatus`. La colonne d'une carte se lit par
`getBoardColumn(task)` (`renderer/lib/kanban-columns.ts`) :

| Carte | Colonne |
|---|---|
| `metadata.abandoned === true` | `abandoned`, quel que soit son statut |
| statut `error` | `failed` |
| `human_review` avec `reviewReason` `errors`, `prompt_too_long` ou `qa_rejected` (`FAILED_REVIEW_REASONS`) | `failed` |
| autre | la colonne de son statut (`getVisualColumn`) |

Pourquoi pas deux statuts de plus : le statut est écrit par le backend, la machine XState et
`implementation_plan.json`, et lu par la reprise, la QA, le suivi des PR et l'app mobile. Une
colonne calculée ne change rien à ce chemin ; une tâche reprise retrouve sa colonne d'avant.

Les deux colonnes sont masquées tant qu'elles sont vides (`occupiedOutcomeColumns`,
`hooks/useVisibleKanbanColumns.ts`), comme « Build rouge » et « PR ouverte ». Un ordre de colonnes
enregistré avant elles les reçoit (`normalizeColumnOrder`).

## Ce qu'on peut y faire (`canMoveTaskTo`)

- **« Échec »** se remplit par les runs seuls : un dépôt y est refusé (toast
  `kanban.outcome.failedDropRefused`). Une carte en échec ne repart que vers `backlog`, `queue`
  ou `in_progress`, ou se met de côté.
- **« Abandonnée »** : un dépôt (d'une carte ou d'une sélection), ou « Abandonner… » du menu de la
  carte, ouvre le dialogue de la raison (`kanban/AbandonRequestDialog.tsx`, ouvert par
  `stores/abandon-request-store.ts`). Une tâche terminée ne s'abandonne pas.
- **Sortir de « Abandonnée »** : glisser la carte ailleurs la reprend (`resumeAbandonedTask`), puis
  la déplace par les règles habituelles si elle n'atterrit pas dans la colonne de son statut ; le
  bandeau de la carte et « Reprendre » du menu font de même. Une carte abandonnée n'a pas de menu
  « Déplacer vers ».

Les dépôts sont traités avant ceux des statuts par `hooks/useOutcomeDrop.ts` (appelé au début de
`handleDragEnd` de `KanbanBoard.tsx`, qui est à son plafond de taille).

## La raison d'un abandon

`AbandonDialog` (`task-detail/`) demande une **résolution** (`ABANDON_RESOLUTIONS`,
`shared/types/task.ts`), la tâche liée pour `duplicate` et `replaced` (200 tâches au plus,
non archivées, hors celles qu'on abandonne) et une note. `pr_closed` (« PR fermée sans fusion »)
est réservée à l'app (voir « PR fermée sans fusion »). `buildAbandonMetadata` (`shared/utils/task-lifecycle.ts`) écrit
`abandoned`, `abandonedAt`, `abandonedReason`, `abandonedResolution`, `abandonedLink` ;
`buildResumeMetadata` les efface. Rien n'est supprimé.

La ligne de résumé (`lib/column-pulse.ts`) compte les échecs par cause (erreur, QA, contexte) et les
abandons par résolution.

## Mode serveur et mobile

- Les champs d'abandon vont au serveur par `PATCH /api/board/cards/{id}/settings`
  (`main/server-card-settings.ts` → `shared_board/settings.py`, `PLAIN_KEYS`), revalidés
  (résolution en liste fermée, lien au format d'un id de tâche, date ISO, note de 2 000 caractères
  au plus) et écrits dans `task_metadata.json` : chaque membre voit la carte dans « Abandonnée ».
  Comme les autres réglages, pas pendant un run (409).
- `board_mcp.server.summary` ajoute `outcome` (`failed` ou `abandoned`) à une carte qui a mal fini ;
  `column` reste la colonne du plan, pour les clients qui la lisent déjà.
- L'app mobile range la carte par `boardColumn` (`apps/mobile/src/board/columns.ts`) : `outcome`,
  sinon `error` → `failed`. Une carte abandonnée n'offre aucune action sur le téléphone.

## « Bloquée » : le drapeau

Comme le drapeau de Jira, « Bloquée » n'est pas une colonne : la carte reste où elle est, avec un
bandeau rouge (`kanban/FlagBanner.tsx`) qui montre la raison et un bouton « Retirer le drapeau ».
« Marquer comme bloquée… » du menu de la carte ouvre `kanban/FlagRequestDialog.tsx` (raison
facultative, 500 caractères au plus, `MAX_FLAG_REASON`), ouvert par `stores/flag-request-store.ts`.
`buildFlagMetadata` / `buildUnflagMetadata` (`shared/utils/task-flag.ts`) écrivent ou effacent
`flagged`, `flaggedReason`, `flaggedAt` ; `stores/task-flag-actions.ts` les enregistre et avance
`updatedAt`, que lisent les comparateurs de `KanbanColumn` pour redessiner la carte. Une tâche
terminée ne se marque pas.

Le drapeau suit le même chemin que l'abandon en mode serveur (`PLAIN_KEYS` : booléen, raison de
500 caractères, date ISO) ; `board_mcp` ajoute `flagged: true` au résumé de la carte et l'app
mobile affiche « Bloquée » sur la carte.

## PR fermée sans fusion

Le suivi des PR (`main/worktree-purge/merged-watch.ts`, `followMergedPrs`) lit déjà l'état de la
PR de chaque carte. Quand elle est **fermée sans fusion**, la carte est abandonnée avec la
résolution `pr_closed` et `prClosedAt` est noté : une seule fois, pour qu'une carte reprise à la
main ne soit pas remise de côté au passage suivant. Une PR rouverte efface `prClosedAt` ; une PR
fusionnée reprend une carte abandonnée. Le réglage « Mettre de côté les cartes dont la PR est
fermée » (`kanbanAbandonClosedPrs`, Affichage, activé par défaut) coupe ce comportement.
