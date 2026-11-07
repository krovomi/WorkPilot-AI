"""The dependency guard as a QA gate: a package that does not exist sends the fixer back.

Run once the reviewer has approved, with the other gates that can overturn an
approval (`qa/loop.py`). It writes `dependency_guard.json` on every run, the
record the hard gate `deps-exist` reads, and only a ``blocked`` package (the
public registry answered 404, no private source, not installed) rejects the
pass: the fixer gets a `QA_FIX_REQUEST.md` naming the package and asking for
an existing one. Unknown and warnings are printed and logged, never blocking.

`WORKPILOT_DEPENDENCY_GUARD=0` switches the gate off; the record then says so,
and the hard gate reads it as unknown, never as a pass.
"""

from __future__ import annotations

import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from dependency_guard import (
    BLOCKED,
    UNKNOWN,
    WARN,
    Added,
    GuardReport,
    added_packages,
    check,
    http_fetch,
    write_record,
)
from dependency_guard.registries import Fetch
from foundation.change_scope import ChangeScope
from foundation.debug import debug, debug_warning
from offline_policy import airgap_status

__all__ = ["DEPENDENCY_GUARD_ENV", "dependency_gate", "render_fix_request"]

DEPENDENCY_GUARD_ENV = "WORKPILOT_DEPENDENCY_GUARD"
ISSUE_TYPE = "missing_dependency"


def _enabled() -> bool:
    return os.environ.get(DEPENDENCY_GUARD_ENV, "1").strip().lower() not in (
        "0",
        "false",
        "off",
        "no",
    )


def render_fix_request(report: GuardReport) -> str:
    """`QA_FIX_REQUEST.md` for the packages that do not exist."""
    lines = [
        "# QA Fix Request — Dependency that does not exist",
        "",
        "**Status**: REJECTED (dependency guard)",
        f"**Date**: {datetime.now(UTC).isoformat(timespec='seconds')}",
        "",
        "The task added these packages, and their public registry answered that",
        "no package has this name. An invented name is a supply-chain risk: anyone",
        "can publish a package under it later, and it would then be installed.",
        "",
        "## To fix (blocking)",
        "",
    ]
    for n, f in enumerate(report.of(BLOCKED), start=1):
        hint = f" Did you mean `{f.suggestion}`?" if f.suggestion else ""
        lines.append(
            f"{n}. `{f.name}` ({f.ecosystem}) in `{f.manifest}`: {f.reason}.{hint}"
        )
    lines += [
        "",
        "Replace each one with an existing, maintained package that does the job,",
        "or remove it and write the code. Never create or publish a package under",
        "this name, and do not point the project at another registry to make the",
        "check pass.",
        "",
    ]
    return "\n".join(lines)


def _issues(report: GuardReport) -> list[dict]:
    return [
        {
            "title": "Dependency does not exist",
            "description": f"{f.name} ({f.ecosystem}, {f.manifest}): {f.reason}",
            "type": ISSUE_TYPE,
        }
        for f in report.of(BLOCKED)
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


def _say(report: GuardReport, task_logger=None) -> None:
    lines = [
        f"  {mark} {f.name} ({f.ecosystem}): {f.reason}"
        for verdict, mark in ((BLOCKED, "✗"), (UNKNOWN, "?"), (WARN, "!"))
        for f in report.of(verdict)
    ]
    lines += [
        f"  ? {path}: unreadable, its new packages are unknown"
        for path in report.unreadable
    ]
    if report.unchecked:
        lines.append(f"  ? nothing checked: {report.unchecked}")
    if not lines:
        return
    message = "📦 Dependency guard:\n" + "\n".join(lines)
    if task_logger is None:
        print("\n" + message)
        return
    from task_logger import LogEntryType, LogPhase

    kind = LogEntryType.ERROR if report.of(BLOCKED) else LogEntryType.WARNING
    task_logger.log(message, kind, LogPhase.VALIDATION)


def dependency_gate(
    spec_dir: Path,
    project_dir: Path,
    qa_iteration: int,
    review_scope: ChangeScope | None,
    *,
    fetch: Fetch = http_fetch,
    task_logger=None,
) -> tuple[list[dict], str] | None:
    """The issues and verdict of a rejection, or None. Never raises."""
    spec_dir, project_dir = Path(spec_dir), Path(project_dir)
    try:
        if not _enabled():
            report = GuardReport(unchecked=f"disabled by {DEPENDENCY_GUARD_ENV}=0")
        elif review_scope is None or not review_scope.base:
            report = GuardReport(unchecked="the change set is unknown")
        else:
            added = added_packages(project_dir, review_scope.base, review_scope.files)
            report = (
                GuardReport(base=review_scope.base)
                if added == Added()
                else check(
                    project_dir,
                    added,
                    fetch=fetch,
                    offline=airgap_status(project_dir, spec_dir)["airgapStrict"],
                    base=review_scope.base,
                )
            )
        write_record(spec_dir, report)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        debug_warning("qa_loop", f"Dependency guard skipped (non-blocking): {exc}")
        return None
    _say(report, task_logger)
    if report.status != BLOCKED:
        debug("qa_loop", "Dependency guard", status=report.status)
        return None
    issues = _issues(report)
    try:
        (spec_dir / "QA_FIX_REQUEST.md").write_text(
            render_fix_request(report), encoding="utf-8"
        )
        _mark_signoff_rejected(spec_dir, issues)
    except OSError as exc:
        debug_warning(
            "qa_loop", f"Dependency guard could not write the fix request: {exc}"
        )
    return issues, (
        f"QA pass #{qa_iteration} rejected: {len(issues)} dependency(ies) "
        "that do not exist on their registry"
    )
