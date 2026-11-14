---
section: 🐛 Corrections
---

- **Contexte cognitif lié au projet** : l'optimiseur lit les fichiers du projet ouvert (choisis
  dans le projet, tapés relativement à lui, ou proposés par WorkPilot quand la liste est vide) et
  liste ceux qu'il n'a pas lus avec la raison. Les extraits gardent les déclarations de toutes
  les stacks (C#, Java, Kotlin, Go, Rust, PHP, Swift, Dart…), se déplient dans le panneau et se
  copient. Avec `WORKPILOT_COGNITIVE_CONTEXT_ENABLED`, le coder reçoit enfin ce contexte packé :
  l'option n'avait jusqu'ici aucun effet. Le budget est borné à 200 000 tokens comme le backend.
