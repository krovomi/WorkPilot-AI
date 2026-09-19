#!/usr/bin/env python3
"""
Tests for Plan Recovery
=======================

`Planning failed: the model did not produce a valid implementation_plan.json`
was the answer to a question nobody asked: the validator reads one path in one
shape and reports what is not there. These tests pin the three cases where that
sentence was false — the plan was written elsewhere, written in another shape,
or never written at all because the JSON is in the transcript — and the one
case where it is true, which must keep failing.
"""

import json
import sys
from pathlib import Path

import pytest

backend_path = Path(__file__).parent.parent / "apps" / "backend"
sys.path.insert(0, str(backend_path))

from spec.plan_recovery import (  # noqa: E402
    count_subtasks,
    extract_json_document,
    normalize_plan_shape,
    recover_plan,
    write_recovered_plan,
)
from spec.validate_pkg import SpecValidator, auto_fix_plan  # noqa: E402

VALID_PLAN = {
    "feature": "Ajout de namespaces manquants",
    "workflow_type": "feature",
    "phases": [
        {
            "id": "phase-1",
            "name": "Implementation",
            "subtasks": [
                {
                    "id": "subtask-1-1",
                    "description": "Add namespace to Foo.cs",
                    "status": "pending",
                }
            ],
        }
    ],
}


# --------------------------------------------------------------------------- #
# JSON out of prose
# --------------------------------------------------------------------------- #


class TestExtractJsonDocument:
    def test_plain_json_is_returned_as_is(self):
        assert extract_json_document(json.dumps(VALID_PLAN)) == VALID_PLAN

    def test_fenced_json(self):
        text = "Voici le plan :\n```json\n" + json.dumps(VALID_PLAN) + "\n```\nVoilà."
        assert extract_json_document(text) == VALID_PLAN

    def test_unlabelled_fence(self):
        text = "```\n" + json.dumps(VALID_PLAN) + "\n```"
        assert extract_json_document(text) == VALID_PLAN

    def test_prose_on_both_sides(self):
        text = (
            "Here is the plan: "
            + json.dumps(VALID_PLAN)
            + " Let me know if that works."
        )
        assert extract_json_document(text) == VALID_PLAN

    def test_braces_inside_strings_do_not_close_the_document(self):
        plan = {
            "feature": "x",
            "phases": [
                {
                    "name": "P",
                    "subtasks": [
                        {"description": 'use map[0] and {placeholder} "quoted"'}
                    ],
                }
            ],
        }
        text = "Plan:\n```json\n" + json.dumps(plan) + "\n```"
        assert extract_json_document(text) == plan

    def test_no_json_at_all(self):
        assert (
            extract_json_document("I analysed the repository and it looks fine.")
            is None
        )
        assert extract_json_document("") is None

    def test_incomplete_document_is_not_returned(self):
        assert extract_json_document('{"feature": "x", "phases": [') is None


# --------------------------------------------------------------------------- #
# Any shape -> the schema's shape
# --------------------------------------------------------------------------- #


