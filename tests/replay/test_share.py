"""Sharing a replay session (#347): the bundle, its page, bookmarks, routes.

The bundle is built from a real recorder's session, masked (secrets, the
project and home folders) and stripped as asked; a bundle someone else made
is read back field by field, bounded, under a new id. The page carries no
script and escapes every text. Routes run in a FastAPI app over a recorder
storing under a temporary folder.
"""

from __future__ import annotations

import base64
import gzip
import html
import json
import re

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from foundation.log_redaction import text_redactor
from replay import api as replay_api
from replay import bookmarks as bookmark_store
from replay import bundle as bundle_module
from replay import recorder as recorder_module
from replay.bundle import (
    BundleError,
    ExportOptions,
    build_bundle,
    decode,
    encode,
    file_name,
    session_from_bundle,
)
from replay.models import (
    Breakpoint,
    FileDiff,
    ReplaySession,
    ReplayStep,
    ReplayStepType,
)
from replay.viewer import _csp, _duration, render_viewer

SECRET = "sk-ant-api03-" + "A" * 40
HOME = "/home/dev"
PROJECT = "/home/dev/work/shop"


def _session(**overrides) -> ReplaySession:
    steps = [
        ReplayStep(
            id="s0",
            step_index=0,
            step_type=ReplayStepType.AGENT_THINKING,
            label="Thinking",
            reasoning=f"Read {PROJECT}/app.py with key {SECRET}",
        ),
        ReplayStep(
            id="s1",
            step_index=1,
            step_type=ReplayStepType.TOOL_CALL,
            label="Edit <b>app</b>",
            description="Fix the bug",
            tool_name="Edit",
            tool_input={"path": f"{PROJECT}/app.py", "lines": [1, 2]},
            tool_output=f"done in {HOME}/cache",
            file_diffs=[
                FileDiff(
                    file_path=f"{PROJECT}/app.py",
                    operation="update",
                    before_content="a",
                    after_content="b",
                    diff_lines=["- a", "+ b", "  c"],
                ),
                FileDiff(file_path="README.md", operation="read"),
            ],
            input_tokens=10,
            output_tokens=5,
            cumulative_tokens=15,
            cost_usd=0.1,
            cumulative_cost_usd=0.1,
            options_considered=["A", "B"],
            chosen_option="B",
        ),
    ]
    values = {
        "session_id": "local-1",
        "agent_name": "Coder Bot",
        "agent_role": "coder",
        "provider": "ollama",
        "model": "qwen3",
        "task_description": "Fix the cart",
        "project_path": PROJECT,
        "start_time": 1_700_000_000.0,
        "end_time": 1_700_003_725.0,
        "steps": steps,
        "total_tokens": 15,
        "total_cost_usd": 0.1,
        "status": "completed",
        "tags": ["imported", "demo"],
    }
    values.update(overrides)
    return ReplaySession(**values)


def _gz(document: object) -> bytes:
    return gzip.compress(json.dumps(document).encode("utf-8"))


def _envelope(session: dict) -> dict:
    return {"format": "wpreplay", "version": 1, "session": session}


class TestTextRedactor:
    def test_it_masks_keys_and_secret_named_values_read_once(self, monkeypatch):
        monkeypatch.setenv("SHOP_API_TOKEN", "value-of-the-token-123")
        redact = text_redactor()
        out = redact(f"{SECRET} and value-of-the-token-123")
        assert SECRET not in out
        assert "value-of-the-token-123" not in out


