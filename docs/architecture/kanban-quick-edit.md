---
feature: Ajout et édition rapides des cartes Kanban
summary: >-
  Ajout d'une ou plusieurs cartes depuis Planification et File d'attente (bouton, ligne sous les
  cartes, double-clic sur le vide, touche N, collage d'une liste) ; type et priorité choisis à la
  création ; assistant complet prérempli. Lots suivants : clic droit, sélection, annulation, clavier.
---

# Ajout et édition rapides des cartes Kanban

Demandé le 21 novembre 2026 : ajouter, modifier ou supprimer une ou plusieurs cartes prenait trop
de gestes (l'assistant complet pour chaque carte, la fiche puis une modale pour renommer). Le
travail est découpé en quatre lots, un par PR, dans cet ordre :

1. **Ajout rapide en colonne** (ce document, livré).
2. Clic droit sur carte et colonne, une seule liste d'actions partagée avec le menu « ⋮ ».
3. Sélection Ctrl/Maj, barre d'actions groupées enrichie, suppression différée, Ctrl+Z.
4. Renommage en ligne, navigation au clavier, aide des raccourcis.

## Où l'on crée une carte

Seulement dans **Planification** (`backlog`) et **File d'attente** (`queue`),
`QUICK_ADD_COLUMNS` de `renderer/lib/kanban-columns.ts`. Les autres colonnes sont tenues par le
pipeline (En cours, Révision IA, Révision humaine), la CI (Build rouge) ou le suivi des PR (PR
ouverte, Terminé) : une carte créée là ne décrirait rien de réel.

Une carte créée dans File d'attente y est placée (`persistTaskStatus(…, "queue")`), puis
`kickQueue()` demande au tableau de démarrer ce qu'il a la place de démarrer : elle part dès qu'un
emplacement est libre, comme « Tout mettre en file ».

## Les gestes

| Geste | Effet |
|---|---|
| « + » de l'en-tête, ligne « Ajouter une carte » sous les cartes | ouvre la boîte en haut de la colonne |
| double-clic dans le vide de la colonne | idem ; jamais sur une carte ni un contrôle (`QUICK_ADD_IGNORED_TARGETS`) |
| touche N (Planification) | idem, hors saisie, hors Ctrl/Cmd/Alt, sans dialogue ni menu ouvert (`hooks/useQuickAddShortcut.ts`) ; une colonne repliée se déplie |
| Entrée | crée et garde la boîte ouverte, vide, pour la carte suivante |
| Maj+Entrée | nouvelle ligne |
| Échap ou ✕ | ferme ; le texte non créé est rendu à la prochaine ouverture (par projet et colonne, pour la vie de la fenêtre) |
| « Plus d'options… » | écrit le texte (et la priorité) dans le brouillon de l'assistant (`saveDraft`) puis ouvre l'assistant complet |

Un simple clic dans le vide n'ouvre rien : il sert déjà à désélectionner, et le relâché d'un
glisser-déposer y tombe souvent.

## Ce que devient le texte

`renderer/lib/quick-add.ts`, fonctions pures :

- une ligne courte (≤ `QUICK_ADD_TITLE_MAX` = 120 caractères) devient le titre et la description ;
- un texte plus long ou sur plusieurs lignes devient la description, le titre est laissé vide et
  le main le génère comme pour l'assistant (`TASK_CREATE`, `titleGenerator`) ;
- une liste collée (au moins deux lignes, toutes courtes) donne **une carte par ligne**, puces et
  numéros retirés, au plus `QUICK_ADD_MAX_CARDS` = 50. Le bouton « Une carte par ligne (N) »
  bascule ce choix ; une description sur plusieurs lignes longues reste une seule carte par défaut.

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

## Fichiers

| Fichier | Rôle |
|---|---|
| `renderer/components/kanban/QuickAddComposer.tsx` | la boîte |
| `renderer/lib/quick-add.ts` | découpage du texte, métadonnées |
| `renderer/lib/kanban-columns.ts` | `QUICK_ADD_COLUMNS`, `isQuickAddColumn` |
| `renderer/hooks/useQuickAddShortcut.ts` | touche N |
| `renderer/components/kanban/KanbanColumn.tsx` | ouverture (« + », ligne, double-clic, N) |
| `renderer/styles/globals.css` | `.kanban-quick-add-row`, `.kanban-quick-add-pill` |

Tests : `kanban/QuickAddComposer.test.tsx`, `lib/__tests__/quick-add.test.ts`,
`shared/constants/card-types.test.ts`.
