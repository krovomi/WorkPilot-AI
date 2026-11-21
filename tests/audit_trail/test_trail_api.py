"""The Audit Trail panel's routes: append, filter, replay, verify, list.

The exports have their own file (`test_export_api.py`).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from audit_trail.api import STORAGE_DIR_REFUSED, _trails, router
from fastapi import FastAPI
from fastapi.testclient import TestClient

BASE = "/api/audit-trail"


@pytest.fixture(autouse=True)
def _fresh_registry():
    _trails.clear()
    yield
    _trails.clear()


@pytest.fixture
def store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("AUDIT_TRAIL_ALLOWED_ROOTS", str(tmp_path))
    return tmp_path / "project" / ".workpilot" / "audit-trail"


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _append(client: TestClient, store: Path, **fields) -> dict:
    body = {
        "storage_dir": str(store),
        "kind": "agent_invoked",
        "actor": "coder",
        "correlation_id": "spec-1",
        "summary": "coder started",
        **fields,
    }
    return client.post(f"{BASE}/append", json=body).json()


def test_events_are_chained_filtered_and_replayed(client, store) -> None:
    first = _append(client, store)
    assert first["success"] is True and first["event"]["sequence"] == 0
    _append(client, store, kind="agent_completed", correlation_id="spec-2")
    decided = client.post(
        f"{BASE}/append-decision",
        json={
            "storage_dir": str(store),
            "actor": "planner",
            "correlation_id": "spec-1",
            "decision_id": "d-1",
            "title": "Pick a cache",
            "chosen_option": "redis",
            "rejected_options": ["memcached"],
            "rationale": "already deployed",
            "risk_score": 0.2,
        },
    ).json()
    assert decided["success"] is True
    assert decided["event"]["prev_hash"] != "genesis"

    coder = client.get(
        f"{BASE}/events", params={"storage_dir": str(store), "actor": "coder"}
    ).json()
    assert coder["count"] == 2
    invoked = client.get(
        f"{BASE}/events",
        params={"storage_dir": str(store), "kind": "agent_invoked"},
    ).json()
    assert [e["correlation_id"] for e in invoked["events"]] == ["spec-1"]

    bundle = client.get(
        f"{BASE}/replay/spec-1", params={"storage_dir": str(store)}
    ).json()["bundle"]
    assert bundle["event_count"] == 2

    integrity = client.get(f"{BASE}/verify", params={"storage_dir": str(store)}).json()
    assert integrity["integrity"]["is_intact"] is True

    assert client.get(f"{BASE}/trails", params={"storage_dir": str(store)}).json() == {
        "success": True,
        "trails": ["default"],
    }


def test_an_edited_line_on_disk_breaks_the_chain_where_it_was_edited(
    client, store
) -> None:
    _append(client, store, summary="first")
    _append(client, store, summary="second")
    log = store / "default.audit.jsonl"
    log.write_text(
        log.read_text(encoding="utf-8").replace("second", "forged"), encoding="utf-8"
    )
    _trails.clear()

    integrity = client.get(f"{BASE}/verify", params={"storage_dir": str(store)}).json()

    assert integrity["integrity"]["is_intact"] is False
    assert integrity["integrity"]["first_broken_sequence"] == 1


@pytest.mark.parametrize(
    "fields", [{"kind": "agent_daydreamed"}, {"trail_name": "../x"}]
)
def test_an_event_that_cannot_be_recorded_is_refused(client, store, fields) -> None:
    answer = _append(client, store, **fields)

    assert answer["success"] is False
    assert answer["error"]


@pytest.mark.parametrize(
    ("route", "body"),
    [
        (
            "append",
            '{"kind": "agent_invoked", "actor": "a", "correlation_id": "c",'
            ' "payload": {"elapsed": NaN}}',
        ),
        (
            "append-decision",
            '{"actor": "a", "correlation_id": "c", "decision_id": "d",'
            ' "title": "t", "chosen_option": "x", "risk_score": Infinity}',
        ),
    ],
)
def test_a_value_json_cannot_hold_is_refused_before_it_is_chained(
    client, store, route, body
) -> None:
    # Python's JSON reads `NaN` and `Infinity` and would write them back as
    # such: not JSON, so the trail line could be neither answered nor exported.
    raw = f'{{"storage_dir": "{store.as_posix()}", {body[1:]}'

    answer = client.post(
        f"{BASE}/{route}", content=raw, headers={"content-type": "application/json"}
    ).json()

    assert answer["success"] is False
    events = client.get(f"{BASE}/events", params={"storage_dir": str(store)}).json()
    assert events["count"] == 0


def test_a_filter_on_an_unknown_kind_is_refused(client, store) -> None:
    answer = client.get(
        f"{BASE}/events", params={"storage_dir": str(store), "kind": "daydream"}
    ).json()

    assert answer["success"] is False


@pytest.mark.parametrize(
    ("method", "path", "body", "params"),
    [
        ("POST", "/append", {"kind": "agent_invoked", "actor": "a"}, None),
        ("POST", "/append-decision", {"decision_id": "d", "title": "t"}, None),
        ("GET", "/events", None, {}),
        ("GET", "/replay/spec-1", None, {}),
        ("GET", "/verify", None, {}),
        ("GET", "/trails", None, {}),
        ("GET", "/export/soc2", None, {}),
        ("GET", "/export/gdpr", None, {"actor": "a"}),
    ],
)
def test_a_folder_outside_the_allowed_roots_is_named_as_the_reason(
    client, store, tmp_path: Path, method, path, body, params
) -> None:
    outside = str(tmp_path.parent / "elsewhere")
    if body is not None:
        body = {
            "storage_dir": outside,
            "actor": "a",
            "correlation_id": "c",
            "chosen_option": "x",
            **body,
        }
    else:
        params = {**params, "storage_dir": outside}

    answer = client.request(method, BASE + path, json=body, params=params).json()

    assert answer == {"success": False, "error": STORAGE_DIR_REFUSED}
    assert not Path(outside).exists()


@pytest.mark.parametrize(
    ("method", "path", "body", "broken"),
    [
        ("POST", "/append", {"kind": "agent_invoked"}, "append"),
        ("POST", "/append-decision", {"decision_id": "d"}, "append_decision"),
        ("GET", "/events", None, "filter"),
        ("GET", "/replay/spec-1", None, "replay"),
        ("GET", "/verify", None, "verify"),
        ("GET", "/trails", None, "list_trails"),
        ("GET", "/export/soc2", None, "filter"),
        ("GET", "/export/gdpr", None, "filter"),
    ],
)
def test_an_unreadable_trail_is_reported_without_its_detail(
    client, store, monkeypatch: pytest.MonkeyPatch, method, path, body, broken
) -> None:
    from audit_trail.trail import AuditTrail

    def fail(*_a, **_k):
        raise OSError("/home/someone/.workpilot/audit-trail is unreadable")

    monkeypatch.setattr(AuditTrail, broken, fail)
    params = None
    if body is not None:
        body = {
            "storage_dir": str(store),
            "actor": "a",
            "correlation_id": "c",
            "title": "t",
            "chosen_option": "x",
            **body,
        }
    else:
        # `actor` names the data subject of the GDPR export; the other reads
        # ignore it.
        params = {"storage_dir": str(store), "actor": "a"}

    answer = client.request(method, BASE + path, json=body, params=params).json()

    assert answer["success"] is False
    assert "/home/someone" not in answer["error"]
