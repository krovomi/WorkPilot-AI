---
feature: Pixel Office
summary: >-
  Les agents du projet en personnages pixel art, aux couleurs de leur fournisseur ; succès et
  saisons trimestrielles calculés à partir de faits normalisés (tâche livrée, QA du premier coup,
  incident résolu, accord d'un second moteur) sur tous les providers ; mini-scènes quand une tâche
  change de mains, écrites par le modèle de la page sur option ; mode TV plein écran et mode calme.
---

# Pixel Office (#350)

Pixel Office montre chaque terminal d'agent, chaque tâche active du Kanban et chaque sous-tâche
d'un swarm en personnage à son bureau (`components/pixel-office/`, état dans
`stores/pixel-office-store.ts`). #350 y ajoute des **succès** qui racontent ce que le projet a
livré et un **mode TV** pour l'écran d'une équipe (lot 1), puis des **saisons** qui décorent le
bureau, des **mini-scènes** et la **couleur du fournisseur** de chaque personnage (lot 3).

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

## Couleur du fournisseur

`renderer/lib/pixel-office-providers.ts` range chaque fournisseur dans une famille (Anthropic,
OpenAI, Google, Ollama, Copilot, Grok, autre) et lui donne une couleur de chemise
(`FAMILY_SHIRTS`). Le personnage d'une tâche porte celle du fournisseur de la phase en cours
(planification, code ou QA), lue comme le backend la lit (`resolveTaskEngine`) ; un terminal en
mode Claude est Anthropic. Un fournisseur inconnu est « autre », jamais pris pour un vendeur
connu ; sans fournisseur, le personnage garde ses couleurs. `getCharacterSprite` prend la
chemise en paramètre (et dans sa clé de cache), et la barre d'outils nomme les familles au
travail (`ProviderLegend.tsx`).

## Saisons

`renderer/lib/pixel-office-seasons.ts` : une saison est un trimestre civil (heure locale). Ses
cinq objectifs (`SEASON_GOALS`) comptent des faits datés : tâches livrées, QA approuvée à la
première session, tâches de refactorisation livrées (le « remboursement de dette » mesuré par ce
que le projet livre, pas par un score), incidents résolus (`resolved_at` du runner, une date
illisible ne compte dans aucune saison), accord d'un second moteur. Une tâche est datée par sa
dernière modification, comme le succès hebdomadaire.

Un objectif atteint dans **n'importe quelle** saison gagne pour de bon sa récompense : une pièce
de décor (étagère à trophées, plantes, tableau blanc, enseigne néon, borne d'arcade) dessinée par
`office-decor.ts` sur le mur du fond ou la bande de sol devant, où aucun bureau ne s'assoit. Le
décor se **calcule** à partir des faits (`earnedDecor`) : rien n'est stocké, un autre poste qui
lit le même projet voit le même bureau, et les saisons ne s'additionnent pas. Le décor est
immobile, le mode calme n'a rien à arrêter. Le panneau de la saison (`SeasonPanel.tsx`) donne le
nom, la date de fin, chaque objectif avec sa progression et sa récompense, et le décor gagné.

## Mini-scènes

`renderer/lib/pixel-office-narratives.ts` dit **quelle** scène une transition de tâche est :
plan remis au Coder, travail rendu au Reviewer QA, renvoyé au Fixer, validé (en attente de la
personne), livré, ou arrêté sur une erreur. Ce sont des changements de statut et de phase, jamais
un signal propre à un fournisseur. `use-office-narratives.ts` compare deux lectures des tâches du
projet : la première lecture d'un projet est silencieuse, une liste en chargement ne compte pas,
trois scènes au plus restent 30 s. `NarrativeFeed.tsx` les écrit à partir de gabarits i18n
(hors-ligne, tous fournisseurs), dans une région `aria-live="polite"`, sans transition en mode
calme ; elles se voient aussi en mode TV.

Sur option (`settings.narrativesAi`, éteinte par défaut et relue à `true` seulement), le modèle de
la page écrit la phrase : `PIXEL_OFFICE_NARRATE` (`main/ipc-handlers/pixel-office-handlers.ts`).
La requête ne porte que des listes fermées (scène, rôles, familles, langue) et un numéro de spec
en chiffres ; le main la revérifie (`parseNarrativeRequest`), écrit le prompt lui-même et **ne
reçoit ni le titre ni le contenu de la tâche** : un titre peut venir d'un ticket importé, et la
scène se raconte sans lui. La page `pixel-office` est dans `PAGE_LLM_FEATURES` (modèle
« utilitaire ») : son sélecteur choisit fournisseur et modèle (Haiku, un petit modèle OpenAI ou
Gemini, un modèle Ollama local), et `runOneShotLLM` les exécute. La réponse est ramenée à une
ligne bornée sans caractère de contrôle (`narrativeText`) ; un refus, un échec ou une réponse
vide laissent le gabarit.

## Pas encore fait

- **Classement d'équipe**, opt-in par personne (aucun nom affiché sans accord), pondéré par la
  complexité estimée et le coût normalisé (catalogue Cost Intelligence), qui compte l'entraide
  (revues, approbations) ; en mode serveur, agrégé par organisation. Il faut une personne derrière
  chaque fait : seul le mode serveur en a (`specs_index.claimed_by`, `spec_approvals`). C'est une
  route du serveur avec sa permission, une table d'accord et sa migration, puis un client dans
  l'app : un lot à lui.
- **Succès d'équipe et profil** : badges par personne en mode serveur (aujourd'hui, par projet
  et sur ce poste), sur la même route que le classement.
- Récompenses cosmétiques au choix (skins d'agents) : aujourd'hui, le décor gagné s'affiche
  entier, sans réglage.
