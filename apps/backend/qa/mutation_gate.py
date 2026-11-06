"""The mutation gate in QA: tests that let a mutant through send the fixer back.

Run once the reviewer has approved, after the other gates that can overturn
an approval (`qa/loop.py`). It runs when the task's workflow declares the
hard gate ``tests-bite`` (the `test` workflow does), or for every task when
``WORKPILOT_QA_MIN_MUTATION`` is set above 0 (the threshold, in percent; 60
when only the workflow asks). ``WORKPILOT_QA_MIN_MUTATION=0`` switches it
off: the record then says so, and the hard gate reads it as unknown.

A ``fail`` rejects the pass. The fix request names each survivor as a
missing test (« the tests still pass when ``>=`` becomes ``>`` at
``Order.cs:42`` ») and allows test files only: after that fixer session, any
other file it changed is restored (`guard_test_only`). Killing a mutant by
changing the code would prove nothing. ``unknown`` never rejects and never
holds the hard gate.
"""

from __future__ import annotations

import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from foundation.change_scope import ChangeScope
from foundation.debug import debug, debug_warning
from foundation.git_executable import run_git
from mutation_gate import MutationReport, run_mutation_gate, write_record
from mutation_gate.scope import is_test_path

__all__ = [
    "ISSUE_TYPE",
    "MUTATION_ENV",
    "guard_test_only",
    "mutation_gate",
    "render_fix_request",
    "guard_start",
]

MUTATION_ENV = "WORKPILOT_QA_MIN_MUTATION"
DEFAULT_THRESHOLD = 60
ISSUE_TYPE = "mutation_survivor"
GATE_NAME = "tests-bite"


def _declared(spec_dir: Path) -> bool:
    """Whether the task's workflow declares the hard gate ``tests-bite``."""
    from workflows.hard_gates import gate_names
    from workflows.registry import load_workflow_for_spec
    from workflows.spec import WorkflowError

    try:
        workflow = load_workflow_for_spec(spec_dir)
    except (OSError, WorkflowError):  # an unreadable workflow declares nothing
        return False
    return any(
        GATE_NAME in gate_names(getattr(phase, "hard_gate", None))
        for phase in getattr(workflow, "phases", ())
    )


def threshold_for(spec_dir: Path) -> int | None:
    """The threshold this task is held to; 0 when switched off; None: not asked."""
    raw = os.environ.get(MUTATION_ENV, "").strip()
    if raw:
        try:
            value = int(raw)
        except ValueError:
            value = DEFAULT_THRESHOLD  # a typo must not switch the gate off
        return max(0, min(100, value))
    return DEFAULT_THRESHOLD if _declared(spec_dir) else None


def _plan_files(spec_dir: Path) -> tuple[str, ...]:
    from .criteria import load_implementation_plan

    plan = load_implementation_plan(spec_dir) or {}
    files: list[str] = []
    for phase in plan.get("phases") or []:
        for subtask in (phase or {}).get("subtasks") or []:
            for key in ("files_to_modify", "files_to_create"):
                for f in (subtask or {}).get(key) or []:
                    if isinstance(f, str):
                        files.append(f.replace("\\", "/").removeprefix("./"))
    return tuple(dict.fromkeys(files))


def render_fix_request(report: MutationReport) -> str:
    lines = [
        "# QA Fix Request — Tests that do not catch a bug",
        "",
        "**Status**: REJECTED (mutation gate `tests-bite`)",
        f"**Date**: {datetime.now(UTC).isoformat(timespec='seconds')}",
        "",
        f"Mutation score on the lines this task wrote: **{report.score}%**,",
        f"below the {report.threshold}% threshold. Each line below is a small bug",
        "WorkPilot planted, alone, in a copy of the code: the tests still passed.",
        "",
        "## Missing tests (blocking)",
        "",
    ]
    for n, r in enumerate(report.survivors, start=1):
        change = r.get("description") or "a mutation"
        lines.append(
            f"{n}. The tests still pass when `{change}` at `{r['path']}:{r['line']}`."
        )
    lines += [
        "",
        "## Rules",
        "",
        "- Change **test files only**: add or strengthen the assertions that would",
        "  fail on each of these bugs. Any other file you change is restored after",
        "  your session: changing the code to make a mutant disappear proves nothing.",
        "- Do not delete, skip or weaken a test.",
        "",
    ]
    return "\n".join(lines)


def _issues(report: MutationReport) -> list[dict]:
    return [
        {
            "title": "Test that does not catch a bug",
            "description": (
                f"{r['path']}:{r['line']}: the tests still pass when "
                f"{r.get('description') or 'the line is mutated'}"
            ),
            "type": ISSUE_TYPE,
        }
        for r in report.survivors
    ]


def _mark_signoff_rejected(spec_dir: Path, issues: list[dict]) -> None:
    from .criteria import load_implementation_plan, save_implementation_plan

    plan = load_implementation_plan(spec_dir)
    if not plan:
        return
    signoff = plan.get("qa_signoff")
    signoff = signoff if isinstance(signoff, dict) else {}
    kept = [
        i
        for i in signoff.get("issues_found") or []
        if not (isinstance(i, dict) and i.get("type") == ISSUE_TYPE)
    ]
    signoff.update(
        status="rejected", ready_for_qa_revalidation=False, issues_found=kept + issues
    )
    plan["qa_signoff"] = signoff
    save_implementation_plan(spec_dir, plan)


