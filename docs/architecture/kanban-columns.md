---
feature: Colonnes du Kanban (style Bandeau)
summary: >-
  En-tête de colonne en bandeau teinté de la couleur de la colonne : icône sur une tuile pleine,
  gros compteur, jauge de capacité (créneaux d'« En cours », limite WIP) qui passe à l'ambre ;
  ligne de résumé calculée depuis les cartes, masquable ; corps neutre pour les cartes Halo ;
  état vide, cible de dépôt et colonne repliée à la couleur de la colonne ; textes à 4,5:1.
---

# Colonnes du Kanban (style Bandeau)

Demandé le 21 novembre 2026 (« les colonnes ne sont pas très sexy ») ; style choisi le
22 novembre sur maquette parmi trois (Lumière, Couloir, Bandeau). Les cartes gardent le style
Halo de [kanban-card-colors.md](kanban-card-colors.md).

## Ce que montre une colonne

| Élément | Où | Rôle |
|---|---|---|
| Bandeau | `.kanban-col-band` (`styles/kanban-columns.css`) | dégradé de l'accent de la colonne sur la couleur des cartes, de 22 % à 11 % ; bordure basse à 30 % |
| Icône | `ColumnIcon` (`kanban/ColumnBand.tsx`) | la même que l'état vide, sur une tuile pleine de l'accent ; tourne dans « En cours » tant qu'une carte y est (sauf `prefers-reduced-motion`) |
| Compteur | `ColumnCount` | gros chiffre à droite ; `n/limite` quand la colonne a une limite, phrase complète pour les lecteurs d'écran |
| Jauge | `ColumnGauge` | « En cours » : un segment par tâche parallèle (`maxParallelTasks`, au-delà de 8 une barre) ; autre colonne : barre vers sa limite WIP |
| État vide | `ColumnEmptyState` | icône dans un halo de l'accent, message et indication, cadre pointillé ; « Build rouge » vide montre une coche |
| Cible de dépôt | `.kanban-column.drop-zone-highlight` | bordure, halo et lueur de l'accent de la colonne visée (l'ancienne couleur jaune fixe ignorait le thème) |
| Colonne repliée | `.kanban-col-collapsed` | toute la bande teintée : icône, compteur, nom vertical ; pas de message d'état vide (trop étroit) |

Le corps de la colonne est une surface neutre (`--card` à 40 % sur `--background`) : la
couleur de la colonne vit dans le bandeau et le liseré gauche des cartes.

## Capacité (`lib/kanban-column-meta.ts`)

`columnCapacity(nombre, limite, type)` rend `open`, `full` ou `over` :

- `slots` (« En cours », limite dure des tâches parallèles) : avertit dès que c'est plein ;
- `wip` (limite douce posée par l'utilisateur) : n'avertit qu'une fois dépassée, avec
  l'infobulle `kanban.wipLimit.exceeded`.

## Couleurs lisibles sur chaque thème (`lib/kanban-column-tokens.ts`)

Dessiné dans l'accent brut, le compteur descend à 1,5:1 sur son bandeau (cyan sur thème clair).
Comme pour les pastilles des cartes, une feuille de style générée (`#kanban-column-colors`)
calcule par colonne et par thème, en oklab :

| Variable | Sur | Cible |
|---|---|---|
| `--col-ink` | le haut du bandeau | 4,5:1 (compteur) |
| `--col-warn-ink` | le haut du bandeau | 4,5:1 (compteur plein ou dépassé, alerte du résumé) |
| `--col-muted` | le haut du bandeau | 4,5:1 (ligne de résumé, libellé de la jauge) |
| `--col-on` | la tuile pleine de l'accent | noir ou blanc, le plus contrasté |
| `--col-icon` | le halo de l'état vide | 3:1 (élément graphique, WCAG 1.4.11) |

Les accents de `COLUMN_ACCENTS` répètent les règles `.column-*` de `globals.css`, qui restent la
source du liseré des cartes ; `kanban-column-meta.test.ts` vérifie qu'ils concordent et
`kanban-column-tokens.test.ts` mesure les cinq cibles sur les 7 thèmes en clair et en sombre.
Sans feuille générée (tests, couleur de thème illisible), chaque variable retombe sur un jeton du
thème.

## Ligne de résumé

Sous le titre, une ligne dit ce que contient la colonne sans ouvrir de carte. Elle est calculée
par `lib/column-pulse.ts` depuis les cartes que la colonne a déjà, sans appel au modèle ni IPC :

| Colonne | Résumé |
|---|---|
| À faire | cartes urgentes (en alerte), puis haute priorité |
| File d'attente | prochaine carte, puis les priorités |
| En cours | où en sont les agents : planification, code, QA, en pause (en alerte) ; la jauge dit déjà les créneaux |
| Revue humaine | plans à approuver, à relire, à corriger (en alerte : erreur, QA refusée, contexte trop long) |
| Terminé | terminées depuis lundi 00:00, heure locale |

Les autres colonnes n'en ont pas. Le texte est coupé par une ellipse et entier dans l'infobulle.
Le réglage `kanbanColumnSummary` (Paramètres › Affichage, activé par défaut) la masque.