class TestBuildBundle:
    def test_secrets_and_local_folders_are_masked_everywhere(self):
        bundle = build_bundle(_session(), ExportOptions(), home=HOME, now=5.0)
        text = json.dumps(bundle)
        assert SECRET not in text
        assert HOME not in text
        session = bundle["session"]
        assert session["project_path"] == "<project>"
        assert session["steps"][1]["tool_input"]["path"] == "<project>/app.py"
        assert session["steps"][1]["tool_input"]["lines"] == [1, 2]
        assert session["steps"][1]["tool_output"] == "done in ~/cache"
        assert bundle["exported_at"] == 5.0
        assert bundle["redacted"] is True
        assert bundle["thinking"] == "included"
        assert "file_heatmap" not in session

    def test_windows_folders_are_masked_with_either_separator(self):
        session = _session(project_path="C:\\Users\\dev\\shop")
        session.steps[1].tool_output = "C:/Users/dev/shop/a.py and C:\\Users\\dev\\x"
        bundle = build_bundle(session, ExportOptions(), home="C:\\Users\\dev")
        assert bundle["session"]["steps"][1]["tool_output"] == "<project>/a.py and ~\\x"

    def test_a_root_folder_is_not_a_folder_to_mask(self):
        bundle = build_bundle(_session(project_path="/"), ExportOptions(), home="")
        assert bundle["session"]["project_path"] == "/"

    def test_file_contents_stay_out_unless_asked(self):
        kept = build_bundle(_session(), ExportOptions(include_file_contents=True))
        dropped = build_bundle(_session(), ExportOptions())
        assert kept["session"]["steps"][1]["file_diffs"][0]["after_content"] == "b"
        diff = dropped["session"]["steps"][1]["file_diffs"][0]
        assert diff["after_content"] is None
        assert diff["before_content"] is None
        assert diff["diff_lines"] == ["- a", "+ b", "  c"]

    def test_strip_reasoning_drops_thinking_steps_and_reasoning(self):
        session = _session()
        session.steps[1].reasoning = "because"
        bundle = build_bundle(session, ExportOptions(strip_reasoning=True))
        steps = bundle["session"]["steps"]
        assert [s["step_index"] for s in steps] == [1]
        assert steps[0]["reasoning"] == ""
        assert bundle["session"]["step_count"] == 1
        assert bundle["thinking"] == "removed"

    def test_a_session_without_thinking_says_so(self):
        session = _session()
        session.steps = session.steps[1:]
        assert build_bundle(session, ExportOptions())["thinking"] == "none"
        session.steps[0].reasoning = "  "
        stripped = build_bundle(session, ExportOptions(strip_reasoning=True))
        assert stripped["thinking"] == "none"

    def test_reasoning_alone_counts_as_a_thinking_trace(self):
        session = _session()
        session.steps = session.steps[1:]
        session.steps[0].reasoning = "why"
        assert build_bundle(session, ExportOptions())["thinking"] == "included"

    def test_strip_tokens_zeroes_counts_and_costs(self):
        bundle = build_bundle(_session(), ExportOptions(strip_tokens=True))
        session = bundle["session"]
        assert session["total_tokens"] == 0
        assert session["total_cost_usd"] == 0.0
        step = session["steps"][1]
        assert (step["input_tokens"], step["output_tokens"]) == (0, 0)
        assert (step["cumulative_tokens"], step["cost_usd"]) == (0, 0.0)
        assert bundle["options"]["strip_tokens"] is True

    def test_home_defaults_to_the_user_home(self, monkeypatch, tmp_path):
        monkeypatch.setattr(bundle_module.Path, "home", lambda: tmp_path)
        session = _session(project_path="")
        session.steps[1].tool_output = f"{tmp_path}/notes"
        bundle = build_bundle(session, ExportOptions())
        assert bundle["session"]["steps"][1]["tool_output"] == "~/notes"
        assert bundle["exported_at"] > 0

    def test_file_names_are_safe_on_every_os(self):
        assert file_name(_session()) == "replay-coder-bot-20231114-2213.wpreplay"
        assert file_name(_session(agent_name="../ :*"), ".html").startswith(
            "replay-session-"
        )


class TestDecode:
    def test_a_bundle_round_trips(self):
        bundle = build_bundle(_session(), ExportOptions())
        assert decode(encode(bundle)) == json.loads(json.dumps(bundle))

    def test_plain_json_is_read_too(self):
        raw = json.dumps(_envelope({})).encode("utf-8")
        assert decode(raw)["format"] == "wpreplay"

    @pytest.mark.parametrize(
        ("data", "code"),
        [
            (b"\x1f\x8bnot gzip", "unreadable"),
            (b"\xff\xfe", "unreadable"),
            (b"{not json", "unreadable"),
            (b"[]", "not_a_bundle"),
            (json.dumps({"format": "other"}).encode(), "not_a_bundle"),
            (
                json.dumps({"format": "wpreplay", "version": 2}).encode(),
                "unsupported_version",
            ),
            (json.dumps({"format": "wpreplay", "version": 1}).encode(), "not_a_bundle"),
        ],
    )
    def test_what_is_not_a_bundle_is_refused(self, data, code):
        with pytest.raises(BundleError) as error:
            decode(data)
        assert error.value.args[0] == code

    def test_a_large_file_is_refused_before_it_is_read(self, monkeypatch):
        monkeypatch.setattr(bundle_module, "MAX_BUNDLE_BYTES", 10)
        with pytest.raises(BundleError, match="too_large"):
            decode(b"x" * 11)

    def test_a_bundle_that_inflates_past_the_bound_is_refused(self, monkeypatch):
        monkeypatch.setattr(bundle_module, "MAX_JSON_BYTES", 1000)
        with pytest.raises(BundleError, match="too_large"):
            decode(gzip.compress(b" " * 100_000))


