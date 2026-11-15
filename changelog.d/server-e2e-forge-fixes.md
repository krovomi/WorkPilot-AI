---
section: 🐛 Corrections
---

- **Mode serveur, GitHub et GitLab** : un projet du serveur hébergé sur GitHub ou GitLab affiche
  de nouveau ses vues « GitHub issues » et « GitHub PRs » (ou « GitLab issues » et « GitLab MRs »)
  dans le menu de l'app de bureau ; le filtre du menu ignorait la forge du projet et les cachait
  toujours.
- **Mode serveur, plusieurs projets** : une personne membre de plusieurs projets du serveur les
  ouvre tous depuis l'app de bureau. Le bouton « + » des onglets liste les projets de l'équipe pas
  encore ouverts ; seul le premier s'ouvrait jusqu'ici.
- **GitHub PRs** : rouvrir la vue relit la liste des pull requests, comme elle le promettait ;
  après l'ajout d'un jeton GitHub, la vue n'affichait plus « GitHub non connecté ».
