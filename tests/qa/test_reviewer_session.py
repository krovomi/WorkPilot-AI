"""A QA reviewer pass from the prompt it sends to the verdict it returns.

The scripted client stands for the model: while it streams, it edits the
plan the way a reviewer does (`on_stream`), and the real prompt builders,
plan readers, report renderer, memory and replay store do the rest.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from foundation.change_scope import ChangeScope
from qa import reviewer
from qa.reviewer import (
    QA_ERROR_INVALID_PLAN,
    QA_ERROR_NO_SIGNOFF,
    QA_ERROR_SIGNOFF_WRITE,
    _plan_json_error,
    _programmatic_qa_signoff,
    _read_plan_text,
    _restore_plan,
    _verdict_from_session_reports,
    _what_went_wrong,
    classify_qa_error,
    run_qa_agent_session,
)


def _plan(spec: Path) -> dict:
    return json.loads((spec / "implementation_plan.json").read_text(encoding="utf-8"))


def _signoff(spec: Path, **signoff) -> None:
    plan = _plan(spec)
    plan["qa_signoff"] = signoff
    (spec / "implementation_plan.json").write_text(json.dumps(plan), encoding="utf-8")


@pytest.fixture
def qa_results(monkeypatch) -> list[tuple]:
    """The dashboard's QA pass/fail counter, as the reviewer feeds it."""
    calls: list[tuple] = []
    monkeypatch.setattr(
        reviewer,
        "_ut_record_qa",
        lambda project, spec_id, passed, score: calls.append((spec_id, passed, score)),
    )
    return calls


async def _review(client, spec, **kwargs):
    return await run_qa_agent_session(
        client, spec.parents[2], spec, qa_session=2, max_iterations=5, **kwargs
    )


async def test_an_approval_written_in_the_plan_is_the_verdict(
    qa_kit, qa_spec, replays, read_replays, qa_results
):
    client = qa_kit.Client(
        [qa_kit.say("All criteria met."), qa_kit.tool("Bash", command="npm test")],
        on_stream=lambda: _signoff(qa_spec, status="approved", qa_session=2),
    )
    commands: list[str] = []

    status, text = await _review(client, qa_spec, commands_seen=commands)

    assert (status, text) == ("approved", "All criteria met.")
    assert commands == ["npm test"]
    assert qa_results == [("001-login", True, 100.0)]
    report = (qa_spec / "qa_report.md").read_text(encoding="utf-8")
    assert "**SIGN-OFF**: APPROVED" in report
    [prompt] = client.prompts
    assert "**QA Session**: 2" in prompt and "**Max Iterations**: 5" in prompt
    assert read_replays(replays)[0]["agent_role"] == "qa_reviewer"


async def test_a_rejection_keeps_its_issues_as_gotchas(
    qa_kit, qa_spec, replays, qa_results, monkeypatch
):
    saved: list[dict] = []

    async def save_session_memory(**kwargs):
        saved.append(kwargs)

    monkeypatch.setattr(reviewer, "save_session_memory", save_session_memory)
    issues = [
        {"type": "critical", "title": "No CSRF token", "location": "form.ts:3"},
        {},
    ]
    client = qa_kit.Client(
        [qa_kit.say("Two issues.")],
        on_stream=lambda: _signoff(qa_spec, status="rejected", issues_found=issues),
    )

    status, _ = await _review(client, qa_spec)

    assert status == "rejected"
    assert qa_results == [("001-login", False, 0.0)]
    [memory] = saved
    assert memory["success"] is False
    assert memory["discoveries"]["gotchas_encountered"] == [
        "QA Issue (critical): No CSRF token at form.ts:3",
        "QA Issue (unknown): No title at unknown",
    ]


