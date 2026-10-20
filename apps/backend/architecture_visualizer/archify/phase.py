"""The `architecture-map` workflow phase: `task_delta`, driven by the build.

`workflows.runner.run_skill_phase` hands a phase whose id is in
`CUSTOM_EXECUTORS` to its executor instead of a one-shot session; this is the
one for `architecture-map`. Modelled on `verify.phase`: the phase's provider
and model are resolved the way every skill phase resolves them, and the one
step that needs a model — authoring the head model — runs on
`verify.phase.make_agent_runner`, i.e. `create_agent_client` under the
`architecture_visualizer` agent, which may `Write` and may not shell out.

Everything else is `task_delta.run_task_delta`, the same code the Delta tab's
regenerate button runs, so a non-significant change records its answer and
returns before any session is opened.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = ["run_architecture_map_phase", "task_summary"]

#: The agent the head model is authored under (`AGENT_CONFIGS`).
AGENT_TYPE = "architecture_visualizer"

#: The summary is a hint for the author, not the spec: the delta prompt already
#: carries the baseline and the changed files, which are what decide the model.
_SUMMARY_CHARS = 1200

#: Diagnostics copied into the phase report when authoring gave up.
_REPORT_DIAGNOSTICS = 10


def task_summary(spec_dir: Path) -> str:
    """What the task set out to do, in a few lines: the request as typed, else
    the head of `spec.md`."""
    try:
        data = json.loads((spec_dir / "requirements.json").read_text(encoding="utf-8"))
        text = data.get("task_description") if isinstance(data, dict) else None
        if isinstance(text, str) and text.strip():
            return text.strip()[:_SUMMARY_CHARS]
    except (OSError, ValueError):
        # No requirements.json, or not JSON: the head of spec.md says it too.
        pass
    try:
        spec = (spec_dir / "spec.md").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    lines = [line.strip() for line in spec.splitlines() if line.strip()]
    return "\n".join(lines[:12])[:_SUMMARY_CHARS]


def _report(status, record_dir: Path, session_errors: list[str]) -> str:
    """The phase's markdown, kept beside the other phases' reports."""
    from .delta import status_path

    lines = [
        "# architecture-map",
        "",
        f"Status: `{status.status}`",
    ]
    if status.reason:
        lines.append(f"Reason: {status.reason}")
    if status.summary:
        lines.append(f"Summary: `{json.dumps(status.summary, sort_keys=True)}`")
    if status.artifact:
        lines.append(f"Delta: {status.artifact}")
    lines.append(f"Record: {status_path(record_dir)}")
    for error in session_errors[-2:]:
        lines.append(f"Session error: {error[:300]}")
    # The record keeps the sentence a person reads; the authoring loop's own
    # refusals are what a maintainer needs, and this report is where they land.
    diagnostics = status.diagnostics or []
    if diagnostics:
        lines.append("")
        lines.append("Unresolved diagnostics:")
        for item in diagnostics[:_REPORT_DIAGNOSTICS]:
            if isinstance(item, dict):
                code = item.get("code", "?")
                message = item.get("message") or item.get("subject") or ""
            else:
                code, message = "?", item
            lines.append(f"- `{code}` {str(message)[:200]}")
        if len(diagnostics) > _REPORT_DIAGNOSTICS:
            lines.append(f"- … {len(diagnostics) - _REPORT_DIAGNOSTICS} more")
    return "\n".join(lines) + "\n"


async def run_architecture_map_phase(resolved, ctx):
    """Map the task against the baseline and report it. Never raises.

    Everything — resolving the provider, building the runner, the delta, the
    report — sits under one guard: a phase that cannot run reports why and the
    build goes on, whichever of its steps it was that failed.
    """
    from workflows.runner import PhaseOutcome

    phase = resolved.phase
    try:
        return await _run(resolved, ctx)
    except Exception as exc:  # noqa: BLE001 - a phase reports, it does not abort
        logger.warning("architecture-map failed to run: %s", exc)
        return PhaseOutcome(
            phase.id, phase.impl, resolved.dispatch, None, detail=str(exc)[:200]
        )


async def _run(resolved, ctx):
    from workflows.runner import (
        CONFIG_PHASE,
        PhaseOutcome,
        _write_output,
        phase_provider,
        subagents_allowed,
    )

    from . import delta as delta_module
    from . import task_delta

    phase = resolved.phase
    try:
        from verify.phase import make_agent_runner
    except ImportError as exc:  # pragma: no cover - import-time environment
        return PhaseOutcome(
            phase.id, phase.impl, resolved.dispatch, None, detail=f"unavailable: {exc}"
        )
    config_phase = CONFIG_PHASE.get(phase.id, "qa")
    explicit, _effective = phase_provider(ctx.spec_dir, config_phase)

    project_dir = Path(ctx.project_dir)
    spec_dir = Path(ctx.spec_dir)
    record_dir = Path(ctx.source_spec_dir or ctx.spec_dir)
    baseline_project = Path(ctx.source_project_dir or ctx.project_dir)

    # One fresh session per authoring round — the runner lifts the resume
    # marker and puts it back, which is what `fresh-context` asks for.
    runner = make_agent_runner(
        project_dir,
        spec_dir,
        model=ctx.model,
        provider=explicit,
        verbose=ctx.verbose,
        config_phase=config_phase,
        roster=None,
        use_subagents=subagents_allowed(resolved.dispatch),
    )
    session_errors: list[str] = []

    async def session(prompt: str) -> str:
        status, response = await runner(AGENT_TYPE, prompt)
        if status == "error":
            # The authoring loop reads the file, not the reply, so a session
            # that died reads to it as "wrote no model". Kept so the outcome
            # can say why.
            session_errors.append(response)
        return response

    def _log(message: str) -> None:
        print(f"  {message}", flush=True)

    status = await task_delta.run_task_delta(
        project_dir,
        spec_dir,
        session=session,
        baseline_project_dir=baseline_project,
        changed_files=ctx.changed_files,
        task_summary=task_summary(spec_dir),
        progress=_log,
        record_dir=record_dir,
    )

    output = _write_output(ctx, phase.id, _report(status, record_dir, session_errors))

    reason = status.reason or status.status
    if status.status == delta_module.STATUS_MAPPED:
        succeeded: bool | None = True
        detail = (
            "mapped — the architecture changed"
            if status.has_changes
            else "mapped — no architectural change"
        )
    elif status.status == delta_module.STATUS_NOT_SIGNIFICANT:
        succeeded = True
        detail = f"not significant — {reason}"
    elif status.status == delta_module.STATUS_FAILED:
        succeeded = False
        detail = reason
        if session_errors:
            detail = f"{detail} (session error: {session_errors[-1][:120]})"
    else:
        # `no-baseline`, `runtime-missing`, `unreliable-ids`: the phase could
        # not produce a delta worth reading, which is not the build's fault.
        succeeded = None
        detail = reason
    return PhaseOutcome(
        phase.id,
        phase.impl,
        resolved.dispatch,
        succeeded,
        detail=detail[:300],
        output_path=output,
    )
