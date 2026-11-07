---
section: 🐛 Corrections
---

- **Les instructions tapées après Ctrl+C sont de nouveau lues par l'agent** (F157). Le CLI
  annonçait que l'agent suivrait les consignes enregistrées dans `HUMAN_INPUT.md` à la reprise,
  mais plus rien ne lisait ce fichier depuis le passage à une session par sous-tâche. La session
  suivante les reçoit maintenant en tête de son prompt, puis WorkPilot archive le fichier
  (`HUMAN_INPUT.<horodatage>.md`) : une consigne s'applique une fois et sa trace reste. Le fichier
  est écrit dans les deux copies de la spec, celle du projet et celle du worktree, et les agents
  ne peuvent pas l'écrire.
