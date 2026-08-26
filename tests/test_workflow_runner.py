"""Tests for executing the phases a resolved profile keeps.

The engine used to resolve eleven phases and execute three. These tests pin
down the half that was missing, and in particular the three things that were
declared and inert:

* the window a phase runs in comes from the **declared** order, so pruning a
  phase that bounds a window does not silently hand its work to the next one;
* `dispatch` is read at execution — `fresh-context` inherits nothing, and
  `sequential-reset` suppresses the roster rather than handing one over to a
  provider that will drop it;
* a phase that could not run reports *unknown*, never success.
"""

from __future__ import annotations

import asyncio
import os
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from workflows.runner import (  # noqa: E402
    BUILTIN_EXECUTORS,
    PhaseContext,
    PhaseOutcome,
    builtin_plan,
    effort_preamble,
    find_skill_body,
    fresh_context,
    phases_between,
    run_skill_phase,
    subagents_allowed,
)

from workflows import load_workflow, resolve_profile  # noqa: E402

WORKFLOW_PATH = REPO_ROOT / "workflows" / "feature-build" / "workflow.yaml"


@pytest.fixture
def workflow():
    return load_workflow(WORKFLOW_PATH)


def profile_at(workflow, effort: str, **kwargs):
    return resolve_profile(workflow, effort, **kwargs)


class TestPhaseWindows:
    """Which phases run where, taken from the file rather than from Python."""

    def test_the_windows_partition_the_skill_phases(self, workflow):
        profile = profile_at(workflow, "ultrathink")
        pre = phases_between(profile, after=None, before="planning")
        mid = phases_between(profile, after="coding", before="qa")
        post = phases_between(profile, after="qa", before=None)

        assert [r.id for r in pre] == ["brainstorm", "spec"]
        assert [r.id for r in mid] == ["review"]
        assert [r.id for r in post] == [
            "adversarial-review",
            "spec-conformance",
            "verify",
        ]

    def test_no_phase_is_run_by_two_windows(self, workflow):
        profile = profile_at(workflow, "ultrathink")
        seen = [
            r.id
            for window in (
                phases_between(profile, after=None, before="planning"),
                phases_between(profile, after="coding", before="qa"),
                phases_between(profile, after="qa", before=None),
            )
            for r in window
        ]
        assert len(seen) == len(set(seen))

    def test_a_pruned_boundary_still_marks_its_position(self, workflow):
        """The regression this exists for.

        `qa` is prunable. Looking the boundary up in what survived resolution
        would make `before="qa"` mean "to the end of the list" on a build with
        no QA pass, so `review` and the two ultrathink readings would all run
        in the pre-QA window — and then again in the post-QA one.
        """
        profile = profile_at(workflow, "ultrathink")
        profile.run = [r for r in profile.run if r.id != "qa"]
        assert "qa" not in [r.id for r in profile.run]
        assert "qa" in profile.declared

        mid = phases_between(profile, after="coding", before="qa")
        post = phases_between(profile, after="qa", before=None)
        assert [r.id for r in mid] == ["review"]
        assert [r.id for r in post] == [
            "adversarial-review",
            "spec-conformance",
            "verify",
        ]

    def test_phases_owned_by_another_executor_are_stepped_over(self, workflow):
        profile = profile_at(workflow, "ultrathink")
        every_window = [
            r.id
            for window in (
                phases_between(profile, after=None, before="planning"),
                phases_between(profile, after="coding", before="qa"),
                phases_between(profile, after="qa", before=None),
            )
            for r in window
        ]
        # WorkPilot's own implementations, the deterministic gate and the
        # observer each have an executor of their own.
        assert "planning" not in every_window
        assert "coding" not in every_window
        assert "qa" not in every_window
        assert "design-check" not in every_window
        assert "observe" not in every_window

    def test_low_effort_leaves_the_windows_empty_except_what_it_bought(self, workflow):
        profile = profile_at(workflow, "low")
        pre = phases_between(profile, after=None, before="planning")
        mid = phases_between(profile, after="coding", before="qa")
        post = phases_between(profile, after="qa", before=None)
        assert pre == []
        assert mid == []
        # `verify` is a hard gate: never pruned, at any level.
        assert [r.id for r in post] == ["verify"]

    def test_every_builtin_phase_named_here_exists_in_the_workflow(self, workflow):
        declared = {p.id for p in workflow.phases}
        for phase_id in BUILTIN_EXECUTORS:
            assert phase_id in declared, f"{phase_id} is not a phase of the workflow"

    def test_builtins_are_recognised_by_id_not_by_implementation(self, workflow):
        """`coding` names a superpowers skill and is run by the coder loop.

        Keying the builtin set on the impl string would mean swapping the
        methodology in the YAML silently demotes `coding` to a one-shot skill
        session — losing the entire coder loop to a one-line edit.
        """
        coding = workflow.phase("coding")
        assert coding.impl == "superpowers/test-driven-development"
        assert "coding" in BUILTIN_EXECUTORS
        assert coding.impl not in BUILTIN_EXECUTORS


