---
feature: Cartes vertes remises sur la nouvelle base après une fusion
summary: >-
  Après une fusion dans la branche de base (dans l'app ou d'une PR sur la forge), chaque autre
  carte approuvée par la QA reprend la base dans son worktree, puis sa suite repart : sur la CI de
  la forge quand l'app la suit, sinon par une nouvelle revue QA sur la machine.
---

# Cartes vertes remises sur la nouvelle base

Dix cartes finies pendant une absence peuvent être vertes chacune sur leur base, et rouges l'une
après l'autre une fois les premières fusionnées. Après chaque fusion, WorkPilot remet donc les
autres cartes vertes sur la nouvelle base et relance leur suite, sans attendre une personne.

## Quand

- Une fusion faite dans l'app (`worktree-merge-handlers.ts`), sauf « stage only » : la base n'a
  pas encore bougé.
- Une PR vue fusionnée sur sa forge (`worktree-purge/merged-watch.ts`, toutes les 5 minutes).

Les deux appellent `ciPipelineService.refreshAfterMerge(project, carte fusionnée)`.

## Quelles cartes (`base-refresh.ts`)

Une carte verte est en revue humaine ou en attente de sa PR, avec une approbation QA, ni archivée,
ni fusionnée, ni posée dans le projet (« stage only »). Les cartes passent une par une ; l'échec de
l'une n'arrête pas les autres.

## Ce qui est fait à chacune

1. La base est celle de la carte (`getEffectiveBaseBranch`). La référence fusionnée est
   `origin/<base>` quand elle contient la branche locale (PR fusionnée sur la forge), sinon la
   branche locale (fusion dans l'app).
2. Rien ne change si le worktree contient déjà cette base, ni s'il a des changements non
   commités.
3. `git merge --no-edit <ref>` dans le worktree. Un conflit est annulé (`merge --abort`) et noté
   dans `plan.baseRefresh` (`state: "conflict"`) ; l'aperçu de fusion habituel le montre.
4. Puis la suite, comme Leub l'a choisi le 22 novembre 2026 :
   - la CI du projet est suivie par l'app (fournisseur connu, route non mise de côté) : la branche
     est poussée et `plan.ciSuite` repart en `pending` sur le nouveau commit, suivi comme au lot B
     ([test-placement-ci.md](test-placement-ci.md)), sans appel de modèle ;
   - sinon (ou si le push échoue) : l'approbation, donnée sur l'ancienne base, est retirée et la
     revue QA repart sur la machine (`qa-rerun.ts`, les mêmes étapes que « AI review » depuis le
     tableau). Sa suite complète suit `test_placement` ([test-placement.md](test-placement.md)).

Les commandes git sont des listes d'arguments, la base passe `GIT_BRANCH_REGEX` sans `..`, et le
push n'est jamais forcé.
