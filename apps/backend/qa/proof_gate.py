"""The project's proof checkers as a QA gate: a rejected proof sends the fixer back.

Run once the reviewer has approved, with the other gates that can overturn an
approval (`qa/loop.py`). It writes `proof_checks.json` on every run, the
record the hard gate `proof-checks` reads. Only ``fail`` (a checker exited
non-zero) rejects the pass: the fixer gets a `QA_FIX_REQUEST.md` naming the
checker and the end of its output. A checker that is not installed, a time
out or a recipe not approved is ``unknown``: said, never blocking, never a
pass. A project without `[proofs]` is not concerned (``none``).
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from core.workspace.proofs import (
    FAIL,
    UNKNOWN,
    ProofReport,
    main_project_of,
    run_proofs,
    write_proof_record,
)
from foundation.debug import debug, debug_warning

__all__ = ["proof_gate", "render_fix_request"]

ISSUE_TYPE = "proof_rejected"


def render_fix_request(report: ProofReport) -> str:
    """`QA_FIX_REQUEST.md` for the checkers that rejected the proofs."""
    lines = [
        "# QA Fix Request — Proof rejected",
        "",
        "**Status**: REJECTED (proof checks)",
        f"**Date**: {datetime.now(UTC).isoformat(timespec='seconds')}",
        "",
        "The project's proof checker rejected the proofs with this task's changes.",
        "Fix the code or the proof until the checker accepts it. Do not weaken,",
        "delete or `assume` away a proof obligation to get it accepted.",
        "",
    ]
    for check in report.failed:
        lines += [
            f"## `{' '.join(check.get('command') or [])}`",
            "",
            "```text",
            str(check.get("detail") or "")[:1500],
            "```",
            "",
        ]
    return "\n".join(lines)


def _issues(report: ProofReport) -> list[dict]:
    return [
        {
            "title": "Proof rejected",
            "description": (
                f"`{' '.join(c.get('command') or [])}`: {str(c.get('detail') or '')[:600]}"
            ),
            "type": ISSUE_TYPE,
        }
        for c in report.failed
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


def _say(report: ProofReport, task_logger=None) -> None:
    if report.status not in (FAIL, UNKNOWN):
        return
    marks = {"failed": "✗", "ok": "✓"}
    lines = [f"  {report.reason}"] + [
        f"  {marks.get(c['status'], '?')} {' '.join(c['command'])}"
        + (f": {c['detail'][:200]}" if c.get("detail") else "")
        for c in report.checks
    ]
    message = "🧮 Proof checks:\n" + "\n".join(lines)
    if task_logger is None:
        print("\n" + message)
        return
    from task_logger import LogEntryType, LogPhase

    kind = LogEntryType.ERROR if report.status == FAIL else LogEntryType.WARNING
    task_logger.log(message, kind, LogPhase.VALIDATION)


def proof_gate(
    spec_dir: Path,
    project_dir: Path,
    qa_iteration: int,
    *,
    task_logger=None,
) -> tuple[list[dict], str] | None:
    """The issues and verdict of a rejection, or None. Never raises.

    ``project_dir`` is the task's worktree, where QA runs; the recipe and its
    approval are read from the project it belongs to.
    """
    spec_dir, worktree = Path(spec_dir), Path(project_dir)
    try:
        report = run_proofs(main_project_of(worktree), worktree, spec_dir.name)
        write_proof_record(spec_dir, report)
    except (OSError, ValueError) as exc:
        debug_warning("qa_loop", f"Proof checks skipped (non-blocking): {exc}")
        return None
    _say(report, task_logger)
    if report.status != FAIL:
        debug("qa_loop", "Proof checks", status=report.status)
        return None
    issues = _issues(report)
    try:
        (spec_dir / "QA_FIX_REQUEST.md").write_text(
            render_fix_request(report), encoding="utf-8"
        )
        _mark_signoff_rejected(spec_dir, issues)
    except OSError as exc:
        debug_warning("qa_loop", f"Proof checks could not write the fix request: {exc}")
    return issues, (
        f"QA pass #{qa_iteration} rejected: {len(issues)} proof checker(s) "
        "rejected the proofs"
    )
