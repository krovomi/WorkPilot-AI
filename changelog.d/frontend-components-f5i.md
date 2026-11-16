---
section: 🐛 Corrections
---

- **API Explorer** : plusieurs environnements importés d'un coup ont chacun leur identifiant
  (ils partageaient le même, donc modifier ou supprimer l'un touchait les autres) et arrivent
  dans l'ordre où ils ont été trouvés ; supprimer l'environnement actif bascule sur un
  environnement qui existe encore ; l'export Postman garde les requêtes sans étiquette et écrit
  les exemples d'en-tête tels quels ; la documentation Markdown ne casse plus un tableau quand
  une description contient un `|` et n'affiche plus les paramètres communs d'un chemin comme
  un endpoint ; copier le contrat dit quand le presse-papiers refuse ; une erreur de chargement
  du contrat ne commence plus par « Error: » ; l'environnement par défaut détecté, le libellé
  Markdown et les boutons sans texte (fermer, modifier, supprimer, afficher le jeton, effacer
  la recherche, charger le contrat) sont traduits et nommés pour un lecteur d'écran ; les deux
  fenêtres sont annoncées comme des boîtes de dialogue.
