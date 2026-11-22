---
feature: Pré-analyse avant En cours
summary: >-
  Avant qu'une carte démarre pour la première fois, la machine est vérifiée (git, commit, compte Claude) et une carte
  courte est relue une fois par l'IA, qui peut poser jusqu'à trois questions. La revue aide, elle ne bloque jamais :
  sans réponse du modèle, la carte démarre.
---

# Pré-analyse avant « En cours »

Demandé par Leub le 22 novembre 2026 : « sécuriser que tout est conforme » avant qu'une tâche
parte dans En cours. Il a choisi le niveau : **des contrôles rapides à chaque démarrage, et l'IA
seulement pour une carte courte**.

## Ce qui existait

Au démarrage, `validateTaskPrerequisites` (`main/ipc-handlers/task/execution-utils.ts`) vérifiait
déjà le dépôt git, son premier commit et le compte Claude, mais **après** le déplacement : la carte
arrivait dans En cours puis tombait en erreur. Rien ne regardait le contenu de la carte ; l'agent
de spec signale ce qui est flou (`[NEEDS CLARIFICATION]`, des avertissements), et l'interview de
spec (`SpecInterviewDialog`) ne s'ouvre qu'à la demande.

## Où elle s'applique

`persistTaskStatus(…, "in_progress")` (`renderer/stores/task-store.ts`) est le passage de tous
les démarrages faits dans l'app : glisser, sélection glissée ou déplacée par la barre, « + » de
En cours, menus, file d'attente qui promeut une carte. Il appelle `readyToStart`
(`renderer/lib/start-readiness.ts`) avant d'écrire le statut ; une carte retenue n'est pas
déplacée et le résultat porte `held: true`, que les appelants ne traitent pas comme une erreur
(pas de toast « opération échouée » : la fenêtre dit pourquoi).

Elle ne tourne qu'au **premier démarrage** (`isFirstStart` : depuis Planification ou File
d'attente). Une carte renvoyée en travail depuis une revue reprend sans question. Une carte du
serveur démarre sur le serveur, qui fait ses propres contrôles : le main répond « prête ».

## Les deux moitiés

Le main répond sur `TASK_CHECK_READINESS` (`main/ipc-handlers/task/readiness-handlers.ts`), qui
revalide l'id reçu (chaîne de 1 à 200 caractères) :

1. **La machine**, toujours : dépôt git, au moins un commit, compte Claude quand la tâche l'utilise
   (`requiresClaudeAuth`). Un échec donne un `problem` (`no_git`, `no_commit`, `no_auth`) : le
   démarrage échouerait, la fenêtre l'explique et ne propose que de fermer.
2. **L'IA**, pour une carte courte seulement (`isShortCard`, `shared/utils/task-readiness.ts` :
   moins de 80 caractères de description en plus du titre, jamais planifiée). Une complétion
   (`main/readiness-review-service.ts`, par `runOneShotLLM`, donc le provider choisi par
   l'utilisateur) dit si un agent peut construire la carte sans deviner, ou pose au plus trois
   questions d'une ligne avec une réponse par défaut. Le texte de la carte entre dans le prompt
   cité comme donnée (`quoteUntrusted`, règle S2) : il peut venir d'un ticket importé.

Le verdict est gardé par tâche pour le même titre et la même description (200 au plus) : la file
qui retente une carte retenue ne repaie pas la revue, et une carte complétée est relue. Sans
verdict (pas de provider, délai de 45 s dépassé, réponse illisible), la carte démarre : la revue
aide, elle ne bloque jamais. « Pas prête » sans question compte comme prête.

## La fenêtre

`components/task-readiness/ReadinessDialog.tsx`, rendue par `kanban/BoardKeyboard.tsx`, montre la
première carte retenue (`stores/task-readiness-store.ts`). Les réponses sont préremplies avec la
suggestion du modèle ; « Enregistrer et démarrer » les ajoute à la description (section
« Précisions avant le démarrage ») puis démarre, « Démarrer quand même » démarre sans rien
ajouter, « Plus tard » laisse la carte où elle était. Une carte démarrée depuis la fenêtre est
`accepted` pour la session : la pré-analyse ne l'arrête plus. Elle respecte la limite d'En cours :
sans place libre, elle attend dans File d'attente.

Pendant la revue d'une carte courte, un toast dit « Pré-analyse de « … » ».

## Fichiers

| Fichier | Rôle |
|---|---|
| `shared/utils/task-readiness.ts` | `isShortCard`, `isFirstStart` |
| `main/ipc-handlers/task/readiness-handlers.ts` | contrôles de la machine, cache, canal |
| `main/readiness-review-service.ts` | prompt, lecture du verdict |
| `renderer/lib/start-readiness.ts` | appel avant le démarrage, toast, mise de côté |
| `renderer/stores/task-readiness-store.ts` | cartes retenues, cartes acceptées |
| `renderer/components/task-readiness/ReadinessDialog.tsx` | la fenêtre |

Tests : `readiness-handlers.test.ts`, `__tests__/readiness-review-service.test.ts`,
`shared/utils/__tests__/task-readiness.test.ts`, `lib/__tests__/start-readiness.test.ts`,
`task-readiness/ReadinessDialog.test.tsx`, `KanbanBoard.test.tsx` (« pre-analysis »),
`kanban/QuickAddComposer.test.tsx` (« pre-analysis »).
