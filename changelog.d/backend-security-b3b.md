---
section: 🧪 Filets de test
---

- **Couverture backend, lot B3b (sécurité)** : le scanner de vulnérabilités, les rapports (JSON, Markdown, HTML, SARIF), l'orchestrateur et sa commande, le scan de sécurité de la QA, l'analyse de conformité et les validateurs de commandes ont leurs tests de comportement. Les outils externes (bandit, semgrep, pip-audit, npm audit, snyk, trivy) répondent avec la sortie JSON qu'ils impriment vraiment ; le scan de secrets et les commits tournent dans un vrai dépôt git.
- **Scan de sécurité de la QA** : il ne voyait aucun fichier d'une tâche, parce que son worktree vit sous `.workpilot/`, un dossier qu'il écarte ; seuls les dossiers *dans* le projet sont désormais écartés, et les fichiers `.env` / `.env.local` sont lus.
- **Scanner de vulnérabilités** : le scan de secrets listait les fichiers du dépôt courant au lieu de ceux du projet ; pip-audit auditait l'environnement de WorkPilot au lieu des dépendances du projet, et sa sortie réelle faisait échouer la lecture ; npm audit (format npm 7+) et une erreur d'analyse ESLint faisaient échouer leur scan. L'identifiant d'un secret trouvé est stable d'un scan à l'autre.
- **Rapport HTML de sécurité** : le texte d'un résultat, qui vient du code scanné, s'affiche comme du texte.
- **Commande `python -m security.security_orchestrator`** : un commit n'est plus bloqué par un secret dans un fichier qu'il ne touche pas, la politique compte enfin les secrets, et `block_on_compliance_critical` est respecté.
- **Validateurs de commandes d'agent** : plusieurs validateurs (git, bases de données, archives, processus, suppression de fichiers) lisent désormais chaque forme d'écriture de leurs options et le dépôt que vise la commande ; chaque refus a son test.
- **Code mort retiré** : `security/auto_integration.py`, `git_hooks.py`, `verify_security_feature.py` et `FEATURE_STATUS.json` (aucun appelant ; le dépôt utilise `.husky/`), la moitié inutilisée de `content_sanitizer.py` (validateur de sortie, fonctions de commodité), `validate_tool_input` et `check_tool_available` (aucun appelant), la liste de motifs `rm` que la règle des chemins relatifs couvrait déjà.
