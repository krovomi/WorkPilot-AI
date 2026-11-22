"""How this machine shares its replays, counted on this machine (#347).

Exports are counted in a ledger beside the sessions (kind and time only),
bounded in size and age; sessions are read from the store. The report gives
eight rolling weeks of exports and the share of sessions that carry a
bookmark. Nothing is sent anywhere: the routes answer the local app.
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from replay import api as replay_api
from replay import recorder as recorder_module
from replay import usage
from replay.models import (
    Bookmark,
    BookmarkReply,
    ReplaySession,
    SessionSummary,
)

NOW = 1_800_000_000.0
DAY = 24 * 3600


@pytest.fixture
def recorder(tmp_path, monkeypatch) -> recorder_module.ReplayRecorder:
    store = recorder_module.ReplayRecorder(storage_dir=tmp_path / "replays")
    monkeypatch.setattr(recorder_module, "_replay_recorder", store)
    return store


def _save(recorder, session_id, **fields) -> None:
    session = ReplaySession(session_id=session_id, status="completed")
    for key, value in fields.items():
        setattr(session, key, value)
    recorder.save_session(session)


def test_exports_are_counted_by_rolling_week_and_kind(recorder):
    storage = recorder.storage_dir
    usage.record_export(storage, "wpreplay", now=NOW - 1 * DAY)
    usage.record_export(storage, "video", now=NOW - 2 * DAY)
    usage.record_export(storage, "html", now=NOW - 10 * DAY)
    usage.record_export(storage, "team_link", now=NOW - 55 * DAY)
    # Older than the eight weeks, and not yet happened: outside the report.
    usage.record_export(storage, "html", now=NOW - 60 * DAY)
    usage.record_export(storage, "html", now=NOW + DAY)

    report = usage.usage_report(storage, now=NOW)

    weeks = report["weeks"]
    assert len(weeks) == usage.WEEKS
    assert weeks[-1]["end"] == NOW
    assert weeks[-1]["total"] == 2
    assert weeks[-1]["by_kind"] == {
        "wpreplay": 1,
        "html": 0,
        "video": 1,
        "team_link": 0,
    }
    assert weeks[-2]["by_kind"]["html"] == 1
    assert weeks[0]["by_kind"]["team_link"] == 1
    assert report["exports"] == 4
    assert report["exports_per_week"] == 0.5


def test_the_ledger_keeps_only_a_kind_and_a_time_and_is_bounded(recorder, monkeypatch):
    storage = recorder.storage_dir
    usage.record_export(storage, "html", now=NOW - 400 * DAY)
    monkeypatch.setattr(usage, "MAX_EVENTS", 3)
    for i in range(4):
        usage.record_export(storage, "wpreplay", now=NOW + i)

    raw = json.loads(usage.ledger_path(storage).read_text(encoding="utf-8"))
    # The year-old entry and the oldest beyond the bound are gone.
    assert raw == {
        "version": 1,
        "exports": [
            [NOW + 1, "wpreplay"],
            [NOW + 2, "wpreplay"],
            [NOW + 3, "wpreplay"],
        ],
    }
    with pytest.raises(ValueError):
        usage.record_export(storage, "telemetry")
    # The ledger is not a session the store would list.
    assert recorder.list_sessions() == []


def test_a_ledger_that_is_not_one_counts_nothing(recorder):
    path = usage.ledger_path(recorder.storage_dir)
    path.parent.mkdir(parents=True)
    path.write_text("not json", encoding="utf-8")
    assert usage.usage_report(recorder.storage_dir, now=NOW)["exports"] == 0

    path.write_text(
        json.dumps(
            {
                "exports": [
                    [NOW - 5, "html"],
                    [True, "html"],
                    ["x", "html"],
                    [float("inf"), "html"],
                    [NOW - 5, "other"],
                    [NOW - 5],
                    "entry",
                ]
            }
        ),
        encoding="utf-8",
    )
    assert usage.usage_report(recorder.storage_dir, now=NOW)["exports"] == 1
    path.write_text(json.dumps({"exports": "many"}), encoding="utf-8")
    assert usage.usage_report(recorder.storage_dir, now=NOW)["exports"] == 0
    path.write_text(json.dumps([1, 2]), encoding="utf-8")
    assert usage.usage_report(recorder.storage_dir, now=NOW)["exports"] == 0


def test_sessions_annotated_discussed_summarized_imported(recorder):
    reply = BookmarkReply(note="agreed")
    _save(recorder, "plain")
    _save(recorder, "marked", bookmarks=[Bookmark(step_index=0, note="look")])
    _save(
        recorder,
        "discussed",
        bookmarks=[Bookmark(step_index=0, note="why?", replies=[reply])],
        tags=["imported"],
    )
    _save(
        recorder,
        "summed",
        summary=SessionSummary(text="Did it", provider="ollama", model="m"),
    )
    (recorder.storage_dir / "broken.json").write_text("{", encoding="utf-8")
    (recorder.storage_dir / "list.json").write_text("[]", encoding="utf-8")

    report = usage.usage_report(recorder.storage_dir, now=NOW)

    assert report["sessions"] == {
        "total": 4,
        "annotated": 2,
        "discussed": 1,
        "summarized": 1,
        "imported": 1,
    }
    assert report["annotated_ratio"] == 0.5


def test_no_session_has_no_ratio(recorder):
    report = usage.usage_report(recorder.storage_dir)
    assert report["annotated_ratio"] is None
    assert report["sessions"]["total"] == 0


def test_the_routes_count_an_export_and_answer_the_report(recorder):
    app = FastAPI()
    app.include_router(replay_api.router)
    client = TestClient(app)

    assert client.post("/replay/usage/exports", json={"kind": "html"}).json() == {
        "success": True
    }
    refused = client.post("/replay/usage/exports", json={"kind": "elsewhere"})
    assert refused.status_code == 422

    answer = client.get("/replay/usage").json()
    assert answer["success"] is True
    assert answer["exports"] == 1
    assert answer["weeks"][-1]["by_kind"]["html"] == 1
