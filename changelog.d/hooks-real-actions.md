---
section: 🐛 Corrections
---

- **Hooks événementiels** : un hook n'offre plus que les actions qui font réellement quelque
  chose (journal, notification, commande, Slack, Teams, Discord, Google Chat, webhook). Les dix
  actions qui répondaient « exécutée » sans rien faire (lint, tests, génération de tests, agent,
  spec, pipeline, docs, PR, chaînage, personnalisée) sont retirées, avec les neuf modèles bâtis
  sur elles. Un hook déjà enregistré se charge sans ces actions, un nouveau hook qui en nomme une
  est refusé, et un hook dont une action a dépassé son délai est compté en échec.
