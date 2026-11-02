"""
WorkPilot AI CLI Package
=======================

Command-line interface for the WorkPilot AI autonomous coding framework.

This package provides a modular CLI structure:
- main.py: Argument parsing and command routing
- spec_commands.py: Spec listing and management
- build_commands.py: Build execution and follow-up tasks
- workspace_commands.py: Workspace management (merge, review, discard)
- qa_commands.py: QA validation commands
- utils.py: Shared utilities and configuration
"""

__all__ = ["main"]


def __getattr__(name: str):
    # Loaded on first use, not on import: `python -m cli.main` (the streaming
    # server) imports this package first, and a cli.main already in
    # sys.modules by then makes runpy warn (RuntimeWarning).
    if name == "main":
        from .main import main as entry_point

        # Importing the submodule bound `cli.main` to the module: rebind the
        # name to the function, as the eager import used to.
        globals()["main"] = entry_point
        return entry_point
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
