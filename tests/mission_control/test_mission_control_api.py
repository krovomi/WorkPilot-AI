"""Mission Control over HTTP: sessions, agent slots, controls, live updates,
decision trees and the event log, as the desktop dashboard drives them.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mission_control import api as mc_api
from mission_control import orchestrator as mc_orchestrator
from mission_control.decision_tree import DecisionTree

BASE = "/api/mission-control"


@pytest.fixture
def client(monkeypatch) -> TestClient:
    monkeypatch.setattr(mc_orchestrator, "_mission_control", None)
    app = FastAPI()
    app.include_router(mc_api.router)
    return TestClient(app)


def _agent(client: TestClient, **fields) -> dict:
    body = {"name": "Coder", "role": "coder", "provider": "anthropic", "model": "m1"}
    return client.post(f"{BASE}/agents", json={**body, **fields}).json()["agent"]


class TestSession:
    def test_start_read_and_stop(self, client):
        started = client.post(f"{BASE}/session/start", json={}).json()["session"]
        agent = _agent(client)
        client.post(f"{BASE}/agents/{agent['id']}/start", json={"task": "fix login"})

        session = client.get(f"{BASE}/session").json()["session"]
        assert session["session_id"] == started["session_id"]
        assert (
            session["is_active"],
            session["agent_count"],
            session["running_count"],
        ) == (
            True,
            1,
            1,
        )

        assert client.post(f"{BASE}/session/stop").json() == {"success": True}
        after = client.get(f"{BASE}/agents/{agent['id']}").json()["agent"]
        assert after["status"] == "completed"
        assert client.get(f"{BASE}/session").json()["session"]["is_active"] is False

    def test_full_state(self, client):
        agent = _agent(client)

        state = client.get(f"{BASE}/state").json()["state"]

        assert [a["id"] for a in state["agents"]] == [agent["id"]]
        assert agent["id"] in state["decision_trees"]
        assert state["recent_events"][-1]["type"] == "agent_created"


class TestAgents:
    def test_an_unknown_role_is_custom(self, client):
        assert _agent(client, role="astronaut")["role"] == "custom"
        assert _agent(client, model_label="")["model_label"] == "m1"

    def test_update_config(self, client):
        agent = _agent(client)

        updated = client.put(
            f"{BASE}/agents/{agent['id']}",
            json={
                "provider": "openai",
                "model": "m2",
                "model_label": "Model 2",
                "name": "Reviewer",
                "role": "reviewer",
            },
        ).json()["agent"]
        same_role = client.put(
            f"{BASE}/agents/{agent['id']}", json={"role": "not-a-role"}
        ).json()["agent"]

        assert (updated["provider"], updated["model"], updated["name"]) == (
            "openai",
            "m2",
            "Reviewer",
        )
        assert updated["model_label"] == "Model 2"
        assert same_role["role"] == updated["role"]

    def test_list_and_remove_a_running_agent(self, client):
        agent = _agent(client)
        client.post(f"{BASE}/agents/{agent['id']}/start", json={"task": "t"})

        assert len(client.get(f"{BASE}/agents").json()["agents"]) == 1
        assert client.delete(f"{BASE}/agents/{agent['id']}").json() == {"success": True}
        assert client.get(f"{BASE}/agents").json()["agents"] == []
        last = client.get(f"{BASE}/events").json()["events"][-1]
        assert (last["type"], last["data"]) == (
            "agent_removed",
            {"agent_id": agent["id"]},
        )

    @pytest.mark.parametrize(
        ("method", "path", "body"),
        [
            ("get", "/agents/nope", None),
            ("put", "/agents/nope", {}),
            ("delete", "/agents/nope", None),
            ("post", "/agents/nope/start", {}),
            ("post", "/agents/nope/pause", None),
            ("post", "/agents/nope/resume", None),
            ("post", "/agents/nope/stop", None),
            ("post", "/agents/nope/update", {}),
            ("get", "/agents/nope/decision-tree", None),
            ("get", "/agents/nope/decision-path", None),
        ],
    )
    def test_an_unknown_agent_is_404(self, client, method, path, body):
        kwargs = {"json": body} if body is not None else {}

        answer = getattr(client, method)(f"{BASE}{path}", **kwargs)

        assert answer.status_code == 404
        assert answer.json() == {"detail": mc_api.AGENT_NOT_FOUND}


class TestControls:
    def test_pause_resume_stop(self, client):
        agent = _agent(client)
        aid = agent["id"]

        client.post(f"{BASE}/agents/{aid}/pause")  # idle: nothing to pause
        assert client.get(f"{BASE}/agents/{aid}").json()["agent"]["status"] == "idle"
        client.post(f"{BASE}/agents/{aid}/start", json={"task": "t"})
        client.post(f"{BASE}/agents/{aid}/resume")  # running: nothing to resume
        client.post(f"{BASE}/agents/{aid}/pause")
        assert client.get(f"{BASE}/agents/{aid}").json()["agent"]["status"] == "paused"
        client.post(f"{BASE}/agents/{aid}/resume")
        assert client.get(f"{BASE}/agents/{aid}").json()["agent"]["status"] == "running"
        client.post(f"{BASE}/agents/{aid}/stop")

        final = client.get(f"{BASE}/agents/{aid}").json()["agent"]
        assert (final["status"], final["progress"]) == ("completed", 1.0)
        types = [e["type"] for e in client.get(f"{BASE}/events").json()["events"]]
        assert types[1:] == [
            "agent_started",
            "agent_paused",
            "agent_resumed",
            "agent_stopped",
        ]

    def test_a_start_without_task_and_none_before(self, client):
        agent = _agent(client)

        client.post(f"{BASE}/agents/{agent['id']}/start", json={})

        tree = client.get(f"{BASE}/agents/{agent['id']}/decision-tree").json()["tree"]
        assert tree["nodes"][tree["root_id"]]["label"] == "Start"


class TestLiveUpdates:
    def test_every_field_of_an_update(self, client):
        aid = _agent(client)["id"]
        client.post(f"{BASE}/agents/{aid}/start", json={"task": "build the cart"})

        answer = client.post(
            f"{BASE}/agents/{aid}/update",
            json={
                "thinking": "Read the cart first",
                "tool_name": "Read",
                "tool_input": "cart.py",
                "file_path": "cart.py",
                "input_tokens": 10,
                "progress": 1.7,
                "current_step": "reading",
                "status": "paused",
                "error": "",
            },
        ).json()["agent"]

        assert answer["current_thinking"] == "Read the cart first"
        assert answer["last_tool_call"] == "Read"
        assert answer["active_files"] == ["cart.py"]
        assert answer["tokens"]["total_tokens"] == 10
        assert (answer["progress"], answer["current_step"]) == (1.0, "reading")
        assert answer["status"] == "paused"

        path = client.get(f"{BASE}/agents/{aid}/decision-path").json()["path"]
        assert [n["node_type"] for n in path] == ["root", "thinking", "tool_call"]

    def test_files_are_kept_once_and_last_twenty(self, client):
        aid = _agent(client)["id"]

        for i in range(25):
            client.post(f"{BASE}/agents/{aid}/update", json={"file_path": f"f{i}.py"})
        client.post(f"{BASE}/agents/{aid}/update", json={"file_path": "f24.py"})

        files = client.get(f"{BASE}/agents/{aid}").json()["agent"]["active_files"]
        assert files == [f"f{i}.py" for i in range(5, 25)]

    def test_an_unknown_status_and_an_error_message(self, client):
        aid = _agent(client)["id"]
        client.post(f"{BASE}/agents/{aid}/start", json={"task": "t"})

        client.post(f"{BASE}/agents/{aid}/update", json={"status": "dancing"})
        assert client.get(f"{BASE}/agents/{aid}").json()["agent"]["status"] == "running"
        client.post(
            f"{BASE}/agents/{aid}/update",
            json={"status": "paused", "error": "rate limit"},
        )
        assert (
            client.get(f"{BASE}/agents/{aid}").json()["agent"]["error_message"]
            == "rate limit"
        )

    def test_updates_for_a_removed_agent_are_ignored(self):
        mc = mc_orchestrator.MissionControlOrchestrator()

        for update in (
            lambda: mc.update_agent_thinking("gone", "x"),
            lambda: mc.update_agent_tool_call("gone", "Read"),
            lambda: mc.update_agent_file("gone", "a.py"),
            lambda: mc.update_agent_tokens("gone", 1, 1),
            lambda: mc.update_agent_progress("gone", 0.5),
            lambda: mc.update_agent_output("gone", "x"),
            lambda: mc.update_agent_status("gone", "completed"),
        ):
            update()

        assert mc.get_decision_tree("gone") is None
        assert mc.get_decision_path("gone") == []
        assert mc.update_agent_config("gone", name="x") is None

    def test_an_agent_without_its_tree(self):
        mc = mc_orchestrator.MissionControlOrchestrator()
        slot = mc.create_agent("A")
        mc._decision_trees.clear()

        mc.start_agent(slot.id, "t")
        mc.update_agent_thinking(slot.id, "x")
        mc.update_agent_tool_call(slot.id, "Read")
        mc.update_agent_status(slot.id, "completed")
        mc.start_agent(slot.id, "t")
        mc.update_agent_output(slot.id, "")
        mc.update_agent_status(slot.id, "error", "boom")

        assert (slot.status.value, slot.output) == ("error", "")


class TestEventLog:
    def test_limits(self, client):
        mc = mc_orchestrator.get_mission_control()
        for i in range(205):
            mc.create_agent(f"a{i}")

        assert len(mc.get_event_log(1000)) == 200
        assert (
            client.get(f"{BASE}/events", params={"limit": 3}).json()["events"][-1][
                "data"
            ]["name"]
            == "a204"
        )
        assert client.get(f"{BASE}/events", params={"limit": 0}).json()["events"] == []
        assert client.get(f"{BASE}/events", params={"limit": -5}).json()["events"] == []


class TestDecisionTree:
    def test_nodes_before_a_root_have_no_parent_and_no_path(self):
        tree = DecisionTree("a1")

        tree.add_thinking("loose")

        assert tree.get_flat_path() == []
        assert tree.node_count == 1

    def test_a_result_completes_its_parent(self):
        tree = DecisionTree("a1")
        root = tree.create_root()
        call = tree.add_tool_call("Bash", "ls", parent_id=root.id)

        tree.add_result("Error", "x" * 600, success=False)

        data = tree.to_dict()
        assert data["nodes"][call.id]["status"] == "completed"
        [result] = [n for n in data["nodes"].values() if n["node_type"] == "result"]
        assert (result["status"], len(result["description"])) == ("failed", 500)
        assert [n["id"] for n in tree.get_flat_path()][:2] == [root.id, call.id]

    def test_a_result_for_a_missing_parent(self):
        tree = DecisionTree("a1")

        node = tree.add_result("Answer", parent_id="ghost")

        assert node.parent_id == "ghost"
        assert tree.node_count == 1

    def test_a_cycle_is_walked_once(self):
        tree = DecisionTree("a1")
        root = tree.create_root()
        child = tree.add_thinking("x")
        tree._nodes[child.id].children.append(root.id)
        tree._nodes[child.id].children.append("missing")

        assert [n["id"] for n in tree.get_flat_path()] == [root.id, child.id]
