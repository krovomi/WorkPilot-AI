"""Running a command of the Kanban's Quick-Command bar.

The bar used to ``POST /api/slash-commands/run``: the desktop backend server
ran the agent itself, in the project folder, with the server's own
environment (F181). Two things went wrong there:

* the server is started once, with the main process environment, and never
  receives what a run needs: the Claude profile's sign-in, the provider chosen
  in the app and its key. A Claude subscription (OAuth) was not found, the run
  stopped on "No OAuth token found", and every other provider was ignored;
* the agent wrote straight into the person's checkout, on whatever branch was
  checked out, without a review.

A command now runs like every page that writes code: the Electron main opens
a Kanban review card, starts ``runners/slash_command_runner.py`` in the card's
worktree with the environment every page runner gets (``pythonRunnerEnv``:
the provider of the app, its key, the Claude profile), then commits what the
agent wrote on the card's branch (docs/architecture/generated-review.md).

This module is what the runner calls: it resolves the command's instructions
from the project the palette listed them from, and runs them with a
tool-enabled agent on the active provider, whatever it is.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from slash_commands.api import resolve_command_instructions

logger = logging.getLogger(__name__)

# Build/availability failures of the tool-enabled path that should degrade to
# a single-turn completion (vs a genuine workflow runtime error, surfaced as-is).
_AGENT_FALLBACK_PREFIXES = (
    "agent runner not available",
    "failed to build agent client",
)


def resolve_prompt(project_dir: Path, command: str, args: str) -> str | None:
    """The instructions to run for `/command args`, or None when unknown.

    Read from `project_dir`, the project the palette listed the command
    from, not from the worktree the agent works in: a project's
    `.agents/skills/` may be untracked, and then only the checkout has it.
    """
    body = resolve_command_instructions(project_dir, command)
    if body is None:
        return None
    extra = args.strip()
    return f"{body}\n\nArguments: {extra}" if extra else body


async def _guarded(
    failure: str, call: Callable[[], Awaitable[Any]]
) -> tuple[bool, Any]:
    """`(True, result)` of `call`, or `(False, "<failure>: <error>")`.

    The one place a run's errors are caught: a provider's SDK or CLI may raise
    anything, and the bar must say what went wrong rather than crash.
    """
    try:
        return True, await call()
    except Exception as exc:  # noqa: BLE001 - reported to the person, logged here
        logger.exception("[slash-commands] %s", failure)
        return False, f"{failure}: {exc}"


async def _agent_workflow_call(
    workdir: Path, prompt: str, spec_dir: Path
) -> tuple[bool, str]:
    """Run `prompt` as a multi-turn, tool-enabled agent on the active provider.

    A full task-execution client (read/write/web tools, multi-turn) via
    `core.client.create_agent_client`, so the agent can READ the files a
    workflow refers to (`_bmad/`…), follow its steps and WRITE its outputs.
    The provider is the one the app passed down (`SELECTED_LLM_PROVIDER`):
    Claude, Codex, Copilot, Gemini, OpenCode, Mistral, Ollama…

    Returns (False, "<prefix>: …") with a prefix in `_AGENT_FALLBACK_PREFIXES`
    when the client could not be built, so the caller degrades to a one-shot.
    """
    try:
        from core.client import create_agent_client, peek_active_provider
        from core.oneshot import _extract_text, _resolve_model
    except ImportError as exc:
        return False, f"agent runner not available: {exc}"

    async def build():
        # Peeked: a palette command is not the session a "resume with X"
        # choice was made for, and must not eat it.
        provider = peek_active_provider(spec_dir)
        model = _resolve_model(provider, None, spec_dir)
        # agent_type="coder" carries the read+write+web tool set a workflow needs.
        return create_agent_client(
            project_dir=workdir,
            spec_dir=spec_dir,
            model=model,
            agent_type="coder",
            provider=provider,
        )

    ok, client = await _guarded("failed to build agent client", build)
    if not ok:
        return False, client

    async def converse() -> str:
        text = ""
        async with client:
            await client.query(prompt)
            async for msg in client.receive_response():
                text += _extract_text(msg)
        return text.strip()

    return await _guarded("workflow run failed", converse)


async def _oneshot_call(workdir: Path, prompt: str, spec_dir: Path) -> tuple[bool, str]:
    """A single-turn completion on the active provider, without tools."""
    try:
        from core.oneshot import oneshot_completion
    except ImportError as exc:
        return False, f"oneshot runner not available: {exc}"

    async def complete() -> str:
        text = await oneshot_completion(
            prompt, project_dir=str(workdir), spec_dir=str(spec_dir), max_turns=1
        )
        return (text or "").strip()

    return await _guarded("command run failed", complete)


async def run_prompt(workdir: Path, prompt: str, spec_dir: Path) -> tuple[bool, str]:
    """Run the instructions in `workdir`; (success, text or error message).

    `spec_dir` takes what the agent writes about its own run (context
    snapshot, write trace): never the worktree, or it would be committed with
    the command's work and land in the pull request.

    The tool-enabled agent first; a one-shot completion only when that agent
    could not be built (a genuine workflow error is reported as is).
    """
    ok, text = await _agent_workflow_call(workdir, prompt, spec_dir)
    if not ok and text.startswith(_AGENT_FALLBACK_PREFIXES):
        logger.warning("[slash-commands] %s; falling back to a one-shot", text)
        ok, text = await _oneshot_call(workdir, prompt, spec_dir)
    return ok, text
