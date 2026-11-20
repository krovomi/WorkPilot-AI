"""A stand-in model for the GitHub PR reviewers, the only thing they don't run for real.

The reviewers reach a model two ways, and the stand-in speaks both:

- ``create_agent_client`` (``core.client``): a provider-neutral ``AgentClient``
  whose stream is ``AgentMessage`` objects. ``StandInModel.agent`` builds one.
- ``create_client`` / ``create_simple_client``: the Claude SDK's own client,
  whose stream is the SDK's message classes (``AssistantMessage``,
  ``ResultMessage``...). ``StandInModel.sdk`` builds one, with the real classes.

Answers are scripted by prompt: ``model.answer("Security", text(...))`` makes
every session whose prompt contains "Security" stream those messages; an answer
with no ``when`` is the default. An exception among the messages is raised
where it stands in the stream. Every client made is kept, with the options it
was made with and the prompt it got, in ``model.clients``.

    model = StandInModel()
    monkeypatch.setattr(importlib.import_module("core.client"),
                        "create_agent_client", model.agent)
    model.answer(text('{"findings": []}'))
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any

from core.agent_client import (
    AgentClient,
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    MessageRole,
)

__all__ = [
    "StandInModel",
    "result",
    "structured",
    "text",
    "thinking",
    "tool_result",
    "tool_use",
]


def _message(block: ContentBlock, role: MessageRole = MessageRole.ASSISTANT):
    return AgentMessage(role=role, content=[block])


def text(value: str) -> AgentMessage:
    return _message(ContentBlock(type=ContentBlockType.TEXT, text=value))


def thinking(value: str) -> AgentMessage:
    return _message(ContentBlock(type=ContentBlockType.THINKING, text=value))


def structured(data: dict[str, Any]) -> AgentMessage:
    return _message(
        ContentBlock(type=ContentBlockType.STRUCTURED_OUTPUT, structured_output=data)
    )


def tool_use(name: str, tool_input: dict[str, Any], tool_id: str) -> AgentMessage:
    return _message(
        ContentBlock(
            type=ContentBlockType.TOOL_USE,
            tool_name=name,
            tool_id=tool_id,
            tool_input=tool_input,
        )
    )


def tool_result(tool_id: str, content: Any, is_error: bool = False) -> AgentMessage:
    return _message(
        ContentBlock(
            type=ContentBlockType.TOOL_RESULT,
            tool_use_id=tool_id,
            result_content=content,
            is_error=is_error,
        ),
        role=MessageRole.USER,
    )


def result(
    subtype: str = "success", data: dict[str, Any] | None = None
) -> AgentMessage:
    return _message(
        ContentBlock(
            type=ContentBlockType.RESULT, subtype=subtype, structured_output=data
        ),
        role=MessageRole.SYSTEM,
    )


class _Session:
    """What every stand-in client shares: its options, its prompt, its answer."""

    def __init__(self, model: StandInModel, options: dict[str, Any]):
        self.model = model
        self.options = options
        self.prompt: str | None = None

    def _reply(self) -> list[Any]:
        return self.model.reply_for(self.prompt or "", self.options)


class _AgentSession(_Session, AgentClient):
    """An ``AgentClient``, as ``create_agent_client`` returns for any provider."""

    async def query(self, prompt: str) -> None:
        self.prompt = prompt

    async def receive_response(self):
        for item in self._reply():
            if isinstance(item, BaseException):
                raise item
            yield item

    def supports_subagents(self) -> bool:
        return True

    def provider_name(self) -> str:
        return "stand-in"

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        return False


class _SdkSession(_Session):
    """The Claude SDK's client: raw SDK messages, no ``AgentMessage`` wrapper."""

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt: str) -> None:
        self.prompt = prompt

    async def receive_response(self):
        for item in self._reply():
            if isinstance(item, BaseException):
                raise item
            yield item


class StandInModel:
    """Scripted answers by prompt, and a record of every session."""

    def __init__(self) -> None:
        self._answers: list[tuple[str | None, Callable[..., Iterable[Any]]]] = []
        self.clients: list[_Session] = []
        self.fail_to_create: list[BaseException] = []

    def answer(self, *messages: Any, when: str | None = None) -> None:
        """Stream ``messages`` to a session whose prompt contains ``when``."""
        self._answers.append((when, lambda _prompt, _options: list(messages)))

    def answer_with(
        self, reply: Callable[[str, dict[str, Any]], Iterable[Any]], when=None
    ) -> None:
        """Stream what ``reply(prompt, options)`` returns, for each session."""
        self._answers.append((when, reply))

    def reply_for(self, prompt: str, options: dict[str, Any]) -> list[Any]:
        for when, reply in self._answers:
            if when is not None and when in prompt:
                return list(reply(prompt, options))
        for when, reply in self._answers:
            if when is None:
                return list(reply(prompt, options))
        return []

    def _made(self, session: _Session) -> _Session:
        if self.fail_to_create:
            raise self.fail_to_create.pop(0)
        self.clients.append(session)
        return session

    def agent(self, **options: Any) -> _AgentSession:
        """Stands in for ``core.client.create_agent_client``."""
        return self._made(_AgentSession(self, options))

    def sdk(self, **options: Any) -> _SdkSession:
        """Stands in for ``create_client`` / ``create_simple_client``."""
        return self._made(_SdkSession(self, options))

    @property
    def prompts(self) -> list[str | None]:
        return [client.prompt for client in self.clients]
