"""The lessons a task's prompts carried, which a person can turn off (#345).

What has to hold:

* a prompt built with a spec directory in hand records what it carried in
  ``applied_lessons.json`` there: adopted rules, learned patterns, the
  checkpoints of the task's kind, each with the agent it went to;
* a lesson turned off for the task (its id in ``disabled``) leaves every later
  prompt of that task, and only that task;
* the checkpoints of a kind come only when this repository's QA history says
  specs of that kind come back: three finished tasks at least, and on average
  1.5 QA passes or more, or two in five rejected at their first;
* the record is never a reason to fail: a missing, foreign or unreadable file
  is ignored, and the desktop app's ``disabled`` survives every write.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from learning_loop import applied, kind_checkpoints  # noqa: E402
from learning_loop.models import LearningPattern  # noqa: E402
from learning_loop.pattern_storage import PatternStorage  # noqa: E402
from learning_loop.prompt_injection import (  # noqa: E402
    context_for_agent,
    get_learning_context,
)
from learning_loop.review_lessons import (  # noqa: E402
    adopt,
    load_lessons,
    record_plan_feedback,
)
from spec.phases.spec_phases import learning_context_for  # noqa: E402

RULE = "Keep EF Core out of the Domain project."
INSTRUCTION = "Run the migrations before running the tests."


@pytest.fixture
def vault(tmp_path, monkeypatch):
    root = tmp_path / "vault"
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(root))
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    monkeypatch.setenv("BRAIN_PULL_INTERVAL", "0")
    return root


@pytest.fixture
def project(tmp_path) -> Path:
    path = tmp_path / "shop"
    (path / ".workpilot" / "specs").mkdir(parents=True)
    return path


def _spec(project: Path, name: str, kind: str | None = None, runs=None) -> Path:
    spec = project / ".workpilot" / "specs" / name
    spec.mkdir()
    if kind is not None:
        (spec / "task_metadata.json").write_text(
            json.dumps({"kind": kind}), encoding="utf-8"
        )
    if runs is not None:
        plan = {
            "qa_iteration_history": [{"status": status} for status in runs],
            "qa_stats": {"issues_by_type": {"missing_test": 2, "unknown": 5}},
        }
        (spec / "implementation_plan.json").write_text(
            json.dumps(plan), encoding="utf-8"
        )
    return spec


def _adopt_rule(project: Path) -> str:
    assert record_plan_feedback(project, "001-orders", RULE)
    lesson_id = load_lessons(project)[0]["id"]
    assert adopt(project, lesson_id) is not None
    return lesson_id


def _learn_pattern(project: Path) -> str:
    pattern = LearningPattern(
        pattern_id=LearningPattern.generate_id(),
        category="qa_pattern",
        pattern_type="failure",
        source="qa_feedback",
        description="Migrations were not run before the tests",
        confidence=0.8,
        occurrence_count=2,
        agent_phase="coding",
        context_tags=["db"],
        actionable_instruction=INSTRUCTION,
        source_build_ids=["001-login"],
    )
    PatternStorage(project).add_patterns([pattern])
    return pattern.pattern_id


def _disable(spec: Path, *ids: str) -> None:
    data = json.loads((spec / applied.APPLIED_FILE).read_text(encoding="utf-8"))
    data["disabled"] = list(ids)
    (spec / applied.APPLIED_FILE).write_text(json.dumps(data), encoding="utf-8")


class TestWhatAPromptCarriedIsRecorded:
    def test_rules_and_patterns_are_recorded_with_their_agent(self, vault, project):
        rule_id = _adopt_rule(project)
        pattern_id = _learn_pattern(project)
        spec = _spec(project, "002-refunds")

        context = get_learning_context(project, "coding", spec_dir=spec)

        assert f"- {RULE}" in context and INSTRUCTION in context
        rows = applied.applied(spec)
        assert [(r["id"], r["kind"], r["agent"]) for r in rows] == [
            (rule_id, "rule", "coder"),
            (pattern_id, "pattern", "coder"),
        ]
        assert rows[1]["pattern_type"] == "failure"
        assert rows[1]["confidence"] == 0.8
        assert applied.disabled_ids(spec) == frozenset()

    def test_without_a_spec_dir_nothing_is_written(self, vault, project):
        _adopt_rule(project)
        assert f"- {RULE}" in get_learning_context(project, "coding")
        assert not list(project.rglob(applied.APPLIED_FILE))

    def test_a_lesson_given_again_moves_to_the_end_once(self, vault, project):
        rule_id = _adopt_rule(project)
        spec = _spec(project, "002-refunds")
        get_learning_context(project, "coding", spec_dir=spec)
        get_learning_context(project, "planning", spec_dir=spec)
        get_learning_context(project, "coding", spec_dir=spec)

        rows = applied.applied(spec)
        assert [(r["id"], r["agent"]) for r in rows] == [
            (rule_id, "planner"),
            (rule_id, "coder"),
        ]

    def test_the_record_is_capped(self, tmp_path):
        lessons = [
            applied.Lesson(id=f"l{i}", kind="rule", text="x", agent="coder")
            for i in range(applied.MAX_RECORDED + 5)
        ]
        applied.record(tmp_path, lessons)
        rows = applied.applied(tmp_path)
        assert len(rows) == applied.MAX_RECORDED
        assert rows[-1]["id"] == f"l{applied.MAX_RECORDED + 4}"

    def test_an_id_the_app_would_refuse_is_not_recorded(self, tmp_path):
        applied.record(
            tmp_path,
            [applied.Lesson(id="../escape", kind="rule", text="x", agent="coder")],
        )
        assert applied.applied(tmp_path) == []


class TestTheRecordNeverFailsABuild:
    def _lesson(self) -> applied.Lesson:
        return applied.Lesson(id="r1", kind="rule", text="x", agent="coder")

    def test_a_missing_or_linked_spec_directory_gets_nothing(self, tmp_path):
        applied.record(tmp_path / "gone", [self._lesson()])
        real = tmp_path / "real"
        real.mkdir()
        link = tmp_path / "link"
        try:
            link.symlink_to(real, target_is_directory=True)
        except OSError:
            pytest.skip("this system cannot create a symbolic link")
        applied.record(link, [self._lesson()])
        assert not (real / applied.APPLIED_FILE).exists()
        assert not (tmp_path / "gone").exists()

    def test_a_temp_file_that_cannot_be_made_is_dropped(self, tmp_path, monkeypatch):
        def refuse(**_kwargs):
            raise OSError("read-only")

        monkeypatch.setattr(applied.tempfile, "mkstemp", refuse)
        applied.record(tmp_path, [self._lesson()])
        assert list(tmp_path.iterdir()) == []

    def test_a_replace_that_fails_leaves_no_temp_file(self, tmp_path, monkeypatch):
        def refuse(_src, _dst):
            raise OSError("locked")

        monkeypatch.setattr(applied.os, "replace", refuse)
        applied.record(tmp_path, [self._lesson()])
        assert list(tmp_path.iterdir()) == []


class TestTheQaFixerCarriesTheTasksLessons:
    """The fixer's prompt goes through the same entry point, with its spec dir."""

    async def _fixer_prompt(self, project: Path, spec: Path) -> str:
        from qa.fixer import run_qa_fixer_session

        class _Stop(Exception):
            pass

        class _Client:
            prompt = ""

            async def query(self, prompt: str) -> None:
                _Client.prompt = prompt
                raise _Stop  # the prompt is all this test needs

        (spec / "QA_FIX_REQUEST.md").write_text("fix it", encoding="utf-8")
        status, _ = await run_qa_fixer_session(_Client(), spec, 1, project_dir=project)
        assert status == "error"
        return _Client.prompt

    @pytest.mark.asyncio
    async def test_the_fixer_records_and_honours_a_turned_off_rule(
        self, vault, project
    ):
        rule_id = _adopt_rule(project)
        spec = _spec(project, "002-refunds")

        assert f"- {RULE}" in await self._fixer_prompt(project, spec)
        assert [(r["id"], r["agent"]) for r in applied.applied(spec)] == [
            (rule_id, "qa_fixer")
        ]

        _disable(spec, rule_id)
        assert f"- {RULE}" not in await self._fixer_prompt(project, spec)


