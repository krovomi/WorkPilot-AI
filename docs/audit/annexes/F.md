# Annexe F — Audit du 17 octobre 2026 (`473bbf1`)

Audit de `develop` après les lots L1 à L17 ; tout ce qu'il relève est nouveau ou une régression
prouvée. Il ordonne dix lots, un lot = une PR vers `develop`. Les constats de sécurité ne sont
détaillés ici qu'une fois corrigés ([`SECURITY.md`](../../SECURITY.md)).

| Lot | Thème | Statut |
|---|---|---|
| M1 | Aucune commande construite depuis le renderer ou un texte externe ; app Windows sans élévation | **fait** (F52 à F56) |
| M2 | Une CI qui garde : filtres `paths:`, version de Biome, Python 3.12, lockfile Python, image serveur construite et migrée | **fait** (F57 à F62) |
| M3 | Des features qui ne disent que ce qu'elles font (PR Azure DevOps factice, triage `continuous_ai`, verdict QA .NET, workflows de release jamais déclenchés, Skills Sync, Sentry) | **fait** (F63 à F68) |
| M4 | Mode hors-ligne strict et mode serveur | **fait** (F69 à F71) |
| M5 | Secrets et environnement des processus enfants | **fait** (F78 à F84 : journaux et processus enfants, aucun identifiant stocké dans le renderer, environnement construit pour les runners Python des vues et de forge) |
| M6 | Frontière renderer → main, avec tests de refus | **fait** (F85 à F90, expéditeur vérifié sur chaque canal, chemins d'outils et dossier du backend des réglages contrôlés) |
| M7 | Contrats d'architecture (`import-linter`, canaux IPC, Sidebar ↔ `product-overview.md`) | **fait** (F91 à F94 ; contrats d'imports en test AST, sans `import-linter`) |
| M8 | Code mort, `scripts/`, vues sans test | **fait** (F95 à F100 ; vues sans conception ni test marquées « Expérimental » ; `node-pty` retiré ensuite, F75) |
| M9 | Doc ↔ code, i18n de la palette, jsdom, dépendances | **fait** (F72 à F77) |
| M10 | Casser le cycle `core ⇄ agents`, découper les fonctions géantes | **fait** (F101, F102 : cycle de 81 à 26 unités, plafonné ; F103 à F106 : les quatre fonctions géantes découpées ; reste le cycle du moteur d'agents, qui demande une interface) |
| M11 (26 octobre) | L'effort que le modèle reçoit vraiment, sur chaque provider | **fait** (F107 à F112 : effort envoyé à Grok, DeepSeek, Mistral et Ollama, échelle OpenAI complète, effort refusé relancé sans lui, fil et sélecteur qui disent ce qui est envoyé) |

Vérification du lot M1 : `cd apps/frontend && pnpm run typecheck && pnpm test -- release-handlers
no-renderer-command worktree-open-launchers pr-details-azure-script`.

Vérification du lot M2 : `pytest tests/test_ci_triggers.py tests/test_tool_pins.py
tests/backend/test_alembic_migrations.py` ; `docker build -f deploy/Dockerfile.server .` ; le job
`server-image` de `ci.yml`.

Vérification du lot M4 : `pytest tests/test_libdocs.py tests/backend/test_feature_router_authz.py
tests/backend/test_server_mode_fail_closed.py -q`.

Vérification du lot M5 : `pytest tests/test_entrypoints_redaction.py tests/core/test_log_redaction.py -q`
et `cd apps/frontend && pnpm test -- child-env dev-env-files`.

Vérification du lot M6 : `cd apps/frontend && pnpm test -- renderer-path ipc-path-policy
renderer-path-refusals no-renderer-interpreter python-feature-services`.

Vérification du lot M7 : `pytest tests/test_import_contracts.py tests/test_product_overview_views.py -q`
et `cd apps/frontend && pnpm test -- ipc-channel-parity useIpc-task-updated context-mesh-events`.

Vérification du lot M8 : `pytest tests/test_product_overview_views.py tests/test_scripts_readme.py
tests/test_import_contracts.py -q` et `cd apps/frontend && pnpm test -- ipc-channel-parity
live-companion-events AuthFailureModal use-sidebar-prefs`.

Vérification du lot M9 : `pytest tests/test_docs_context.py tests/test_python_floor.py
tests/test_test_generation_post_build_scope.py -q` et `cd apps/frontend && pnpm test`.

Vérification du lot M10 (cycle) : `pytest tests/test_import_contracts.py
tests/cost_intelligence/test_formula_refine.py tests/test_offline_mode.py tests/test_platform.py -q`.

Vérification du lot M10 (coder) : `pytest tests/agents/ tests/test_pipeline_phase_recovery.py -q`.

Vérification du lot M10 (boucle QA) : `pytest tests/test_qa_loop_characterization.py
tests/test_qa_loop_gate_rejection.py tests/test_qa_loop.py tests/test_qa_loop_enhancements.py
tests/test_qa_loop_fix_request.py tests/test_qa_dotnet_tests.py -q`.

Vérification du lot M10 (`create_client`) : `pytest tests/core/test_create_client_characterization.py
tests/test_client.py tests/test_sdk_options_factories.py tests/test_agent_tool_rights.py
tests/harness/test_subagent_results.py tests/harness/test_code_search_serving.py -q`.

Vérification du lot M10 (`_build_agent_client`) : `pytest
tests/core/test_build_agent_client_characterization.py tests/test_agent_client_factory.py
tests/test_offline_mode.py tests/test_local_model_coercion.py -q`.

Vérification du lot M11 : `pytest tests/core/test_effort_plan.py tests/core/test_llm_optimization.py
tests/core/test_openai_loop.py tests/core/test_copilot_loop.py
tests/core/test_build_agent_client_characterization.py -q` et `cd apps/frontend && pnpm test --
useEffortPlan translateLogMessage`.

---

[Cahier de nettoyage](../AUDIT-NETTOYAGE.md)
