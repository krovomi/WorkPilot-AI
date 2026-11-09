"""
Core Framework Module
=====================

Core components for the WorkPilot AI autonomous coding framework.
"""

# Note: We use lazy imports here because the full agent module has many dependencies
# that may not be needed for basic operations like workspace management.

# First: `src.connectors` (provider config, Jira, Azure DevOps) is imported
# below and by every runner; in the repository and the server image it sits
# at the root, which no runner had on its path (F173).
from foundation.connectors_path import ensure_connectors_on_path

ensure_connectors_on_path()

# Light, and registers the provider/model label of the backend log lines
# (foundation.colored_logs cannot import core).
# Light too: installs the agent_runtime port, through which the units below
# core (merge, integrations, analysis, architecture) start a session.
from . import agent_runtime as _agent_runtime  # noqa: F401
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
