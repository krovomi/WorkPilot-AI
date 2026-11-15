---
section: 🐛 Corrections
---

- **Mode serveur : un administrateur d'organisation ouvre les projets qu'on lui liste.** Il
  recevait « Not a member of this project » en ouvrant un projet de son organisation dont il n'est
  pas membre, sa liste de membres ou ses specs, alors que la liste des projets le donnait
  propriétaire. Il y est désormais propriétaire partout.
- **Mode serveur : un job de feature terminé n'est plus noté « échoué » si un coéquipier ouvre
  la feature au même instant.** Le job cessait d'être suivi avant que son résultat soit
  enregistré ; une lecture tombée entre les deux le prenait pour un job abandonné par un serveur
  arrêté.
