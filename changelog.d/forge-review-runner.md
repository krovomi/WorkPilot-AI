---
section: 🐛 Corrections
---

- **La revue de merge request GitLab trouve son runner** : elle le cherchait dans le dossier `.workpilot` du projet, où il n'est pas, et s'arrêtait toujours sur « GitLab runners not found ». Les revues GitHub et GitLab cherchent maintenant leur runner au même endroit, dans le backend de l'application.
