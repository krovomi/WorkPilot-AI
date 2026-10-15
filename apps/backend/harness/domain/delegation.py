"""Delegation to a sub-agent, as every provider without a native one runs it.

The Claude Agent SDK runs a roster natively: ``agents=`` on the client and the
``Agent`` tool the model calls. Every other provider WorkPilot drives through
its own loop (``harness.application.loop``) had nothing: the roster was
composed, logged, and never reached the model. This module is the
provider-free half of giving them one:

* ``DELEGATE_TOOL`` — the one tool the parent sees, whose description names
  the specialists it may call (that is how the model picks one, exactly as the
  SDK matches on an ``AgentDefinition``'s ``description``).
* ``executor_tools`` — a specialist's tools, written in the registry's
  vocabulary (Claude Code's: ``Read``, ``Grep``, ``Bash``…), translated to the
  executor's (``read_file``, ``search_files``, ``run_command``…). An unknown
  name is dropped, never passed through: the executor would answer "Unknown
  tool" on every call and the schema would be paid for nothing.
* ``child_system_prompt`` — what the child session is told, once: that it is a
  sub-agent, its role, and the return contract (``harness.domain.subagents``).

Pure; the session that runs the child lives in ``harness.application.delegation``.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from .subagents import RESULT_CAP_TOKENS, with_contract

DELEGATE_TOOL = "delegate"

#: Turns a child session may take. A specialist answers one question; past
#: this it is wandering, and the parent is still paying for its roster.
CHILD_MAX_TURNS = 20

#: What a child is told first. Kept short: it is paid once per delegation.
CHILD_PREAMBLE = (
    "You are a sub-agent: a parent agent gave you one task and a role for it. "
    "Work in the project directory with the tools you are given, then report. "
    "You cannot delegate further.\n\n"
)

#: The registry's tool names (Claude Code's vocabulary, see
#: ``capabilities/harnesses.yaml``) to the executor's. ``list_files`` comes
#: with reading and globbing: a reader who cannot list a directory guesses
#: paths.
TOOL_TRANSLATION: Mapping[str, tuple[str, ...]] = {
    "Read": ("read_file", "list_files"),
    "Grep": ("search_files",),
    "Glob": ("find_files", "list_files"),
    "Bash": ("run_command",),
    "Write": ("write_file", "create_directory"),
    "Edit": ("write_file",),
    "MultiEdit": ("write_file",),
    "NotebookEdit": ("write_file",),
}


def executor_tools(registry_tools: Iterable[str]) -> frozenset[str]:
    """The executor tools a specialist declared in the registry's vocabulary.

    Names already in the executor's vocabulary pass through, so a definition
    written for the loop (``search_code``) needs no translating.
    """
    executor_names = {name for names in TOOL_TRANSLATION.values() for name in names}
    out: set[str] = set()
    for tool in registry_tools:
        if tool in TOOL_TRANSLATION:
            out.update(TOOL_TRANSLATION[tool])
        elif tool in executor_names or tool == "search_code":
            out.add(tool)
    return frozenset(out)


def _description_of(definition: Any) -> str:
    if isinstance(definition, Mapping):
        return str(definition.get("description") or "")
    return str(getattr(definition, "description", "") or "")


def delegate_tool_definition(agents: Mapping[str, Any]) -> dict[str, Any]:
    """The ``delegate`` tool, its description listing the roster.

    One tool, not one per specialist: the set of tools is fixed for the
    session and sits in the cached prefix (``harness.domain.tools``), and a
    single schema costs the same whatever the roster's size — only the
    description grows, by one line per specialist.
    """
    lines = [
        "Hand one self-contained task to a specialist sub-agent, which works "
        "in a fresh context with its own tools and returns only its "
        "conclusion. Use it for work whose detail you do not need in your "
        "own context (running the tests, surveying an unfamiliar area, "
        "reviewing a diff). Several delegations in one turn run in parallel.",
        "",
        "Specialists:",
    ]
    for name in sorted(agents):
        lines.append(f"- {name}: {_description_of(agents[name]).strip()}")
    return {
        "name": DELEGATE_TOOL,
        "description": "\n".join(lines),
        "parameters": {
            "type": "object",
            "properties": {
                "agent": {
                    "type": "string",
                    "enum": sorted(agents),
                    "description": "The specialist to hand the task to.",
                },
                "task": {
                    "type": "string",
                    "description": (
                        "The task, complete and self-contained: the specialist "
                        "sees nothing of your conversation. Name the files, "
                        "the question, and what a good answer contains."
                    ),
                },
            },
            "required": ["agent", "task"],
        },
    }


def child_system_prompt(
    role_prompt: str, *, project_dir: str, cap_tokens: int = RESULT_CAP_TOKENS
) -> str:
    """What the child session reads as its system prompt."""
    return (
        f"{CHILD_PREAMBLE}Project directory: {project_dir}\n\n"
        f"{with_contract(role_prompt, cap_tokens)}"
    )


def is_delegation(tool_name: str) -> bool:
    return tool_name == DELEGATE_TOOL
