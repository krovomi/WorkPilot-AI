---
section: 🧪 Filets de test
---

- **Kanban** : la carte, le tableau (glisser-déposer, sélection en masse, file d'attente,
  imports Azure DevOps et Jira, annulation d'une suppression), les colonnes, la barre d'outils et
  les commandes rapides sont testés par leur comportement. Un faux `window.electronAPI`
  (`src/__tests__/helpers/renderer-api.ts`) répond à toute méthode, pour que chaque test ne
  déclare que les appels dont il parle. Code mort retiré du tableau et de la carte.
