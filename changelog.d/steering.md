---
section: ✨ Nouveautés
---

- **Guider l'agent pendant qu'il travaille.** Sans mettre la tâche en pause, écrivez un message
  depuis l'onglet Sous-tâches de la tâche, l'app mobile (fiche de la carte) ou la CLI
  (`python run.py --spec 001 --steer "…"`, `--steer-subtask` pour viser une sous-tâche). Il entre
  dans le prompt de la prochaine session concernée (coder ou QA fixer), et la tâche affiche quelle
  session l'a reçu. En mode serveur, envoyer demande la permission `agent.execute`. Les agents ne
  peuvent pas écrire dans cette file.
