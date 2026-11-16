"""Plan recovery on the shapes and failures the main suite does not reach.

`tests/test_plan_recovery.py` pins the recoveries that matter most. These are
the edges around them: a phase map whose values are lists, entries that are not
objects, a log a crash left in a broken state, a disk that refuses the write.
Each one must end either in a plan the model wrote or in ``None``, never in an
exception on a build that has already failed validation.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from spec.plan_recovery import (
    RecoveredPlan,
    candidate_files,
    count_subtasks,
    normalize_plan_shape,
    recover_plan,
    write_recovered_plan,
)

PLAN = {
    "feature": "Export invoices",
    "workflow_type": "feature",
    "phases": [
        {
            "id": "phase-1",
            "name": "Implementation",
            "subtasks": [{"id": "subtask-1-1", "description": "Add the exporter"}],
        }
    ],
}


def _log(spec_dir: Path, lines: list[str], name: str = "conversation.p-m.jsonl"):
    (spec_dir / name).write_text("\n".join(lines) + "\n", encoding="utf-8")


def _assistant(*blocks: dict) -> str:
    return json.dumps({"v": 1, "role": "assistant", "content": list(blocks)})


def _write(path, content, tool_name="Write", **extra) -> dict:
    tool_input = {"file_path": path, "content": content, **extra}
    return {"type": "tool_use", "tool_name": tool_name, "tool_input": tool_input}


class TestShapes:
    def test_a_phase_map_whose_values_are_subtask_lists(self):
        plan = normalize_plan_shape(
            {"phases": {"backend": ["Add the route"], "frontend": ["Add the button"]}}
        )
        assert plan is not None
        assert [p["id"] for p in plan["phases"]] == ["backend", "frontend"]
        assert plan["phases"][1]["subtasks"][0]["description"] == "Add the button"

    def test_phases_as_prose_fall_back_to_the_flat_list(self):
        plan = normalize_plan_shape(
            {"phases": "see the tasks below", "tasks": ["Write the parser"]}
        )
        assert plan is not None
        assert plan["phases"][0]["subtasks"][0]["description"] == "Write the parser"

    def test_entries_that_are_not_objects_are_dropped(self):
        plan = normalize_plan_shape(
            [{"name": "Build", "subtasks": ["Compile it"]}, "a stray note", 7]
        )
        assert plan is not None
        assert len(plan["phases"]) == 1
        assert plan["phases"][0]["name"] == "Build"

    def test_subtasks_without_any_description_are_not_invented(self):
        plan = normalize_plan_shape(
            {
                "phases": [
                    {
                        "subtasks": [
                            42,
                            {"files": ["src/app.go"]},
                            "   ",
                            {"goal": "Handle the empty input"},
                        ]
                    }
                ]
            }
        )
        assert plan is not None
        subtasks = plan["phases"][0]["subtasks"]
        assert [s["description"] for s in subtasks] == ["Handle the empty input"]
        # The id is the position in the model's own list.
        assert subtasks[0]["id"] == "subtask-1-4"

    @pytest.mark.parametrize("plan", [{}, {"phases": {}}, {"phases": "none"}])
    def test_count_without_a_phase_list_is_zero(self, plan):
        assert count_subtasks(plan) == 0


class TestCandidates:
    def test_an_undecodable_candidate_is_skipped(self, tmp_path):
        (tmp_path / "implementation_plan.json").write_bytes(b"\xff\xfe{not utf-8")
        (tmp_path / "plan.json").write_text(json.dumps(PLAN), encoding="utf-8")
        recovered = recover_plan(tmp_path)
        assert recovered is not None
        assert recovered.source_file == tmp_path / "plan.json"

    def test_the_same_file_reached_twice_is_read_once(self, tmp_path):
        spec_dir = tmp_path / "spec"
        project = tmp_path / "project"
        spec_dir.mkdir()
        project.mkdir()
        target = spec_dir / "implementation_plan.json"
        target.write_text(json.dumps(PLAN), encoding="utf-8")
        try:
            (project / "implementation_plan.json").symlink_to(target)
        except OSError:
            pytest.skip("symbolic links are not available here")
        assert candidate_files(spec_dir, project) == [target]

    def test_paths_that_cannot_be_resolved_are_compared_as_written(
        self, tmp_path, monkeypatch
    ):
        project = tmp_path / "project"
        project.mkdir()
        (project / "implementation_plan.json").write_text(
            json.dumps(PLAN), encoding="utf-8"
        )

        def refuse(self, strict=False):
            raise OSError("resolution refused")

        monkeypatch.setattr(Path, "resolve", refuse)
        recovered = recover_plan(tmp_path / "spec", project)
        assert recovered is not None
        assert recovered.source_file == project / "implementation_plan.json"


class TestResponseText:
    def test_prose_without_a_plan_recovers_nothing(self, tmp_path):
        assert recover_plan(tmp_path, response_text="I could not plan this.") is None


class TestToolCalls:
    def test_a_name_that_only_contains_the_plan_name_is_credited(self, tmp_path):
        _log(
            tmp_path,
            [_assistant(_write("out/implementation_plan.v2.json", json.dumps(PLAN)))],
        )
        recovered = recover_plan(tmp_path)
        assert recovered is not None and recovered.subtask_count == 1

    def test_an_invented_name_outside_the_spec_directory_is_not_credited(
        self, tmp_path
    ):
        spec_dir = tmp_path / "spec"
        spec_dir.mkdir()
        elsewhere = (tmp_path / "project" / "tasks.json").as_posix()
        _log(spec_dir, [_assistant(_write(elsewhere, json.dumps(PLAN)))])
        assert recover_plan(spec_dir) is None

    def test_calls_that_cannot_carry_a_plan_are_passed_over(self, tmp_path):
        good = _write("implementation_plan.json", json.dumps(PLAN))
        _log(
            tmp_path,
            [
                _assistant(good),
                json.dumps(["not", "an", "entry"]),
                _assistant(
                    "not a block",
                    {"type": "text", "text": "done"},
                    _write("implementation_plan.json", "{}", tool_name="Edit"),
                    {"type": "tool_use", "tool_name": "Write", "tool_input": "{}"},
                    {
                        "type": "tool_use",
                        "tool_name": "Write",
                        "tool_input": {"path": 3},
                    },
                    _write("implementation_plan.json", "   "),
                    _write("implementation_plan.json", '{"feature": "no work"}'),
                ),
            ],
        )
        recovered = recover_plan(tmp_path)
        # Every later call was unusable, so the first one is the plan.
        assert recovered is not None
        assert recovered.plan["feature"] == "Export invoices"

    def test_a_log_that_is_not_utf8_is_one_fewer_candidate(self, tmp_path):
        (tmp_path / "conversation.p-m.jsonl").write_bytes(b"\xff\xfe\x00broken\n")
        assert recover_plan(tmp_path) is None

    def test_without_the_conversation_log_there_is_nothing_more_to_read(
        self, tmp_path, monkeypatch
    ):
        _log(
            tmp_path, [_assistant(_write("implementation_plan.json", json.dumps(PLAN)))]
        )
        monkeypatch.setitem(sys.modules, "core.conversation_log", None)
        assert recover_plan(tmp_path) is None


class TestWrite:
    def test_a_spec_path_that_is_a_file_reports_the_failure(self, tmp_path):
        not_a_dir = tmp_path / "spec"
        not_a_dir.write_text("", encoding="utf-8")
        recovered = RecoveredPlan(plan=dict(PLAN), origin="test")
        assert write_recovered_plan(not_a_dir, recovered) is False

    def test_a_source_already_gone_does_not_undo_the_promotion(self, tmp_path):
        recovered = RecoveredPlan(
            plan=dict(PLAN), origin="test", source_file=tmp_path / "gone.json"
        )
        assert write_recovered_plan(tmp_path, recovered) is True
        written = json.loads(
            (tmp_path / "implementation_plan.json").read_text(encoding="utf-8")
        )
        assert written["feature"] == "Export invoices"

    def test_a_shell_that_is_not_an_object_is_replaced(self, tmp_path):
        (tmp_path / "implementation_plan.json").write_text("[]", encoding="utf-8")
        assert write_recovered_plan(
            tmp_path, RecoveredPlan(plan=dict(PLAN), origin="t")
        )
        written = json.loads(
            (tmp_path / "implementation_plan.json").read_text(encoding="utf-8")
        )
        assert set(written) == set(PLAN)
