"""`PiCliAgentClient` — an agent turn run by ``pi --mode json``.

What the boundary is, as read from pi's source (`packages/coding-agent/src`,
1.3.0) and from the streams in `tests/fixtures/pi/` (captured against the real
binary by `tests/fixtures/pi/capture.py`); the rationale is in
`docs/architecture/pi.md`:

- ``pi --mode json`` reads the prompt from **stdin** when it is not a TTY and
  prints one JSON object per line: a ``session`` header (``id``, ``cwd``),
  then the session events — ``message_start``/``message_end`` for every role
  (``system``, ``user``, ``assistant``, ``toolResult``), ``message_update``
  (``usage``, ``assistantMessageEvent``), ``tool_execution_start`` (``args``)
  and ``tool_execution_end`` (``result``, ``isError``), ``compaction_*``,
  ``auto_retry_*``, and ``agent_settled`` last. An assistant ``message_end``
  carries ``usage`` (``input`` uncached, ``cacheRead``, ``cacheWrite``,
  ``output``, ``reasoning``, ``cost``), ``stopReason`` and ``errorMessage``.
- The exit status is 0 even when the answer is ``stopReason: "error"`` (a
  401 included): the adapter reads ``stopReason``, never the status.
- ``--session-id <uuid>`` names a new session; ``--session <uuid>`` continues
  it, resolved by exact id inside the directory ``PI_CODING_AGENT_SESSION_DIR``
  names. Sessions of a task live in its spec directory, never in ``~/.pi``.
- ``--tools <names>`` is a real allowlist: a tool outside it does not exist for
  the model, and a call to it is answered ``Tool … not found``. The names come
  from the agent type's declaration through ``capabilities/harnesses.yaml``
  (``pi.tools``), plus pi's MCP names for the servers the type declares.
- ``--skill .agents/skills`` hands the project's skills to pi explicitly: pi
  loads a ``--skill`` directory outside its project-trust gate, which keeps
  guarding ``.pi/`` (extensions run inside the pi process). ``--approve`` is
  never passed; the trust state of ``.pi/`` is reported instead.
- ``--thinking <off|minimal|low|medium|high|xhigh|max>``; a level the model
  does not support is clamped by pi, never refused.
- pi owns its login (``/login`` in its TUI, or the provider's environment
  variable). Nothing here reads a credential.
- ``--mode rpc`` (``WORKPILOT_PI_MODE=rpc``) keeps one process for the whole
  session: commands are JSON lines on stdin (``{"id", "type": "prompt" |
  "abort" | "compact" | "get_state", …}``), answered by ``{"type": "response",
  "id", "command", "success", "data" | "error"}`` among the same events as
  json mode; a turn is over at ``agent_settled``; closing stdin is the
  shutdown. ``extension_ui_request`` is answered ``cancelled``.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import tempfile
import uuid
from collections.abc import AsyncIterator
from contextlib import aclosing
from pathlib import Path
from typing import Any

from core.platform import build_windows_command, find_executable, is_windows
from harness.domain import from_pi_usage

from .base import AgentMessage, MessageRole
from .cli_subprocess import (
    CliSubprocessAgentClient,
    ProcessFactory,
    as_int,
    qualify_provider_model,
    safe_error_text,
    text_message,
    tool_messages,
    validated_option,
)

logger = logging.getLogger(__name__)

__all__ = [
    "ENV_DENYLIST",
    "GUARD_RELATIVE",
    "PI_MODES",
    "PI_THINKING_LEVELS",
    "PiCliAgentClient",
    "PiCliAuthenticationError",
    "PiCliError",
    "build_pi_args",
    "install_pi_guard",
    "pi_guard_policy",
    "pi_mode",
    "pi_thinking_level",
    "pi_tool_allowlist",
    "pi_trust_state",
]

#: How WorkPilot drives pi: a process per turn (`json`) or per session (`rpc`).
PI_MODES = ("json", "rpc")


def pi_mode(mode: str | None = None) -> str:
    """``json`` or ``rpc``: the argument, else ``WORKPILOT_PI_MODE``, else ``json``.

    An unknown value is ``json``, the mode every fixture proves, not an error
    that would stop a build over a typo in a setting.
    """
    candidate = (mode or os.environ.get("WORKPILOT_PI_MODE", "")).strip().lower()
    return candidate if candidate in PI_MODES else "json"


#: The levels `pi --thinking` accepts (cli/args.ts, `isValidThinkingLevel`).
PI_THINKING_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max")

#: WorkPilot's phase levels (`phase_config.THINKING_BUDGET_MAP`) in pi's words.
_THINKING_BY_LEVEL = {
    "none": "off",
    "low": "low",
    "medium": "medium",
    "high": "high",
    "ultrathink": "max",
}

#: pi's directory listing tool. No canonical counterpart, offered with `Read`.
_LS_TOOL = "ls"

#: The project resources pi loads only from a trusted checkout
#: (core/trust-manager.ts, TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES).
_TRUST_GATED_PROJECT_RESOURCES = (
    "settings.json",
    "mcp.json",
    "extensions",
    "skills",
    "prompts",
    "themes",
    "SYSTEM.md",
    "APPEND_SYSTEM.md",
)

#: pi registers an MCP tool as ``mcp__<server>__<tool>`` with every other
#: character replaced (extensions/mcp/tools.ts).
_MCP_NAME_UNSAFE = re.compile(r"[^A-Za-z0-9_]")

#: The relative skills directory handed to pi, resolved by pi from its cwd.
PROJECT_SKILLS_DIR = ".agents/skills"

#: The write guard pi loads with `-e` (lot 4, option B): shipped here, copied
#: into the project before a run, policy handed over by environment.
GUARD_SOURCE = Path(__file__).resolve().parent / "pi_guard" / "workpilot-guard.js"
#: Where the copy lives, relative to the project — the only form a path takes
#: in pi's argument vector. `.workpilot/*` is what WorkPilot already owns in a
#: project (specs, worktrees, status files).
GUARD_RELATIVE = ".workpilot/pi-guard/workpilot-guard.js"
#: The policy's environment variable, read by the guard at load.
GUARD_ENV_VAR = "WORKPILOT_PI_GUARD"

#: Environment variables that never reach the pi process: dynamic-linker and
#: runtime-loader injection (the same names `claude-code-settings/env-sanitizer.ts`
#: refuses from a repository), WorkPilot's own JEV key, and the Claude Code
#: OAuth token, which pi has no use for. A provider credential pi reads itself
#: (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_AUTH_TOKEN`…) stays:
#: that is the process that needs it.
ENV_DENYLIST = frozenset(
    {
        "NODE_OPTIONS",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "LD_AUDIT",
        "DYLD_INSERT_LIBRARIES",
        "DYLD_LIBRARY_PATH",
        "DYLD_FRAMEWORK_PATH",
        "DYLD_FALLBACK_LIBRARY_PATH",
        "DYLD_FALLBACK_FRAMEWORK_PATH",
        "DYLD_VERSIONED_LIBRARY_PATH",
        "DYLD_VERSIONED_FRAMEWORK_PATH",
        "TYPESAFE_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
    }
)

#: What may name a tool in `--tools`: pi's names and MCP names (`mcp__a__b`),
#: or a `*` pattern. Joined with commas, which cmd.exe passes through `%*`
#: untouched; nothing else from the vector is ever parsed as a path or a shell.
_SAFE_TOOL_NAME = re.compile(r"^[A-Za-z0-9_*]+$")

#: A session id WorkPilot names (uuid4) or stored from a previous turn. pi
#: reads `--session` as a *path* as soon as it holds `/`, `\` or ends in
#: `.jsonl`, and writes `--session-id` into a file name: neither may hold
#: anything but these characters (S4: a validated id, never a path).
_SAFE_SESSION_ID = re.compile(r"^[A-Za-z0-9-]{8,64}$")


class PiCliError(RuntimeError):
    """A safe, user-facing failure from the pi boundary."""


class PiCliAuthenticationError(PiCliError):
    """pi has no usable credentials for the selected provider."""


def pi_thinking_level(level: str | None) -> str | None:
    """pi's name for a WorkPilot thinking level, or None when there is none.

    A custom budget (``"12000 tokens"``) is not a level; pi then keeps its own
    default rather than receiving a guess.
    """
    if not level:
        return None
    lowered = level.strip().lower()
    if lowered in PI_THINKING_LEVELS:
        return lowered
    return _THINKING_BY_LEVEL.get(lowered)


def _pi_tool_map() -> dict[str, str]:
    """Canonical tool name → pi's, from ``capabilities/harnesses.yaml``."""
    from skills_registry.harnesses import load_harnesses
    from skills_registry.providers import _REPO_ROOT

    try:
        return dict(load_harnesses(_REPO_ROOT)["pi"].tools)
    except (FileNotFoundError, KeyError):  # pragma: no cover - the matrix ships
        logger.warning("[PiCliAgentClient] capabilities/harnesses.yaml has no pi entry")
        return {}


