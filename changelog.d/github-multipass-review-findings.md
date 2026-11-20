---
section: 🐛 Corrections
---

- **La revue de PR GitHub en plusieurs passes rapporte enfin ce que le modèle a trouvé** :
  quand l'orchestrateur parallèle est désactivé, chaque passe (balayage rapide, sécurité,
  qualité, structure, tri des commentaires d'autres outils d'IA, analyse approfondie) lisait la
  réponse du modèle sous une forme que le client ne produit plus, et la revue se terminait
  toujours sans aucun constat.