class TestNormalizePlanShape:
    def test_valid_plan_is_left_alone(self):
        assert normalize_plan_shape(VALID_PLAN)["phases"] == VALID_PLAN["phases"]

    @pytest.mark.parametrize(
        "alias", ["tasks", "steps", "items", "actions", "subtasks", "chunks"]
    )
    def test_flat_subtask_list_under_any_name(self, alias):
        plan = normalize_plan_shape(
            {"feature": "F", alias: [{"description": "a"}, {"description": "b"}]}
        )
        assert count_subtasks(plan) == 2
        assert plan["feature"] == "F"
        # The alias must not survive next to the phases it became.
        assert alias not in plan or alias == "phases"

    @pytest.mark.parametrize("alias", ["phases", "stages", "milestones", "workstreams"])
    def test_phase_list_under_any_name(self, alias):
        plan = normalize_plan_shape(
            {alias: [{"name": "P", "subtasks": [{"description": "a"}]}]}
        )
        assert count_subtasks(plan) == 1

    @pytest.mark.parametrize(
        "wrapper", ["implementation_plan", "implementationPlan", "plan"]
    )
    def test_one_level_of_wrapping(self, wrapper):
        plan = normalize_plan_shape({wrapper: VALID_PLAN})
        assert count_subtasks(plan) == 1

    def test_phases_keyed_by_id_keep_their_keys(self):
        plan = normalize_plan_shape(
            {"phases": {"phase-a": {"name": "A", "subtasks": [{"description": "a"}]}}}
        )
        assert plan["phases"][0]["id"] == "phase-a"

    def test_top_level_list_of_phases(self):
        plan = normalize_plan_shape([{"name": "P", "subtasks": [{"description": "a"}]}])
        assert count_subtasks(plan) == 1

    def test_top_level_list_of_subtasks(self):
        plan = normalize_plan_shape([{"description": "a"}, {"description": "b"}])
        assert count_subtasks(plan) == 2

    def test_phases_that_are_really_subtasks(self):
        """No entry holds a list of its own, so the list is the work items."""
        plan = normalize_plan_shape(
            {"phases": [{"description": "a"}, {"description": "b"}]}
        )
        assert count_subtasks(plan) == 2

    def test_bare_string_subtasks(self):
        plan = normalize_plan_shape(
            {"phases": [{"name": "P", "steps": ["add ns to Foo.cs", "  "]}]}
        )
        assert [s["description"] for s in plan["phases"][0]["subtasks"]] == [
            "add ns to Foo.cs"
        ]

    def test_subtask_description_aliases(self):
        plan = normalize_plan_shape(
            {"tasks": [{"title": "T"}, {"name": "N"}, {"summary": "S"}]}
        )
        assert [s["description"] for s in plan["phases"][0]["subtasks"]] == [
            "T",
            "N",
            "S",
        ]

    def test_feature_is_taken_from_a_title_when_present(self):
        plan = normalize_plan_shape(
            {"title": "My feature", "tasks": [{"description": "a"}]}
        )
        assert plan["feature"] == "My feature"

    def test_defaults_are_filled_in(self):
        plan = normalize_plan_shape({"tasks": [{"description": "a"}]})
        assert plan["feature"] == "Unnamed Feature"
        assert plan["workflow_type"] == "feature"

    @pytest.mark.parametrize(
        "document",
        [
            {"phases": []},
            {"phases": [{"name": "P", "subtasks": []}]},
            {"hello": "world"},
            {"implementation_plan": {"phases": []}},
            [],
            "a string",
            None,
            42,
        ],
    )
    def test_nothing_to_recover_returns_none(self, document):
        """A plan WorkPilot made up is worse than the error message: the coder
        would spend a whole build implementing it."""
        assert normalize_plan_shape(document) is None

    def test_unbounded_wrapping_is_refused(self):
        assert (
            normalize_plan_shape({"plan": {"plan": {"plan": {"plan": VALID_PLAN}}}})
            is None
        )


# --------------------------------------------------------------------------- #
# Everywhere the plan could be
# --------------------------------------------------------------------------- #


