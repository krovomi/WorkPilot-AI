# Banc de rejeu sur le dépôt (`bench`)

Formula Lab estimait le coût et la réussite de chaque provider × modèle × effort à partir de
l'historique d'usage du projet, sans expérience contrôlée : un modèle peu utilisé n'avait pas
d'historique, et un modèle très utilisé avait celui des tâches qu'on lui avait confiées. Le banc
de rejeu mesure. Il reprend 10 à 20 cartes terminées du projet, les reconstruit depuis le commit
d'avant avec chaque moteur choisi, et les juge avec les tests que la carte a livrés. Ces tests
viennent du commit d'arrivée, et l'agent qui rejoue ne les voit jamais. Le tableau qui en sort
nourrit Formula Lab et le routeur de modèles.

```
apps/backend/bench/
  layout.py     où vit un passage : manifeste et tableau dans le projet, copies hors du projet
  repo.py       commit d'arrivée, tests cachés, copies isolées, recouvrement des tests
  judge.py      détection des suites, environnement construit, lancement borné
  reports.py    JUnit, JSON Jest/Vitest, TRX, go test -json → {test: pass|fail|skip}
  lifecycle.py  discover, prepare (calibrage + copies), judge_build, discard
  results.py    records cumulés, tableau, échantillons pour Formula Lab, verdict du routeur
apps/backend/runners/bench_runner.py              une commande par appel, une ligne JSON
apps/frontend/src/main/ipc-handlers/bench-handlers.ts
apps/frontend/src/renderer/components/bench/RepoBenchView.tsx   vue « Banc de rejeu »
apps/frontend/src/renderer/stores/bench-store.ts   état par projet, écouté pour la fenêtre
```

## Une carte devient un cas

Une carte terminée (`done` ou `pr_created`) est entrée dans la branche de base par un commit, sa
**cible**. Le premier parent de la cible est la **base** : le code tel qu'il était avant la carte.
La cible se trouve dans cet ordre :

