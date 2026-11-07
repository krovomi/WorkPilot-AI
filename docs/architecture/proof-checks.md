# Vérification des preuves (`proof-checks`, P2)

Écrire une preuve formelle devient automatisable, et une preuve fausse écrite par un modèle est
simplement rejetée par son vérificateur : c'est une porte dure déterministe, sans faux vert. La
difficulté se déplace vers l'écriture de bonnes spécifications, qui reste le travail de la
personne. WorkPilot ne choisit ni le langage ni l'outil : il lance ceux que le projet déclare.

Code : `apps/backend/core/workspace/proofs.py` (exécution, relevé), `apps/backend/qa/proof_gate.py`
(la porte QA), `workflows/hard_gates.py` (`proof-checks`). La déclaration vit dans la recette de
worktree ([worktree-recipe.md](worktree-recipe.md)).

## Déclarer

```toml
# .workpilot/worktree.toml
[proofs]
commands = [
  ["dafny", "verify", "src/Billing/Invoice.dfy"],   # Dafny, qui compile aussi vers C#
  ["lake", "build", "Proofs"],                     # Lean 4
  ["cargo", "verus", "verify"],                    # Verus, pour Rust
]
windows = [["dafny.exe", "verify", "src/Billing/Invoice.dfy"]]  # remplace commands sous Windows
timeout_seconds = 600                             # 10 à 3600, pour toutes les commandes
```

Les règles de la recette s'appliquent : une commande est une liste d'arguments, sans shell
(`bash -c` est refusé), un programme relatif est celui du worktree, l'environnement est privé des
identifiants sauf ceux de `[setup] pass_env`, et les variables `${WORKPILOT_*}` sont développées.

## Quand et d'où

Après l'approbation du relecteur, avec les autres portes qui peuvent la renverser (dépendances,
architecture, couverture), dans le worktree de la tâche. La recette est lue dans le **projet**
(retrouvé par le répertoire git commun du worktree), jamais dans la branche de la tâche : un agent
qui modifie `worktree.toml` dans son worktree ne change rien à ce qui tourne. Et elle ne tourne
qu'une fois approuvée telle quelle : l'empreinte de la recette couvre `[proofs]`.

## Verdicts

| Relevé (`<spec>/proof_checks.json`) | Porte `proof-checks` | Effet |
|---|---|---|
| `pass` : chaque vérificateur a fini à 0 | tient | aucun |
| `fail` : un vérificateur a refusé | ne tient pas | `QA_FIX_REQUEST.md` avec la commande et la fin de sa sortie ; le fixer corrige le code ou la preuve, sans affaiblir ni contourner (`assume`) une obligation |
| `unknown` : absent, hors délai, recette invalide ou non approuvée | inconnu | dit dans le journal de la tâche, jamais bloquant, jamais compté comme un succès |
| `none` : pas de `[proofs]` | pas de ligne | le projet n'est pas concerné |

Pas de relevé du tout veut dire que la porte QA n'a pas tourné : inconnu. La porte est déclarée
sur `verify` des workflows qui écrivent du code (feature-build, bug-fix, hotfix, refactoring).

## Pas couvert

- Écrire les preuves ou les spécifications : c'est le travail de l'agent, guidé par la spec.
- Installer le vérificateur : un vérificateur absent donne « inconnu », et la recette `[setup]`
  peut l'installer.
- Lancer seulement les preuves touchées par le diff : toutes les commandes tournent.
