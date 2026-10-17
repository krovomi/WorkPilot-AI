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
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
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
    "PI_THINKING_LEVELS",
    "PiCliAgentClient",
    "PiCliAuthenticationError",
    "PiCliError",
    "build_pi_args",
    "pi_thinking_level",
    "pi_tool_allowlist",
    "pi_trust_state",
]

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
    model: str | None,
    session_id: str,
    resume: bool,
    tools: list[str] | None,
    thinking_level: str | None,
    project_skills: bool,
) -> list[str]:
    """A shell-free ``pi --mode json`` command. The prompt goes on stdin.

    Every option value passes `validated_option`: the launcher may be a `.cmd`
    parsed by cmd.exe on Windows, so no path, space or shell character enters
    the vector — the session is an id, the skills directory is relative.
    """
    args = [executable, "--mode", "json"]
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


class PiCliAgentClient(CliSubprocessAgentClient):
    """Run an agent turn through ``pi --mode json``."""

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

    def _default_session_dir(self, spec_dir: str | Path | None) -> Path:
        """Sessions are an artefact of the task: its spec directory, else the
        workpilot temp root — never ``~/.pi``, which belongs to the person."""
        if spec_dir:
            return Path(spec_dir) / "pi-sessions"
        digest = hashlib.sha1(self._project_dir.encode("utf-8")).hexdigest()[:12]  # noqa: S324 - a name, not a secret
        return Path(tempfile.gettempdir()) / "workpilot" / "pi-sessions" / digest

    def provider_name(self) -> str:
        return "pi"

    def resumes_native_session(self) -> bool:
        return self._resume

    def _resolve_executable(self) -> str | None:
        return self._executable or find_executable("pi")

    def _subprocess_env(self) -> dict[str, str]:
        env = super()._subprocess_env()
        env["PI_CODING_AGENT_SESSION_DIR"] = str(self.session_dir)
        # The startup version check is a network call pi makes on its own; a
        # build is not the moment.
        env.setdefault("PI_SKIP_VERSION_CHECK", "1")
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

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        prompt = self._take_prompt()
        if not prompt:
            return
        try:
            async with aclosing(self._attempt(prompt)) as attempt:
                async for message in attempt:
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
            async with aclosing(self._attempt(prompt)) as attempt:
                async for message in attempt:
                    yield message

    async def _attempt(self, prompt: str) -> AsyncIterator[AgentMessage]:
        executable = self._resolve_executable()
        if not executable:
            raise PiCliError(
                "pi is not installed or is not available on PATH "
                "(https://pi.dev/docs/latest/quickstart)."
            )
        try:
            self.session_dir.mkdir(parents=True, exist_ok=True)
            logical = build_pi_args(
                executable=executable,
                model=None if self.model == "default" else self.model,
                session_id=self.session_id,
                resume=self._resume,
                tools=self.tools,
                thinking_level=self.thinking_level,
                project_skills=self._project_skills_present(),
            )
            command = build_windows_command(logical[0], logical[1:])
            process = await self._spawn(command, prompt.encode("utf-8"))
        except (OSError, RuntimeError, ValueError) as error:
            raise _pi_error(error) from error

        self.last_context_tokens = None
        self._start_usage_ledger()
        stderr_task = asyncio.create_task(process.stderr.read())
        text_seen = False
        tool_seen = False
        usage_seen = False
        settled = False
        pending_args: dict[str, dict[str, Any]] = {}
        totals = {
            "input_tokens": 0,
            "output_tokens": 0,
            "reasoning_tokens": 0,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        }
        try:
            async for event in self._json_events(process):
                event_type = event.get("type")

                if event_type == "session":
                    session = event.get("id")
                    if isinstance(session, str) and session:
                        self.session_id = session
                        self.last_session_id = session
                elif event_type == "message_end":
                    message = event.get("message")
                    if (
                        not isinstance(message, dict)
                        or message.get("role") != "assistant"
                    ):
                        continue
                    usage = message.get("usage")
                    if isinstance(usage, dict):
                        usage_seen = True
                        fresh = as_int(usage.get("input"))
                        read = as_int(usage.get("cacheRead"))
                        write = as_int(usage.get("cacheWrite"))
                        # `input` is the uncached part (pi-ai normalises every
                        # API to that): what the window holds is all three.
                        self.last_context_tokens = fresh + read + write
                        totals["input_tokens"] += fresh + read + write
                        totals["output_tokens"] += as_int(usage.get("output"))
                        totals["reasoning_tokens"] += as_int(usage.get("reasoning"))
                        totals["cache_read_input_tokens"] += read
                        totals["cache_creation_input_tokens"] += write
                        self._record_call(from_pi_usage(usage))
                    stop = message.get("stopReason")
                    if stop in ("error", "aborted"):
                        raise _pi_error(
                            message.get("errorMessage") or f"request {stop}"
                        )
                    text = _text_of(message.get("content"))
                    if text.strip():
                        text_seen = True
                        yield text_message(MessageRole.ASSISTANT, text)
                    if stop == "length":
                        raise PiCliError(
                            "pi's answer was cut by the model's output limit; the turn is incomplete."
                        )
                elif event_type == "tool_execution_start":
                    call_id = event.get("toolCallId")
                    if isinstance(call_id, str) and isinstance(event.get("args"), dict):
                        pending_args[call_id] = event["args"]
                elif event_type == "tool_execution_end":
                    call_id = str(event.get("toolCallId") or "")
                    result = event.get("result")
                    output = (
                        _text_of(result.get("content"))
                        if isinstance(result, dict)
                        else result
                    )
                    tool_seen = True
                    for message in tool_messages(
                        tool_id=call_id,
                        name=str(event.get("toolName") or "tool"),
                        tool_input=pending_args.pop(call_id, None),
                        output=output,
                        is_error=bool(event.get("isError")),
                    ):
                        yield message
                elif event_type == "compaction_end":
                    logger.info(
                        "[PiCliAgentClient] pi compacted the session (reason=%s, aborted=%s)",
                        event.get("reason"),
                        event.get("aborted"),
                    )
                elif event_type == "agent_settled":
                    settled = True

            returncode = await process.wait()
            stderr = safe_error_text((await stderr_task).decode("utf-8", "replace"))
            if returncode != 0:
                raise _pi_error(stderr or f"exit status {returncode}")
            if usage_seen:
                self.last_usage = totals
                self.context_usage_source = "reported"
            else:
                self.context_usage_source = "estimated"
            if not text_seen and not tool_seen:
                raise PiCliError(
                    "pi returned no response."
                    + (f" stderr: {stderr}" if stderr else "")
                    + ("" if settled else " The run did not settle.")
                )
            # The first turn named the session; every later one resumes it.
            self._resume = True
        except asyncio.CancelledError:
            await self._stop_process()
            raise
        finally:
            if not stderr_task.done():
                stderr_task.cancel()
            await asyncio.gather(stderr_task, return_exceptions=True)
            await self._stop_process()
