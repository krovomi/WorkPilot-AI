---
section: ✨ Nouveautés
---

- **Mon usage, l'information des membres et l'effacement d'un compte sur le serveur d'équipe.**
  Chacun lit ce que les administrateurs voient de lui et quels rôles le lisent
  (`GET /users/me/usage`), et exporte en JSON tout ce que le serveur garde de son usage
  (`/users/me/usage/export`). Un message dit à chaque membre ce qui est mesuré ; sa lecture est
  inscrite à l'audit, et il revient quand l'activité par page est activée. Un administrateur de la
  plateforme efface un compte (`POST /admin/users/{id}/erase`) : la consommation, la présence et
  l'audit restent sans nom, adresse et IP sont effacées.
