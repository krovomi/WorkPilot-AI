---
section: 🐛 Corrections
---

- **Cerveau partagé sur un dossier en lecture seule** : quand le fichier `.gitignore` du
  vault ne peut pas être écrit, le cerveau s'ouvre et se synchronise quand même, au lieu
  d'échouer avant chaque synchronisation.
