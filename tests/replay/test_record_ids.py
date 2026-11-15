"""Replay records are named by their ids, and only by ids the replay makes.

The router runs in a FastAPI app (TestClient) over a real recorder and a real
time-travel engine, both storing under a temporary folder. An id that is not
one of theirs (a path, a dot, a separator) names no file: reading, scoring
or deleting by it finds nothing, and files beside the store stay as they are.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from replay import api as replay_api
from replay import recorder as recorder_module
from replay import time_travel as time_travel_module
from replay.models import ForkSession, ReplaySession
from replay.storage import record_file, require_record_file
from replay.time_travel import TimeTravelEngine

NOT_IDS = ["../outside", "..", ".hidden", "a/b", "a\\b", "", "x" * 129, "a.b"]


@pytest.fixture
def store(tmp_path, monkeypatch):
    replays = tmp_path / "data" / "replays"
    recorder = recorder_module.ReplayRecorder(storage_dir=replays)
    engine = TimeTravelEngine(storage_dir=replays / "time_travel")
    monkeypatch.setattr(recorder_module, "_replay_recorder", recorder)
    monkeypatch.setattr(time_travel_module, "_time_travel_engine", engine)
    monkeypatch.setattr(time_travel_module, "get_replay_recorder", lambda: recorder)
    for name in (
        "outside.json",
        "data/outside.json",
        "data/replays/time_travel/x.json",
    ):
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text("{}", encoding="utf-8")
    return tmp_path, recorder, engine


@pytest.fixture
def client(store) -> TestClient:
    app = FastAPI()
    app.include_router(replay_api.router)
    return TestClient(app)


def _kept(root) -> list[str]:
    return sorted(
        p.relative_to(root).as_posix() for p in root.rglob("*.json") if p.is_file()
    )


class TestRecordFile:
    @pytest.mark.parametrize("record_id", NOT_IDS + [None, 7])
    def test_what_is_not_an_id_names_no_file(self, tmp_path, record_id):
        assert record_file(tmp_path, record_id) is None
        with pytest.raises(ValueError):
            require_record_file(tmp_path, record_id)

    @pytest.mark.parametrize(
        "record_id", ["3f2a9c1e0b7d4a55", "1b4e28ba-2fa1-11d2-883f-0016d3cca427", "f_1"]
    )
    def test_the_ids_the_replay_makes(self, tmp_path, record_id):
        assert record_file(tmp_path, record_id, "scores_") == (
            tmp_path / f"scores_{record_id}.json"
        )

    def test_a_record_that_links_out_of_the_store_is_not_one(self, tmp_path):
        store = tmp_path / "store"
        store.mkdir()
        (tmp_path / "elsewhere.json").write_text("{}", encoding="utf-8")
        try:
            (store / "s1.json").symlink_to(tmp_path / "elsewhere.json")
        except OSError:
            pytest.skip("this system does not let the test create a symlink")

        assert record_file(store, "s1") is None

    def test_a_store_reached_through_a_link_still_names_its_own_files(self, tmp_path):
        real = tmp_path / "real"
        real.mkdir()
        try:
            (tmp_path / "link").symlink_to(real, target_is_directory=True)
        except OSError:
            pytest.skip("this system does not let the test create a symlink")

        assert record_file(tmp_path / "link", "s1") == tmp_path / "link" / "s1.json"


class TestRoutes:
    def test_a_bulk_delete_removes_only_sessions(self, client, store):
        root, recorder, _engine = store
        recorder.save_session(ReplaySession(session_id="s1"))

        answer = client.post(
            "/replay/sessions/bulk-delete",
            json={"session_ids": ["s1", *NOT_IDS, "../../outside", "../data/outside"]},
        ).json()

        assert answer == {"success": True, "deleted": 1}
        assert _kept(root) == [
            "data/outside.json",
            "data/replays/time_travel/x.json",
            "outside.json",
        ]

    @pytest.mark.parametrize(
        ("method", "path"),
        [
            ("get", "/replay/sessions/..%2F..%2Foutside"),
            ("delete", "/replay/sessions/..%2F..%2Foutside"),
            ("delete", "/replay/sessions/..%5C..%5Coutside"),
            ("get", "/replay/sessions/..%2Ftime_travel%2Fx/checkpoints"),
            ("get", "/replay/forks/..%2Fx"),
            ("delete", "/replay/forks/..%2Fx"),
            ("get", "/replay/sessions/..%2F..%2Foutside/decisions/scores"),
        ],
    )
    def test_an_id_that_is_a_path_finds_nothing(self, client, store, method, path):
        root, _recorder, _engine = store

        answer = getattr(client, method)(path)

        assert answer.status_code in (200, 404)
        assert answer.json().get("checkpoints", []) == []
        assert answer.json().get("scores", []) == []
        assert _kept(root) == [
            "data/outside.json",
            "data/replays/time_travel/x.json",
            "outside.json",
        ]


class TestStorage:
    def test_records_are_never_written_under_another_name(self, store):
        _root, recorder, engine = store

        with pytest.raises(ValueError):
            recorder.save_session(ReplaySession(session_id="../x"))
        with pytest.raises(ValueError):
            engine._save_fork(ForkSession(fork_id="../x", original_session_id="s1"))
        with pytest.raises(ValueError):
            engine._save_checkpoints("../x", [])
        with pytest.raises(ValueError):
            engine._save_decision_scores("../x", [])

    def test_records_are_never_read_under_another_name(self, store):
        root, _recorder, engine = store
        (root / "data" / "replays" / "scores_x.json").write_text("[]", encoding="utf-8")

        assert engine._load_checkpoints("../time_travel/x") == []
        assert engine._load_decision_scores("../x") == []
        assert engine.get_fork("../time_travel/x") is None

    def test_checkpoints_and_scores_round_trip(self, store):
        _root, _recorder, engine = store

        engine._save_checkpoints("s1", [])
        engine._save_decision_scores("s1", [])

        assert engine._load_checkpoints("s1") == []
        assert engine._load_decision_scores("s1") == []
        assert (engine._checkpoints_dir / "s1.json").exists()

    def test_a_valid_record_round_trips(self, store):
        _root, recorder, engine = store
        recorder.save_session(ReplaySession(session_id="s1"))
        engine._save_fork(ForkSession(fork_id="f1", original_session_id="s1"))

        assert recorder.load_session("s1").session_id == "s1"
        assert engine.get_fork("f1").fork_id == "f1"
        assert engine.delete_fork("f1") is True
        assert engine.delete_fork("f1") is False
        assert recorder.delete_session("s1") is True