def pi_tool_allowlist(
    agent_type: str, *, spec_dir: Path | str | None = None
) -> list[str] | None:
    """The ``--tools`` allowlist of an agent type, or None for an unregistered type.

    Built-in names come from the harness matrix (one source for "how pi calls
    `Write`"); a canonical name the matrix does not map (`WebFetch`, `Task`) is
    a right pi cannot grant and is left out rather than guessed. The MCP tools
    of the servers the type declares are named as pi names them. `ls` rides
    with `Read`. `powershell` is never granted: a second shell the command
    allowlist does not see.

    An unregistered type is permissive, as `ToolExecutor` and the other CLIs
    keep it: refusing it everything would break tests and callers outside the
    product rather than protect anything.
    """
    from agents.tools_pkg.models import get_required_mcp_servers
    from agents.tools_pkg.permissions import declared_tools, mcp_tools_for_servers

    declared = declared_tools(agent_type)
    if declared is None:
        return None
    tool_map = _pi_tool_map()
    allowed: list[str] = []
    for canonical in sorted(declared):
        name = tool_map.get(canonical)
        if name and name not in allowed:
            allowed.append(name)
    if "Read" in declared and _LS_TOOL not in allowed:
        allowed.append(_LS_TOOL)
    servers = get_required_mcp_servers(agent_type, spec_dir=spec_dir)
    for mcp_tool in mcp_tools_for_servers(servers):
        name = _MCP_NAME_UNSAFE.sub("_", mcp_tool)
        if name not in allowed:
            allowed.append(name)
    return allowed


