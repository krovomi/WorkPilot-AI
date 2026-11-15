---
section: 🧹 Maintenance
---

- **Création de spec** : les anciens recours à des scripts `planner.py` et `context.py` placés dans le projet sont retirés ; WorkPilot n'en livre plus depuis longtemps. Le plan vient toujours de l'agent de planification, et `context.json` est écrit directement à partir de la tâche.
- **Hook git de la frise des fichiers** : le hook `post-commit` que WorkPilot ajoutait au dépôt n'est plus installé. Il appelait un module qui n'existe plus et n'a donc jamais rien enregistré. Au premier build, WorkPilot le retire du projet : un hook entièrement à lui est supprimé, et un hook auquel il s'était ajouté retrouve son contenu d'origine. `merge/install_hook.py` et `merge/tracker_cli.py`, qui n'avaient pas d'autre usage, sont supprimés.