class TestDispatchIsRead:
    def test_sequential_reset_suppresses_the_roster(self):
        assert subagents_allowed("subagent-per-task") is True
        assert subagents_allowed("inline") is True
        assert subagents_allowed("fresh-context") is True
        assert subagents_allowed("sequential-reset") is False

    def test_only_fresh_context_starts_from_nothing(self):
        assert fresh_context("fresh-context") is True
        for other in ("inline", "subagent-per-task", "sequential-reset"):
            assert fresh_context(other) is False

    def test_the_reviewer_runs_in_a_fresh_context(self, workflow):
        profile = profile_at(workflow, "high")
        review = next(r for r in profile.run if r.id == "review")
        assert fresh_context(review.dispatch)


class TestBuiltinPlan:
    def test_no_profile_keeps_the_previous_behaviour(self):
        plan = builtin_plan(None)
        assert plan.planning_runs is True
        assert plan.use_subagents is True
        assert plan.coding_dispatch == "inline"

    def test_it_reads_the_coding_dispatch(self, workflow):
        plan = builtin_plan(profile_at(workflow, "high"))
        assert plan.coding_dispatch == "subagent-per-task"
        assert plan.use_subagents is True

    def test_a_degraded_provider_loses_the_roster(self, workflow, monkeypatch):
        import skills_registry.providers as providers

        monkeypatch.setattr(
            providers,
            "get_provider_capabilities",
            lambda name: types.SimpleNamespace(supports_subagents=False),
        )
        plan = builtin_plan(profile_at(workflow, "high", provider="mistral"))
        assert plan.coding_dispatch == "sequential-reset"
        assert plan.coding_degraded_from == "subagent-per-task"
        assert plan.use_subagents is False

    def test_a_malformed_profile_falls_back_rather_than_raising(self):
        plan = builtin_plan(object())
        assert plan.planning_runs is True
        assert plan.use_subagents is True


class TestEffortInjection:
    def test_the_engine_states_the_level(self, workflow):
        plan = builtin_plan(profile_at(workflow, "ultrathink"))
        text = effort_preamble(plan, "coding")
        assert "EFFORT: ultrathink" in text
        assert "WORKFLOW PHASE: coding" in text

    def test_a_degradation_is_explained_not_hidden(self, workflow, monkeypatch):
        import skills_registry.providers as providers

        monkeypatch.setattr(
            providers,
            "get_provider_capabilities",
            lambda name: types.SimpleNamespace(supports_subagents=False),
        )
        plan = builtin_plan(profile_at(workflow, "high", provider="deepseek"))
        text = effort_preamble(plan, "coding")
        assert "sequential-reset" in text
        assert "subagent-per-task" in text
        assert "do not attempt to dispatch" in text

    def test_the_planning_phase_gets_no_dispatch_line(self, workflow):
        plan = builtin_plan(profile_at(workflow, "high"))
        assert "DISPATCH" not in effort_preamble(plan, "planning")


