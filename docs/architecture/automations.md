# Automatisations : un événement crée une carte

Le démon « Continuous AI » (`apps/backend/continuous_ai/`) tournait à côté du
Kanban. Il surveillait la CI, les dépendances et les issues, et agissait seul,
hors de toute carte. Ce qu'il disait avoir fait n'était pas toujours fait :
`cicd_watcher._run_self_healing` répondait « Diagnosed CI failure » sans rien
lancer, et l'audit du 17 octobre avait déjà corrigé un triage d'issues marqué
réussi alors qu'il échouait (F64). La sentinelle de dépendances lançait
`npm install` et `pip install` dans le checkout principal, hors worktree.

Les automatisations le remplacent. Une règle, c'est un déclencheur, un type de
carte (donc un workflow) et un moteur (provider, modèle, effort). Quand
l'événement arrive, elle crée **une carte du Kanban**, et rien d'autre. La carte
suit le cycle normal : spec, plan, code, QA, revue humaine. Une règle ne merge
pas, ne pousse pas et ne commente pas. Seule exception, une PR ouverte par
quelqu'un d'autre : la règle lance la revue IA de GitHub PRs, gardée en
brouillon, au lieu de créer une carte (voir plus bas).

```
apps/frontend/src/main/automations/
  rules.ts       une règle telle que le main l'accepte : listes fermées, bornes
  sources.ts     les événements : issues et PR GitHub, pipeline de la branche de base, horloge
  pr-review.ts   l'accès à la revue de PR de GitHub PRs, chargé au premier usage
  cards.ts       la carte : mêmes fichiers qu'une carte saisie, sous le même verrou
  run.ts         un passage : dédoublonnage, plafond du jour, série rouge, journal
  store.ts       rules.json et ledger.json dans <projet>/.workpilot/automations/
  scheduler.ts   un passage toutes les 5 min par projet, tant que l'app est ouverte
apps/frontend/src/main/ipc-handlers/automations-handlers.ts
apps/frontend/src/renderer/components/settings/integrations/AutomationsIntegration.tsx
```

Les règles se règlent par projet : Réglages › projet › Automatisations. Il n'y a
pas de vue en plus dans la barre latérale.

## Les déclencheurs

| Déclencheur | Source | Clé de dédoublonnage | Ce qui n'est pas un événement |
|---|---|---|---|
| `issue_labeled` | API GitHub, avec le jeton du projet (Réglages › GitHub) | `github-issue:<dépôt>#<n>` | une issue qui portait l'étiquette avant la règle ; une PR ; une issue qui a déjà une carte |
| `ci_failed` | le fournisseur de CI du « Build rouge » (Azure DevOps, GitHub Actions, GitLab CI, Jenkins) | `ci:<fournisseur>:<branche>:<run>` | un run en cours ; un run vert, qui clôt la série rouge |
| `schedule` | l'horloge locale, `HH:MM` et des jours de la semaine | `schedule:<règle>:<jour>` | l'heure pas encore passée ; un jour où l'app était fermée ; une règle créée après l'heure du jour |
| `pr_opened` | API GitHub, avec le jeton du projet ; base optionnelle | `github-pr:<dépôt>#<n>` | une PR ouverte avant la règle ; une PR en brouillon (elle revient une fois prête) ; une PR de la personne elle-même ou d'un bot ; une PR qui a déjà une revue |

- **L'étiquette posée après la règle.** La liste des issues est filtrée par
  `since`, mais `since` porte sur la dernière mise à jour. Une vieille issue
  commentée hier passerait. Le passage lit donc les événements de l'issue et ne
  retient que l'événement `labeled` daté d'après `createdAt`. Activer une règle
  ne demande pas d'importer le backlog. Une issue écartée pour cette raison est
  gardée dans le registre, pour ne pas être relue.
- **Une issue, une carte.** La carte porte les champs de l'import GitHub
  (`sourceType: "github"`, `githubIssueNumber`, `githubUrl`). L'import manuel et
  les vues d'issues la reconnaissent donc. À l'inverse, une issue déjà importée
  à la main ne reçoit pas de deuxième carte : le passage lit les
  `task_metadata.json` du tableau.
- **Une carte par série rouge.** Tant que la carte ouverte pour une série rouge
  n'est ni terminée ni archivée, un nouvel échec sur la branche ne crée rien. Il
  est noté « écarté ». Un run vert clôt la série. Si la carte est terminée et
  que la CI est encore rouge, le correctif n'a pas tenu : une nouvelle carte
  s'ouvre.
