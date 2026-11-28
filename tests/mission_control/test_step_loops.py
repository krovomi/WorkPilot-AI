"""A loop read in the decision tree: the same steps over and over (#344).

An agent that reports its thoughts and tool calls to Mission Control
(`/agents/{id}/update`) is flagged when the tree repeats the same block of
steps, and rebalanced like an agent whose answer loops.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mission_control import api as mc_api
from mission_control import orchestrator as mc_orchestrator
from mission_control.decision_tree import DecisionNode, DecisionTree, NodeType
from mission_control.rebalance import STEP_REPEATS, detect_step_loop
from models_registry import tier_pick

BASE = "/api/mission-control"
THOUGHT = "I should read the configuration file again to be sure"


class TestDetectStepLoop:
    def test_one_step_repeated_is_a_loop(self):
        assert detect_step_loop(["a"] * STEP_REPEATS)
        assert not detect_step_loop(["a"] * (STEP_REPEATS - 1))

    def test_a_block_of_steps_repeated_is_a_loop(self):
        assert detect_step_loop(["x", "a", "b"] + ["a", "b"] * STEP_REPEATS)
        assert detect_step_loop(["a", "b", "c"] * STEP_REPEATS)

    def test_steps_that_move_on_are_not_a_loop(self):
        assert not detect_step_loop([str(i) for i in range(20)])
        assert not detect_step_loop(["a", "b", "c", "d"] * STEP_REPEATS)
        assert not detect_step_loop([])


class TestTreeSteps:
    def test_thoughts_and_calls_of_the_current_run_only(self):
        tree = DecisionTree("a")
        tree.create_root()
        tree.add_tool_call("Read", "old.py")
        tree.add_result("Rebalanced", "loop", success=False)
        tree.add_thinking("Thinking...")
        tree.add_thinking(f"  {THOUGHT.upper()}\n")
        tree.add_tool_call("Read", "a.py")
        assert tree.steps(10) == [
            f"thought\0{THOUGHT.lower()}",
            "tool\0Read\0a.py",
        ]
        assert tree.steps(1) == ["tool\0Read\0a.py"]

    def test_a_decision_is_not_a_step(self):
        tree = DecisionTree("a")
        tree.add_tool_call("Read", "a.py")
        decision = DecisionNode(node_type=NodeType.DECISION, label="Pick")
        tree._nodes[decision.id] = decision
        assert tree.steps(5) == ["tool\0Read\0a.py"]

    def test_a_fresh_tree_has_no_steps(self):
        assert DecisionTree("a").steps(5) == []


@pytest.fixture
def client(monkeypatch) -> TestClient:
    monkeypatch.setattr(mc_orchestrator, "_mission_control", None)
    app = FastAPI()
    app.include_router(mc_api.router)
    http = TestClient(app)
    http.post(f"{BASE}/session/start", json={})
    return http


def _running(client: TestClient) -> str:
    agent = client.post(
        f"{BASE}/agents",
        json={
            "name": "Coder",
            "role": "coder",
            "provider": "anthropic",
            "model": tier_pick("anthropic", "fast").model_id,
        },
    ).json()["agent"]
    client.post(f"{BASE}/agents/{agent['id']}/start", json={"task": "fix it"})
    return agent["id"]


def _update(client: TestClient, agent_id: str, **body) -> dict:
    return client.post(f"{BASE}/agents/{agent_id}/update", json=body).json()["agent"]


def _loop_events(client: TestClient) -> list[dict]:
    events = client.get(f"{BASE}/events?limit=200").json()["events"]
    return [e["data"] for e in events if e["type"] == "agent_loop_detected"]


def test_the_same_tool_call_over_and_over_is_flagged_once(client):
    agent_id = _running(client)
    replies = [
        _update(client, agent_id, tool_name="Read", tool_input="config.py")
        for _ in range(STEP_REPEATS + 1)
    ]
    assert [r["loop_detected"] for r in replies] == [False] * (STEP_REPEATS - 1) + [
        True,
        True,
    ]
    assert _loop_events(client) == [{"agent_id": agent_id, "source": "steps"}]

    decision = client.post(f"{BASE}/agents/{agent_id}/rebalance", json={}).json()
    assert (decision["rebalance"]["reason"], decision["rebalance"]["action"]) == (
        "loop",
        "escalate",
    )
    # On the bigger model the run starts clean: the old steps do not count.
    client.post(
        f"{BASE}/agents/{agent_id}/start", json={"task": "", "rebalanced": True}
    )
    again = _update(client, agent_id, tool_name="Read", tool_input="config.py")
    assert again["loop_detected"] is False


def test_a_thought_and_a_call_in_turn_are_a_loop(client):
    agent_id = _running(client)
    for _ in range(STEP_REPEATS):
        _update(client, agent_id, thinking=THOUGHT)
        last = _update(client, agent_id, tool_name="Read", tool_input="config.py")
    assert last["loop_detected"] is True


def test_an_agent_that_is_not_running_is_not_flagged(client):
    agent_id = _running(client)
    client.post(f"{BASE}/agents/{agent_id}/stop")
    for _ in range(STEP_REPEATS):
        reply = _update(client, agent_id, thinking=THOUGHT)
    assert reply["loop_detected"] is False
    assert _loop_events(client) == []


def test_an_answer_loop_says_where_it_was_read(client):
    agent_id = _running(client)
    passage = "The same sentence comes back again and again here. "
    _update(client, agent_id, output_delta=passage * 8)
    assert _loop_events(client) == [{"agent_id": agent_id, "source": "answer"}]


def test_an_unknown_agent_is_ignored():
    mc = mc_orchestrator.MissionControlOrchestrator()
    mc.update_agent_thinking("nobody", THOUGHT)
    mc.update_agent_tool_call("nobody", "Read")
