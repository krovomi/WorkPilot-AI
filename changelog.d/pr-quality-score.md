---
section: 🐛 Corrections
---

- **Le score de qualité d'une PR GitHub s'affiche enfin.** La vue PR lançait un script introuvable dans l'app installée, avec une commande qui ne produisait rien, dans un dossier qui était en fait l'identifiant du projet : le score n'arrivait jamais. Un runner du backend note désormais les fichiers modifiés de la PR (syntaxe, secrets en dur, appels dangereux, complexité) dans le dossier du projet, sans appel de modèle ni identifiant transmis, et ignore tout fichier hors du projet.
