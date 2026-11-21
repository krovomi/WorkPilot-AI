---
section: 🧹 Maintenance
---

- **Ancien auto-réparateur retiré** : la CLI `python -m self_healing` (`check`, `heal`, `monitor`, `report`) et ses modules (moniteur, planificateur, moteur de refactoring, alertes, bilan de santé, dette technique, préréglages) ne sont plus livrés. Rien dans l'app ne les appelait : la vue Auto-guérison passe par l'Incident Responder. Ce moteur travaillait dans le checkout du projet au lieu d'un worktree, et il committait tout le dossier sans ouvrir de PR. Le README du paquet décrit maintenant l'Incident Responder.
