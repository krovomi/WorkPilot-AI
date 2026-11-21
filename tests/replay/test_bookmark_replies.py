"""A bookmark as a discussion (#347): each reader of a saved session answers
its note, the replies live in the session file, leave masked with an export,
come back bounded with an import, and show under the bookmark in the page.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from replay import api as replay_api
from replay import bookmarks as bookmark_store
from replay import recorder as recorder_module
from replay.bundle import (
    ExportOptions,
    build_bundle,
    decode,
    encode,
    session_from_bundle,
)
from replay.models import Bookmark, BookmarkReply, ReplaySession, ReplayStep
from replay.viewer import render_viewer

SECRET = "sk-ant-api03-" + "B" * 40  # pragma: allowlist secret
PROJECT = "/home/dev/work/shop"


def _session() -> ReplaySession:
    return ReplaySession(
        session_id="local-1",
        agent_name="coder",
        project_path=PROJECT,
        steps=[ReplayStep(id="s0", step_index=0), ReplayStep(id="s1", step_index=1)],
        status="completed",
    )


@pytest.fixture
def recorder(tmp_path, monkeypatch) -> recorder_module.ReplayRecorder:
    store = recorder_module.ReplayRecorder(storage_dir=tmp_path / "replays")
    monkeypatch.setattr(recorder_module, "_replay_recorder", store)
    store.save_session(_session())
    return store


@pytest.fixture
def mark(recorder) -> Bookmark:
    return bookmark_store.add_bookmark(recorder, "local-1", 1, "why this edit?", "Ada")


def test_replies_follow_each_other_and_are_saved(recorder, mark):
    first = bookmark_store.add_reply(
        recorder, "local-1", mark.id, "  a guess  ", " Bob "
    )
    second = bookmark_store.add_reply(recorder, "local-1", mark.id, "x" * 5000)
    assert (first.note, first.author) == ("a guess", "Bob")
    assert len(second.note) == bookmark_store.MAX_NOTE
    saved = recorder.load_session("local-1")
    assert saved is not None
    assert [r.id for r in saved.bookmarks[0].replies] == [first.id, second.id]


def test_reply_refusals(recorder, mark, monkeypatch):
    live = recorder.start_session("live-1", {"agent_name": "live"})
    cases = [
        ("local-1", mark.id, "   ", "empty_reply"),
        ("missing", mark.id, "n", "not_found"),
        (live.session_id, mark.id, "n", "recording"),
        ("local-1", "other", "n", "no_such_bookmark"),
    ]
    for session_id, bookmark_id, note, code in cases:
        with pytest.raises(bookmark_store.BookmarkError) as error:
            bookmark_store.add_reply(recorder, session_id, bookmark_id, note)
        assert error.value.code == code
    monkeypatch.setattr(bookmark_store, "MAX_REPLIES", 1)
    bookmark_store.add_reply(recorder, "local-1", mark.id, "one")
    with pytest.raises(bookmark_store.BookmarkError, match="too_many_replies"):
        bookmark_store.add_reply(recorder, "local-1", mark.id, "two")


def test_removing_a_reply(recorder, mark):
    reply = bookmark_store.add_reply(recorder, "local-1", mark.id, "n")
    live = recorder.start_session("live-1", {"agent_name": "live"})
    assert not bookmark_store.remove_reply(recorder, live.session_id, mark.id, reply.id)
    assert not bookmark_store.remove_reply(recorder, "missing", mark.id, reply.id)
    assert not bookmark_store.remove_reply(recorder, "local-1", "other", reply.id)
    assert not bookmark_store.remove_reply(recorder, "local-1", mark.id, "other")
    assert bookmark_store.remove_reply(recorder, "local-1", mark.id, reply.id)
    saved = recorder.load_session("local-1")
    assert saved is not None and saved.bookmarks[0].replies == []


def test_replies_leave_masked_and_come_back_bounded():
    session = _session()
    session.bookmarks = [
        Bookmark(
            id="b1",
            step_index=1,
            note="look",
            replies=[
                BookmarkReply(
                    id="r1", note=f"key {SECRET} in {PROJECT}/app.py", author="Bob"
                )
            ],
        )
    ]
    bundle = build_bundle(session, ExportOptions())
    sent = bundle["session"]["bookmarks"][0]["replies"][0]
    assert SECRET not in sent["note"]
    assert "<project>/app.py" in sent["note"]
    back = session_from_bundle(decode(encode(bundle)))
    assert back.bookmarks[0].replies[0].author == "Bob"
    assert back.bookmarks[0].replies[0].id == "r1"

    forged = {
        "session": {
            "bookmarks": [
                {
                    "step_index": 0,
                    "replies": [{"note": "n" * 9000, "author": 4}, "not a reply"]
                    + [{"note": "x"}] * 80,
                }
            ]
        }
    }
    replies = session_from_bundle(forged).bookmarks[0].replies
    # The first 50 entries are read, and what is not a reply among them dropped.
    assert len(replies) == 49
    assert len(replies[0].note) == 4000
    assert replies[0].author == ""
    assert replies[0].id


def test_a_session_file_without_replies_still_loads():
    data = _session().to_dict()
    data["bookmarks"] = [{"id": "b1", "step_index": 0, "note": "old"}]
    assert ReplaySession.from_dict(data).bookmarks[0].replies == []


def test_the_page_shows_the_discussion_as_text():
    session = _session()
    session.bookmarks = [
        Bookmark(
            step_index=1,
            note="look",
            replies=[
                BookmarkReply(note="<script>x()</script>", author="<b>Bob</b>"),
                BookmarkReply(note="anonymous"),
            ],
        ),
        Bookmark(step_index=0, note="alone"),
    ]
    bundle = build_bundle(session, ExportOptions())
    bundle["session"]["bookmarks"][0]["replies"].append("not a reply")
    page = render_viewer(bundle, "en")
    assert "<ul class=replies>" in page
    assert "&lt;script&gt;x()&lt;/script&gt;" in page
    assert "&lt;b&gt;Bob&lt;/b&gt;" in page
    assert "<script>" not in page
    assert page.count("<ul class=replies>") == 1


@pytest.fixture
def client(recorder) -> TestClient:
    app = FastAPI()
    app.include_router(replay_api.router)
    return TestClient(app)


def test_reply_routes(client, recorder, mark):
    url = f"/replay/sessions/local-1/bookmarks/{mark.id}/replies"
    added = client.post(url, json={"note": "agreed", "author": "Bob"})
    assert added.status_code == 200
    reply = added.json()["reply"]
    assert (reply["note"], reply["author"]) == ("agreed", "Bob")
    session = client.get("/replay/sessions/local-1").json()["session"]
    assert session["bookmarks"][0]["replies"][0]["id"] == reply["id"]

    assert client.post(url, json={"note": ""}).status_code == 422
    assert client.post(url, json={"note": " "}).json()["detail"] == "empty_reply"
    assert client.post(url, json={"note": "x" * 4001}).status_code == 422
    other = "/replay/sessions/local-1/bookmarks/other/replies"
    assert client.post(other, json={"note": "n"}).status_code == 404

    assert client.delete(f"{url}/{reply['id']}").status_code == 200
    assert client.delete(f"{url}/{reply['id']}").status_code == 404
