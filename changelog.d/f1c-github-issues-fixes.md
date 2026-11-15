---
section: 🐛 Corrections
---

- **Le nombre d'issues ouvertes de la connexion GitHub est le vrai** : il comptait la première page d'une liste demandée par pages de un, donc 0 ou 1, et les pull requests avec ; il vient maintenant du total de la recherche GitHub.
- **L'analyse d'une issue GitHub lit un dépôt configuré en URL** (`https://github.com/owner/repo`) : elle seule ne normalisait pas la référence, et l'appel partait vers une adresse invalide.
- **Les handlers GitHub des issues, de l'analyse et du test de connexion revérifient ce que le renderer envoie** : numéro d'issue, état, page et configuration du test, et une référence de dépôt qui n'est pas un seul `owner/repo` ne devient plus une adresse d'API.
- **Le journal d'une revue de PR n'est lu et écrit que pour un vrai numéro de PR** : le numéro reçu du renderer nomme le fichier, il doit maintenant être un entier positif.
- **La version proposée pour une release ne vaut plus jamais `NaN`** : une version de `package.json` comme `2.1` ou `1.4.2-beta.1` donne `2.1.1` ou `1.4.3`, une version absente ou qui n'est pas du texte compte comme `0.0.0`, et le type de montée (majeure, mineure, corrective) se lit dans les versions plutôt que dans les mots de la raison.
- **Un commit dont le sujet ou l'auteur contient `|` arrive entier à la suggestion de version** : les champs de `git log` sont séparés par un caractère qui n'apparaît pas dans un sujet.
- **Un projet GitHub dont le dossier porte `..` dans son nom (`my..app`) n'est plus refusé** : le contrôle cherchait `..` dans un chemin absolu déjà normalisé, où il ne reste jamais de remontée.
