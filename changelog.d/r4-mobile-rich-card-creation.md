---
section: ✨ Nouveautés
---

- **L'app mobile crée une carte comme le bureau** (MO5). L'écran Nouvelle carte choisit le moteur (provider, modèle, effort) et la priorité, sinon la carte tourne avec le défaut du déploiement, et joint jusqu'à 10 images de la photothèque ou de l'appareil photo ; une image refusée (format, plus de 5 Mo, plus de 10) est nommée avec sa raison. La description se dicte avec le micro du clavier. Sur Android, un texte ou un lien partagé depuis une autre app ouvre une nouvelle carte préremplie dans le projet choisi, rien n'étant créé avant que la personne le relise. Le serveur gagne `GET /api/board/engines` (`task.read`), la liste des providers et modèles qu'une carte peut demander.
