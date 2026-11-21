---
section: 🐛 Corrections
---

- **Revue IA des merge requests GitLab** : la revue lit enfin la réponse du modèle (elle concluait
  « prête à fusionner », sans aucun constat, quelle que soit la MR), et une réponse sans revue
  lisible ne vaut plus approbation. Un refus de GitLab (jeton, droits, MR introuvable, limite de
  débit) ou une instance injoignable s'affiche en clair au lieu d'une trace Python. L'instance
  auto-hébergée de `GITLAB_INSTANCE_URL` est prise en compte, `--instance` n'est plus écrasé par
  la configuration du projet, et le jeton de glab se lit avec le glab choisi dans l'app. Lancée
  par l'app, la revue reçoit aussi le contexte du code et retient ses constats importants dans
  la mémoire du projet, comme celle de GitHub.
  L'app lance enfin la revue sur le bon projet GitLab : elle passait le dossier local là où le
  runner attend le projet GitLab (`namespace/nom`), qui recevait donc une erreur 404.
