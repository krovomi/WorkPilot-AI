---
section: 🧪 Filets de test
---

- **Couverture backend, lot B4e (migration de code)** : l'analyse du projet et le plan que lit la page Migration de code passent à 100 %, testés sur de vrais projets. Les transformateurs de code, le transformateur assisté par modèle, le retour arrière, le validateur, le rapport et la ligne de commande `python -m migration`, qu'aucune partie de l'application n'appelait, sont supprimés (environ 6 000 lignes), avec le type d'agent `migration` qui ne servait qu'à eux.
- **Migration de code, analyse du projet** :
  - un projet Python qui ne déclare ses dépendances que dans `pyproject.toml` (uv, Poetry, PDM) est reconnu comme Django, Flask ou FastAPI. Il sortait en « python » générique et aucune migration ne lui était proposée ;
  - `node_modules`, les environnements virtuels, les dossiers de build et les worktrees de `.workpilot/` ne sont plus parcourus. Un projet Python avec une chaîne d'outils front sortait en JavaScript, et l'analyse d'un gros projet prenait plusieurs minutes ;
  - un fichier `.sql` qui n'est pas en UTF-8 n'arrête plus l'analyse, qui faisait afficher la migration comme non prise en charge ;
  - un `tsconfig.json` vide (`{}`) et un Angular installé (`node_modules/@angular/core`) sont reconnus.
