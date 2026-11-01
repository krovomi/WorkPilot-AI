---
section: ✨ Nouveautés
---

- **Le journal du build d'une carte du serveur se lit enfin, sur le bureau et sur le téléphone.** En mode serveur, l'onglet Logs d'une tâche restait vide : le journal était écrit dans le clone du serveur et rien ne le servait. Le serveur le sert désormais (`GET /api/board/cards/{id}/logs`, permission de lecture des tâches), en fusionnant la copie du dossier de spec et celle de l'espace de build comme l'app le fait en local, borné et avec les secrets masqués. L'onglet Logs de l'app le relit toutes les 3 secondes tant qu'il est ouvert ; l'écran d'une carte sur le téléphone gagne une section « Journal du build » qui ouvre la phase en cours.
