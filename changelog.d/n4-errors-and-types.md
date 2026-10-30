---
section: 🛠️ Qualité
---

- **Les erreurs avalées et les `biome-ignore` ne peuvent plus que diminuer** (F127). Chaque
  fichier garde un plafond d'`except Exception` et de `biome-ignore` ; une PR qui en ajoute est
  refusée, une PR qui en retire fait baisser le plafond (`python scripts/quality_baselines.py update`).
- **Les types Python sont vérifiés en CI** (F127). pyright `1.1.408` tourne sur sept paquets du
  backend (`bench`, `best_of_n`, `genai_trace`, `goal`, `mcp_tasks`, `os_sandbox`, `security`),
  remis à zéro erreur ; la liste s'élargit paquet par paquet.
