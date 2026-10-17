"""The tools a WorkPilot loop sends: fixed for the session, and weighed.

The clients that run their loop themselves (OpenAI and the compatible
providers, Ollama and LM Studio, Copilot, Windsurf) send their tool definitions
on every call. ``session_tools`` puts them in canonical form
(``harness.domain.tools``) once, when the session starts, and holds them: a
second preparation in the same session keeps the first set and says so. The
loops then send that set unchanged, turn after turn.

``tool_weights`` measures what each agent type's set weighs in the prefix, in
the unit of the context gauge (``context_mgmt.guard.CHARS_PER_TOKEN``). The
CLIs (Claude Code, Codex, OpenCode, Antigravity, pi) bring their own tools: their
weight is theirs to report.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from harness.domain.tools import ToolSet, ToolSetChanged, hold

logger = logging.getLogger(__name__)


def chars_per_token() -> int:
    """The context gauge's ratio, so a weight reads in the gauge's unit."""
    from context_mgmt.guard import CHARS_PER_TOKEN

    return CHARS_PER_TOKEN


def session_tools(
    definitions: Iterable[Mapping[str, Any]],
    *,
    held: ToolSet | None = None,
    owner: str = "client",
) -> ToolSet:
    """The session's tool set: ``definitions`` in canonical form, or ``held``.

    ``held`` is the set the session already sends, if any: a different one is
    refused (``hold``), logged, and the session keeps its own.
    """
    offered = ToolSet.of(definitions)
    if held is None:
        logger.info(
            "[%s] session tools: %d, ~%d tokens, fingerprint %s",
            owner,
            len(offered.tools),
            offered.tokens(chars_per_token()),
            offered.fingerprint[:12],
        )
        return offered
    try:
        return hold(held, offered)
    except ToolSetChanged as exc:
        logger.warning("[%s] %s: the session keeps its first set", owner, exc)
        return held


def tool_weights(
    agent_types: Iterable[str] | None = None,
    spec_dir: Path | str | None = None,
) -> dict[str, ToolSet]:
    """Each agent type's tool set as the executor offers it on this machine.

    The brain's tools count when a brain exists here, ui-ux's when
    ``spec_dir`` is a UI task: what a session would send, not a theoretical
    maximum. The MCP servers a project bridges come on top.
    """
    from agents.tools_pkg.models import AGENT_CONFIGS
    from core.runtimes.tool_executor import get_tool_definitions

    types = sorted(AGENT_CONFIGS) if agent_types is None else list(agent_types)
    return {
        agent_type: ToolSet.of(get_tool_definitions(agent_type, spec_dir))
        for agent_type in types
    }
