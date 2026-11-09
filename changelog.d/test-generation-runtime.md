---
section: 🐛 Corrections
---

- **Le studio de génération de tests fonctionne à nouveau** (F179). Les onglets Unitaire,
  Analyser, E2E et TDD échouaient sur « No agent runtime is installed », quels que soient le
  provider et la stack, et un scénario E2E d’un projet C#, Java ou Go ne s’écrit plus en `.js`.
