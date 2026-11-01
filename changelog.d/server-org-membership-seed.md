---
section: 🐛 Corrections
---

- **Mode serveur : le passage des comptes d'un serveur mono-organisation dans l'organisation par
  défaut n'a lieu qu'une fois.** Il est enregistré à la mise à niveau (révision Alembic `0007`)
  et le démarrage du serveur ne le refait plus : une personne membre d'une autre organisation, ou
  d'aucune, reste où un administrateur l'a placée. Une invitation appartient désormais à
  l'organisation où agit l'administrateur qui l'émet, avec le rôle qu'elle enregistre ; l'accepter
  fait entrer la personne dans cette organisation. La liste et la révocation des invitations ne
  voient que celles de l'organisation active, et une invitation antérieure sans organisation est
  refusée : en émettre une nouvelle.
