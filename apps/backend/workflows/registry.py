"""Which workflow a card gets, from the kind of work it asks for.

`cli/build_commands.py` loaded `workflows/feature-build/workflow.yaml` by a
path written in the function, so every card — a one-line bug, a data purge, a
"why is this test flaky" — ran the feature pipeline. The kind of a card is
data since lot 0 (`tasks.classify`, written to `task_metadata.json`); this
module is the one table that turns it into a workflow file, for the build and
for the profile API, so the two cannot pick different pipelines for the same
card.

The table is closed and written here rather than derived from the directory
listing: a `workflows/<name>/` that no kind maps to is a file nobody runs,
and a kind the table does not name falls back to `feature-build` — the
pipeline that was always run, so an unknown kind changes nothing.
"""

from __future__ import annotations

import logging
from pathlib import Path

from .spec import Workflow, WorkflowError, load_workflow

logger = logging.getLogger(__name__)

__all__ = [
    "DEFAULT_WORKFLOW",
    "WORKFLOW_BY_KIND",
    "workflow_for",
    "workflow_name_for",
    "workflow_for_spec",
    "workflows_root",
    "load_workflow_for_spec",
]

DEFAULT_WORKFLOW = "feature-build"

# Task kind (`tasks.classify.TaskKind.value`) -> `workflows/<name>/`.
WORKFLOW_BY_KIND: dict[str, str] = {
    "feature": DEFAULT_WORKFLOW,
    "bug_fix": "bug-fix",
    "hotfix": "hotfix",
    "investigation": "investigation",
    "run": "run",
    "refactoring": "refactoring",
    "test": "test",
    "docs": "docs",
    "spike": "spike",
}


def workflows_root(repo_root: Path | None = None) -> Path:
    """The `workflows/` directory of this repository."""
    root = repo_root or Path(__file__).resolve().parents[3]
    return root / "workflows"


def workflow_name_for(kind: object) -> str:
    """The workflow directory name for a kind. Unknown or empty → the default.

    Accepts the enum (`TaskKind.BUG_FIX`), its value (``"bug_fix"``) or
    nothing: the three forms the kind reaches here in.
    """
    value = getattr(kind, "value", kind)
    if not isinstance(value, str) or not value:
        return DEFAULT_WORKFLOW
    return WORKFLOW_BY_KIND.get(value, DEFAULT_WORKFLOW)


def workflow_for(kind: object, repo_root: Path | None = None) -> Path:
    """The `workflow.yaml` a kind runs under."""
    return workflows_root(repo_root) / workflow_name_for(kind) / "workflow.yaml"


def workflow_for_spec(spec_dir: Path, repo_root: Path | None = None) -> Path:
    """The workflow for a spec, from the kind recorded in its metadata.

    A spec with no recorded kind — created before lot 0, or whose metadata is
    unreadable — gets the default, which is the pipeline it would have got
    before kinds existed.
    """
    try:
        from tasks.metadata import read_task_metadata

        kind = read_task_metadata(spec_dir).get("kind")
    except Exception as exc:  # noqa: BLE001 - metadata is advisory
        logger.debug("could not read the task kind of %s: %s", spec_dir, exc)
        kind = None
    return workflow_for(kind, repo_root)


def load_workflow_for_spec(spec_dir: Path, repo_root: Path | None = None) -> Workflow:
    """`workflow_for_spec`, loaded. Falls back to the default workflow when the
    kind's file is missing or malformed: a broken specialised workflow must
    not stop a build the default pipeline can run — and the fallback is
    logged, not silent."""
    path = workflow_for_spec(spec_dir, repo_root)
    try:
        return load_workflow(path)
    except WorkflowError as exc:
        default = workflows_root(repo_root) / DEFAULT_WORKFLOW / "workflow.yaml"
        if path == default:
            raise
        logger.warning("workflow %s unusable (%s); running %s", path, exc, default)
        return load_workflow(default)
