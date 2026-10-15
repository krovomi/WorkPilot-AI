"""Sub-agents launched staggered: the first alone until its response begins, then the rest."""

from __future__ import annotations

import asyncio
import time

import pytest
from core.agent_client import CopilotAgentClient, SubagentDefinition
from harness.application.subagents import launch_staggered, subagent_messages


async def _settle() -> None:
    """Let every ready task run until it blocks."""
    for _ in range(10):
        await asyncio.sleep(0)


def _job(log: list[str], name: str, gate: asyncio.Event | None = None):
    async def job(started):
        log.append(f"{name}:launched")
        if gate is not None:
            await gate.wait()
        return name

    return job


@pytest.mark.asyncio
async def test_the_rest_start_only_after_the_first_has_begun():
    log: list[str] = []
    began, finish, rest_gate = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def first(started):
        log.append("first:launched")
        await began.wait()
        log.append("first:began")
        started()
        await finish.wait()
        return "first"

    run = asyncio.create_task(
        launch_staggered(
            {
                "first": first,
                "b": _job(log, "b", rest_gate),
                "c": _job(log, "c", rest_gate),
            }
        )
    )
    await _settle()
    assert log == ["first:launched"]

    began.set()
    await _settle()
    # The rest go together, while the first is still answering.
    assert log[:2] == ["first:launched", "first:began"]
    assert sorted(log[2:]) == ["b:launched", "c:launched"]

    rest_gate.set()
    finish.set()
    assert await asyncio.wait_for(run, 1) == {"first": "first", "b": "b", "c": "c"}


@pytest.mark.asyncio
async def test_a_first_that_fails_before_beginning_holds_no_one_back():
    log: list[str] = []

    async def first(started):
        raise RuntimeError("the first sub-agent's call failed")

    outcomes = await asyncio.wait_for(
        launch_staggered({"first": first, "b": _job(log, "b")}), 1
    )
    assert isinstance(outcomes["first"], RuntimeError)
    assert outcomes["b"] == "b"


@pytest.mark.asyncio
async def test_a_first_that_produces_nothing_holds_no_one_back():
    log: list[str] = []

    async def first(started):
        return ""

    outcomes = await asyncio.wait_for(
        launch_staggered({"first": first, "b": _job(log, "b"), "c": _job(log, "c")}),
        1,
    )
    assert outcomes == {"first": "", "b": "b", "c": "c"}


@pytest.mark.asyncio
async def test_a_first_that_never_begins_is_waited_for_a_bounded_time():
    log: list[str] = []
    release = asyncio.Event()

    async def first(started):
        await release.wait()
        return "late"

    run = asyncio.create_task(
        launch_staggered({"first": first, "b": _job(log, "b")}, head_start=0.05)
    )
    await asyncio.sleep(0.2)
    assert log == ["b:launched"]
    release.set()
    # Nothing lost: the slow first one's result arrives with the others.
    assert await asyncio.wait_for(run, 1) == {"first": "late", "b": "b"}


@pytest.mark.asyncio
async def test_a_failing_sub_agent_loses_no_other_result():
    async def first(started):
        started()
        return "first"

    async def broken(started):
        raise ValueError("bad answer")

    outcomes = await launch_staggered(
        {"first": first, "broken": broken, "c": _job([], "c")}
    )
    assert list(outcomes) == ["first", "broken", "c"]
    assert outcomes["first"] == "first" and outcomes["c"] == "c"
    assert isinstance(outcomes["broken"], ValueError)


@pytest.mark.asyncio
async def test_one_job_or_none():
    assert await launch_staggered({}) == {}

    async def only(started):
        return "only"

    assert await launch_staggered({"only": only}) == {"only": "only"}


@pytest.mark.asyncio
async def test_cancelling_the_wave_cancels_every_sub_agent():
    cancelled: list[str] = []

    async def first(started):
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.append("first")
            raise

    run = asyncio.create_task(launch_staggered({"first": first, "b": _job([], "b")}))
    await _settle()
    run.cancel()
    with pytest.raises(asyncio.CancelledError):
        await run
    await _settle()
    assert cancelled == ["first"]


