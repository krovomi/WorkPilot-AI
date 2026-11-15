"""
Tool Input Validator
====================

Reads a tool call's input for display: a missing or malformed input becomes
an empty dict instead of an exception. It refuses nothing.
"""

from typing import Any


def get_safe_tool_input(block: Any, default: dict | None = None) -> dict:
    """
    Safely extract tool_input from a ToolUseBlock, defaulting to empty dict.

    Args:
        block: A ToolUseBlock from Claude SDK
        default: Default value if extraction fails (defaults to empty dict)

    Returns:
        The tool input as a dict (never None)
    """
    if default is None:
        default = {}

    if not hasattr(block, "input"):
        return default

    tool_input = block.input
    if tool_input is None:
        return default

    if not isinstance(tool_input, dict):
        return default

    return tool_input
