---
section: 🐛 Corrections
---

- **Contexte cognitif sous Windows** : les fichiers choisis pour une tâche sont nommés `src/a.cs`
  sur tous les systèmes, et non plus `src\a.cs` sous Windows, dans le contexte donné au codeur
  comme dans la vue.
- **API Watcher** : un fichier donné à la place du dossier du projet est signalé par le même
  message sur tous les systèmes (« Not a directory »).
