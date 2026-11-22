---
section: 🐛 Corrections
---

- **Mode multi-utilisateur, administration** : dans une organisation qu'un administrateur de la
  plateforme vient de créer, changer le rôle d'un membre n'est plus refusé (« l'organisation
  resterait sans administrateur ») tant que ce membre n'en était pas un. Une invitation peut
  nommer le rôle de la personne dans l'organisation (Relecteur, Mainteneur…), et
  **Administration → Membres** ajoute à l'organisation un compte qui existe déjà sur le
  serveur, par son adresse (administrateur de la plateforme), là où une invitation refusait
  l'adresse. Le test de bout en bout du serveur à deux organisations repasse au vert.