class TestRecoverPlan:
    def test_stray_plan_at_the_project_root_is_promoted(self, tmp_path):
        """PHASE 3 of the prompt spells a relative path, which resolves against
        the worktree root. That file used to be deleted."""
        project_dir = tmp_path / "project"
        spec_dir = project_dir / ".workpilot" / "specs" / "003-ns"
        spec_dir.mkdir(parents=True)
        stray = project_dir / "implementation_plan.json"
        stray.write_text(json.dumps(VALID_PLAN), encoding="utf-8")

        recovered = recover_plan(spec_dir, project_dir, None)
        assert recovered is not None
        assert recovered.subtask_count == 1
        assert recovered.source_file == stray

        assert write_recovered_plan(spec_dir, recovered)
        written = json.loads(
            (spec_dir / "implementation_plan.json").read_text(encoding="utf-8")
        )
        assert count_subtasks(written) == 1
        assert not stray.exists(), (
            "a second copy of the real plan must not linger at the root"
        )

    def test_a_project_file_at_the_root_is_never_read_as_a_plan(self, tmp_path):
        """`tasks.json` at a project root is a task-runner config far more often
        than it is a plan. Invented names are looked for in the spec directory,
        which is WorkPilot's own, and nowhere else."""
        project_dir = tmp_path / "project"
        spec_dir = project_dir / ".workpilot" / "specs" / "003-ns"
        spec_dir.mkdir(parents=True)
        (project_dir / "tasks.json").write_text(
            json.dumps({"tasks": [{"description": "build", "command": "make"}]}),
            encoding="utf-8",
        )

        assert recover_plan(spec_dir, project_dir, None) is None

    def test_invented_filename_is_promoted(self, tmp_path):
        project_dir = tmp_path / "project"
        spec_dir = project_dir / "spec"
        spec_dir.mkdir(parents=True)
        (spec_dir / "plan.json").write_text(json.dumps(VALID_PLAN), encoding="utf-8")

        recovered = recover_plan(spec_dir, project_dir, None)
        assert recovered is not None and recovered.subtask_count == 1

    def test_the_asked_for_name_wins_over_an_invented_one(self, tmp_path):
        project_dir = tmp_path / "project"
        spec_dir = project_dir / "spec"
        spec_dir.mkdir(parents=True)
        (spec_dir / "tasks.json").write_text(
            json.dumps({"tasks": [{"description": "wrong"}]}), encoding="utf-8"
        )
        (spec_dir / "implementation_plan.json").write_text(
            json.dumps(VALID_PLAN), encoding="utf-8"
        )

        recovered = recover_plan(spec_dir, project_dir, None)
        assert (
            recovered.plan["phases"][0]["subtasks"][0]["description"]
            == "Add namespace to Foo.cs"
        )

    def test_wrong_shape_in_the_right_file_is_recovered_in_place(self, tmp_path):
        spec_dir = tmp_path / "spec"
        spec_dir.mkdir()
        (spec_dir / "implementation_plan.json").write_text(
            json.dumps({"feature": "F", "tasks": [{"description": "a"}]}),
            encoding="utf-8",
        )

        recovered = recover_plan(spec_dir, tmp_path, None)
        assert recovered is not None
        assert recovered.source_file is None, "the file it lives in must not be deleted"
        assert recovered.origin == "its own shape"

    def test_json_in_the_transcript(self, tmp_path):
        spec_dir = tmp_path / "spec"
        spec_dir.mkdir()
        response = (
            "I could not write the file, but here is the plan:\n```json\n"
            + json.dumps(VALID_PLAN)
            + "\n```"
        )

        recovered = recover_plan(spec_dir, tmp_path, response)
        assert recovered is not None
        assert recovered.origin == "the planner's response"

    def test_a_file_beats_the_transcript(self, tmp_path):
        spec_dir = tmp_path / "spec"
        spec_dir.mkdir()
        (spec_dir / "implementation_plan.json").write_text(
            json.dumps({"tasks": [{"description": "from the file"}]}), encoding="utf-8"
        )
        response = (
            "```json\n"
            + json.dumps({"tasks": [{"description": "from the transcript"}]})
            + "\n```"
        )

        recovered = recover_plan(spec_dir, tmp_path, response)
        assert (
            recovered.plan["phases"][0]["subtasks"][0]["description"] == "from the file"
        )

    def test_nothing_anywhere(self, tmp_path):
        spec_dir = tmp_path / "spec"
        spec_dir.mkdir()
        (spec_dir / "implementation_plan.json").write_text(
            json.dumps({"status": "in_progress"}), encoding="utf-8"
        )
        assert recover_plan(spec_dir, tmp_path, "I analysed the repository.") is None

    def test_the_frontend_status_shell_survives_the_plan_landing_under_it(
        self, tmp_path
    ):
        """`persistPlanStatusAndReasonSync` creates this file before the plan
        exists; dropping its keys resets a card that is visibly running."""
        spec_dir = tmp_path / "spec"
        spec_dir.mkdir()
        shell = {
            "created_at": "2026-01-01T00:00:00Z",
            "status": "in_progress",
            "planStatus": "in_progress",
            "xstateState": "planning",
            "executionPhase": "planning",
        }
        (spec_dir / "implementation_plan.json").write_text(
            json.dumps(shell), encoding="utf-8"
        )
        (tmp_path / "implementation_plan.json").write_text(
            json.dumps(VALID_PLAN), encoding="utf-8"
        )

        recovered = recover_plan(spec_dir, tmp_path, None)
        assert write_recovered_plan(spec_dir, recovered)

        written = json.loads(
            (spec_dir / "implementation_plan.json").read_text(encoding="utf-8")
        )
        assert written["xstateState"] == "planning"
        assert written["created_at"] == "2026-01-01T00:00:00Z"
        assert count_subtasks(written) == 1

    def test_unreadable_candidates_are_skipped_not_raised(self, tmp_path):
        spec_dir = tmp_path / "spec"
        spec_dir.mkdir()
        (spec_dir / "plan.json").write_text("not json at all {{{", encoding="utf-8")
        (spec_dir / "tasks.json").write_text(json.dumps(VALID_PLAN), encoding="utf-8")

        recovered = recover_plan(spec_dir, tmp_path, None)
        assert recovered is not None and recovered.subtask_count == 1


