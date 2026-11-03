---
section: 🐛 Corrections
---

- **App mobile : plus de clés brutes à l'écran.** Les statuts du tableau de bord, les phases des sessions et les rôles de projet et d'organisation s'affichent traduits en anglais et en français (« En cours », « Revue IA de PR GitHub », « Mainteneur »…) au lieu de `in_progress`, `github-review` ou `maintainer`. Le message d'autorisation Face ID est traduit en français.
- **Analyses du mode serveur : un écran rouvert retrouve l'analyse en cours.** Le rapport d'une analyse renvoie aussi le run qui tourne ; l'app mobile le suit et propose de nouveau Annuler. Une tâche de projet annulée pendant son démarrage est arrêtée au lieu de tourner jusqu'au bout.
- **CI mobile : fin des tests de connexion qui expiraient au hasard.** Le premier rendu d'un fichier de test transforme tout React Native ; sans cache (CI) il prenait jusqu'à 10 s et dépassait la limite de 5 s par test de Jest. La limite passe à 30 s pour l'app mobile.
