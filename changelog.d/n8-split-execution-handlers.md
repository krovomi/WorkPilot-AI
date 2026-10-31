---
section: 🛠️ Qualité
---

- **Les handlers d'exécution des tâches sont répartis par groupe** (F130). `execution-handlers.ts`
  passe de 3 092 à environ 500 lignes : la revue, le changement de statut, la reprise et la
  récupération d'une tâche bloquée ont chacun leur module. Aucun changement de comportement.
