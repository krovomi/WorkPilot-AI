---
section: ✨ Nouveautés
---

- **Après un mauvais verdict de la surveillance de déploiement** : un rapport d'incident
  (référence, pire valeur et dernière valeur de chaque métrique, mesures critiques et dégradées,
  réponses du health check, rollback), suivi de quelques phrases du modèle du projet, quel que
  soit son fournisseur (`explain_incident: false` dans `.workpilot/deploy-monitors.yaml` le
  retire) ; une notification sur le bureau et les canaux configurés (ntfy, Telegram) ; et, si le
  fichier dit `revert_pr: true`, une PR qui revert le commit déployé, préparée dans un worktree et
  une branche à elle et ouverte sur la forge du projet (GitHub, GitLab, Azure DevOps). Rien n'est
  jamais poussé sur la branche par défaut.
