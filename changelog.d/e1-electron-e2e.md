---
section: 🧪 Filets de test
---

- **Chaque page du menu s'ouvre dans l'app construite sans erreur** : un test E2E Electron ouvre chaque espace de la barre latérale, clique chaque entrée (Labo compris), chaque onglet des hubs et chaque outil qui s'ouvre en dialogue, et échoue sur une exception, un `console.error`, l'écran « Something went wrong » ou une page vide. Une page ajoutée au menu est testée le jour où elle apparaît.
- **Le parcours d'une carte du Kanban, de bout en bout** : création, démarrage, construction par un agent factice (le vrai code d'événements, de phases et de worktree du backend, tout sauf le modèle), revue du diff, vrai « Merge to main », puis Done.
