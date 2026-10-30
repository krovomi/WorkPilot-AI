# Annexe C — Ce qui a changé le 15 octobre 2026 (`7ef6fca` → `e3e468f` + PR #454)

| PR | Changement | Effet sur les constats |
|---|---|---|
| #454 | Le roster de sous-agents atteint le modèle sur tout provider de la boucle WorkPilot (états `native` / `emulated` / `none`, outil `delegate`, session enfant à outils restreints, vague parallèle, Codex CLI lu depuis le mode d'auth) | **F49** nouveau, résolu par la PR elle-même ; F18 : la matrice dit maintenant ce que chaque provider fait des sous-agents |
| #455 | Plan par lots pour spécialiser le traitement par type de carte (`docs/architecture/kanban-task-types.md`) | **F51** nouveau, partiel (plan accepté, rien livré) ; **F50** nouveau (mock `_bmad/` qui réussit), décision à prendre au lot 2 |
| #456 | README racine, backend, agents, skills réalignés sur le code | aucun |

Les trois constats sont décrits dans l'atlas (`WorkPilot-architecture.html`, vue 06) ; la feuille de
route est la vue 09, lisible sans prérequis technique comme la vue 00.

---

[Cahier de nettoyage](../AUDIT-NETTOYAGE.md)
