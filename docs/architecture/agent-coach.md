# Coach personnel : le profil de style

> Pourquoi le coach apprend le style de la personne dans chaque projet et le donne aux agents, et
> comment. Issue : #376. Règles : [`docs/CLAUDE.md`](../CLAUDE.md),
> [`security.md`](../rules/security.md) (S2, S4, S6).

## Le constat

Le coach lisait les exécutions des agents (coût, échecs, modèles) et donnait des conseils. Il ne
savait rien de la façon dont la personne écrit. Un agent qui nomme en `snake_case` dans un projet
TypeScript écrit en `camelCase` oblige à corriger chaque diff. La boucle d'apprentissage
(`learning_loop/`) apprend ce qui marche pour l'**équipe**. Ce profil apprend ce que préfère la
**personne**.

## Ce qui est mesuré (`agent_coach/style_dimensions.py`)

Douze dimensions, chacune avec une liste fermée de valeurs, mesurées **par langage** :

| Dimension | Valeurs |
|---|---|
| noms de fonctions, noms de variables | camelCase, snake_case, PascalCase |
| longueur des noms | courts, descriptifs |
| commentaires | aucun, minimaux, généreux |
| commentaires de doc | sur chaque fonction, seulement si utile |
| langue des commentaires | anglais, français |
| longueur des fonctions | ≤ 20 lignes, ≤ 50 lignes, longues |
| imports | nommés, par défaut (JS/TS) ; `from … import`, `import module` (Python) |
| erreurs | exceptions, types résultat (pas en Go, où l'idiome est imposé) |
| conditions | retours anticipés, imbriquées |
| tests | une ou deux assertions, plusieurs ; mocks du framework, faux écrits à la main |

Les langages sont reconnus au suffixe du fichier : Python, JavaScript, TypeScript, C#, Java,
Kotlin, Go, Rust, Ruby, PHP, Swift, Dart, Scala, C, C++, F#. Le profil reste par langage : une
personne qui écrit en `snake_case` en Python et en `camelCase` en TypeScript a deux réponses,
pas une contradiction.

## D'où viennent les votes (`style_observer.py`)

`git log` (argv, sans shell) sur un an, 300 commits au plus, classés ainsi :

- **les commits de la personne** (auteur = `user.email` du projet) : la référence, poids 1 ;
- **les commits d'agents gardés** : le côté d'un merge `workpilot/…`, ou un commit avec un
  trailer d'outil d'IA (`Co-Authored-By: Claude…`, Copilot, Codex, Gemini…), ou un commit dont la
  moitié des lignes vient d'un merge enregistré ; poids 0,5 ;
- **les corrections** : les lignes d'un build fusionné qu'un commit de la personne a retirées ;
  poids −0,5, un vote contre ce style ;
- **les autres auteurs** : poids 0,3, l'amorce de quelqu'un qui n'a pas encore d'historique.

Chaque vote perd la moitié de son poids en 90 jours, et un commit compte au plus cinq fois par
valeur. La configuration du lint pèse 4 : ESLint (`camelcase`, `naming-convention`), Ruff,
Flake8 ou Pylint avec pep8-naming, les styles de nommage .NET de `.editorconfig`, et
`analysis_options.yaml` de Dart.

Une dimension est **préférée** quand elle a un poids d'au moins 3 et qu'une valeur en tient
70 %. Sinon elle est **indifférente**, et une dimension indifférente n'est jamais donnée aux
agents.

À chaque merge, l'abonné de `core.merge_event` enregistre dans `.workpilot/coach/merged.jsonl`
l'empreinte (16 caractères de SHA-256) de chaque ligne apportée, et si le profil était actif. Les
lignes elles-mêmes ne sont jamais gardées. C'est ainsi qu'un merge préparé sans commit, puis
validé sous le nom de la personne, n'est pas pris pour son propre code.

## Ce que reçoivent les agents (`profile_injector.py`)

Le prompt du codeur (`prompts_pkg/prompt_generator.py`) et celui du correcteur QA (`qa/fixer.py`)
reçoivent une section « The developer's personal style », pour tous les providers puisque ces
prompts sont construits en Python. Elle est écrite à partir de phrases fixes, choisies par des
valeurs de listes fermées. Un profil modifié à la main ou importé ne peut donc pas y mettre de
texte (S2). La section dit que la tâche, la spec et le `AGENTS.md` du projet passent avant, et
qu'un écart se justifie dans le résumé. Une tâche qui demande un autre style l'obtient.

Le profil est lu dans le projet même quand l'agent travaille dans son worktree
(`<projet>/.workpilot/worktrees/…`).

## Ce que la personne décide

La page Coach montre le profil par langage : la valeur, sa part, et d'où elle vient (historique,
projet ou lint). Pour chaque dimension, la personne peut choisir « Mesuré », une valeur, ou « Ne
pas donner », et peut aussi couper le profil pour tout le projet. Les choix sont enregistrés dans
`.workpilot/coach/preferences.json` et gagnent sur la mesure.

**Export et import.** Un export ne contient que les préférences effectives : ni e-mail, ni chemin,
ni code. Un import les reprend comme des choix de la personne, après validation par listes
fermées dans le main puis dans le runner. Le main lit le fichier choisi dans une boîte native,
256 Ko au plus.

**Vérifier une tâche.** Pour une tâche en attente de revue, la page compare ce que la tâche a
ajouté (diff du worktree depuis sa base) avec le profil. Elle liste les écarts, par exemple
« camelCase (3×), votre profil dit snake_case ». Le nom de la tâche est vérifié dans le main et
dans le runner, et le worktree doit être sous `.workpilot/worktrees/tasks/`.

**Mesure.** Le profil indique la part des builds fusionnés gardés tels quels, c'est-à-dire non
corrigés dans les 30 jours, avec et sans le profil actif.

## Pas fait

- Une tâche abandonnée ne compte pas encore comme un rejet.
- Le mode serveur n'a pas de profil par membre : la page est locale.
- Le style d'architecture (POO ou fonctionnel, patterns) n'est pas mesuré, faute d'une mesure
  fiable sur toutes les stacks.
- Aucune suggestion n'est faite pendant que l'agent écrit : l'écart se voit à la revue.
