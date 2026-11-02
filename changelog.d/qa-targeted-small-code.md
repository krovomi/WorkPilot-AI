---
section: ✨ Nouveautés
---

- **Une petite modification de code ne paie plus la QA complète** (K2). Quand une tâche change
  au plus 3 fichiers de code Python ou TypeScript et 150 lignes, et que chacun a un test par
  convention (`test_x.py`, `x.test.ts`…), la QA passe en « QA ciblée » : seuls ces tests sont
  lancés, avec la couverture des fichiers touchés, sans sous-agent, pour tous les providers.
  L'approbation n'est retenue que si chaque test a bien été lancé et est passé. Un fichier sans
  test, un fichier généré ou supprimé, un chemin de sécurité, la CI ou un manifeste de
  dépendances renvoient à la QA complète. Le journal et `qa_report.md` disent quel palier a
  tourné ; `WORKPILOT_QA_TARGETED=0` le désactive.
