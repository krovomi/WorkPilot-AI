---
section: 🐛 Corrections
---

- **Les sorties de build et de test n'apparaissent plus dans les fichiers modifiés d'une tâche.** Pour un projet .NET sans `.gitignore`, une tâche « créer toto.txt » listait 268 fichiers (`bin/`, `obj/`, `TestResults/`). WorkPilot exclut désormais ces dossiers (et `node_modules/`, `__pycache__/`, `target/`, `dist/`… selon la pile détectée) de chaque commit du worktree, quel que soit le fournisseur de l'agent, via un bloc géré dans `.git/info/exclude` (local, jamais commité). Les sorties déjà commitées sont retirées de la branche avant la QA, la revue, la PR et la fusion. Un dossier que le projet versionne déjà (un `dist/` commité) n'est jamais exclu.
