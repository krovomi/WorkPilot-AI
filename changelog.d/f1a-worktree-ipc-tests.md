---
section: 🧪 Filets de test
---

- **Les handlers IPC des worktrees de tâche sont testés sur de vrais dépôts git** (lot F1a de la couverture à 100 %) : fusion et aperçu, statut, abandon, liste et orphelins, synchronisation depuis une branche (fusion, rebase, conflit annulé), création de PR, diff du worktree et d'un fichier, lecture, écriture et abandon de fichiers, preuve visuelle, détection et ouverture des IDE et terminaux sur macOS, Windows et Linux. Le backend y est remplacé par un script qui fait à git ce que fait le vrai. Le code jamais atteignable trouvé en chemin est retiré.
