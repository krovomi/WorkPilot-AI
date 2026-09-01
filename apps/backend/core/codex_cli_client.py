"""AgentClient adapter for authenticated Codex CLI sessions.

Authentication remains entirely owned by Codex. WorkPilot invokes the public
``codex exec --json`` boundary and never reads or forwards OAuth credentials.
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

from core.agent_client import (
    AgentClient,
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    MessageRole,
)
from core.platform import build_windows_command, find_executable

logger = logging.getLogger(__name__)

_SAFE_OPTION_VALUE = re.compile(r"^[A-Za-z0-9._:/-]+$")
_ProcessFactory = Callable[..., Awaitable[Any]]


class CodexCliError(RuntimeError):
    """A safe, user-facing failure from the Codex CLI boundary."""


class CodexCliAuthenticationError(CodexCliError):
    """The existing Codex CLI session is missing or no longer valid."""


def openai_uses_codex_cli() -> bool:
    """Return whether OpenAI execution should reuse the Codex CLI session."""
    return os.environ.get("OPENAI_AUTH_MODE", "api-key").strip().lower() == "codex-cli"


def _validated_option(value: str, label: str) -> str:
    """Reject option values that could alter a Windows launcher command."""
    if not _SAFE_OPTION_VALUE.fullmatch(value):
        raise ValueError(f"Invalid Codex {label}: {value!r}")
    return value


def build_codex_exec_args(
    *,
    executable: str,
    project_dir: str | Path,
    model: str | None,
    reasoning_effort: str | None,
    prompt: str,
    thread_id: str | None,
) -> list[str]:
    """Build a shell-free Codex command; the prompt is always sent on stdin."""
    # Both values are deliberately excluded from launcher arguments. ``cwd``
    # carries the project directory to the subprocess; this is essential for
    # npm ``.cmd`` launchers because their argument vector is ultimately parsed
    # by cmd.exe on Windows.
    del project_dir, prompt

    if thread_id:
        return [
            executable,
            "exec",
            "resume",
            _validated_option(thread_id, "thread id"),
            "--json",
            "-",
        ]

    args = [
        executable,
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
    ]
    if model:
        args.extend(["--model", _validated_option(model, "model")])
    if reasoning_effort:
        effort = _validated_option(reasoning_effort, "reasoning effort")
        args.extend(["-c", f'model_reasoning_effort="{effort}"'])
    args.append("-")
    return args


def _text_message(role: MessageRole, text: str) -> AgentMessage:
    return AgentMessage(
        role=role,
        content=[ContentBlock(type=ContentBlockType.TEXT, text=text)],
    )


def _safe_error_text(value: object) -> str:
    """Return a compact diagnostic with credential-shaped values redacted."""
    if isinstance(value, dict):
        value = value.get("message") or value.get("error") or value.get("detail")
    text = str(value or "unknown error").replace("\x00", "").strip()
    text = re.sub(
        r"\bBearer\s+[^\s,;]+", "Bearer [REDACTED]", text, flags=re.IGNORECASE
    )
    text = re.sub(r"\bsk-[A-Za-z0-9._-]{8,}\b", "[REDACTED_API_KEY]", text)
    text = re.sub(
        r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b",
        "[REDACTED_JWT]",
        text,
    )
    text = re.sub(
        r"(?i)\b(access_token|refresh_token|id_token|token|secret|api_key)"
        r"\s*[=:]\s*[\"']?[^\"',;\s}]+",
        r"\1=[REDACTED]",
        text,
    )
    return " ".join(text.split())[:1000]


def _codex_error(value: object) -> CodexCliError:
    safe_text = _safe_error_text(value)
    lowered = safe_text.lower()
    if any(
        marker in lowered
        for marker in (
            "not logged in",
            "not authenticated",
            "authentication",
            "unauthorized",
            "invalid token",
            "token expired",
        )
    ):
        return CodexCliAuthenticationError(
            "Codex CLI authentication error. Run 'codex login' and try again."
        )
    return CodexCliError(f"Codex CLI failed: {safe_text}")


class CodexCliAgentClient(AgentClient):
    """Run an agent turn through ``codex exec --json``."""

    def __init__(
        self,
        *,
        model: str | None = None,
        system_prompt: str | None = None,
        project_dir: str,
        agent_type: str = "coder",
        reasoning_effort: str | None = None,
        thread_id: str | None = None,
        executable: str | None = None,
        process_factory: _ProcessFactory | None = None,
    ) -> None:
        self.model = model or "default"
        self.system_prompt = system_prompt
        self._project_dir = str(Path(project_dir))
        self._agent_type = agent_type
        self._reasoning_effort = reasoning_effort
        self._executable = executable
        self._process_factory = process_factory or asyncio.create_subprocess_exec
        self._pending_query: str | None = None
        self._process: Any = None
        self.thread_id = thread_id
        self.last_session_id = thread_id
        self.last_usage: dict[str, int] | None = None

    async def __aenter__(self) -> CodexCliAgentClient:
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        await self._stop_process()

    def supports_subagents(self) -> bool:
        # Codex may coordinate internally, but WorkPilot must not inject its
        # Claude-SDK subagent roster into this provider contract.
        return False

    def provider_name(self) -> str:
        return "openai-codex-cli"

    async def query(self, prompt: str) -> None:
        self._pending_query = prompt

    def _compose_prompt(self, prompt: str) -> str:
        sections: list[str] = []
        if self.system_prompt:
            sections.append(self.system_prompt)
        history = getattr(self, "_resumed_history", None)
        if history:
            sections.append(self._format_history_as_preamble(history))
            self._resumed_history = []
        sections.append(prompt)
        return "\n\n".join(section for section in sections if section)

    def _resolve_executable(self) -> str | None:
        return self._executable or find_executable("codex")

    async def _start_process(self, prompt: str) -> Any:
        executable = self._resolve_executable()
        if not executable:
            raise FileNotFoundError(
                "Codex CLI is not installed or is not available on PATH."
            )
        logical_args = build_codex_exec_args(
            executable=executable,
            project_dir=self._project_dir,
            model=None if self.model == "default" else self.model,
            reasoning_effort=self._reasoning_effort,
            prompt=prompt,
            thread_id=self.thread_id,
        )
        command = build_windows_command(logical_args[0], logical_args[1:])
        process = await self._process_factory(
            *command,
            cwd=self._project_dir,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._process = process
        if process.stdin is None:
            raise RuntimeError("Codex CLI stdin pipe is unavailable.")
        process.stdin.write(prompt.encode("utf-8"))
        await process.stdin.drain()
        process.stdin.close()
        return process

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        if not self._pending_query:
            return

        prompt = self._compose_prompt(self._pending_query)
        self._pending_query = None
        final_message_seen = False

        try:
            process = await self._start_process(prompt)
        except (FileNotFoundError, OSError, RuntimeError, ValueError) as error:
            raise _codex_error(error) from error

        stderr_task = asyncio.create_task(process.stderr.read())
        try:
            while True:
                raw_line = await process.stdout.readline()
                if not raw_line:
                    break
                try:
                    event = json.loads(raw_line.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    logger.warning(
                        "[CodexCliAgentClient] Ignoring malformed JSONL event"
                    )
                    continue

                event_type = event.get("type")
                if event_type == "thread.started":
                    thread_id = event.get("thread_id")
                    if isinstance(thread_id, str) and thread_id:
                        self.thread_id = thread_id
                        self.last_session_id = thread_id
                elif event_type == "item.completed":
                    item = event.get("item") or {}
                    if item.get("type") == "agent_message" and isinstance(
                        item.get("text"), str
                    ):
                        final_message_seen = True
                        yield _text_message(MessageRole.ASSISTANT, item["text"])
                elif event_type == "turn.completed":
                    usage = event.get("usage")
                    if isinstance(usage, dict):
                        self.last_usage = {
                            key: int(value)
                            for key, value in usage.items()
                            if isinstance(value, (int, float))
                        }
                elif event_type in {"turn.failed", "error"}:
                    detail = (
                        event.get("message")
                        or event.get("error")
                        or event.get("detail")
                    )
                    raise _codex_error(detail)

            returncode = await process.wait()
            stderr = _safe_error_text((await stderr_task).decode("utf-8", "replace"))
            if returncode != 0:
                raise _codex_error(stderr)
            elif not final_message_seen:
                raise CodexCliError("Codex CLI returned no final response.")
        except asyncio.CancelledError:
            await self._stop_process()
            raise
        finally:
            if not stderr_task.done():
                stderr_task.cancel()
            await asyncio.gather(stderr_task, return_exceptions=True)
            await self._stop_process()

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