def pi_guard_policy(
    project_dir: Path | str, spec_dir: Path | str | None
) -> dict[str, Any]:
    """The write policy the guard enforces, from `security/path_guard`'s tables.

    Roots: the project (worktree), the spec directory, the workpilot scratch
    directory and `WORKPILOT_WRITE_ROOTS` — `resolve_write_roots`, as the SDK
    hook computes them. Protected: the config names and directories the SDK
    hook refuses, plus pi's own `.pi/` and the guard's directory, which hold the
    agent's guardrails on this provider.
    """
    from security.path_guard import (
        PROTECTED_CONFIG_DIRS,
        PROTECTED_CONFIG_NAMES,
        resolve_write_roots,
    )

    project = Path(project_dir)
    return {
        "roots": [str(root) for root in resolve_write_roots(project, spec_dir)],
        "protectedNames": list(PROTECTED_CONFIG_NAMES),
        "protectedDirs": {d: list(p) for d, p in PROTECTED_CONFIG_DIRS.items()},
        "protectedPrefixes": [
            str(project / ".pi"),
            str(project / Path(GUARD_RELATIVE).parent),
        ],
        "caseInsensitive": is_windows(),
    }


def install_pi_guard(project_dir: Path | str) -> Path:
    """Copy the guard into the project; the path pi is given, relative to it.

    Rewritten on every run from the shipped source: a copy an agent managed
    to change (through `bash`, which the guard does not judge) lasts one run,
    and the guard refuses `write`/`edit` under its own directory.
    """
    target = Path(project_dir) / GUARD_RELATIVE
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.is_file() or target.read_bytes() != GUARD_SOURCE.read_bytes():
        shutil.copyfile(GUARD_SOURCE, target)
    return target


def _pi_agent_dir() -> Path:
    from brain.agents import agent as brain_agent

    return brain_agent("pi").resolve("$PI_AGENT_DIR/trust.json").parent


def _trust_key(path: Path) -> str:
    key = str(path.resolve())
    return os.path.normcase(key) if is_windows() else key


