---
section: ✨ Nouveautés
---

- **Vagues d'exécution sur un serveur d'équipe et sur mobile** (#358, lot 4) : le serveur
  planifie le backlog d'un projet depuis son clone, avec le même calcul que le bureau (fichiers
  partagés, zones fragiles, liens de code, merge de test), et mène lui-même « Exécuter dans
  l'ordre optimal » : il lance chaque carte comme le tableau, au nom de la personne qui a démarré
  l'exécution et seulement tant qu'elle en a le droit, et passe à la vague suivante quand un run
  du projet se termine. L'exécution et son historique vivent dans le clone. L'app mobile a une
  page « Vagues » par projet : plan, exécution en cours, démarrage, arrêt et chiffres du sprint.
- **Temps de résolution des conflits résiduels** (#358, lot 4) : un merge (ou son aperçu) qui
  rencontre un conflit git en note l'heure, le merge suivant de la tâche qui aboutit note celle de
  la résolution, sur le bureau comme sur le serveur. La vue des vagues et l'app mobile montrent,
  sur 14 jours, les conflits résolus, leur temps médian mesuré et ceux encore ouverts. Rien n'est
  estimé.