async def test_a_status_the_loop_does_not_know_goes_to_a_person(
    qa_kit, qa_spec, replays
):
    client = qa_kit.Client(
        [qa_kit.say("Cannot decide.")],
        on_stream=lambda: _signoff(qa_spec, status="needs_human"),
    )

    assert (await _review(client, qa_spec))[0] == "human_escalation"


async def test_a_verdict_stated_but_not_written_is_written_for_the_reviewer(
    qa_kit, qa_spec, replays, qa_results
):
    client = qa_kit.Client([qa_kit.say("**SIGN-OFF**: REJECTED")])

    status, _ = await _review(client, qa_spec)

    assert status == "rejected"
    assert _plan(qa_spec)["qa_signoff"]["fix_request_file"] == "QA_FIX_REQUEST.md"
    assert "**SIGN-OFF**: REJECTED" in (qa_spec / "qa_report.md").read_text(
        encoding="utf-8"
    )


async def test_a_stated_verdict_with_no_plan_to_write_into_is_an_error(
    qa_kit, qa_spec, replays
):
    (qa_spec / "implementation_plan.json").unlink()
    client = qa_kit.Client([qa_kit.say("Verdict: APPROVED")])

    assert await _review(client, qa_spec) == ("error", QA_ERROR_SIGNOFF_WRITE)


async def test_a_broken_plan_with_a_verdict_it_cannot_record_says_why(
    qa_kit, qa_spec, replays
):
    def break_plan():
        (qa_spec / "implementation_plan.json").write_text("{ broken", encoding="utf-8")

    # No copy from before to restore: the session started on a broken plan.
    break_plan()
    client = qa_kit.Client([qa_kit.say("Status: APPROVED")], on_stream=break_plan)

    status, message = await _review(client, qa_spec)

    assert status == "error"
    assert message.startswith(QA_ERROR_INVALID_PLAN)


async def test_a_silent_session_lists_what_was_missing(qa_kit, qa_spec, replays):
    status, message = await _review(qa_kit.Client([]), qa_spec)

    assert status == "error"
    assert message == (
        f"{QA_ERROR_NO_SIGNOFF} (No messages received from agent; "
        "No tools were used by agent; Agent produced no output)"
    )


async def test_a_session_that_talked_and_used_tools_but_wrote_nothing(
    qa_kit, qa_spec, replays
):
    client = qa_kit.Client(
        [qa_kit.say("Looked around."), qa_kit.tool("Read", file_path="a")]
    )

    assert await _review(client, qa_spec) == ("error", QA_ERROR_NO_SIGNOFF)


async def test_a_provider_error_is_a_session_error_not_a_missing_update(
    qa_kit, qa_spec, replays
):
    # Regression: the live (AgentClient) path dropped the provider's error,
    # and the next pass was told it had not updated the plan.
    client = qa_kit.Client([qa_kit.say("Half")], result_error="Rate limit reached")

    status, message = await _review(client, qa_spec)

    assert (status, message) == ("error", "Agent session error: Rate limit reached")
    assert classify_qa_error(message) == "session_error"


async def test_a_crash_is_an_error_and_is_logged(qa_kit, qa_spec, replays):
    from task_logger import load_task_logs

    client = qa_kit.Client([], fail=ConnectionError("socket closed"))

    assert await _review(client, qa_spec) == ("error", "socket closed")
    entries = load_task_logs(qa_spec)["phases"]["validation"]["entries"]
    assert entries[-1]["content"] == "QA session error: socket closed"


async def test_a_crash_without_a_task_log_is_still_an_error(
    qa_kit, qa_spec, replays, monkeypatch
):
    monkeypatch.setattr(reviewer, "get_task_logger", lambda spec: None)

    client = qa_kit.Client([], fail=ConnectionError("gone"))

    assert await _review(client, qa_spec) == ("error", "gone")