def test_sub_agents_of_a_wave_share_everything_but_their_role():
    one = subagent_messages("You check security.", "Review PR #12: the diff …")
    two = subagent_messages("You check quality.", "Review PR #12: the diff …")
    assert one[:-1] == two[:-1]
    assert one[-1] != two[-1]
    assert "You check security." in one[-1]["content"]
    assert "WorkPilot sub-agent contract" in one[0]["content"]


class _Response:
    """A Copilot chat completion, delayed until the test lets it arrive."""

    def __init__(self, log, name, text, gate):
        self.log, self.name, self.text, self.gate = log, name, text, gate
        self.status = 200

    async def __aenter__(self):
        await self.gate.wait()
        self.log.append(f"{self.name}:response")
        return self

    async def __aexit__(self, *exc):
        return None

    async def json(self):
        return {
            "choices": [{"message": {"content": self.text}}],
            "usage": {"prompt_tokens": 2_000, "completion_tokens": 50},
        }


class _Session:
    def __init__(self, roles: dict[str, str], gates: dict[str, asyncio.Event]):
        self.roles, self.gates, self.log = roles, gates, []
        self.payloads: list[dict] = []

    def post(self, url, json=None, headers=None):
        role = json["messages"][-1]["content"]
        name = next(n for n, r in self.roles.items() if r in role)
        self.log.append(f"{name}:post")
        self.payloads.append(json)
        return _Response(self.log, name, f"{name} done", self.gates[name])


def _copilot(session) -> CopilotAgentClient:
    client = CopilotAgentClient(model="gpt-4o", github_token="gho_test_oauth")
    client._copilot_token = "copilot_test_token"
    client._copilot_token_expires_at = time.time() + 3600
    client._http_client = session
    return client


@pytest.mark.asyncio
async def test_copilot_sends_the_rest_after_the_first_response_arrives():
    roles = {"sec": "Check sec", "quality": "Check quality", "logic": "Check logic"}
    gates = {name: asyncio.Event() for name in roles}
    session = _Session(roles, gates)
    client = _copilot(session)
    agents = {name: SubagentDefinition(name, prompt) for name, prompt in roles.items()}

    run = asyncio.create_task(client.run_subagents(agents, "Review PR #123"))
    await _settle()
    assert session.log == ["sec:post"]

    gates["sec"].set()
    await _settle()
    assert session.log[:2] == ["sec:post", "sec:response"]
    assert sorted(session.log[2:]) == ["logic:post", "quality:post"]

    gates["quality"].set()
    gates["logic"].set()
    results = await asyncio.wait_for(run, 1)
    assert set(results) == set(roles)
    # The prefix the wave shares is byte for byte the same in every request.
    prefixes = {repr(p["messages"][:-1]) for p in session.payloads}
    assert len(prefixes) == 1
    # Each call measured, on its own thread; each result counted.
    ledger = client.usage_ledger
    assert len(ledger.calls) == 3
    assert ledger.summary()["subagentReturns"] == 3


@pytest.mark.asyncio
async def test_copilot_runs_the_rest_when_the_first_call_fails():
    roles = {"sec": "Check sec", "quality": "Check quality"}
    gates = {name: asyncio.Event() for name in roles}
    gates["quality"].set()
    session = _Session(roles, gates)
    real_post = session.post

    def post(url, json=None, headers=None):
        if "Check sec" in json["messages"][-1]["content"]:
            raise ConnectionError("unreachable")
        return real_post(url, json=json, headers=headers)

    session.post = post
    client = _copilot(session)
    agents = {name: SubagentDefinition(name, prompt) for name, prompt in roles.items()}

    results = await asyncio.wait_for(client.run_subagents(agents, "Review"), 1)
    assert results["sec"] == "Error: unreachable"
    assert "quality done" in results["quality"]
