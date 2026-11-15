---
section: 🧪 Filets de test
---

- **Les handlers IPC GitHub des issues, de la CI, des journaux de revue et des releases sont testés contre un GitHub simulé** (lot F1c de la couverture à 100 %) : test de connexion, liste des dépôts, pages d'issues reconstituées sans les pull requests, recherche, issue et commentaires, analyse d'une issue en tâche sur un vrai dossier de projet, spec créée depuis une issue, attente de la CI avant une revue sur une horloge simulée, liste des PR en GraphQL, journal de revue sur un vrai dossier, release et suggestion de version sur un vrai dépôt git, et utilitaires (configuration du projet, jeton de gh, appel d'API, projet vérifié, journalisation). Les assistants de projet que personne n'appelait (`withProject`, `withProjectOrDefault`, `withProjectSync`, `withProjectSyncOrNull`) sont supprimés.