class TestPrompt:
    async def _prompt(self, qa_kit, spec, **kwargs) -> str:
        client = qa_kit.Client([])
        await _review(client, spec, **kwargs)
        return client.prompts[0]

    @pytest.mark.parametrize(
        ("level", "marker"),
        [("light", "light"), ("targeted", "targeted"), ("full", None)],
    )
    async def test_the_scope_picks_the_prompt(
        self, qa_kit, qa_spec, replays, monkeypatch, level, marker
    ):
        monkeypatch.setattr(
            reviewer, "get_qa_reviewer_light_prompt", lambda *a: "PROMPT light"
        )
        monkeypatch.setattr(
            reviewer, "get_qa_reviewer_targeted_prompt", lambda *a: "PROMPT targeted"
        )
        monkeypatch.setattr(
            reviewer, "get_qa_reviewer_prompt", lambda *a: "PROMPT full"
        )
        memory_asked: list[bool] = []

        async def get_memory_context(*args):
            memory_asked.append(True)
            return "## Memory\nKnown gotcha."

        monkeypatch.setattr(reviewer, "get_memory_context", get_memory_context)
        scope = ChangeScope(level=level, reason="test")

        prompt = await self._prompt(qa_kit, qa_spec, review_scope=scope)

        assert prompt.startswith(f"PROMPT {marker or 'full'}")
        # A scoped review is about the changed code: no memory of the rest.
        assert bool(memory_asked) is (marker is None)
        assert ("Known gotcha." in prompt) is (marker is None)

    async def test_judge_advice_and_learned_patterns_are_added(
        self, qa_kit, qa_spec, replays, monkeypatch
    ):
        monkeypatch.setattr(
            "learning_loop.prompt_injection.get_learning_context",
            lambda project, phase, **kwargs: f"## Patterns for {phase}",
        )

        prompt = await self._prompt(qa_kit, qa_spec, jev_advice="## Judge advice")

        assert "## Judge advice" in prompt
        assert "## Patterns for qa_review" in prompt

    async def test_a_failing_pattern_lookup_leaves_the_prompt_valid(
        self, qa_kit, qa_spec, replays, monkeypatch
    ):
        def broken(project, phase, **kwargs):
            raise RuntimeError("no index")

        monkeypatch.setattr(
            "learning_loop.prompt_injection.get_learning_context", broken
        )

        prompt = await self._prompt(qa_kit, qa_spec)

        assert "**QA Session**: 2" in prompt

    @pytest.mark.parametrize(
        ("error_type", "phrase"),
        [
            ("invalid_implementation_plan_json", "left it as invalid JSON"),
            ("session_error", "ended on an error"),
            ("missing_implementation_plan_update", "did NOT update"),
        ],
    )
    async def test_the_previous_error_is_explained(
        self, qa_kit, qa_spec, replays, capsys, error_type, phrase
    ):
        previous = {
            "error_type": error_type,
            "error_message": "boom",
            "consecutive_errors": 2,
        }

        prompt = await self._prompt(qa_kit, qa_spec, previous_error=previous)

        assert "PREVIOUS ITERATION FAILED" in prompt
        assert "**Error**: boom" in prompt and "**Consecutive Failures**: 2" in prompt
        assert phrase in prompt
        assert "This is attempt 3." in prompt
        assert "attempt 3" in capsys.readouterr().out
        assert phrase in _what_went_wrong(error_type)


