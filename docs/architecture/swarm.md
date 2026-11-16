---
feature: Swarm Mode (sous-tâches en parallèle)
summary: >-
  Quand le réglage est actif, le build d'une tâche construit en parallèle les sous-tâches que son
  plan permet de mener côte à côte, chacune dans son worktree et sur sa branche, puis les fusionne
  vague après vague ; un conflit revient au codeur de la tâche.
---

# Swarm Mode : les sous-tâches d'une tâche construites en parallèle (`agents/swarm/`)

Le swarm existait sans jamais tourner : rien dans l'app ne le lançait, son interrupteur n'était
pas enregistré, `run.py` n'avait pas l'option `--subtask` que ses workers recevaient, aucun coder
ne lisait `SWARM_SUBTASK_ID` et les workers écrivaient tous dans le même dossier. La fusion par
vague appelait le moteur de merge sur des worktrees qui n'existaient pas.

## Le chemin

| Étape | Où |
|---|---|
| Le réglage (activé, sous-tâches en même temps 2 à 8, arrêt rapide, relances 0 à 5) | `SwarmModeSettings.tsx`, enregistré dans `settings.json` par `SETTINGS_SAVE`, validé par `shared/utils/swarm-settings.ts` (`parseSwarmSettings`) |
| Vers le build | `AgentManager.startTaskExecution` ajoute `swarmEnv(...)` : `WORKPILOT_SWARM_MAX_PARALLEL`, `WORKPILOT_SWARM_MAX_RETRIES`, `WORKPILOT_SWARM_FAIL_FAST` |
| Dans la boucle du coder | `agents/coder.py` appelle `run_swarm_phase` (`agents/swarm/build_phase.py`) une fois le plan écrit, avant la première sous-tâche |
| Les vagues | `DependencyAnalyzer` (fichiers et phases du plan), puis `SwarmOrchestrator` |
| Un worktree par sous-tâche | `agents/swarm/subtask_worktree.py` (`create`, `finished`, `merge`, `remove`) |
| Le worker | `run.py --spec … --project-dir <worktree> --subtask <id>` (`cli/subtask_command.py`) : la boucle habituelle du coder, tenue sur cette sous-tâche par `core.progress.swarm_focus()` |
| Les événements | `WaveExecutor` relaie les marqueurs de phase et de tâche d'un worker en `subtask_log`, sans le marqueur : l'app ne les prend pas pour ceux du build |

## Pourquoi un worktree par sous-tâche

Deux coders dans le même dossier voient les fichiers à moitié écrits de l'autre et indexent ses
changements. Chaque sous-tâche d'une vague part donc de la branche de la tâche telle qu'elle est
avant la vague, dans `.workpilot/worktrees/swarm/<spec>/<sous-tâche>`, sur la branche
`workpilot/swarm/<spec>/<sous-tâche>`. Le worktree est préparé comme celui de la tâche (fichiers
d'environnement, `node_modules` ou recette de préparation, fichiers de sécurité du worktree de la
tâche) et reçoit une copie de la spec : le coder y lit son plan.

## La fusion après chaque vague

Une fois la vague finie (relances comprises), chaque sous-tâche que son coder a marquée
`completed` est validée (`git add` hors fichiers de WorkPilot) puis fusionnée dans la branche de
la tâche en `--no-ff`, dans l'ordre du plan ; son entrée du plan de la tâche prend ce que son
coder a noté. Une fusion en conflit est annulée (`merge --abort`) : la branche reste telle
qu'elle était et la sous-tâche reste `pending`. Le build continue ensuite comme sans swarm : le
codeur de la tâche reprend ce qui reste, une sous-tâche après l'autre, sur tout ce que les vagues
ont fusionné, et la QA juge l'ensemble. Il n'y a donc pas de fusion par IA à cet endroit : le
conflit revient à un coder qui voit les deux côtés dans le code, et l'option « fusion assistée par
IA » du panneau a été retirée avec « simulation », que rien ne lisait.

## Quand le swarm s'écarte

`run_swarm_phase` ne fait rien, et dit pourquoi dans le journal du build, quand : le réglage est
coupé (ou sous 2), le processus est lui-même un worker, aucune vague n'a deux sous-tâches, la tâche
n'est pas à la racine d'un checkout git (mode `--direct` dans un dossier qui n'en est pas un), ou
son worktree porte du travail non commité (les sous-tâches partent de la branche et ne le
verraient pas). Il ne tourne qu'une fois par tâche et par processus.

## Frontières

- Le renderer n'envoie que le réglage ; le main le revalide (types, bornes) avant de l'écrire, et
  relit le fichier à chaque lancement : une valeur illisible coupe le swarm, elle n'atteint pas le
  build. Aucune commande ni aucun chemin ne vient du renderer.
- Les workers sont lancés par une liste d'arguments, sans shell ; leur dossier de projet
  (`PROJECT_DIR_ENV_VAR`) est leur propre worktree, donc leurs écritures y restent confinées.
- `.workpilot/` n'entre jamais dans un commit de sous-tâche.

## Tests

`tests/agents/swarm/test_swarm_worktrees.py` construit un vrai dépôt git et lance de vrais
processus d'un worker factice : une vague isolée puis fusionnée, un conflit laissé au coder, un
échec non fusionné, l'arrêt rapide, un worktree resté d'un run interrompu, les raisons de
s'écarter. Côté app : `swarm-settings.test.ts`, `SwarmModeSettings.test.tsx`, le refus d'un
réglage hors bornes (`source-env-handlers.test.ts`) et l'environnement du build
(`subprocess-spawn.test.ts`).
