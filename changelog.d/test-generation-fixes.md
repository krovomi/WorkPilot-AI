---
section: 🐛 Corrections
---

- **Génération de tests : les bonnes réponses pour chaque stack** (F161) : le résultat d'une analyse de couverture s'affiche enfin, la cible de couverture est transmise au modèle, le framework est lu dans les manifestes du langage du fichier (un projet C# avec un `package.json` n'obtient plus Vitest), l'E2E et le TDD ne retombent plus sur TypeScript ou Python et écrivent des chemins dans l'extension du langage.
