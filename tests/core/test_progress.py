"""What the build loop reads from implementation_plan.json, and what it prints.

Each test writes a plan in a spec directory, as the planner does, and reads it
back through `core.progress`; the terminal lines are the ones the coder prints
between sessions (captured from stdout).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest
from core import progress
from core.progress import (
    count_subtasks,
    count_subtasks_detailed,
    get_current_phase,
    get_next_subtask,
    print_build_complete_banner,
    print_paused_banner,
    print_progress_summary,
    print_session_header,
    reopen_interrupted_subtasks,
)


def plan(spec_dir: Path, phases: list[dict] | object) -> Path:
    path = spec_dir / "implementation_plan.json"
    body = {"phases": phases} if isinstance(phases, list) else phases
    path.write_text(json.dumps(body), encoding="utf-8")
    return path


def subtask(sid: str, status: str, description: str = "") -> dict:
    return {"id": sid, "status": status, "description": description}


SHOP = [
    {
        "id": "p1",
        "name": "Backend",
        "subtasks": [subtask("1.1", "completed"), subtask("1.2", "completed")],
    },
    {
        "id": "p2",
        "name": "API",
        "depends_on": ["p1"],
        "subtasks": [subtask("2.1", "completed"), subtask("2.2", "pending")],
    },
    {
        "id": "p3",
        "name": "Frontend",
        "depends_on": ["p2"],
        "subtasks": [subtask("3.1", "pending", "x" * 80)],
    },
    {
        "id": "p4",
        "name": "Docs",
        "depends_on": ["p1"],
        "subtasks": [subtask("4.1", "pending")],
    },
    {"id": "p5", "name": "Review", "subtasks": [subtask("5.1", "in_progress")]},
]


class TestCounting:
    def test_the_detailed_count_puts_unknown_statuses_with_pending(self, tmp_path):
        plan(
            tmp_path,
            [
                {
                    "subtasks": [
                        subtask("a", "completed"),
                        subtask("b", "failed"),
                        subtask("c", "in_progress"),
                        {"id": "d"},
                        subtask("e", "waiting_for_review"),
                    ]
                }
            ],
        )

        assert count_subtasks_detailed(tmp_path) == {
            "completed": 1,
            "in_progress": 1,
            "pending": 2,
            "failed": 1,
            "total": 5,
        }

    @pytest.mark.parametrize("content", ["{", "[]"])
    def test_an_unreadable_plan_counts_nothing(self, tmp_path, content):
        (tmp_path / "implementation_plan.json").write_text(content, encoding="utf-8")

        assert count_subtasks(tmp_path) == (0, 0)

    def test_an_unreadable_plan_has_no_detailed_count(self, tmp_path):
        (tmp_path / "implementation_plan.json").write_text("{", encoding="utf-8")

        assert count_subtasks_detailed(tmp_path)["total"] == 0


class TestTheCurrentPhase:
    def test_it_is_the_first_phase_with_work_left(self, tmp_path):
        plan(tmp_path, SHOP)

        assert get_current_phase(tmp_path) == {
            "id": "p2",
            "phase": None,
            "name": "API",
            "completed": 1,
            "total": 2,
        }

    def test_an_old_plan_with_chunks_is_read_too(self, tmp_path):
        plan(tmp_path, [{"phase": 1, "chunks": [subtask("c1", "pending")]}])

        assert get_current_phase(tmp_path)["phase"] == 1

    def test_a_finished_plan_has_none(self, tmp_path):
        plan(tmp_path, SHOP[:1])

        assert get_current_phase(tmp_path) is None

    @pytest.mark.parametrize("content", [None, "{"])
    def test_a_missing_or_broken_plan_has_none(self, tmp_path, content):
        if content is not None:
            (tmp_path / "implementation_plan.json").write_text(
                content, encoding="utf-8"
            )

        assert get_current_phase(tmp_path) is None


class TestTheNextSubtask:
    def test_a_phase_waits_for_the_phase_it_depends_on(self, tmp_path):
        plan(tmp_path, SHOP)

        assert get_next_subtask(tmp_path)["id"] == "2.2"

    def test_a_single_dependency_and_a_null_one_are_understood(self, tmp_path):
        plan(
            tmp_path,
            [
                {"phase": 1, "subtasks": [subtask("1.1", "pending")]},
                {"id": "b", "depends_on": 1, "subtasks": [subtask("b.1", "pending")]},
                {
                    "depends_on": None,
                    "chunks": [{"id": "c.1", "status": "not started"}],
                },
            ],
        )
        first = json.loads((tmp_path / "implementation_plan.json").read_text("utf-8"))
        first["phases"][0]["subtasks"][0]["status"] = "completed"
        plan(tmp_path, first)

        nxt = get_next_subtask(tmp_path)

        assert (nxt["id"], nxt["phase_id"]) == ("b.1", "b")

    def test_a_phase_with_no_id_does_not_unblock_another(self, tmp_path):
        plan(
            tmp_path,
            [
                {"subtasks": [subtask("x", "in_progress")]},
                {
                    "depends_on": [None],
                    "chunks": [{"id": "c.1", "status": "not_started"}],
                },
            ],
        )

        nxt = get_next_subtask(tmp_path)

        assert nxt["id"] == "c.1" and nxt["status"] == "pending"

    def test_a_phase_blocked_by_an_unfinished_one_is_skipped(self, tmp_path):
        plan(
            tmp_path,
            [
                {"id": "a", "subtasks": [subtask("a.1", "in_progress")]},
                {"id": "b", "depends_on": "a", "subtasks": [subtask("b.1", "pending")]},
                {
                    "id": "c",
                    "depends_on": None,
                    "subtasks": [subtask("c.1", "pending")],
                },
            ],
        )

        assert get_next_subtask(tmp_path)["id"] == "c.1"

    def test_without_a_plan_there_is_nothing_to_do(self, tmp_path):
        assert get_next_subtask(tmp_path) is None
        assert count_subtasks_detailed(tmp_path)["total"] == 0

    def test_nothing_left_means_none(self, tmp_path):
        plan(tmp_path, SHOP[:1])

        assert get_next_subtask(tmp_path) is None

    def test_a_broken_plan_has_no_next_subtask(self, tmp_path):
        (tmp_path / "implementation_plan.json").write_text("{", encoding="utf-8")

        assert get_next_subtask(tmp_path) is None


class TestWhatTheLoopPrints:
    def test_the_summary_shows_each_phase_and_the_next_subtask(self, tmp_path, capsys):
        plan(tmp_path, SHOP)

        print_progress_summary(tmp_path)

        out = capsys.readouterr().out
        assert "4 subtasks remaining" in out
        for name in ("Backend", "API", "Frontend", "Docs", "Review"):
            assert name in out
        assert "Next:" in out and "2.2" in out

    def test_a_long_next_description_is_cut(self, tmp_path, capsys):
        phases = [dict(SHOP[2], depends_on=[])]
        plan(tmp_path, phases)

        print_progress_summary(tmp_path)

        out = capsys.readouterr().out
        assert "x" * 57 + "..." in out
        assert "x" * 58 not in out

    def test_a_complete_build_says_so_and_shows_no_next(self, tmp_path, capsys):
        plan(tmp_path, SHOP[:1])

        print_progress_summary(tmp_path)

        out = capsys.readouterr().out
        assert "BUILD COMPLETE - All subtasks completed!" in out
        assert "Next:" not in out

    def test_without_a_plan_the_planner_is_awaited(self, tmp_path, capsys):
        print_progress_summary(tmp_path, show_next=False)

        assert "planner needs to run" in capsys.readouterr().out

    def test_the_session_header_names_the_subtask_phase_and_attempt(self, capsys):
        print_session_header(
            3,
            is_planner=False,
            subtask_id="2.2",
            subtask_desc="d" * 60,
            phase_name="API",
            attempt=2,
        )
        print_session_header(1, is_planner=True, subtask_id="1.1", subtask_desc="short")

        out = capsys.readouterr().out
        assert "SESSION 3: CODING AGENT" in out
        assert "d" * 51 not in out  # the description is cut at 50
        assert "Phase: API" in out and "Attempt: 2" in out
        assert "SESSION 1: PLANNER AGENT" in out and "short" in out

    def test_the_banners(self, tmp_path, capsys):
        plan(tmp_path, SHOP)

        print_build_complete_banner(tmp_path)
        print_paused_banner(tmp_path, "007-cart", has_worktree=True)
        print_paused_banner(tmp_path, "007-cart")

        out = capsys.readouterr().out
        assert "BUILD COMPLETE!" in out
        assert out.count("Progress saved: 3/7 subtasks complete") == 2
        assert out.count("separate workspace") == 1


class TestReopening:
    @pytest.mark.parametrize("content", ["{", "[1]"])
    def test_an_unreadable_plan_reopens_nothing(self, tmp_path, content):
        (tmp_path / "implementation_plan.json").write_text(content, encoding="utf-8")

        assert reopen_interrupted_subtasks(tmp_path) == []

    def test_odd_entries_are_left_alone(self, tmp_path):
        path = plan(
            tmp_path,
            ["not a phase", {"chunks": [subtask("c1", "in_progress"), "x"]}],
        )

        assert reopen_interrupted_subtasks(tmp_path) == ["c1"]
        assert (
            json.loads(path.read_text(encoding="utf-8"))["phases"][0] == "not a phase"
        )

    def test_a_plan_that_cannot_be_written_back_reopens_nothing(
        self, tmp_path, monkeypatch, caplog
    ):
        plan(tmp_path, [{"subtasks": [subtask("1.1", "in_progress")]}])

        def read_only(path, data):
            raise PermissionError("read-only file system")

        import foundation.file_utils

        monkeypatch.setattr(foundation.file_utils, "write_json_atomic", read_only)

        with caplog.at_level(logging.WARNING, logger=progress.__name__):
            assert reopen_interrupted_subtasks(tmp_path) == []
        assert "Could not reopen interrupted subtasks" in caplog.text
