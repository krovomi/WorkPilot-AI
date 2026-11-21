---
section: ✨ Nouveautés
---

- **La gouvernance tient aussi le Swarm, la tâche et le coupe-circuit** (#353) : avant chaque
  vague et chaque nouvel essai, le Swarm relit la pause de la tâche et `workpilot.policy.yaml` ;
  hors des heures, au budget atteint ou quand un agent s'est mis en pause, rien de nouveau ne
  démarre et ce qui était fini est gardé. Une politique invalide met la tâche en pause avant toute
  session, avec la liste des erreurs dans son journal et une carte qui le dit. Deux réglages
  rejoignent le fichier : `budget.max_tokens_per_task` (jetons d'une tâche, toutes sessions) et
  `loop_detection.max_same_tool_call` (limite du coupe-circuit, que le réglage de la machine ne
  peut que durcir). Chaque déclenchement du coupe-circuit entre dans le journal d'audit, et
  Réglages → Garde-fous compte les actions arrêtées sur 24 h et les déclenchements sur 7 jours.
