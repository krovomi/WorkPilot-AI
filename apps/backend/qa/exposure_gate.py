"""« Exposition de l'artefact » in QA: what the task's build output reveals.

Run once the reviewer has approved, with the other gates that can overturn an
approval (`qa/loop.py`). It reads, with REA's static audit and no model
(`rea.exposure`), the build output the task left in its worktree: an Electron
or Tauri bundle, an APK, a web build with its source maps, a .NET publish
folder, a jar, a wheel, a Rust executable. It never builds. It writes
``artifact_exposure.json`` on every run: the record the hard gate
``artifact-exposure`` reads.

When it blocks, by ``WORKPILOT_QA_ARTIFACT_EXPOSURE``:

- ``warn`` (the default): never; what REA found is printed and logged. Only an
  REA already installed at the pinned version runs: QA does not download a
  tool on its own;
- ``strict``: a check exposed at the threshold rejects the pass, and the fixer
  gets a `QA_FIX_REQUEST.md` with REA's remediations. npx may fetch the pinned
  release, except under strict offline mode;
- ``off``: never runs; the record says so and the hard gate reads it as
  unknown.

The threshold is ``WORKPILOT_QA_ARTIFACT_EXPOSURE_FAIL_ON`` (``high``, the
default, ``medium`` or ``low``). A workflow that declares the hard gate
``artifact-exposure`` runs it ``strict`` unless the variable is ``off``. A value
that is none of these reads as the default: a typo must not start blocking,
nor switch the gate off. ``unknown`` and ``not_assessed`` never block.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path

from foundation.debug import debug, debug_warning
from offline_policy import airgap_status
from rea import locate
from rea.exposure import FAIL, FAIL_LEVELS, ExposureReport, audit, write_record
from security.untrusted import quote_untrusted

__all__ = [
    "EXPOSURE_ENV",
    "FAIL_ON_ENV",
    "GATE_NAME",
    "ISSUE_TYPE",
    "exposure_gate",
    "fail_on",
    "gate_mode",
    "render_fix_request",
]

EXPOSURE_ENV = "WORKPILOT_QA_ARTIFACT_EXPOSURE"
FAIL_ON_ENV = "WORKPILOT_QA_ARTIFACT_EXPOSURE_FAIL_ON"
GATE_NAME = "artifact-exposure"
ISSUE_TYPE = "artifact_exposure"
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
    raw = os.environ.get(EXPOSURE_ENV, "").strip().lower()
    mode = raw if raw in _MODES else "warn"
    if mode == "warn" and _declared(spec_dir):
        return "strict"
    return mode


def fail_on() -> str:
    raw = os.environ.get(FAIL_ON_ENV, "").strip().lower()
    return raw if raw in FAIL_LEVELS else "high"


def _offline(project_dir: Path) -> bool:
    try:
        return bool(airgap_status(project_dir)["airgapStrict"])
    except (OSError, KeyError, ValueError):
        # An unreadable offline policy is read as strict: no download on doubt.
        return True


def render_fix_request(report: ExposureReport, spec_dir: Path | None = None) -> str:
    """`QA_FIX_REQUEST.md` for what the build output exposes."""
    lines = [
        "# QA Fix Request — The build output exposes more than it should",
        "",
        "**Status**: REJECTED (artifact exposure)",
        f"**Date**: {datetime.now(UTC).isoformat(timespec='seconds')}",
        f"**Threshold**: {report.fail_on} and above",
        f"**Reader**: {report.rea}",
        "",
        "REA read the build output this task produced, without running it.",
        "These checks are exposed at the threshold or above.",
        "",
        "## To fix (blocking)",
        "",
    ]
    for n, (artifact, check) in enumerate(report.blocking, start=1):
        lines.append(
            f"{n}. `{check.get('id')}` ({check.get('severity')}) in `{artifact.path}`"
        )
    details = "\n".join(
        f"{check.get('id')} in {artifact.path}: {check.get('remediation') or ''}"
        + (
            f" (e.g. {', '.join(check.get('samples') or [])})"
            if check.get("samples")
            else ""
        )
        for artifact, check in report.blocking
    )
    if details:
        lines += [
            "",
            "## What REA says about each, as it wrote it",
            "",
            quote_untrusted(
                details, kind="tool_output", source="rea", spec_dir=spec_dir
            ),
        ]
    lines += [
        "",
        "Fix the build configuration that produces this output (do not ship",
        "source maps with their sources, turn the fuse off, keep secrets out of",
        "the bundle). Do not delete the build output to make the check pass, and",
        "do not switch the gate off.",
        "",
    ]
    return "\n".join(lines)


def _issues(report: ExposureReport) -> list[dict]:
    return [
        {
            "title": "Build output exposes more than it should",
            "description": f"{check.get('id')} ({check.get('severity')}) in {artifact.path}",
            "type": ISSUE_TYPE,
        }
        for artifact, check in report.blocking
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


def _say(report: ExposureReport, task_logger=None) -> None:
    if report.unchecked and not report.artifacts:
        message = f"📦 Artifact exposure: not checked — {report.unchecked}"
    else:
        lines = []
        for artifact in report.artifacts:
            exposed = [c for c in artifact.checks if c.get("status") == "exposed"]
            if artifact.status != FAIL and not exposed:
                lines.append(
                    f"  ✓ {artifact.path}: {artifact.status} {artifact.detail}".rstrip()
                )
                continue
            for check in exposed:
                mark = "✗" if check.get("blocking") else "!"
                lines.append(
                    f"  {mark} {artifact.path}: {check.get('id')} ({check.get('severity')})"
                )
        message = f"📦 Artifact exposure ({report.rea}):\n" + "\n".join(lines)
    if task_logger is None:
        print("\n" + message)
        return
    from task_logger import LogEntryType, LogPhase

    kind = LogEntryType.ERROR if report.status == FAIL else LogEntryType.INFO
    task_logger.log(message, kind, LogPhase.VALIDATION)


def exposure_gate(
    spec_dir: Path,
    project_dir: Path,
    qa_iteration: int,
    *,
    task_logger=None,
    locator=locate,
    auditor=audit,
) -> tuple[list[dict], str] | None:
    """The issues and verdict of a rejection, or None. Never raises."""
    spec_dir, project_dir = Path(spec_dir), Path(project_dir)
    try:
        mode = gate_mode(spec_dir)
        threshold = fail_on()
        if mode == "off":
            report = ExposureReport(
                fail_on=threshold,
                mode=mode,
                unchecked=f"disabled by {EXPOSURE_ENV}=off",
            )
        else:
            allow_download = mode == "strict" and not _offline(project_dir)
            report = auditor(
                project_dir,
                fail_on=threshold,
                mode=mode,
                launcher=locator(allow_download=allow_download),
            )
        write_record(spec_dir, report)
    except (OSError, ValueError) as exc:
        debug_warning("qa_loop", f"Artifact exposure skipped (non-blocking): {exc}")
        return None
    _say(report, task_logger)
    if report.status != FAIL or mode != "strict":
        debug("qa_loop", "Artifact exposure", status=report.status, mode=mode)
        return None
    issues = _issues(report)
    try:
        (spec_dir / "QA_FIX_REQUEST.md").write_text(
            render_fix_request(report, spec_dir), encoding="utf-8"
        )
        _mark_signoff_rejected(spec_dir, issues)
    except OSError as exc:
        debug_warning(
            "qa_loop", f"Artifact exposure could not write the fix request: {exc}"
        )
    return issues, (
        f"QA pass #{qa_iteration} rejected: the build output exposes "
        f"{len(issues)} check(s) at {report.fail_on} or above"
    )
