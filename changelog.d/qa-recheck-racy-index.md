---
section: 🐛 Corrections
---

- **Re-revue QA : un correctif de même taille n'est plus manqué.** L'instantané du worktree
  copiait l'index git sans garder sa date ; sous Windows, une correction de même taille écrite
  dans la même seconde que l'index passait pour « aucun fichier changé », et la passe suivante
  disait au relecteur que le fixer n'avait rien fait.
