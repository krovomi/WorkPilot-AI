"""`/api/verify/*`: what the Kanban reads and what it asks to run.

The run is real: the shop of `conftest.py` is launched and called by the
loop, at low effort (no model session). The comparison itself is covered by
`tests/test_verify_compare.py`; here it is the route around it — addressing,
the task's worktree, the record served back and what a failure answers.
"""

from __future__ import annotations

import json

import pytest
import verify.api as api_module
import verify.compare as compare_module
import verify.loop as loop_module
from fastapi import FastAPI
from fastapi.testclient import TestClient
from verify.api import router
from verify.record import load_record, new_record, save_record


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _address(project, spec_id="001-orders") -> dict:
    return {"project_dir": str(project), "spec_id": spec_id}


def _spec(project, spec_id="001-orders"):
    spec = project / ".workpilot" / "specs" / spec_id
    spec.mkdir(parents=True, exist_ok=True)
    return spec


def test_the_worktree_s_newer_record_is_the_one_served(tmp_path, client):
    spec = _spec(tmp_path)
    save_record(spec / "verify", new_record(status="fail", finished_at=10.0))
    tree_spec = (
        (tmp_path / ".workpilot" / "worktrees" / "tasks" / spec.name)
        / ".workpilot"
        / "specs"
        / spec.name
    )
    save_record(tree_spec / "verify", new_record(status="pass", finished_at=20.0))

    body = client.get("/api/verify/", params=_address(tmp_path)).json()

    assert body["success"] is True
    assert body["record"]["status"] == "pass"
    assert body["settings"]["enabled"] is True


def test_an_older_worktree_copy_does_not_hide_the_project_s(tmp_path, client):
    spec = _spec(tmp_path)
    save_record(spec / "verify", new_record(status="fail", finished_at=30.0))
    legacy = tmp_path / ".worktrees" / spec.name / ".workpilot" / "specs" / spec.name
    save_record(legacy / "verify", new_record(status="pass", finished_at=5.0))

    body = client.get("/api/verify/", params=_address(tmp_path)).json()

    assert body["record"]["status"] == "fail"


def test_no_record_yet(tmp_path, client):
    _spec(tmp_path)
    body = client.get("/api/verify/", params=_address(tmp_path)).json()
    assert body == {
        "success": True,
        "record": None,
        "settings": body["settings"],
    }


def test_the_served_record_names_no_path(tmp_path, client):
    spec = _spec(tmp_path)
    shot = spec / "verify" / "screenshots" / "saved.png"
    shot.parent.mkdir(parents=True)
    shot.write_bytes(b"\x89PNG\r\n\x1a\n")
    record = new_record(status="pass", finished_at=1.0)
    record.update(
        agent={"transcript": "secret reasoning"},
        screenshots=[{"path": str(shot), "label": "saved", "platform": "android"}],
        scenario_steps=[
            {"step": 1, "outcome": "pass", "screenshot": str(shot)},
            {"step": 2, "outcome": "fail", "screenshot": "/elsewhere.png"},
            "not a step",
        ],
        perf=[{"url": "/", "lcp_ms": 900, "trace_path": str(spec / "t.json.gz")}],
        mobile=[{"platform": "android", "frame": str(spec / "android.png")}],
        targets=[{"name": "api", "launch": {"log_path": str(spec / "api.log")}}],
        trace=str(spec / "verify" / "scenario-trace.zip"),
    )
    save_record(spec / "verify", record)

    served = client.get("/api/verify/", params=_address(tmp_path)).json()["record"]

    assert "agent" not in served
    assert served["scenario_steps"] == [
        {"step": 1, "outcome": "pass", "screenshotIndex": 0},
        {"step": 2, "outcome": "fail"},
    ]
    assert served["screenshots"] == [
        {"index": 0, "label": "saved", "platform": "android", "url": ""}
    ]
    assert (served["trace"], served["video"], served["walkthrough"]) == (
        True,
        False,
        False,
    )
    assert str(tmp_path) not in json.dumps(served)


def test_a_bad_address_is_refused_with_its_reason(tmp_path, client):
    params = _address(tmp_path, "../escape")
    body = client.get("/api/verify/", params=params).json()
    assert body["success"] is False and body["reason"] == "spec_id"
    assert (
        client.get("/api/verify/screenshot", params={**params, "index": 0}).status_code
        == 400
    )
    assert client.get("/api/verify/trace", params=params).status_code == 400
    assert client.get("/api/verify/", params={}).json()["reason"] == "addressing"


def test_a_record_that_cannot_be_read_is_an_internal_error(
    tmp_path, client, monkeypatch
):
    _spec(tmp_path)

    def broken(project):
        raise PermissionError("settings unreadable")

    monkeypatch.setattr(api_module, "load_settings", broken)
    body = client.get("/api/verify/", params=_address(tmp_path)).json()
    assert body == {"success": False, "error": "An internal error has occurred."}


