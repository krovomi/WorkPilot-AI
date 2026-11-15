---
section: 🐛 Corrections
---

- **Fusion, aperçu de fusion, analyse d'impact et création de PR répondent par une erreur lisible quand le backend ne peut pas démarrer** : si le lancement de Python échouait d'emblée, l'appel IPC était rejeté et la fenêtre recevait une exception brute au lieu du message « échec » attendu.
