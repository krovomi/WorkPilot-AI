"""The built-in Claude Code tools a session is offered at all.

`disallowed_tools` (`undeclared_builtin_tools`) removes the guarded tools a
type does not declare, but every other built-in of the Claude Code CLI stays in
the request: Agent, Workflow, Monitor, SendMessage, the Cron and worktree
tools, DesignSync… Their schemas are re-read on every API turn of every
session. On a trivial card (2026-11-28) that was about 20 k tokens of a 31–57 k
prefix, read 27 times: half of the 1.13 M cache reads the card was billed for,
for tools no WorkPilot agent calls.

The SDK's `tools` option sets the CLI's *base* set (`--tools`): only the names
listed exist for the model. This module turns the type's declaration into that
list, so a summarizer gets no built-in tool at all and a reviewer only what it
declares. MCP tools are not built-ins and are untouched; `ToolSearch` stays so
the CLI can still defer them.

The other providers already work this way: `ToolExecutor` offers only the
declared tools.

`WORKPILOT_CLI_TOOL_BASE=0` gives the CLI's full default set back.
"""

from __future__ import annotations

import os
from collections.abc import Iterable, MutableMapping
from typing import Any

from .permissions import declared_tools

#: Turns the restriction off (the CLI's own default set).
ENV = "WORKPILOT_CLI_TOOL_BASE"

#: Built-ins a declaration can name (`AGENT_CONFIGS[...]["tools"]`), with the
#: CLI tools each one brings.
DECLARABLE: dict[str, tuple[str, ...]] = {
    "Read": ("Read",),
    "Glob": ("Glob",),
    "Grep": ("Grep",),
    "Write": ("Write",),
    "Edit": ("Edit", "MultiEdit", "NotebookEdit"),
    "Bash": ("Bash",),
    "WebFetch": ("WebFetch",),
    "WebSearch": ("WebSearch",),
}

#: Kept for every session that has any tool: it is how the CLI defers MCP
#: tools instead of sending each schema on every turn.
TOOL_SEARCH = "ToolSearch"

#: The tool through which a session dispatches its sub-agents.
SUBAGENT_TOOL = "Agent"

#: How the coder reaches the skills of the project and of ~/.claude.
SKILL_TOOL = "Skill"

_OFF = frozenset({"0", "false", "no", "off"})


def enabled(environ: MutableMapping[str, str] | None = None) -> bool:
    value = (os.environ if environ is None else environ).get(ENV, "")
    return value.strip().lower() not in _OFF


def builtin_tool_base(
    agent_type: str,
    *,
    subagents: bool = False,
    skills: bool = False,
    extra: Iterable[str] = (),
    disallowed: Iterable[str] = (),
) -> list[str] | None:
    """The `tools` option of one session, or ``None`` to leave the CLI's default.

    ``None`` for a type nobody registered (as `declared_tools`), and when the
    switch is off. An empty list means no built-in tool.
    """
    if not enabled():
        return None
    declared = declared_tools(agent_type)
    if declared is None:
        return None
    base: list[str] = []
    for grant in sorted(declared):
        base.extend(DECLARABLE.get(grant, ()))
    if subagents:
        base.append(SUBAGENT_TOOL)
    if skills:
        base.append(SKILL_TOOL)
    base.extend(extra)
    denied = set(disallowed)
    base = [tool for tool in dict.fromkeys(base) if tool not in denied]
    if base:
        base.append(TOOL_SEARCH)
    return base


def restrict_builtin_tools(
    options: MutableMapping[str, Any], agent_type: str, *, extra: Iterable[str] = ()
) -> None:
    """Set `options["tools"]` from the type's declaration (see module doc).

    Reads what the factory already decided: sub-agents (`agents`), the
    settings sources that carry the person's skills (`user`), and the
    `disallowed_tools`, which always win.
    """
    base = builtin_tool_base(
        agent_type,
        subagents=bool(options.get("agents")),
        skills="user" in (options.get("setting_sources") or ()),
        extra=extra,
        disallowed=options.get("disallowed_tools") or (),
    )
    if base is not None:
        options["tools"] = base


__all__ = ["ENV", "builtin_tool_base", "enabled", "restrict_builtin_tools"]
