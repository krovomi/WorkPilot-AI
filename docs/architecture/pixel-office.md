---
feature: Pixel Office
summary: >-
  Les agents du projet en personnages pixel art ; succès calculés à partir de faits normalisés
  (tâche livrée, QA du premier coup, incident résolu, accord d'un second moteur) sur tous les
  providers, annoncés une fois ; mode TV plein écran avec mode calme et rafraîchissement.
---

# Pixel Office (#350, lot 1)

Pixel Office montre chaque terminal d'agent, chaque tâche active du Kanban et chaque sous-tâche
d'un swarm en personnage à son bureau (`components/pixel-office/`, état dans
`stores/pixel-office-store.ts`). Le lot 1 de #350 y ajoute deux choses : des **succès** qui
racontent ce que le projet a livré, et un **mode TV** pour l'écran d'une équipe.

## Succès

### D'où viennent les faits

Une règle ne lit que des faits normalisés, jamais un signal propre à un provider : le même projet
gagne les mêmes succès qu'il tourne sur Claude, un modèle local ou un mélange.

| Fait | Source | Lu par |
|---|---|---|
| tâche livrée (`done` ou `pr_created`) et sa date | les tâches du projet (`task-store`) | `collectFacts` |
| QA approuvée à la première session | `qa_signoff` du plan (`status`, `qa_session`, écrits par `qa/reviewer.py`), porté sur la tâche en `qaSignoff` par `main/project-store.ts` | `shared/utils/qa-signoff.ts` |
| accord d'un second moteur | `crossReview.verdict === "agree"` (`cross_review/`) | `collectFacts` |
| incident résolu, et réparé par une PR d'agent | `selfHealing.getIncidents` (statut `resolved`, `fix_pr_url`) | `incidentFactsOf` |

Le plan est écrit par un agent et la liste d'incidents sort d'un sous-processus : rien n'y est
pris pour typé. Un `qa_signoff` dont le statut n'est ni `approved` ni `rejected`, ou dont la
session n'est pas un entier à partir de 1, ne compte pas ; un incident sans statut texte est
ignoré, une URL de correctif vide compte comme aucune.

Le catalogue (`renderer/lib/pixel-office-achievements.ts`, `ACHIEVEMENT_IDS`) : première
livraison, dix livraisons en sept jours, QA du premier coup (une, puis cinq), incident résolu,
incident réparé par un agent, deuxième avis. Les règles sont des fonctions pures des faits et de
l'heure (`earnedAchievements`).

### Annoncés une fois

`stores/pixel-office-achievements-store.ts` garde, par id de projet, la date à laquelle chaque
succès a été vu gagné (local storage, relu en ne gardant que des ids connus et des dates texte).
`record` renvoie ce qui est nouveau depuis la dernière évaluation ; **la première évaluation d'un
projet est silencieuse** : un projet qui avait déjà livré trente tâches reçoit ses succès sans
six annonces d'affilée, comme les carillons du bureau se taisent pour un agent qui attendait déjà
à l'ouverture. Pour la même raison, `use-office-achievements.ts` attend la liste d'incidents et
la fin du chargement des tâches avant d'évaluer : un projet n'est jamais enregistré sur une
liste à moitié lue. Une réponse d'incidents arrivée pour un projet qu'on a quitté est jetée ; un
runner qui échoue compte comme aucun incident.

L'annonce (`AchievementToast.tsx`) vit dans le bureau, pas dans le toaster de l'app : elle se voit
aussi en mode TV, et un lecteur d'écran l'entend par une région `aria-live="polite"`. La liste
complète, gagnés et verrouillés, s'ouvre depuis le trophée de la barre d'outils
(`AchievementsPanel.tsx`).

## Mode TV

`use-kiosk-mode.ts` : l'état est le nôtre, le plein écran est un bonus. Le bouton demande le
plein écran du bureau (`requestFullscreen`) ; s'il est refusé ou absent, le bureau passe quand
même en disposition TV dans la fenêtre. Échap, ou la sortie du plein écran par le système, quitte
le mode TV. Pendant qu'il est actif, les tâches et les incidents sont relus chaque minute
(`KIOSK_REFRESH_MS`) : personne n'est là pour cliquer.

`KioskOverlay.tsx` remplace la barre d'outils : de grands compteurs (actifs, qui vous attendent,
livrées aujourd'hui, succès), une horloge dans la langue de l'app (`formatAppTime`), le mode
calme et la sortie. La zone du canvas est mesurée elle-même (`ResizeObserver` sur la zone, et
non la vue moins une hauteur de barre) : l'en-tête TV est plus haut que la barre qu'il remplace.

### Mode calme

`settings.calmMode` (persisté avec les autres préférences du bureau). `use-office-motion.ts`
rend le bureau immobile quand le mode calme est actif **ou** quand le système demande moins
d'animations (`prefers-reduced-motion`, suivi en direct) ; dans ce second cas le bouton est
désactivé et dit pourquoi. Calme : le canvas dessine toujours l'état, mais son compteur
d'images ne bouge plus (toutes les animations le lisent), la file d'attente ne rebondit plus,
ses petits personnages ne s'animent plus et l'annonce d'un succès arrive sans transition.

## Pas encore fait

- **Classement d'équipe**, opt-in par personne (aucun nom affiché sans accord), pondéré par la
  complexité estimée et le coût normalisé (catalogue Cost Intelligence) pour ne pas pénaliser un
  utilisateur Ollama ou d'un petit modèle ; en mode serveur, agrégé par organisation.
- **Saisons** de trois mois avec objectifs d'équipe et récompenses cosmétiques.
- **Mini-récits** générés par un modèle léger au choix (via `create_client()`), désactivables.
- **Succès d'équipe et profil** : badges par personne en mode serveur (aujourd'hui, par projet
  et sur ce poste).
- Palette de personnages par famille de provider.