class TestSessionFromBundle:
    def test_an_exported_session_comes_back_under_a_new_id(self):
        bundle = decode(encode(build_bundle(_session(), ExportOptions())))
        session = session_from_bundle(bundle)
        assert session.session_id != "local-1"
        assert session.tags == ["imported", "demo"]
        assert session.status == "completed"
        assert [s.step_type for s in session.steps] == [
            ReplayStepType.AGENT_THINKING,
            ReplayStepType.TOOL_CALL,
        ]
        assert session.steps[1].file_diffs[0].diff_lines == ["- a", "+ b", "  c"]
        assert session.steps[1].file_diffs[1].diff_lines is None
        assert session.steps[1].tool_input == {
            "path": "<project>/app.py",
            "lines": [1.0, 2.0],
        }
        assert session.end_time == 1_700_003_725.0

    def test_every_field_is_rebuilt_from_what_it_should_be(self):
        hostile = {
            "agent_name": ["not", "text"],
            "start_time": "yesterday",
            "end_time": None,
            "total_tokens": 10**30,
            "total_cost_usd": float("inf"),
            "total_tool_calls": True,
            "tags": "imported",
            "steps": [
                {
                    "step_type": "teleport",
                    "step_index": "3",
                    "label": {"x": 1},
                    "tool_input": ["not", "a", "dict"],
                    "file_diffs": "nope",
                    "is_breakpoint": "yes",
                    "children_step_ids": [1, "c1"],
                },
                {
                    "id": "keep",
                    "step_type": "decision",
                    "step_index": 7,
                    "tool_input": {"deep": {"a": {"b": {"c": {"d": {"e": {"f": 1}}}}}}},
                },
                "not a step",
            ],
            "breakpoints": [
                {"breakpoint_type": "nonsense"},
                {"breakpoint_type": "error", "enabled": False, "condition": 5},
            ],
            "bookmarks": [{"step_index": -4, "note": "look", "author": 3}],
        }
        session = session_from_bundle(_envelope(hostile))
        assert session.agent_name == ""
        assert session.start_time == 0.0
        assert session.end_time is None
        assert session.total_tokens == 0
        assert session.total_cost_usd == 0.0
        assert session.total_tool_calls == 0
        assert session.tags == ["imported"]
        first, second = session.steps
        assert first.step_type == ReplayStepType.PROGRESS
        assert first.step_index == 0
        assert first.label == ""
        assert first.tool_input is None
        assert first.file_diffs == []
        assert first.is_breakpoint is False
        assert first.children_step_ids == ["c1"]
        assert len(first.id) == 12
        assert second.id == "keep"
        assert second.step_index == 7
        deep = second.tool_input["deep"]["a"]["b"]["c"]["d"]
        assert deep == {"e": None}
        assert len(session.breakpoints) == 1
        assert session.breakpoints[0].enabled is False
        assert session.breakpoints[0].condition == ""
        mark = session.bookmarks[0]
        assert (mark.step_index, mark.note, mark.author) == (0, "look", "")
        assert len(mark.id) == 8

    def test_json_values_keep_their_plain_types_only(self):
        assert bundle_module._json(object()) is None
        assert bundle_module._json(True) is True
        assert bundle_module._json(None) is None
        assert bundle_module._json("x" * (bundle_module.MAX_TEXT + 5)) == (
            "x" * bundle_module.MAX_TEXT
        )


