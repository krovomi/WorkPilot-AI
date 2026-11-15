---
section: 🧪 Filets de test
---

- **Couverture frontend, lot F3a (stores)** : les stores de l'Idéation, des fonctions de la phase 3 à 5, des tâches du Kanban, du changelog, des terminaux, d'Insights, des colonnes du Kanban et de la marketplace MCP sont testés par leur comportement : ce qu'ils envoient au processus principal, ce qu'ils gardent de la réponse, ce qu'ils affichent d'un refus. Le code jamais appelé est supprimé.
- **Idéation** : ouvrir un projet pendant qu'un autre génère ses idées affiche bien les idées du projet ouvert. La page restait vide, le store lisant encore l'état du projet quitté. Ajouter des types à une idéation existante ne remet plus en attente les types déjà générés.
- **Insights** : une réponse qui arrive pour un projet après qu'on en a ouvert un autre ne s'ajoute plus à la conversation affichée.
- **Marketplace MCP** : installer ou retirer un serveur quand la configuration du projet n'a pas pu être relue est refusé. La liste écrite était celle encore en mémoire, parfois celle d'un autre projet, qui remplaçait les serveurs du projet.
- **Changelog** : une copie dans le presse-papiers refusée par le système s'affiche comme un échec au lieu de passer pour réussie.
- **Annuler une suppression de tâches** : la copie gardée pour l'annulation expire bien au bout de cinq minutes ; elle n'expirait jamais.
