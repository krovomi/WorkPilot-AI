---
section: 🧪 Filets de test
---

- **Couverture frontend, lot F3b (stores et hooks)** : Formula Lab, Agent Time Travel, marketplace de plugins, revues de MR GitLab, filtres du Kanban, console d'administration, projets, génération de tests, Pixel Office, écouteurs des tâches et de la roadmap, réglages de GitHub Copilot. Le code jamais appelé est supprimé.
- **Agent Time Travel** : supprimer un point de contrôle ou un fork que le backend refuse de supprimer ne le retire plus de la liste ; le refus s'affiche.
- **Marketplace de plugins** : une désinstallation qui échoue affiche son erreur au lieu de rien.
- **Revues de MR GitLab** : l'abonnement aux événements des revues est pris une fois au démarrage de l'app, et non plus par la page des merge requests.
- **Administration (mode serveur)** : une action refusée par le processus principal n'affiche plus un chargement sans fin.
- **Projets** : renommer un projet pendant qu'un autre est ajouté ne fait plus disparaître ce dernier de la liste.
