---
section: 🛠️ Qualité
---

- **Le cycle d'imports des agents recule à 18 unités** (F131). Le registre des sous-agents
  devient une unité à lui (`apps/backend/subagents/`, ex-`agents/subagents/`) ; le générateur de
  tests passe dans `test_generation/generator.py` et appelle le modèle par le port
  `agent_runtime` ; `error_details` et la prévision du plan descendent dans `foundation`. Les
  chemins changent, pas le comportement.
