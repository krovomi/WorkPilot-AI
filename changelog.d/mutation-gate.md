---
section: ✨ Nouveautés
---

- **Les tests attrapent-ils un bug ? La porte `tests-bite`.** Une fois la QA approuvée, WorkPilot
  plante quelques fautes simples (`>=` devient `>`, `&&` devient `||`, `true` devient `false`…)
  dans les seules lignes que la tâche a écrites, une à une, dans une copie jetable du worktree, et
  lance les tests du fichier muté. Toutes les stacks : un mutateur générique qui ignore
  commentaires et chaînes (C#, TypeScript, Python, Go, Rust, Java, Kotlin, Dart, Swift, PHP…), ou
  StrykerJS et cargo-mutants quand le projet les a. Une faute que les tests ne voient pas renvoie
  au QA fixer comme un test manquant, et il ne peut alors modifier que des tests. Activée pour le
  workflow `test`, et pour toutes les tâches avec `WORKPILOT_QA_MIN_MUTATION` (seuil en %).
