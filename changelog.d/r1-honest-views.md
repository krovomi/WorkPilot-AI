---
section: 🐛 Corrections
---

- **La vue « Spec Approval » approuve vraiment** (F137). Elle liste les tâches dont le plan vous
  attend et décide par le même canal que la carte : approuver lance le build, demander des
  modifications renvoie le plan avec votre retour. Avant, elle écrivait dans des fichiers que
  personne ne lisait et restait vide. La vue « Spec Refinement », qu'aucun code n'alimentait, est
  retirée.
- **Idéation ne boucle plus et accepte tous les fournisseurs.** La page relançait sa vérification
  d'identifiants en continu tant qu'elle était ouverte, et exigeait un compte Claude même quand
  elle tournait sur Codex, Copilot, Gemini ou Ollama.
- **Des noms honnêtes** : les vues qui analysent le code sans appeler de modèle ne s'appellent plus
  « Agent » (Analyse d'accessibilité, Analyse i18n, Kit d'intégration, Contrôles de notebook,
  Aperçu des changements), et l'aperçu des changements n'affiche plus d'étapes ni de coût qu'il
  ne calcule pas.