- **Le dernier run.** Le déclencheur CI lit le dernier run de la branche, comme
  le « Build rouge » lit celui de la branche d'une tâche. Un run en cours n'est
  pas encore un événement : on n'ouvre pas une carte sur une CI qui va peut-être
  repasser au vert.

Sentry n'est pas un déclencheur. WorkPilot n'a pas de connecteur Sentry côté
projet (`main/sentry.ts` remonte les erreurs de l'app elle-même). Une
alerte qui arrive dans une issue GitHub étiquetée passe par `issue_labeled`.

## Une PR ouverte par quelqu'un d'autre : une revue en brouillon

Plan du 29 octobre, IA7. Le déclencheur `pr_opened` réutilise deux briques
existantes, sans nouveau démon : la boucle des automatisations (G6) et la revue
IA de GitHub PRs (G1). Il ne crée pas de carte.

- **La même revue que le bouton, sans ses effets de bord.** `startDraftPRReview`
  (`pr-handlers.ts`) lance le runner `review-pr` avec le moteur de la page
  GitHub PRs. Contrairement au bouton, il n'assigne personne et n'attend pas la
  CI. Comme lui, le résultat est enregistré dans le projet et n'est jamais
  publié : le runner tourne sans `--auto-post`. Publier, corriger ou écarter la
  revue reste un clic de la personne dans GitHub PRs, où la revue apparaît par
  les événements habituels.
- **Qui est « quelqu'un d'autre ».** La source demande à GitHub à qui
  appartient le jeton (`/user`). Une PR de ce compte est ignorée (`own_pr`),
  comme une PR de bot (`bot_author`). Si GitHub ne répond pas qui il est, la
  source échoue plutôt que de relire le travail de la personne.
- **Une revue par PR.** Une PR qui a déjà une revue, enregistrée ou en cours
  (lancée à la main ou par une autre règle), est écartée (`already_reviewed`).
  Une revue déjà en cours refuse d'en lancer une deuxième.
- **Rien du texte de la PR ne passe par la règle.** L'événement ne porte que le
  numéro, validé comme entier positif, et l'URL. Le titre, la description et le
  diff arrivent au relecteur par son propre chargement, comme contenu non fiable
  (S2), exactement comme pour le bouton.
- **Mêmes garde-fous que les cartes.** Le plafond du jour compte les revues
  lancées (3 par défaut). Une revue qui n'a pas pu démarrer (fenêtre fermée,
  module GitHub absent) n'est pas notée comme vue : le passage suivant retente,
  et l'échec n'est écrit qu'une fois (`review_failed`). Une revue qui échoue en
  cours de route est signalée dans GitHub PRs et n'est pas relancée par la règle.
- **Pas de type, pas de moteur, toujours un brouillon.** Le main retire `kind`
  et `engine` d'une règle `pr_opened` et force `draft: true`, quoi que le
  renderer envoie. Le formulaire ne les montre pas.

## Les garde-fous

- **Brouillon par défaut.** La carte attend dans le backlog qu'on la lance,
  comme une carte saisie, avec un `implementation_plan.json` en `pending`. Sans
  brouillon, le passage appelle `startSpecCreation`, comme l'import d'issues. La
  règle doit le demander explicitement : `draft: false`. Toute autre valeur
  reste un brouillon. Si le lancement échoue, la carte existe quand même, et le
  journal dit `not_started` avec la cause.
- **Plafond du jour.** 3 cartes par règle et par jour par défaut, 20 au plus. Un
  événement au-delà n'est pas noté comme vu : il revient le lendemain, sous le
  plafond du lendemain. Aucun n'est perdu, et le nombre en attente s'affiche.
- **Une source illisible le dit.** Pas de GitHub connecté, pas de fournisseur de
  CI, une réponse qui n'est pas une liste, une erreur réseau : la règle passe en
  erreur avec la raison, au lieu de répondre « rien de nouveau ». La même
  erreur à chaque passage n'est écrite qu'une fois au journal. Elle disparaît au
  premier passage qui lit la source.
- **Une carte qui n'a pas pu s'écrire** n'est pas notée comme vue : le passage
  suivant la retente.
