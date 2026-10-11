"""
Historical Hints from the Shared Brain
======================================

Cross-session context for the context builder and the GitHub runners: what the
project's memory in the Obsidian vault (`brain.project_memory`) knows about a
task. Whether hints can be asked for at all is ``is_memory_enabled``.
"""

from memory.store import get_graph_hints, is_memory_enabled

__all__ = ["fetch_graph_hints", "is_memory_enabled"]


async def fetch_graph_hints(
    query: str, project_id: str, max_results: int = 5
) -> list[dict]:
    """
    What the shared brain knows about *query* for a project.

    Args:
        query: The task description or query to search for
        project_id: The project directory (its name files the memory)
        max_results: Maximum number of hints to return

    Returns:
        List of hints: ``content``, ``score``, ``type``, ``path``. Never raises.
    """
    if not is_memory_enabled():
        return []
    return await get_graph_hints(
        query=query, project_id=project_id, max_results=max_results
    )
