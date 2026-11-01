---
section: 🐛 Corrections
---

- **La colonne « Build rouge » du kanban se comporte enfin comme prévu.** Une tâche dont tout le code est fini n'en ressort plus toute seule vers la revue au rechargement suivant ; elle en sort quand la CI repasse au vert, vers son statut d'avant (revue, PR créée…). Un redémarrage de l'application ne retraite plus un build rouge déjà traité (ni nouveau déplacement, ni nouvelle réparation lancée). Une tâche terminée n'y est plus renvoyée, seul le badge du pipeline montre le rouge. La réparation automatique passe par la machine d'états comme un démarrage depuis le tableau (avant, le run de réparation était ignoré par la carte), ne se lance plus sur une tâche que l'agent exécute déjà, et s'arrête après 3 tentatives sur la même tâche. La colonne n'apparaît plus sur un projet sans pipeline CI.
