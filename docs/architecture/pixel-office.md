---
feature: Pixel Office
summary: >-
  Les agents en personnages pixel art ; succès et saisons tirés de faits normalisés (tâche livrée,
  QA du premier coup, incident résolu) sur tous les providers ; mini-scènes ; mode TV et mode
  calme ; habits et décor au choix ; sur un projet du serveur, classement d'équipe opt-in et
  badges par personne calculés par le serveur, sans télémétrie.
---

# Pixel Office (#350)

Pixel Office montre chaque terminal d'agent, chaque tâche active du Kanban et chaque sous-tâche
d'un swarm en personnage à son bureau (`components/pixel-office/`, état dans
`stores/pixel-office-store.ts`). #350 y ajoute des **succès** qui racontent ce que le projet a
livré et un **mode TV** pour l'écran d'une équipe (lot 1), puis des **saisons** qui décorent le
bureau, des **mini-scènes** et la **couleur du fournisseur** de chaque personnage (lot 3), enfin
les **cosmétiques au choix** et, sur un projet du serveur, le **classement d'équipe** et les
**badges par personne** (lot 4).

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

## Cosmétiques

`renderer/lib/pixel-office-skins.ts`, `CosmeticsPanel.tsx`. Trois habits : la couleur du
fournisseur (par défaut), les couleurs propres du personnage, ou le **néon**, une récompense
portée une fois chaque objectif de saison atteint au moins une fois (les cinq pièces de décor
gagnées). Un néon choisi sur un projet qui ne l'a pas gagné n'y est pas porté : le bureau
s'habille alors par fournisseur (`wornSkin`). Chaque pièce de décor gagnée peut être cachée ; le
canvas dessine le reste (`shownDecor`). Les deux choix sont des préférences d'affichage de ce
poste (`settings.agentSkin`, `settings.hiddenDecor`), relues depuis des listes fermées. Le canvas
et la file d'attente prennent la chemise de `agentShirt(famille, habit)`.

## Classement d'équipe et badges (mode serveur)

Sur l'ordinateur, rien ne dit qui a fait le travail ; un serveur le sait. La feature
`pixel_office` (domaine `analytics`, servie par un serveur) calcule, **sur le serveur et pour la
seule personne qui demande**, à partir de sa base et des fichiers du clone
(`apps/backend/shared_features/pixel_office.py`). Rien n'est envoyé à un service central : pas
de télémétrie.

| Action | Route | Il faut |
|---|---|---|
| Lire le classement et son propre score | `GET /api/features/pixel-office/leaderboard?project_id=…&scope=project\|org&period=season\|all` | `analytics.read`, un rôle sur le projet |
| Montrer ou cacher son nom | `PUT /api/features/pixel-office/consent?project_id=…`, corps `{"visible": bool}` | `analytics.read` (`ROUTE_OVERRIDES`) : la route n'écrit que la ligne de la personne ; écrit au journal d'audit |

**Ce qui compte.** Une carte livrée (`done` ou `pr_created`) est créditée à la personne qui a
lancé son dernier build réussi (`agent_runs.started_by`) et vaut la complexité évaluée par
l'agent de spec (`complexity_assessment.json`, lu par `approval_policy.assessed_criticality`,
dossier de carte résolu par `board_mcp.card_dir`, lien refusé) : 1, 2 ou 3 points, 1 sans
évaluation. La criticité qu'une personne choisit n'est pas lue : personne ne relève son propre
score. L'approbation d'une carte écrite et livrée par un autre (`spec_approvals`) compte comme de
l'**entraide**, 2 points, une fois par carte et par personne : relire pèse comme livrer une carte
standard, le classement ne récompense pas le travail en solo ni les petites cartes. **Aucun
jeton ni prix** n'est lu : le même travail vaut autant sur Claude, un modèle local ou un autre
fournisseur. C'est la forme stricte de « pondérer par le coût normalisé » : un coût, même
normalisé, suit le nombre de jetons, qu'un modèle bavard gonfle.

**Qui est nommé.** Personne, sans son accord (`leaderboard_consents`, une ligne par personne et
organisation, migration `0023`, écrite par la seule personne). Sans accord, le travail de la
personne n'est compté que pour elle : `me` donne toujours son score et ses badges, `entries` ne
liste que les personnes qui ont dit oui, au plus 50, rang partagé à points égaux. Aucun total des
autres n'est donné : avec une seule personne absente, ce serait le sien.

**Où et quand.** `scope=project` lit le projet ; `scope=org`, chaque projet de son organisation
que la personne lit elle-même (`load_project_scope`, au plus 100), comme `/workspace/compare`.
`period=season` est le trimestre civil en UTC (l'heure du serveur, pour que chacun lise le même
classement), `all` depuis le début ; les badges (`BADGES` : première livraison, dix livraisons,
une carte complexe, première revue, dix revues) comptent toujours depuis le début.

**Dans l'app.** Pixel Office s'ouvre sur un projet du serveur (`SERVER_PROJECT_VIEWS`) : ses
personnages sont ses cartes, aucun terminal ne s'ouvre sur le miroir et aucun runner
Self-Healing local ne le lit. La barre d'outils y ajoute `TeamBoardPanel.tsx`
(`use-team-board.ts`), lu seulement tant qu'il est ouvert ; une réponse pour un choix ou un
projet quitté est jetée. Le main (`main/server-pixel-office.ts`, canaux
`PIXEL_OFFICE_TEAM_BOARD` et `PIXEL_OFFICE_TEAM_CONSENT`) revérifie l'id de projet (un projet
listé du serveur), la portée et la période (listes fermées), le booléen, et relit la réponse
champ par champ (nom ramené à un libellé, entiers, badges connus).

## Pas encore fait

Rien de ce que demande #350 et qui se construit ici. Hors de portée :

- **Mesurer l'engagement** (temps passé sur l'onglet, équipes qui activent le mode TV, part des
  personnes qui ont un succès) : ce sont des métriques d'usage du produit, qui demandent de la
  télémétrie, et la décision est de ne pas en envoyer. Les mesurer sur le serveur d'une équipe,
  pour cette équipe, serait une autre décision produit.