class TestATurnedOffLessonLeavesTheTask:
    def test_a_disabled_rule_and_pattern_leave_later_prompts(self, vault, project):
        rule_id = _adopt_rule(project)
        pattern_id = _learn_pattern(project)
        spec = _spec(project, "002-refunds")
        get_learning_context(project, "coding", spec_dir=spec)
        _disable(spec, rule_id, pattern_id)

        context = get_learning_context(project, "coding", spec_dir=spec)

        assert RULE not in context and INSTRUCTION not in context
        assert applied.disabled_ids(spec) == {rule_id, pattern_id}

    def test_only_for_that_task(self, vault, project):
        rule_id = _adopt_rule(project)
        mine = _spec(project, "002-refunds")
        other = _spec(project, "003-invoices")
        get_learning_context(project, "coding", spec_dir=mine)
        _disable(mine, rule_id)

        assert f"- {RULE}" in get_learning_context(project, "coding", spec_dir=other)

    def test_the_apps_disabled_list_survives_a_record(self, vault, project):
        rule_id = _adopt_rule(project)
        spec = _spec(project, "002-refunds")
        get_learning_context(project, "coding", spec_dir=spec)
        _disable(spec, rule_id, "lp-000000000000")

        get_learning_context(project, "qa_review", spec_dir=spec)

        assert applied.disabled_ids(spec) == {rule_id, "lp-000000000000"}

    def test_a_malformed_disabled_list_is_ignored(self, tmp_path):
        (tmp_path / applied.APPLIED_FILE).write_text(
            json.dumps({"disabled": ["ok-1", 3, "../x", "a" * 81]}), encoding="utf-8"
        )
        assert applied.disabled_ids(tmp_path) == {"ok-1"}

    @pytest.mark.parametrize("content", ["{not json", "[]", '"text"'])
    def test_an_unreadable_file_reads_as_empty(self, tmp_path, content):
        (tmp_path / applied.APPLIED_FILE).write_text(content, encoding="utf-8")
        assert applied.disabled_ids(tmp_path) == frozenset()
        assert applied.applied(tmp_path) == []

    def test_a_symlinked_file_is_not_read(self, tmp_path):
        target = tmp_path / "elsewhere.json"
        target.write_text(json.dumps({"disabled": ["ok-1"]}), encoding="utf-8")
        spec = tmp_path / "spec"
        spec.mkdir()
        try:
            (spec / applied.APPLIED_FILE).symlink_to(target)
        except OSError:
            pytest.skip("symlinks are not available here")
        assert applied.disabled_ids(spec) == frozenset()