class TestMethodologyReachesTheBuiltins:
    """The `impl:` of `coding` used to be decoration. It is not any more."""

    def test_the_declared_methodology_is_named(self, workflow):
        plan = builtin_plan(profile_at(workflow, "high"))
        assert "superpowers/test-driven-development" in effort_preamble(plan, "coding")

    def test_workpilots_own_implementation_is_not_announced_as_a_methodology(
        self, workflow
    ):
        plan = builtin_plan(profile_at(workflow, "high"))
        assert "METHODOLOGY" not in effort_preamble(plan, "planning")

    def test_a_materialised_skill_is_pointed_at_rather_than_inlined(
        self, workflow, tmp_path
    ):
        body = "Red, green, refactor. " * 500
        _write_skill(tmp_path, "test-driven-development", body)
        plan = builtin_plan(profile_at(workflow, "high"))
        text = effort_preamble(plan, "coding", tmp_path)
        assert ".agents/skills/test-driven-development/SKILL.md" in text
        # A ten-kilobyte procedure pasted into every subtask prompt is a
        # four-figure token bill per build to say what one line can.
        assert body not in text
        assert len(text) < 800

    def test_an_unvendored_methodology_is_silent_not_a_broken_pointer(
        self, workflow, tmp_path
    ):
        plan = builtin_plan(profile_at(workflow, "high"))
        text = effort_preamble(plan, "coding", tmp_path)
        assert "SKILL.md" not in text
        assert "superpowers/test-driven-development" in text


class TestSkillLookup:
    def _write(self, path: Path, body: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            f"---\nname: {path.parent.name}\ndescription: d\n---\n\n{body}\n",
            encoding="utf-8",
        )

    def test_the_built_output_wins_over_the_source(self, tmp_path):
        self._write(tmp_path / ".agents" / "skills" / "s" / "SKILL.md", "built")
        self._write(tmp_path / "skills" / "p" / "s" / "SKILL.md", "source")
        body, path = find_skill_body(tmp_path, "p", "s")
        assert "built" in body
        assert ".agents" in str(path)

    def test_the_source_is_the_fallback_for_an_unbuilt_checkout(self, tmp_path):
        self._write(tmp_path / "skills" / "p" / "s" / "SKILL.md", "source")
        body, _path = find_skill_body(tmp_path, "p", "s")
        assert "source" in body

    def test_a_missing_skill_is_reported_not_invented(self, tmp_path):
        assert find_skill_body(tmp_path, "p", "s") is None

    def test_a_skill_with_an_empty_body_does_not_count(self, tmp_path):
        self._write(tmp_path / "skills" / "p" / "s" / "SKILL.md", "   ")
        assert find_skill_body(tmp_path, "p", "s") is None


