---
section: 🧪 Filets de test
---

- **Couverture backend, lot B5 (cerveau partagé et Replay)** : `brain/` et `replay/` sont entièrement couverts.
  - Cerveau : le pont des mémoires (frontmatter non fermé, commentaire sur plusieurs lignes, règle proposée par un agent puis confirmée, sauvegarde d'origine gardée, pont rafraîchi), les notes (étiquettes écrites en une valeur, écriture interrompue sans fichier temporaire laissé) et le repli de recherche par mots du vault.
  - Replay : une session enregistrée suivie de l'enregistreur aux routes, en passant par les points de reprise, les forks, le score des décisions et leur carte de chaleur.
  - Code mort retiré, preuves à l'appui : une vérification qui ne pouvait pas se déclencher à la création d'un cerveau neuf, une erreur 500 de la comparaison A/B qui suivait une seconde lecture des deux sessions, et un retour après le dernier type de point d'arrêt.
- 🐛 **Un point d'arrêt sur un fichier précis s'arrête enfin sur ce fichier** : le changement de fichier était vérifié avant que son chemin ne soit attaché à l'étape, si bien qu'un point d'arrêt limité à un chemin ne se déclenchait jamais.
- 🐛 **Un type de point d'arrêt inconnu est refusé avec une erreur claire (422)** au lieu d'une erreur serveur.
