---
section: 🐛 Corrections
---

- **API Explorer, panneau de requête** : « Obtenir un nouveau jeton » OAuth 2.0 passe par le
  processus principal comme les autres requêtes (l'appel direct était bloqué par la politique de
  sécurité de la fenêtre et n'aboutissait jamais) ; une authentification Basic avec un accent ou
  un symbole (« é », « € ») s'envoie au lieu de laisser le bouton Envoyer bloqué ; une requête
  impossible à construire termine l'envoi ; une requête refusée montre la raison du refus ; la
  coloration du JSON colore enfin les clés et les chaînes ; un `$ref` qui contient `~1` ou `~0`
  se résout ; copier la réponse dit quand le presse-papiers refuse ; les champs de l'onglet Auth
  sont reliés à leur libellé, et les boutons d'icône (afficher la valeur, copier, cocher ou
  retirer une ligne) sont nommés pour un lecteur d'écran ; le flux « Authorization Code » ne
  promet plus PKCE, qu'il ne fait pas, et ses libellés sont traduits en français.