def test_a_screenshot_that_is_not_an_image_is_not_served(tmp_path, client):
    spec = _spec(tmp_path)
    notes = spec / "verify" / "notes.txt"
    notes.parent.mkdir(parents=True)
    notes.write_text("not an image", encoding="utf-8")
    save_record(spec / "verify", new_record(screenshots=[{"path": str(notes)}]))
    response = client.get(
        "/api/verify/screenshot", params={**_address(tmp_path), "index": 0}
    )
    assert response.status_code == 404


def test_a_jpeg_screenshot_is_served_as_one(tmp_path, client):
    spec = _spec(tmp_path)
    shot = spec / "verify" / "a.jpg"
    shot.parent.mkdir(parents=True)
    shot.write_bytes(b"\xff\xd8\xff\xe0")
    save_record(spec / "verify", new_record(screenshots=[{"path": str(shot)}]))
    response = client.get(
        "/api/verify/screenshot", params={**_address(tmp_path), "index": 0}
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"


def test_a_trace_under_another_name_is_not_the_scenario_s(tmp_path, client):
    spec = _spec(tmp_path)
    other = spec / "verify" / "other.zip"
    other.parent.mkdir(parents=True)
    other.write_bytes(b"PK\x03\x04")
    save_record(spec / "verify", new_record(trace=str(other)))
    assert client.get("/api/verify/trace", params=_address(tmp_path)).status_code == 404


# -- run -------------------------------------------------------------------


def test_run_verifies_the_task_now(shop, client):
    root, spec = shop
    body = client.post(
        "/api/verify/run", json={**_address(root), "effort": "low"}
    ).json()

    assert body["success"] is True, body
    assert body["record"]["status"] == "pass"
    assert str(root) not in json.dumps(body["record"])
    assert load_record(spec / "verify")["status"] == "pass"


def test_run_works_on_the_task_s_worktree_when_it_exists(tmp_path, client, monkeypatch):
    spec = _spec(tmp_path)
    tree = tmp_path / ".workpilot" / "worktrees" / "tasks" / spec.name
    tree_spec = tree / ".workpilot" / "specs" / spec.name
    tree_spec.mkdir(parents=True)
    seen = {}

    async def loop(code_dir, spec_dir, runner, options):
        seen.update(code_dir=code_dir, spec_dir=spec_dir, effort=options.effort)
        return new_record(status="pass")

    monkeypatch.setattr(loop_module, "run_verify_loop", loop)
    body = client.post("/api/verify/run", json=_address(tmp_path)).json()

    assert body["success"] is True
    assert seen == {"code_dir": tree, "spec_dir": tree_spec, "effort": "medium"}


def test_run_refuses_a_spec_outside_a_project(tmp_path, client):
    loose = tmp_path / "loose-spec"
    loose.mkdir()
    body = client.post("/api/verify/run", json={"spec_dir": str(loose)}).json()
    assert body == {"success": False, "error": "the spec is not inside a project"}
    body = client.post("/api/verify/compare", json={"spec_dir": str(loose)}).json()
    assert body == {"success": False, "error": "the spec is not inside a project"}


def test_run_and_compare_refuse_a_bad_address(tmp_path, client):
    for route in ("/api/verify/run", "/api/verify/compare"):
        body = client.post(route, json=_address(tmp_path, "..")).json()
        assert body["success"] is False and body["reason"] == "spec_id"


def test_a_run_that_crashes_answers_without_detail(tmp_path, client, monkeypatch):
    _spec(tmp_path)

    async def crash(*args, **kwargs):
        raise RuntimeError(f"cannot write {tmp_path}")

    monkeypatch.setattr(loop_module, "run_verify_loop", crash)
    body = client.post("/api/verify/run", json=_address(tmp_path)).json()
    assert body == {"success": False, "error": "An internal error has occurred."}


# -- compare ---------------------------------------------------------------


def test_compare_answers_the_entry_and_the_record(tmp_path, client, monkeypatch):
    spec = _spec(tmp_path)
    save_record(spec / "verify", new_record(status="pass", finished_at=1.0))

    async def compare(code_dir, spec_dir):
        assert (code_dir, spec_dir) == (tmp_path, spec)
        return {"status": "done", "differences": []}

    monkeypatch.setattr(compare_module, "run_base_comparison", compare)
    body = client.post("/api/verify/compare", json=_address(tmp_path)).json()

    assert body["success"] is True
    assert body["compare"] == {"status": "done", "differences": []}
    assert body["record"]["status"] == "pass"


def test_compare_with_no_record_answers_none(tmp_path, client, monkeypatch):
    _spec(tmp_path)

    async def compare(code_dir, spec_dir):
        return {"status": "skipped", "reason": "nothing verified to compare"}

    monkeypatch.setattr(compare_module, "run_base_comparison", compare)
    body = client.post("/api/verify/compare", json=_address(tmp_path)).json()
    assert body["record"] is None
    assert body["compare"]["status"] == "skipped"


def test_a_comparison_that_fails_answers_without_detail(tmp_path, client, monkeypatch):
    _spec(tmp_path)

    async def compare(code_dir, spec_dir):
        raise TimeoutError("the base app never answered")

    monkeypatch.setattr(compare_module, "run_base_comparison", compare)
    body = client.post("/api/verify/compare", json=_address(tmp_path)).json()
    assert body == {"success": False, "error": "An internal error has occurred."}