# --------------------------------------------------------------------------- #
# The validator's own verdict, after the fixes
# --------------------------------------------------------------------------- #


class TestAutoFixReachesTheValidator:
    def _validate(self, spec_dir):
        return SpecValidator(spec_dir).validate_implementation_plan()

    @pytest.mark.parametrize(
        "document",
        [
            {"feature": "F", "tasks": [{"description": "a"}]},
            {
                "implementation_plan": {
                    "phases": [{"name": "P", "subtasks": [{"description": "a"}]}]
                }
            },
            {"phases": {"p1": {"name": "P", "subtasks": [{"description": "a"}]}}},
            [{"name": "P", "subtasks": [{"description": "a"}]}],
            {"steps": ["add a namespace to Foo.cs"]},
        ],
    )
    def test_a_reshaped_plan_validates(self, tmp_path, document):
        (tmp_path / "implementation_plan.json").write_text(
            json.dumps(document), encoding="utf-8"
        )
        assert auto_fix_plan(tmp_path) is True
        result = self._validate(tmp_path)
        assert result.valid, result.errors

    def test_a_fenced_plan_validates(self, tmp_path):
        (tmp_path / "implementation_plan.json").write_text(
            "```json\n" + json.dumps(VALID_PLAN) + "\n```", encoding="utf-8"
        )
        assert auto_fix_plan(tmp_path) is True
        assert self._validate(tmp_path).valid

    def test_a_status_only_shell_still_fails(self, tmp_path):
        """The case the error message was written for stays a failure."""
        (tmp_path / "implementation_plan.json").write_text(
            json.dumps({"status": "in_progress", "planStatus": "in_progress"}),
            encoding="utf-8",
        )
        auto_fix_plan(tmp_path)
        result = self._validate(tmp_path)
        assert not result.valid
        assert "No phases defined" in result.errors

    def test_an_already_valid_plan_is_not_reshaped(self, tmp_path):
        """Auto-fix still fills in the optional fields it always did (`phase`,
        `depends_on`); what must not change is the work the model decided."""
        plan_file = tmp_path / "implementation_plan.json"
        plan_file.write_text(json.dumps(VALID_PLAN), encoding="utf-8")
        auto_fix_plan(tmp_path)
        after = json.loads(plan_file.read_text(encoding="utf-8"))
        assert after["feature"] == VALID_PLAN["feature"]
        assert after["workflow_type"] == VALID_PLAN["workflow_type"]
        assert len(after["phases"]) == 1
        assert after["phases"][0]["id"] == "phase-1"
        assert after["phases"][0]["subtasks"] == VALID_PLAN["phases"][0]["subtasks"]
        assert self._validate(tmp_path).valid


# --------------------------------------------------------------------------- #
# The shape the earlier fix still gave up on
# --------------------------------------------------------------------------- #


