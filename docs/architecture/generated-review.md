# Code généré en revue : une carte, un worktree, une PR

> Pourquoi une page qui écrit du code dans un projet passe par une carte du Kanban, et comment.
> Règle : [`docs/CLAUDE.md`](../CLAUDE.md). Constat d'origine : [F180](../audit/findings/F180.md).

## Le constat

Le Kanban n'a jamais écrit dans le dossier du projet : chaque tâche travaille dans son worktree,
sur sa branche `workpilot/<spec>`, et la personne relit le diff puis ouvre la pull request. Des
pages écrivaient, elles, directement dans le checkout, donc sur la branche courante (`develop`,
`main`) et sans relecture :

| Page | Ce qu'elle écrivait | Lot |
|---|---|---|
| Studio de tests | le fichier de tests ; les manifestes (`.csproj`, `package.json`, `pyproject.toml`…) quand elle ajoute des paquets | 1 |
| Import Design | les fichiers du composant (« Écrire dans le projet ») | 2 |
| Journal des modifications | `CHANGELOG.md` (« Enregistrer ») | 2 |
| Pair programming | tout ce que l'agent codeur modifie, en direct | 3 |
| Barre « Commande rapide » du Kanban | tout ce que l'agent de la commande écrit ([F181](../audit/findings/F181.md)) | 5 |

Passent déjà par une carte (donc un worktree et une PR) : Visuel vers Code, Migration de code,
Dette technique, Plateformes mobiles, migration .NET, autofix GitHub et GitLab. N'écrivent rien
dans le projet : la traduction inter-langages (dossier temporaire), les extraits contextuels
(copie), le playground, le compagnon, les analyses (accessibilité, i18n, dérive de doc,
notebooks, git surgeon), le générateur de pipelines (`.workpilot/pipelines/`). Le mode serveur
n'offre aucune de ces pages.

## Le mécanisme

Une page qui écrit ouvre un **espace de revue** (`apps/frontend/src/main/generated-review/`)
avant d'écrire :

1. **La carte.** Un dossier de spec comme celui de toute tâche (`createLocalTask`), avec
   `sourceType: "generated"` et `generatedBy: <page>` dans `task_metadata.json`, et la branche de
   base du projet (`settings.mainBranch`) ou, à défaut, celle que détecte le gestionnaire de
   worktrees.
2. **Le worktree.** `runners/review_worktree_runner.py` appelle `core.worktree.WorktreeManager`,
   la classe du pipeline Kanban : même dossier `.workpilot/worktrees/tasks/<spec>`, même branche,
   même base, mêmes exclusions au commit (`.workpilot/`, sorties de build). Aucun modèle n'est
   appelé : le runner reçoit l'environnement statique (ni provider, ni profil Claude, S1), et
   les variables git d'un hook englobant sont effacées.
3. **L'écriture.** La page écrit dans le worktree. Les chemins venus du renderer (fichier
   testé, dossier de tests choisi) sont ramenés à la même place dans le worktree
   (`toWorkspacePath`) ; un chemin hors du projet, ou dans son `.workpilot/`, n'a pas
   d'équivalent et la page refuse (S4, S6). Le dossier nommé par le renderer doit être un projet
   local de cet ordinateur.
4. **Le commit.** Un message Conventional Commits par exécution (`test: add generated unit tests
   for X`), puis la carte passe en revue humaine avec l'exécution comme sous-tâche terminée et
   les fichiers qu'elle a changés. La page montre la carte (« Voir la carte ») et peut ouvrir la PR
   (« Créer la PR », le même `TASK_WORKTREE_CREATE_PR` que le Kanban : GitHub, GitLab, Azure
   DevOps).

Les exécutions d'une même page rejoignent la carte qui attend encore sa revue : des tests puis
les paquets qu'ils demandent, deux designs d'un même écran font une carte, une branche, une PR.
Une fois la PR ouverte, la carte quitte la revue humaine et l'exécution suivante ouvre une
nouvelle carte. Une exécution qui échoue, qu'on annule ou qui n'écrit rien sur une carte qu'elle
vient d'ouvrir retire la carte, son worktree et sa branche : un échec ne laisse rien sur le
tableau.

Les questions en lecture seule lisent le worktree de la carte ouverte quand il y en a une : le
studio (bibliothèques déjà présentes, dossier de destination), Import Design (fichier qu'un
composant remplacerait), le journal (`CHANGELOG.md` existant). Ce qui attend sa revue y vit, pas
encore dans le dossier du projet.

Par page :

- **Studio de tests** (lot 1) : une exécution, un commit `test: add generated <unit|e2e|tdd> tests
  for X` ; l'ajout de paquets, `test: add test packages …`.
