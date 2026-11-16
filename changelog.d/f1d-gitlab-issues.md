---
section: 🐛 Corrections
---

- **Issues et merge requests GitLab** : l'investigation d'une issue écrit enfin dans la tâche les commentaires choisis (section « Selected comments », 50 au plus, chacun borné), lus par pages de 100 et non plus sur la première page de 20. Les handlers des issues, des notes, des merge requests, de l'import et de l'investigation revérifient ce que le renderer envoie avant de l'utiliser : état de la liste en liste fermée, iid, liste d'issues, champs d'une nouvelle merge request (`gitlab/ipc-guard.ts`). Le code GitLab que l'UI n'appelait pas est supprimé : auto-fix, triage, création de release, lecture d'un projet, d'une issue ou d'une merge request seule, et modification d'une merge request, avec leurs canaux et méthodes du preload.
