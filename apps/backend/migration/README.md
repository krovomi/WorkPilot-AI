# Code Migration

What the **Code Migration** page reads through `runners/code_migration_runner.py`:

- `analyzer.py`: `StackAnalyzer.detect_stack()`, the project's framework, language,
  version, database, dependencies, tools and package manager, read from its files
  (dependencies, virtualenvs, build output and `.workpilot/` are never walked).
- `planner.py`: `MigrationPlanner.create_plan()`, a rule-based plan (phases, steps,
  effort, risk) for a pair listed in `config.py` (`SUPPORTED_MIGRATIONS`).
- `orchestrator.py`: `MigrationOrchestrator.start_migration()` ties the two, refuses a pair
  the planner does not know (`ValueError`, shown as "unsupported" by the page) and saves the
  plan to `.workpilot/migration/<id>.json`.

The migration itself is a Kanban task created from the same description (spec, planner,
coder, QA in a worktree), for every stack.

The rule-based code transformers, the model-enhanced transformer, the rollback manager, the
validator, the report and the `python -m migration` CLI that used to live here were never
called by the app and were removed in lot B4e of the coverage plan. Tests: `tests/migration/`
and `tests/test_code_migration_runner_cli.py`.
