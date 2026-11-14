---
section: 🐛 Corrections
---

- **La commande rapide du Kanban, le catalogue de modèles, le plan d'effort, les capacités agentiques, la recherche dans la bibliothèque Ollama et les outils d'agent (brain, docintel, hermes, vérification, rtk…) joignent enfin le backend local.** Ils appelaient une adresse vide : en développement, la page de Vite répondait à la place du backend, et dans l'app installée la requête était refusée. C'est maintenant le processus principal qui interroge le backend, sur une liste fermée de routes, et les captures, la vidéo et la trace du vérificateur s'affichent et se téléchargent par le même chemin.
