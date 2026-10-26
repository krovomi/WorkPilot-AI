# Suivi de la PR jusqu'au merge (`pr_followup`)

Une tâche qui avait ouvert sa pull request s'arrêtait à « PR créée » : un check
rouge ou un commentaire de revue attendait une personne, qui relançait une
tâche à la main ou corrigeait elle-même. Le suivi de la PR garde la carte au
travail jusqu'au merge : il lit la PR, et tant qu'un check échoue ou qu'un fil
de revue attend, il donne l'échec au QA fixer dans le worktree de la tâche,
vérifie le commit, puis le pousse.

```
apps/backend/pr_followup/
  model.py     ce que dit la forge : checks, fils de revue, état de la PR
  policy.py    decide() : la prochaine étape, sans effet de bord
  guards.py    ce qu'un correctif n'a pas le droit de faire pour obtenir du vert
  forge.py     GitHub par `gh`, en liste d'arguments
  state.py     <spec>/pr_followup.json : tours dépensés, dernier push, fils traités
  loop.py      run_round() : un regard sur la PR, et le tour de correction
apps/backend/runners/pr_followup_runner.py      boucle, une ligne JSON par regard
apps/frontend/src/main/ipc-handlers/task/pr-followup-handlers.ts
apps/frontend/src/renderer/components/task-detail/PrFollowupCard.tsx
```

## Ce que décide la politique, et dans quel ordre

`policy.decide` est pure : elle lit un `PRSnapshot` et l'état, et rend une
décision. L'ordre des règles est la conception, parce que chaque règle avant
la suivante écarte un faux positif.

| # | Règle | Décision | Pourquoi avant la suivante |
|---|---|---|---|
| 1 | la forge n'a pas pu être lue | `unknown` | une liste de checks vide à côté d'une erreur veut dire « inconnu », jamais « rien n'a échoué » |
| 2 | PR mergée ou fermée | `merged`, `closed` | fin du suivi |
| 3 | aucun check sur la tête, après `no_checks_grace` regards | `no_checks` | rien ne prouve que le code marche : ce n'est pas du vert |
| 4 | un check tourne encore | `pending` | on ne juge pas une CI à moitié lue |
| 5 | tout est passé et aucun fil n'attend | `green` | le merge reste à une personne |
| 6 | tous les échecs sont rouges aussi sur la branche de base | `base_red` | ce n'est pas à cette PR de les « corriger » |
| 7 | un tour sur cette même tête n'a produit aucun commit | `stuck` | rejouer la même tête dépense un tour pour rien |
| 8 | le plafond de tours est atteint (3 par défaut) | `exhausted` | une boucle sans fin coûte sans rien prouver |
| 9 | sinon | `fix` | seuls les échecs propres à la PR et les fils nouveaux partent au fixer |

Un état de check que `gh` ajouterait plus tard (un *bucket* inconnu) est lu
comme `pending`, pas comme un succès. Quand l'état de la branche de base ne
peut pas être lu, tous les échecs sont traités comme ceux de la PR : corriger
un échec de la base coûte un tour, appeler « celui de la base » un vrai échec
le cacherait.

Un fil de revue est « nouveau » tant que le fixer ne l'a pas vu avec son
dernier commentaire : une réponse du relecteur après le correctif le rend
nouveau à nouveau. Les fils résolus ou périmés (*outdated*) ne sont pas lus.

## Ce qu'un correctif n'a pas le droit de faire

Le moyen le moins cher de passer un check au vert est de ne plus lancer le
test, ou de changer la CI qui le lance. Les deux se lisent comme un succès sur
la forge. `guards.check_fix_diff` lit le diff du tour (lignes ajoutées
seulement : retirer un `skip` est bienvenu) et refuse :

- un test sauté, focalisé ou désactivé, par pile : `pytest.mark.skip`,
  `unittest.skip`, `it.skip` / `.only` / `xit`, `[Fact(Skip = …)]`, `[Ignore]`,
  `@Disabled`, `t.Skip`, `#[ignore]` ;
- un fichier de test supprimé, ou renommé hors de la suite (`is_test_file` de
  `workflows/hard_gates.py`, la même définition que la porte `tests-unchanged`) ;
- un fichier de pipeline modifié (`.github/workflows/`, `.gitlab-ci.yml`,
  `azure-pipelines.yml`, Jenkins, CircleCI, Bitbucket).

Un tour refusé est annulé par `git reset --hard` sur la tête de départ, avant
tout push, et le suivi s'arrête pour une personne. Rien n'a quitté la machine.

## Le tour de correction

1. Le worktree est amené à la tête de la PR **par avance rapide seulement**.
   Quelqu'un a pu pousser sur la branche (une suggestion appliquée sur la
   forge) : l'avance rapide la prend. Un worktree qui a des commits que la PR
   n'a pas n'est pas corrigé (`diverged`) : on pousserait ce que personne n'a
   relu.
2. `QA_FIX_REQUEST.md` est écrit avec la fin du journal des étapes en échec
   (`gh run view --log-failed`, 8 000 caractères) et les commentaires des fils.
   Tout passe par `quote_untrusted` (S2) : un journal de CI et un commentaire
   de revue sont du contenu externe.
3. Le QA fixer tourne dans le worktree, sur le provider, le modèle et l'effort
   de la phase QA **de la tâche** (`get_phase_provider`, `get_phase_model`) :
   le main lui donne l'environnement de la tâche (`pythonRunnerEnv` avec
   `taskProviders`), pas celui du fournisseur par défaut.
4. `implementation_plan.json` est restauré après le fixer : son prompt lui
   demande d'y signer `fixes_applied`, et le suivi tient son propre registre
   (`pr_followup.json`). La signature du build reste celle de la boucle QA.
5. Sans commit, la tête est notée (`no_progress_heads`). Avec un commit, les
   gardes sont lues ; puis `WorktreeManager.push_branch(force=False)`.

## Frontières

- Le renderer ne nomme que la tâche. L'URL de la PR, le dossier de spec et le
  worktree sont lus par le main dans l'enregistrement de la tâche, et le
  runner les résout de nouveau (`resolve(strict=True)`, contenus dans le
  projet).
- L'URL de la PR vient de `task_metadata.json`, un fichier qu'un agent peut
  écrire. Seuls son propriétaire, son nom et son numéro atteignent `gh`, après
  une expression stricte : une URL qui n'est pas exactement celle d'une PR
  GitHub est refusée.
- Chaque appel `gh` est une liste d'arguments qui nomme le dépôt (`-R`), sans
  shell.
- Jamais de push forcé, jamais de merge, aucun commentaire posté sur la PR.

## Limites connues

- **GitHub seulement.** Une URL GitLab ou Azure DevOps est refusée par le
  runner avec un message, pas suivie à moitié.
- Les fils de revue sont donnés au fixer, mais aucune réponse n'est postée dans
  le fil : poster au nom de la personne est une décision à part.
- Le suivi vit dans le processus de l'app : il s'arrête quand l'app quitte et
  se relance par la carte (l'état sur disque garde les tours dépensés).

## Vérifier

`pytest tests/pr_followup -q` et
`cd apps/frontend && pnpm test -- pr-followup-handlers PrFollowupCard python-runner-env`.
