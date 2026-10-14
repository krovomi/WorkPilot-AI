"""`AntigravityCliAgentClient` — an agent turn run by Google Antigravity's ``agy``.

The boundary, as documented at https://antigravity.google/docs/cli/headless/,
https://antigravity.google/docs/cli/modes and in the CLI changelog:

- Print mode with ``--input-format stream-json --output-format stream-json``
  reads prompts from **stdin**, one JSON line each
  (``{"event": "user", "message": {"content": "..."}}``), and exits once stdin
  is closed and the turn completes. A prompt on the command line is dropped in
  that mode, so the prompt never enters argv.
- Output is NDJSON keyed by ``event``, the payload under the same name:
  ``init`` (``conversation_id``, ``init.permission_mode``…), ``step_update``
  (``conversation_id``, ``step_index``, ``state`` ACTIVE/DONE, ``step_type``
  user_input/agent_response/tool/checkpoint, ``text_delta``, ``tool_name``,
  ``usage``) and ``result`` (``conversation_id``, ``status`` SUCCESS/ERROR/…,
  ``response``, ``error``, ``usage``, ``denied_actions``).
- Usage carries ``input_tokens``, ``output_tokens``, ``thinking_tokens``,
  ``cache_read_tokens`` and ``total_tokens``; per step on ``step_update``,
  cumulative for the process on ``result``.
- ``--conversation <id>`` resumes a conversation; ``--model <slug>`` exits
  non-zero on an unknown model rather than falling back; ``--effort
  low|medium|high``.
- Fatal errors go to stderr behind a stable ``error:`` marker. Headless runs
  need credentials cached by one interactive sign-in (or ``GEMINI_API_KEY``);
  without them the CLI fails with "authentication required".

**Rights.** Antigravity has no mode that *enforces* read-only: ``plan`` mode
only prefixes an instruction, and the user's own settings (``agentMode``,
``permissions.allow``) can pre-grant writes and commands to a headless run.
So an agent type that declares none of Write, Edit or Bash is refused at
construction — the same stance ``core/simple_client.py`` takes with the types
it cannot hook. A type that declares Bash runs with
``--dangerously-skip-permissions --sandbox`` (the terminal sandbox on); a type
that only edits runs ``--mode accept-edits``, where shell commands stay subject
to the permission rules and are soft-denied headless.

**Compaction.** The CLI compacts on its own past a trigger threshold and has a
``/compact`` command (1.3.5), but nothing documents ``/compact`` in print mode,
and a CLI-handled slash command ends a stream-json session with exit 2.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import aclosing
from typing import Any

from core.platform import build_windows_command, find_executable

from .base import AgentMessage, MessageRole
from .cli_subprocess import (
    CliSubprocessAgentClient,
    ProcessFactory,
    as_int,
    declares_no_writes,
    declares_shell,
    safe_error_text,
    text_message,
    tool_messages,
    validated_option,
)

logger = logging.getLogger(__name__)

#: What a WorkPilot agent type may be handed on Antigravity.
#:   full   edits and commands, inside the terminal sandbox
#:   edits  file edits only; commands follow the user's permission rules
ANTIGRAVITY_PERMISSIONS = ("full", "edits")

#: `--effort` values the CLI accepts.
ANTIGRAVITY_EFFORTS = ("low", "medium", "high")

_EFFORT_BY_LEVEL = {
    "low": "low",
    "medium": "medium",
    "high": "high",
    "xhigh": "high",
    "ultrathink": "high",
    "max": "high",
}

_SUCCESS = "SUCCESS"


class AntigravityCliError(RuntimeError):
    """A safe, user-facing failure from the Antigravity CLI boundary."""


class AntigravityCliAuthenticationError(AntigravityCliError):
    """Antigravity has no cached sign-in for headless runs."""


def antigravity_permission_for(agent_type: str) -> str:
    """`full` or `edits` from the type's declaration; a read-only type is refused."""
    if declares_no_writes(agent_type):
        raise ValueError(
            f"agent_type '{agent_type}' declares none of Write, Edit or Bash, and "
            "the Antigravity CLI cannot be restricted to read-only: its plan mode "
            "is an instruction, not a barrier, and user settings can pre-grant "
            "writes to a headless run. Run this agent on another provider."
        )
    return "full" if declares_shell(agent_type) else "edits"


def antigravity_effort(level: str | None, model: str | None = None) -> str | None:
    """The ``--effort`` value for a WorkPilot thinking level, or None to omit it.

    A model slug that already names its effort (``gemini-3.8-flash-medium``)
    keeps it: the flag would contradict the slug.
    """
    if model and model.rsplit("-", 1)[-1] in ANTIGRAVITY_EFFORTS:
        return None
    return _EFFORT_BY_LEVEL.get((level or "").strip().lower())