def pi_trust_state(project_dir: Path | str, *, agent_dir: Path | None = None) -> str:
    """What pi will do with ``<project>/.pi`` in a run without a UI.

    ``not-needed`` when the project has none of the trust-gated resources;
    otherwise ``trusted``, ``untrusted`` or ``undecided`` from
    ``<agent dir>/trust.json`` — ``{"<canonical path>": true | false}``, the
    nearest ancestor entry deciding, as `core/trust-manager.ts` reads it.
    ``undecided`` means pi silently loads nothing from ``.pi/`` in json mode.
    Nothing here writes that file: trusting a checkout is a person's decision.
    """
    project = Path(project_dir)
    config_dir = project / ".pi"
    if not any(
        (config_dir / entry).exists() for entry in _TRUST_GATED_PROJECT_RESOURCES
    ):
        return "not-needed"
    trust_file = (agent_dir or _pi_agent_dir()) / "trust.json"
    try:
        raw = (
            json.loads(trust_file.read_text(encoding="utf-8"))
            if trust_file.is_file()
            else {}
        )
    except (OSError, ValueError):
        return "undecided"
    if not isinstance(raw, dict):
        return "undecided"
    decisions = {
        _trust_key(Path(key)): value
        for key, value in raw.items()
        if isinstance(key, str) and isinstance(value, bool)
    }
    current = project.resolve()
    while True:
        decision = decisions.get(_trust_key(current))
        if decision is not None:
            return "trusted" if decision else "untrusted"
        if current.parent == current:
            return "undecided"
        current = current.parent


def build_pi_args(
    *,
    executable: str,
    mode: str = "json",
    model: str | None,
    session_id: str,
    resume: bool,
    tools: list[str] | None,
    thinking_level: str | None,
    project_skills: bool,
    guard: bool = True,
) -> list[str]:
    """A shell-free ``pi --mode json`` command. The prompt goes on stdin.

    Every option value passes `validated_option`: the launcher may be a `.cmd`
    parsed by cmd.exe on Windows, so no path, space or shell character enters
    the vector — the session is an id, the skills directory is relative.
    """
    if mode not in PI_MODES:
        raise ValueError(f"Invalid pi mode: {mode!r}")
    args = [executable, "--mode", mode]
    if not isinstance(session_id, str) or not _SAFE_SESSION_ID.fullmatch(session_id):
        raise ValueError(f"Invalid pi session id: {session_id!r}")
    args.extend(["--session" if resume else "--session-id", session_id])
    if model:
        args.extend(["--model", validated_option(model, "model", "pi")])
    if thinking_level:
        if thinking_level not in PI_THINKING_LEVELS:
            raise ValueError(f"Invalid pi thinking level: {thinking_level!r}")
        args.extend(["--thinking", thinking_level])
    if tools is not None:
        for tool in tools:
            if not isinstance(tool, str) or not _SAFE_TOOL_NAME.fullmatch(tool):
                raise ValueError(f"Invalid pi tool name: {tool!r}")
        allowlist = ",".join(tools)
        # An empty allowlist still has to be an allowlist: `--no-tools` keeps the
        # model from every built-in and extension tool.
        args.extend(["--tools", allowlist] if allowlist else ["--no-tools"])
    if project_skills:
        args.extend(["--skill", PROJECT_SKILLS_DIR])
    if guard:
        args.extend(["--extension", GUARD_RELATIVE])
    return args


def _pi_error(value: object) -> PiCliError:
    safe_text = safe_error_text(value)
    lowered = safe_text.lower()
    if any(
        marker in lowered
        for marker in (
            "invalid_api_key",
            "invalid api key",
            "incorrect api key",
            "unauthorized",
            "not authenticated",
            "authentication",
            "no api key",
            "api key is missing",
            "401",
        )
    ):
        return PiCliAuthenticationError(
            "pi authentication error. Sign in to the selected provider inside pi "
            "('pi', then '/login') or set its API key in the environment pi runs "
            "with, and try again."
        )
    if "model" in lowered and any(
        marker in lowered
        for marker in ("not found", "unknown model", "does not exist", "404")
    ):
        return PiCliError(
            "pi's provider rejected the selected model. Choose a provider/model id "
            "listed by 'pi --list-models', or clear the model override to use "
            "pi's default."
        )
    return PiCliError(f"pi failed: {safe_text}")


def _text_of(content: Any) -> str:
    """The text blocks of a pi message or tool result, joined."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = [
        block.get("text")
        for block in content
        if isinstance(block, dict)
        and block.get("type") == "text"
        and isinstance(block.get("text"), str)
    ]
    return "\n".join(part for part in parts if part)


class _Turn:
    """What one turn accumulates while pi's events stream in."""

    def __init__(self) -> None:
        self.text_seen = False
        self.tool_seen = False
        self.usage_seen = False
        self.settled = False
        self.pending_args: dict[str, dict[str, Any]] = {}
        self.totals = {
            "input_tokens": 0,
            "output_tokens": 0,
            "reasoning_tokens": 0,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        }