class TestKindHistory:
    @pytest.mark.parametrize(
        ("histories", "needs"),
        [
            # Two tasks are no history, however badly they went.
            ([["rejected", "rejected", "approved"]] * 2, False),
            # Three tasks approved at their first pass: nothing to say.
            ([["approved"]] * 3, False),
            # 2 passes on average.
            ([["rejected", "approved"]] * 3, True),
            # 1.33 passes on average, but 2 of 5 rejected first.
            ([["rejected", "approved"]] * 2 + [["approved"]] * 3, True),
            # 1.25 passes, 1 of 4 rejected first.
            ([["rejected", "approved"]] + [["approved"]] * 3, False),
        ],
    )
    def test_thresholds(self, project, histories, needs):
        for index, runs in enumerate(histories):
            _spec(project, f"{index:03d}-fix", kind="bug_fix", runs=runs)
        seen = kind_checkpoints.history(project, "bug_fix")
        assert seen.tasks == len(histories)
        assert seen.needs_checkpoints is needs

    def test_other_kinds_and_unfinished_tasks_do_not_count(self, project):
        for index in range(3):
            _spec(project, f"{index:03d}-feat", kind="feature", runs=["rejected"] * 3)
        _spec(project, "010-fix", kind="bug_fix")
        _spec(project, "011-fix", kind="bug_fix", runs=[])
        assert kind_checkpoints.history(project, "bug_fix").tasks == 0

    def test_the_current_task_is_left_out(self, project):
        specs = [
            _spec(
                project, f"{i:03d}-fix", kind="bug_fix", runs=["rejected", "approved"]
            )
            for i in range(3)
        ]
        assert kind_checkpoints.history(project, "bug_fix", exclude=specs[0]).tasks == 2

    def test_issue_types_are_named_without_unknown(self, project):
        for index in range(3):
            _spec(
                project,
                f"{index:03d}-fix",
                kind="bug_fix",
                runs=["rejected", "approved"],
            )
        assert kind_checkpoints.history(project, "bug_fix").issue_types == (
            "missing_test",
        )

    def test_an_unknown_kind_gets_nothing(self, project):
        assert kind_checkpoints.checkpoints_for(project, "docs", "spec_writer") == (
            [],
            None,
        )
        assert kind_checkpoints.checkpoints_for(project, None, "spec_writer") == (
            [],
            None,
        )

    def test_every_checkpoint_id_is_one_the_app_accepts(self):
        for kind, texts in kind_checkpoints.CHECKPOINTS.items():
            for index in range(1, len(texts) + 1):
                assert applied.LESSON_ID.match(f"checkpoint-{kind}-{index}")


