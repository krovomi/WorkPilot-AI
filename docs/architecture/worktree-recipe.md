# Recette de worktree (`.workpilot/worktree.toml`)

Un worktree de tâche est un checkout neuf : ni `node_modules`, ni `.venv`, ni paquets NuGet
restaurés, ni `.env.local`. Jusqu'ici, WorkPilot ne liait que les deux `node_modules` de son propre
dépôt ; tout autre projet laissait l'agent découvrir l'environnement manquant à sa première
compilation, et deux tâches en parallèle se disputaient le même port. La recette prépare chaque
worktree avant la première session, pour toutes les stacks.

Code :

- `apps/backend/core/workspace/recipe.py` : lecture du fichier, détection d'après la stack ;
- `apps/backend/core/workspace/recipe_run.py` : exécution, approbation, nettoyage, section du prompt ;
- `apps/backend/core/workspace/ports.py` : un bloc de ports par tâche, sur la machine ;
- `apps/backend/core/workspace/recipe_api.py` : la route desktop `/api/worktree-recipe` ;
- l'écran : `components/project-settings/WorktreeRecipeSection.tsx`, dans les réglages généraux du
  projet.

## Deux sources

- **Détectée** (pas de fichier) : une commande par gestionnaire de paquets que les fichiers de la
  racine nomment. pnpm, yarn, bun, `npm ci` (ou `npm install` sans lockfile) ; `uv sync`,
  `poetry install`, ou un `.venv` puis `pip install -r requirements.txt` ; `dotnet restore` (et
  `dotnet tool restore` avec `.config/dotnet-tools.json`, solution ou projet jusqu'à deux niveaux) ;
  `go mod download`, `cargo fetch`, `composer install`, `bundle install`, `flutter pub get` ou
  `dart pub get`, le wrapper Gradle ou `mvn dependency:go-offline`. Un dépôt polyglotte (une API
  .NET et un front Angular) reçoit les deux. La recette détectée est celle de WorkPilot : elle
  tourne sans approbation.
- **Fichier** : `.workpilot/worktree.toml`, celui du projet.

```toml
[setup]
commands = [
  ["dotnet", "restore"],
  ["npm", "ci"],
]
windows = [["npm.cmd", "ci"]]       # remplace commands sous Windows, si présent
copy = [".env.local", "src/Api/appsettings.Development.json"]
link = []                           # dossiers liés, pas copiés
pass_env = ["NUGET_FEED_TOKEN"]     # seuls identifiants transmis
timeout_seconds = 900               # 10 à 3600, pour toute la recette

[ports]
count = 3                           # 0 à 20

[teardown]
commands = [["docker", "compose", "-p", "${WORKPILOT_TASK_SLUG}", "down", "-v"]]
```

## Les règles

- **Une commande est une liste d'arguments, jamais une chaîne** (règle 6) : pas de shell, donc pas
  de `&&`, de redirection ni de substitution. `bash -c`, `sh -c`, `cmd /c`, `pwsh -Command` et
  `-EncodedCommand` sont refusés : nommer un script du dépôt. Un programme relatif
  (`./gradlew`, `.venv/bin/python`) est celui du worktree. Un programme absent est sauté et signalé.
- **Chemins dans le projet** : `copy` et `link` refusent un chemin absolu, `..` ou un lecteur.
- **Seul un fichier ignoré par git est copié ou lié.** La branche de la tâche committe ce que
  l'agent laisse non commité (`commit_pending_changes`) : un `.env` que git n'ignore pas finirait
  dans la PR. Le refus est noté, et l'agent le lit.
- **Une erreur invalide toute la recette** : rien ne tourne, et l'agent lit pourquoi.
- **Approbation par empreinte** : un fichier ne tourne qu'une fois approuvé tel quel
  (`.workpilot/worktree-approved.json`, SHA-256 de la recette telle qu'elle s'exécutera). Changer
  un caractère retire l'approbation. Les agents ne peuvent écrire ni la recette ni l'approbation
  (`security/path_guard.py`) : sinon une tâche ferait tourner ses commandes dans le worktree de la
  suivante, hors de toute revue.
- **Environnement** : celui du backend sans ses identifiants (`security/child_env.py`), plus
  `pass_env`, plus `WORKPILOT_WORKTREE_PATH`, `WORKPILOT_ROOT_PATH`, `WORKPILOT_TASK_SLUG`,
  `WORKPILOT_PORT` et `WORKPILOT_PORT_COUNT`. Dans un argument, seul `${WORKPILOT_*}` est remplacé.

## Quand elle tourne

Après le checkout et les exclusions de build, avant la première session (`setup_workspace`). Une
seule fois : le relevé (`<worktree>/.workpilot/worktree-setup.json`) garde l'empreinte, et une
reprise ne relance que si la recette a changé. Le journal (`worktree-setup.log`) garde la fin de la
sortie de chaque commande ; les fichiers copiés y sont nommés, jamais montrés.

**Une étape en échec n'arrête pas la tâche.** L'agent est mieux placé pour réparer un environnement
à moitié prêt que rien ne l'est. Le prompt de chaque sous-tâche porte une section
« Worktree environment » : les ports de la tâche, les étapes en échec ou sautées avec la fin de leur
sortie, une recette en attente d'approbation ou invalide. Rien ne s'affiche quand tout va bien.

Le dépôt de WorkPilot lui-même garde son lien des deux `node_modules` (ses hooks de pre-commit
typecheckent dans le worktree) ; ailleurs, lier les dépendances peut casser le checkout principal,
ce n'est jamais le défaut.

## Ports

`<WORKPILOT_DATA_DIR>/ports.json` (par défaut `~/.workpilot/ports.json`) associe chaque tâche
(projet et spec) au premier port de son bloc. Blocs de 10 à partir de 20000, quel que soit `count`,
pour qu'une recette qui grandit ne déborde pas sur sa voisine ; un bloc dont un port est occupé par
autre chose est sauté. Un verrou fichier sérialise les builds de la machine ; un verrou de plus de
30 s est celui d'un processus mort. La même tâche retrouve son bloc à la reprise.

## Nettoyage

Avant de supprimer un worktree (`remove_worktree`, et le ménage des worktrees orphelins), le
`[teardown]` tourne dans le worktree encore présent (120 s par commande), puis le bloc de ports est
rendu. Une tâche qui n'a jamais tenu de ports ne touche pas au registre.

## Désactiver

`WORKPILOT_WORKTREE_SETUP=0` dans l'environnement du backend : aucune recette ne tourne (la suite
de tests le pose par défaut, `tests/conftest.py`).

## Non couvert

- Le mode serveur : la route est desktop (`LOCAL_ONLY_FEATURES`) ; un serveur partagé ne lance pas
  de commandes d'un projet sur sa propre machine sans un modèle de permission dédié.
- Les worktrees de terminal (`terminal/worktree-handlers.ts`) gardent leur liste propre ; les
  aligner sur la recette est un lot à part.