class TestViewer:
    def _page(self, session: ReplaySession | None = None, language="en", **options):
        bundle = build_bundle(
            session or _session(), ExportOptions(**options), home=HOME
        )
        return render_viewer(bundle, language)

    def test_the_page_has_no_script_and_escapes_every_text(self):
        session = _session()
        session.steps[1].description = "<script>alert(1)</script>"
        page = self._page(session)
        assert "<script" not in page
        assert "&lt;script&gt;alert(1)&lt;/script&gt;" in page
        assert "Edit &lt;b&gt;app&lt;/b&gt;" in page
        assert SECRET not in page

    def test_its_policy_allows_only_its_own_style(self):
        page = self._page()
        policy = re.search(r'Content-Security-Policy" content="([^"]+)"', page)
        assert policy is not None
        assert html.unescape(policy.group(1)) == _csp()
        assert _csp().startswith("default-src 'none'; style-src 'sha256-")

    def test_steps_diffs_and_choices_are_shown(self):
        page = self._page()
        assert 'id="step-1"' in page
        assert '<span class="add">+ b</span>' in page
        assert '<span class="del">- a</span>' in page
        assert "<span>  c</span>" in page
        assert "<code>README.md</code></p><h3" not in page
        assert "Options considered" in page
        assert "ollama · qwen3" in page
        assert "1:02:05" in page
        assert "Tokens" in page

    def test_bookmarks_link_to_their_step(self):
        session = _session()
        session.bookmarks = [
            bookmark_store.Bookmark(
                step_index=1, note="**weird** choice", author="Ana"
            ),
            bookmark_store.Bookmark(step_index=0, note="start"),
        ]
        page = self._page(session)
        assert '<a href="#step-1">Step 1</a> · Ana' in page
        assert "**weird** choice" in page
        assert '<details id="step-1" class="marked">' in page

    def test_the_page_speaks_french(self):
        page = self._page(language="fr", strip_tokens=True)
        assert '<html lang="fr">' in page
        assert "Rejeu d&#x27;agent" in page
        assert "Les tokens et les coûts ont été retirés" in page
        assert "Tokens</dt>" not in page

    def test_an_unknown_language_falls_back_to_english(self):
        assert '<html lang="en">' in self._page(language="de")

    def test_it_says_when_there_is_no_thinking_or_it_was_removed(self):
        removed = self._page(strip_reasoning=True)
        assert "The reasoning was removed before export." in removed
        session = _session()
        session.steps = session.steps[1:]
        assert "No thinking trace is available" in self._page(session)

    def test_an_empty_session_still_renders(self):
        session = _session(steps=[], task_description="", agent_name="", provider="")
        page = self._page(session)
        assert "This session has no steps." in page
        assert "<dt>Task</dt>" not in page

    def test_short_durations_have_no_hour(self):
        assert _duration(65) == "1:05"
        assert _duration(-3) == "0:00"


@pytest.fixture
def recorder(tmp_path, monkeypatch) -> recorder_module.ReplayRecorder:
    store = recorder_module.ReplayRecorder(storage_dir=tmp_path / "replays")
    monkeypatch.setattr(recorder_module, "_replay_recorder", store)
    return store


class TestBookmarks:
    def test_a_bookmark_is_kept_sorted_with_the_saved_session(self, recorder):
        recorder.save_session(_session())
        late = bookmark_store.add_bookmark(recorder, "local-1", 1, "  later  ", " me ")
        early = bookmark_store.add_bookmark(recorder, "local-1", 0, "first")
        saved = recorder.load_session("local-1")
        assert saved is not None
        assert [b.id for b in saved.bookmarks] == [early.id, late.id]
        assert (late.note, late.author) == ("later", "me")

    def test_refusals(self, recorder, monkeypatch):
        recorder.save_session(_session())
        cases = {"no_such_step": ("local-1", 9), "not_found": ("missing", 0)}
        for code, (session_id, step) in cases.items():
            with pytest.raises(bookmark_store.BookmarkError) as error:
                bookmark_store.add_bookmark(recorder, session_id, step, "n")
            assert error.value.code == code
        monkeypatch.setattr(bookmark_store, "MAX_BOOKMARKS", 1)
        bookmark_store.add_bookmark(recorder, "local-1", 0, "one")
        with pytest.raises(bookmark_store.BookmarkError, match="too_many"):
            bookmark_store.add_bookmark(recorder, "local-1", 0, "two")

    def test_a_recording_session_takes_no_bookmark(self, recorder):
        live = recorder.start_session("live-1", {"agent_name": "live"})
        with pytest.raises(bookmark_store.BookmarkError, match="recording"):
            bookmark_store.add_bookmark(recorder, live.session_id, 0, "n")
        assert not bookmark_store.remove_bookmark(recorder, live.session_id, "x")

    def test_removing(self, recorder):
        recorder.save_session(_session())
        mark = bookmark_store.add_bookmark(recorder, "local-1", 0, "n")
        assert not bookmark_store.remove_bookmark(recorder, "missing", mark.id)
        assert not bookmark_store.remove_bookmark(recorder, "local-1", "other")
        assert bookmark_store.remove_bookmark(recorder, "local-1", mark.id)
        saved = recorder.load_session("local-1")
        assert saved is not None and saved.bookmarks == []