class PiCliAgentClient(CliSubprocessAgentClient):
    """Run agent turns through ``pi --mode json`` (one process per turn) or
    ``pi --mode rpc`` (one process per session, JSONL both ways).

    The two modes read the same events. RPC adds what a persistent process
    allows: ``abort`` instead of a kill, ``compact`` on demand, the model's
    context window from ``get_state``, and the system prompt sent once for the
    whole session. An extension that asks a question (``extension_ui_request``)
    is always answered ``cancelled``: a run without a UI asks nobody.
    """

    cli_label = "pi"

    def __init__(
        self,
        *,
        model: str | None = None,
        system_prompt: str | None = None,
        project_dir: str,
        agent_type: str = "coder",
        session_id: str | None = None,
        thinking_level: str | None = None,
        spec_dir: str | Path | None = None,
        session_dir: str | Path | None = None,
        mode: str | None = None,
        guard: bool = True,
        executable: str | None = None,
        process_factory: ProcessFactory | None = None,
    ) -> None:
        super().__init__(
            model=qualify_provider_model(model, cli="pi"),
            system_prompt=system_prompt,
            project_dir=project_dir,
            agent_type=agent_type,
            session_id=session_id,
            executable=executable,
            process_factory=process_factory,
        )
        self.mode = pi_mode(mode)
        self.guard = guard
        self._spec_dir = Path(spec_dir) if spec_dir else None
        self.thinking_level = pi_thinking_level(thinking_level)
        self.tools = pi_tool_allowlist(agent_type, spec_dir=spec_dir)
        self.session_dir = (
            Path(session_dir) if session_dir else self._default_session_dir(spec_dir)
        )
        # `resumes_native_session` reads `session_id`: a session WorkPilot named
        # on the first turn is resumed on the next one.
        self._resume = bool(session_id)
        self.session_id = session_id or str(uuid.uuid4())
        self.last_session_id = self.session_id
        self._rpc_ids = 0
        self._rpc_stderr: asyncio.Task[bytes] | None = None

    def _default_session_dir(self, spec_dir: str | Path | None) -> Path:
        """Sessions are an artefact of the task: its spec directory, else the
        workpilot temp root — never ``~/.pi``, which belongs to the person."""
        if spec_dir:
            return Path(spec_dir) / "pi-sessions"
        digest = hashlib.sha1(
            self._project_dir.encode("utf-8"), usedforsecurity=False
        ).hexdigest()[:12]
        return Path(tempfile.gettempdir()) / "workpilot" / "pi-sessions" / digest

    def provider_name(self) -> str:
        # `pi-rpc` is a client-level fact the provider matrix cannot express:
        # the persistent process compacts on demand (context_mgmt/capabilities).
        return "pi-rpc" if self.mode == "rpc" else "pi"

    def resumes_native_session(self) -> bool:
        return self._resume

    def _resolve_executable(self) -> str | None:
        return self._executable or find_executable("pi")

    def _subprocess_env(self) -> dict[str, str]:
        """The environment pi runs with: WorkPilot's, less what must not reach it.

        pi owns its login, so the provider credentials a person set stay; the
        loader-injection variables, WorkPilot's JEV key and the Claude Code
        OAuth token do not (`ENV_DENYLIST`). The guard's policy rides in
        `WORKPILOT_PI_GUARD`: nothing in argv is a path.
        """
        env = {
            k: v for k, v in super()._subprocess_env().items() if k not in ENV_DENYLIST
        }
        env["PI_CODING_AGENT_SESSION_DIR"] = str(self.session_dir)
        # The startup version check is a network call pi makes on its own; a
        # build is not the moment.
        env.setdefault("PI_SKIP_VERSION_CHECK", "1")
        if self.guard:
            env[GUARD_ENV_VAR] = json.dumps(
                pi_guard_policy(self._project_dir, self._spec_dir), ensure_ascii=False
            )
        return env

    def trust_state(self) -> str:
        return pi_trust_state(self._project_dir)

    def _project_skills_present(self) -> bool:
        return (Path(self._project_dir) / PROJECT_SKILLS_DIR).is_dir()

    def _take_prompt(self) -> str | None:
        # A resumed session already carries the system prompt of its first
        # turn (`CliSubprocessAgentClient._take_prompt` checks `session_id`,
        # which pi sets on the first turn too), so decide from `_resume`.
        prompt = self._pending_query
        self._pending_query = None
        if not prompt:
            return None
        sections: list[str] = []
        if self.system_prompt and not self._resume:
            sections.append(self.system_prompt)
        if self._resumed_history:
            sections.append(self._format_history_as_preamble(self._resumed_history))
            self._resumed_history = []
        sections.append(prompt)
        return "\n\n".join(section for section in sections if section)

    def _command(self, executable: str) -> list[str]:
        if self.guard:
            install_pi_guard(self._project_dir)
        logical = build_pi_args(
            executable=executable,
            mode=self.mode,
            model=None if self.model == "default" else self.model,
            session_id=self.session_id,
            resume=self._resume,
            tools=self.tools,
            thinking_level=self.thinking_level,
            project_skills=self._project_skills_present(),
            guard=self.guard,
        )
        return build_windows_command(logical[0], logical[1:])

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        prompt = self._take_prompt()
        if not prompt:
            return
        attempt = self._rpc_turn if self.mode == "rpc" else self._attempt
        try:
            async with aclosing(attempt(prompt)) as messages:
                async for message in messages:
                    yield message
        except PiCliError as error:
            if self.model == "default" or "rejected the selected model" not in str(
                error
            ):
                raise
            rejected = self.model
            self.model = "default"
            logger.warning(
                "[PiCliAgentClient] Model %s is unavailable; retrying once with pi's default model",
                rejected,
            )
            if self.mode == "rpc":
                # The process was started with the rejected model: a new one.
                await self._stop_process()
            async with aclosing(attempt(prompt)) as messages:
                async for message in messages:
                    yield message

    # ── the events both modes read ────────────────────────────────────────
    def _consume(self, event: dict[str, Any], turn: _Turn) -> list[AgentMessage]:
        """Fold one pi event into ``turn``; the messages it yields, if any."""
        event_type = event.get("type")
        if event_type == "session":
            session = event.get("id")
            if isinstance(session, str) and session:
                self.session_id = session
                self.last_session_id = session
            return []
        if event_type == "message_end":
            message = event.get("message")
            if not isinstance(message, dict) or message.get("role") != "assistant":
                return []
            usage = message.get("usage")
            if isinstance(usage, dict):
                turn.usage_seen = True
                fresh = as_int(usage.get("input"))
                read = as_int(usage.get("cacheRead"))
                write = as_int(usage.get("cacheWrite"))
                # `input` is the uncached part (pi-ai normalises every API to
                # that): what the window holds is all three.
                self.last_context_tokens = fresh + read + write
                turn.totals["input_tokens"] += fresh + read + write
                turn.totals["output_tokens"] += as_int(usage.get("output"))
                turn.totals["reasoning_tokens"] += as_int(usage.get("reasoning"))
                turn.totals["cache_read_input_tokens"] += read
                turn.totals["cache_creation_input_tokens"] += write
                self._record_call(from_pi_usage(usage))
            stop = message.get("stopReason")
            if stop in ("error", "aborted"):
                raise _pi_error(message.get("errorMessage") or f"request {stop}")
            out: list[AgentMessage] = []
            text = _text_of(message.get("content"))
            if text.strip():
                turn.text_seen = True
                out.append(text_message(MessageRole.ASSISTANT, text))
            if stop == "length":
                raise PiCliError(
                    "pi's answer was cut by the model's output limit; the turn is incomplete."
                )
            return out
        if event_type == "tool_execution_start":
            call_id = event.get("toolCallId")
            if isinstance(call_id, str) and isinstance(event.get("args"), dict):
                turn.pending_args[call_id] = event["args"]
            return []
        if event_type == "tool_execution_end":
            call_id = str(event.get("toolCallId") or "")
            result = event.get("result")
            output = (
                _text_of(result.get("content")) if isinstance(result, dict) else result
            )
            turn.tool_seen = True
            return tool_messages(
                tool_id=call_id,
                name=str(event.get("toolName") or "tool"),
                tool_input=turn.pending_args.pop(call_id, None),
                output=output,
                is_error=bool(event.get("isError")),
            )
        if event_type == "compaction_end":
            logger.info(
                "[PiCliAgentClient] pi compacted the session (reason=%s, aborted=%s, error=%s)",
                event.get("reason"),
                event.get("aborted"),
                safe_error_text(event.get("errorMessage") or "") or None,
            )
            return []
        if event_type == "agent_settled":
            turn.settled = True
            return []
        if event_type == "extension_error":
            logger.warning(
                "[PiCliAgentClient] a pi extension failed: %s",
                safe_error_text(event.get("error") or event),
            )
        return []

    def _settle(self, turn: _Turn, stderr: str) -> None:
        if turn.usage_seen:
            self.last_usage = turn.totals
            self.context_usage_source = "reported"
        else:
            self.context_usage_source = "estimated"
        if not turn.text_seen and not turn.tool_seen:
            raise PiCliError(
                "pi returned no response."
                + (f" stderr: {stderr}" if stderr else "")
                + ("" if turn.settled else " The run did not settle.")
            )
        # The first turn named the session; every later one resumes it.
        self._resume = True

    # ── json mode: one process per turn ──────────────────────────────────
    async def _attempt(self, prompt: str) -> AsyncIterator[AgentMessage]:
        executable = self._resolve_executable()
        if not executable:
            raise PiCliError(
                "pi is not installed or is not available on PATH "
                "(https://pi.dev/docs/latest/quickstart)."
            )
        try:
            self.session_dir.mkdir(parents=True, exist_ok=True)
            process = await self._spawn(
                self._command(executable), prompt.encode("utf-8")
            )
        except (OSError, RuntimeError, ValueError) as error:
            raise _pi_error(error) from error

        self.last_context_tokens = None
        self._start_usage_ledger()
        stderr_task = asyncio.create_task(process.stderr.read())
        turn = _Turn()
        try:
            async for event in self._json_events(process):
                for message in self._consume(event, turn):
                    yield message
            returncode = await process.wait()
            stderr = safe_error_text((await stderr_task).decode("utf-8", "replace"))
            if returncode != 0:
                raise _pi_error(stderr or f"exit status {returncode}")
            self._settle(turn, stderr)
        except asyncio.CancelledError:
            await self._stop_process()
            raise
        finally:
            if not stderr_task.done():
                stderr_task.cancel()
            await asyncio.gather(stderr_task, return_exceptions=True)
            await self._stop_process()

    # ── rpc mode: one process per session ────────────────────────────────
    async def _rpc_process(self) -> Any:
        """The session's pi process, started on first use."""
        process = self._process
        if process is not None and process.returncode is None:
            return process
        executable = self._resolve_executable()
        if not executable:
            raise PiCliError(
                "pi is not installed or is not available on PATH "
                "(https://pi.dev/docs/latest/quickstart)."
            )
        try:
            self.session_dir.mkdir(parents=True, exist_ok=True)
            process = await self._process_factory(
                *self._command(executable),
                cwd=self._project_dir,
                env=self._subprocess_env(),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except (OSError, RuntimeError, ValueError) as error:
            raise _pi_error(error) from error
        if process.stdin is None:
            raise PiCliError("pi stdin pipe is unavailable.")
        self._process = process
        self._rpc_stderr = asyncio.create_task(process.stderr.read())
        return process

    async def _rpc_send(self, command: dict[str, Any]) -> str:
        """Write one command line; its id, echoed in the response."""
        process = await self._rpc_process()
        self._rpc_ids += 1
        command_id = f"wp-{self._rpc_ids}"
        process.stdin.write(
            (
                json.dumps({"id": command_id, **command}, ensure_ascii=False) + "\n"
            ).encode("utf-8")
        )
        await process.stdin.drain()
        return command_id

    async def _rpc_answer_ui(self, request: dict[str, Any]) -> None:
        """A question from a pi extension: nobody is there to answer it."""
        request_id = request.get("id")
        logger.warning(
            "[PiCliAgentClient] a pi extension asked `%s` (%s); answered cancelled",
            request.get("method"),
            safe_error_text(request.get("title") or request.get("message") or ""),
        )
        if isinstance(request_id, str):
            process = await self._rpc_process()
            process.stdin.write(
                (
                    json.dumps(
                        {
                            "type": "extension_ui_response",
                            "id": request_id,
                            "cancelled": True,
                        }
                    )
                    + "\n"
                ).encode("utf-8")
            )
            await process.stdin.drain()

    async def _rpc_wait(
        self, process: Any, command_id: str, command: str
    ) -> dict[str, Any] | None:
        """Read until the response to ``command_id``; None on EOF."""
        async for event in self._json_events(process):
            if event.get("type") == "extension_ui_request":
                await self._rpc_answer_ui(event)
            elif event.get("type") == "response" and event.get("id") == command_id:
                if event.get("command") != command:
                    continue
                return event
        return None

    async def _rpc_turn(self, prompt: str) -> AsyncIterator[AgentMessage]:
        process = await self._rpc_process()
        self.last_context_tokens = None
        self._start_usage_ledger()
        turn = _Turn()
        command_id = await self._rpc_send({"type": "prompt", "message": prompt})
        try:
            async for event in self._json_events(process):
                event_type = event.get("type")
                if event_type == "extension_ui_request":
                    await self._rpc_answer_ui(event)
                    continue
                if event_type == "response":
                    if event.get("id") == command_id and not event.get("success", True):
                        raise _pi_error(event.get("error") or "prompt refused")
                    continue
                for message in self._consume(event, turn):
                    yield message
                if turn.settled:
                    break
            if process.returncode is not None or not turn.settled:
                stderr = await self._rpc_stderr_text()
                if process.returncode not in (None, 0):
                    raise _pi_error(stderr or f"exit status {process.returncode}")
                if not turn.settled:
                    raise PiCliError(
                        "pi closed its RPC stream before the turn settled."
                        + (f" stderr: {stderr}" if stderr else "")
                    )
            await self._rpc_read_state()
            self._settle(turn, "")
        except asyncio.CancelledError:
            await self.abort()
            await self._stop_process()
            raise
        except PiCliError:
            await self._stop_process()
            raise

    async def _rpc_stderr_text(self) -> str:
        task = self._rpc_stderr
        if task is None:
            return ""
        try:
            raw = await asyncio.wait_for(task, timeout=2)
        except (TimeoutError, asyncio.CancelledError):
            return ""
        return safe_error_text(raw.decode("utf-8", "replace"))

    async def _rpc_read_state(self) -> None:
        """``get_state``: the session id pi settled on and the model's window."""
        process = await self._rpc_process()
        command_id = await self._rpc_send({"type": "get_state"})
        response = await self._rpc_wait(process, command_id, "get_state")
        data = response.get("data") if response else None
        if not isinstance(data, dict):
            return
        session = data.get("sessionId")
        if isinstance(session, str) and session:
            self.session_id = session
            self.last_session_id = session
        model = data.get("model")
        window = model.get("contextWindow") if isinstance(model, dict) else None
        if isinstance(window, int) and window > 0:
            self.context_window_tokens = window

    async def abort(self) -> None:
        """Ask the running turn to stop (RPC); nothing to ask in json mode."""
        process = self._process
        if self.mode != "rpc" or process is None or process.returncode is not None:
            return
        try:
            await self._rpc_send({"type": "abort"})
        except (OSError, RuntimeError, PiCliError):  # the process is going away anyway
            logger.debug("[PiCliAgentClient] abort could not be sent")

    async def compact(self, instructions: str | None = None) -> bool:
        """Compact the session now (RPC). False when pi had nothing to compact."""
        if self.mode != "rpc":
            return False
        process = await self._rpc_process()
        command: dict[str, Any] = {"type": "compact"}
        if instructions:
            command["customInstructions"] = instructions
        command_id = await self._rpc_send(command)
        response = await self._rpc_wait(process, command_id, "compact")
        if response is None:
            raise PiCliError("pi closed its RPC stream during compaction.")
        if not response.get("success", False):
            logger.info(
                "[PiCliAgentClient] pi did not compact: %s",
                safe_error_text(response.get("error") or ""),
            )
            return False
        return True

    async def _stop_process(self) -> None:
        process = self._process
        if self.mode == "rpc" and process is not None and process.returncode is None:
            # Closing stdin is pi's shutdown; terminate only if it lingers.
            try:
                process.stdin.close()
                await asyncio.wait_for(process.wait(), timeout=5)
            except (OSError, RuntimeError, TimeoutError) as exc:
                # The base class terminates (then kills) whatever is still running.
                logger.debug(
                    "[PiCliAgentClient] pi did not exit on stdin close: %s", exc
                )
        task = self._rpc_stderr
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self._rpc_stderr = None
        await super()._stop_process()
