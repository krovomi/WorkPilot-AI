"""
Core Framework Module
=====================

Core components for the WorkPilot AI autonomous coding framework.
"""

# Note: We use lazy imports here because the full agent module has many dependencies
# that may not be needed for basic operations like workspace management.

# Light, and registers the provider/model label of the backend log lines
# (foundation.colored_logs cannot import core).
from . import model_info as _model_info  # noqa: F401

__all__ = [
    "run_autonomous_agent",
    "run_followup_planner",
    "WorkspaceManager",
    "WorktreeManager",
    "ProgressTracker",
    "create_agent_client",
    "AgentClient",
]


def __getattr__(name):
    """Lazy imports to avoid circular dependencies and heavy imports."""
    if name in ("run_autonomous_agent", "run_followup_planner"):
        from .agent import run_autonomous_agent, run_followup_planner

        return locals()[name]
    elif name == "WorkspaceManager":
        from .workspace import WorkspaceManager

        return WorkspaceManager
    elif name == "WorktreeManager":
        from .worktree import WorktreeManager

        return WorktreeManager
    elif name == "ProgressTracker":
        from .progress import ProgressTracker

        return ProgressTracker
    elif name in ("create_claude_client", "ClaudeClient"):
        from . import client as _client

        return getattr(_client, name)
    elif name == "create_agent_client":
        from .client import create_agent_client

        return create_agent_client
    elif name == "AgentClient":
        from .agent_client import AgentClient

        return AgentClient
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
