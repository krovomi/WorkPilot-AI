---
section: 🐛 Corrections
---

- **Jira, Azure DevOps et les réglages de fournisseurs fonctionnent dans l'app installée.** Les connecteurs Python partagés (`src/connectors`) n'étaient pas embarqués : ces vues échouaient à l'import dans les versions installées, alors qu'elles marchaient depuis les sources. Ils sont désormais livrés dans le backend de l'app, et le desktop les y cherche.