class TestEmptyPhasesFallsThroughToTheFlatList:
    """`{"phases": [], "tasks": [...]}` — the shape behind the bug report.

    PHASE 3 of `prompts/planner.md` warns against an empty `phases` array by
    name, which is exactly why a local model produces one. Reading that empty
    key as the final answer meant the subtasks one key further down were thrown
    away, and the build reported "No phases defined / No subtasks defined in any
    phase" — the one report that claims a model produced nothing when it had
    produced a plan.
    """

    @pytest.mark.parametrize("alias", ["tasks", "subtasks", "steps", "items"])
    def test_empty_phases_beside_a_flat_list(self, alias):
        plan = normalize_plan_shape(
            {
                "feature": "Ajout de namespaces manquants",
                "workflow_type": "feature",
                "phases": [],
                alias: [{"description": "Add namespace to Foo.cs"}],
            }
        )
        assert plan is not None and count_subtasks(plan) == 1
        assert plan["feature"] == "Ajout de namespaces manquants"

    def test_phases_present_but_none_of_them_carries_work(self):
        plan = normalize_plan_shape(
            {
                "feature": "F",
                "phases": [{"id": "p1", "name": "P", "subtasks": []}],
                "tasks": [{"description": "a"}, {"description": "b"}],
            }
        )
        assert plan is not None and count_subtasks(plan) == 2

    def test_empty_phases_inside_a_wrapper(self):
        plan = normalize_plan_shape(
            {"implementation_plan": {"phases": [], "tasks": [{"description": "a"}]}}
        )
        assert plan is not None and count_subtasks(plan) == 1

    def test_a_flat_list_of_bare_strings_beside_empty_phases(self):
        plan = normalize_plan_shape(
            {"phases": [], "steps": ["Add the missing namespace to Foo.cs"]}
        )
        assert plan is not None and count_subtasks(plan) == 1
        assert (
            plan["phases"][0]["subtasks"][0]["description"]
            == "Add the missing namespace to Foo.cs"
        )

    def test_empty_phases_with_nothing_else_still_fails(self):
        """The genuinely empty plan must keep failing: there is no work in it,
        and inventing a subtask would cost a whole build."""
        assert normalize_plan_shape({"feature": "F", "phases": []}) is None

    @pytest.mark.parametrize("alias", ["sub_tasks", "subTasks", "implementation_steps"])
    def test_further_spellings_of_the_subtask_list(self, alias):
        plan = normalize_plan_shape({"feature": "F", alias: [{"description": "a"}]})
        assert plan is not None and count_subtasks(plan) == 1

    def test_the_users_exact_failure_reaches_a_valid_plan(self, tmp_path):
        """End to end, through the path the CLI and the spec pipeline take."""
        (tmp_path / "implementation_plan.json").write_text(
            json.dumps(
                {
                    "feature": "Ajout de namespaces manquants",
                    "workflow_type": "feature",
                    "phases": [],
                    "tasks": [{"description": "Add namespace to Foo.cs"}],
                }
            ),
            encoding="utf-8",
        )
        assert auto_fix_plan(tmp_path) is True
        result = SpecValidator(tmp_path).validate_implementation_plan()
        assert result.valid, result.errors


# --------------------------------------------------------------------------- #
# The plan that never reached the disk
# --------------------------------------------------------------------------- #


