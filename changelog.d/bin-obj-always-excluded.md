---
section: 🐛 Corrections
---

- **Le contenu des dossiers `bin/` et `obj/` n'apparaît plus jamais dans les fichiers modifiés d'une tâche, quel que soit le projet.** Le premier correctif ne les excluait que si un projet .NET était détecté, et jamais quand la branche de base versionnait déjà des fichiers `obj/` (fusionnés par une tâche précédente) : un `dotnet restore` réécrivait alors `obj/project.nuget.cache` et les `*.nuget.g.props/targets`, que l'agent commitait. `bin/` et `obj/` sont maintenant exclus partout ; les fichiers que la base versionne déjà sous ces dossiers sont gelés dans le worktree (`skip-worktree`) et ramenés à leur version de base s'ils ont été commités ; la vue des fichiers modifiés les masque aussi.