def _say(report: MutationReport, task_logger=None) -> None:
    head = f"🧬 Mutation gate ({report.engine}): {report.status}"
    if report.score is not None:
        head += f", score {report.score}% (threshold {report.threshold}%)"
    lines = [head, f"  {report.reason}" if report.reason else ""]
    lines += [
        f"  ✗ {r['path']}:{r['line']} — {r.get('description')}"
        for r in report.survivors
    ]
    message = "\n".join(line for line in lines if line)
    if task_logger is None:
        print("\n" + message)
        return
    from task_logger import LogEntryType, LogPhase

    kind = LogEntryType.ERROR if report.status == "fail" else LogEntryType.INFO
    task_logger.log(message, kind, LogPhase.VALIDATION)


def mutation_gate(
    spec_dir: Path,
    project_dir: Path,
    qa_iteration: int,
    review_scope: ChangeScope | None,
    *,
    task_logger=None,
) -> tuple[list[dict], str] | None:
    """The issues and verdict of a rejection, or None. Never raises."""
    spec_dir, project_dir = Path(spec_dir), Path(project_dir)
    threshold = threshold_for(spec_dir)
    if threshold is None:
        return None  # neither the workflow nor the person asked for it
    try:
        if threshold == 0:
            report = MutationReport(
                status="unknown", reason=f"switched off by {MUTATION_ENV}=0"
            )
        elif review_scope is None or not review_scope.base:
            report = MutationReport(
                status="unknown",
                threshold=threshold,
                reason="the change set is unknown",
            )
        else:
            report = run_mutation_gate(
                project_dir,
                review_scope.base,
                list(review_scope.files),
                threshold=threshold,
                first=_plan_files(spec_dir),
            )
        write_record(spec_dir, report)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        debug_warning("qa_loop", f"Mutation gate skipped (non-blocking): {exc}")
        return None
    _say(report, task_logger)
    if report.status != "fail":
        debug("qa_loop", "Mutation gate", status=report.status, score=report.score)
        return None
    issues = _issues(report)
    try:
        (spec_dir / "QA_FIX_REQUEST.md").write_text(
            render_fix_request(report), encoding="utf-8"
        )
        _mark_signoff_rejected(spec_dir, issues)
    except OSError as exc:
        debug_warning(
            "qa_loop", f"Mutation gate could not write the fix request: {exc}"
        )
    return issues, (
        f"QA pass #{qa_iteration} rejected: {len(issues)} mutant(s) the tests "
        f"did not catch (score {report.score}% < {report.threshold}%)"
    )


# -- the fixer may only touch tests -------------------------------------------


def guard_start(project_dir: Path, gate: tuple[list[dict], str] | None) -> str | None:
    """HEAD before a fixer session that answers the mutation gate, else None."""
    if not gate or not any(
        isinstance(i, dict) and i.get("type") == ISSUE_TYPE for i in gate[0]
    ):
        return None
    head = run_git(["rev-parse", "HEAD"], cwd=project_dir)
    return head.stdout.strip() if head.returncode == 0 else None


def _changed_since(project_dir: Path, head: str) -> list[str]:
    diff = run_git(["diff", "--name-only", "-z", head], cwd=project_dir)
    new = run_git(["ls-files", "--others", "--exclude-standard", "-z"], cwd=project_dir)
    names = [*diff.stdout.split("\0"), *new.stdout.split("\0")]
    return sorted({n for n in names if n})


def guard_test_only(project_dir: Path, spec_dir: Path, head: str | None) -> list[str]:
    """Restore every non-test file the fixer changed since ``head``; their paths."""
    if not head:
        return []
    project_dir = Path(project_dir).resolve()
    try:
        spec_rel = Path(spec_dir).resolve().relative_to(project_dir).as_posix() + "/"
    except ValueError:
        spec_rel = None
    restored: list[str] = []
    for path in _changed_since(project_dir, head):
        if is_test_path(path) or (spec_rel and path.startswith(spec_rel)):
            continue
        existed = run_git(["cat-file", "-e", f"{head}:{path}"], cwd=project_dir)
        if existed.returncode == 0:
            run_git(["checkout", head, "--", path], cwd=project_dir)
        else:
            run_git(
                ["rm", "-q", "--cached", "--ignore-unmatch", "--", path],
                cwd=project_dir,
            )
            (project_dir / path).unlink(missing_ok=True)
        restored.append(path)
    if restored:
        run_git(["add", "-A", "--", *restored], cwd=project_dir)
        committed = run_git(
            [
                "commit",
                "-q",
                "-m",
                "qa: restore non-test files changed to answer the mutation gate",
            ],
            cwd=project_dir,
        )
        if committed.returncode != 0:
            debug_warning("qa_loop", "Mutation guard: the restore is left uncommitted")
        print(
            "\n🧬 Mutation gate: the fixer changed code, not only tests; restored "
            + ", ".join(restored[:10])
        )
    return restored
