---
section: 🧹 Maintenance
---

- **Les artefacts de la CI ne remplissent plus le quota de stockage GitHub.** Chaque upload garde
  ses fichiers 3 jours au plus (1 jour pour les builds de release, déjà publiés sur la page de la
  release), et `artifact-cleanup.yml` supprime chaque nuit ce qui est plus ancien ; un lancement
  manuel avec `max-age-hours: 0` vide tout. `tests/test_artifact_retention.py` garde la limite.