def build_antigravity_args(
    *,
    executable: str,
    model: str | None,
    conversation_id: str | None,
    effort: str | None,
    permission: str,
) -> list[str]:
    """A shell-free ``agy`` command in stream-json print mode.

    The prompt is written to stdin (`antigravity_stdin_payload`); nothing here
    carries it or the project path.
    """
    if permission not in ANTIGRAVITY_PERMISSIONS:
        raise ValueError(f"Unknown Antigravity permission level: {permission!r}")
    args = [
        executable,
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
    ]
    if conversation_id:
        args.extend(
            [
                "--conversation",
                validated_option(conversation_id, "conversation id", "Antigravity"),
            ]
        )
    if model:
        args.extend(["--model", validated_option(model, "model", "Antigravity")])
    if effort in ANTIGRAVITY_EFFORTS:
        args.extend(["--effort", effort])
    if permission == "full":
        args.extend(["--dangerously-skip-permissions", "--sandbox"])
    else:
        args.extend(["--mode", "accept-edits"])
    return args


def antigravity_stdin_payload(prompt: str) -> bytes:
    """One ``user`` event, newline-terminated, as stream-json input expects."""
    event = {"event": "user", "message": {"content": prompt}}
    return (json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8")


def context_tokens_from_usage(usage: dict[str, Any]) -> int | None:
    """The prompt tokens one step sent — what the window held for it.

    Whether ``input_tokens`` already includes ``cache_read_tokens`` is not
    documented. ``total_tokens`` settles it when present: a total that covers
    input, output, thinking *and* the cache reads means they are separate. With
    no total the cache reads are added — over-counting compacts a little early,
    under-counting overflows.
    """
    if not isinstance(usage, dict):
        return None
    fresh = as_int(usage.get("input_tokens"))
    cached = as_int(usage.get("cache_read_tokens"))
    if not fresh and not cached:
        return None
    total = usage.get("total_tokens")
    if isinstance(total, (int, float)) and not isinstance(total, bool) and cached:
        visible = (
            fresh
            + as_int(usage.get("output_tokens"))
            + as_int(usage.get("thinking_tokens"))
        )
        return fresh + cached if int(total) >= visible + cached else fresh
    return fresh + cached


def _stderr_error_line(stderr: str) -> str:
    """The text after the stable ``error:`` marker, else all of stderr."""
    for line in stderr.splitlines():
        stripped = line.strip()
        if stripped.lower().startswith("error:"):
            return stripped[len("error:") :].strip()
    return stderr


def _antigravity_error(value: object) -> AntigravityCliError:
    safe_text = safe_error_text(value)
    lowered = safe_text.lower()
    if any(
        marker in lowered
        for marker in (
            "authentication required",
            "authentication expired",
            "log back in",
            "not signed in",
            "not authenticated",
            "unauthenticated",
            "lack required scopes",
        )
    ):
        return AntigravityCliAuthenticationError(
            "Antigravity CLI is not signed in for headless runs. Run 'agy' once "
            "in a terminal and sign in (or set GEMINI_API_KEY), then try again."
        )
    if "model" in lowered and any(
        marker in lowered
        for marker in ("unknown model", "not found", "invalid model", "not a valid")
    ):
        return AntigravityCliError(
            "Antigravity CLI rejected the selected model. Choose a model listed by "
            "'agy models', or clear the model override to use the CLI's default."
        )
    return AntigravityCliError(f"Antigravity CLI failed: {safe_text}")


def _payload(event: dict[str, Any], name: str) -> dict[str, Any]:
    """The event's payload, nested under its own name or inline."""
    nested = event.get(name)
    return nested if isinstance(nested, dict) else event


class AntigravityCliAgentClient(CliSubprocessAgentClient):
    """Run an agent turn through ``agy`` in stream-json print mode."""

    cli_label = "Antigravity CLI"

    def __init__(
        self,
        *,
        model: str | None = None,
        system_prompt: str | None = None,
        project_dir: str,
        agent_type: str = "coder",
        thinking_level: str | None = None,
        conversation_id: str | None = None,
        executable: str | None = None,
        process_factory: ProcessFactory | None = None,
    ) -> None:
        # Refused before anything else, so the mistake surfaces at the call
        # site rather than as a CLI that wrote where it should only have read.
        self.permission = antigravity_permission_for(agent_type)
        candidate = (model or "").strip()
        super().__init__(
            model=None if candidate.lower() in {"", "default"} else candidate,
            system_prompt=system_prompt,
            project_dir=project_dir,
            agent_type=agent_type,
            session_id=conversation_id,
            executable=executable,
            process_factory=process_factory,
        )
        self._thinking_level = thinking_level

    def provider_name(self) -> str:
        return "antigravity"

    def _resolve_executable(self) -> str | None:
        return self._executable or find_executable("agy")

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        prompt = self._take_prompt()
        if not prompt:
            return
        try:
            async with aclosing(self._attempt(prompt)) as attempt:
                async for message in attempt:
                    yield message
        except AntigravityCliError as error:
            if self.model == "default" or "rejected the selected model" not in str(
                error
            ):
                raise
            rejected = self.model
            self.model = "default"
            logger.warning(
                "[AntigravityCliAgentClient] Model %s is unavailable; retrying once "
                "with the Antigravity CLI default",
                rejected,
            )
            async with aclosing(self._attempt(prompt)) as attempt:
                async for message in attempt:
                    yield message

    def _capture_conversation(self, payload: dict[str, Any]) -> None:
        conversation = payload.get("conversation_id")
        if isinstance(conversation, str) and conversation:
            self.session_id = conversation
            self.last_session_id = conversation

    async def _attempt(self, prompt: str) -> AsyncIterator[AgentMessage]:
        executable = self._resolve_executable()
        if not executable:
            raise AntigravityCliError(
                "Antigravity CLI ('agy') is not installed or is not available on PATH."
            )
        model = None if self.model == "default" else self.model
        try:
            logical = build_antigravity_args(
                executable=executable,
                model=model,
                conversation_id=self.session_id,
                effort=antigravity_effort(self._thinking_level, model),
                permission=self.permission,
            )
            command = build_windows_command(logical[0], logical[1:])
            process = await self._spawn(command, antigravity_stdin_payload(prompt))
        except (OSError, RuntimeError, ValueError) as error:
            raise _antigravity_error(error) from error

        self.last_context_tokens = None
        stderr_task = asyncio.create_task(process.stderr.read())
        buffers: dict[Any, str] = {}
        text_seen = False
        tool_seen = False
        result_seen = False
        usage_seen = False

        def flush(step: Any) -> AgentMessage | None:
            nonlocal text_seen
            text = buffers.pop(step, "")
            if not text.strip():
                return None
            text_seen = True
            return text_message(MessageRole.ASSISTANT, text)

        try:
            async for event in self._json_events(process):
                name = event.get("event") or event.get("type")
                if name == "init":
                    self._capture_conversation(event)
                    self._capture_conversation(_payload(event, "init"))
                elif name == "step_update":
                    step = _payload(event, "step_update")
                    self._capture_conversation(step)
                    index = step.get("step_index")
                    step_type = step.get("step_type")
                    delta = step.get("text_delta")
                    if step_type == "agent_response" and isinstance(delta, str):
                        buffers[index] = buffers.get(index, "") + delta
                    usage = step.get("usage")
                    context = context_tokens_from_usage(usage)
                    if context is not None:
                        usage_seen = True
                        self.last_context_tokens = context
                    if step.get("state") == "DONE":
                        if step_type == "agent_response":
                            message = flush(index)
                            if message:
                                yield message
                        elif step_type == "tool":
                            tool_seen = True
                            info = step.get("tool_info")
                            for message in tool_messages(
                                tool_id=f"agy-step-{index}",
                                name=str(step.get("tool_name") or "tool"),
                                tool_input=info if isinstance(info, dict) else None,
                                output="",
                                is_error=False,
                            ):
                                yield message
                elif name == "result":
                    result = _payload(event, "result")
                    result_seen = True
                    self._capture_conversation(result)
                    for index in list(buffers):
                        message = flush(index)
                        if message:
                            yield message
                    usage = result.get("usage")
                    if isinstance(usage, dict):
                        self.last_usage = {
                            key: as_int(value)
                            for key, value in usage.items()
                            if isinstance(value, (int, float))
                            and not isinstance(value, bool)
                        }
                        if self.last_context_tokens is None:
                            self.last_context_tokens = context_tokens_from_usage(usage)
                        usage_seen = usage_seen or self.last_context_tokens is not None
                    denied = result.get("denied_actions")
                    if isinstance(denied, list) and denied:
                        yield text_message(
                            MessageRole.SYSTEM,
                            "Antigravity CLI denied "
                            f"{len(denied)} action(s) this agent was not permitted "
                            "to take: "
                            + safe_error_text(
                                json.dumps(denied, ensure_ascii=False, default=str)
                            ),
                        )
                    status = str(result.get("status") or _SUCCESS).upper()
                    if status != _SUCCESS:
                        raise _antigravity_error(result.get("error") or status)
                    response = result.get("response")
                    if not text_seen and isinstance(response, str) and response.strip():
                        text_seen = True
                        yield text_message(MessageRole.ASSISTANT, response)

            returncode = await process.wait()
            stderr = (await stderr_task).decode("utf-8", "replace")
            if returncode != 0:
                raise _antigravity_error(
                    _stderr_error_line(stderr) or f"exit status {returncode}"
                )
            self.context_usage_source = "reported" if usage_seen else "estimated"
            if not text_seen and not tool_seen:
                detail = _stderr_error_line(stderr).strip()
                if detail and not result_seen:
                    raise _antigravity_error(detail)
                raise AntigravityCliError("Antigravity CLI returned no response.")
        except asyncio.CancelledError:
            await self._stop_process()
            raise
        finally:
            if not stderr_task.done():
                stderr_task.cancel()
            await asyncio.gather(stderr_task, return_exceptions=True)
            await self._stop_process()
