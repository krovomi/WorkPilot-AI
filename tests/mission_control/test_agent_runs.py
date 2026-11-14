"""Mission Control: an agent that is started answers, and its run ends.

Starting an agent used to mark it "running" and nothing else: no model was
ever called, so the card stayed at 0 tokens with its clock running forever.
The model call now runs in the Electron main process, which reports back
through ``/agents/{id}/update``; these tests hold the backend side of that
contract: the answer streams in, the end of the run stops the clock and is
logged, and a stopped agent is not reopened by a late report.
"""

from fastapi import FastAPI
from fastapi.testclient import TestClient
from mission_control import api as mc_api
from mission_control import orchestrator as mc_orchestrator
from mission_control.agent_slot import MAX_OUTPUT_CHARS, AgentStatus


def _fresh():
    mc_orchestrator._mission_control = None
    mc = mc_orchestrator.get_mission_control()
    mc.start_session()
    return mc


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(mc_api.router)
    return TestClient(app)


def test_streamed_answer_tokens_and_completion_reach_the_card():
    mc = _fresh()
    slot = mc.create_agent("Agent Coder", "coder", "anthropic", "claude-x")
    client = _client()

    assert (
        client.post(
            f"/api/mission-control/agents/{slot.id}/start", json={"task": "say HELLO"}
        ).status_code
        == 200
    )
    for chunk in ("HEL", "LO"):
        client.post(
            f"/api/mission-control/agents/{slot.id}/update",
            json={"output_delta": chunk},
        )
    client.post(
        f"/api/mission-control/agents/{slot.id}/update",
        json={"input_tokens": 12, "output_tokens": 3, "cost_usd": 0.0004},
    )
    done = client.post(
        f"/api/mission-control/agents/{slot.id}/update",
        json={"status": "completed", "progress": 1},
    ).json()["agent"]

    assert done["output"] == "HELLO"
    assert done["status"] == "completed"
    assert done["tokens"]["total_tokens"] == 15
    assert done["completed_at"] is not None  # the clock stops
    events = [e["type"] for e in mc.get_event_log()]
    assert events[-1] == "agent_completed"
    tree = mc.get_decision_tree(slot.id)
    results = [n for n in tree["nodes"].values() if n["node_type"] == "result"]
    assert results and results[0]["description"] == "HELLO"


def test_a_failure_is_shown_and_logged():
    mc = _fresh()
    slot = mc.create_agent("A", "coder", "meta", "llama")
    mc.start_agent(slot.id, "task")

    mc.update_agent_status(slot.id, "error", "Provider 'meta' has no adapter")

    assert slot.status == AgentStatus.ERROR
    assert slot.error_message == "Provider 'meta' has no adapter"
    assert slot.completed_at is not None
    last = mc.get_event_log()[-1]
    assert last["type"] == "agent_failed"
    assert "meta" in last["data"]["error"]


def test_a_stopped_agent_is_not_reopened_by_a_late_report():
    mc = _fresh()
    slot = mc.create_agent("A", "coder", "openai", "gpt")
    mc.start_agent(slot.id, "task")
    mc.stop_agent(slot.id)

    mc.update_agent_output(slot.id, "late chunk")
    mc.update_agent_status(slot.id, "error", "Stopped")

    assert slot.status == AgentStatus.COMPLETED
    assert slot.output == ""
    assert slot.error_message == ""
    assert [e["type"] for e in mc.get_event_log()][-1] == "agent_stopped"


def test_restart_without_a_task_reruns_the_last_one_on_a_fresh_answer():
    mc = _fresh()
    slot = mc.create_agent("A", "coder", "ollama", "llama3.3")
    mc.start_agent(slot.id, "say HELLO")
    mc.update_agent_output(slot.id, "HELLO")
    mc.update_agent_status(slot.id, "completed")

    mc.start_agent(slot.id, "")

    assert slot.current_task == "say HELLO"
    assert slot.status == AgentStatus.RUNNING
    assert slot.output == ""
    tree = mc.get_decision_tree(slot.id)
    assert tree["node_count"] == 1  # the last run's nodes are gone


def test_a_long_answer_keeps_its_end():
    mc = _fresh()
    slot = mc.create_agent("A", "documenter", "google", "gemini")
    mc.start_agent(slot.id, "write")

    mc.update_agent_output(slot.id, "a" * MAX_OUTPUT_CHARS)
    mc.update_agent_output(slot.id, "END")

    assert len(slot.output) == MAX_OUTPUT_CHARS
    assert slot.output.endswith("END")


def test_an_oversized_chunk_is_refused():
    mc = _fresh()
    slot = mc.create_agent("A", "coder", "openai", "gpt")
    mc.start_agent(slot.id, "task")

    response = _client().post(
        f"/api/mission-control/agents/{slot.id}/update",
        json={"output_delta": "x" * 20_001},
    )

    assert response.status_code == 422
    assert slot.output == ""
