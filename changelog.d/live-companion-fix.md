---
section: 🐛 Corrections
---

- **Le Compagnon en direct fonctionne enfin.** Il surveillait des motifs que chokidar 6 ne comprend plus, donc aucun fichier, et son analyse importait un module absent : aucune suggestion n'arrivait jamais. Il surveille maintenant le dossier du projet pour toutes les stacks (dont .NET/Blazor, Kotlin, Swift, Dart/Flutter, C/C++), analyse le diff ou le début d'un fichier nouveau avec le fournisseur IA sélectionné, garde suggestions et reprises par projet, et affiche pourquoi une analyse a échoué. « Créer une tâche » et « Créer une tâche de reprise » remplacent les boutons qui ne faisaient rien : la correction passe par une carte Kanban (worktree, branche, PR).
