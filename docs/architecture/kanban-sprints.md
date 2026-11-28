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
par les trois derniers sprints terminés (`velocity`).

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

## Ce qui reste pour les lots suivants

La vue de planification (backlog et sprints côte à côte), « proposer le sprint » d'après la
vélocité, le burndown et le rapport de sprint (lot 6) lisent ce modèle sans le changer.
