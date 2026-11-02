---
section: 🐛 Corrections
---

- **Modifier la description d'une tâche pas encore lancée (une tâche dupliquée par exemple) régénère sa spec.** Seule la section « Overview » du `spec.md` était réécrite : une copie de « Créer toto.txt » renommée en « tata.txt » gardait une spec qui demandait `toto.txt`, et le QA supprimait le `tata.txt` créé par l'agent. La spec et ce qui en dérive (`context.json`, indices du Brain, évaluation de complexité) sont maintenant retirés et réécrits au lancement à partir de la nouvelle description. La mémoire du projet injectée aux agents précise aussi qu'elle parle d'autres tâches et ne remplace jamais un nom de fichier de la tâche en cours.
