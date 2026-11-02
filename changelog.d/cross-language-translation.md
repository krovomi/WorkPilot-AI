---
section: 🐛 Corrections
---

- **La traduction inter-langages fonctionne.** La page cherchait son runner hors du dépôt
  (« can't open file … cross_language_translation_runner.py »), le code collé écrasait le premier
  argument, l'appel au modèle n'existait pas et le « repli » rendait le code source en
  commentaires comme s'il était traduit. Elle passe maintenant par le fournisseur IA choisi,
  affiche la traduction en direct, sépare les tests générés dans leur onglet et signale une
  vraie erreur au lieu d'un faux résultat. Les déclencheurs CI/CD avaient le même chemin faux.
- **Page Traduction inter-langages lisible en thème sombre.** Les listes de langages étaient des
  listes natives blanches aux options grises illisibles ; elles utilisent les composants de
  l'application, avec un bouton pour inverser les langages, la copie du résultat et un historique
  daté.
