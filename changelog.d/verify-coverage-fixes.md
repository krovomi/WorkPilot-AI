---
section: 🐛 Corrections
---

- **La vérification de l'app après une tâche ne se trompe plus de verdict** : le rejeu après la QA voit désormais un changement hors de git ou dans un fichier non suivi, le vérificateur reçoit de nouveau les règles du projet, une erreur de console d'une page déjà corrigée ne la fait plus échouer (moteur Playwright), et les problèmes de la fenêtre Windows restent dans le rapport quand aucun navigateur n'est disponible.
