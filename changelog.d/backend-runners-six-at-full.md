---
section: 🧪 Filets de test
---

- **Couverture backend, lot B1c (runners)** : six runners passent à 100 %, chacun testé comme l'application le lance (sous-processus) sur de vrais fichiers, dépôts git ou serveurs HTTP locaux.
  - Auto-réparation : `self_healing_runner.py` (configuration, incidents, CI/CD, production, proactif, tableau de bord).
  - Release train : `release_coordinator_runner.py` (plan, notes, démarrage, reprise, abandon, historique).
  - Notebooks : `notebook_agent_runner.py` (analyse, extraction d'une cellule longue, nettoyage, exécution, chiffres mensuels).
  - Bac à sable : `sandbox_runner.py` (fichiers ajoutés, supprimés, renommés et modifiés, avec leurs hunks).
  - Déclencheurs CI/CD : `cicd_triggers_runner.py` (GitLab et Jenkins contre un serveur local, GitHub Actions et Azure DevOps).
  - Agent navigateur : `browser_agent_runner.py` (références visuelles, comparaison, tableau de bord, échec propre sans Chromium).
  - Le backend passe de 69,9 % à 70,6 % de couverture, et son plancher de 69 % à 70 %.
- **Déclencheurs CI/CD** :
  - le statut et l'annulation d'un run GitHub acceptent l'alias `github_actions`, comme le déclenchement : ils lisaient `CICD_GITHUB_ACTIONS_TOKEN` au lieu de `CICD_GITHUB_TOKEN` ;
  - Jenkins reçoit la branche et l'URL de la PR encodées : un `&` dans l'une d'elles coupait les paramètres du build.
