"""The schema guard in QA: a migration that breaks a live database is caught.

Run once the reviewer has approved, with the other gates that can overturn an
approval (`qa/loop.py`). It reads only the migrations the task added or
changed, with no model and no database (`schema_guard/`), and writes
`schema_guard.json` on every run: the record the hard gate `migration-safe`
and the task's Quality tab read.

When it blocks, by ``WORKPILOT_QA_SCHEMA_GUARD``:

- ``warn`` (the default): never; the findings are printed, logged and shown
  on the task, so a team that runs its migrations in a maintenance window is
  not sent round the fixer for nothing;
- ``strict``: an error (data loss, a rename, a NOT NULL column the first
  existing row breaks, an applied migration edited) rejects the pass, and the
  fixer gets a `QA_FIX_REQUEST.md` with the expand/contract plan;
- ``off``: never runs; the record says so and the hard gate reads it as
  unknown.

A workflow that declares the hard gate ``migration-safe`` runs it ``strict``
unless the variable is ``off``. A value that is none of these reads as
``warn``: a typo must not start blocking, nor switch the guard off.
"""

from __future__ import annotations

import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from foundation.change_scope import ChangeScope
from foundation.debug import debug, debug_warning
from schema_guard import FAIL, WARNING, SchemaReport, check, write_record
from security.untrusted import quote_untrusted

__all__ = [
    "GATE_NAME",
    "ISSUE_TYPE",
    "SCHEMA_GUARD_ENV",
    "render_fix_request",
    "schema_gate",
]

SCHEMA_GUARD_ENV = "WORKPILOT_QA_SCHEMA_GUARD"
GATE_NAME = "migration-safe"
ISSUE_TYPE = "unsafe_migration"
_MODES = ("off", "warn", "strict")


def _declared(spec_dir: Path) -> bool:
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


def gate_mode(spec_dir: Path) -> str:
    raw = os.environ.get(SCHEMA_GUARD_ENV, "").strip().lower()
    mode = raw if raw in _MODES else "warn"
    if mode == "warn" and _declared(spec_dir):
        return "strict"
    return mode


def render_fix_request(report: SchemaReport, spec_dir: Path | None = None) -> str:
    """`QA_FIX_REQUEST.md` for the migrations a live database would not survive."""
    lines = [
        "# QA Fix Request — Migration that is not zero-downtime",
        "",
        "**Status**: REJECTED (schema guard)",
        f"**Date**: {datetime.now(UTC).isoformat(timespec='seconds')}",
        f"**Engine**: {report.engine}",
        "",
        "While a deploy rolls out, the old code still runs against the new",
        "schema. These migrations break it, or lose data, as written.",
        "",
        "## To fix (blocking)",
        "",
    ]
    for n, f in enumerate(report.errors, start=1):
        lines.append(f"{n}. `{f.path}:{f.line}` {f.message}. {f.advice}")
    warnings = [f for f in report.findings if f.severity == WARNING]
    if warnings:
        lines += ["", "## Also worth fixing (not blocking)", ""]
        lines += [f"- `{f.path}:{f.line}` {f.message}. {f.advice}" for f in warnings]
    statements = "\n".join(
        f"{f.path}:{f.line}: {f.statement}" for f in report.findings if f.statement
    )
    if statements:
        lines += [
            "",
            "## The statements, as written in the migrations",
            "",
            quote_untrusted(
                statements,
                kind="file_content",
                source="schema_guard",
                spec_dir=spec_dir,
            ),
        ]
    lines += ["", "## The zero-downtime plan", ""]
    lines += [f"{n}. {step}" for n, step in enumerate(report.plan, start=1)]
    lines += [
        "",
        "Split the change into migrations of their own along this plan. Do not",
        "edit a migration that existed before the task, do not delete one to",
        "make the check pass, and do not switch the guard off.",
        "",
    ]
    return "\n".join(lines)


def _issues(report: SchemaReport) -> list[dict]:
    return [
        {
            "title": "Migration is not zero-downtime",
            "description": f"{f.path}:{f.line} {f.message}",
            "type": ISSUE_TYPE,
        }
        for f in report.errors
    ]


def _mark_signoff_rejected(spec_dir: Path, issues: list[dict]) -> None:
    """The reviewer wrote "approved"; a later run must not read that and stop."""
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


def _say(report: SchemaReport, task_logger=None) -> None:
    if not report.findings:
        return
    lines = [
        f"  {'✗' if f.severity != WARNING else '!'} {f.path}:{f.line} {f.message}"
        for f in report.findings
    ]
    message = f"🗄️ Schema guard ({report.engine}):\n" + "\n".join(lines)
    if task_logger is None:
        print("\n" + message)
        return
    from task_logger import LogEntryType, LogPhase

    kind = LogEntryType.ERROR if report.status == FAIL else LogEntryType.WARNING
    task_logger.log(message, kind, LogPhase.VALIDATION)


def schema_gate(
    spec_dir: Path,
    project_dir: Path,
    qa_iteration: int,
    review_scope: ChangeScope | None,
    *,
    task_logger=None,
) -> tuple[list[dict], str] | None:
    """The issues and verdict of a rejection, or None. Never raises."""
    spec_dir, project_dir = Path(spec_dir), Path(project_dir)
    try:
        mode = gate_mode(spec_dir)
        if mode == "off":
            report = SchemaReport(
                mode=mode, unchecked=f"disabled by {SCHEMA_GUARD_ENV}=off"
            )
        elif review_scope is None or not review_scope.base:
            report = SchemaReport(mode=mode, unchecked="the change set is unknown")
        else:
            report = check(
                project_dir, review_scope.files, review_scope.base, mode=mode
            )
        write_record(spec_dir, report)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        debug_warning("qa_loop", f"Schema guard skipped (non-blocking): {exc}")
        return None
    _say(report, task_logger)
    if report.status != FAIL or mode != "strict":
        debug("qa_loop", "Schema guard", status=report.status, mode=mode)
        return None
    issues = _issues(report)
    try:
        (spec_dir / "QA_FIX_REQUEST.md").write_text(
            render_fix_request(report, spec_dir), encoding="utf-8"
        )
        _mark_signoff_rejected(spec_dir, issues)
    except OSError as exc:
        debug_warning("qa_loop", f"Schema guard could not write the fix request: {exc}")
    return issues, (
        f"QA pass #{qa_iteration} rejected: {len(issues)} migration step(s) "
        "that a live database would not survive"
    )
