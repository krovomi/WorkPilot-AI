---
extends: verify
provider: copilot
---
GitHub Copilot : les outils `verify_*` sont exécutés par WorkPilot comme pour
les autres fournisseurs sans MCP. Les sous-agents existent mais **ne
naviguent pas** : la confirmation de l'état est faite par la session
principale, qui seule voit les instantanés de la page.

## Fix & retry
<!-- append -->
Copilot tend à corriger plusieurs fichiers d'un coup : relancer
(`verify_launch`) après **chaque** fichier modifié, pour savoir quelle
modification a fait disparaître — ou apparaître — l'erreur.
