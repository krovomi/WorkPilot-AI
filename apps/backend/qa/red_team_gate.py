"""The red team in QA: an attack that crashes the changed code sends the fixer back.

Run once the reviewer has approved, after the other gates (`qa/loop.py`).

When it runs, by ``WORKPILOT_QA_RED_TEAM``:

- ``complex`` (the default): tasks whose spec was assessed ``complex``;
- ``always``: every task that changed source code;
- ``off``: never; the record says so and the hard gate reads it as unknown.

A workflow that declares the hard gate ``attack-resistant`` runs it whatever
the variable says, unless it is ``off``. A value that is not one of these
reads as ``complex``: a typo must not switch it on for every task, nor off.

The first run opens one session (the QA provider and model) that writes the
attacks; each later pass of the same task replays them without a model. A
``fail`` (an attack crashed the code) rejects the pass with a fix request
that shows each attack test and its failure. ``unexpected`` results are shown
on the card, never blocking: the attack's expectation may be the wrong one.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path

from foundation.change_scope import ChangeScope
from foundation.debug import debug, debug_warning
from red_team import RedTeamReport, load_record, run_red_team, write_record

__all__ = [
    "AGENT_TYPE",
    "GATE_NAME",
    "ISSUE_TYPE",
    "RED_TEAM_ENV",
    "mode_for",
    "red_team_gate",
    "render_fix_request",
]

RED_TEAM_ENV = "WORKPILOT_QA_RED_TEAM"
GATE_NAME = "attack-resistant"
ISSUE_TYPE = "red_team_crash"
AGENT_TYPE = "red_team"
_MODES = ("off", "complex", "always")


def _declared(spec_dir: Path) -> bool:
    from workflows.hard_gates import gate_names
    from workflows.registry import load_workflow_for_spec
    from workflows.spec import WorkflowError

    try:
        workflow = load_workflow_for_spec(spec_dir)
    except (OSError, WorkflowError):
        return False
    return any(
        GATE_NAME in gate_names(getattr(phase, "hard_gate", None))
        for phase in getattr(workflow, "phases", ())
    )


def _complex(spec_dir: Path) -> bool:
    from scheduling.complexity_router import get_complexity_from_spec

    return get_complexity_from_spec(spec_dir) == "complex"


def mode_for(spec_dir: Path) -> str | None:
    """``run``, ``off`` (switched off, recorded), or None (not asked for this task)."""
    raw = os.environ.get(RED_TEAM_ENV, "").strip().lower() or "complex"
    setting = raw if raw in _MODES else "complex"
    if setting == "off":
        return "off"
    if setting == "always" or _declared(spec_dir) or _complex(spec_dir):
        return "run"
    return None


def make_session(spec_dir: Path, model: str, *, verbose: bool = False):
    """One session of the ``red_team`` agent type in the scratch copy, any provider."""

    async def session(copy: Path, prompt: str) -> object:
        from agents.session import run_agent_session
        from core.client import create_agent_client
        from phase_config import get_phase_thinking_budget
        from task_logger import LogPhase
        from workflows.runner import phase_provider

        explicit, _provider = phase_provider(spec_dir, "qa")
        stashed = os.environ.pop("AUTO_CLAUDE_RESUME_SESSION_ID", None)
        try:
            client = create_agent_client(
                project_dir=copy,
                spec_dir=spec_dir,
                model=model,
                agent_type=AGENT_TYPE,
                max_thinking_tokens=get_phase_thinking_budget(spec_dir, "qa"),
                use_subagents=False,
                provider=explicit,
            )
            async with client:
                return await run_agent_session(
                    client, prompt, spec_dir, verbose, phase=LogPhase.VALIDATION
                )
        finally:
            if stashed is not None:
                os.environ["AUTO_CLAUDE_RESUME_SESSION_ID"] = stashed

    return session


def _fence(text: str) -> str:
    fence = "````" if "```" in text else "```"
    return f"{fence}\n{text.rstrip()}\n{fence}"


def render_fix_request(report: RedTeamReport) -> str:
    lines = [
        "# QA Fix Request — The red team crashed the code",
        "",
        f"**Status**: REJECTED (red team gate `{GATE_NAME}`)",
        f"**Date**: {datetime.now(UTC).isoformat(timespec='seconds')}",
        "",
        "Each attack below made an unhandled error escape from the code this task",
        "wrote. The attack tests are not in your worktree: WorkPilot keeps them and",
        "runs them again after your session.",
        "",
        "## Crashes (blocking)",
        "",
    ]
    for n, attack in enumerate(report.crashes, start=1):
        lines += [
            f"### {n}. `{attack.test}` ({attack.mode}) — `{attack.target or attack.file}`",
            "",
            f"- Input: {attack.input or '(see the test)'}",
            f"- Expected: {attack.expect or 'no crash'}",
            "",
            "Failure:",
            "",
            _fence(attack.detail[:1500] or "(no message)"),
            "",
        ]
        source = report.files.get(attack.file)
        if source:
            lines += [f"Attack test (`{attack.file}`):", "", _fence(source[:4000]), ""]
    lines += [
        "## Rules",
        "",
        "- Fix the code so that it handles these inputs the way it handles bad input",
        "  elsewhere (validation error, error result, documented exception).",
        "- If an attack expects a behaviour the spec contradicts, follow the spec and",
        "  say so in your answer: the person sees the attack on the task card.",
        "",
    ]
    return "\n".join(lines)


def _issues(report: RedTeamReport) -> list[dict]:
    return [
        {
            "title": "Crash found by the red team",
            "description": (
                f"{a.target or a.file}: {a.input or a.test} — "
                f"{(a.detail.splitlines() or [''])[0][:200]}"
            ),
            "type": ISSUE_TYPE,
        }
        for a in report.crashes
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


def _say(report: RedTeamReport, task_logger=None) -> None:
    counts = report.to_dict()["counts"]
    head = (
        f"🛡️ Red team ({report.run}): {report.status} — {counts['crash']} crash, "
        f"{counts['unexpected']} unexpected, {counts['resistant']} resistant, "
        f"{counts['warning']} warning"
    )
    lines = [head, f"  {report.reason}" if report.reason else ""]
    lines += [f"  ✗ {a.test}: {a.input}" for a in report.crashes]
    message = "\n".join(line for line in lines if line)
    if task_logger is None:
        print("\n" + message)
        return
    from task_logger import LogEntryType, LogPhase

    kind = LogEntryType.ERROR if report.status == "fail" else LogEntryType.INFO
    task_logger.log(message, kind, LogPhase.VALIDATION)


async def red_team_gate(
    spec_dir: Path,
    project_dir: Path,
    qa_iteration: int,
    review_scope: ChangeScope | None,
    *,
    model: str,
    verbose: bool = False,
    task_logger=None,
) -> tuple[list[dict], str] | None:
    """The issues and verdict of a rejection, or None. Never raises."""
    spec_dir, project_dir = Path(spec_dir), Path(project_dir)
    mode = mode_for(spec_dir)
    if mode is None:
        return None
    try:
        if mode == "off":
            report = RedTeamReport(reason=f"switched off by {RED_TEAM_ENV}=off")
        elif review_scope is None or not review_scope.base:
            report = RedTeamReport(reason="the change set is unknown")
        else:
            previous = load_record(spec_dir)
            if previous and previous.get("base") != review_scope.base:
                previous = None
            report = await run_red_team(
                project_dir,
                review_scope.base,
                list(review_scope.files),
                session=make_session(spec_dir, model, verbose=verbose),
                previous=previous,
            )
        write_record(spec_dir, report)
    except (OSError, ValueError) as exc:
        debug_warning("qa_loop", f"Red team skipped (non-blocking): {exc}")
        return None
    _say(report, task_logger)
    if report.status != "fail":
        debug("qa_loop", "Red team", status=report.status)
        return None
    issues = _issues(report)
    try:
        (spec_dir / "QA_FIX_REQUEST.md").write_text(
            render_fix_request(report), encoding="utf-8"
        )
        _mark_signoff_rejected(spec_dir, issues)
    except OSError as exc:
        debug_warning("qa_loop", f"Red team could not write the fix request: {exc}")
    return issues, (
        f"QA pass #{qa_iteration} rejected: the red team crashed the code "
        f"({len(issues)} attack(s))"
    )
