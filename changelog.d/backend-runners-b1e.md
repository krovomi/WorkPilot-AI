---
section: 🧪 Filets de test
---

- **Couverture backend, lot B1e (runners)** : quinze runners de plus passent à 100 %, lancés comme l'application les lance, sur de vrais dépôts git, de vrais projets et de vrais fichiers ; seuls les appels à un modèle sont remplacés par une doublure.
  - Git Surgeon (analyse, plan, application sur une nouvelle branche, branches fusionnées) et Injection Guard (prompts enregistrés dans tous les formats lus).
  - Dette technique, rayon d'impact, index du projet, aperçu de l'app, profilage des performances.
  - Formula Lab : matrice des formules, affinage par le modèle, prédiction de coût.
  - Débogueur d'agent, vérification (`/verify`), Bounty Board, best-of-N.
- **La prédiction de coût trouve de nouveau les specs** : elle ne cherchait que dans l'ancien dossier `.autonomousbuild/specs/` et répondait « Spec not found » pour toute spec de `.workpilot/specs/`. Elle lit les deux, et seulement un dossier de spec du projet.
- **Code mort retiré** : le runner du profilage des performances gardait un repli « module pas encore disponible » que rien ne pouvait atteindre, le module `performance` étant livré avec le backend.
- **Plancher de couverture backend relevé à 72 %** (72,7 % mesurés) : la CI refuse une PR qui ferait redescendre la suite en dessous.
