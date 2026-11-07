"""A blocked subtask says why, and a person can unblock it.

A verification subtask ("test.txt contains 'OK'") ended blocked with no
reason: the coder prompt told the agent to block every verification that was
not a command, an API call, a browser check or an E2E scenario (``none``
included), and to write the reason in ``_blocked_reason``, a field the app
never read. These tests hold the fix, for every provider (the prompt and the
loop are the same for all of them) and every stack:

- the agent runs a check itself whenever its tools can, and blocks only what
  needs a person, with ``blocked_reason`` the panel shows;
- a ``none`` verification never asks for a block;
- the loop never turns a subtask the agent completed into a block;
- the panel's answers (done, not needed, retry, reply) apply to the plan, and
  a subtask a person sent back runs again with its count reset and the reply
  in its prompt.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND = REPO_ROOT / "apps" / "backend"
sys.path.insert(0, str(BACKEND))

from agents.manual_verification import (  # noqa: E402
    settle_block,
    skip_manual_verification,
    take_human_unblock,
)
from foundation.subtask_unblock import (  # noqa: E402
    apply_unblock,
    block,
    blocked_reason,
    normalize_block,
)
from prompts_pkg.prompt_generator import generate_subtask_prompt  # noqa: E402
from services.recovery import RecoveryManager  # noqa: E402


def _plan(*subtasks: dict) -> dict:
    return {
        "status": "human_review",
        "planStatus": "review",
        "qa_signoff": {"status": "approved"},
        "phases": [{"id": "1", "name": "Implementation", "subtasks": list(subtasks)}],
    }


def _write(spec: Path, plan: dict) -> None:
    spec.mkdir(parents=True, exist_ok=True)
    (spec / "implementation_plan.json").write_text(json.dumps(plan), encoding="utf-8")


def _read(spec: Path) -> dict:
    return json.loads((spec / "implementation_plan.json").read_text(encoding="utf-8"))


# --- foundation.subtask_unblock -------------------------------------------


def test_done_and_not_needed_close_the_subtask_and_keep_the_reason():
    for action in ("complete", "skip"):
        plan = _plan({"id": "v", "status": "blocked", "_blocked_reason": "Check it"})
        subtask = apply_unblock(plan, "v", action, now="T")
        assert subtask["status"] == "completed"
        assert subtask["human_resolution"] == {
            "action": action,
            "at": "T",
            "reason": "Check it",
        }
        assert "_blocked_reason" not in subtask
        assert plan["status"] == "human_review"  # nothing to run again


def test_retry_and_reply_send_it_back_and_reopen_the_plan():
    plan = _plan({"id": "v", "status": "failed", "blocked_kind": "max_attempts"})
    subtask = apply_unblock(plan, "v", "answer", "  The file is in src/  ", now="T")
    assert subtask["status"] == "pending"
    assert subtask["human_reply"] == "The file is in src/"
    assert subtask["unblocked_at"] == "T" and "blocked_kind" not in subtask
    assert plan["status"] == "in_progress" and plan["planStatus"] == "in_progress"
    assert plan["qa_signoff"]["status"] == "pending"

    plan = _plan({"id": "v", "status": "blocked"})
    assert apply_unblock(plan, "v", "retry", now="T")["status"] == "pending"


@pytest.mark.parametrize(
    ("action", "reply", "subtask_id", "status", "code"),
    [
        ("delete", None, "v", "blocked", "invalid_action"),
        ("answer", "  ", "v", "blocked", "reply_required"),
        ("answer", "x" * 4001, "v", "blocked", "reply_too_long"),
        ("complete", None, "nope", "blocked", "subtask_not_found"),
        ("complete", None, "v", "completed", "not_blocked"),
    ],
)
def test_an_answer_that_cannot_apply_is_refused(
    action, reply, subtask_id, status, code
):
    plan = _plan({"id": "v", "status": status})
    with pytest.raises(ValueError, match=code):
        apply_unblock(plan, subtask_id, action, reply)


def test_a_block_is_written_where_the_app_reads_it():
    subtask = {"id": "v", "status": "pending"}
    block(subtask, "Plug in the device", "nonsense")
    assert subtask == {
        "id": "v",
        "status": "blocked",
        "blocked_reason": "Plug in the device",
        "blocked_kind": "agent",
    }
    legacy = {"id": "v", "status": "blocked", "_blocked_reason": "Old prompt"}
    assert normalize_block(legacy) is True
    assert legacy["blocked_reason"] == "Old prompt"
    assert legacy["blocked_kind"] == "needs_human"
    assert blocked_reason(legacy) == "Old prompt"
    assert normalize_block(legacy) is False


# --- the coder prompt ------------------------------------------------------


@pytest.fixture
def _prompt(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTO_TEST_GENERATION", "false")
    monkeypatch.delenv("TDD_MODE", raising=False)
    monkeypatch.setattr(
        "learning_loop.prompt_injection.get_learning_context",
        lambda *_a, **_k: "",
        raising=False,
    )
    spec = tmp_path / ".workpilot" / "specs" / "001-task"
    spec.mkdir(parents=True)

    def render(subtask: dict) -> str:
        return generate_subtask_prompt(
            spec, tmp_path, subtask, {"id": "1", "name": "V"}
        )

    return render


@pytest.mark.parametrize(
    "verification",
    [
        {"type": "manual", "instructions": "Check test.txt contains 'OK'"},
        {"type": "component"},
        {"run": "cat test.txt"},
    ],
)
def test_a_check_is_run_by_the_agent_and_blocked_only_when_a_person_is_needed(
    _prompt, verification
):
    text = _prompt(
        {"id": "v", "description": "Verify test.txt", "verification": verification}
    )
    assert "Run this check yourself" in text
    assert '"blocked_reason"' in text
    assert "_blocked_reason" not in text
    assert "You CANNOT automate it" not in text
    assert "Visual Studio" not in text


def test_a_subtask_without_verification_is_never_told_to_block(_prompt):
    text = _prompt(
        {"id": "v", "description": "Write the notes", "verification": {"type": "none"}}
    )
    assert "blocked" not in text.split("## Verification", 1)[1].split("##", 1)[0]


def test_the_persons_reply_reaches_the_prompt(_prompt):
    text = _prompt(
        {
            "id": "v",
            "description": "Verify test.txt",
            "verification": {"type": "command", "command": "cat test.txt"},
            "human_reply": "It is in docs/\nnot at the root",
            "unblocked_at": "T",
        }
    )
    assert "## Reply from the person" in text
    assert "> It is in docs/\n> not at the root" in text
    retry = _prompt({"id": "v", "description": "x", "unblocked_at": "T"})
    assert "## Sent back by the person" in retry


# --- the coder loop --------------------------------------------------------


def test_a_completed_manual_check_is_not_turned_into_a_block(tmp_path):
    spec = tmp_path / "spec"
    done = {"id": "v", "status": "completed", "verification": {"type": "manual"}}
    plan = _plan(done)
    _write(spec, plan)
    assert settle_block(spec, plan, done, new_commits=0) == "completed"
    assert _read(spec)["phases"][0]["subtasks"][0]["status"] == "completed"


def test_an_open_manual_check_is_blocked_with_a_reason(tmp_path):
    spec = tmp_path / "spec"
    open_check = {
        "id": "v",
        "status": "in_progress",
        "verification": {"type": "manual"},
    }
    plan = _plan(open_check)
    _write(spec, plan)
    assert settle_block(spec, plan, open_check, new_commits=0) == "blocked"
    saved = _read(spec)["phases"][0]["subtasks"][0]
    assert saved["blocked_kind"] == "manual_verification"
    assert "check it yourself" in saved["blocked_reason"]


def test_an_agents_own_block_gets_a_readable_reason(tmp_path):
    spec = tmp_path / "spec"
    agent_block = {"id": "v", "status": "blocked", "_blocked_reason": "Needs a phone"}
    plan = _plan(agent_block)
    _write(spec, plan)
    assert settle_block(spec, plan, agent_block, new_commits=1) == "blocked"
    assert _read(spec)["phases"][0]["subtasks"][0]["blocked_reason"] == "Needs a phone"


def test_a_manual_check_is_skipped_unless_a_person_sent_it_back(tmp_path):
    spec = tmp_path / "spec"
    manual = {"id": "v", "status": "pending", "verification": {"type": "manual"}}
    _write(spec, _plan(dict(manual)))
    assert skip_manual_verification(spec, "v", manual, None) is True
    assert _read(spec)["phases"][0]["subtasks"][0]["status"] == "completed"

    sent_back = {**manual, "unblocked_at": "T"}
    _write(spec, _plan(dict(sent_back)))
    assert skip_manual_verification(spec, "v", sent_back, None) is False
    assert _read(spec)["phases"][0]["subtasks"][0]["status"] == "pending"


def test_a_subtask_sent_back_starts_its_attempt_count_over_once(tmp_path):
    spec = tmp_path / "spec"
    _write(spec, _plan({"id": "v", "status": "pending", "unblocked_at": "T"}))
    recovery = RecoveryManager(spec, tmp_path)
    for n in range(3):
        recovery.record_attempt("v", n, False, f"approach {n}", "boom")
    recovery.mark_subtask_stuck("v", "Failed after 3 attempts")
    _write(spec, _plan({"id": "v", "status": "pending", "unblocked_at": "T"}))

    assert take_human_unblock(spec, "v", recovery) is True
    assert recovery.get_attempt_count("v") == 0
    assert recovery.get_stuck_subtasks() == []
    recovery.record_attempt("v", 4, False, "again", "boom")
    assert take_human_unblock(spec, "v", recovery) is False  # same answer
    assert recovery.get_attempt_count("v") == 1


def test_a_stuck_subtask_says_why_in_the_plan(tmp_path):
    spec = tmp_path / "spec"
    _write(spec, _plan({"id": "v", "status": "pending"}))
    RecoveryManager(spec, tmp_path).mark_subtask_stuck(
        "v", "File validation failed", kind="file_validation"
    )
    saved = _read(spec)["phases"][0]["subtasks"][0]
    assert saved["status"] == "blocked"
    assert saved["blocked_reason"] == "File validation failed"
    assert saved["blocked_kind"] == "file_validation"
