"""
Migration Orchestrator: the analysis and the plan the Code Migration page asks for.

The page (`runners/code_migration_runner.py`) analyses the project and plans
the migration; the change itself is made by a Kanban task (spec, planner,
coder, QA in a worktree). The rule-based transformers, the rollback manager,
the validator, the report and the `python -m migration` CLI that once lived
here were never called by the app and were removed (lot B4e).
"""

import json
import uuid
from pathlib import Path

from .analyzer import StackAnalyzer
from .config import SUPPORTED_MIGRATIONS
from .models import MigrationContext, MigrationState, StackInfo
from .planner import MigrationPlanner


class MigrationOrchestrator:
    """Detects the source stack and plans a migration to a target."""

    def __init__(self, project_dir: str):
        self.project_dir = Path(project_dir)
        self.state_dir = self.project_dir / ".workpilot" / "migration"
        self.context: MigrationContext | None = None

    def start_migration(
        self, target_framework: str, target_language: str
    ) -> MigrationContext:
        """Analyse the project, plan the migration and save the plan.

        Raises ValueError for a pair the rule-based planner does not know: the
        runner reports it as "unsupported", and the Kanban task still migrates
        it with the agents' own plan.
        """
        source_stack = StackAnalyzer(str(self.project_dir)).detect_stack()
        target_stack = StackInfo(
            framework=target_framework,
            language=target_language,
            version="latest",
        )

        if (source_stack.framework, target_stack.framework) not in (
            SUPPORTED_MIGRATIONS
        ):
            raise ValueError(
                f"Migration from {source_stack.framework} to {target_stack.framework} "
                "is not supported"
            )

        self.context = MigrationContext(
            migration_id=str(uuid.uuid4()),
            source_stack=source_stack,
            target_stack=target_stack,
            project_dir=str(self.project_dir),
            state=MigrationState.PLANNING,
            plan=MigrationPlanner(source_stack, target_stack).create_plan(),
        )
        self._save_context(self.context)
        return self.context

    def _save_context(self, context: MigrationContext) -> None:
        """Write the plan to `.workpilot/migration/<id>.json`."""
        self.state_dir.mkdir(parents=True, exist_ok=True)
        state_file = self.state_dir / f"{context.migration_id}.json"
        state_file.write_text(json.dumps(context.to_dict(), indent=2), encoding="utf-8")
