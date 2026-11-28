---
feature: Voie express des PR de dépendances
summary: >-
  Les PR Dependabot et Renovate d'un projet passent par le moteur de validation sans tâche ni
  modèle ; une PR verte jugée N0 fusionne seule, à la tête jugée, quand l'interrupteur est mis et
  que les niveaux sont appliqués ; tout le reste attend une personne.
---

# Voie express des PR de dépendances (lot K1)

Dependabot et Renovate ouvrent sur les projets de la personne des pull requests qu'aucune tâche
n'a écrites. La validation par niveaux ([approval-tiers.md](approval-tiers.md)) sait déjà qu'une
montée de version qui ne touche que des manifestes et des lockfiles est N0 ; la voie express lui
donne ces PR-là, sans carte Kanban et sans agent.

## Qui la lance

`apps/frontend/src/main/express-lane.ts`, dans le main Electron. Trois minutes après le
démarrage, puis toutes les trente minutes, il relit les réglages : rien ne se passe tant que
`expressLane` n'est pas `true` (arrêté par défaut, normalisé en booléen par `SETTINGS_SAVE`) et
que `approvalTiers` n'est pas `enforce`. Sinon il lance, un projet après l'autre,
`apps/backend/runners/express_lane_runner.py --project-dir <racine>` (liste d'arguments, sans
shell, environnement de `pythonRunnerEnv` avec `WORKPILOT_APPROVALS`). Un projet du serveur, un
projet en hors-ligne strict et un projet sans dossier ne lui sont jamais donnés ; un runner qui
dépasse dix minutes est arrêté. Le main ne fait que journaliser ce que le runner imprime : il
n'y a pas de canal IPC.

## Ce que le runner décide

`apps/backend/pr_followup/express.py` :

1. Le runner refuse un worktree (`main_project(projet) != projet`) : la politique se lit sur le
   checkout principal, jamais là où un agent écrit.
2. Mode `off` : rien n'est listé. `origin` doit être un dépôt github.com (https, `git@` ou
   `ssh://`, propriétaire et nom bornés), sinon le projet est passé.
3. `gh pr list -R owner/repo --state open --limit 50`. Seuls restent les auteurs
   `app/dependabot`, `dependabot[bot]`, `app/renovate`, `renovate[bot]`, hors brouillon et hors
   fork (`isCrossRepository`). Le titre est une donnée : il ne sert qu'à lire la montée de
   version (patch, mineure, majeure), jamais d'instruction.
4. Chaque candidate est lue par `GitHubForge.snapshot()`. Il faut au moins un check, tous
   passés, et aucun fil de revue ouvert ; une PR rouge ou en cours n'est pas jugée.
5. Git récupère la base et `refs/pull/<n>/head` (branche de base vérifiée avant la commande) ;
   la liste des fichiers vient de git, pas de l'API. `build_facts` puis `decide` avec la
   politique du projet (`ci=green`, `review=none`).
6. Fusion seulement si `Decision.merges` est vrai, donc en `enforce` et pour une action
   `merge`, et à la tête jugée (`--match-head-commit`) : un push du bot entre le jugement et la
   fusion la fait refuser.

Une ligne JSON par PR regardée, puis `{"result": {"seen": …, "merged": …}}` ou `{"error": …}`.

## Pourquoi sans revue croisée

Une montée de version N0 ne touche ni le code ni la CI ; le niveau N0 ne demande que la CI verte.
Le moindre fichier de code fait passer la PR en N1 (`bump_with_code`) ou plus, une montée
majeure en N2 (`major_bump`), un fichier de CI en N2 : ces PR-là restent à une personne, et la
voie express n'appelle ni modèle ni Claude Ship.

## Limites

- GitHub seulement, par `gh` (la connexion de `gh` sur la machine).
- Le mode `observe` ou un `workpilot.policy.yaml` en `observe` imprime la décision sans
  fusionner : l'interrupteur affiche alors qu'il attend `Appliquer`.
