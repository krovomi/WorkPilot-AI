"""Shared plumbing for agent clients that drive a coding-agent CLI.

OpenCode (`opencode run`) and Google Antigravity (`agy`) bring their own tools,
their own sessions and their own context management. WorkPilot only starts the
process, hands it the prompt on stdin and reads newline-delimited JSON back —
the same boundary `core/codex_cli_client.py` keeps with Codex.

Three rules every subclass inherits:

- **No shell.** The argument vector goes through `build_windows_command`, which
  only adds `cmd.exe` for a `.cmd`/`.bat` launcher (npm installs). The prompt
  and the project path never enter it: the prompt goes on stdin, the project is
  the subprocess `cwd`. cmd.exe would otherwise parse both, and a prompt longer
  than its 8 191-character command line would not fit anyway.
- **No credentials.** Each CLI owns its login. Nothing here reads a token, and
  every error that reaches the task log passes through `safe_error_text`.
- **The context contract.** `last_usage`, `last_session_id`,
  `last_context_tokens`, `context_window_tokens` and `context_usage_source` are
  read duck-typed by the context-management engine after every turn.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any

from .base import (
    AgentClient,
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    MessageRole,
)

logger = logging.getLogger(__name__)

ProcessFactory = Callable[..., Awaitable[Any]]

#: Values that may enter a launcher argument vector. A `.cmd` launcher is
#: parsed by cmd.exe on Windows, so `&`, `|`, `%`, quotes and spaces are out.
_SAFE_OPTION_VALUE = re.compile(r"^[A-Za-z0-9._:/@#+-]+$")

#: The declaration that makes an agent type able to change anything.
WRITE_CAPABLE_TOOLS = frozenset({"Write", "Edit", "Bash"})

#: Model-id prefixes that name their provider unambiguously, for the bare ids
#: a task inherits from another provider ("claude-sonnet-4-6" → anthropic/…).
#: OpenCode and pi both take `provider/model`, with these provider names.
_PROVIDER_BY_PREFIX = (
    ("claude-", "anthropic"),
    ("gpt-", "openai"),
    ("o1", "openai"),
    ("o3", "openai"),
    ("o4", "openai"),
    ("gemini-", "google"),
    ("grok-", "xai"),
)


def qualify_provider_model(model: str | None, *, cli: str) -> str:
    """The ``provider/model`` id a CLI takes, or ``"default"`` for its own default.

    A bare id inherited from another provider is qualified when its family is
    unambiguous, and dropped otherwise rather than sent to fail.
    """
    candidate = (model or "").strip()
    if not candidate or candidate.lower() == "default":
        return "default"
    if "/" in candidate:
        return candidate
    lowered = candidate.lower()
    for prefix, provider in _PROVIDER_BY_PREFIX:
        if lowered.startswith(prefix):
            return f"{provider}/{candidate}"
    logger.warning(
        "[%s] Model %r is not a provider/model id; using the CLI's default model",
        cli,
        candidate,
    )
    return "default"


def validated_option(value: str, label: str, cli: str) -> str:
    """Reject an option value that could alter a Windows launcher command."""
    if not isinstance(value, str) or not _SAFE_OPTION_VALUE.fullmatch(value):
        raise ValueError(f"Invalid {cli} {label}: {value!r}")
    return value


def declares_no_writes(agent_type: str) -> bool:
    """True for a registered type that declares none of Write, Edit or Bash.

    An unregistered type is permissive, as `ToolExecutor` and
    `codex_sandbox_for` keep it: refusing it everything would break tests and
    callers outside the product rather than protect anything.
    """
    from agents.tools_pkg.permissions import declared_tools

    declared = declared_tools(agent_type)
    return declared is not None and not (declared & WRITE_CAPABLE_TOOLS)


def declares_shell(agent_type: str) -> bool:
    """True when the type declares Bash, or is not registered at all."""
    from agents.tools_pkg.permissions import declared_tools

    declared = declared_tools(agent_type)
    return declared is None or "Bash" in declared


def safe_error_text(value: object) -> str:
    """A compact diagnostic with credential-shaped values redacted.

    The one redaction `core/codex_cli_client.py` applies, imported lazily:
    that module imports `core.agent_client`, which imports this package.
    """
    from core.codex_cli_client import _safe_error_text

    return _safe_error_text(value)


def text_message(role: MessageRole, text: str) -> AgentMessage:
    return AgentMessage(
        role=role,
        content=[ContentBlock(type=ContentBlockType.TEXT, text=text)],
    )


def tool_messages(
    *,
    tool_id: str,
    name: str,
    tool_input: dict[str, Any] | None,
    output: Any,
    is_error: bool,
) -> list[AgentMessage]:
    """A tool the CLI already ran, as the use/result pair the task log shows.

    Purely informational: the CLI executed it, `process_agent_stream` only logs
    tool blocks, and nothing dispatches them again.
    """
    return [
        AgentMessage(
            role=MessageRole.ASSISTANT,
            content=[
                ContentBlock(
                    type=ContentBlockType.TOOL_USE,
                    tool_id=tool_id,
                    tool_name=name,
                    tool_input=tool_input or {},
                )
            ],
        ),
        AgentMessage(
            role=MessageRole.USER,
            content=[
                ContentBlock(
                    type=ContentBlockType.TOOL_RESULT,
                    tool_use_id=tool_id,
                    is_error=is_error,
                    result_content=output if output is not None else "",
                )
            ],
        ),
    ]


def as_int(value: object) -> int:
    """A token count as an int; anything else (None, str, bool) is 0."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return max(0, int(value))


