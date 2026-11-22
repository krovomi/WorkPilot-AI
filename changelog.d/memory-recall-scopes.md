---
section: ✨ Nouveautés
---

- **Une mémoire portée sur une branche ou une équipe n'est rappelée que là où elle s'applique** (#352). Une note `branch:release/2.0` n'est servie qu'aux agents d'une tâche de cette branche (ou d'une branche en dessous, comme `branch:release` pour `release/2.0`), jamais quand la branche ne se lit pas ; en mode serveur, une note `team:paiements` ne l'est qu'aux runs lancés par un membre du groupe « paiements ». En local, les notes d'équipe restent servies à tous, et les notes sans portée ne changent pas. L'onglet Mémoires, le Cycle de vie et l'historique montrent toujours chaque note avec sa portée.
