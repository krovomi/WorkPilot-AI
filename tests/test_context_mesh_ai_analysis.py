"""The Context Mesh analysis reaches the model through the real session runner.

`_run_ai_analysis` imported the session from a module that does not exist and
unpacked two values where the session returns three, so every analysis fell
back to an empty answer. The client and the session here are stand-ins; the
import path and the call shape are the production ones.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import agents.session
import core.client
from context_mesh.mesh_service import ContextMeshService
from context_mesh.types import ProjectSummary


class StandInClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


def test_the_model_answer_comes_back(monkeypatch, tmp_path: Path) -> None:
    clients: list[dict] = []
    sessions: list[tuple] = []

    def create_client(**options):
        clients.append(options)
        return StandInClient()

    async def run_agent_session(client, prompt, spec_dir):
        sessions.append((prompt, spec_dir))
        return "complete", '{"patterns": []}', {}

    monkeypatch.setattr(core.client, "create_client", create_client)
    monkeypatch.setattr(agents.session, "run_agent_session", run_agent_session)
    service = ContextMeshService(model="haiku", thinking_level="low")
    project = ProjectSummary(project_path=str(tmp_path), project_name="shop")
    answer = asyncio.run(service._run_ai_analysis("Compare them.", [project]))
    assert answer == '{"patterns": []}'
    assert sessions == [("Compare them.", None)]
    [options] = clients
    assert options["agent_type"] == "context_mesh_analyzer"
    assert options["project_dir"] == str(tmp_path)


def test_a_failed_session_is_an_empty_answer(monkeypatch) -> None:
    def create_client(**_options):
        raise RuntimeError("no provider configured")

    monkeypatch.setattr(core.client, "create_client", create_client)
    assert asyncio.run(ContextMeshService()._run_ai_analysis("x", [])) == ""
