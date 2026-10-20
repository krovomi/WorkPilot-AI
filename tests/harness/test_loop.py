"""The WorkPilot loop (``harness.application.loop``), against a fake port.

No provider behind it: a scripted adapter that records what the loop asks of
it. The five real adapters are pinned by their own tests in ``tests/core/``;
here, the loop's order and its decisions.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

import pytest
from harness.application.loop import run_turns
from harness.domain import CallUsage, UsageLedger
from harness.domain.progress import NO_PROGRESS_STOP, PROGRESS_NUDGE
from harness.ports import Measured, Outcome, Reply, ToolCall, ToolResult

READ = ToolCall("call_1", "read_file", {"path": "a.py"})
LIST = ToolCall("call_2", "list_files", {})


class _Port:
    """Plays one scripted answer per call, and logs every request made of it."""

    provider = "fake"

    def __init__(self, answers, *, settle=None, results=None):
        self._answers = list(answers)
        self._settle = settle or (lambda reply, turn: ([], Outcome.DONE))
        self._results = results or (lambda n, call: "x = 1\n")
        self.log: list[tuple] = []
        self.executed = 0

    def assemble(self, turn):
        self.log.append(("assemble", turn))
        return {"turn": turn}

    async def call(self, request, turn):
        self.log.append(("call", request["turn"]))
        answer = self._answers.pop(0) if len(self._answers) > 1 else self._answers[0]
        for event in answer:
            yield event

    def settle(self, reply, turn):
        self.log.append(("settle", turn))
        return self._settle(reply, turn)

    def announce(self, call, turn):
        self.log.append(("announce", call.name, turn))

    async def execute(self, call):
        self.executed += 1
        self.log.append(("execute", call.name))
        return ToolResult(self._results(self.executed, call))

    def reinject(self, reply, results):
        self.log.append(("reinject", len(reply.calls), len(results)))

    def remind(self, text):
        self.log.append(("remind", text))

    def clear(self):
        self.log.append(("clear",))

    def finish(self, reason):
        self.log.append(("finish", reason))

    def text(self, text):
        return ("text", text)

    def notice(self, text):
        return ("notice", text)

    def tool_use(self, call):
        return ("use", call.id)

    def tool_result(self, call, result):
        return ("result", call.id, result.text, result.is_error)


async def _run(port, *, max_turns=50, ledger=None):
    ledger = ledger if ledger is not None else UsageLedger()
    return [m async for m in run_turns(port, max_turns=max_turns, ledger=ledger)]


def _steps(port, name):
    return [entry for entry in port.log if entry[0] == name]


@pytest.mark.asyncio
async def test_a_reply_without_calls_is_settled_and_ends():
    port = _Port([[Reply("All done.")]])

    messages = await _run(port)

    assert messages == [("text", "All done.")]
    assert port.log == [
        ("assemble", 0),
        ("call", 0),
        ("settle", 0),
        ("finish", "natural_end"),
    ]


@pytest.mark.asyncio
async def test_a_tool_turn_executes_every_call_then_asks_again():
    port = _Port([[Reply("Looking.", (READ, LIST))], [Reply("Done.")]])

    messages = await _run(port)

    assert messages == [
        ("text", "Looking."),
        ("use", "call_1"),
        ("result", "call_1", "x = 1\n", False),
        ("use", "call_2"),
        ("result", "call_2", "x = 1\n", False),
        ("text", "Done."),
    ]
    assert port.log == [
        ("assemble", 0),
        ("call", 0),
        ("announce", "read_file", 0),
        ("execute", "read_file"),
        ("announce", "list_files", 0),
        ("execute", "list_files"),
        ("reinject", 2, 2),
        ("clear",),
        ("assemble", 1),
        ("call", 1),
        ("settle", 1),
        ("finish", "natural_end"),
    ]


@pytest.mark.asyncio
async def test_a_call_passes_its_messages_on_and_its_measure_to_the_ledger():
    usage = CallUsage(1_000, 512, None, 20)
    port = _Port([["heartbeat", Measured(usage), Measured(None), Reply("Done.")]])
    ledger = UsageLedger()

    messages = await _run(port, ledger=ledger)

    assert messages == ["heartbeat", ("text", "Done.")]
    # Nothing reported is nothing recorded.
    assert ledger.calls == [usage]


@pytest.mark.asyncio
async def test_a_halt_ends_the_response_without_finishing_it():
    port = _Port([[("notice", "API error (500)"), Outcome.HALT]])

    messages = await _run(port)

    assert messages == [("notice", "API error (500)")]
    assert _steps(port, "finish") == []


@pytest.mark.asyncio
async def test_a_call_that_says_nothing_halts():
    port = _Port([[]])

    assert await _run(port) == []
    assert _steps(port, "finish") == []


@pytest.mark.asyncio
async def test_a_retried_turn_counts_against_max_turns_and_clears_nothing():
    port = _Port([[Outcome.AGAIN]])

    messages = await _run(port, max_turns=3)

    assert messages == []
    assert _steps(port, "call") == [("call", 0), ("call", 1), ("call", 2)]
    assert _steps(port, "clear") == []
    assert port.log[-1] == ("finish", "max_turns")


@pytest.mark.asyncio
async def test_settle_can_ask_again_or_halt():
    verdicts = iter(
        [([("text", "nudged")], Outcome.AGAIN), ([("notice", "gave up")], Outcome.HALT)]
    )
    port = _Port(
        [[Reply("I would read it.")]], settle=lambda reply, turn: next(verdicts)
    )

    messages = await _run(port)

    assert messages == [
        ("text", "I would read it."),
        ("text", "nudged"),
        ("text", "I would read it."),
        ("notice", "gave up"),
    ]
    assert _steps(port, "settle") == [("settle", 0), ("settle", 1)]
    assert _steps(port, "finish") == []


@pytest.mark.asyncio
async def test_a_model_that_repeats_itself_is_nudged_once_then_stopped():
    port = _Port([[Reply("", (READ,))]])

    messages = await _run(port)

    assert len(_steps(port, "call")) == 5
    assert _steps(port, "remind") == [("remind", PROGRESS_NUDGE)]
    # Reminded after the third turn, before the fourth request.
    assert port.log.index(("remind", PROGRESS_NUDGE)) < port.log.index(("assemble", 3))
    assert messages[-1] == ("notice", NO_PROGRESS_STOP)
    # Cleared after every turn but the one that stops.
    assert len(_steps(port, "clear")) == 4
    assert port.log[-1] == ("finish", "no_progress")


@pytest.mark.asyncio
async def test_a_result_that_changes_is_progress_up_to_max_turns():
    port = _Port([[Reply("", (READ,))]], results=lambda n, call: f"attempt {n}")

    messages = await _run(port, max_turns=4)

    assert NO_PROGRESS_STOP not in [m[1] for m in messages if m[0] == "notice"]
    assert _steps(port, "remind") == []
    # The last turn is cleared too: it went through.
    assert len(_steps(port, "clear")) == 4
    assert port.log[-1] == ("finish", "max_turns")


@pytest.mark.asyncio
async def test_no_turn_at_all_when_there_are_none_to_take():
    port = _Port([[Reply("never")]])

    assert await _run(port, max_turns=0) == []
    assert port.log == [("finish", "max_turns")]


@pytest.mark.asyncio
async def test_closing_the_loop_closes_the_call_in_flight():
    """The session runner may stop reading mid-call (a spending cap): the
    adapter's ``finally`` runs then, as it did when the loop was inline."""
    closed = asyncio.Event()

    class _Slow(_Port):
        async def call(self, request, turn):
            try:
                yield "heartbeat"
                await asyncio.Event().wait()
            finally:
                closed.set()

    loop = run_turns(_Slow([[]]), max_turns=5, ledger=UsageLedger())
    assert await loop.__anext__() == "heartbeat"
    await loop.aclose()

    assert closed.is_set()


def test_the_loop_knows_no_provider_and_no_client():
    """Decisions take capabilities, never a provider name; the loop and its
    port import nothing from the clients."""
    backend = Path(__file__).resolve().parents[2] / "apps" / "backend"
    names = re.compile(
        r"openai|copilot|ollama|windsurf|gemini|google|claude|anthropic|codex|"
        r"opencode|antigravity|deepseek|mistral|lm.?studio",
        re.IGNORECASE,
    )
    for relative in (
        "harness/application/loop.py",
        "harness/ports.py",
        "harness/domain/stop.py",
        "harness/domain/progress.py",
    ):
        source = (backend / relative).read_text(encoding="utf-8")
        code = "\n".join(
            line for line in source.splitlines() if not line.lstrip().startswith("#")
        )
        imports = [
            line for line in code.splitlines() if line.startswith(("import ", "from "))
        ]
        assert not any(" core" in line or "agent_client" in line for line in imports), (
            relative
        )
        assert not names.search(code), relative
