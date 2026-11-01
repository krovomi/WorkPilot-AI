---
section: 🐛 Corrections
---

- **Une carte du serveur tourne enfin avec le moteur, la priorité et l'objectif qu'on lui donne.** En mode serveur, l'app abandonnait le provider, le modèle, l'effort, la priorité et la catégorie choisis à la création d'une carte, et une modification dans le panneau de la tâche (moteur, objectif) s'écrivait dans le miroir local, que le serveur ne lit jamais : la carte tournait sur le moteur par défaut du serveur, sans objectif. Le serveur les accepte désormais (`PATCH /api/board/cards/{id}/settings`), les valide (provider connu, objectif vérifié avec les règles du build) et les écrit là où le build les lit ; ils restent modifiables après le début du travail, sauf pendant un run. Modifier le moteur d'une carte déjà commencée n'échoue plus parce que l'app renvoyait son texte inchangé. Le téléphone affiche avec quoi la carte tourne.
