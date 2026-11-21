---
section: 🐛 Corrections
---

- **Forges** : chaque projet lit ses issues, PR et merge requests dans le dépôt de ses propres
  remotes git. Sans dépôt enregistré, GitHub et GitLab prennent celui du remote du projet ; un
  dépôt enregistré qui n'est aucun remote du projet (copié d'un autre projet) est signalé dans
  les réglages GitHub, GitLab et Azure DevOps, avec le bon dépôt en un clic. La revue de PR et
  l'autofix GitHub utilisent le jeton et le dépôt du projet au lieu du compte global de `gh`.
  Les remotes `gitlab.com` sont reconnus à l'ajout d'un projet.