- **Le type choisi est gardé.** Un type de carte fixé par la règle est écrit
  avec `kindSource: "user"`, que le classifieur n'écrase pas
  ([kanban-task-types.md](kanban-task-types.md)). Sans type, le classifieur
  décide, depuis les étiquettes pour une issue. Le formulaire propose `bug_fix`
  pour une règle CI.
- **Le moteur choisi est verrouillé.** Un moteur fixé par la règle est écrit
  par `buildEngineMetadata(uniformEngine(trio))`, la même forme que le
  sélecteur d'une carte. Sinon la carte prend le moteur par défaut de l'app.

## Les frontières

- **Le renderer n'envoie qu'un id de projet et une règle en données.** Le main
  résout le projet (`projectStore`) et revalide chaque champ
  (`automations/rules.ts`) :
  - les déclencheurs et les types sont des listes fermées ;
  - le nom et l'étiquette tiennent sur une ligne, sans caractère de contrôle,
    et l'étiquette sans virgule (l'API lit une virgule comme deux étiquettes) ;
  - la branche (CI) et la base (PR) suivent la grammaire d'un nom de ref, sans `..` ;
  - le provider suit le même motif que le best-of-N ;
  - l'effort est pris dans la liste des niveaux.
  - Un id de règle que le main n'a pas émis est refusé. Une règle garde son type
    de déclencheur et sa date de création : changer l'un ou l'autre rendrait
    nouveaux des événements anciens.
- **Le contenu d'une issue est une donnée.** Il passe par `sanitizeText`, comme
  à l'import manuel (caractères de contrôle retirés, longueur bornée), et entre
  dans la description de la carte. Les étapes de CI en échec sont citées comme
  une liste. Aucune valeur lue dans un événement ne choisit un outil, une
  commande, un chemin ou un droit. Le dossier de la carte vient du numéro
  attribué sous verrou et d'un slug du titre.
- **Le jeton GitHub reste dans le main.** Il est lu par `getGitHubConfig`, comme
  pour l'import, et n'apparaît ni dans le registre, ni dans le journal, ni dans
  un message d'erreur rendu à l'UI.

## Ce qui a été retiré

- `apps/backend/continuous_ai/` et `runners/continuous_ai_runner.py`.
- Côté app : `continuous-ai-handlers.ts`, son store, son écran de réglages, ses
  huit canaux IPC et son espace i18n `continuousAI`.
  `ipc-bridge-guards.test.ts` ne garde plus que le pont du swarm.
- La sentinelle de dépendances écrivait
  `.workpilot/continuous-ai/deps/latest_scan.json`, que `longevity/` lit.
  Personne ne le rafraîchit plus, donc `longevity` ne compte un scan que s'il
  date de moins de 30 jours (`sentinel_snapshot_is_current`). Un scan ancien ou
  sans date ne vaut pas « tout est propre » : il ne compte pas. Un audit de
  dépendances régulier se règle avec un déclencheur `schedule` : la carte fait
  l'audit dans son worktree.

## Preuves

- `src/main/automations/__tests__/` :
  - `rules.test.ts` : listes fermées, bornes, brouillon par défaut, identité et
    âge gardés ; une règle PR toujours en brouillon, sans type ni moteur ;
  - `sources.test.ts` : l'étiquette d'avant la règle, PR écartées, run en cours,
    vert, source illisible ; PR de la personne, de bot, en brouillon, d'avant la
    règle, identité inconnue → échec ;
  - `run.test.ts` : une carte par événement, plafond reporté au lendemain, issue
    déjà sur le tableau, série rouge, erreur écrite une fois ; une revue par PR,
    sous le plafond, sans carte, retentée si elle n'a pas démarré ;
  - `scheduler.test.ts` : un passage rejoint, connecteur manquant nommé.
- `ipc-handlers/github/__tests__/pr-draft-review.test.ts` : `review-pr` sans
  `--auto-post`, personne d'assigné, deux revues de la même PR refusées, échec
  avant lancement qui libère la PR, échec en cours rendu à la vue.
- `ipc-handlers/__tests__/automations-handlers.test.ts` : projet inconnu ou non
  initialisé, règle refusée, id étranger, historique oublié à la suppression.
- `AutomationsIntegration.test.tsx` : statut, plafond, raison d'erreur, envoi en
  brouillon, refus du main affiché ; règle PR envoyée sans réglages de carte,
  revues du jour et raisons affichées.
- `tests/longevity/test_ingest.py` : scan ancien ou sans date → pas de signal.
