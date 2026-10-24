"""`OpenCodeCliAgentClient` — an agent turn run by ``opencode run --format json``.

What the boundary is, as read from the OpenCode CLI source
(`packages/cli/src/run/run.ts`, `run/noninteractive.ts`) and https://opencode.ai/docs/cli:

- ``opencode run [message..]`` reads the message from **stdin** when stdin is
  not a TTY, and appends it to any positional message. WorkPilot passes no
  positional message: the prompt goes on stdin, never into argv.
- It works in ``process.env.PWD`` before ``process.cwd()``, so the subprocess
  gets ``PWD`` set to the project as well as ``cwd``.
- ``-s/--session <id>`` continues a session; ``-m/--model provider/model``;
  ``--agent <name>``; ``--format json`` prints one JSON object per line:
  ``{"type", "timestamp", "sessionID", ...}`` with ``type`` one of
  ``step_start``, ``text`` (``part.text``), ``reasoning``, ``tool_use``
  (``part.tool``, ``part.state.{status,input,output,error}``), ``step_finish``
  (``part.tokens.{input,output,reasoning,cache.{read,write}}``, ``part.cost``)
  and ``error`` (``error.message`` / ``error.data.message``).
- ``run`` rejects any permission that would *ask*; ``--auto`` approves what is
  not explicitly denied.

Rights come from the agent type's declaration, as Codex's sandbox does: a type
declaring none of Write, Edit or Bash runs the built-in ``plan`` agent (edits
denied; shell asks, which ``run`` rejects) without ``--auto``. Every other type
runs ``build`` with ``--auto``.

Compaction: OpenCode compacts a session on its own when the model's window
fills (``compaction.auto``, on by default; ``OPENCODE_DISABLE_AUTOCOMPACT``
turns it off). ``run`` exposes no command to compact on demand.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import aclosing
from typing import Any

from foundation.platform import build_windows_command, find_executable
from harness.domain import from_step_tokens

from .base import AgentMessage, MessageRole
from .cli_subprocess import (
    CliSubprocessAgentClient,
    ProcessFactory,
    as_int,
    declares_no_writes,
    qualify_provider_model,
    safe_error_text,
    text_message,
    tool_messages,
    validated_option,
)

logger = logging.getLogger(__name__)

#: The two built-in OpenCode agents a WorkPilot agent type maps onto.
OPENCODE_AGENTS = ("build", "plan")


class OpenCodeCliError(RuntimeError):
    """A safe, user-facing failure from the OpenCode CLI boundary."""


class OpenCodeCliAuthenticationError(OpenCodeCliError):
    """OpenCode has no usable credentials for the selected provider."""


def opencode_agent_for(agent_type: str) -> str:
    """`plan` for a type that declares neither writing nor the shell."""
    return "plan" if declares_no_writes(agent_type) else "build"


def resolve_opencode_model(model: str | None) -> str | None:
    """The ``provider/model`` id to pass to ``-m``, or None for OpenCode's default.

    OpenCode only takes ``provider/model``. A bare id inherited from another
    provider is qualified when its family is unambiguous, and dropped otherwise
    rather than sent to fail.
    """
    qualified = qualify_provider_model(model, cli="OpenCodeCliAgentClient")
    return None if qualified == "default" else qualified


def build_opencode_run_args(
    *,
    executable: str,
    model: str | None,
    session_id: str | None,
    agent: str = "build",
) -> list[str]:
    """A shell-free ``opencode run`` command. The prompt goes on stdin."""
    mode = agent if agent in OPENCODE_AGENTS else "build"
    args = [executable, "run", "--format", "json", "--agent", mode]
    if mode == "build":
        # `run` rejects every permission that would ask. A coder in its own
        # worktree must be able to edit and run commands; rules a user set to
        # `deny` stay denied.
        args.append("--auto")
    if session_id:
        args.extend(
            ["--session", validated_option(session_id, "session id", "OpenCode")]
        )
    if model:
        args.extend(["--model", validated_option(model, "model", "OpenCode")])
    return args


def _error_detail(event: dict[str, Any]) -> object:
    error = event.get("error")
    if isinstance(error, dict):
        data = error.get("data")
        if isinstance(data, dict) and data.get("message"):
            return data["message"]
        return error.get("message") or error.get("name") or error
    return error or event.get("message")


def _opencode_error(value: object) -> OpenCodeCliError:
    safe_text = safe_error_text(value)
    lowered = safe_text.lower()
    if any(
        marker in lowered
        for marker in (
            "no credentials",
            "not authenticated",
            "unauthorized",
            "invalid api key",
            "api key is missing",
            "authentication",
            "opencode auth login",
        )
    ):
        return OpenCodeCliAuthenticationError(
            "OpenCode CLI authentication error. Run 'opencode auth login' for the "
            "selected provider and try again."
        )
    if "model" in lowered and any(
        marker in lowered for marker in ("not found", "unknown model", "modelnotfound")
    ):
        return OpenCodeCliError(
            "OpenCode CLI rejected the selected model. Choose a provider/model id "
            "listed by 'opencode models', or clear the model override to use "
            "OpenCode's default."
        )
    return OpenCodeCliError(f"OpenCode CLI failed: {safe_text}")


class OpenCodeCliAgentClient(CliSubprocessAgentClient):
    """Run an agent turn through ``opencode run --format json``."""

    cli_label = "OpenCode CLI"

    def __init__(
        self,
        *,
        model: str | None = None,
        system_prompt: str | None = None,
        project_dir: str,
        agent_type: str = "coder",
        session_id: str | None = None,
        executable: str | None = None,
        process_factory: ProcessFactory | None = None,
    ) -> None:
        super().__init__(
            model=resolve_opencode_model(model),
            system_prompt=system_prompt,
            project_dir=project_dir,
            agent_type=agent_type,
            session_id=session_id,
            executable=executable,
            process_factory=process_factory,
        )
        self.agent = opencode_agent_for(agent_type)

    def provider_name(self) -> str:
        return "opencode"

    def _resolve_executable(self) -> str | None:
        return self._executable or find_executable("opencode")

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        prompt = self._take_prompt()
        if not prompt:
            return
        try:
            async with aclosing(self._attempt(prompt)) as attempt:
                async for message in attempt:
                    yield message
        except OpenCodeCliError as error:
            if self.model == "default" or "rejected the selected model" not in str(
                error
            ):
                raise
            rejected = self.model
            self.model = "default"
            logger.warning(
                "[OpenCodeCliAgentClient] Model %s is unavailable; retrying once "
                "with OpenCode's default model",
                rejected,
            )
            async with aclosing(self._attempt(prompt)) as attempt:
                async for message in attempt:
                    yield message

    async def _attempt(self, prompt: str) -> AsyncIterator[AgentMessage]:
        executable = self._resolve_executable()
        if not executable:
            raise OpenCodeCliError(
                "OpenCode CLI is not installed or is not available on PATH."
            )
        try:
            logical = build_opencode_run_args(
                executable=executable,
                model=None if self.model == "default" else self.model,
                session_id=self.session_id,
                agent=self.agent,
            )
            command = build_windows_command(logical[0], logical[1:])
            process = await self._spawn(command, prompt.encode("utf-8"))
        except (OSError, RuntimeError, ValueError) as error:
            raise _opencode_error(error) from error

        self.last_context_tokens = None
        self._start_usage_ledger()
        stderr_task = asyncio.create_task(process.stderr.read())
        text_seen = False
        tool_seen = False
        usage_seen = False
        totals = {
            "input_tokens": 0,
            "output_tokens": 0,
            "reasoning_tokens": 0,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        }
        try:
            async for event in self._json_events(process):
                session = event.get("sessionID")
                if isinstance(session, str) and session:
                    self.session_id = session
                    self.last_session_id = session
                event_type = event.get("type")
                part = event.get("part") if isinstance(event.get("part"), dict) else {}

                if event_type == "text":
                    text = part.get("text")
                    if isinstance(text, str) and text.strip():
                        text_seen = True
                        yield text_message(MessageRole.ASSISTANT, text)
                elif event_type == "tool_use":
                    state = (
                        part.get("state") if isinstance(part.get("state"), dict) else {}
                    )
                    status = str(state.get("status") or "")
                    is_error = status in {"error", "failed"}
                    tool_seen = True
                    for message in tool_messages(
                        tool_id=str(part.get("callID") or part.get("id") or ""),
                        name=str(part.get("tool") or "tool"),
                        tool_input=state.get("input")
                        if isinstance(state.get("input"), dict)
                        else None,
                        output=state.get("error") if is_error else state.get("output"),
                        is_error=is_error,
                    ):
                        yield message
                elif event_type == "step_finish":
                    tokens = part.get("tokens")
                    if isinstance(tokens, dict):
                        usage_seen = True
                        cache = (
                            tokens.get("cache")
                            if isinstance(tokens.get("cache"), dict)
                            else {}
                        )
                        fresh = as_int(tokens.get("input"))
                        read = as_int(cache.get("read"))
                        write = as_int(cache.get("write"))
                        # `input` is the non-cached part (SessionUsage.tokens):
                        # what the window holds is all three.
                        self.last_context_tokens = fresh + read + write
                        totals["input_tokens"] += fresh + read + write
                        totals["output_tokens"] += as_int(tokens.get("output"))
                        totals["reasoning_tokens"] += as_int(tokens.get("reasoning"))
                        totals["cache_read_input_tokens"] += read
                        totals["cache_creation_input_tokens"] += write
                        self._record_call(from_step_tokens(tokens))
                elif event_type == "error":
                    raise _opencode_error(_error_detail(event))

            returncode = await process.wait()
            stderr = safe_error_text((await stderr_task).decode("utf-8", "replace"))
            if returncode != 0:
                raise _opencode_error(stderr or f"exit status {returncode}")
            if usage_seen:
                self.last_usage = totals
                self.context_usage_source = "reported"
            else:
                self.context_usage_source = "estimated"
            if not text_seen and not tool_seen:
                raise OpenCodeCliError("OpenCode CLI returned no response.")
        except asyncio.CancelledError:
            await self._stop_process()
            raise
        finally:
            if not stderr_task.done():
                stderr_task.cancel()
            await asyncio.gather(stderr_task, return_exceptions=True)
            await self._stop_process()
