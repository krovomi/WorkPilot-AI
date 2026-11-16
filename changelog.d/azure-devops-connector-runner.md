---
section: 🐛 Corrections
---

- **Azure DevOps** : les appels au connecteur (test de connexion, dépôts, work items, détection du dépôt) passent par un runner du backend, `runners/azure_devops/connector_call.py`, qui reçoit le dossier du projet, l'opération et ses paramètres en arguments : un projet dont le nom de dossier contient une apostrophe fonctionne, et la détection du dépôt ne reçoit plus d'identifiant. Les quatre canaux de revue de PR Azure DevOps, qu'aucun écran n'appelait, sont supprimés.
