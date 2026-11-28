---
section: 🔒 Sécurité
---

- **Clés API chiffrées sous WSL, sans trousseau Linux** : quand aucun trousseau Linux n'est utilisable sous WSL (absent, sur un autre bus D-Bus, ou verrouillé derrière une fenêtre que WSLg n'affiche pas), WorkPilot AI chiffre désormais les clés et jetons avec le chiffrement de Windows (DPAPI, lié à votre compte Windows) : l'alerte « Clés API stockées sans chiffrement » ne s'affiche plus et rien n'est à installer. Les clés laissées en clair sont rechiffrées au lancement suivant.
- **Alerte de chiffrement** : elle propose une correction en un clic (« Chiffrer maintenant » sous WSL, sans redémarrer ; « Redémarrer WorkPilot AI » ailleurs sous Linux) et un « Ne plus afficher » qui ne la cache que pour la situation signalée.
