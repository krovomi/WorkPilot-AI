---
section: 🐛 Corrections
---

- **Les vues GitHub, GitLab, CI/CD et Git montrent le projet de l'onglet affiché.** Après la
  fermeture de l'onglet affiché, l'ouverture d'un nouvel onglet ou un redémarrage, certaines vues
  restaient sur un autre projet : la vue « PRs GitHub » de l'onglet « Dotnet » listait les pull
  requests de WorkPilot-AI. Le projet sélectionné suit désormais l'onglet actif, et une réponse
  arrivée après un changement de projet (dépôt, PR, issues) n'est plus affichée.
