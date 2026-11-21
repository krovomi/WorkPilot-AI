"""A recorded session, followed from the recorder through time travel to the routes.

The recorder, the time-travel engine and the FastAPI router are the real ones,
all storing under a temporary folder. A session is recorded the way an agent
run records one (thinking, answers, tool calls, file changes, commands,
decisions, errors), saved, and then read back the way the Replay and Debugger
screens read it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from replay import api as replay_api
from replay import recorder as recorder_module
from replay import time_travel as time_travel_module
from replay.models import (
    BreakpointType,
    FileDiff,
    ForkRequest,
    ReplaySession,
    ReplayStep,
    ReplayStepType,
)
from replay.recorder import ReplayRecorder, get_replay_recorder
from replay.time_travel import (
    TimeTravelEngine,
    _step_to_conversation_message,
    get_time_travel_engine,
)


@pytest.fixture
def recorder(tmp_path, monkeypatch) -> ReplayRecorder:
    made = ReplayRecorder(storage_dir=tmp_path / "replays")
    monkeypatch.setattr(recorder_module, "_replay_recorder", made)
    return made


@pytest.fixture
def engine(tmp_path, recorder, monkeypatch) -> TimeTravelEngine:
    made = TimeTravelEngine(storage_dir=tmp_path / "replays" / "time_travel")
    monkeypatch.setattr(time_travel_module, "_time_travel_engine", made)
    monkeypatch.setattr(time_travel_module, "get_replay_recorder", lambda: recorder)
    return made


@pytest.fixture
def client(engine) -> TestClient:
    app = FastAPI()
    app.include_router(replay_api.router)
    return TestClient(app)


def _record(
    recorder: ReplayRecorder, session_id: str = "s1", *, task: str = "Add login"
):
    """A run as an agent records it, ended and saved."""
    recorder.start_session(
        session_id,
        {"agent_name": "Coder", "agent_type": "coder", "task": task, "tags": ["t"]},
    )
    recorder.record_thinking(session_id, "Read the routes first")
    recorder.record_decision(
        session_id, "Where the login lives", ["api", "web"], "api", "API first"
    )
    recorder.record_tool_call(session_id, "Read", "src/app.py", {"path": "src/app.py"})
    recorder.record_tool_result(session_id, "Read", "def app(): ...")
    recorder.record_file_change(
        session_id, "src/a/b/c/login.py", "create", after_content="def login():\n    ok"
    )
    recorder.record_file_change(
        session_id,
        "src/app.py",
        "update",
        before_content="a\nb",
        after_content="a\nc",
    )
    recorder.record_file_change(session_id, "src/old.py", "delete")
    recorder.record_file_change(session_id, "README.md", "read")
    recorder.record_response(session_id, "Done", 1200, 300, 0.01)
    recorder.record_command(session_id, "pytest -q", cwd="/repo")
    recorder.record_command_output(session_id, "1 failed", is_error=True)
    recorder.record_test(session_id, "pytest -q")
    recorder.record_test(session_id, "pytest -q", success=False, details="1 failed")
    recorder.record_test(session_id, "pytest -q", success=True)
    recorder.record_error(session_id, "AssertionError", "test")
    recorder.record_progress(session_id, 0.5, "half way")
    recorder.record_tool_result(session_id, "Bash", None, success=False)
    return recorder.end_session(session_id, status="failed")


class TestRecorder:
    def test_a_recorded_session_is_saved_with_its_totals(self, recorder):
        session = _record(recorder)

        saved = recorder.load_session("s1")
        assert saved is not None and session is not None
        types = [s.step_type for s in saved.steps]
        assert types[0] == ReplayStepType.SESSION_START
        assert types[-1] == ReplayStepType.SESSION_END
        assert saved.steps[-1].label == "Session Ended (failed)"
        assert saved.status == "failed"
        assert (saved.total_tool_calls, saved.total_file_changes) == (1, 3)
        assert saved.files_touched == [
            "README.md",
            "src/a/b/c/login.py",
            "src/app.py",
            "src/old.py",
        ]
        assert saved.total_tokens == 1500
        # Each step links to the one before it.
        assert saved.steps[1].parent_step_id == saved.steps[0].id
        assert saved.steps[0].children_step_ids == [saved.steps[1].id]
        assert not recorder.is_recording("s1")

    def test_a_file_change_keeps_its_diff_and_a_short_label(self, recorder):
        recorder.start_session("s1", {})
        created = recorder.record_file_change(
            "s1", "src/a/b/c/login.py", "create", after_content="x\ny"
        )
        updated = recorder.record_file_change(
            "s1", "src/app.py", "update", before_content="a\nb", after_content="a\nc"
        )
        other = recorder.record_file_change("s1", "x.py", "rename")

        assert created.label == "File create: .../b/c/login.py"
        assert created.file_diffs[0].line_count_after == 2
        assert updated.label == "File update: src/app.py"
        assert updated.file_diffs[0].diff_lines == ["- b", "+ c"]
        assert other.step_type == ReplayStepType.FILE_UPDATE

    def test_breakpoints_and_a_file_touched_twice_are_saved_once(self, recorder):
        recorder.start_session("s1", {})
        bp = recorder.add_breakpoint("s1", "file_change", "app.py", "the app")
        recorder.record_file_change("s1", "src/app.py", after_content="a")
        recorder.record_file_change("s1", "src/app.py", after_content="b")
        recorder.end_session("s1")

        saved = recorder.load_session("s1")

        assert saved.files_touched == ["src/app.py"]
        assert [(b.id, b.hit_count, b.description) for b in saved.breakpoints] == [
            (bp.id, 2, "the app")
        ]

    def test_the_end_label_of_a_clean_run(self, recorder):
        recorder.start_session("s1", {})
        recorder.record_tool_call("s1", "Grep")

        session = recorder.end_session("s1")

        assert session.steps[-1].label == "Session Completed"
        assert session.steps[1].description == "Grep"

    def test_nothing_is_recorded_for_a_session_that_is_not_running(self, recorder):
        assert recorder.record_thinking("nope", "x") is None
        assert recorder.record_file_change("nope", "a.py") is None
        assert recorder.record_tool_call("nope", "Read") is None
        assert recorder.end_session("nope") is None
        assert recorder.add_breakpoint("nope", "error", "") is None
        assert recorder.remove_breakpoint("nope", "b1") is False
        assert recorder.check_breakpoints("nope", ReplayStep()) == []
        recorder.record_usage("nope", 10, 10, 1.0)

    def test_usage_adds_to_the_running_totals(self, recorder):
        recorder.start_session("s1", {})
        recorder.record_usage("s1", 100, None, None)
        recorder.record_usage("s1", 10, 5, 0.5)

        session = recorder.end_session("s1")

        assert (session.total_tokens, session.total_cost_usd) == (115, 0.5)

    def test_a_long_diff_is_cut(self, recorder):
        before = "\n".join(f"old {i}" for i in range(150))
        after = "\n".join(f"new {i}" for i in range(150))
        recorder.start_session("s1", {})

        step = recorder.record_file_change(
            "s1", "big.py", before_content=before, after_content=after
        )

        assert len(step.file_diffs[0].diff_lines) == 200

    def test_saved_sessions_are_listed_newest_first_and_broken_files_skipped(
        self, recorder
    ):
        _record(recorder, "old")
        _record(recorder, "new")
        older = recorder.load_session("old")
        older.start_time -= 100
        recorder.save_session(older)
        (recorder._storage_dir / "broken.json").write_text("{", encoding="utf-8")

        listed = recorder.list_sessions()

        assert [s["session_id"] for s in listed] == ["new", "old"]
        assert recorder.load_session("broken") is None
        assert recorder.delete_session("old") is True
        assert recorder.delete_session("old") is False

    def test_the_shared_recorder_lives_in_the_user_folder(self, tmp_path, monkeypatch):
        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        monkeypatch.setattr(recorder_module, "_replay_recorder", None)

        first = get_replay_recorder()

        assert first is get_replay_recorder()
        assert first._storage_dir == tmp_path / ".workpilot" / "replays"


class TestBreakpoints:
    def _hits(self, recorder, bp_type: str, condition: str = "") -> list[str]:
        recorder.start_session("s1", {})
        bp = recorder.add_breakpoint("s1", bp_type, condition, "why")
        steps = [
            recorder.record_tool_call("s1", "Bash", "ls"),
            recorder.record_tool_call("s1", "Read"),
            recorder.record_file_change(
                "s1", "src/auth/login.py", "create", after_content="x"
            ),
            recorder.record_file_change("s1", "docs/a.md", "update", after_content="y"),
            recorder.record_decision("s1", "pick", ["a", "b"], "a"),
            recorder.record_error("s1", "Boom happened"),
            recorder.record_response("s1", "ok", 500, 600),
        ]
        hit = [s.label for s in steps if s.is_breakpoint]
        assert bp.hit_count == len(hit)
        return hit

    def test_a_tool_call_breakpoint_on_one_tool(self, recorder):
        assert self._hits(recorder, "tool_call", "Read") == ["Tool: Read"]

    def test_a_file_change_breakpoint_on_a_path(self, recorder):
        assert self._hits(recorder, "file_change", "auth/") == [
            "File create: src/auth/login.py"
        ]

    def test_a_file_change_breakpoint_on_any_path(self, recorder):
        assert len(self._hits(recorder, "file_change")) == 2

    def test_decision_error_and_pattern_breakpoints(self, recorder):
        assert self._hits(recorder, "decision") == ["Decision: pick"]

    def test_an_error_breakpoint(self, recorder):
        assert self._hits(recorder, "error") == ["Error: unknown"]

    def test_a_pattern_breakpoint_ignores_case(self, recorder):
        assert self._hits(recorder, "pattern_match", "boom") == ["Error: unknown"]

    def test_a_token_threshold_breakpoint(self, recorder):
        assert self._hits(recorder, "token_threshold", "1000") == ["Agent Response"]

    def test_a_step_index_breakpoint(self, recorder):
        # Step 0 is the session start: the first tool call is step 1.
        assert self._hits(recorder, "step_index", "1") == ["Tool: Bash"]

    @pytest.mark.parametrize("bp_type", ["token_threshold", "step_index"])
    def test_a_number_breakpoint_without_a_number_never_hits(self, recorder, bp_type):
        assert self._hits(recorder, bp_type, "many") == []

    def test_a_disabled_or_removed_breakpoint_does_not_hit(self, recorder):
        recorder.start_session("s1", {})
        off = recorder.add_breakpoint("s1", "tool_call", "")
        off.enabled = False
        gone = recorder.add_breakpoint("s1", "tool_call", "")
        assert recorder.remove_breakpoint("s1", gone.id) is True

        step = recorder.record_tool_call("s1", "Read")

        assert step.is_breakpoint is False
        assert [b.id for b in recorder._active_sessions["s1"].breakpoints] == [off.id]


def _decision_session(recorder: ReplayRecorder) -> ReplaySession:
    """A saved session whose decisions differ on every scoring factor."""
    steps = [
        ReplayStep(
            step_index=0, step_type=ReplayStepType.SESSION_START, description="go"
        ),
        # Quick, one option, nothing after it: confident, low impact.
        ReplayStep(
            step_index=1,
            step_type=ReplayStepType.DECISION,
            duration_ms=100,
            options_considered=["only"],
            chosen_option="only",
        ),
        # Long, many options, then errors, many file changes, many tokens.
        ReplayStep(
            step_index=2,
            step_type=ReplayStepType.DECISION,
            duration_ms=9000,
            options_considered=["a", "b", "c", "d"],
            chosen_option="d",
        ),
        ReplayStep(step_index=3, step_type=ReplayStepType.ERROR, description="x"),
        ReplayStep(
            step_index=4,
            step_type=ReplayStepType.FILE_UPDATE,
            file_diffs=[
                FileDiff(f"f{i}.py", "update", after_content="v") for i in range(6)
            ],
            input_tokens=9000,
            output_tokens=2000,
        ),
        # Two options, a middling duration: no factor from either.
        ReplayStep(
            step_index=5,
            step_type=ReplayStepType.DECISION,
            duration_ms=1000,
            options_considered=["a", "b"],
        ),
        ReplayStep(
            step_index=6,
            step_type=ReplayStepType.FILE_CREATE,
            file_diffs=[FileDiff("f0.py", "create", after_content="w")],
        ),
    ]
    session = ReplaySession(session_id="d1", steps=steps, start_time=1.0, end_time=2.0)
    recorder.save_session(session)
    return session


class TestDecisionScores:
    def test_each_factor_moves_the_scores(self, recorder, engine):
        _decision_session(recorder)

        quick, hard, plain = engine.score_decisions("d1")

        assert (quick.confidence_score, quick.impact_score) == (0.85, 0.4)
        assert quick.factors == [
            "Quick decision (high confidence)",
            "Single clear option",
            "No file changes followed",
        ]
        assert hard.is_critical and hard.confidence_score == 0.0
        assert hard.impact_score == 1.0
        assert hard.factors == [
            "Long deliberation (lower confidence)",
            "Many options considered (4)",
            "Followed by 1 error(s)",
            "Led to 6 file changes",
            "High token cost after (11000)",
        ]
        assert plain.factors == []
        assert engine.get_decision_scores("d1") == [quick, hard, plain]

    def test_the_heatmap_scores_first_when_nothing_is_scored(self, recorder, engine):
        _decision_session(recorder)

        heatmap = engine.get_decision_heatmap("d1")

        assert heatmap["decision_count"] == 3
        assert heatmap["critical_decisions"] == 1
        top = heatmap["file_impact"][0]
        assert (top["file_path"], top["intensity"]) == ("f0.py", 1.0)
        assert engine.get_decision_heatmap("missing") == {}
        assert engine.score_decisions("missing") == []

    def test_a_session_without_file_changes_has_an_empty_heatmap(
        self, recorder, engine
    ):
        recorder.save_session(
            ReplaySession(
                session_id="d2",
                steps=[ReplayStep(step_index=0, step_type=ReplayStepType.DECISION)],
            )
        )

        heatmap = engine.get_decision_heatmap("d2")

        assert heatmap["file_impact"] == [] and heatmap["decision_count"] == 1

    def test_unreadable_scores_are_none(self, engine):
        (engine._storage_dir / "scores_d1.json").write_text("[{", encoding="utf-8")

        assert engine.get_decision_scores("d1") == []


class TestCheckpointsAndForks:
    def test_checkpoints_carry_the_conversation_and_the_files_so_far(
        self, recorder, engine
    ):
        _record(recorder)

        checkpoints = engine.create_checkpoints_for_session("s1")

        kinds = [c.checkpoint_type.value for c in checkpoints]
        assert kinds == [
            "auto_decision",
            "auto_tool_call",
            "auto_file_change",
            "auto_file_change",
            "auto_file_change",
        ]
        last = checkpoints[-1]
        assert last.file_snapshots == {
            "src/a/b/c/login.py": "def login():\n    ok",
            "src/app.py": "a\nc",
        }
        roles = [m["role"] for m in last.conversation_history]
        assert roles == [
            "system",
            "assistant_thinking",
            "assistant",
            "assistant",
            "tool",
            "assistant",
            "assistant",
            "assistant",
        ]
        assert engine.get_checkpoints("s1") == checkpoints
        assert engine.create_checkpoints_for_session("missing") == []

    def test_a_manual_checkpoint_is_kept_in_step_order(self, recorder, engine):
        _record(recorder)
        engine.create_checkpoints_for_session("s1")

        manual = engine.add_manual_checkpoint("s1", 1)

        assert manual.label == "Agent Thinking"
        assert manual.conversation_history[-1]["content"] == "Read the routes first"
        assert engine.get_checkpoints("s1")[0].id == manual.id
        at_end = engine.add_manual_checkpoint("s1", 18, description="the end")
        # Reads, tests, progress and the end are not part of the conversation,
        # and a read changes no file.
        assert at_end.description == "the end"
        assert len(at_end.conversation_history) == 13
        assert "README.md" not in at_end.file_snapshots
        assert engine.add_manual_checkpoint("s1", 99) is None
        assert engine.add_manual_checkpoint("s1", -1) is None
        assert engine.add_manual_checkpoint("missing", 0) is None
        assert engine.delete_checkpoint("s1", manual.id) is True
        assert engine.delete_checkpoint("s1", manual.id) is False

    def test_a_fork_gives_the_context_of_its_checkpoint(self, recorder, engine):
        _record(recorder)
        [checkpoint, *_] = engine.create_checkpoints_for_session("s1")
        fork = engine.create_fork(
            ForkRequest(
                checkpoint_id=checkpoint.id,
                session_id="s1",
                modified_prompt="Use sessions",
                fork_provider="ollama",
                fork_model="qwen",
            )
        )

        context = engine.get_fork_context(fork.fork_id)

        assert context["checkpoint_step_index"] == checkpoint.step_index
        assert (context["provider"], context["model"]) == ("ollama", "qwen")
        assert context["modified_prompt"] == "Use sessions"
        assert engine.update_fork_status(fork.fork_id, "running") is True
        assert engine.get_fork(fork.fork_id).status == "running"
        assert [f.fork_id for f in engine.list_forks("s1")] == [fork.fork_id]
        assert engine.list_forks("other") == []

        engine.delete_checkpoint("s1", checkpoint.id)
        assert engine.get_fork_context(fork.fork_id) is None
        assert engine.delete_fork(fork.fork_id) is True
        assert engine.delete_fork(fork.fork_id) is False
        assert engine.get_fork_context(fork.fork_id) is None
        assert engine.update_fork_status(fork.fork_id, "done") is False

    def test_unreadable_records_are_skipped(self, engine):
        (engine._forks_dir / "bad.json").write_text("{", encoding="utf-8")
        (engine._checkpoints_dir / "s1.json").write_text("[{", encoding="utf-8")

        assert engine.list_forks() == []
        assert engine.get_fork("bad") is None
        assert engine.get_checkpoints("s1") == []

    def test_the_shared_engine_lives_in_the_user_folder(self, tmp_path, monkeypatch):
        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        monkeypatch.setattr(time_travel_module, "_time_travel_engine", None)

        first = get_time_travel_engine()

        assert first is get_time_travel_engine()
        assert (tmp_path / ".workpilot" / "replays" / "time_travel" / "forks").is_dir()


@pytest.mark.parametrize(
    ("step", "role", "content"),
    [
        (
            ReplayStep(step_type=ReplayStepType.COMMAND_RUN, description="ls"),
            "assistant",
            "ls",
        ),
        (
            ReplayStep(step_type=ReplayStepType.COMMAND_OUTPUT, description="a.py"),
            "tool",
            "a.py",
        ),
        (
            ReplayStep(step_type=ReplayStepType.ERROR, description="boom"),
            "system",
            "Error: boom",
        ),
        (
            ReplayStep(step_type=ReplayStepType.TOOL_RESULT, tool_name="Read"),
            "tool",
            "",
        ),
        (
            ReplayStep(step_type=ReplayStepType.AGENT_THINKING, description="short"),
            "assistant_thinking",
            "short",
        ),
    ],
)
def test_each_step_becomes_a_message_any_provider_reads(step, role, content):
    message = _step_to_conversation_message(step)

    assert (message["role"], message["content"]) == (role, content)


def test_a_progress_step_is_not_part_of_the_conversation():
    assert (
        _step_to_conversation_message(ReplayStep(step_type=ReplayStepType.PROGRESS))
        is None
    )


class TestRoutes:
    def test_reading_a_saved_session(self, client, recorder):
        _record(recorder)

        assert client.get("/replay/sessions").json()["count"] == 1
        assert client.get("/replay/sessions/s1").json()["session"]["status"] == "failed"
        page = client.get("/replay/sessions/s1/steps?offset=1&limit=2").json()
        assert (page["total"], len(page["steps"])) == (19, 2)
        tests = client.get("/replay/sessions/s1/steps?step_type=test_result").json()
        assert tests["total"] == 2
        step = client.get("/replay/sessions/s1/step/1").json()["step"]
        assert step["step_type"] == "agent_thinking"
        assert client.get("/replay/sessions/s1/step/99").status_code == 404
        assert client.get("/replay/sessions/s1/step/-1").status_code == 404
        heatmap = client.get("/replay/sessions/s1/heatmap").json()
        assert (heatmap["total_files"], heatmap["max_touches"]) == (4, 1)
        tokens = client.get("/replay/sessions/s1/token-timeline").json()
        assert tokens["total_tokens"] == 1500 and len(tokens["timeline"]) == 1
        tools = client.get("/replay/sessions/s1/tool-stats").json()
        assert tools["tool_stats"] == {"Read": 2, "Bash": 1}
        assert client.get("/replay/sessions/s1/breakpoints").json()["breakpoints"] == []

    @pytest.mark.parametrize(
        "path",
        [
            "/replay/sessions/x",
            "/replay/sessions/x/steps",
            "/replay/sessions/x/step/0",
            "/replay/sessions/x/heatmap",
            "/replay/sessions/x/token-timeline",
            "/replay/sessions/x/tool-stats",
            "/replay/sessions/x/breakpoints",
            "/replay/sessions/x/checkpoints/c1",
            "/replay/sessions/x/decisions/heatmap",
            "/replay/forks/f1",
            "/replay/forks/f1/context",
        ],
    )
    def test_what_does_not_exist_is_a_404(self, client, path):
        assert client.get(path).status_code == 404

    @pytest.mark.parametrize(
        ("method", "path"),
        [
            ("delete", "/replay/sessions/x"),
            ("post", "/replay/sessions/x/checkpoints/generate"),
            ("delete", "/replay/sessions/x/checkpoints/c1"),
            ("delete", "/replay/sessions/x/breakpoints/b1"),
            ("post", "/replay/sessions/x/decisions/score"),
            ("delete", "/replay/forks/f1"),
            ("patch", "/replay/forks/f1/status?status=done"),
        ],
    )
    def test_acting_on_what_does_not_exist_is_a_404(self, client, method, path):
        assert client.request(method, path).status_code == 404

    def test_breakpoints_on_a_running_session(self, client, recorder):
        recorder.start_session("live", {})

        made = client.post(
            "/replay/sessions/live/breakpoints",
            json={"breakpoint_type": "tool_call", "condition": "Bash"},
        )
        bp = made.json()["breakpoint"]

        assert bp["breakpoint_type"] == "tool_call"
        assert client.delete(
            f"/replay/sessions/live/breakpoints/{bp['id']}"
        ).json() == {"success": True}
        unknown = client.post(
            "/replay/sessions/live/breakpoints", json={"breakpoint_type": "whenever"}
        )
        assert unknown.status_code == 422
        saved_only = client.post(
            "/replay/sessions/gone/breakpoints", json={"breakpoint_type": "error"}
        )
        assert saved_only.status_code == 404

    def test_comparing_two_sessions(self, client, recorder):
        _record(recorder, "a")
        recorder.start_session("b", {})
        recorder.record_tool_call("b", "Grep")
        recorder.record_file_change("b", "src/app.py", after_content="z")
        recorder.end_session("b")

        result = client.post(
            "/replay/compare", json={"session_a_id": "a", "session_b_id": "b"}
        ).json()

        comparison = result["comparison"]
        assert (comparison["session_a_id"], comparison["session_b_id"]) == ("a", "b")
        assert comparison["common_files"] == ["src/app.py"]
        assert comparison["unique_tools_b"] == ["Grep"]
        assert comparison["tool_calls_diff"] == 0
        assert result["session_b"]["session_id"] == "b"
        for a_id, b_id, who in (("x", "b", "A"), ("a", "x", "B")):
            missing = client.post(
                "/replay/compare", json={"session_a_id": a_id, "session_b_id": b_id}
            )
            assert missing.status_code == 404
            assert missing.json()["detail"] == f"Session {who} not found: x"

    def test_deleting_sessions(self, client, recorder):
        _record(recorder, "a")
        _record(recorder, "b")

        assert client.delete("/replay/sessions/a").json() == {"success": True}
        bulk = client.post(
            "/replay/sessions/bulk-delete", json={"session_ids": ["a", "b"]}
        )
        assert bulk.json()["deleted"] == 1

    def test_time_travel_through_the_routes(self, client, recorder):
        _record(recorder)

        generated = client.post("/replay/sessions/s1/checkpoints/generate").json()
        assert generated["count"] == 5
        listed = client.get("/replay/sessions/s1/checkpoints").json()
        first = listed["checkpoints"][0]["id"]
        one = client.get(f"/replay/sessions/s1/checkpoints/{first}").json()
        assert one["checkpoint"]["checkpoint_type"] == "auto_decision"
        manual = client.post(
            "/replay/sessions/s1/checkpoints", json={"step_index": 1, "label": "here"}
        ).json()["checkpoint"]
        assert manual["label"] == "here"
        assert (
            client.post(
                "/replay/sessions/s1/checkpoints", json={"step_index": 99}
            ).status_code
            == 404
        )
        assert client.delete(
            f"/replay/sessions/s1/checkpoints/{manual['id']}"
        ).json() == {"success": True}

        fork = client.post(
            "/replay/sessions/s1/fork",
            json={"checkpoint_id": first, "fork_provider": "openai", "fork_model": "m"},
        ).json()["fork"]
        assert (
            client.post(
                "/replay/sessions/s1/fork", json={"checkpoint_id": "nope"}
            ).status_code
            == 404
        )
        fork_id = fork["fork_id"]
        assert client.get("/replay/forks?session_id=s1").json()["count"] == 1
        assert (
            client.get(f"/replay/forks/{fork_id}").json()["fork"]["status"] == "pending"
        )
        context = client.get(f"/replay/forks/{fork_id}/context").json()["context"]
        assert context["provider"] == "openai"
        assert client.patch(f"/replay/forks/{fork_id}/status?status=done").json() == {
            "success": True
        }
        assert client.delete(f"/replay/forks/{fork_id}").json() == {"success": True}

        scored = client.post("/replay/sessions/s1/decisions/score").json()
        assert (scored["count"], scored["critical_count"]) == (1, 1)
        assert client.get("/replay/sessions/s1/decisions/scores").json()["count"] == 1
        heatmap = client.get("/replay/sessions/s1/decisions/heatmap").json()["heatmap"]
        assert heatmap["decision_count"] == 1

    def test_a_breakpoint_type_the_request_accepts_is_one_the_recorder_knows(self):
        field = replay_api.AddBreakpointRequest.model_fields["breakpoint_type"]

        assert field.annotation is BreakpointType


def test_stored_records_are_plain_json(recorder, engine):
    _record(recorder)
    engine.create_checkpoints_for_session("s1")

    stored = json.loads(
        (engine._checkpoints_dir / "s1.json").read_text(encoding="utf-8")
    )

    assert stored[0]["session_id"] == "s1"
