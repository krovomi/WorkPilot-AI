---
section: 🐛 Corrections
---

- **Les workflows GitHub visent toujours le dépôt configuré** : les commentaires, labels et
  lectures d'issues, ainsi que les appels à l'API (fichiers et commits d'une PR, commentaires
  depuis la dernière revue, comparaison de commits, approbation des workflows de fork), ne
  dépendent plus du dépôt que le dossier local désigne. Une lecture de l'API avec des paramètres
  reste une lecture au lieu de partir en écriture, et l'assignation d'une PR à plusieurs personnes
  envoie bien la liste des comptes.
