---
section: ✨ Nouveautés
---

- **La gouvernance d'un projet du serveur, dans l'app et sur le téléphone** (#353) : Garde-fous
  d'un projet du mode serveur montre ce que le serveur lit dans son `workpilot.policy.yaml`, les
  appels qu'attendent ses agents (Approuver, Refuser), ses agents en cours avec leur arrêt, et ses
  dernières décisions, exportables ; le téléphone a la même page, sauf l'export. Une approbation
  est donnée au nom du compte connecté et de ses rôles, et le journal l'écrit ; le nouveau
  `files.reviewers` réserve l'approbation à certains rôles. Sur l'ordinateur seul, le panneau dit
  qu'une approbation n'a pas d'identité vérifiée.
- **« Arrêter tous les agents » atteint aussi le serveur** (#353) : en mode serveur, l'appui arrête
  en plus les runs et les jobs que la personne a lancés sur chaque projet du serveur, jamais ceux
  d'un collègue ; le propriétaire d'un projet peut y tout arrêter. Un test sur de vrais processus
  exige que l'arrêt prenne moins de 2 s.
- **Les noms de fuseau marchent sous Windows** (#353) : le backend embarque `tzdata`, donc
  `schedule.timezone: Europe/Paris` n'est plus refusé là où le système n'a pas de données de fuseau.
