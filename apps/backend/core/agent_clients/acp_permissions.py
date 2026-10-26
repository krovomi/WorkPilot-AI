"""Who answers an ACP agent's `session/request_permission`, and how.

An Agent Client Protocol agent asks its client before it acts (Gemini CLI asks
before a write or a shell command it does not read as harmless). WorkPilot
puts the question on the task card and waits for the person:

- **In the app** (``WORKPILOT_PERMISSION_CHANNEL=stdin``, set by the Electron
  main for a task process): the question leaves as a ``PERMISSION_REQUESTED``
  task event on stdout; the answer comes back as one line on this process's
  stdin, ``__WORKPILOT_PERMISSION_ANSWER__:{"requestId", "optionId"}``. Only
  the main process writes that pipe. The agent is this process's child with
  pipes of its own, so nothing it prints or writes can answer for the person.
- **In a terminal** (stdin is a TTY): the question is printed and read there.
- **Anywhere else**: nobody can answer, and the request is refused.

No answer within ``WORKPILOT_PERMISSION_TIMEOUT_SECONDS`` (30 minutes by
default) is a refusal. An answer must name an option the agent offered for
that request; anything else is ignored.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
import threading
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

logger = logging.getLogger(__name__)

__all__ = [
    "ANSWER_PREFIX",
    "CHANNEL_ENV",
    "TIMEOUT_ENV",
    "PermissionBroker",
    "PermissionOption",
    "PermissionQuestion",
    "StdinBroker",
    "TerminalBroker",
    "UnansweredBroker",
    "broker_for",
    "display_text",
]

CHANNEL_ENV = "WORKPILOT_PERMISSION_CHANNEL"
TIMEOUT_ENV = "WORKPILOT_PERMISSION_TIMEOUT_SECONDS"
ANSWER_PREFIX = "__WORKPILOT_PERMISSION_ANSWER__:"
DEFAULT_TIMEOUT_SECONDS = 30 * 60

#: The option kinds ACP defines (`PermissionOptionKind`).
OPTION_KINDS = ("allow_once", "allow_always", "reject_once", "reject_always")

_CONTROL = re.compile(
    r"[\x00-\x08\x0b-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]"
)
_SPACES = re.compile(r"\s+")


def display_text(value: object, limit: int) -> str:
    """Agent-written text, made safe to show: one line, no control or bidi
    characters, bounded. It is shown, never interpreted."""
    text = _SPACES.sub(" ", _CONTROL.sub("", str(value or ""))).strip()
    return text if len(text) <= limit else f"{text[: limit - 1]}…"


@dataclass(frozen=True)
class PermissionOption:
    option_id: str
    name: str
    kind: str


@dataclass(frozen=True)
class PermissionQuestion:
    """One request, as the person sees it."""

    agent: str
    title: str
    kind: str
    options: tuple[PermissionOption, ...]
    locations: tuple[str, ...] = ()
    request_id: str = field(default_factory=lambda: str(uuid.uuid4()))

    def option(self, option_id: object) -> PermissionOption | None:
        return next((o for o in self.options if o.option_id == option_id), None)


class PermissionBroker(Protocol):
    async def ask(self, question: PermissionQuestion) -> str | None:
        """The option the person chose, or None for no answer."""
        ...


def _timeout_seconds() -> float:
    try:
        value = float(os.environ.get(TIMEOUT_ENV, ""))
    except ValueError:
        return DEFAULT_TIMEOUT_SECONDS
    return value if value > 0 else DEFAULT_TIMEOUT_SECONDS


class UnansweredBroker:
    """Nobody to ask: every request is refused, and the feed says why."""

    def __init__(self, reason: str) -> None:
        self.reason = reason

    async def ask(self, question: PermissionQuestion) -> str | None:
        logger.warning(
            "[acp] %s asked to %s; refused: %s",
            question.agent,
            question.title,
            self.reason,
        )
        return None


class _StdinAnswers:
    """The answers the main process writes on stdin, read by one thread."""

    _lock = threading.Lock()
    _instance: _StdinAnswers | None = None

    def __init__(self, stream: Any = None) -> None:
        self._waiters: dict[
            str, tuple[asyncio.AbstractEventLoop, asyncio.Future[str]]
        ] = {}
        self._mutex = threading.Lock()
        self._stream = (
            stream if stream is not None else getattr(sys.stdin, "buffer", None)
        )
        threading.Thread(
            target=self._read, name="workpilot-permission-answers", daemon=True
        ).start()

    @classmethod
    def shared(cls) -> _StdinAnswers:
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    def _read(self) -> None:
        if self._stream is None:
            return
        for raw in self._stream:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith(ANSWER_PREFIX):
                continue
            try:
                answer = json.loads(line[len(ANSWER_PREFIX) :])
            except json.JSONDecodeError:
                continue
            if not isinstance(answer, dict):
                continue
            request_id, option_id = answer.get("requestId"), answer.get("optionId")
            if not isinstance(request_id, str) or not isinstance(option_id, str):
                continue
            with self._mutex:
                waiter = self._waiters.pop(request_id, None)
            if waiter is not None:
                loop, future = waiter
                loop.call_soon_threadsafe(_settle, future, option_id)

    def wait(self, request_id: str) -> asyncio.Future[str]:
        loop = asyncio.get_running_loop()
        future: asyncio.Future[str] = loop.create_future()
        with self._mutex:
            self._waiters[request_id] = (loop, future)
        return future

    def forget(self, request_id: str) -> None:
        with self._mutex:
            self._waiters.pop(request_id, None)


def _settle(future: asyncio.Future[str], value: str) -> None:
    if not future.done():
        future.set_result(value)


class StdinBroker:
    """The question goes to the card; the answer comes back on stdin."""

    def __init__(self, spec_dir: Path, *, answers: _StdinAnswers | None = None) -> None:
        from core.task_event import TaskEventEmitter

        self._emitter = TaskEventEmitter.from_spec_dir(spec_dir)
        self._answers = answers

    async def ask(self, question: PermissionQuestion) -> str | None:
        answers = self._answers or _StdinAnswers.shared()
        timeout = _timeout_seconds()
        future = answers.wait(question.request_id)
        expires = datetime.now(UTC) + timedelta(seconds=timeout)
        self._emitter.emit(
            "PERMISSION_REQUESTED",
            {
                "request": {
                    "requestId": question.request_id,
                    "agent": question.agent,
                    "title": question.title,
                    "kind": question.kind,
                    "options": [
                        {"optionId": o.option_id, "name": o.name, "kind": o.kind}
                        for o in question.options
                    ],
                    "locations": list(question.locations),
                    "expiresAt": expires.isoformat(),
                }
            },
        )
        outcome, chosen = "timeout", None
        try:
            while True:
                option_id = await asyncio.wait_for(asyncio.shield(future), timeout)
                if question.option(option_id) is not None:
                    outcome, chosen = "answered", option_id
                    break
                # Not an option of this request: ignored, the question stands.
                logger.warning("[acp] ignored an answer naming no offered option")
                future = answers.wait(question.request_id)
        except TimeoutError:
            pass
        except asyncio.CancelledError:
            outcome = "cancelled"
            raise
        finally:
            answers.forget(question.request_id)
            self._emitter.emit(
                "PERMISSION_RESOLVED",
                {
                    "requestId": question.request_id,
                    "outcome": outcome,
                    "optionId": chosen,
                },
            )
        return chosen


class TerminalBroker:
    """The question printed in the terminal the build runs in."""

    async def ask(self, question: PermissionQuestion) -> str | None:
        lines = [f"\n{question.agent} asks: {question.title}"]
        lines += [f"  {i}. {o.name}" for i, o in enumerate(question.options, start=1)]
        prompt = "\n".join(lines) + "\nChoice (empty = refuse): "
        try:
            raw = await asyncio.wait_for(
                asyncio.to_thread(input, prompt), _timeout_seconds()
            )
        except (TimeoutError, EOFError):
            return None
        try:
            index = int(raw.strip()) - 1
        except ValueError:
            return None
        if 0 <= index < len(question.options):
            return question.options[index].option_id
        return None


def broker_for(spec_dir: Path | str | None) -> PermissionBroker:
    """The broker for this process: the app, a terminal, or nobody."""
    channel = os.environ.get(CHANNEL_ENV, "").strip().lower()
    if channel == "stdin" and spec_dir:
        return StdinBroker(Path(spec_dir))
    try:
        interactive = sys.stdin.isatty()
    except (AttributeError, ValueError):
        interactive = False
    if interactive:
        return TerminalBroker()
    return UnansweredBroker(
        "this run has no one to ask (start it from the app, or in a terminal)"
    )
