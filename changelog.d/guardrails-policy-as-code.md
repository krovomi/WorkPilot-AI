---
section: ✨ Nouveautés
---

- **Garde-fous en code : une politique versionnée que les agents ne contournent pas** (F185). Un `workpilot.policy.yaml` à la racine du dépôt, une couche globale (`~/.workpilot/guardrails.yaml`) et la couche projet de Réglages → Garde-fous s'empilent sans qu'une couche puisse affaiblir l'autre. Nouvelles conditions sur toutes les stacks : test supprimé, dépendance ajoutée à un manifeste, fichier nouveau trop long, lignes ajoutées, glob de chemin, branche, message à l'agent. `require_approval` attend désormais une approbation à usage unique au lieu de refuser, et l'écran montre les couches lues, les demandes en attente, l'activité des règles et un essai à blanc des changements du dépôt. Une politique invalide refuse tout jusqu'à correction (#377).
- **Les garde-fous s'appliquent enfin dans les worktrees des tâches** (F185). Ils étaient cherchés dans le worktree, où `.workpilot/` n'existe pas, et les règles de chemin ne voyaient jamais les chemins absolus envoyés par le SDK Claude.
