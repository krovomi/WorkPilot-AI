---
section: 🧪 Filets de test
---

- **Les handlers IPC d'exécution des tâches sont testés sur de vrais dossiers de spec et de vrais dépôts git** (lot F1b de la couverture à 100 %) : démarrage, arrêt et reprise de session, statut manuel et création de PR, récupération d'une tâche bloquée, revue humaine (dont une fusion préparée annulée sans toucher aux modifications de la personne), reprise sur un autre moteur, relance d'une phase, changement à chaud, création, duplication, modification et suppression de tâches, fichiers de plan, gestion du contexte, journaux et découpage d'une tâche en parties. Le code jamais atteignable trouvé en chemin est retiré.
