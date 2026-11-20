---
section: 🐛 Corrections
---

- **Import Azure DevOps** : un Bug importé depuis la fenêtre d'import reçoit la catégorie « correction de bug » (`bug_fix`) que filtre le tableau, au lieu d'une catégorie `bug` qui n'existe pas ; les autres types (User Story, Feature, Task, types personnalisés) deviennent des features, et non plus une catégorie `task` inconnue.
- **Tâches importées d'Azure DevOps** : la réparation de l'affichage n'écrit que les champs qu'elle a changés, sans effacer un titre écrit entre-temps, et un `requirements.json` qui n'est pas un objet est signalé comme illisible. La synchronisation des critères d'acceptation ne lit que le work item dont la tâche est issue. Les handlers Azure DevOps revérifient ce que le renderer envoie (`azure-devops-ipc-guard.ts`) : ids de work item entiers positifs, liste bornée, types courts, option d'import limitée à son champ ; la construction d'une tâche importée vit dans `azure-devops-import.ts`.
