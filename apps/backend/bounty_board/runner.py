"""
Bounty Board — running one contestant.

This is the half of the feature that was never actually wired up. The previous
runner opened with::

    from llm_client import acomplete

`llm_client` is `core.llm_client`, the runner only puts `apps/backend` on the
path, and `acomplete` does not exist in that module under any name. So the
import raised `ImportError` on every run, and the handler below it — written
for an environment where the multi-provider client "was not wired up yet" —
answered with a deterministic stub::

    contestant.output = f"[stub:{provider}:{model}] {prompt[:200]}"

Every bounty ever run scored that string. Because the stub embeds the
contestant's own `provider:model`, the only thing that varied between
contestants was the length of their model's name, and the board reported a
winner with two decimal places of confidence. The warning that said so went to
a logger nobody reads: the runner is spawned by the Electron main process and
its stderr is only surfaced when the process exits non-zero.

Hence the two rules here:

* **One dispatch path, the repository's own.** `core.client.create_agent_client`
  takes an explicit `provider`, which is exactly what a board of heterogeneous
  contestants needs — and it is the entry point every other phase uses, so a
  provider added to WorkPilot is a provider the board can field without a line
  of code here.
* **No fallback that produces a scoreable answer.** A contestant whose client
  cannot be built, or whose session raises, ends `status="error"` with the
  reason attached, which the judge scores 0 and the card renders in red. A
  wrong answer nobody can see is worse than a visible failure.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

from .models import Contestant

logger = logging.getLogger(__name__)


CONTESTANT_PREAMBLE = """You are one entry in a blind code contest.

Implement the specification below in the repository you are working in. Other
entries are implementing the same specification independently; you cannot see
them and they cannot see you.

Your entry is judged on the change you leave in the working tree: whether the
project's own test suite passes, and whether the diff satisfies the
specification. Nothing you write in your answer is scored — only what you
change on disk. A small correct change beats a large one that does not build.

## Specification

"""


def contestant_prompt(contestant: Contestant, spec_prompt: str) -> str:
    """Build the prompt for one contestant.

    `prompt_override` is honoured here. It was parsed from the command line,
    carried on `ContestantSpec`, and then dropped on the floor by
    `_materialize`, so the per-contestant strategy the UI offers ("Refactor
    aggressively" / "Prioritize readability") reached no model. An override is
    an instruction *added* to the brief, never a replacement for it: a
    contestant that received only "Prioritize readability" would not know what
    to build.
    """
    parts = [CONTESTANT_PREAMBLE, spec_prompt.strip()]
    if override := (contestant.prompt_override or "").strip():
        parts.append(f"\n\n## Additional instruction for this entry\n\n{override}")
    return "".join(parts)


async def default_contestant_runner(
    contestant: Contestant,
    spec_prompt: str,
    worktree: Path,
) -> None:
    """Run one contestant to completion inside its own worktree.

    Mutates `contestant` in place: status, output, usage, timings, and `error`
    when it failed. Never raises — a contestant that blows up must not take the
    other contestants' results down with it, since they run under one
    `asyncio.gather`.
    """
    prompt = contestant_prompt(contestant, spec_prompt)
    start = time.time()
    contestant.started_at = int(start * 1000)
    contestant.status = "running"

    try:
        from agents.session import run_agent_session
        from core.client import create_agent_client
    except ImportError as exc:
        contestant.status = "error"
        contestant.error = (
            f"Agent client unavailable ({exc}). The bounty board runs real "
            "providers; there is no offline stub."
        )
        logger.error("Contestant %s: %s", contestant.label, contestant.error)
        _finish(contestant)
        return

    # Un fournisseur sans adaptateur agentique (mistral, deepseek, grok, meta,
    # aws, cursor, custom) est exécuté par le SDK Claude — le bon compromis pour
    # un build, puisque la tâche tourne, et le mauvais ici : la victoire serait
    # enregistrée au nom d'un éditeur qui n'a jamais vu le prompt. C'est la
    # règle que le Mode Arena applique déjà avec `require_provider`, et elle
    # vaut mot pour mot pour un concours.
    try:
        from skills_registry.providers import get_provider_capabilities

        caps = get_provider_capabilities((contestant.provider or "").lower())
        if not caps.has_adapter:
            contestant.status = "error"
            contestant.error = (
                f"Provider '{contestant.provider}' has no agentic adapter here: "
                f"it would run on {caps.degrades_to or 'claude'}, and the result "
                "would carry a name that never saw the prompt."
            )
            logger.warning("Contestant %s: %s", contestant.label, contestant.error)
            _finish(contestant)
            return
    except Exception:  # noqa: BLE001 — la matrice manquante ne bloque pas un round
        logger.debug("provider capability matrix unavailable", exc_info=True)

    try:
        client = create_agent_client(
            project_dir=worktree,
            spec_dir=Path(contestant.spec_dir) if contestant.spec_dir else worktree,
            model=contestant.model,
            agent_type="coder",
            provider=contestant.provider,
        )
        async with client:
            status, response, error_info = await run_agent_session(
                client,
                prompt,
                Path(contestant.spec_dir) if contestant.spec_dir else worktree,
            )

        contestant.output = response or ""
        usage = getattr(client, "last_usage", None) or {}
        contestant.tokens_used = int(usage.get("input_tokens", 0) or 0) + int(
            usage.get("output_tokens", 0) or 0
        )
        contestant.cost_usd = float(usage.get("cost_usd", 0.0) or 0.0)

        if status == "error":
            contestant.status = "error"
            contestant.error = str(error_info.get("message") or "agent session failed")
        else:
            contestant.status = "completed"
    except Exception as exc:  # noqa: BLE001 - reported, never swallowed
        contestant.status = "error"
        contestant.error = f"{type(exc).__name__}: {exc}"
        logger.exception(
            "Contestant %s (%s:%s) failed",
            contestant.label,
            contestant.provider,
            contestant.model,
        )
    finally:
        _finish(contestant)


def _finish(contestant: Contestant) -> None:
    contestant.completed_at = int(time.time() * 1000)
    contestant.duration_ms = max(
        0, contestant.completed_at - (contestant.started_at or contestant.completed_at)
    )
