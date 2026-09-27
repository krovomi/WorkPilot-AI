"""
Memory Helpers (formerly Graphiti)
==================================

The names callers have always imported, now answered by the vault.

Graphiti / LadybugDB used to be the "primary" memory when ``GRAPHITI_ENABLED``
was set, with files under ``<spec_dir>/memory/`` as the "fallback": two stores,
and which one a reader got depended on a switch the writer may not have seen.
There is one store now — the shared Obsidian vault (`brain.project_memory`) —
and these functions return it, with the same method surface
(``save_gotcha``, ``get_patterns_and_gotchas``, ``close``…), so no caller had
to learn a new API. New code imports from `memory.store`.
"""

import asyncio
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .store import get_project_memory, is_memory_enabled

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from brain.project_memory import ProjectMemory


def is_graphiti_memory_enabled() -> bool:
    """Whether memory is on — the vault, whatever ``GRAPHITI_ENABLED`` says."""
    return is_memory_enabled()


async def get_graphiti_memory(
    spec_dir: Path, project_dir: Path | None = None
) -> "ProjectMemory | None":
    """The project's memory in the vault, or ``None`` when memory is off."""
    return get_project_memory(spec_dir, project_dir)


def run_async(coro):
    """
    Run an async coroutine synchronously.

    NOTE: This should only be called from synchronous code. For async callers,
    use the async function directly with await to ensure proper execution.
    """
    try:
        asyncio.get_running_loop()
        logger.warning(
            "run_async called from async context. "
            "Use await directly for proper execution."
        )
        coro.close()
        return None
    except RuntimeError:
        return asyncio.run(coro)


async def save_to_graphiti_async(
    spec_dir: Path,
    session_num: int,
    insights: dict[str, Any],
    project_dir: Path | None = None,
) -> bool:
    """Save a session's insights (and its discoveries) to the vault."""
    memory = get_project_memory(spec_dir, project_dir)
    if memory is None:
        return False
    try:
        return await memory.save_session_insights(session_num, insights)
    finally:
        await memory.close()
