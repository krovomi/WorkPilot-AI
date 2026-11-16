"""The WorkPilot tools an agent calls: subtask status, build progress, QA
sign-off and project memory.

Each tool is the SDK tool ``create_all_tools`` serves to the agent; its handler
is called with the arguments a model would send, against a real
``implementation_plan.json`` and a real vault.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from agents.tools_pkg.registry import create_all_tools, create_auto_claude_mcp_server


@pytest.fixture
def spec(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(tmp_path / "vault"))
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    spec_dir = tmp_path / "shop" / ".workpilot" / "specs" / "001-login"
    spec_dir.mkdir(parents=True)
    return spec_dir


def _call(spec: Path, name: str, **args: Any) -> str:
    tools = {t.name: t for t in create_all_tools(spec, spec.parents[2])}
    answer = asyncio.run(tools[name].handler(args))
    [block] = answer["content"]
    return block["text"]


def _plan_file(spec: Path) -> Path:
    return spec / "implementation_plan.json"


def _write_plan(spec: Path, plan: object) -> None:
    _plan_file(spec).write_text(json.dumps(plan), encoding="utf-8")


def _read_plan(spec: Path) -> dict:
    return json.loads(_plan_file(spec).read_text(encoding="utf-8"))


PLAN = {
    "feature": "login",
    "phases": [
        {
            "id": "p1",
            "name": "Backend",
            "subtasks": [
                {"id": "1.1", "description": "session API", "status": "completed"},
                {"id": "1.2", "description": "password check", "status": "pending"},
            ],
        },
        {
            "phase": "p2",
            "subtasks": [
                {"id": "2.1", "description": "login form", "status": "in_progress"},
                {"id": "2.2", "description": "error page", "status": "failed"},
            ],
        },
    ],
}


def test_the_agent_is_served_every_tool(spec: Path) -> None:
    names = [t.name for t in create_all_tools(spec, spec.parents[2])]

    assert names == [
        "update_subtask_status",
        "get_build_progress",
        "record_discovery",
        "record_gotcha",
        "get_session_context",
        "update_qa_status",
    ]
    server = create_auto_claude_mcp_server(spec, spec.parents[2])
    assert server["name"] == "workpilot"


# -- update_subtask_status ---------------------------------------------------------


def test_a_subtask_status_is_written_to_the_plan(spec: Path) -> None:
    _write_plan(spec, PLAN)

    text = _call(
        spec, "update_subtask_status", subtask_id="2.1", status="completed", notes="ok"
    )

    assert text == "Successfully updated subtask '2.1' to status 'completed'"
    plan = _read_plan(spec)
    subtask = plan["phases"][1]["subtasks"][0]
    assert (subtask["status"], subtask["notes"]) == ("completed", "ok")
    assert "updated_at" in subtask and "last_updated" in plan
    # The other subtasks are left as they were, without notes.
    assert plan["phases"][0]["subtasks"][1] == PLAN["phases"][0]["subtasks"][1]


@pytest.mark.parametrize(
    ("args", "error"),
    [
        (
            {"subtask_id": "1.2", "status": "done"},
            "Error: Invalid status 'done'. Must be one of: "
            "['pending', 'in_progress', 'completed', 'failed']",
        ),
        (
            {"subtask_id": "9.9", "status": "completed"},
            "Error: Subtask '9.9' not found in implementation plan",
        ),
    ],
)
def test_a_subtask_update_the_plan_cannot_take_is_refused(
    spec: Path, args: dict, error: str
) -> None:
    _write_plan(spec, PLAN)

    assert _call(spec, "update_subtask_status", **args) == error
    assert _read_plan(spec) == PLAN


def test_a_subtask_update_without_a_plan_says_so(spec: Path) -> None:
    text = _call(spec, "update_subtask_status", subtask_id="1", status="pending")

    assert text == "Error: implementation_plan.json not found"


def test_a_fenced_plan_is_repaired_before_the_subtask_is_updated(spec: Path) -> None:
    _plan_file(spec).write_text(
        "Here is the plan:\n```json\n" + json.dumps(PLAN) + "\n```\n",
        encoding="utf-8",
    )

    text = _call(spec, "update_subtask_status", subtask_id="1.2", status="in_progress")
    missing = _call(spec, "update_subtask_status", subtask_id="9.9", status="pending")

    assert text == (
        "Successfully updated subtask '1.2' to status 'in_progress' (after auto-fix)"
    )
    assert _read_plan(spec)["phases"][0]["subtasks"][1]["status"] == "in_progress"
    assert missing == "Error: Subtask '9.9' not found in implementation plan"


def test_a_fenced_plan_without_the_subtask_says_so_after_the_repair(
    spec: Path,
) -> None:
    _plan_file(spec).write_text(
        "```json\n" + json.dumps(PLAN) + "\n```", encoding="utf-8"
    )

    text = _call(spec, "update_subtask_status", subtask_id="9.9", status="pending")

    assert text == (
        "Error: Subtask '9.9' not found in implementation plan (after auto-fix)"
    )


def test_a_plan_that_cannot_be_repaired_is_left_alone(spec: Path) -> None:
    _plan_file(spec).write_text("the planner crashed", encoding="utf-8")

    text = _call(spec, "update_subtask_status", subtask_id="1", status="pending")

    assert text.startswith("Error: Invalid JSON in implementation_plan.json: ")
    assert _plan_file(spec).read_text(encoding="utf-8") == "the planner crashed"


def test_a_plan_that_is_not_an_object_is_an_error(spec: Path) -> None:
    _write_plan(spec, ["1.1"])

    text = _call(spec, "update_subtask_status", subtask_id="1.1", status="pending")

    assert text.startswith("Error updating subtask status: ")


# -- get_build_progress ------------------------------------------------------------


def test_the_progress_counts_each_status_and_names_the_next_subtask(
    spec: Path,
) -> None:
    _write_plan(spec, PLAN)

    text = _call(spec, "get_build_progress")

    assert text == (
        "Build Progress: 1/4 subtasks (25%)\n\n"
        "Status breakdown:\n"
        "  Completed: 1\n  In Progress: 1\n  Pending: 1\n  Failed: 1\n\n"
        "Phases:\n  Backend: 1/2\n  p2: 0/2\n\n"
        "Next subtask to work on:\n"
        "  ID: 1.2\n  Phase: Backend\n  Description: password check"
    )


def test_a_finished_plan_is_ready_for_qa(spec: Path) -> None:
    _write_plan(
        spec,
        {
            "phases": [
                {"name": "Only", "subtasks": [{"id": "1", "status": "completed"}]}
            ]
        },
    )

    text = _call(spec, "get_build_progress")

    assert text.startswith("Build Progress: 1/1 subtasks (100%)")
    assert text.endswith("All subtasks completed! Build is ready for QA.")


def test_progress_without_a_plan_or_with_a_broken_one(spec: Path) -> None:
    assert _call(spec, "get_build_progress") == (
        "No implementation plan found. Run the planner first."
    )

    _write_plan(spec, {"phases": []})
    assert _call(spec, "get_build_progress").startswith(
        "Build Progress: 0/0 subtasks (0%)"
    )

    _plan_file(spec).write_text("{", encoding="utf-8")
    assert _call(spec, "get_build_progress").startswith(
        "Error reading build progress: "
    )


# -- update_qa_status --------------------------------------------------------------


def test_a_rejection_opens_a_new_qa_session_with_its_issues(spec: Path) -> None:
    _write_plan(spec, PLAN)

    text = _call(
        spec,
        "update_qa_status",
        status="rejected",
        issues=json.dumps([{"title": "no rate limit"}]),
        tests_passed=json.dumps({"unit": True}),
        coverage=json.dumps({"unit": 91}),
    )

    assert text == "Updated QA status to 'rejected' (session 1)"
    signoff = _read_plan(spec)["qa_signoff"]
    assert signoff["issues_found"] == [{"title": "no rate limit"}]
    assert signoff["tests_passed"] == {"unit": True}
    assert signoff["coverage"] == {"unit": 91}
    assert signoff["ready_for_qa_revalidation"] is False
    # The QA tool never decides the task's status: the app's state machine does.
    assert "status" not in _read_plan(spec)

    fixed = _call(spec, "update_qa_status", status="fixes_applied")
    assert fixed == "Updated QA status to 'fixes_applied' (session 1)"
    assert _read_plan(spec)["qa_signoff"]["ready_for_qa_revalidation"] is True

    again = _call(spec, "update_qa_status", status="in_review")
    assert again == "Updated QA status to 'in_review' (session 2)"


def test_qa_arguments_that_are_not_json_are_kept_as_text_or_dropped(
    spec: Path,
) -> None:
    _write_plan(spec, PLAN)

    _call(
        spec,
        "update_qa_status",
        status="rejected",
        issues="the login button does nothing",
        tests_passed="all green",
        coverage="ninety",
    )
    signoff = _read_plan(spec)["qa_signoff"]
    assert signoff["issues_found"] == [{"description": "the login button does nothing"}]
    assert (signoff["tests_passed"], signoff["coverage"]) == ({}, {})

    _call(spec, "update_qa_status", status="approved", issues="", coverage="[1]")
    signoff = _read_plan(spec)["qa_signoff"]
    assert (signoff["issues_found"], signoff["coverage"]) == ([], {})


def test_a_qa_update_the_plan_cannot_take_is_refused(spec: Path) -> None:
    assert _call(spec, "update_qa_status", status="approved") == (
        "Error: implementation_plan.json not found"
    )
    _write_plan(spec, PLAN)
    assert _call(spec, "update_qa_status", status="great") == (
        "Error: Invalid QA status 'great'. Must be one of: "
        "['pending', 'in_review', 'approved', 'rejected', 'fixes_applied']"
    )
    assert "qa_signoff" not in _read_plan(spec)


def test_a_fenced_plan_is_repaired_before_the_qa_sign_off(spec: Path) -> None:
    _plan_file(spec).write_text(
        "```json\n" + json.dumps(PLAN) + "\n```", encoding="utf-8"
    )

    text = _call(spec, "update_qa_status", status="approved")

    assert text == "Updated QA status to 'approved' (session 0) (after auto-fix)"
    assert _read_plan(spec)["qa_signoff"]["status"] == "approved"


def test_a_qa_sign_off_on_a_broken_plan_is_an_error(spec: Path) -> None:
    _plan_file(spec).write_text("the planner crashed", encoding="utf-8")
    assert _call(spec, "update_qa_status", status="approved").startswith(
        "Error: Invalid JSON in implementation_plan.json: "
    )

    _write_plan(spec, ["not", "a", "plan"])
    assert _call(spec, "update_qa_status", status="approved").startswith(
        "Error updating QA status: "
    )


# -- project memory ----------------------------------------------------------------


def test_what_a_session_records_is_what_the_next_one_reads(spec: Path) -> None:
    assert _call(spec, "get_session_context") == (
        "No project memory yet. This appears to be the first session."
    )

    assert _call(
        spec,
        "record_discovery",
        file_path="src/auth/session.ts",
        description="issues the session cookie",
        category="auth",
    ) == ("Recorded discovery for 'src/auth/session.ts': issues the session cookie")
    assert _call(
        spec, "record_gotcha", gotcha="cookies need SameSite=Lax", context="login"
    ) == ("Recorded gotcha: cookies need SameSite=Lax")

    context = _call(spec, "get_session_context")

    assert "## Codebase Discoveries" in context
    assert "- `src/auth/session.ts`: issues the session cookie" in context
    assert "## Gotchas" in context
    assert "cookies need SameSite=Lax" in context


def test_an_empty_note_is_not_recorded(spec: Path) -> None:
    assert _call(spec, "record_discovery", file_path=" ", description="x") == (
        "Error recording discovery for ' '"
    )
    assert _call(spec, "record_gotcha", gotcha="  ") == "Error recording gotcha"


def test_memory_turned_off_records_and_reads_nothing(
    spec: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("BRAIN_ENABLED", "false")
    off = "Memory is turned off (BRAIN_ENABLED=false): nothing was recorded."

    assert _call(spec, "record_discovery", file_path="a.py", description="x") == off
    assert _call(spec, "record_gotcha", gotcha="g") == off
    assert _call(spec, "get_session_context") == off
    assert not (spec.parents[3] / "vault").exists()
