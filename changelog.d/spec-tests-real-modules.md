---
section: 🧪 Filets de test
---

- **Tests du pipeline spec isolés** : `test_spec_pipeline.py` et `test_spec_phases.py`
  remplaçaient une soixantaine de modules par des faux dans `sys.modules` au moment de
  l'import. Les fichiers collectés après eux recevaient ces faux, et
  `spec_creation/test_orchestrator_parts.py` échouait quand il tombait dans le même shard. Les
  deux fichiers testent maintenant les vrais modules.
