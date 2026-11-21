"""`POST /api/mission-control/composition`, as the main process calls it.

The main process resolves the project from its id; the backend still checks
every directory it is handed, and answers a refusal with a code.
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mission_control import api as mc_api

URL = "/api/mission-control/composition"


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(mc_api.router)
    return TestClient(app)


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "proj"
    spec = root / ".workpilot" / "specs" / "001-login"
    spec.mkdir(parents=True)
    (spec / "spec.md").write_text(
        "Fix the crash of the login screen when the API times out.", encoding="utf-8"
    )
    (root / "package.json").write_text(
        '{"scripts": {"test": "vitest"}}', encoding="utf-8"
    )
    return root


def _post(client, **body):
    return client.post(URL, json={"providers": ["anthropic"], **body}).json()


def test_a_description_gets_a_crew(client):
    body = _post(client, prompt="Add a settings page with a dark mode toggle and tests")
    assert body["success"] is True
    composition = body["composition"]
    assert composition["template"] == "new_feature"
    assert composition["refinement"] is None


def test_a_spec_of_a_project_is_read_with_its_stack(client, project):
    body = _post(client, project_dir=str(project), spec_id="001-login", refine=True)
    composition = body["composition"]
    assert composition["template"] == "bug_fix"
    assert composition["signals"]["has_spec"] is True
    assert composition["signals"]["has_test_suite"] is True
    assert "login screen" in composition["refinement"]["prompt"]


def test_a_project_without_a_spec(client, project):
    body = _post(client, project_dir=str(project), prompt="Refactor the auth module")
    assert body["composition"]["signals"]["languages"] == ["javascript/typescript"]


def test_the_model_answer_comes_back_as_hints(client):
    hints = json.dumps({"kind": "incident_response", "complexity": "large"})
    body = _post(client, prompt="Payments are down", model_hints=hints, refine=True)
    composition = body["composition"]
    assert (composition["template"], composition["hinted"]) == (
        "incident_response",
        True,
    )
    assert composition["refinement"] is None
    unusable = _post(client, prompt="Payments are down", model_hints="no idea")
    assert {"code": "hints_unusable", "params": {}} in unusable["composition"][
        "warnings"
    ]


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ({"template": "launch_rockets"}, "unknown_template"),
        ({"spec_id": "001-login"}, "invalid_spec"),
        ({"project_dir": "/no/such/dir/anywhere"}, "invalid_project"),
        ({"providers": ["meta"]}, "no_provider"),
    ],
)
def test_refusals_answer_a_code(client, body, code):
    assert _post(client, **body) == {"success": False, "error": code}


@pytest.mark.parametrize("spec_id", ["../../etc", "..", "missing-spec"])
def test_a_spec_outside_the_project_or_missing_is_refused(client, project, spec_id):
    body = _post(client, project_dir=str(project), spec_id=spec_id)
    assert body == {"success": False, "error": "invalid_spec"}


@pytest.mark.parametrize(
    "body",
    [
        {"providers": []},
        {"budget_usd": 0},
        {"budget_usd": -5},
        {"budget_tokens": 0},
        {"prompt": "x" * 20_001},
        {"providers": ["p" * 65]},
    ],
)
def test_malformed_requests_are_rejected(client, body):
    response = client.post(URL, json={"providers": ["anthropic"], **body})
    assert response.status_code == 422


def test_a_budget_too_low_is_refused_in_the_composition(client):
    body = _post(client, prompt="Add a login page with an API", budget_usd=0.00001)
    composition = body["composition"]
    assert composition["status"] == "refused"
    assert composition["minimum"]["cost_usd"] > 0
