---
section: 🐛 Corrections
---

- **Hermes Agent n'affiche plus « Failed to fetch » au démarrage**. La fenêtre s'ouvre avant le
  backend local : la carte Hermes de la barre latérale l'interrogeait trop tôt et restait en
  « Erreur » jusqu'à un clic sur « Actualiser ». Le main attend désormais la fin du lancement du
  backend avant de répondre aux vues qui l'interrogent (Hermes, commandes slash, catalogue de
  modèles, cerveau…), et un premier démarrage lent (après une mise à jour, sous WSL) n'est plus
  signalé comme un échec au bout de 10 s. Un backend vraiment arrêté est nommé comme tel au lieu
  de « Failed to fetch ».