class TestPlanFiles:
    def test_the_plan_is_read_as_it_is_on_disk(self, qa_spec):
        assert json.loads(_read_plan_text(qa_spec))["feature"] == "login"
        (qa_spec / "implementation_plan.json").write_bytes(b"\xff\xfe")
        assert _read_plan_text(qa_spec) is None

    def test_a_missing_or_valid_plan_has_no_json_error(self, qa_spec, tmp_path):
        assert _plan_json_error(qa_spec) is None
        assert _plan_json_error(tmp_path) is None

    def test_an_undecodable_plan_has_an_error(self, qa_spec):
        (qa_spec / "implementation_plan.json").write_bytes(b"\xff\xfe{")

        assert _plan_json_error(qa_spec)

    def test_only_a_parsable_copy_is_restored(self, qa_spec):
        assert _restore_plan(qa_spec, None) is False
        assert _restore_plan(qa_spec, "{ no") is False
        assert _restore_plan(qa_spec, '{"feature": "back"}') is True
        assert _plan(qa_spec) == {"feature": "back"}

    def test_a_restore_that_cannot_write_fails(self, tmp_path):
        assert _restore_plan(tmp_path / "missing-dir", '{"a": 1}') is False

    def test_an_unknown_verdict_is_not_written(self, qa_spec):
        assert _programmatic_qa_signoff(qa_spec, "maybe", 1) is False
        assert "qa_signoff" not in _plan(qa_spec)

    def test_a_report_that_cannot_be_read_is_skipped(self, qa_spec):
        (qa_spec / "qa_report.md").mkdir()
        (qa_spec / "QA_FIX_REQUEST.md").write_text("Status: REJECTED", encoding="utf-8")

        assert _verdict_from_session_reports(qa_spec, time.time() - 60) == "rejected"

    def test_a_report_without_a_verdict_gives_none(self, qa_spec):
        (qa_spec / "qa_report.md").write_text("Notes only.", encoding="utf-8")

        assert _verdict_from_session_reports(qa_spec, 0.0) is None


@pytest.mark.parametrize(
    ("text", "verdict"),
    [
        ("=== QA VALIDATION COMPLETE ===\nAPPROVED ✓", "approved"),
        ("=== **QA VALIDATION COMPLETE** ===\nREJECTED ✗", "rejected"),
        ("QA validation complete, see the report.", None),
        ("APPROVED, but no banner.", None),
    ],
)
def test_the_closing_banner_is_read_when_no_status_line_says_it(text, verdict):
    assert reviewer._extract_verdict_from_response(text) == verdict


class TestSuitePlacement:
    """The full suite's placement (`test_placement`) as the reviewer reads it."""

    async def _prompt(self, qa_kit, spec, **kwargs) -> str:
        client = qa_kit.Client([])
        await _review(client, spec, **kwargs)
        return client.prompts[0]

    async def test_a_suite_moved_to_the_ci_is_said_in_the_prompt(
        self, qa_kit, qa_spec, replays, monkeypatch
    ):
        from test_placement.decide import GIB, Machine

        busy = Machine(
            cores=4, cpu_busy=99.0, ram_total=8 * GIB, ram_free=GIB, builds=2
        )
        monkeypatch.setattr("test_placement.machine.sample", lambda suites: busy)
        monkeypatch.delenv("WORKPILOT_TEST_PLACEMENT")
        monkeypatch.setenv("WORKPILOT_TEST_PLACEMENT_ROUTES", "ci")
        monkeypatch.setenv("TEST_PLACEMENT_ALLOW_BRANCH_PUSH", "true")

        prompt = await self._prompt(qa_kit, qa_spec)

        assert "WHERE THE LONG SUITES RUN FOR THIS TASK" in prompt
        decision = json.loads(
            (qa_spec / "test_placement.json").read_text(encoding="utf-8")
        )
        assert (decision["target"], decision["reason"]) == ("ci", "branch_push")

    async def test_a_suite_run_here_adds_nothing_and_is_measured(
        self, qa_kit, qa_spec, replays
    ):
        prompt = await self._prompt(qa_kit, qa_spec)

        assert "WHERE THE LONG SUITES RUN" not in prompt
        history = qa_spec.parents[2] / ".workpilot" / "test-placement" / "history.json"
        assert history.is_file()

    async def test_a_targeted_review_is_not_placed(self, qa_kit, qa_spec, replays):
        scope = ChangeScope(level="targeted", reason="test")

        await self._prompt(qa_kit, qa_spec, review_scope=scope)

        assert not (qa_spec / "test_placement.json").exists()
