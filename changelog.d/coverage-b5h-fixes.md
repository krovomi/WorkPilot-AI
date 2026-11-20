---
section: 🐛 Corrections
---

- **Cerveau partagé sur un dossier en lecture seule** : quand le fichier `.gitignore` du
  vault ne peut pas être écrit, le cerveau s'ouvre et se synchronise quand même, au lieu
  d'échouer avant chaque synchronisation.
- **Serveur MCP du cerveau** : une recherche ou une requête du graphe dont l'agent laisse la
  limite vide (`null`) ou d'une autre forme répond avec la limite par défaut, au lieu d'une
  erreur interne du serveur.
