---
section: ✨ Nouveautés
---

- **L'app mobile prend les thèmes de l'app de bureau, et le thème suit la personne d'un appareil à l'autre.** Les sept thèmes de couleur (Default, Dusk, Lime, Ocean, Retro, Neo, Forest), chacun en clair et en sombre, avec les couleurs du bureau ; là où un accent ou une couleur d'état serait illisible sur fond clair ou sombre, il est foncé ou éclairci juste assez pour un contraste de 3:1. Dans Réglages → Apparence, la personne choisit le mode (celui de l'appareil, clair, sombre) et le thème ; le choix s'applique à tout l'écran, en-têtes compris, reste sur le téléphone hors ligne et part sur le serveur. Le serveur gagne `GET` et `PUT /users/me/preferences` (révision Alembic `0009`), qui n'acceptent que les valeurs connues. Connectée à un serveur, l'app de bureau lit ce choix à la connexion et envoie le sien quand la personne change de thème.
