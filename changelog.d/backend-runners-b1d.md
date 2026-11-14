---
section: 🧪 Filets de test
---

- **Couverture backend, lot B1d (runners)** : six runners de plus passent à 100 %, lancés comme l'application les lance, sur de vrais dépôts git et de vrais dossiers.
  - Instantanés d'environnement : `env_snapshot_runner.py` (capture, liste, relecture, export Dockerfile, Nix et script ; les secrets n'atteignent jamais le fichier).
  - Prédiction de conflits : `conflict_predictor_runner.py` et son service (`services/conflict_predictor_service.py`), sur un dépôt dont les branches touchent les mêmes fichiers.
  - Context Mesh : `context_mesh_runner.py` (inscription des projets, résumé, recommandations, analyse).
  - Learning Loop : `learning_loop_runner.py` (verdicts gardés avec leur historique, versés au cerveau partagé, analyse sans modèle).
  - Swarm : `swarm_runner.py` (vagues de sous-tâches indépendantes, code de sortie selon l'issue).
  - Cerveau partagé : `brain_runner.py` (création, mémorisation, rappel, promotion, synchronisation, import des mémoires d'agents, ponts, MCP, surveillance).
- **La prédiction de conflits ne compte plus le projet lui-même comme une branche à fusionner** : la première ligne de `git worktree list` (le checkout du projet) apparaissait dans les branches actives et dans l'ordre de fusion conseillé. Une branche ouverte dans un autre worktree apparaissait aussi en double, sous le nom `+ branche`.
