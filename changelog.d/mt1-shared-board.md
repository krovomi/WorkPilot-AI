---
section: ✨ Nouveautés
---

- **Mode serveur : un tableau partagé qu'on peut modifier.** Les membres d'un projet créent,
  modifient, suppriment une carte et approuvent sa spec (`/api/board/cards`), chacun selon son
  rôle ; les autres le voient en direct. Un run sur le serveur peut maintenant écrire la spec
  d'une carte (`spec`) et ouvrir sa pull request (`pr`, qui demande `vcs.pr.create` ; `merge`
  demande `task.merge`).
- **Mode serveur : un run ne reste plus bloqué.** Il tourne sans entrée standard et répond seul
  aux questions du build ; l'approbation d'une spec reste celle d'une personne, jamais forcée.
