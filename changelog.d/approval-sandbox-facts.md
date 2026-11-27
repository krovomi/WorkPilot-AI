---
section: ✨ Nouveautés
---

- **Le bac à sable d'une tâche compte dans le niveau de validation de sa PR.** WorkPilot garde
  le bac à sable de chaque session (microVM Docker, bac à sable de l'OS ou aucun) et les hôtes
  qu'il a refusés. Une tâche lancée sans bac à sable, ou qui a tenté d'atteindre un hôte refusé,
  passe au niveau N2 et attend une personne. Une règle de `workpilot.policy.yaml` peut exiger la
  microVM (`task/sandbox`).
