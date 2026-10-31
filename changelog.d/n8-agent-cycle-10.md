---
section: 🛠️ Qualité
---

- **Le cycle d'imports des agents tombe à 10 unités, l'objectif du plan** (F131). Les parseurs
  de journaux de CI (`foundation/ci_logs.py`), la traçabilité des exigences
  (`foundation/traceability.py`) et la pagination (`foundation/paging.py`) descendent dans
  `foundation` ; la phase `architecture-map` passe dans `workflows/architecture_map_phase.py` et
  ses prompts dans archify. Le cerveau, la mémoire, la boucle d'apprentissage, hermes, docintel,
  self_healing, uiux et archify sortent du cycle.
- **La boucle d'apprentissage dit ce qu'elle fait** : son analyse « avec IA » importait un
  module qui n'a jamais existé et retombait toujours sur l'heuristique. L'appel mort est retiré,
  le statut ne parle plus d'IA ; les motifs extraits sont les mêmes qu'avant.
