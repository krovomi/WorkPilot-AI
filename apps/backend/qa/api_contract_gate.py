"""The API contract watcher in QA: a breaking change nobody declared is caught (#389).

Run once the reviewer has approved, with the other gates that can overturn an
approval (`qa/loop.py`). It compares the contracts the task touched (OpenAPI,
GraphQL, protobuf) with the merge base, with no model (`api_watcher/`), and
writes `api_contract.json` on every run: the record the PR body and the API
Watcher page read.

When it blocks, by ``WORKPILOT_QA_API_CONTRACT``:

- ``warn`` (the default): never; the changes are printed, logged, and listed
  with their consumers in the PR body for the reviewer;
- ``strict``: a breaking change the contract does not acknowledge
  (``x-breaking-acknowledged``) rejects the pass, and the fixer gets a
  `QA_FIX_REQUEST.md` asking for a backward-compatible change;
- ``off``: never runs; the record says so.

A value that is none of these reads as ``warn``: a typo must not start
blocking, nor switch the watcher off.
"""

from __future__ import annotations

import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from api_watcher.compare import CompareReport, compare, write_record
from foundation.change_scope import ChangeScope
from foundation.debug import debug, debug_warning
from security.untrusted import quote_untrusted

__all__ = ["API_CONTRACT_ENV", "ISSUE_TYPE", "api_contract_gate", "render_fix_request"]

API_CONTRACT_ENV = "WORKPILOT_QA_API_CONTRACT"
ISSUE_TYPE = "breaking_api_change"
_MODES = ("off", "warn", "strict")


def gate_mode() -> str:
    raw = os.environ.get(API_CONTRACT_ENV, "").strip().lower()
    return raw if raw in _MODES else "warn"


def render_fix_request(report: CompareReport, spec_dir: Path | None = None) -> str:
    """`QA_FIX_REQUEST.md` for the breaking changes the contract does not declare."""
    lines = [
        "# QA Fix Request — Breaking API change",
        "",
        "**Status**: REJECTED (API contract watcher)",
        f"**Date**: {datetime.now(UTC).isoformat(timespec='seconds')}",
        f"**Compared with**: {report.target} (merge base {report.base[:12]})",
        "",
        "Existing clients of these contracts would break. Keep the change",
        "backward compatible: add instead of changing (a new optional field, a",
        "new endpoint or version), deprecate before removing, never renumber a",
        "protobuf field.",
        "",
        "## To fix (blocking)",
        "",
    ]
    details: list[str] = []
    for n, (entry, change) in enumerate(report.unacknowledged_breaking, start=1):
        lines.append(f"{n}. `{entry.path}` — `{change.path}`")
        details.append(f"{entry.path}: {change.description}")
        for consumer in entry.consumers.get(change.path, [])[:3]:
            files = ", ".join(consumer.get("files", [])[:3])
            details.append(f"  used by {consumer['name']}: {files}")
    if details:
        lines += [
            "",
            "## What changed, as read in the contracts",
            "",
            quote_untrusted(
                "\n".join(details),
                kind="file_content",
                source="api_watcher",
                spec_dir=spec_dir,
            ),
        ]
    lines += [
        "",
        "Only if the task's spec explicitly asks for this break, mark it with",
        "`x-breaking-acknowledged: true` on the operation, schema or property",
        "(`# x-breaking-acknowledged` / `// x-breaking-acknowledged` above it in",
        "GraphQL / protobuf): the reviewer sees every acknowledged break. Do not",
        "delete a contract or switch the watcher off to make the check pass.",
        "",
    ]
    return "\n".join(lines)


def _issues(report: CompareReport) -> list[dict]:
    return [
        {
            "title": "Breaking API change",
            "description": f"{entry.path}: {change.path}",
            "type": ISSUE_TYPE,
        }
        for entry, change in report.unacknowledged_breaking
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


def _say(report: CompareReport, task_logger=None) -> None:
    changes = [(e, c) for e in report.contracts for c in e.diff.changes]
    if not changes:
        return
    marks = {"breaking": "✗", "potentially_breaking": "!", "non_breaking": "+"}
    lines = [
        f"  {marks[c.category.value]} {e.path}: {c.description}"
        + (" (acknowledged)" if c.acknowledged else "")
        for e, c in changes[:40]
    ]
    message = "🔌 API contract watcher:\n" + "\n".join(lines)
    if task_logger is None:
        print("\n" + message)
        return
    from task_logger import LogEntryType, LogPhase

    kind = (
        LogEntryType.ERROR if report.unacknowledged_breaking else LogEntryType.WARNING
    )
    task_logger.log(message, kind, LogPhase.VALIDATION)


def api_contract_gate(
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
        mode = gate_mode()
        if mode == "off":
            report = CompareReport(unchecked=f"disabled by {API_CONTRACT_ENV}=off")
        elif review_scope is None or not review_scope.base:
            report = CompareReport(unchecked="the change set is unknown")
        else:
            report = compare(
                project_dir, base=review_scope.base, files=list(review_scope.files)
            )
        write_record(spec_dir, report)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        debug_warning("qa_loop", f"API contract watcher skipped (non-blocking): {exc}")
        return None
    _say(report, task_logger)
    if not report.unacknowledged_breaking or mode != "strict":
        debug("qa_loop", "API contract watcher", status=report.status, mode=mode)
        return None
    issues = _issues(report)
    try:
        (spec_dir / "QA_FIX_REQUEST.md").write_text(
            render_fix_request(report, spec_dir), encoding="utf-8"
        )
        _mark_signoff_rejected(spec_dir, issues)
    except OSError as exc:
        debug_warning(
            "qa_loop", f"API contract watcher could not write the fix request: {exc}"
        )
    return issues, (
        f"QA pass #{qa_iteration} rejected: {len(issues)} breaking API change(s) "
        "the contract does not acknowledge"
    )
