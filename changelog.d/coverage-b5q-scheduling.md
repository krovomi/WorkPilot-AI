---
section: 🧹 Maintenance
---

- **Backend** : quatre modules de planification que plus rien n'appelait sont retirés, avec leurs
  tests : le routeur « intelligent », le gestionnaire de modèles locaux, l'auto-détection et les
  modèles de tâches (environ 3 600 lignes). Le routage des modèles passe par `model_router/`, les
  modèles locaux par le catalogue des providers et la détection d'Ollama.
