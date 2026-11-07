# Best-of-N : une tâche construite N fois, la personne garde un build (`best_of_n`)

`parallel_variations/` écrivait des plans de variantes sans lancer d'agent (supprimé depuis, voir
[variants-and-replays.md](variants-and-replays.md)). L'Arena compare des
réponses de modèles, pas des builds. Personne ne pouvait donc demander « construis cette tâche
avec trois moteurs et montre-moi lequel a le mieux fait ». Best-of-N le fait sur une vraie tâche
du Kanban, avec ses vrais worktrees, et laisse le choix à la personne.

```
apps/backend/best_of_n/
  variants.py    les moteurs, les dossiers de spec des variantes, best_of_n.json
  rank.py        les mesures de chaque variante et le classement (pur, sauf git et l'objectif)
  lifecycle.py   préparer, classer, adopter, abandonner
apps/backend/runners/best_of_n_runner.py                 une commande par appel, une ligne JSON
apps/frontend/src/main/ipc-handlers/task/best-of-n-handlers.ts   lance les builds, suit les sorties
apps/frontend/src/renderer/components/task-detail/BestOfNCard.tsx
```

## Le déroulé

1. **Configurer.** Sur une tâche du backlog, la carte propose 2 à 4 moteurs (fournisseur ×
   modèle × effort). Le premier est celui de la tâche. Le même moteur deux fois est permis : c'est
   un tirage de plus.
2. **Préparer** (`prepare`). Pour chaque moteur, un dossier de spec frère `<tâche>-bon<k>` est
   copié depuis la tâche, sauf ce qu'un build écrit (logs, rapport QA, verdict d'objectif…). Son
   `task_metadata.json` porte le moteur (`engineLocked`, les quatre phases) et
   `bestOfN: {parent, index}`. Les worktrees `workpilot/<tâche>-bon<k>` sont créés l'un après
   l'autre, avant tout build. N `run.py` qui créent les leurs en même temps feraient des `fetch`
   et des écritures de refs concurrentes dans le même dépôt. Si une étape échoue, tout ce qui a
   été créé est retiré.
3. **Construire.** Le main lance chaque variante par `agentManager.startTaskExecution`, à 1,5 s
   d'intervalle. C'est le chemin de n'importe quelle tâche : environnement du fournisseur de la
   variante, rafraîchissement du jeton Claude, logs, arrêt à la fermeture de l'app. Les variantes
   sont filtrées du tableau par `project-store`, et leur sortie ne passe pas par la machine d'état
   des tâches (`isBestOfNVariant` dans `agent-events-handlers.ts`).
4. **Classer** (`rank`). Le classement est lancé quand la dernière variante sort. Il peut aussi
   être relancé depuis la carte, par exemple après une interruption.
5. **Choisir.** La personne lit le tableau, appuie sur « Garder celle-ci » et confirme. Rien n'est
   automatique.
6. **Adopter** (`adopt`). Le worktree est déplacé et la branche renommée au nom de la tâche
   (`git worktree move`, `git branch -m`), là où tout le reste de WorkPilot les cherche. La copie
   du spec dans le worktree prend le nom de la tâche. Ce que le build a écrit rejoint le dossier
   de la tâche, avec le moteur gagnant dans ses métadonnées. Les autres variantes, leurs
   worktrees et leurs branches sont supprimés. La tâche continue ensuite comme si elle avait été
   construite une fois : revue, PR, suivi de PR. Rien n'est fusionné ni poussé.

« Tout abandonner » arrête les builds en cours puis supprime toutes les variantes ; la tâche
reste comme avant le run.

## Le classement

Chaque critère ne départage que les variantes que les précédents laissent à égalité :

| Critère | Mesure | Source |
|---|---|---|
| `build` | toutes les sous-tâches du plan terminées | `implementation_plan.json` du worktree, sinon du dossier principal |
| `tests` | la QA a signé le build (la QA lance les tests du projet) | `qa_signoff.status == "approved"` |
| `goal` | la commande du mode objectif sort avec le code attendu | `goal.evaluate_goal`, relancé maintenant dans chaque worktree, chemins protégés compris |
| `diff` | moins de lignes modifiées depuis le point de départ | `git diff --numstat` + fichiers non suivis, hors `.workpilot/` |
| `cost` | moins dépensé | `goal.spend.task_spend` sur les deux registres d'usage de la variante |

Le tableau montre chaque nombre : sous-tâches faites / total, statut QA, verdict de l'objectif
(avec sa raison au survol), lignes et fichiers, coût.

## Ce qui empêche un faux classement

- **Un critère illisible ne classe personne.** Le critère est ignoré, et la carte dit pourquoi,
  dans les cas suivants :
  - un objectif en `error` ou `invalid` pour une variante construite ;
  - un diff illisible ;
  - un coût qui n'est qu'un plancher (un fournisseur sans prix connu).

  Classer sur la moitié des variantes mettrait un nombre que la carte ne peut pas justifier
  au-dessus d'un nombre qu'elle peut justifier.
- **L'objectif est revérifié, pas relu.** Le verdict enregistré par la QA d'une variante peut
  dater d'avant son dernier commit. Le classement relance la porte du mode objectif dans chaque
  worktree, avec l'objectif tel que la personne l'a écrit sur la tâche.
- **Pas de recommandation sans vainqueur net.** Une variante n'est recommandée que si elle est
  seule au rang 1 avec un build fini. Sinon la carte dit de comparer.
- **Pas d'égalité cachée.** Des variantes encore à égalité après le dernier critère partagent leur
  rang.
- **Un run par tâche, et une tâche sans build.** `prepare` refuse dans ces cas :
  - une tâche qui a déjà un worktree ou une branche ;
  - un plan commencé ;
  - un spec qui attend sa revue (`requireReviewBeforeCoding`) ;
  - un run encore ouvert ;
  - une variante restée d'un run précédent.

  Le gagnant devient le build de la tâche, et il ne doit pas y en avoir un autre à écraser.
- **Une interruption est dite.** Si l'app se ferme pendant les builds, les variantes sans code de
  sortie sont marquées « interrompues » à la réouverture. La personne relance le classement ou
  abandonne.

## Sécurité

- **Le renderer ne nomme que la tâche et des moteurs.** Fournisseur, modèle et effort sont
  validés dans le main puis par le runner.
- **Les noms de variante sont dérivés du nom de la tâche.** Un nom relu dans `best_of_n.json` est
  revérifié contre `<tâche>-bon<k>` avant de devenir un chemin ou une branche. Le dossier de spec
  est résolu et rattaché au projet.
- **Pas de lien symbolique.** Un spec qui en contient un n'est pas copié, et la copie se fait sans
  suivre de lien.
- **Les builds sont des tâches ordinaires.** Mêmes hooks, même `path_guard`, même sandbox. La
  commande de l'objectif tourne sans identifiants.

## Limites connues

- **Le coût est multiplié.** Chaque variante est un build complet, et la carte le dit avant le
  lancement.
- **Les variantes ne sont pas visibles une par une.** Elles n'ont ni logs ni fiche propre dans
  l'UI : la carte montre leur état, puis le classement.
- **Le coût après adoption.** Les lignes de coût des variantes gardent leur nom de spec, `-bon<k>`,
  et le coût affiché sur la tâche adoptée ne les additionne pas.

## Vérifier

```
pytest tests/best_of_n -q
cd apps/frontend && npx vitest run best-of-n-handlers BestOfNCard project-store
```