@pytest.fixture
def client(recorder) -> TestClient:
    app = FastAPI()
    app.include_router(replay_api.router)
    return TestClient(app)


class TestRoutes:
    def test_export_as_a_bundle_and_import_it_back(self, client, recorder):
        recorder.save_session(_session())
        answer = client.post(
            "/replay/sessions/local-1/export", json={"strip_reasoning": True}
        ).json()
        assert answer["file_name"].endswith(".wpreplay")
        imported = client.post(
            "/replay/import", json={"content_base64": answer["content_base64"]}
        ).json()
        assert imported["session"]["tags"][0] == "imported"
        new_id = imported["session"]["session_id"]
        assert recorder.load_session(new_id) is not None
        assert recorder.load_session("local-1") is not None

    def test_export_as_a_page(self, client, recorder):
        recorder.save_session(_session())
        answer = client.post(
            "/replay/sessions/local-1/export", json={"format": "html", "language": "fr"}
        ).json()
        assert answer["file_name"].endswith(".html")
        page = base64.b64decode(answer["content_base64"]).decode("utf-8")
        assert page.startswith("<!doctype html>")

    def test_export_refusals(self, client):
        assert (
            client.post("/replay/sessions/missing/export", json={}).status_code == 404
        )
        bad = client.post("/replay/sessions/x/export", json={"format": "exe"})
        assert bad.status_code == 422

    @pytest.mark.parametrize(
        ("content", "detail"),
        [
            ("@@not base64@@", "unreadable"),
            (base64.b64encode(b"[]").decode(), "not_a_bundle"),
        ],
    )
    def test_import_refusals(self, client, content, detail):
        answer = client.post("/replay/import", json={"content_base64": content})
        assert answer.status_code == 422
        assert answer.json()["detail"] == detail

    def test_bookmark_routes(self, client, recorder):
        recorder.save_session(_session())
        added = client.post(
            "/replay/sessions/local-1/bookmarks", json={"step_index": 1, "note": "see"}
        ).json()["bookmark"]
        assert added["note"] == "see"
        missing = client.post(
            "/replay/sessions/local-1/bookmarks", json={"step_index": 4}
        )
        assert missing.status_code == 422
        live = recorder.start_session("live-1", {"agent_name": "live"})
        busy = client.post(
            f"/replay/sessions/{live.session_id}/bookmarks", json={"step_index": 0}
        )
        assert busy.status_code == 409
        path = f"/replay/sessions/local-1/bookmarks/{added['id']}"
        assert client.delete(path).status_code == 200
        assert client.delete(path).status_code == 404
        assert (
            client.get("/replay/sessions/local-1").json()["session"]["bookmarks"] == []
        )

    def test_a_negative_step_or_a_long_note_is_refused(self, client):
        url = "/replay/sessions/local-1/bookmarks"
        assert client.post(url, json={"step_index": -1}).status_code == 422
        long_note = {"step_index": 0, "note": "x" * 4001}
        assert client.post(url, json=long_note).status_code == 422


def test_breakpoints_and_diffs_survive_the_round_trip():
    session = _session()
    session.breakpoints = [Breakpoint(condition="Edit")]
    back = session_from_bundle(decode(encode(build_bundle(session, ExportOptions()))))
    assert back.breakpoints[0].condition == "Edit"
    assert back.steps[1].file_diffs[0].operation == "update"
