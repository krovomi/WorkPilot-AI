"""
Security Hooks
==============

Pre-tool-use hooks that validate bash commands for security.
Main enforcement point for the security system.
"""

import os
from pathlib import Path
from typing import Any

from project_analyzer import BASE_COMMANDS, SecurityProfile

from .command_guard import validate_command_line
from .profile import get_security_profile


async def bash_security_hook(
    input_data: dict[str, Any],
    tool_use_id: str | None = None,
    context: Any | None = None,
) -> dict[str, Any]:
    """
    Pre-tool-use hook that validates bash commands using dynamic allowlist.

    This is the main security enforcement point. It:
    1. Validates tool_input structure (must be dict with 'command' key)
    2. Extracts command names from the command string
    3. Checks each command against the project's security profile
    4. Runs additional validation for sensitive commands
    5. Blocks disallowed commands with clear error messages

    Args:
        input_data: Dict containing tool_name and tool_input
        tool_use_id: Optional tool use ID
        context: Optional context

    Returns:
        Empty dict to allow, or hookSpecificOutput with permissionDecision "deny" to block
    """
    if input_data.get("tool_name") != "Bash":
        return {}

    # Validate tool_input structure before accessing
    tool_input = input_data.get("tool_input")

    # Check if tool_input is None (malformed tool call)
    if tool_input is None:
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "Bash tool_input is None - malformed tool call from SDK",
            }
        }

    # Check if tool_input is a dict
    if not isinstance(tool_input, dict):
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": f"Bash tool_input must be dict, got {type(tool_input).__name__}",
            }
        }

    # Now safe to access command
    command = tool_input.get("command", "")
    if not command:
        return {}

    # Get the working directory from context or use current directory
    # Priority:
    # 1. Environment variable PROJECT_DIR_ENV_VAR (set by agent on startup)
    # 2. input_data cwd (passed by SDK in the tool call)
    # 3. Context cwd (should be set by ClaudeSDKClient but sometimes isn't)
    # 4. Current working directory (fallback, may be incorrect in worktree mode)
    from .constants import PROJECT_DIR_ENV_VAR

    cwd = os.environ.get(PROJECT_DIR_ENV_VAR)
    if not cwd:
        cwd = input_data.get("cwd")
    if not cwd and context and hasattr(context, "cwd"):
        cwd = context.cwd
    if not cwd:
        cwd = os.getcwd()

    allowed, reason = validate_command_line(command, _profile_for(Path(cwd)))
    if not allowed:
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        }

    return {}


def _profile_for(project_dir: Path) -> SecurityProfile:
    """The project's security profile, or the base commands when it cannot be
    built: failing closed on the project's own additions, not on `ls`."""
    # Note: In actual use, spec_dir would be passed through context
    try:
        return get_security_profile(project_dir)
    except Exception as e:
        print(f"Warning: Could not load security profile: {e}")
        profile = SecurityProfile()
        profile.base_commands = BASE_COMMANDS.copy()
        return profile


async def guardrail_refusal(
    tool_name: str, tool_input: dict[str, Any], project_dir: Path
) -> str | None:
    """Why the user's guardrails deny this call, or ``None``.

    `guardrails_hook`'s answer — `create_client` registers it on `Bash` and on
    every write tool — for the providers that never reach the hook.
    """
    from .guardrails import guardrails_hook

    verdict = await guardrails_hook(
        {"tool_name": tool_name, "tool_input": tool_input},
        project_root=project_dir,
    )
    output = verdict.get("hookSpecificOutput") or {}
    if output.get("permissionDecision") == "deny":
        return output.get("permissionDecisionReason") or "Refused by a guardrail"
    return None


async def command_refusal(command: str, project_dir: Path) -> str | None:
    """Why `command` may not run in `project_dir`, or ``None`` when it may.

    The answer `create_client`'s two `Bash` hooks give — the project's command
    allowlist (`bash_security_hook`), then the user's guardrails — for the
    providers that never reach them: Copilot, OpenAI and its kin, Windsurf and
    LiteLLM run their commands through `ToolExecutor._run_command`, which
    validated nothing. Judged on the command as the model wrote it; the
    allowlist sees through an `rtk` prefix itself.
    """
    allowed, reason = validate_command_line(command, _profile_for(project_dir))
    if not allowed:
        return reason
    return await guardrail_refusal("Bash", {"command": command}, project_dir)


def validate_command(
    command: str,
    project_dir: Path | None = None,
) -> tuple[bool, str]:
    """
    Validate a command string (for testing/debugging).

    Answers from `validate_command_line`, the same function the hook uses.
    This used to be a second copy of the logic, and the copies had already
    drifted: on a command with no matching segment the hook handed the
    validator the unwrapped line and this handed it the raw one.

    Args:
        command: Full command string to validate
        project_dir: Optional project directory (uses cwd if not provided)

    Returns:
        (is_allowed, reason) tuple
    """
    if project_dir is None:
        project_dir = Path.cwd()

    profile = get_security_profile(project_dir)
    return validate_command_line(command, profile)
