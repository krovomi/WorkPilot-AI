---
section: ✨ Nouveautés
---

- **L'app mobile prévient quand un run se termine.** La personne qui a lancé un run reçoit une notification sur son téléphone quand il réussit ou échoue ; la toucher ouvre la carte. Le serveur n'envoie que le nom du projet, le numéro de la carte, la phase et son résultat, par le service push d'Expo, et seulement si l'opérateur l'active (`WORKPILOT_PUSH_ENABLED`). Sur la fiche d'une carte, l'app permet aussi de modifier son titre et sa description avant que le travail commence, de lire le patch de chaque fichier changé et le rapport QA. Le serveur gagne `PUT` et `DELETE /users/me/devices`, et la fiche d'une carte est lue dans l'espace de build pendant un build.
