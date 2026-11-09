---
section: 🐛 Corrections
---

- **Premier lancement et ajout d'un projet sans impasse** (F173). L'assistant n'affiche plus
  « steps.claudeCode » ni un compte Claude « Authentifié » sans connexion, passe à l'étape suivante
  après la création d'un profil clé d'API, « Passer » saute l'étape au lieu de fermer l'assistant, et
  « Ouvrir le créateur de tâches » ouvre l'ajout de projet quand il n'y en a pas encore ;
  l'indicateur d'usage ne reste plus sur « Loading... » au premier lancement. Sur une
  machine où git ne connaît ni nom ni e-mail, « Initialiser Git » les demande au lieu d'échouer.
  Créer un projet ne demande plus de recliquer sur « Passer pour l'instant », et un projet à
  initialiser prépare git dans ses réglages sans fenêtre qui les ferme.