class TestRecoveryFromARejectedToolCall:
    """A provider that does not use the Claude SDK puts its plan in a tool call,
    not in its prose. When the executor refuses that call the plan exists in
    exactly one place — the conversation log, which records every `tool_use`
    with its input. Reading files and response text both miss it, which is why
    the earlier fix looked like no fix at all on Ollama.
    """

    def _log(self, spec_dir, blocks, name="conversation.ollama-gemma3-12b.jsonl"):
        entries = [
            {"v": 1, "role": "user", "content": [{"type": "text", "text": "plan it"}]},
            {"v": 1, "role": "assistant", "content": blocks},
        ]
        (spec_dir / name).write_text(
            "\n".join(json.dumps(e) for e in entries) + "\n", encoding="utf-8"
        )

    def _write_call(self, path, content):
        return {
            "type": "tool_use",
            "tool_id": "t1",
            "tool_name": "Write",
            "tool_input": {"file_path": path, "content": content},
        }

    def test_a_fenced_plan_in_a_refused_write(self, tmp_path):
        self._log(
            tmp_path,
            [
                {"type": "text", "text": "I will create the plan now."},
                self._write_call(
                    "implementation_plan.json",
                    "```json\n" + json.dumps(VALID_PLAN) + "\n```",
                ),
            ],
        )
        recovered = recover_plan(tmp_path, tmp_path, response_text="I will create it.")
        assert recovered is not None
        assert recovered.subtask_count == 1
        assert "did not land" in recovered.origin
        # Nothing to delete: the plan was never a file.
        assert recovered.source_file is None

    def test_the_newest_attempt_wins(self, tmp_path):
        second = json.loads(json.dumps(VALID_PLAN))
        second["phases"][0]["subtasks"].append(
            {"id": "subtask-1-2", "description": "Add namespace to Bar.cs"}
        )
        self._log(
            tmp_path,
            [
                self._write_call("implementation_plan.json", json.dumps(VALID_PLAN)),
                self._write_call("implementation_plan.json", json.dumps(second)),
            ],
        )
        recovered = recover_plan(tmp_path, tmp_path)
        assert recovered is not None and recovered.subtask_count == 2

    @pytest.mark.parametrize(
        "destination", ["src/Program.cs", "package.json", "tasks.json", "README.md"]
    )
    def test_a_write_aimed_elsewhere_is_never_read_as_a_plan(
        self, tmp_path, destination
    ):
        """Strict on purpose: a tool call's content is *any* file the model
        wrote, and building an arbitrary one as a plan is worse than failing."""
        self._log(tmp_path, [self._write_call(destination, json.dumps(VALID_PLAN))])
        assert recover_plan(tmp_path, tmp_path) is None

    def test_an_invented_name_inside_the_spec_directory_is_credited(self, tmp_path):
        """The qualification cuts both ways: inside WorkPilot's own directory,
        `plan.json` can only be the plan the planner just tried to write."""
        self._log(
            tmp_path,
            [self._write_call(str(tmp_path / "plan.json"), json.dumps(VALID_PLAN))],
        )
        recovered = recover_plan(tmp_path, tmp_path)
        assert recovered is not None and recovered.subtask_count == 1

    def test_a_relative_invented_name_is_not_credited(self, tmp_path):
        """A relative path lands at the worktree root, which is exactly where a
        project's own `tasks.json` lives."""
        self._log(tmp_path, [self._write_call("plan.json", json.dumps(VALID_PLAN))])
        assert recover_plan(tmp_path, tmp_path) is None

    def test_a_file_on_disk_still_wins_over_the_log(self, tmp_path):
        """The log is the last resort — a filed plan proves more than a call."""
        filed = json.loads(json.dumps(VALID_PLAN))
        filed["feature"] = "the one on disk"
        (tmp_path / "implementation_plan.json").write_text(
            json.dumps(filed), encoding="utf-8"
        )
        self._log(tmp_path, [self._write_call("implementation_plan.json", "{}")])
        recovered = recover_plan(tmp_path, tmp_path)
        assert recovered is not None
        assert recovered.plan["feature"] == "the one on disk"

    def test_an_archived_log_is_not_read(self, tmp_path):
        """A prompt-too-long halt archives precisely so nothing replays it."""
        self._log(
            tmp_path,
            [self._write_call("implementation_plan.json", json.dumps(VALID_PLAN))],
            name="conversation.ollama-gemma3-12b.too-long.jsonl",
        )
        assert recover_plan(tmp_path, tmp_path) is None

    def test_a_log_with_no_write_call_recovers_nothing(self, tmp_path):
        self._log(tmp_path, [{"type": "text", "text": "Here is my plan, in prose."}])
        assert recover_plan(tmp_path, tmp_path) is None

    def test_a_corrupt_log_is_one_fewer_candidate_not_a_crash(self, tmp_path):
        (tmp_path / "conversation.ollama-x.jsonl").write_text(
            '{"v": 1, "role": "assist', encoding="utf-8"
        )
        assert recover_plan(tmp_path, tmp_path) is None


# --------------------------------------------------------------------------- #
# A document that parses but is not a plan-shaped object
# --------------------------------------------------------------------------- #


class TestTheValidatorReportsRatherThanCrashes:
    """Every check in the plan validator reads the document as a mapping, so a
    model that wrote the bare `phases` array took the whole build down with an
    AttributeError and the card showed a crash instead of what was wrong."""

    @pytest.mark.parametrize(
        "document", ['[{"id": "p1", "subtasks": []}]', '"hello"', "null", "42"]
    )
    def test_a_non_object_plan_is_an_error(self, tmp_path, document):
        (tmp_path / "implementation_plan.json").write_text(document, encoding="utf-8")
        result = SpecValidator(tmp_path).validate_implementation_plan()
        assert not result.valid
        assert any("must contain a JSON object" in e for e in result.errors)

    def test_a_bare_phases_array_is_still_recovered(self, tmp_path):
        """Reported, not fatal — and reshaped by the step that runs next."""
        (tmp_path / "implementation_plan.json").write_text(
            json.dumps(VALID_PLAN["phases"]), encoding="utf-8"
        )
        assert auto_fix_plan(tmp_path) is True
        assert SpecValidator(tmp_path).validate_implementation_plan().valid
