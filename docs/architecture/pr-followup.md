---
feature: Suivi de la PR
summary: >-
  La carte fait avancer sa PR jusqu'au merge : check rouge ou fil de revue au QA fixer, commit
  vérifié (aucun test sauté, aucune CI modifiée), push jamais forcé.
---

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
  state.py     <spec>/pr_followup.json : tours dépensés, dernier push, fils traités, first_ci
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
| 5 | tout est passé et aucun fil n'attend | `green` | le niveau de validation décide ; sans lui, le merge reste à une personne |
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

Avant le premier tour de correction, le premier regard où chaque check de la tête est fini écrit
`first_ci` (`passed` ou `failed`, `policy.first_ci_verdict`) : ce que la CI disait de la PR telle
qu'elle a été ouverte. « Où vous en êtes » en tire le taux de CI verte du premier coup
([build-compare.md](build-compare.md)).

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
- Jamais de push forcé, aucun commentaire posté sur la PR. Un merge seulement quand le niveau
  de validation le permet en mode `enforce` (section suivante), à la tête jugée exactement.

## Le niveau de validation d'une PR verte

Sur `green`, `pr_followup/approval.py` demande son niveau (N0 à N3) au moteur
[`approvals`](approval-tiers.md) : fichiers changés de la base à la tête jugée par la forge, titre
et labels de la PR, type de la carte, verdict de la revue croisée **sur cet arbre-là** (un accord
donné avant un tour de correction ne compte plus), plus bas score de confiance des sessions de la
tâche (`agent_safety.json`). La décision est gardée dans `approval_decision.json` et résumée dans
`implementation_plan.json` (`approval`) pour le badge de la carte. La PR n'est fusionnée que si
`Decision.merges` est vrai (mode `enforce` des Paramètres, action `merge`) : `gh pr merge
--match-head-commit` avec la première méthode que le dépôt accepte (squash, merge, rebase), donc
jamais une tête arrivée après le jugement. Le main passe le réglage par `WORKPILOT_APPROVALS`
(`main/agent/approvals-env.ts`) ; `off` et `observe` ne fusionnent rien.

Avec Claude Ship allumé (`WORKPILOT_CLAUDE_SHIP=1`, voir [approval-tiers.md](approval-tiers.md#claude-ship-en-option-lot-a3)),
les checks Claude Code Review et Claude Approvals de la tête entrent dans ce jugement, et une PR que
PR Steward suit (label `claude-pr-steward-watching`) ne reçoit plus de tour de correction de
WorkPilot (`steward` dans l'historique, aucun tour dépensé).

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
