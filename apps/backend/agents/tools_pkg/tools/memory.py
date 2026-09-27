"""
Session Memory Tools
====================

Tools for recording and retrieving session memory, including discoveries,
gotchas, and patterns.

One store: the shared Obsidian vault (`brain.project_memory`). A discovery or a
gotcha recorded here is a note under ``knowledge/projects/<project>/memory/``,
recalled by the next session of any spec of the project and by every agent
connected to the brain. It used to be written twice — a file in the spec
directory and, when enabled, Graphiti — and read back from the file only.
"""

from pathlib import Path
from typing import Any

try:
    from claude_agent_sdk import ToolAnnotations, tool

    SDK_TOOLS_AVAILABLE = True
except ImportError:
    SDK_TOOLS_AVAILABLE = False
    tool = None
    ToolAnnotations = None  # type: ignore[assignment,misc]

from memory.store import get_project_memory

_OFF = "Memory is turned off (BRAIN_ENABLED=false): nothing was recorded."


def _text(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}]}


def create_memory_tools(spec_dir: Path, project_dir: Path) -> list:
    """
    Create session memory tools.

    Args:
        spec_dir: Path to the spec directory
        project_dir: Path to the project root

    Returns:
        List of memory tool functions
    """
    if not SDK_TOOLS_AVAILABLE:
        return []

    tools = []

    # -------------------------------------------------------------------------
    # Tool: record_discovery
    # -------------------------------------------------------------------------
    @tool(
        "record_discovery",
        "Record a codebase discovery to the project's memory (the shared brain). "
        "Use this when you learn something important about the codebase.",
        {"file_path": str, "description": str, "category": str},
    )
    async def record_discovery(args: dict[str, Any]) -> dict[str, Any]:
        """Record what a file is for, as a note in the vault."""
        file_path = args["file_path"]
        description = args["description"]
        category = args.get("category", "general")

        memory = get_project_memory(spec_dir, project_dir)
        if memory is None:
            return _text(_OFF)
        try:
            saved = await memory._run(
                lambda: memory.record_discovery(
                    file_path, description, category=category
                )
            )
        finally:
            await memory.close()
        if not saved:
            return _text(f"Error recording discovery for '{file_path}'")
        return _text(f"Recorded discovery for '{file_path}': {description}")

    tools.append(record_discovery)

    # -------------------------------------------------------------------------
    # Tool: record_gotcha
    # -------------------------------------------------------------------------
    @tool(
        "record_gotcha",
        "Record a gotcha or pitfall to avoid, in the project's memory (the shared "
        "brain). Use this when you encounter something that future sessions should know.",
        {"gotcha": str, "context": str},
    )
    async def record_gotcha(args: dict[str, Any]) -> dict[str, Any]:
        """Record a pitfall, as a note in the vault."""
        gotcha = args["gotcha"]
        context = args.get("context", "")

        memory = get_project_memory(spec_dir, project_dir)
        if memory is None:
            return _text(_OFF)
        try:
            saved = await memory._run(
                lambda: memory.record_gotcha(gotcha, context=context)
            )
        finally:
            await memory.close()
        if not saved:
            return _text("Error recording gotcha")
        return _text(f"Recorded gotcha: {gotcha}")

    tools.append(record_gotcha)

    # -------------------------------------------------------------------------
    # Tool: get_session_context
    # -------------------------------------------------------------------------
    @tool(
        "get_session_context",
        "Get what previous sessions learned about this project: discoveries, "
        "gotchas and patterns, from the shared brain.",
        {},
        # Read-only: enables parallel execution alongside other read-only
        # tools (get_build_progress, Read, Grep) in the same turn.
        annotations=ToolAnnotations(readOnlyHint=True),
    )
    async def get_session_context(args: dict[str, Any]) -> dict[str, Any]:
        """The project's accumulated memory."""
        memory = get_project_memory(spec_dir, project_dir)
        if memory is None:
            return _text(_OFF)

        def _read() -> list[str]:
            parts: list[str] = []
            codebase = memory.load_codebase_map()
            if codebase:
                parts.append("## Codebase Discoveries")
                parts.extend(
                    f"- `{path}`: {desc}" for path, desc in list(codebase.items())[:20]
                )
            for title, items in (
                ("Gotchas", memory.load_gotchas()),
                ("Patterns", memory.load_patterns()),
            ):
                if items:
                    parts.append(f"\n## {title}")
                    parts.extend(f"- {item}" for item in items[-15:])
            return parts

        parts = await memory._read(_read)
        if not parts:
            return _text("No project memory yet. This appears to be the first session.")
        return _text("\n".join(parts))

    tools.append(get_session_context)

    return tools
