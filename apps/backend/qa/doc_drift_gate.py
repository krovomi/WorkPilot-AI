"""The documentation drift detector in QA: a task's change that leaves its docs behind (#354).

Run once the reviewer has approved, with the other gates (`qa/loop.py`). It
reads the task's own changes, with no model (`doc_drift_detector/`): the doc
comments of the source files it changed, the documents it changed (cited
functions and files, code examples), and the documents about the code it
changed that it left as they were. It writes `doc_drift.json` on every run.

When it blocks, by ``WORKPILOT_QA_DOC_DRIFT``:

- ``warn`` (the default): never; what drifted is printed and logged;
- ``strict``: a high problem (a doc comment naming a parameter the code no
  longer has, an example importing or calling what no longer exists) rejects
  the pass, and the fixer gets a `QA_FIX_REQUEST.md` to update the docs;
- ``off``: never runs; the record says so.

A value that is none of these reads as ``warn``.
"""

from __future__ import annotations

import json
import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from doc_drift_detector.project import scan_project
from foundation.change_scope import ChangeScope
from foundation.debug import debug, debug_warning
from security.untrusted import quote_untrusted

__all__ = ["DOC_DRIFT_ENV", "ISSUE_TYPE", "doc_drift_gate", "render_fix_request"]

DOC_DRIFT_ENV = "WORKPILOT_QA_DOC_DRIFT"
ISSUE_TYPE = "doc_drift"
RECORD = "doc_drift.json"
_MODES = ("off", "warn", "strict")


def gate_mode() -> str:
    raw = os.environ.get(DOC_DRIFT_ENV, "").strip().lower()
    return raw if raw in _MODES else "warn"


def _blocking(report: dict[str, Any]) -> list[dict[str, Any]]:
    return [i for i in report.get("issues", []) if i.get("severity") == "high"]


def render_fix_request(
    blocking: list[dict[str, Any]], spec_dir: Path | None = None
) -> str:
    """`QA_FIX_REQUEST.md` for the docs the change left wrong."""
    lines = [
        "# QA Fix Request — Documentation drift",
        "",
        "**Status**: REJECTED (documentation drift detector)",
        f"**Date**: {datetime.now(UTC).isoformat(timespec='seconds')}",
        "",
        "The code this task changed no longer matches its documentation. Update",
        "the doc comments and the documents so they describe the code as it is;",
        "do not change the code back, and do not delete the documentation.",
        "",
        "## To fix (blocking)",
        "",
    ]
    details = []
    for n, issue in enumerate(blocking, start=1):
        lines.append(f"{n}. `{issue['docFile']}:{issue['docLine']}`")
        details.append(f"{issue['docFile']}:{issue['docLine']}: {issue['message']}")
    lines += [
        "",
        "## What drifted, as read in the files",
        "",
        quote_untrusted(
            "\n".join(details),
            kind="file_content",
            source="doc_drift",
            spec_dir=spec_dir,
        ),
        "",
        "A document that describes another version on purpose can be marked",
        "`<!-- no-drift-check -->`; the reviewer sees every mark.",
        "",
    ]
    return "\n".join(lines)


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


def _say(report: dict[str, Any], task_logger=None) -> None:
    issues = report.get("issues", [])
    if not issues:
        return
    marks = {"high": "✗", "medium": "!", "low": "·"}
    lines = [
        f"  {marks.get(i['severity'], '·')} {i['docFile']}:{i['docLine']}: {i['message']}"
        for i in issues[:40]
    ]
    message = "📄 Documentation drift:\n" + "\n".join(lines)
    if task_logger is None:
        print("\n" + message)
        return
    from task_logger import LogEntryType, LogPhase

    kind = LogEntryType.ERROR if _blocking(report) else LogEntryType.WARNING
    task_logger.log(message, kind, LogPhase.VALIDATION)


def _write(spec_dir: Path, record: dict[str, Any]) -> None:
    (spec_dir / RECORD).write_text(json.dumps(record, indent=2), encoding="utf-8")


def doc_drift_gate(
    spec_dir: Path,
    project_dir: Path,
    qa_iteration: int,
    review_scope: ChangeScope | None,
    *,
    task_logger=None,
) -> tuple[list[dict], str] | None:
    """The issues and verdict of a rejection, or None. Never raises."""
    spec_dir, project_dir = Path(spec_dir), Path(project_dir)
    mode = gate_mode()
    try:
        if mode == "off":
            _write(spec_dir, {"unchecked": f"disabled by {DOC_DRIFT_ENV}=off"})
            return None
        if review_scope is None or not review_scope.files:
            _write(spec_dir, {"unchecked": "the change set is unknown"})
            return None
        report = scan_project(
            project_dir, changed=set(review_scope.files), use_git=False
        )
        report["mode"] = mode
        _write(spec_dir, report)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        debug_warning("qa_loop", f"Doc drift detector skipped (non-blocking): {exc}")
        return None
    _say(report, task_logger)
    blocking = _blocking(report)
    if not blocking or mode != "strict":
        debug("qa_loop", "Doc drift detector", issues=len(report["issues"]), mode=mode)
        return None
    issues = [
        {
            "title": "Documentation drift",
            "description": f"{i['docFile']}:{i['docLine']}: {i['message']}",
            "type": ISSUE_TYPE,
        }
        for i in blocking
    ]
    try:
        (spec_dir / "QA_FIX_REQUEST.md").write_text(
            render_fix_request(blocking, spec_dir), encoding="utf-8"
        )
        _mark_signoff_rejected(spec_dir, issues)
    except OSError as exc:
        debug_warning(
            "qa_loop", f"Doc drift detector could not write the fix request: {exc}"
        )
    return issues, (
        f"QA pass #{qa_iteration} rejected: {len(issues)} documentation drift(s) "
        "left by the change"
    )
