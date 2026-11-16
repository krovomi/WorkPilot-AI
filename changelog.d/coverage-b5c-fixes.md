---
section: 🐛 Corrections
---

- **Message de commit proposé après un merge** : sans réponse du modèle, il reprend le nom de la
  spec au lieu d'un titre vide, et une réponse entourée d'un bloc de code n'en garde que le texte.
- **Revue d'architecture** : un rapport d'une ronde QA précédente n'est plus relu comme le
  nouveau, et une violation de gravité inconnue reste listée comme avertissement.
- **Aperçu du Kanban** : un projet sans script de lancement habituel n'essaie plus de lancer un
  script de build ou de déploiement.
- **Index du projet** : un service Python d'un monorepo (`pyproject.toml` sans `package.json`)
  déclenche bien le rafraîchissement de l'index, comme les fichiers de dépendances Java, Gradle,
  Dart, Swift et Elixir.
- **Prompts du planner et de la QA** : le planner ne cherche plus le projet à côté d'un dossier
  `auto-claude/`, un plan à la forme inattendue ne casse plus la reprise d'un build, et les
  outils de validation du projet sont injectés même si le prompt de QA a été retouché.
- **Carte d'architecture** : les imports relatifs Python (`from ..models import X`) et JS/TS
  (`../lib/api`, `./ui` vers `ui/index.tsx`) relient enfin les bons modules, et un projet rangé
  sous un dossier `build/` ou `out/` est lu.
