---
feature: Couleurs des cartes Kanban par type
summary: >-
  Un type visuel par carte (14, en 5 familles) résolu sans saisie depuis kind, catégorie, sévérité,
  import et origine ; style Halo (lueur d'angle, liseré haut), liseré gauche laissé à la colonne ;
  couleurs mélangées en oklab au thème actif avec texte AA garanti ; fiche d'information au survol
  après 700 ms.
---

# Couleurs des cartes Kanban par type

Demandé le 21 novembre 2026 ; style choisi sur maquette parmi quatre (Halo, Voile, Verre,
Pastille). Ce document dit ce qui est livré et pourquoi.

## Deux axes, deux emplacements

Le liseré gauche d'une carte (`.kanban-card::before`, `--col-accent`) dit **où** elle en est :
il appartient à la colonne et ne change pas. Le type dit **de quoi** elle parle : il colore le
fond, par une lueur partie du coin haut-droit et un liseré de 2 px en haut
(`.kanban-card[data-card-type]` dans `styles/globals.css`). Aucune couleur n'a deux sens : la
priorité reste une pastille, l'exécution un anneau, le blocage des hachures.

## Le type : une donnée qui existe déjà

`shared/constants/card-types.ts` (`resolveCardType`) décide le type sans rien demander, dans cet
ordre : choix de l'utilisateur (`kindSource: "user"`) › correctif urgent (`kind: hotfix`) ›
sécurité (catégorie ou `securitySeverity`) › bug › type de travail (`kind`) › catégorie › type
importé Jira/Azure (Bug) › origine (`tech-debt`, `flaky-tests`). Un `kind` seulement par
défaut (`kindSource: "default"`) ne dit rien : la carte reste neutre. Le résultat porte aussi
les types secondaires (points après la pastille), `proposed` (confiance < 0,6, pastille en
pointillés, teinte réduite) et `basis` (ce qui a décidé, montré dans la fiche).

| Famille | Types |
|---|---|
| Construire | `feature`, `ux` |
| Corriger | `bug`, `hotfix` |
| Fiabiliser | `security`, `perf`, `refactor`, `test` |
| Comprendre | `investigation`, `spike`, `docs` |
| Exploiter | `run`, `upgrade`, `infra` |

La carte n'affiche plus qu'une pastille (`kanban/CardTypeChip.tsx`) à la place du badge de
`kind` et du badge de catégorie ; le sélecteur de type du détail de tâche (`TaskKindBadge`)
reste l'endroit où on le change.

## Les couleurs suivent le thème, le contraste est garanti

Chaque type a une teinte de base. `renderer/lib/card-type-tokens.ts` la mélange, en oklab
comme `color-mix`, avec `--card`, `--foreground`, `--muted-foreground` et `--border` du thème
actif, puis pousse le texte de la pastille et le gris de la description vers `--foreground`
juste assez pour tenir 4,5:1 sur la surface où ils sont posés. Le résultat est **une** feuille
de style générée (`#kanban-card-type-colors`, une règle par type et une variante
`[data-card-faded]`), réécrite quand la classe ou `data-theme` de la racine change : la carte
ne porte que `data-card-type`, le tableau mémoïsé ne se re-rend pas. Les thèmes à surface
colorée (Forest, Ocean, Retro en sombre) et une couleur choisie plus tard par l'utilisateur
passent par le même calcul. `card-type-tokens.test.ts` relit les 14 thèmes dans `globals.css`
et vérifie titre, description et pastille, aux deux intensités, atténués ou non.

Le correctif urgent est toujours en intensité marquée. Sous `forced-colors`, les teintes
disparaissent ; l'icône et le libellé restent.

## La fiche au survol

`hooks/useHoverPreview.ts` ouvre la fiche après 700 ms de repos du pointeur sur la carte, ou
du focus clavier visible ; elle se ferme 150 ms après la sortie, au premier appui (un glisser
commence par un appui) et sur Échap. Après une fiche fermée, la carte suivante montre la sienne
tout de suite pendant 300 ms. Sur un bouton, un lien, une case ou un badge qui a sa propre
infobulle (`[data-state]`), la fiche ne s'ouvre pas. Elle n'est rendue qu'ouverte
(`kanban/TaskCardPreview.tsx`) : type et `basis`, titre complet, 320 caractères de
description, priorité, complexité, impact, statut et progression, cartes qui bloquent, origine,
moteur, dernière activité.

## À venir

- Réglages (Paramètres › Kanban) : style, intensité, couleur par type, délai de la fiche ;
  légende cliquable au-dessus du tableau, branchée sur le filtre.
- Application mobile : mêmes types, fond teinté uni.