1. le merge de `workpilot/<spec>` dans une branche qui n'est pas une branche de tâche
   (`git log --merges`, motif ancré : `workpilot/001-mul-2` n'est pas `workpilot/001-mul`).
   Quand la branche a été mergée plusieurs fois, le premier merge est la carte ; les suivants
   portent ses correctifs, qui ne faisaient pas partie de la demande ;
2. le commit de merge de la PR de la carte (`prUrl`), demandé à `gh` (squash compris) ;
3. sinon, le commit que la personne colle dans la vue.

Les **tests cachés** sont les fichiers de test ajoutés, modifiés ou supprimés entre la base et la
cible (`tests/`, `test/`, `__tests__/`, `test_*.py`, `*_test.py`, `*.test.ts`, `*.spec.js`,
`*_test.go`, projets `*.Tests` .NET, et les fichiers qui changent ce que fait un test sans en être
un : `conftest.py`, `pytest.ini`, `vitest.config.*`, `jest.setup.*`…). Une carte qui n'a modifié
aucun test qu'un runner sait lancer est refusée : rien ne peut la juger.

## Le juge est calibré avant le premier build

Pour chaque cas, les tests tournent trois fois :

- deux fois sur une copie à la cible : un test compte seulement s'il passe les deux fois ;
- une fois sur une copie à la base, avec les tests de la cible posés dessus.

Un test qui passe à la cible et échoue à la base est **F2P** (il prouve le travail de la carte).
Un test qui passe partout est **P2P** (il prouve que rien d'autre n'est cassé). Un cas sans F2P
est écarté avec sa raison : un juge qui ne distingue pas le travail de son absence ne juge rien.

Ce calibrage est aussi la garde contre les faux positifs de l'environnement. Le juge tourne avec
les dépendances installées du projet (le `.venv`, le `node_modules`), qui peuvent contenir le code
actuel du projet (installation en mode éditable, paquets de workspace liés). Si un test lisait ce
code-là au lieu de celui de la copie, il passerait à la base, ne serait donc pas F2P, et ne
pourrait pas donner un faux « réussi ». Un build **réussit** quand tous ses F2P et tous ses P2P
passent ; un test absent du rapport ne passe pas.

## Isolation : l'agent ne voit pas la réponse

- **Une copie par build.** `git init`, puis un fetch superficiel (50 commits) de la base, par son
  identifiant, depuis le projet. La cible descend de la base : elle n'est l'ancêtre de rien de ce
  qui est copié, donc elle n'est pas dans la copie. La copie n'a pas de remote : aucun
  `git fetch` lancé dedans ne peut l'apporter. Un git qui refuse le fetch par identifiant passe
  par une référence créée pour l'occasion dans le projet, supprimée aussitôt.
- **Hors du projet.** Les copies vivent dans `<WORKPILOT_DATA_DIR ou ~/.workpilot>/bench/<clé du
  projet>/<passage>/`, pas dans le checkout qui contient la réponse. Le build tourne en
  `--direct` dans la copie : la racine d'écriture de l'agent est la copie.
- **La spec par liste fermée.** Seuls `spec.md`, `requirements.json`,
  `complexity_assessment.json`, `context.json` et `project_index.json` sont copiés, plus quelques
  clés de `task_metadata.json` (type, catégorie, priorité). Le plan, les rapports de QA, les logs
  et la `prUrl` ne le sont pas : ils décrivent la réponse.
- **Vérifié au jugement.** Une copie qui contient le commit cible n'est pas jugée
  (`saw-answer`) et ne compte pas.

**Limite.** Un agent qui chercherait le checkout du projet sur le disque pourrait le lire : les
copies ne sont pas un bac à sable. Le bac à sable OS du build (PR #523) fermera cette porte une
fois mergé.

## Ce qu'un build ne peut pas décider de son propre jugement

- Les fichiers de test que l'agent a ajoutés, modifiés ou supprimés, et que la carte n'a pas
  touchés, reviennent à leur version de la base (`reset_agent_tests`), avant que les tests de la
  cible soient posés. Ni ses propres tests ni un `conftest.py` écrit par lui ne jugent.
- Le runner de test vient du `node_modules` du projet ; un `node_modules` installé par l'agent
  dans la copie est mis de côté (`node_modules.agent`) le temps du jugement.
- Un chemin de test dont un dossier parent est devenu un lien, ou qui sortirait de la copie, est
  refusé avant toute écriture (`safe_destination`).
- `.workpilot/bench.json`, la commande de juge personnalisée, est lu dans le projet, jamais dans
  la copie.

## Le jugement tourne sans identifiants

Les tests de la copie exécutent du code écrit par l'agent, hors de toute session : leur
environnement est construit depuis une liste fermée (`PATH`, dossiers de l'OS, caches des
toolchains, locale), sans clé, sans jeton, sans variable posée par un dépôt, avec `CI=1`. Chaque
lancement est borné par `WORKPILOT_BENCH_JUDGE_TIMEOUT` (900 s par défaut) et tout l'arbre de
processus est arrêté avec lui. Le runner du banc lui-même n'appelle aucun modèle : le main le
lance sans identifiants (`envWithoutCredentials`).

## Les builds

Le main lance chaque build comme une tâche ordinaire (`startTaskExecution`, `--direct`, dans la
copie), deux à la fois par défaut (`WORKPILOT_BENCH_CONCURRENCY`, 4 au plus). Le moteur est écrit
dans le `task_metadata.json` de la spec copiée, avec les mêmes clés que `buildEngineMetadata`
(toutes les phases verrouillées). L'environnement du build est celui du projet réel
(`envProjectPath`) : la copie n'a ni `.env` ni réglages.

Un build ne compte que s'il a vraiment tourné :

| Sortie | Compté | Pourquoi |
|---|---|---|
| fin normale, quel que soit le code de sortie | oui, jugé | le travail est ce qu'il est |
| n'a pas démarré | non (`not-started`) | rien n'a été demandé au modèle |
| limite de débit, connexion perdue | non (`interrupted`) | le build est arrêté et ne sera pas relancé : ce n'est pas le modèle |
| relancé sur place par l'échange de profil | attendu | une sortie suivie d'une relance immédiate n'est pas une fin |
| passage abandonné | non (`discarded`) | |

Les événements de ces builds s'arrêtent au main (`isBenchBuild`) : ce ne sont pas des cartes.

## Le tableau et ses lecteurs

`<projet>/.workpilot/bench/results.json` garde un record par build jugé, d'un passage à l'autre
(2000 au plus), et le tableau calculé à côté : par provider × modèle × effort, builds jugés et
réussis, taux de F2P passés, coût moyen (lu dans le `cost_data.json` de la copie), durée moyenne.

- **Formula Lab** ajoute un échantillon de réussite par build jugé à l'historique par
  (provider, modèle) qui calibre la probabilité de succès. Ce ne sont pas des échantillons
  d'usage : les volumes et les coûts n'en sont pas changés. La vue dit combien de rejeux comptent.
- **Le routeur** écarte un modèle que le banc a vu réussir moins de la moitié de ses builds sur au
  moins trois cartes distinctes, et la raison du choix le dit ; avec moins de preuves, il cite le
  score sans rien écarter. Une build dans un worktree lit le tableau du projet.

## Coût et durée

Chaque build est une tâche complète (plan, code, QA) facturée par son provider ; la vue affiche
cartes × moteurs avant le lancement. Le calibrage lance trois fois les tests de chaque cas. Un
passage à la fois par projet. À la fin, les copies sont supprimées et les logs restent
(`<données>/bench/…/logs/`) ; abandonner un passage supprime tout, sauf le tableau.

## Commande de juge personnalisée

Un projet que la détection ne couvre pas déclare son juge dans `.workpilot/bench.json` :

```json
{"judge": {"argv": ["make", "test-report", "{files}"], "cwd": ".", "report": "junit",
           "output": "out/report.xml"}}
```

`{report}` est remplacé par le chemin du rapport, `{files}` par les fichiers de test de la carte ;
`report` vaut `junit`, `jest-json`, `trx` ou `go-json`. Les chemins restent dans le projet.
