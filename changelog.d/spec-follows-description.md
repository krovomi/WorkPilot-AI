---
section: 🐛 Corrections
---

- **Une spec suit toujours la description de sa tâche.** Une spec n'était écrite qu'une fois, et « `spec.md` existe » valait « spec à jour » : une tâche dupliquée puis redécrite pouvait tourner sur la spec de l'originale. La spec enregistre maintenant la description dont elle provient (`spec_source.json`). Chaque lancement d'une tâche pas encore planifiée la régénère si la description a changé, quel que soit le chemin de la modification. Le QA reviewer et le QA fixer lisent aussi la demande de l'utilisateur : quand la spec la contredit, la demande l'emporte, et l'écart est signalé au lieu de supprimer le fichier demandé.
