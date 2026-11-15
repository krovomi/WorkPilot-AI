---
section: 🐛 Corrections
---

- **Mode serveur, en direct** : l'app de bureau et l'app mobile rejoignent de nouveau le flux en
  direct d'un projet du serveur. Le serveur refusait le canal tel que les apps l'écrivent dans
  l'adresse (`project%3A…`) : la présence et le chat d'équipe restaient sur « Reconnexion… » et le
  tableau ne suivait que par relecture périodique.
- **Mode serveur, analyses** : la dette technique, la dérive de la documentation, l'accessibilité,
  l'i18n et les tests instables d'un projet du serveur se lancent de nouveau depuis l'app de bureau,
  et leur dernier rapport partagé s'affiche ; le contrôle des dossiers refusait le dossier miroir
  du projet (« TypeError: Cannot read properties of undefined »).
- **Invitations** : un administrateur d'organisation ne se voit plus proposer le rôle
  « Administrateur », que le serveur lui refuse ; seul un administrateur de la plateforme invite un
  « Administrateur du serveur ».
- **Dérive de la documentation** : une fonction citée sous la forme `nom()` ou `nom(arguments)`
  est vérifiée, et plus seulement `nom(`.
