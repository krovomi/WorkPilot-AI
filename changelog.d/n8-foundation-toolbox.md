---
section: 🛠️ Qualité
---

- **Le cycle d'imports des agents recule à 24 unités** (F131). Les logs, la redaction, la
  branche de base, les signaux de pause et le slug des logs par LLM passent de `core` à
  `foundation`, la couche qui n'importe rien du backend. Les chemins changent
  (`core.debug` devient `foundation.debug`, `core.log_redaction` devient
  `foundation.log_redaction`…), pas le comportement.
- **`agents/session.py` repasse sous son plafond de taille** : l'affichage d'un appel d'outil
  dans le fil d'activité et la vue streaming part dans `agents/tool_display.py` (2 591 → 2 482
  lignes).
