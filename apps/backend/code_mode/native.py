"""Claude Code's own code mode (its ``REPL`` tool) for a Claude SDK session.

``create_client`` calls :func:`apply` once its options are built. When the
session's code mode is offered (``settings.offered``) and the CLI can honour
it, the variable goes into the ``env`` block of the session's settings file,
the one place a non-interactive CLI reads it from, and a ``PreToolUse`` hook on
``REPL`` copies each script into the spec folder. The calls a script makes
keep their names (``Bash``, ``Write``…), so the hooks already on them apply.

The conditions below are the ones read from the CLI's refusals (spike S2,
``docs/architecture/code-mode.md``). When one is missed, the CLI refuses code
mode and the session runs with its ordinary tools: nothing breaks, the switch
is only not honoured. A code mode session resumes only with code mode on, so a
session that had it and no longer may starts afresh instead of resuming.
"""

from __future__ import annotations

import json
import os
import re
import time
from collections.abc import Mapping, MutableMapping
from pathlib import Path
from typing import Any

from .settings import offered

#: The CLI's own switch, read only from the ``env`` block of ``--settings``.
CLI_VAR = "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE"
#: The CLI's code mode tool.
TOOL = "REPL"
#: Each script the model ran, one JSON object per line, in the spec folder.
SCRIPTS_FILE = "code-mode-scripts.jsonl"
#: Whether the spec's last Claude session ran with code mode.
MARKER_FILE = ".code-mode-native.json"
#: The longest script kept in the record.
MAX_CODE_CHARS = 20_000

_ANTHROPIC_HOSTS = frozenset({"api.anthropic.com"})
#: Variables that send the CLI to a cloud provider, or that it refuses code
#: mode with (custom credentials, unprefixed MCP tool names).
_REFUSING_VARS = (
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_AGENT_SDK_MCP_NO_PREFIX",
)
_FAMILY = re.compile(r"(?:^|[-/.])(opus|sonnet|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)")


def model_supports(model: str | None) -> bool:
    """Opus or Sonnet 5.5 and later, or Fable: the models the CLI accepts."""
    if not isinstance(model, str):
        return False
    found = _FAMILY.search(model.lower())
    if found is None:
        return False
    family, major, minor = found.group(1), int(found.group(2)), found.group(3)
    if family == "fable":
        return True
    return (major, int(minor or 0)) >= (5, 5)


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() not in ("", "0", "false", "no", "off")


def anthropic_api(environ: Mapping[str, str]) -> bool:
    """Whether the CLI talks to the Anthropic API itself, with its own sign-in."""
    if any(_truthy(environ.get(name)) for name in _REFUSING_VARS):
        return False
    base_url = (environ.get("ANTHROPIC_BASE_URL") or "").strip()
    if not base_url:
        return True
    host = re.sub(r"^[a-z]+://", "", base_url.lower()).split("/", 1)[0]
    return host.split(":", 1)[0] in _ANTHROPIC_HOSTS


def task_worktree(project_dir: Path | str) -> bool:
    """Whether the session works in a task's own worktree, not the checkout."""
    parts = Path(project_dir).resolve().parts
    for index in range(len(parts) - 2):
        if parts[index : index + 3] == (".workpilot", "worktrees", "tasks"):
            return len(parts) > index + 3
    return False


def wanted(
    *,
    agent_type: str,
    spec_dir: Path | str | None,
    project_dir: Path | str,
    model: str | None,
    environ: Mapping[str, str],
    disallowed: list[str] | tuple[str, ...] = (),
) -> bool:
    """Whether this Claude session runs with the CLI's code mode."""
    return (
        offered(agent_type, spec_dir, dict(environ))
        and TOOL not in disallowed
        and model_supports(model)
        and anthropic_api(environ)
        and task_worktree(project_dir)
    )


def _read_marker(spec_dir: Path | None) -> bool:
    if spec_dir is None:
        return False
    try:
        data = json.loads((spec_dir / MARKER_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and data.get("on") is True


def _write_marker(spec_dir: Path | None, on: bool) -> None:
    if spec_dir is None or not spec_dir.is_dir():
        return
    try:
        (spec_dir / MARKER_FILE).write_text(
            json.dumps({"on": on}) + "\n", encoding="utf-8"
        )
    except OSError:
        pass


def make_script_record_hook(spec_dir: Path | None, agent_type: str):
    """A PreToolUse hook on ``REPL`` that keeps each script in the spec folder."""

    async def _hook(
        input_data: dict[str, Any],
        tool_use_id: str | None = None,
        context: Any | None = None,
    ) -> dict[str, Any]:
        if spec_dir is None or input_data.get("tool_name") != TOOL:
            return {}
        tool_input = input_data.get("tool_input")
        code = tool_input.get("code") if isinstance(tool_input, dict) else None
        if not isinstance(code, str):
            return {}
        record = {
            "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "agent": agent_type,
            "id": tool_use_id or "",
            "code": code[:MAX_CODE_CHARS],
        }
        try:
            with open(spec_dir / SCRIPTS_FILE, "a", encoding="utf-8") as out:
                out.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            pass
        return {}

    return _hook


def _add_env(settings_file: Path) -> None:
    data = json.loads(settings_file.read_text(encoding="utf-8"))
    env = data.get("env") if isinstance(data.get("env"), dict) else {}
    data["env"] = {**env, CLI_VAR: "1"}
    settings_file.write_text(json.dumps(data, indent=2), encoding="utf-8")


def apply(
    options: MutableMapping[str, Any],
    settings_file: Path,
    agent_type: str,
    spec_dir: Path | str | None,
    project_dir: Path | str,
    *,
    environ: Mapping[str, str] | None = None,
) -> bool:
    """Turn the CLI's code mode on for this session when it should be.

    ``options`` are the ``ClaudeAgentOptions`` arguments ``create_client``
    built; returns whether code mode is on.
    """
    spec = Path(spec_dir) if spec_dir else None
    merged = {**(os.environ if environ is None else environ)}
    merged.update(options.get("env") or {})
    on = wanted(
        agent_type=agent_type,
        spec_dir=spec,
        project_dir=project_dir,
        model=options.get("model"),
        environ=merged,
        disallowed=options.get("disallowed_tools") or (),
    )
    if not on and options.get("resume") and _read_marker(spec):
        # The session to resume ran with code mode, which it cannot lose.
        options.pop("resume", None)
    if on:
        from claude_agent_sdk import HookMatcher

        _add_env(settings_file)
        hooks = options.setdefault("hooks", {})
        hooks.setdefault("PreToolUse", []).append(
            HookMatcher(matcher=TOOL, hooks=[make_script_record_hook(spec, agent_type)])
        )
    if on or _read_marker(spec):
        # Nothing is written for a session that never had code mode.
        _write_marker(spec, on)
    return on


__all__ = [
    "CLI_VAR",
    "MARKER_FILE",
    "SCRIPTS_FILE",
    "TOOL",
    "anthropic_api",
    "apply",
    "make_script_record_hook",
    "model_supports",
    "task_worktree",
    "wanted",
]
