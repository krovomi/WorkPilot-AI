---
section: 🐛 Corrections
---

- **Une carte fusionnée en local passe en Done** : après « Merge to main », la déplacer dans Done tentait d'ouvrir une PR, échouait (« aucun commit à pousser ») et la laissait en revue. Une branche déjà contenue dans la branche de base, sans travail non commité dans son worktree, ne déclenche plus de PR.
- **L'app ne relance plus `pip install` à chaque démarrage** : la vérification de l'environnement Python attendait un module que rien n'installe (`google.generativeai`) et concluait toujours à une dépendance manquante.
