---
section: 🧪 Filets de test
---

- **Un parcours de bout en bout à travers plusieurs features** (#380) : une nouvelle suite E2E
  (`apps/frontend/e2e/journeys/`, lancée avec les autres par le job `e2e`) suit un utilisateur dans
  l'app construite. Premier parcours : la PR d'une tâche d'agent démarre le pipeline Jenkins configuré
  dans CI/CD Triggers, le build rouge devient un incident Self-Healing sur le commit de l'agent, puis
  la personne l'écarte. Le modèle, la forge et la CI sont simulés en local : aucun réseau, aucun
  modèle, et l'app testée démarre sans les identifiants du shell qui lance les tests.
