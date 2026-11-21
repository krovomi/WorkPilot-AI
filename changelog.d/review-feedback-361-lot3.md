---
section: ✨ Nouveautés
---

- **Retours sur la revue de PR : projets serveur, rejets en attente, relecture avant publication**
  (#361, lot 3) : sur un projet serveur, Accepter / Rejeter / Non applicable, le taux
  d'acceptation et la réinitialisation d'une règle marchent comme sur un projet local ; le serveur
  écrit les retours dans le clone, où la revue apprend. Le rejet d'un membre attend qu'un
  propriétaire du projet l'approuve ou l'écarte avant que le relecteur n'en tienne compte ; seul
  un propriétaire réinitialise une règle. Avant le verdict, la revue fond en un seul résultat, au
  niveau le plus grave, une remarque faite plusieurs fois au même endroit, et le dit dans son
  résumé. Une revue de suivi sans nouveau commit applique aussi les retours donnés depuis.