class CliSubprocessAgentClient(AgentClient):
    """Process lifecycle shared by the CLI-backed clients.

    A subclass builds its argument vector and parses its own event stream in
    `receive_response`; everything about starting, feeding and stopping the
    process lives here.
    """

    #: Human label used in errors ("OpenCode CLI is not installed…").
    cli_label = "CLI"

    def __init__(
        self,
        *,
        model: str | None,
        system_prompt: str | None,
        project_dir: str,
        agent_type: str,
        session_id: str | None,
        executable: str | None,
        process_factory: ProcessFactory | None,
    ) -> None:
        self.model = model or "default"
        self.system_prompt = system_prompt
        self._project_dir = str(Path(project_dir))
        self._agent_type = agent_type
        self._executable = executable
        self._process_factory = process_factory or asyncio.create_subprocess_exec
        self._pending_query: str | None = None
        self._process: Any = None
        self._resumed_history: list[AgentMessage] = []
        self.session_id = session_id
        # The context-management contract (read duck-typed after each turn).
        self.last_session_id: str | None = session_id
        self.last_usage: dict[str, int] | None = None
        self.last_context_tokens: int | None = None
        self.context_window_tokens: int | None = None
        self.context_usage_source: str = "reported"

    async def __aenter__(self) -> CliSubprocessAgentClient:
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        await self._stop_process()

    def supports_subagents(self) -> bool:
        # The CLI may coordinate internally; WorkPilot's Claude-SDK roster is
        # never injected into it.
        return False

    def resumes_native_session(self) -> bool:
        """The CLI rehydrates its own session when it is given one.

        Replaying the conversation log on top would hand it the same turns
        twice.
        """
        return bool(self.session_id)

    async def query(self, prompt: str) -> None:
        self._pending_query = prompt

    def _take_prompt(self) -> str | None:
        """The pending query with the system prompt and any replayed history."""
        prompt = self._pending_query
        self._pending_query = None
        if not prompt:
            return None
        sections: list[str] = []
        if self.system_prompt and not self.session_id:
            # A resumed session already carries the system prompt of its first
            # turn; sending it again on every turn would grow the window.
            sections.append(self.system_prompt)
        if self._resumed_history:
            sections.append(self._format_history_as_preamble(self._resumed_history))
            self._resumed_history = []
        sections.append(prompt)
        return "\n\n".join(section for section in sections if section)

    def _subprocess_env(self) -> dict[str, str]:
        """The inherited environment with `PWD` pointing at the project.

        `cwd` alone is not enough: a Node/Bun CLI that reads `process.env.PWD`
        before `process.cwd()` (opencode does) would otherwise work in the
        directory WorkPilot itself was started from.
        """
        env = dict(os.environ)
        env["PWD"] = self._project_dir
        return env

    async def _spawn(self, command: list[str], stdin_data: bytes) -> Any:
        process = await self._process_factory(
            *command,
            cwd=self._project_dir,
            env=self._subprocess_env(),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._process = process
        if process.stdin is None:
            raise RuntimeError(f"{self.cli_label} stdin pipe is unavailable.")
        process.stdin.write(stdin_data)
        await process.stdin.drain()
        process.stdin.close()
        return process

    async def _json_events(self, process: Any) -> AsyncIterator[dict[str, Any]]:
        """Each well-formed JSON object the CLI prints on stdout."""
        while True:
            raw_line = await process.stdout.readline()
            if not raw_line:
                return
            line = raw_line.strip()
            if not line:
                continue
            try:
                event = json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                logger.debug("[%s] ignoring a non-JSON stdout line", self.cli_label)
                continue
            if isinstance(event, dict):
                yield event

    async def _stop_process(self) -> None:
        process = self._process
        if process is None or process.returncode is not None:
            self._process = None
            return
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except TimeoutError:
            process.kill()
            await process.wait()
        finally:
            self._process = None