class TestRunSkillPhase:
    def _ctx(self, tmp_path: Path) -> PhaseContext:
        spec = tmp_path / "spec"
        spec.mkdir(parents=True, exist_ok=True)
        return PhaseContext(
            project_dir=tmp_path,
            spec_dir=spec,
            model="claude-sonnet-4-5",
            repo_root=tmp_path,
            effort="high",
        )

    def test_a_missing_implementation_is_unknown_never_success(
        self, workflow, tmp_path
    ):
        profile = profile_at(workflow, "high")
        review = next(r for r in profile.run if r.id == "review")
        outcome = asyncio.run(run_skill_phase(review, self._ctx(tmp_path)))
        assert outcome.succeeded is None
        assert "skills:bootstrap" in outcome.detail

    def test_fresh_context_does_not_consume_the_resume_marker(
        self, workflow, tmp_path, monkeypatch
    ):
        """A review must inherit nothing — and must not eat the coder's resume.

        The resume id is a process-wide env var consumed inside create_client.
        A phase that starts fresh has to lift it for the duration of its own
        call and put it back, or the next coder iteration silently loses the
        transcript it was going to rehydrate.
        """
        seen = {}
        _install_fake_agent_stack(monkeypatch, seen)
        _write_skill(tmp_path, "code-review", "Read the diff.")

        monkeypatch.setenv("AUTO_CLAUDE_RESUME_SESSION_ID", "sess-42")
        profile = profile_at(workflow, "high")
        review = next(r for r in profile.run if r.id == "review")

        outcome = asyncio.run(run_skill_phase(review, self._ctx(tmp_path)))

        assert outcome.succeeded is True
        assert seen["resume_visible_during_call"] is False
        assert os.environ.get("AUTO_CLAUDE_RESUME_SESSION_ID") == "sess-42"

    def test_the_prompt_carries_the_effort_and_the_procedure(
        self, workflow, tmp_path, monkeypatch
    ):
        seen = {}
        _install_fake_agent_stack(monkeypatch, seen)
        _write_skill(tmp_path, "code-review", "Look for defects, not for style.")

        profile = profile_at(workflow, "high")
        review = next(r for r in profile.run if r.id == "review")
        asyncio.run(run_skill_phase(review, self._ctx(tmp_path)))

        prompt = seen["prompt"]
        assert "EFFORT: high" in prompt
        assert "Look for defects, not for style." in prompt
        assert "Tests: pass" in prompt  # the hard gate's vocabulary

    def test_a_degraded_phase_does_not_ask_for_a_roster(
        self, workflow, tmp_path, monkeypatch
    ):
        import skills_registry.providers as providers

        monkeypatch.setattr(
            providers,
            "get_provider_capabilities",
            lambda name: types.SimpleNamespace(supports_subagents=False),
        )
        seen = {}
        _install_fake_agent_stack(monkeypatch, seen)
        _write_skill(tmp_path, "test-driven-development", "Red, green, refactor.")

        profile = profile_at(workflow, "high", provider="mistral")
        coding = next(r for r in profile.run if r.id == "coding")
        # `coding` is a builtin, so drive the check through run_skill_phase by
        # asking it directly: the dispatch value is what matters here.
        assert coding.dispatch == "sequential-reset"
        assert subagents_allowed(coding.dispatch) is False

    def test_a_session_error_is_a_failure_not_an_unknown(
        self, workflow, tmp_path, monkeypatch
    ):
        seen = {}
        _install_fake_agent_stack(monkeypatch, seen, status="error")
        _write_skill(tmp_path, "code-review", "Read the diff.")

        profile = profile_at(workflow, "high")
        review = next(r for r in profile.run if r.id == "review")
        outcome = asyncio.run(run_skill_phase(review, self._ctx(tmp_path)))
        assert outcome.succeeded is False

    def test_the_output_is_kept_where_the_next_phase_can_read_it(
        self, workflow, tmp_path, monkeypatch
    ):
        seen = {}
        _install_fake_agent_stack(monkeypatch, seen, response="Tests: pass")
        _write_skill(tmp_path, "verification-before-completion", "Run the suite.")

        profile = profile_at(workflow, "high")
        verify = next(r for r in profile.run if r.id == "verify")
        outcome = asyncio.run(run_skill_phase(verify, self._ctx(tmp_path)))

        assert outcome.output_path is not None
        assert outcome.output_path.name == "verify.md"
        assert "Tests: pass" in outcome.output_path.read_text(encoding="utf-8")


class TestOutcomeReporting:
    def test_unknown_reads_as_unknown(self):
        o = PhaseOutcome("review", "m/code-review", "fresh-context", None, "no skill")
        assert o.describe().strip().startswith("?")

    def test_failure_and_success_are_distinguishable(self):
        ok = PhaseOutcome("review", "m/code-review", "inline", True)
        bad = PhaseOutcome("review", "m/code-review", "inline", False)
        assert "✓" in ok.describe()
        assert "✗" in bad.describe()


# ---------------------------------------------------------------------------
# Fakes. The point of a skill phase is that it starts a session; the point of
# these tests is everything around that, so the session is stubbed rather than
# a live provider being required.
# ---------------------------------------------------------------------------


def _write_skill(root: Path, name: str, body: str) -> None:
    path = root / ".agents" / "skills" / name / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"---\nname: {name}\ndescription: d\n---\n\n{body}\n", encoding="utf-8"
    )


def _install_fake_agent_stack(
    monkeypatch, seen: dict, *, status="complete", response="done"
):
    import core.client as core_client

    class _FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    def _fake_create(**kwargs):
        seen.update(kwargs)
        seen["resume_visible_during_call"] = (
            "AUTO_CLAUDE_RESUME_SESSION_ID" in os.environ
        )
        return _FakeClient()

    async def _fake_session(client, message, spec_dir, verbose, phase=None, **_kw):
        seen["prompt"] = message
        return status, response, {}

    monkeypatch.setattr(core_client, "create_agent_client", _fake_create)

    import agents.session as agent_session

    monkeypatch.setattr(agent_session, "run_agent_session", _fake_session)
