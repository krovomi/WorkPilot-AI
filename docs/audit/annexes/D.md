# Annexe D — Ce qui a changé le 16 octobre 2026 (PR #457 à #462, puis le lot 3)

| PR | Changement | Effet sur les constats |
|---|---|---|
| #457 | Atlas : vue « Pour tous » (00) et feuille de route par type de carte (09) ; READMEs pointant vers l'atlas | aucun |
| #458 | Le mock `_bmad/scripts/resolve_customization.py` porte le marqueur `workpilot-mock` et **échoue** (code 2) ; `is_mock_runtime`, `check_requires(..., accept_mock=False)` ; la palette masque les commandes BMAD de ce dépôt ; `skills:bootstrap` ne compte pas un mock comme installé ; le job CI `skills` vérifie que le mock échoue toujours | **F50 corrigé** |
| #459 | `tests/harness/test_delegation_end_to_end.py` : le vrai `OpenAIAgentClient` contre un serveur OpenAI-compatible local scripté — outil `delegate` proposé, enfant à rôle et outils restreints, commande réellement exécutée, conclusion bornée, appels comptés sur le registre du parent | F49 : la preuve est sur le fil, plus seulement sur des doubles |
| #460 | Lot 0 : `tasks/classify.py` (type décidé sans modèle : choix utilisateur → catégorie → type d'item importé → mots du titre → `feature`), `tasks/metadata.py` (écrit dans `task_metadata.json`, jamais par-dessus un choix humain), badge et sélecteur dans l'UI (i18n en + fr) | F51 : lot 0 livré |
| #461 | Lot 1 : `workflows/registry.py` (type → `workflows/<nom>/workflow.yaml`, défaut `feature-build`), huit workflows, cinq procédures `tooling/` (`reproduce`, `investigate`, `runbook`, `proofread`, `spike-verdict`), `fallback:` substitué et affiché, `irreversible:` parsé, un workflow sans `planning`/`coding` ne lance pas le coder, fenêtres sur bornes absentes, gate `tests-unchanged`, lentilles de revue à `low`/`none` = correction + sécurité | F51 : lot 1 livré ; `cli/build_commands.py:162` (chemin en dur) n'existe plus |
| #462 | Lot 2 : `brainstorm` = `bmad/bmad-brainstorming` → `tooling/brainstorm-approaches`, `prd` (`bmad/bmad-prd` → `workpilot/spec`, `ultrathink`, `when: kind == feature and complexity == complex`), spike sur `bmad/bmad-deep-recon` ; `when:` lit la tâche (`workflows/task_facts.py`) ; « installé » jugé dans le projet cible (`ProjectCheck`), mock refusé à la résolution et à l'exécution ; `handoff.py` lit le workflow du type (le rapport `reproduce` d'un bug atteint son planner) ; prompt de phase avec `PROCEDURE SOURCE` et consigne non interactive | F51 : lot 2 livré ; F50 : fermé aussi côté moteur et runner |

| lot 3 | `irreversible: true` → `workflows/runner.py::irreversible_gate` (marqueur `workflow/<phase>.pause.json`, drapeau dans `core/pause_state.py`, étapes imprimées, `BuildPaused` ; reprise explicite consomme le marqueur) ; `workflows/runbook.py` (la procédure lue telle que le skill l'écrit, refus de ce qu'il faudrait interpréter), `workflows/execute.py` (exécuteur déterministe : `command_refusal` sur chaque commande, journal `run.md` expurgé par `redact_text`, état `run-state.json`, procédure figée), `workflows/environments.py` (`.workpilot/environments.toml` : santé, variables nommées jamais valuées) ; agent `operator` (Read, Glob, Grep, Bash, sans Write/Edit) ; `isCooperativelyPaused` lit `pause_state.json` sur disque | F51 : lot 3 livré ; S1 (secrets hors du journal), S3 (porte infranchissable par l'agent), S4 (allowlist sur chaque étape) tenues, prouvées par `tests/test_workflows_run_execute.py` |

Statut après ces PR : **F50 résolu** ; **F51 partiel** (lots 0 à 3 livrés ; restent rosters et prompts par
type — lot 4 —, origine → type — lot 5 —, mesure — lot 6) ; **F49 fait**, prouvé de bout en bout. Deux écarts assumés par rapport au
plan de #455 : `investigation` garde `tooling/investigate` (BMAD `deep-recon` est une recherche web,
pas une enquête dans un code) ; le workflow `retro` n'est pas écrit tant que rien ne peut le lancer.

Vérification de cette annexe : `pytest tests/test_workflows_by_kind.py tests/test_workflows_bmad_on_demand.py
tests/test_workflows_run_execute.py tests/test_workflow_engine.py tests/test_workflow_runner.py
tests/test_workflow_handoff.py -q` ;
`python scripts/skills_cli.py build --check` ; l'atlas (vue 04) simule chaque type de carte avec ou
sans BMAD installé.

---

[Cahier de nettoyage](../AUDIT-NETTOYAGE.md)