- **Import Design** (lot 2) : « Écrire sur une branche de revue » vérifie chaque chemin dans le
  projet, puis dans le worktree (ses liens ne sont pas ceux du projet) ; `feat: add X from an
  imported design`. Aucune carte quand tous les fichiers sont refusés.
- **Journal des modifications** (lot 2) : « Enregistrer » ajoute la version en tête de
  `CHANGELOG.md` dans le worktree ; `docs(changelog): add 1.4.0`. Le chemin nommé par le renderer
  reste dans le projet (il ne l'était pas : `path.join` sans contrôle). Les images collées
  attendent dans `.workpilot/changelog-assets/` et rejoignent le commit sous `.github/assets/`.
  Un projet du serveur garde son journal sur le serveur, sans fichier ni branche.
- **Pair programming** (lot 3) : l'agent codeur reçoit le worktree de la carte comme
  `--project-dir` ; ses outils n'écrivent donc que là. À la fin de la session (terminée,
  arrêtée ou en erreur), ce qu'il a écrit est commité : `feat: <objectif> (pair programming)`.
  Les commits que l'agent fait lui-même comptent (`commit --since <head du create>`). Exception à
  la règle d'échec : un commit refusé par git laisse le travail dans le worktree, dont la page
  donne le chemin, car la personne l'a regardé s'écrire.
- **Commande rapide du Kanban** (lot 5, F181) : la barre ne demande plus au serveur backend de
  lancer la commande. Le main ouvre la carte (`main/quick-command/quick-command-run.ts`), puis
  lance `runners/slash_command_runner.py` avec `--workdir` = le worktree et `--project-dir` = le
  dossier du projet, d'où viennent les instructions de la commande (la palette les y a lues ;
  `.agents/skills/` peut n'y être que non suivi). L'environnement est celui de tout runner de page
  (`pythonRunnerEnv`) : le provider choisi dans l'app et sa clé, la connexion du profil Claude quand
  ce provider en a besoin. Le serveur backend, lancé une fois avec l'environnement du main, n'avait
  ni l'un ni l'autre : un abonnement Claude (OAuth) n'était pas trouvé et tout autre provider était
  ignoré. Les notes de l'agent sur sa propre exécution (contexte envoyé, trace des écritures) vont
  dans un dossier temporaire, pas dans le worktree : sinon elles partiraient dans la PR. Commit
  `chore: run /<commande> from the quick-command bar`, que la commande ait fini ou
  échoué ; une commande qui n'écrit rien (question, analyse) ne laisse pas de carte et la barre
  affiche seulement sa réponse. Une commande à la fois par projet. `/help` est répondu par la barre
  à partir de la liste ; `/review` a des instructions que tout provider exécute
  (`slash_commands.api._BUILT_IN_BODIES`). La route `POST /api/slash-commands/run` n'existe plus.

## Ce que le mécanisme refuse

- **Écrire dans le dossier du projet**, même quand le worktree ne peut pas être créé (dossier qui
  n'est pas un dépôt git, branche de base introuvable) : la page dit pourquoi et n'écrit rien.
- **Une branche par fichier** : la carte ouverte d'une page absorbe ses exécutions jusqu'à la PR.
- **Un chemin du renderer pris tel quel** : il est ramené au worktree ou refusé.

## La purge (lot 4)

Un worktree est une copie complète du projet, sorties de build et dépendances comprises : une
fois le travail fini, il occupe le disque pour rien (`main/worktree-purge/`).

- **PR fusionnée** : toutes les 5 minutes, la PR de chaque carte locale en revue (statut
  `human_review` ou `pr_created`, URL de PR connue) est lue sur sa forge (`pr-state.ts` : GitHub,
  GitLab, Azure DevOps). Fusionnée, la carte passe « Terminé » avec `prMergedAt`, puis son worktree
  et sa branche locale `workpilot/<spec>` sont supprimés, sans demander. Les parties d'un
  découpage sont suivies par `split-merge-watch.ts` et purgées ici une fois terminées.
- **« Purger »** (barre du Kanban) : liste les worktrees des cartes à PR fusionnée, terminées,
  archivées ou abandonnées, avec la place occupée, et supprime ceux que la personne coche.
- **Jamais purgé** : un worktree avec des modifications non commitées (affiché, case grisée),
  une carte sur laquelle une autre est encore empilée, une carte en cours, un lien à la place du
  dossier, une carte du serveur. Une PR fermée sans fusion, ou une forge qui ne répond pas, ne
  déclenche rien ; un projet en mode hors ligne strict n'est jamais interrogé.
- La carte, sa spec et sa PR restent : seule la copie locale part.

Vérification : `pytest tests/test_review_worktree_runner.py -q` ;
`pytest tests/test_slash_command_runner.py -q` ;
`cd apps/frontend && pnpm test -- generated-review test-generation-service-errors design-to-code-write changelog-review pair-programming-review worktree-purge WorktreePurgeButton quick-command-run`.
