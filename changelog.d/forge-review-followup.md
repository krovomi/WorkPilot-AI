---
section: 🐛 Corrections
---

- **Vérification des labels GitHub sous Windows** : la lecture paginée des événements d'une
  issue passe ses paramètres à `gh` comme champs, et non dans l'URL. Les tests des revues
  GitHub, GitLab et du tri suivent le format de prompt actuel.
