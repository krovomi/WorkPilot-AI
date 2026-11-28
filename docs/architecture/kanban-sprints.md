---
feature: Sprints du Kanban
summary: >-
  Un sprint (nom, objectif, dates) regroupe des cartes : planifié, en cours (un seul à la fois),
  terminé (figé). Le main tient le fichier .workpilot/sprints.json d'un projet local, le serveur
  celui du clone d'un projet serveur, avec les mêmes règles. Les points sont le score de
  l'estimation intelligente, jamais une durée.
---

# Sprints du Kanban

Demandé le 22 novembre 2026 (« répartir le kanban par sprint »), lot 4 de l'étude « Kanban agile ».
Jira (sprints), Linear (cycles) et Azure Boards (itérations) ont tous ce découpage : une boîte de
cartes à livrer ensemble, avec un objectif, qu'on démarre, qu'on termine et dont on garde le bilan
pour la vélocité.

## Le modèle

`shared/types/sprint.ts` : un sprint a un id `sp-` suivi de 8 caractères hexadécimaux, un nom
(80 caractères, une ligne), un objectif facultatif (500 caractères), des jours facultatifs
`YYYY-MM-DD` (la fin jamais avant le début) et un état :

| État | Ce qu'on peut faire |
|---|---|
| Planifié | modifier, démarrer (si aucun autre n'est en cours), supprimer (ses cartes retournent au backlog) |
| En cours | modifier, terminer ; un seul sprint en cours à la fois |
| Terminé | rien : il garde son bilan |

Une carte nomme son sprint dans `metadata.sprintId` ; sans sprint, elle est au backlog. Le sprint
d'une carte appartient au tableau, pas au run : il change pendant qu'un agent travaille dessus, en
local comme sur le serveur (`BOARD_ONLY_KEYS` de `shared_board/settings.py`, qui ne renvoient pas le
409 d'une carte en cours).

**Points.** Les points d'une carte sont le score de son estimation intelligente
(`smartEstimate.adjustedScore`, sinon `complexityScore`), arrondi et borné à 13 (`taskPoints`) ;
une carte non estimée compte 0 et le menu dit combien il y en a. Aucune durée n'est estimée.

Au démarrage, le sprint garde ce qu'il contient (`committed` : cartes et points), pour le burndown
du lot 6. À la fin, il garde son bilan (`report` : cartes et points terminés, cartes et points
reportés, et où : un sprint planifié ou le backlog). La vélocité est la moyenne des points terminés
par les trois derniers sprints terminés (`velocity`, `velocityHistory`).

**Capacité.** Un sprint peut garder une capacité en points (`capacity`, 1 à 999), choisie par
l'équipe quand elle est moins disponible ou pour un premier sprint. Sans elle, la capacité est la
vélocité ; sans vélocité, une cible de 20 points (`sprintCapacity`, `DEFAULT_TARGET_POINTS`).
Un brouillon qui ne la nomme pas la garde ; `null` l'efface (retour à la vélocité), des deux côtés.

**Report.** Quand un sprint se termine, ses cartes non terminées envoyées vers un sprint planifié
gardent `metadata.carriedFrom` (l'id du sprint terminé, clé du tableau comme `sprintId`). La vue de
planification ne les dit « reportées » que si ce sprint terminé nomme bien, dans son bilan, le
sprint où la carte se trouve (`carriedFromSprint`) : une carte déplacée depuis par le menu ou un
couloir perd la marque sans que ces chemins aient à effacer la clé ; un déplacement par la vue
l'efface.

## Où vivent les sprints

Un seul fichier par projet, `.workpilot/sprints.json` (`{ "version": 1, "sprints": [...] }`),
à côté des specs, ignoré par git comme elles.

- **Projet local** : le main le lit et l'écrit (`main/sprints/local-sprints.ts`), une opération à la
  fois par projet, par un fichier temporaire renommé. Le dossier résolu (liens compris) doit rester
  dans le projet ; un temporaire laissé là, ou un lien planté par un dépôt, est supprimé et jamais
  suivi (`flag: "wx"`).
- **Projet du serveur** : `apps/backend/shared_board/sprints.py`, routes `/api/board/sprints`
  (lister ; créer ou modifier ; `/{id}/start` ; `/{id}/complete` ; supprimer). Le montage donne
  `task.read` à la lecture et `task.write` aux changements, et un changement demande un rôle
  `member` au moins (`_require_writer`) : un lecteur voit les sprints sans les boutons. Le client
  passe un `project_id`, jamais un chemin ; le fichier vit dans le clone, un lien n'y est jamais
  suivi, un verrou par projet sérialise les écritures, et chaque changement publie
  `sprints_updated` sur le flux du projet, qui fait relire le tableau et les sprints des autres
  membres (`main/server-board-live.ts`).

Les règles sont écrites deux fois, avec les mêmes refus : `main/sprints/sprint-book.ts` (et
`shared/utils/sprints.ts` pour la forme d'un brouillon) côté app, les modèles Pydantic côté
serveur. Le renderer n'est pas fiable (S6) : `main/ipc-handlers/sprint-handlers.ts` revérifie
l'id du projet, l'id du sprint, le brouillon, l'engagement et le bilan avant de toucher un fichier
ou d'appeler le serveur, qui les revérifie.

## Dans l'app

- **Le bouton « Sprints »** de la barre d'outils (`kanban/SprintMenu.tsx`) filtre le tableau :
  toutes les cartes, le backlog, ou un sprint (`KanbanFilters.sprint`, `NO_SPRINT` pour le
  backlog). Il montre chaque sprint avec son objectif, ses dates, sa progression (cartes et points
  terminés) et, pour un sprint terminé, son bilan ; la vélocité en tête. Les actions (nouveau,
  démarrer, terminer, modifier, supprimer) sont cachées à un lecteur d'un projet du serveur.
- **Terminer** (`SprintCompleteDialog`) compte ce qui est fait, demande où vont les cartes non
  terminées (un sprint planifié ou le backlog), les y déplace, puis enregistre le bilan ; si une
  carte n'a pas pu être déplacée, le sprint n'est pas terminé (`stores/sprint-store.ts`).
- **Une carte** rejoint un sprint par son menu (« Sprint », `SprintChoiceMenuItems` : le sprint en
  cours et les planifiés, jamais un terminé) ou en la glissant dans le couloir du sprint
  (regroupement « Sprint », [kanban-swimlanes.md](kanban-swimlanes.md)) ; les deux s'annulent par
  Ctrl+Z (`applyCardChoice`).

- **Le bandeau du sprint** (`kanban/SprintBanner.tsx`, rendu par `BoardLanes` au-dessus de toutes
  les dispositions) nomme le sprint dont parle le tableau : celui du filtre, sinon le sprint en
  cours (`focusedSprint`, `lib/sprint-planning.ts`). Il donne ses dates, les jours de calendrier
  qui restent jusqu'à son dernier jour (un compte de jours, jamais une estimation du travail), ce
  qu'il contient et ce qui est fait, puis l'étape suivante : n'afficher que ses cartes, le
  planifier, le démarrer ou le terminer. Sans sprint en cours ni filtré, rien ne s'affiche. Avant
  lui, un sprint créé et démarré n'apparaissait que dans le menu : le tableau n'en disait rien.
- **La vue de planification** (`kanban/SprintPlanningDialog.tsx`, côtés dans
  `kanban/SprintPlanningPane.tsx`) met le backlog (cartes sans sprint, ni terminées, ni
  abandonnées, ni archivées, de la plus urgente à la plus ancienne) à côté des cartes du sprint.
  Au-dessus, la jauge de capacité (`kanban/SprintCapacity.tsx`) : les points du sprint, la ligne
  de capacité, les points terminés des derniers sprints, et un réglage par pas d'un dixième de la
  vélocité (affiché en % de la vélocité), ou par point pour une cible. Une carte passe de l'autre
  côté par sa flèche, en cochant plusieurs cartes puis « Ajouter au sprint » ou « Renvoyer au
  backlog », en la glissant (les cartes cochées partent ensemble ; glisser-déposer natif, type
  `application/x-workpilot-planning`), ou au clavier (→ depuis le backlog, ← depuis le sprint, sur
  le titre). Le dernier déplacement s'annule (« Annuler », Ctrl+Z). Le backlog a une recherche et
  des filtres rapides (urgentes ou hautes, bugs, non estimées) ; une carte sans points propose
  « Estimer » (l'estimation intelligente de la carte, qui garde son score). Côté sprint, une carte
  reportée est marquée, et une carte qui attend (`blockedBy`) une carte ni terminée ni dans le
  sprint le dit (`waitingOn`) ; celles de ces cartes encore au backlog s'ajoutent d'un clic
  (`missingBlockers`). Un sprint planifié démarre depuis la vue. Elle s'ouvre depuis le bandeau,
  depuis le bouton « Planifier » de chaque sprint ouvert du menu, et d'elle-même après la création
  d'un sprint. Une seule est ouverte à la fois (`planningId` du store), jamais sur un sprint
  terminé. Les déplacements passent par `assign` du store, qui refuse un sprint terminé ou
  inconnu ; les arguments sont revérifiés par le main comme pour le menu d'une carte. Un lecteur
  d'un projet du serveur voit le plan sans cases, flèches, réglage ni démarrage.

## Ce qui reste pour les lots suivants

« Proposer le sprint » (l'IA remplit le sprint jusqu'à sa capacité, maquette du 28 novembre 2026)
s'appuie sur la capacité, les reports et les dépendances ci-dessus.
