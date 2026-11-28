---
feature: Proposer le sprint
summary: >-
  Remplit un sprint jusqu'à sa capacité, en points : des règles classent le backlog et ajoutent
  ce qu'une tâche attend avant elle ; le modèle du provider choisi compose le sprint parmi les
  mieux classées et dit pourquoi, les règles vérifient son choix et répondent seules sans lui.
  Rien ne bouge avant que la personne ajoute les tâches.
---

# Proposer le sprint

La vue « Planifier » d'un sprint ([kanban-sprints.md](kanban-sprints.md)) propose les tâches
qui remplissent le sprint jusqu'à sa capacité, chacune avec sa raison, et les meilleures qui
n'y entrent pas. La personne garde la main : la proposition n'écrit rien, les tâches ne passent
dans le sprint que lorsqu'elle les ajoute (`assign` du store des sprints).

## Où vit le code

| Fichier | Rôle |
|---|---|
| `apps/frontend/src/shared/types/sprint-proposal.ts` | types, variantes, bornes (`SPRINT_PROPOSAL_LIMITS`) |
| `apps/frontend/src/main/sprint-proposal/proposal-rules.ts` | classement, remplissage, proposition sans modèle |
| `apps/frontend/src/main/sprint-proposal/proposal-service.ts` | prompt, lecture de la réponse, vérification, repli sur les règles |
| `apps/frontend/src/main/ipc-handlers/sprint-proposal-handlers.ts` | canal `SPRINTS_PROPOSE` : requête revérifiée, tableau et sprints lus dans le main |
| `apps/frontend/src/preload/api/modules/sprints-api.ts` | `proposeSprint(request)` |

## Les règles

Une **candidate** est une tâche du backlog qu'on peut planifier : pas de sprint, ni terminée,
ni abandonnée, ni archivée, et estimée. Ses points viennent de l'estimation intelligente
(`taskPoints`, 1 à 13). Une tâche sans estimation n'est pas comptée, donc pas proposée : elle
est listée à part (`unestimated`) pour que la vue offre « Estimer ».

Le score d'une candidate additionne :

| Facteur | Poids |
|---|---|
| Priorité | urgente 40, haute 25, moyenne 10, basse 0, aucune 5 |
| Bug (`category: bug_fix`) | 15, ×3 pour la variante « Bugs d'abord » |
| Tâches ouvertes qui l'attendent | 8 chacune |
| Mots du but (4 lettres et plus, sans accents) dans le titre ou la description | 12, ×3 pour « Autour du but » |
| Âge | un point par 3 jours, plafonné à 30 jours |

À score égal, la plus ancienne passe d'abord, puis l'ordre alphabétique.

Le **remplissage** (`fill`) prend les tâches dans l'ordre et, pour chacune, ce qu'elle attend
(`metadata.blockedBy`) d'abord, quand ce sont aussi des candidates. Une tâche dont l'attente
mène hors des candidates (une tâche d'un autre sprint, une tâche sans estimation) n'est pas
proposée et part dans `blocked`. Une tâche qui dépasserait la capacité, avec ce qu'elle
attend, va sous la ligne (`below`, trois au plus, avec le total du sprint si on l'ajoutait).

La capacité est celle du sprint, sinon la vélocité des 3 derniers sprints, sinon 20 points
(`sprintCapacity`) ; la requête peut en donner une autre pour cette proposition. Les points
déjà dans le sprint (`committed`) sont retirés de la place. « Plus prudent » remplit 80 % de
la capacité.

## Le modèle

Le modèle du provider choisi (`runOneShotLLM`, donc tous les providers) lit les 40 candidates
les mieux classées, nommées `c1`…`c40`, et répond en JSON : les tâches dans l'ordre de lecture,
une raison courte pour chacune, un but s'il n'y en a pas, un résumé. Raisons, but et résumé
sont écrits dans la langue de l'app.

Son choix est vérifié par les mêmes règles : une tâche n'est nommée que par une référence que
le code a donnée, elle entre après ce qu'elle attend, et seulement tant que la capacité tient.
Les candidates qu'il a laissées de côté ne sont jamais ajoutées ; les meilleures qui ne
tiendraient pas restent listées sous la ligne. Sans réponse exploitable (pas de provider, délai
de 60 s dépassé, JSON illisible, aucune tâche qui tienne), la proposition des règles répond
(`mode: "rules"`).

## Confiance et données personnelles

- La requête du renderer est revérifiée (S6) : id de projet connu, id de sprint, variante dans
  la liste fermée, but de 500 caractères au plus, capacité entière de 1 à 999. Le renderer
  n'envoie ni tâches ni sprints : le main les lit, dans le fichier du projet ou sur le serveur,
  qui n'envoie que ce que l'appelant a le droit de lire.
- Le texte des tâches et le but entrent dans le prompt comme données citées (`quoteUntrusted`,
  S2) ; la réponse est lue dans des listes fermées et des textes bornés.
- RGPD : le modèle ne lit que le titre, le début de la description (240 caractères, sans
  balises), la priorité, le type, les points, les étiquettes et les dépendances. Jamais qui
  travaille sur la tâche, ni un autre champ.
- Aucune durée n'est estimée : la proposition ne parle qu'en points.

## Dans la vue Planifier

`renderer/components/kanban/SprintProposalPanel.tsx`, état dans `renderer/stores/sprint-proposal-store.ts`.

- **Entrées** : le bouton « Proposer le sprint » du bandeau du sprint, celui du côté sprint de la
  vue Planifier, et la création d'un sprint, qui ouvre la vue sur les réglages.
- **Réglages** : l'objectif (celui du sprint par défaut), la capacité de 50 % à 150 % de celle
  du sprint, l'intention (les quatre variantes), et ce qui part vers le fournisseur. Un objectif
  ou une capacité laissés tels quels ne sont pas envoyés : le main relit ceux du sprint.
- **Attente** : trois places en pointillés et les trois étapes. La vue peut se fermer : la
  réponse attend dans le store, pour ce sprint et ce projet. Une demande plus récente remplace
  une réponse plus ancienne.
- **Proposition** : les tâches en pointillés violets après celles du sprint, chacune avec sa
  raison (celle du modèle, sinon celle des règles), la ligne de capacité, puis les meilleures
  qui n'y tiennent pas avec le total qu'elles donneraient. La jauge dessine les points proposés.
  On retire une tâche (avec celles proposées seulement pour elle), on en ajoute une d'en dessous,
  on relance une autre variante, on prend l'objectif proposé (« Utiliser »).
- **Ajouter N tâches** passe par le déplacement de la vue : un seul déplacement, que
  « Annuler » (ou Ctrl+Z) défait. Rien ne bouge avant.
- Un lecteur d'un projet du serveur ne voit ni le bouton ni la proposition.
