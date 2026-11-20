---
section: 🐛 Corrections
---

- **La revue de PR GitHub en plusieurs passes rapporte enfin ce que le modèle a trouvé** :
  quand l'orchestrateur parallèle est désactivé, chaque passe (balayage rapide, sécurité,
  qualité, structure, tri des commentaires d'autres outils d'IA, analyse approfondie) lisait la
  réponse du modèle sous une forme que le client ne produit plus, et la revue se terminait
  toujours sans aucun constat.
- **La revue de suivi d'une PR GitHub garde la réponse structurée du modèle** même quand le SDK
  ne la donne que dans son message de fin : elle ne retombait plus alors sur la lecture
  heuristique du diff.
