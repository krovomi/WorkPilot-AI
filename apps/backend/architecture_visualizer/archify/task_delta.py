"""One task's architecture delta: from the files it changed to the record the
Kanban reads.

Two callers, one path. The `architecture-map` workflow phase runs it after QA,
and the runner's `--action delta` runs it behind the Delta tab's regenerate
button. It used to live only in the runner, so the phase — which had no way to
reach it — fell into the generic skill path: a one-shot session that wrote
prose, never asked `significance.assess`, never ran archify, and never wrote
`delta.status.json`. The tab stayed empty on every build.

The order is the point, and it is the same in both callers: no baseline is a
record, an inert change is a record, and only then is a session opened. A
phase that pays for a model to say "nothing changed" is a phase people learn to
ignore.

Three directories, because an isolated build has three answers to "where":

``project_dir``           the code the head model describes — the worktree.
``baseline_project_dir``  where the baseline lives. `.workpilot/` is gitignored,
                          so a worktree never has one; it is under the main
                          project.
``record_dir``            where the answer is written. The Kanban reads the
                          *main* spec directory, and the record names its
                          artifact by absolute path — written in the worktree's
                          copy, that path dies with the worktree at merge,
                          which is exactly when "what did this task change" is
                          asked.

The head model itself stays in ``spec_dir``: it is written by the authoring
session's own `Write`, and a session may write only under the project and the
spec directory it was given.
"""

from __future__ import annotations

import logging
from pathlib import Path

from . import authoring
from . import delta as delta_module
from . import ir as ir_module
from .cli import ArchifyUnavailable
from .significance import assess

logger = logging.getLogger(__name__)

#: Under `<project>/.workpilot/architecture/`.
BASELINE_SPEC = "baseline.arch.json"
BASELINE_HTML = "baseline.html"

#: The head model's own render. A by-product — what the card shows is the
#: comparison — but rendering it is what proves the model is sound before it is
#: compared against anything.
HEAD_HTML = "head.html"

_NO_BASELINE = (
    "this project has no architecture model yet — generate one from the "
    "Architecture page to compare against"
)


def baseline_dir(project_dir: Path) -> Path:
    """Where a project keeps its baseline model and its render."""
    return project_dir / ".workpilot" / "architecture"


async def run_task_delta(
    project_dir: Path,
    spec_dir: Path,
    *,
    session: authoring.SessionFn,
    baseline_project_dir: Path | None = None,
    changed_files: list[str] | None = None,
    task_summary: str = "",
    force: bool = False,
    progress: authoring.ProgressFn | None = None,
    record_dir: Path | None = None,
) -> delta_module.DeltaStatus:
    """Map one task against the baseline and record the answer.

    Always returns a `DeltaStatus` that is already on disk under
    ``record_dir`` (``spec_dir`` when not given). ``force`` skips the
    significance pass — a person pressed the button. An unexpected error is
    raised to the caller, which owns the decision of what it means.
    """
    record = record_dir or spec_dir

    def say(message: str) -> None:
        if progress:
            progress(message)

    baseline_path = baseline_dir(baseline_project_dir or project_dir) / BASELINE_SPEC
    if not baseline_path.is_file():
        return delta_module.write_status(
            record,
            delta_module.DeltaStatus(
                status=delta_module.STATUS_NO_BASELINE, reason=_NO_BASELINE
            ),
        )

    if not force:
        significance = assess(changed_files, baseline_path)
        if not significance.significant:
            say(f"No architectural change: {significance.reason}")
            return delta_module.write_status(
                record,
                delta_module.DeltaStatus(
                    status=delta_module.STATUS_NOT_SIGNIFICANT,
                    reason=significance.reason,
                ),
            )
        say(f"Mapping this task: {significance.reason}")

    try:
        baseline = ir_module.load(baseline_path)
    except ir_module.IRError as exc:
        # Recorded rather than raised: a tab still showing the previous task's
        # answer is worse than one saying the baseline is unreadable.
        return delta_module.write_status(
            record,
            delta_module.DeltaStatus(
                status=delta_module.STATUS_FAILED,
                reason=f"the baseline model is unusable: {exc}",
            ),
        )

    head_dir = delta_module.directory(spec_dir)
    head_path = head_dir / delta_module.HEAD_SPEC
    try:
        authored = await authoring.author(
            session=session,
            project_dir=project_dir,
            spec_path=head_path,
            artifact_path=head_dir / HEAD_HTML,
            baseline=baseline,
            task_summary=task_summary,
            changed_files=changed_files,
            progress=progress,
        )
        if not authored.ok:
            status = delta_module.write_status(
                record,
                delta_module.DeltaStatus(
                    status=delta_module.STATUS_FAILED, reason=authored.error
                ),
            )
            status.diagnostics = list(authored.diagnostics)
            return status

        say("Comparing against the baseline…")
        return delta_module.compare_models(
            record, baseline_path, head_path, project_dir
        )
    except ArchifyUnavailable as exc:
        # `authoring.build_prompt` and every archify call raise this when the
        # renderer or Node is missing. It is one of the six states, not a
        # crash: the doctor already says what fixes it.
        blockers = "; ".join(c.remedy or c.detail for c in exc.readiness.blockers)
        return delta_module.write_status(
            record,
            delta_module.DeltaStatus(
                status=delta_module.STATUS_RUNTIME_MISSING,
                reason=blockers or str(exc),
            ),
        )
