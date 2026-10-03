"""The `verify` workflow phase: `verify.loop`, driven by the build.

`workflows.runner.run_skill_phase` hands a phase whose id is in
`CUSTOM_EXECUTORS` to its executor instead of a one-shot session; this is the
one for `verify`. It resolves what every skill phase resolves — the phase's
provider and model, the skill body *with that provider's overlays*, the
project's binding rules — and gives the loop an `AgentRunner` built on
`create_agent_client`, so the fixer and the verifier run on the provider the
task configured for its QA phase, whichever it is.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = ["run_verify_phase", "make_agent_runner"]


def make_agent_runner(
    project_dir: Path,
    spec_dir: Path,
    *,
    model: str,
    provider: str | None,
    verbose: bool = False,
    config_phase: str = "qa",
    roster: str | None = None,
    use_subagents: bool = True,
):
    """An `AgentRunner` on `create_agent_client` — one fresh session per call."""

    async def runner(agent_type: str, prompt: str) -> tuple[str, str]:
        from agents.session import run_agent_session
        from core.client import create_agent_client
        from phase_config import get_phase_model, get_phase_thinking_budget
        from task_logger import LogPhase

        # Every verification session starts from nothing: a fixer that
        # inherits the coder's transcript re-argues its choices, and a verifier
        # that does is not a second look. The resume marker is lifted and put
        # back, like `fresh-context` does in the runner.
        stashed = os.environ.pop("AUTO_CLAUDE_RESUME_SESSION_ID", None)
        try:
            client = create_agent_client(
                project_dir=project_dir,
                spec_dir=spec_dir,
                model=get_phase_model(spec_dir, config_phase, model),
                agent_type=agent_type,
                max_thinking_tokens=get_phase_thinking_budget(spec_dir, config_phase),
                use_subagents=use_subagents,
                roster=roster if agent_type == "verifier" else None,
                provider=provider,
            )
            async with client:
                status, response, _err = await run_agent_session(
                    client, prompt, spec_dir, verbose, phase=LogPhase.VALIDATION
                )
            return status, response or ""
        except Exception as exc:  # noqa: BLE001 - a session that fails is a result
            logger.warning("verify: %s session failed: %s", agent_type, exc)
            return "error", str(exc)[:500]
        finally:
            if stashed is not None:
                os.environ["AUTO_CLAUDE_RESUME_SESSION_ID"] = stashed

    return runner


def _context(project_dir: Path, spec_dir: Path) -> str:
    """The binding rules a skill phase receives, for the verifier too."""
    parts = []
    try:
        from workflows.runner import _constitution, _docintel, _mobile

        for section in (
            _constitution(project_dir),
            _mobile(project_dir),
            _docintel(project_dir, spec_dir),
        ):
            if section:
                parts.append(section)
    except Exception:  # noqa: BLE001
        pass
    return "\n\n---\n\n".join(parts)


async def run_verify_phase(resolved, ctx):
    """Run the loop for a build and report it as a `PhaseOutcome`. Never raises."""
    from workflows.runner import (
        CONFIG_PHASE,
        PhaseOutcome,
        _write_output,
        find_skill_body,
        phase_provider,
        subagents_allowed,
    )

    from .loop import LoopOptions, run_verify_loop
    from .record import VERDICT_LINE, render_report

    phase = resolved.phase
    config_phase = CONFIG_PHASE.get(phase.id, "qa")
    explicit, provider = phase_provider(ctx.spec_dir, config_phase)
    found = find_skill_body(ctx.repo_root, phase.pack, phase.skill, provider)
    body = found[0] if found else ""

    def _log(message: str) -> None:
        print(f"  {message}", flush=True)

    runner = make_agent_runner(
        Path(ctx.project_dir),
        Path(ctx.spec_dir),
        model=ctx.model,
        provider=explicit,
        verbose=ctx.verbose,
        config_phase=config_phase,
        roster=phase.roster,
        use_subagents=subagents_allowed(resolved.dispatch),
    )
    options = LoopOptions(
        provider=provider or "",
        model=ctx.model,
        effort=ctx.effort,
        changed_files=ctx.changed_files,
        skill_body=body,
        context=_context(Path(ctx.project_dir), Path(ctx.spec_dir)),
        log=_log,
    )
    try:
        record = await run_verify_loop(ctx.project_dir, ctx.spec_dir, runner, options)
    except Exception as exc:  # noqa: BLE001
        return PhaseOutcome(
            phase.id, phase.impl, resolved.dispatch, None, detail=str(exc)[:200]
        )

    report = render_report(record)
    output = _write_output(ctx, phase.id, report)
    status = record.get("status")
    detail = record.get("reason") or ""
    if record.get("score") is not None:
        detail = f"score {record['score']}/100" + (f" — {detail}" if detail else "")
    if status == "pass":
        succeeded: bool | None = True
    elif status == "fail":
        succeeded = False
    else:
        succeeded = None
        detail = f"{status}: {detail}" if detail else str(status)
    logger.debug("verify phase: %s", VERDICT_LINE.get(status, "Verify: unknown"))
    return PhaseOutcome(
        phase.id,
        phase.impl,
        resolved.dispatch,
        succeeded,
        detail=detail,
        output_path=output,
    )
