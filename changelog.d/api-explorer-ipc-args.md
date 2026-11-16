---
section: 🐛 Corrections
---

- **API Explorer** : l'application vérifie elle-même chaque requête que la page lui demande
  d'envoyer (adresse `http` ou `https`, méthode connue, en-têtes et corps bornés) et la portée
  et les champs des secrets qu'elle range, comme le font déjà ses autres vues.
