# Changelog

La vue Changelog écrit les notes d'une version en trois étapes : choisir la source, générer,
enregistrer. La source est au choix les tâches terminées du tableau, les commits (récents, depuis
une date, depuis une version, entre deux tags) ou les commits d'une branche absents d'une autre.
Le texte vient d'un modèle, dans un des trois formats (Keep a Changelog, liste simple, release
GitHub) et pour un des trois publics (technique, utilisateurs, marketing).

## Projet de l'ordinateur

Tout se passe dans le main (`apps/frontend/src/main/changelog/`) : `git-integration.ts` lit les
branches, les tags et les commits par `execFileSync` (liste d'arguments), `formatter.ts` construit
le prompt, `generator.ts` le passe au CLI Claude (`haiku`), `parser.ts` retire le préambule de la
réponse. Enregistrer ajoute le texte en tête de `CHANGELOG.md` sur la branche d'une carte du
Kanban en revue, jamais dans le dossier du projet (`changelog-review.ts`,
[generated-review.md](generated-review.md)) ; l'étape 3 montre la carte et « Créer la PR », puis
propose une release GitHub et l'archivage des tâches incluses. Les images collées attendent dans
`.workpilot/changelog-assets/` et rejoignent le commit, sous `.github/assets/`, avec le texte qui
les cite.

## Projet du serveur

Un projet du serveur n'a pas de dossier sur l'ordinateur : seulement le miroir de son tableau,
sans historique git. Son changelog est généré **sur le serveur**, par le même mécanisme qu'une
analyse (`server-mode.md`, « Les analyses tournent sur le serveur ») : un job sur le clone, son
résultat enregistré comme rapport partagé du projet.

- **Le générateur** est `runners/changelog_runner.py`, lancé en job par
  `shared_features/analyses.py` (analyse `changelog`) avec `--project-path <clone>` et la requête
  entière dans un seul argument `--options=<json>`. La requête est un modèle fermé
  (`changelog_generator/options.py`) : la source, des ids de carte au motif du tableau, des
  références git qui ne commencent jamais par un tiret et ne contiennent jamais `..`, une date
  `AAAA-MM-JJ`, au plus 200 cartes, 1 000 commits et 2 000 caractères de consignes. Le runner la
  revérifie.
- **Les prompts** sont ceux du bureau, portés en Python (`changelog_generator/prompts.py`), avec
  une différence : les cartes et les commits sont écrits par des personnes, ils passent donc par
  `security/untrusted.py` (`quote_untrusted` : nettoyés, bornés à 100 Ko, délimités) et le prompt
  dit que ce sont des données, jamais des consignes (`docs/rules/security.md`, S2). L'appel au modèle passe par
  `core.oneshot.oneshot_completion`, routé comme `core.client` vers le fournisseur actif, en texte
  seul et sans outil.
- **Les cartes** sont les cartes terminées du tableau dans le clone (`changelog_generator/cards.py`),
  lues dans l'espace de build quand il en a une copie, comme le tableau ; une carte archivée ou pas
  terminée est écartée, même si la requête la nomme.
- **L'historique** est celui du clone (`changelog_generator/git_history.py`) : les mêmes commandes
  git que le bureau, par `run_git` (liste d'arguments, environnement git isolé, délai),
  `--end-of-options` devant une plage.
- **Le rapport** est enregistré à la fin d'un job réussi dans `.workpilot/analyses/changelog.json`
  du clone : le texte, la version, la source, le nombre d'éléments, qui l'a lancé et quand. Un job
  échoué n'en enregistre pas.

Côté app, les handlers de la vue (`ipc-handlers/changelog-handlers.ts`) gardent leurs canaux et
passent par `ipc-handlers/server-changelog.ts` dès que le projet est un projet du serveur
(`getServerProject`) ; chaque requête nomme le projet par son id, jamais par un chemin.

| La vue demande | Projet du serveur |
|---|---|
| Les tâches terminées | le tableau relu du serveur (`GET /api/board/snapshot`) dans le miroir, puis le filtre du bureau |
| Les branches, les tags, le `CHANGELOG.md` existant | `GET /api/features/changelog/sources` |
| Les commits d'une plage | `GET /api/features/changelog/commits` |
| Générer | `POST /api/features/analyses/changelog/jobs`, suivi comme une analyse ; à la fin, le rapport relu |
| Le dernier changelog partagé | `GET /api/features/analyses/changelog/report`, montré à l'étape 1 avec un bouton pour l'ouvrir |
| Enregistrer | `PUT /api/features/changelog/report` : la correction d'un membre remplace le texte du rapport |
| Proposer une version d'après les commits | leurs types (`feat`, `fix`, `!`, `BREAKING CHANGE`), sans modèle : rien du projet ne part vers un modèle de l'ordinateur |
| Coller une image | refusé : pas de dossier du projet ici |

Après l'enregistrement, l'étape 3 d'un projet du serveur ne propose ni release GitHub ni
archivage : les deux agiraient sur un projet de l'ordinateur. Le `CHANGELOG.md` du dépôt n'est pas
écrit par le serveur ; le texte partagé se copie pour être commité.

Les droits sont ceux des analyses : lire les sources, les commits et le rapport demande
`insight.read`, un rôle sur le projet, un lecteur compris ; générer demande `agent.execute` et le
rôle `member` ou plus, corriger le rapport `insight.write` et le même rôle. Une correction est
refusée (409) pendant qu'un changelog est généré.

Tests : `tests/backend/test_server_changelog.py` (modèle fermé, prompts, cartes terminées,
historique d'un vrai dépôt, runner, routes et permissions),
`apps/frontend/src/main/ipc-handlers/__tests__/server-changelog.test.ts` (requêtes par id, réponses
revérifiées, génération et erreurs, version sans modèle),
`apps/frontend/src/renderer/components/changelog/__tests__/server-changelog-view.test.tsx` (la vue
d'un projet du serveur).
