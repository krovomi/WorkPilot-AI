---
section: 🧪 Filets de test
---

- **Couverture frontend, lot F3d (stores des fonctionnalités)** : arena, delta d'architecture, Context Mesh, pair programming, learning loop, contexte du projet, débogueur d'agent, garde-fous, déclencheurs CI/CD et agent navigateur. Le code jamais appelé est supprimé.
- **Arena** : un combat suit sa progression même quand la fenêtre de l'arena est fermée ou sur un autre onglet, et un combat qui échoue s'arrête au lieu de tourner sans fin.
- **Garde-fous et déclencheurs CI/CD** : changer de projet n'affiche plus les règles ou les réglages du projet précédent, et un enregistrement ne peut plus les écrire dans le mauvais projet. Des réglages CI/CD refusés à l'enregistrement ne s'affichent plus comme enregistrés.
- **Contexte du projet** : changer de projet efface l'index et les souvenirs du précédent, et une recherche dans la mémoire montre les résultats de la dernière saisie, pas d'une saisie plus ancienne qui répond en retard.
- **Pair programming** : la page montre la session du projet ouvert avec sa conversation, et non plus celle du projet précédent. Ses messages d'état sont traduits.
- **Learning loop** : désactiver ou supprimer un pattern met à jour le nombre de patterns actifs.
- **Context Mesh** : une nouvelle analyse repart d'une sortie vide et sans l'erreur précédente, et son état s'affiche dans la langue de l'app.
- **Débogueur d'agent** : un point d'arrêt, une reprise ou un détachement refusé s'affiche au lieu d'échouer en silence, et un rafraîchissement arrivé après le détachement ne remet plus l'ancienne session.
- **Delta d'architecture et agent navigateur** : une carte fermée pendant le chargement n'est plus recréée, une capture dont l'aperçu est illisible se termine, et une suppression de référence refusée est signalée.
