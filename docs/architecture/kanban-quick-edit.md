---
feature: Ajout et édition rapides des cartes Kanban
summary: >-
  Ajout rapide depuis Planification, File d'attente et En cours (une carte par ligne collée) ; clic droit
  sur carte et colonne, liste d'actions partagée avec « ⋮ », Type ▸, Priorité ▸, Modifier… ;
  sélection Ctrl/Maj et Ctrl+A, actions en masse, suppression différée, Ctrl+Z ; renommage en
  place (F2), flèches entre cartes, aide des touches (Ctrl+/).
---

# Ajout et édition rapides des cartes Kanban

Demandé le 21 novembre 2026 : ajouter, modifier ou supprimer une ou plusieurs cartes prenait trop
de gestes (l'assistant complet pour chaque carte, la fiche puis une modale pour renommer). Le
travail est découpé en quatre lots, un par PR, dans cet ordre :

1. **Ajout rapide en colonne** (livré).
2. **Clic droit sur carte et colonne**, une seule liste d'actions partagée avec le menu « ⋮ » (livré).
3. **Sélection Ctrl/Maj**, barre d'actions groupées enrichie, suppression différée, Ctrl+Z (livré).
4. **Renommage en ligne**, navigation au clavier, aide des raccourcis (livré).

## Où l'on crée une carte

Seulement dans **Planification** (`backlog`), **File d'attente** (`queue`) et **En cours**
(`in_progress`), `QUICK_ADD_COLUMNS` de `renderer/lib/kanban-columns.ts`. Les autres colonnes
sont tenues par le pipeline (Révision IA, Révision humaine), la CI (Build rouge) ou le suivi des
PR (PR ouverte, Terminé) : une carte créée là ne décrirait rien de réel. Les mots de la boîte
dans chaque colonne (« Ajouter et démarrer », « Démarrer ») sont dans `QUICK_ADD_LABELS` de
`renderer/lib/quick-add.ts`.

Une carte créée dans En cours démarre aussitôt (`persistTaskStatus(…, "in_progress")`, que le
main traduit en lancement), comme une carte glissée là, tant qu'En cours a une place libre
(`maxParallelTasks` du projet, compté par `countRunning` de `lib/group-move.ts`). Sinon elle
attend dans File d'attente, et le toast le dit. Avant le 22 novembre, la boîte n'existait pas
dans En cours : il fallait créer la carte ailleurs puis la glisser.

Une carte créée dans File d'attente y est placée (`persistTaskStatus(…, "queue")`) et y attend,
comme une carte glissée là : la file la démarre quand un emplacement se libère (une tâche quitte
En cours). Le 21 novembre, la boîte appelait aussi `kickQueue()`, qui la démarrait tout de suite
quand rien ne tournait ; « Mettre en file » envoyait donc la carte dans En cours.

## Les gestes

| Geste | Effet |
|---|---|
| « + » de l'en-tête, ligne « Ajouter une carte » sous les cartes | ouvre la boîte en haut de la colonne |
| double-clic dans le vide de la colonne | idem ; jamais sur une carte ni un contrôle (`QUICK_ADD_IGNORED_TARGETS`) |
| touche N (Planification) | idem, hors saisie, hors Ctrl/Cmd/Alt, sans dialogue ni menu ouvert (`hooks/useQuickAddShortcut.ts`) ; une colonne repliée se déplie |
| Entrée | crée et garde la boîte ouverte, vide, pour la carte suivante |
| Maj+Entrée | nouvelle ligne |
| Échap, ✕ (dans le coin, loin du bouton de création) ou un clic ailleurs | ferme ; le texte, le type et la priorité non créés sont rendus à la prochaine ouverture (par projet et colonne, pour la vie de la fenêtre). Un clic dans les menus de la boîte, qui vivent dans des portails, ne la ferme pas |
| « Plus d'options… » | écrit le texte (et la priorité) dans le brouillon de l'assistant (`saveDraft`) puis ouvre l'assistant complet |

Un simple clic dans le vide n'ouvre rien : il sert déjà à désélectionner, et le relâché d'un
glisser-déposer y tombe souvent.

## Ce que devient le texte

`renderer/lib/quick-add.ts`, fonctions pures :

- une ligne courte (≤ `QUICK_ADD_TITLE_MAX` = 120 caractères) devient le titre et la description ;
- un texte sur plusieurs lignes donne une carte : sa première ligne, si elle est courte, en est le
  titre, et tout le texte (titre compris) la description, pour que l'agent lise les deux ; une
  première ligne trop longue laisse le titre vide, que le main génère comme pour l'assistant
  (`TASK_CREATE`, `titleGenerator`) ;
- une liste **collée** (au moins deux lignes, toutes courtes) donne **une carte par ligne**, puces
  et numéros retirés, au plus `QUICK_ADD_MAX_CARDS` = 50. Des lignes tapées (Maj+Entrée) ne sont
  jamais une liste : c'est un titre et sa description. Le bouton « Une carte par ligne (N) »
  bascule ce choix dans les deux sens. Avant le 28 novembre 2026, deux lignes courtes tapées
  faisaient deux cartes : la description écrite sous le titre devenait une carte à part.

Si une création échoue au milieu d'une liste, les lignes déjà créées sont retirées de la boîte et
le reste y reste, pour qu'un nouvel essai ne crée pas de doublon.

## Métadonnées d'une carte créée ainsi

`quickAddMetadata` : `sourceType: "manual"` et le moteur de la tâche semé comme dans l'assistant
(`seedEngine(settings, defaultEngineProvider(settings, projectProvider))`, puis
`buildEngineMetadata`) : la carte possède son moteur dès sa création, rien de global ne le
remplace ensuite.

Le **type** choisi passe par `cardTypeChoiceMetadata` (`shared/constants/card-types.ts`) : un type
qui est un genre de travail est enregistré comme le choix de la personne (`kind`,
`kindSource: "user"`, jamais écrasé par le backend) ; les quatre types qui n'existent que comme
catégorie (UI / UX, sécurité, performance, infra) posent cette catégorie et un `kind: "feature"`
décidé par elle, pour que `resolveCardType` l'atteigne. La **priorité** est `metadata.priority`.

## Le clic droit et le menu « ⋮ »

Une carte a **une seule liste d'actions**, `kanban/TaskCardMenuItems.tsx`, rendue par son menu
« ⋮ » et par son menu du clic droit (`kanban/TaskCardMenus.tsx`) : une action ajoutée là
apparaît dans les deux. Dans l'ordre : Ouvrir (clic droit seulement, un clic le fait déjà),
Modifier…, Type ▸, Priorité ▸, Déplacer vers ▸ (`manualMoveTargets`), puis Estimer, Dupliquer,
Reprendre ou Pause, Synchroniser depuis la branche, puis Supprimer, à part.

- **Modifier…** ouvre directement `TaskEditDialog`, sans passer par la fiche.
- **Type ▸** et **Priorité ▸** listent les mêmes choix que la boîte d'ajout
  (`kanban/CardChoiceMenuItems.tsx`) ; le choix est écrit par `persistUpdateTask` avec
  `cardTypeChoiceMetadata` ou `{ priority }`, que le main fusionne dans les métadonnées
  (`TASK_UPDATE`). Choisir la valeur actuelle n'écrit rien ; un échec le dit (toast).
- Pendant qu'un agent travaille sur la carte, Modifier…, Type et Priorité sont grisés : ce que
  l'agent lit ne change pas sous lui.

Une **colonne** a de même une liste (`kanban/ColumnMenuItems.tsx`) pour son menu « ⋯ » et son
clic droit : Ajouter une carte (clic droit, Planification, File d'attente et En cours), Tout sélectionner,
Tout mettre en file (Planification), Archiver les terminées et Afficher les archivées (Terminé),
Paramètres de la file (File d'attente), verrou de largeur, repli. Une action qui ne s'applique pas
(colonne vide, autre colonne) n'est pas montrée ; une colonne sans action n'a pas de menu.

### Comment le menu s'ouvre au pointeur

`kanban/PointerMenu.tsx`, sans nouvelle dépendance : le menu déroulant de l'app, ouvert et
ancré sur un point de taille nulle placé dans `document.body` (une ancre fixe placée dans la
carte suivrait la transformation que le glisser-déposer lui applique). Il n'est pas modal : un
clic droit ailleurs ferme celui-ci et ouvre le suivant. La touche Menu ou Maj+F10, sans position
de pointeur, l'ouvre près du coin de la carte (`contextMenuPoint`).

Le menu et le dialogue sont dans des portails, mais leurs événements remontent l'arbre React
jusqu'à la carte. `isFromPortal` les écarte : la carte ne s'ouvre pas sur un clic dans son menu,
ni sur Espace tapé dans son dialogue (elle ne répond plus qu'aux touches reçues par elle-même),
et `withoutPortalEvents` (`SortableTaskCard`) ne démarre pas de glisser depuis là. Le clic droit
d'une colonne est un écouteur natif, qu'un portail n'atteint pas ; il laisse le sien à une carte,
à un champ de texte et à la boîte d'ajout (`COLUMN_MENU_IGNORED_TARGETS`).

## Sélection, suppression différée, annulation

### Sélectionner

`hooks/useBoardSelection.ts` tient la sélection (sortie de `KanbanBoard.tsx`, qui était à son
plafond de taille). Ctrl+clic ou Cmd+clic ajoute ou retire une carte ; Maj+clic sélectionne de
la dernière carte cliquée à celle-ci, dans la même colonne (sans ancre dans la colonne, il se
comporte comme Ctrl+clic). Ces clics sont pris par un écouteur natif en capture sur la liste de
la colonne (`KanbanColumn`), avant le clic de la carte, qui ne s'ouvre donc pas ; un clic avec
modificateur sur un bouton, un lien, un champ ou la case garde son sens
(`SELECT_GESTURE_IGNORED_TARGETS`). La carte porte `data-task-id` (`SortableTaskCard`).

La case à cocher d'une carte n'apparaît qu'au survol, au focus, cochée, ou dès que le tableau a
une sélection (`.kanban-card-check`, `data-board-selecting` sur le tableau).

Touches (`hooks/useBoardShortcuts.ts`, jamais pendant une saisie ni avec un dialogue ou un menu
ouvert, Ctrl et Cmd valent pareil) : Ctrl+A sélectionne la colonne qui a le focus, sinon celle
sous le pointeur ; Échap vide la sélection ; Suppr ou Retour arrière la supprime ; Ctrl+Z annule.

### Agir sur la sélection

La barre (`kanban/BulkActionBar.tsx`, sortie du tableau) garde les étapes du pipeline pour la
colonne de la sélection et ajoute **Type** et **Priorité**. Le clic droit sur une carte qui fait
partie d'une sélection de plusieurs agit sur toute la sélection (`SelectionMenuItems`, via
`kanban/board-selection-context.ts`) : Type ▸, Priorité ▸, Effacer la sélection, Supprimer ; le
menu « ⋮ » reste celui de la carte. `hooks/useBoardBulkEdits.ts` porte ces actions.

### Glisser la sélection

Glisser une carte qui fait partie d'une sélection de plusieurs déplace toute la sélection, même
si elle vient de plusieurs colonnes. Chaque carte suit les règles d'un glisser seul
(`lib/group-move.ts`, `planGroupMove`) : une carte déjà dans la colonne reste où elle est,
« PR ouverte » ne prend que les cartes qui ont une PR, et « En cours » ne prend que ce que ses
places libres permettent ; le reste attend dans File d'attente (une carte qui y était déjà n'est
pas réécrite). Une carte d'En cours renvoyée dans la file y est tenue le temps que la file tourne
une fois, comme pour un glisser seul. Les cartes déplacées arrivent en haut de leur colonne, dans
l'ordre de la sélection, et un seul Ctrl+Z les ramène. La barre d'actions passe par la même
fonction (`moveSelection`), donc elle respecte aussi la limite d'En cours.

Pendant le glisser, la carte sous le pointeur s'affiche en pile avec le nombre de cartes
(`kanban/DragOverlayCard.tsx`) et les cartes sélectionnées s'estompent à leur place
(`[data-board-group-drag]` dans `globals.css`). Une colonne qui ne prend aucune carte de la
sélection (`groupMoveTargets`) s'affiche comme refusée. Révision humaine vers Terminé garde sa
confirmation, puis le flux de création des PR.

Où tombe une carte lâchée (`lib/board-collision.ts`, `boardCollision`) : sur ce que le pointeur
survole (une carte, sinon sa colonne ou son couloir), et seulement sans pointeur (glisser au
clavier) ou au-dessus de rien sur les coins les plus proches. Avec les coins seuls, une carte lâchée
au milieu d'une colonne vide et haute revenait dans sa colonne dès qu'une carte s'y tenait à la
même hauteur : les quatre coins d'une colonne haute sont loin de tout. `e2e/kanban-agile.e2e.ts`
glisse dans une fenêtre large et haute, où le défaut se voyait.

### Supprimer sans confirmer une carte neuve

Une carte sur laquelle rien n'a travaillé (`isLightCard` de `lib/card-edits.ts` : Planification
ou File d'attente, pas de plan, pas de worktree, jamais lancée) n'a que son texte à perdre. Sa
suppression, seule ou en sélection, ne demande rien : la carte disparaît tout de suite et n'est
supprimée qu'après `DEFERRED_DELETE_MS` = 8 s (`stores/pending-delete-store.ts`, le tableau
masque les cartes en attente), sauf si « Annuler » dans le toast ou Ctrl+Z la ramène avant.
Rien n'est supprimé si la fenêtre se ferme avant. Une carte qui n'a pas pu être supprimée
revient, et un toast le dit. Toute autre carte garde le dialogue de confirmation et l'annulation
d'avant (`restoreTask`, qui recrée la carte).

### Ctrl+Z

`stores/board-undo-store.ts` garde les 20 dernières modifications du projet affiché (vidée au
changement de projet) : type et priorité (carte ou sélection, `applyCardChoice`), déplacements
entre Planification et File d'attente (menu, glisser-déposer, barre ; `recordMoves`), suppressions
encore en attente. Un déplacement qui lance ou arrête un agent ne s'annule pas. Une annulation ne
touche qu'une carte restée telle qu'on l'a laissée ; sinon le toast dit qu'elle n'a pas été
complète.

## Renommer, naviguer au clavier, aide des touches

### Renommer en place

Un double-clic sur le titre d'une carte, ou F2 quand la carte a le focus, remplace le titre par
une zone de texte (`kanban/InlineTitleEditor.tsx`, `hooks/useInlineRename.ts`) : Entrée ou
quitter la zone enregistre, Échap garde l'ancien titre, un titre vide ou identique n'écrit rien.
Entrée et Échap rendent le focus à la carte. Le titre passe par `TASK_UPDATE` (`renameCard` de
`lib/card-edits.ts`) et entre dans la pile de Ctrl+Z, annulé seulement si la carte porte encore
ce titre. Pas de renommage pendant qu'un agent travaille sur la carte (comme Modifier…), ni sur
un titre d'erreur de lecture.

Un simple clic sur le titre d'une carte renommable ouvre la fiche après
`TITLE_DOUBLE_CLICK_MS` = 250 ms : la fiche est une modale, et sans ce délai le second clic d'un
double-clic tomberait sur elle. Un clic ailleurs sur la carte l'ouvre tout de suite.

### Les flèches

Les flèches sans modificateur, depuis une carte ou sa poignée de glisser, passent le focus à la
carte voisine (`lib/card-focus.ts`) : haut et bas dans la colonne, gauche et droite vers la
colonne voisine qui montre des cartes, à la même ligne ou sur sa dernière carte. Le focus va
toujours sur la carte (Entrée l'ouvre, F2 la renomme). La région `aria-live` du tableau dit
« 2 sur 5, File d'attente » ; le lecteur d'écran lit déjà le titre de la carte. Une carte
soulevée au clavier (Espace sur sa poignée, `aria-pressed` posé par dnd-kit) garde les flèches
pour son déplacement.

### L'aide

Ctrl+/ (Cmd+/), « ? » ou le bouton clavier de la barre d'outils ouvrent
`kanban/ShortcutsHelpDialog.tsx`, qui liste les touches des cartes, de la sélection et du tableau,
avec ⌘ sous macOS et les noms de touches traduits (Maj, Entrée, Échap, Suppr). L'état ouvert vit
dans `stores/shortcuts-help-store.ts`, que la barre d'outils et le tableau partagent.
`kanban/BoardKeyboard.tsx` branche `useBoardShortcuts` sur le tableau et rend l'aide.

## Fichiers

| Fichier | Rôle |
|---|---|
| `renderer/components/kanban/QuickAddComposer.tsx` | la boîte |
| `renderer/lib/quick-add.ts` | découpage du texte, métadonnées |
| `renderer/lib/kanban-columns.ts` | `QUICK_ADD_COLUMNS`, `isQuickAddColumn` |
| `renderer/hooks/useQuickAddShortcut.ts` | touche N |
| `renderer/components/kanban/KanbanColumn.tsx` | ouverture (« + », ligne, double-clic, N), menus de la colonne |
| `renderer/components/kanban/TaskCardMenuItems.tsx`, `TaskCardMenus.tsx` | actions d'une carte, menus « ⋮ » et clic droit, dialogue Modifier |
| `renderer/components/kanban/ColumnMenuItems.tsx` | actions d'une colonne |
| `renderer/components/kanban/CardChoiceMenuItems.tsx` | types et priorités en éléments de menu |
| `renderer/components/kanban/PointerMenu.tsx` | menu au pointeur, `isFromPortal`, `withoutPortalEvents` |
| `renderer/hooks/useBoardSelection.ts`, `useBoardShortcuts.ts`, `useBoardBulkEdits.ts` | sélection, touches, actions sur la sélection |
| `renderer/lib/group-move.ts`, `components/kanban/DragOverlayCard.tsx` | où va chaque carte d'une sélection déplacée, pile sous le pointeur |
| `renderer/lib/board-collision.ts` | la cible d'un dépôt : sous le pointeur d'abord |
| `renderer/components/kanban/BulkActionBar.tsx`, `board-selection-context.ts` | barre d'actions, sélection pour le clic droit |
| `renderer/lib/card-edits.ts`, `stores/board-undo-store.ts` | carte neuve, type et priorité en masse, Ctrl+Z |
| `renderer/stores/pending-delete-store.ts`, `components/kanban/deleteCardsLater.tsx` | suppression différée |
| `renderer/components/kanban/InlineTitleEditor.tsx`, `hooks/useInlineRename.ts` | renommage en place |
| `renderer/lib/card-focus.ts`, `components/kanban/BoardKeyboard.tsx` | flèches entre cartes, touches du tableau |
| `renderer/components/kanban/ShortcutsHelpDialog.tsx`, `stores/shortcuts-help-store.ts` | aide des touches |
| `renderer/styles/globals.css` | `.kanban-quick-add-row`, `.kanban-quick-add-pill` |

Tests : `kanban/QuickAddComposer.test.tsx`, `lib/__tests__/quick-add.test.ts`,
`shared/constants/card-types.test.ts`, `kanban/PointerMenu.test.tsx`,
`kanban/TaskCardMenuItems.test.tsx`, `kanban/ColumnMenu.test.tsx`, `__tests__/TaskCard.test.tsx`
(« right-click menu and quick edits »), `kanban/BulkActionBar.test.tsx`,
`__tests__/KanbanBoard.test.tsx` (« quick selection, deferred delete and undo »),
`lib/__tests__/card-edits.test.ts`, `stores/__tests__/board-undo-store.test.ts`,
`stores/__tests__/pending-delete-store.test.ts`, `hooks/__tests__/useBoardSelection.test.tsx`,
`hooks/__tests__/useBoardShortcuts.test.tsx`, `lib/__tests__/card-focus.test.tsx`,
`kanban/BoardKeyboard.test.tsx`, `__tests__/TaskCard.test.tsx` (« renaming in place »),
`lib/__tests__/group-move.test.ts`, `kanban/DragOverlayCard.test.tsx` ; un sous-menu se choisit au clavier dans jsdom
(`src/__tests__/helpers/menus.ts`).
