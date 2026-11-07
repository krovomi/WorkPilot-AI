---
section: ✨ Nouveautés
---

- **Hermes Agent 0.23.0.** La pack de skills Hermes suit désormais les versions publiées
  d'Hermes (aujourd'hui v0.23.0) et non plus sa branche principale, où une version canary
  sort chaque jour. Le diagnostic Hermes (barre latérale « Outils CLI » et panneau de tâche)
  affiche la version installée et propose `hermes update` en dessous de 0.23.0.
- **La persona s'applique aussi aux sessions Hermes déjà ouvertes.** Après « Installer
  SOUL.md », WorkPilot demande à Hermes (`hermes sessions refresh-prompts`) de recharger le
  prompt de ses sessions en cours à leur prochain tour, historique conservé.
- **Verrouiller un skill Hermes gardé.** Quand vous gardez des skills appris par Hermes, le
  panneau donne la commande `hermes curator lock <skill>` pour qu'Hermes ne réécrive plus la
  version que vous avez relue.
- **`wait_for_card` montre sa progression.** Le serveur MCP du Kanban envoie la colonne et les
  sous-tâches d'une carte pendant qu'il l'attend, ce qu'Hermes 0.23 (et Claude Code) affichent.
  L'entrée Hermes écrite par l'app porte un délai de quatre heures au lieu des 300 secondes
  par défaut d'Hermes ; une entrée plus ancienne apparaît « à mettre à jour ».