class TestKindHistoryReadsOnlyWhatItCan:
    def test_an_unreadable_metadata_file_is_not_a_task_of_the_kind(self, project):
        spec = _spec(project, "001-fix", runs=["rejected", "approved"])
        (spec / "task_metadata.json").write_text("{not json", encoding="utf-8")
        assert kind_checkpoints.history(project, "bug_fix").tasks == 0

    def test_a_project_without_specs_has_no_history(self, tmp_path):
        assert kind_checkpoints.history(tmp_path, "bug_fix").tasks == 0

    def test_a_specs_folder_it_cannot_list_has_no_history(self, project, monkeypatch):
        _spec(project, "001-fix", kind="bug_fix", runs=["rejected"])

        def refuse(_self):
            raise PermissionError("denied")

        with monkeypatch.context() as patch:
            patch.setattr(Path, "iterdir", refuse)
            seen = kind_checkpoints.history(project, "bug_fix")
        assert seen.tasks == 0


class TestTheSpecGetsItsKindsCheckpoints:
    def _rough_history(self, project: Path, kind: str = "bug_fix") -> None:
        for index in range(3):
            _spec(project, f"{index:03d}-old", kind=kind, runs=["rejected", "approved"])

    def test_the_spec_writer_gets_them_with_the_numbers(self, vault, project):
        self._rough_history(project)
        spec = _spec(project, "010-crash", kind="bug_fix")

        block = learning_context_for(project, "spec_writer", spec)

        assert "## Checkpoints for bug fix specs in this repository" in block
        assert (
            "The last 3 bug fix tasks of this repository needed 2.0 QA passes" in block
        )
        assert "100% were rejected at their first pass" in block
        assert "(most frequent issue types: missing_test)" in block
        assert kind_checkpoints.CHECKPOINTS["bug_fix"][0] in block
        recorded = [r["id"] for r in applied.applied(spec) if r["kind"] == "checkpoint"]
        assert recorded == ["checkpoint-bug_fix-1", "checkpoint-bug_fix-2"]

    def test_a_smooth_history_adds_nothing(self, vault, project):
        for index in range(3):
            _spec(project, f"{index:03d}-old", kind="bug_fix", runs=["approved"])
        spec = _spec(project, "010-crash", kind="bug_fix")
        assert "Checkpoints" not in learning_context_for(project, "spec_writer", spec)

    def test_another_kind_history_does_not_count(self, vault, project):
        self._rough_history(project, kind="feature")
        spec = _spec(project, "010-crash", kind="bug_fix")
        assert "Checkpoints" not in learning_context_for(project, "spec_writer", spec)

    def test_a_disabled_checkpoint_leaves_the_spec(self, vault, project):
        self._rough_history(project)
        spec = _spec(project, "010-crash", kind="bug_fix")
        learning_context_for(project, "spec_writer", spec)
        _disable(spec, "checkpoint-bug_fix-1")

        block = learning_context_for(project, "spec_self_critique", spec)

        assert kind_checkpoints.CHECKPOINTS["bug_fix"][0] not in block
        assert kind_checkpoints.CHECKPOINTS["bug_fix"][1] in block

    def test_without_a_spec_dir_there_is_no_kind(self, vault, project):
        self._rough_history(project)
        assert "Checkpoints" not in learning_context_for(project, "spec_writer")

    def test_the_build_agents_do_not_get_checkpoints(self, vault, project):
        self._rough_history(project)
        spec = _spec(project, "010-crash", kind="bug_fix")
        assert "Checkpoints" not in get_learning_context(
            project, "coding", spec_dir=spec
        )
        assert "Checkpoints" not in context_for_agent(
            project, "pr_reviewer", spec_dir=spec
        )


class TestAnAgentCannotTurnLessonsOff:
    @pytest.mark.parametrize(
        "path",
        [
            "applied_lessons.json",
            ".workpilot/specs/001-x/applied_lessons.json",
            "APPLIED_LESSONS.JSON",
        ],
    )
    def test_the_write_hook_refuses_the_file(self, path, tmp_path):
        from security.path_guard import (
            protected_config_refusal,
            protected_config_target,
        )

        assert protected_config_target(path) is not None
        reason = protected_config_refusal(path, tmp_path)
        assert reason and "the person turned off" in reason

    def test_a_shell_write_is_refused_too(self):
        from security.config_write_validators import validate_security_config_writes

        allowed, _reason = validate_security_config_writes(
            "echo '{\"disabled\": []}' > .workpilot/specs/001-x/applied_lessons.json"
        )
        assert allowed is False
