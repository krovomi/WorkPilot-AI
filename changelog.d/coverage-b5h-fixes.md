---
section: 🐛 Corrections
---

- **Cerveau partagé sur un dossier en lecture seule** : quand le fichier `.gitignore` du
  vault ne peut pas être écrit, le cerveau s'ouvre et se synchronise quand même, au lieu
  d'échouer avant chaque synchronisation.
- **Serveur MCP du cerveau** : une recherche ou une requête du graphe dont l'agent laisse la
  limite vide (`null`) ou d'une autre forme répond avec la limite par défaut, au lieu d'une
  erreur interne du serveur.
- **Mémoire des builds** : quand le modèle écrit une liste de pièges ou de conventions sous
  forme d'un seul texte, ce texte devient une note, au lieu d'une note par lettre ; des
  découvertes de session ou un ancien fichier de session d'une autre forme ne font plus
  échouer l'enregistrement ni l'import de l'ancienne mémoire.
