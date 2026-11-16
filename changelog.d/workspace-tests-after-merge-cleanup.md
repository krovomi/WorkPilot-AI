---
section: 🧪 Filets de test
---

- **Les tests du worktree suivent le nouveau moteur de fusion.** Le backend ne charge plus le suivi de
  chronologie supprimé, et les tests de dépôt partagé relisent leurs fichiers sans la configuration
  git de la machine (sous Windows, `core.autocrlf` les faisait passer pour modifiés).
