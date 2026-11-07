---
section: ✨ Nouveautés
---

- **Tâches empilées.** Une tâche qui attend un prérequis peut partir de la branche de ce prérequis
  au lieu du tronc (« Empiler sur … » dans le détail de la tâche) : son code s'appuie sur celui du
  prérequis avant sa fusion, et sa PR ne montre que son propre diff. « Mettre à jour » rebase la
  tâche quand le prérequis change ; une fois le prérequis fusionné, « Passer sur <base> » la remet
  sur la base et recible sa PR. Un conflit est annulé et ses fichiers listés. Avec l'extension
  `gh stack`, les deux PR sont liées en pile sur GitHub.
