---
section: 🐛 Corrections
---

- **Le nombre d'issues ouvertes de la connexion GitHub est le vrai** : il comptait la première page d'une liste demandée par pages de un, donc 0 ou 1, et les pull requests avec ; il vient maintenant du total de la recherche GitHub.
- **L'analyse d'une issue GitHub lit un dépôt configuré en URL** (`https://github.com/owner/repo`) : elle seule ne normalisait pas la référence, et l'appel partait vers une adresse invalide.
- **Les handlers GitHub des issues, de l'analyse et du test de connexion revérifient ce que le renderer envoie** : numéro d'issue, état, page et configuration du test, et une référence de dépôt qui n'est pas un seul `owner/repo` ne devient plus une adresse d'API.
