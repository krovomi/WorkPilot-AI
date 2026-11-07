# Tâches empilées (F6)

Une tâche B qui attend une tâche A (A est dans ses « Bloquée par ») ne peut d'habitude démarrer
qu'une fois A fusionnée. Empilée sur A, B part de la branche de A au lieu du tronc : son code
s'appuie sur celui de A avant sa fusion, et sa PR ne montre que le diff de B.

Code : règles sans I/O `apps/frontend/src/shared/utils/task-stack.ts`, git et métadonnées
`apps/frontend/src/main/ipc-handlers/task/stack-handlers.ts`, interface
`renderer/components/task-detail/TaskStack.tsx`, côté PR `apps/backend/core/stacked_pr.py`.

## Empiler

« Empiler sur A » n'est proposé que pour un prérequis non terminé de B. Le main refuse :

- B n'est pas bloquée par A, A est terminée, B est déjà empilée, ou empiler fermerait une boucle
  (le parcours remonte les prérequis et la pile de A) ;
- B a déjà un worktree : sa base ne change plus par empilement, seulement par « Mettre à jour » ;
- A n'a ni worktree, ni branche, ni commit au-delà de sa base ;
- une carte du tableau serveur (`local_only`) : l'empilement est local pour l'instant.

Il écrit alors dans chaque copie de `task_metadata.json` de B : `baseBranch = workpilot/<A>`,
`useLocalBranch` (le worktree part du commit local de A, `origin/workpilot/<A>` pouvant être en
retard), `stackParent`, `stackParentSha` (le commit de A à ce moment) et `stackTrunk` (la branche
où A ira). `detect_base_branch` et `create_worktree` font le reste, sans code nouveau.

## Garder B sur A

`stackStatus` compare `stackParentSha` au commit actuel de `workpilot/<A>`. Si A a bougé (un
correctif QA, une retouche), « Mettre à jour » lance dans le worktree de B
`git rebase --onto <A actuel> <A enregistré>` : seuls les commits de B sont rejoués. Jamais
pendant qu'un agent tourne sur B (`running`), jamais sur un worktree modifié (`dirty`). Un
conflit annule le rebase (`rebase --abort`) et liste les fichiers : rien n'est résolu à la place
de la personne.

Une fois A terminée, « Passer sur <base> » rejoue B `--onto <base> <A enregistré>`, ce qui marche
aussi après un squash merge. La base est la pile de A si A était elle-même empilée (B reste alors
empilée, sur le grand-parent), sinon la base de A, lue sur `origin` après un `fetch`. La PR de B
est reciblée par `gh pr edit --base` ; un échec le dit sans annuler le rebase.

## La PR

Avant de créer la PR de B, `push_and_create_pr` pousse la branche de A (GitHub exige que la base
existe sur le dépôt distant). Si l'extension officielle `gh stack` est installée, les deux PR sont
liées en pile (`gh stack link --base <tronc> <A> <B>`, sans état local) ; sinon, la PR qui vise la
branche de A est le repli. Un échec du lien (codes 3, 4, 8) ne défait jamais la PR : le résultat
porte `stack_linked` et `stack_note`. GitLab et Azure DevOps n'ont que le repli (la PR vise la
branche de A).

## Sûreté

Le renderer ne passe que des identifiants de tâche (S6) : le main relit chaque tâche, refuse un
identifiant inconnu ou trop long, n'accepte un nom de spec que par `SPEC_ID`, une branche que par
`isSafeBranch` (pas de `..`, pas de `-` initial), un commit que par 40 hex, un lien de PR que s'il
finit par `/pull/<n>`. git et gh reçoivent des listes d'arguments, sans shell (règle 6). Le côté
Python valide le parent avec la même expression avant `validate_branch_name`, qui accepte `..`.

## Pas couvert

- Démarrer B automatiquement dès que A a son premier commit : la file attend toujours que A soit
  terminée, sauf démarrage manuel.
- Le rebase automatique quand A bouge : il reste un clic, pour ne jamais réécrire la branche de B
  à l'insu de la personne.
