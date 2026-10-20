"""The PreToolUse hook that puts every agent Bash call through rtk.

This is the change that reaches every feature at once. Planner, coder, QA
reviewer and fixer, the spec pipeline, ideation, the GitHub runners, the
self-healing responder, the architecture map, the mobile phases — none of them
run a command of their own: they all go through `core.client.create_client`,
and this hook is registered there. A phase added next month is covered by
having been written the normal way.

Why it does not decide permissions
----------------------------------
rtk's own shell hook returns ``permissionDecision: "allow"`` alongside the
rewrite, which is right for a person at a terminal — it saves them a prompt for
a command they already implicitly approved. Here it would be wrong twice over.
WorkPilot already grants ``Bash(*)`` in its settings file and gates the real
decision on ``bash_security_hook`` and the guardrails; a second hook returning
"allow" for the same tool call is a second opinion on a question that is
already answered, and on a runner where several PreToolUse hooks vote, the
loudest answer must not be the one that only knows about tokens.

So this hook returns ``updatedInput`` and nothing else. It changes what the
command prints. It never changes whether it runs.
"""

from __future__ import annotations

import logging
from typing import Any

from .rewrite import rewrite_command
from .runtime import is_usable

logger = logging.getLogger(__name__)

__all__ = ["rtk_rewrite_hook"]


async def rtk_rewrite_hook(
    input_data: dict[str, Any],
    tool_use_id: str | None = None,
    context: Any | None = None,
) -> dict[str, Any]:
    """Rewrite a Bash command to its rtk equivalent, or leave it alone.

    Returns ``{}`` for everything it does not touch, which is what the SDK
    reads as "no opinion". Never raises: a hook that throws takes the tool call
    with it, and no token saving is worth a failed build.
    """
    try:
        if input_data.get("tool_name") != "Bash":
            return {}
        if not is_usable():
            return {}

        tool_input = input_data.get("tool_input")
        if not isinstance(tool_input, dict):
            # Malformed input is bash_security_hook's to refuse, with its own
            # message. Answering here would race it with a worse one.
            return {}

        command = tool_input.get("command")
        if not isinstance(command, str) or not command.strip():
            return {}

        outcome = rewrite_command(command)
        if not outcome.changed:
            return {}

        updated = dict(tool_input)
        updated["command"] = outcome.command
        logger.debug("rtk: %s → %s", command[:100], outcome.command[:100])

        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "updatedInput": updated,
            }
        }
    except Exception:  # noqa: BLE001 - a token optimisation never fails a build
        logger.debug("rtk rewrite hook skipped", exc_info=True)
        return {}
