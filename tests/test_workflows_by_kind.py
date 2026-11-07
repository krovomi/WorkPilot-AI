"""One workflow per task kind, chosen by the engine (kanban-task-types, lot 1).

Four properties:

* every kind maps to a workflow file that loads, and an unknown kind gets the
  pipeline every card used to get;
* every implementation — and every fallback — a workflow names resolves on a
  fresh clone, at every effort, for every provider: the profile printed before
  a build is never a plan nobody executes;
* a phase whose `impl` is missing and whose `fallback` is installed runs the
  fallback, and the profile says so; nothing is substituted in silence;
* every skill phase of every workflow belongs to exactly one of the build's
  windows, including on workflows that do not declare the boundaries the
  windows are named by.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from workflows.engine import ResolvedPhase  # noqa: E402
from workflows.hard_gates import (  # noqa: E402
    TESTS_UNCHANGED,
    evaluate_hard_gates,
    is_test_file,
)
from workflows.registry import (  # noqa: E402
    DEFAULT_WORKFLOW,
    WORKFLOW_BY_KIND,
    load_workflow_for_spec,
    workflow_for,
    workflow_for_spec,
    workflow_name_for,
)
from workflows.runner import (  # noqa: E402
    BUILTIN_EXECUTORS,
    CONFIG_PHASE,
    SKILL_PHASE_AGENTS,
    phases_between,
)
from workflows.spec import Phase, WorkflowError  # noqa: E402

from workflows import (  # noqa: E402
    EFFORT_ORDER,
    load_workflow,
    pack_inventory,
    resolve_profile,
    validate_impls,
)

WORKFLOWS = sorted(
    p.parent.name for p in (REPO_ROOT / "workflows").glob("*/workflow.yaml")
)
WINDOWS = (
    (None, "planning"),
    ("planning", "coding"),
    ("coding", "qa"),
    ("qa", None),
)
ELSEWHERE = {"design-check", "observe"}


def _providers() -> list[str]:
    from skills_registry.providers import load_providers

    return sorted(load_providers(REPO_ROOT))


@pytest.fixture(scope="module")
def inventory():
    from skills_registry.packs import load_packs

    return pack_inventory(load_packs(REPO_ROOT / "skills"))


def _load(name: str):
    return load_workflow(REPO_ROOT / "workflows" / name / "workflow.yaml")


def write_workflow(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "workflow.yaml"
    p.write_text(body, encoding="utf-8")
    return p


# ---------------------------------------------------------------------------
# The registry
# ---------------------------------------------------------------------------


class TestRegistry:
    def test_every_kind_has_a_workflow_that_loads(self):
        from tasks.classify import TaskKind

        for kind in TaskKind:
            path = workflow_for(kind, REPO_ROOT)
            assert path.is_file(), f"{kind.value}: no {path}"
            assert load_workflow(path).name == path.parent.name

    def test_every_workflow_on_disk_is_reachable_from_a_kind(self):
        """A `workflows/<name>/` no kind maps to is a file nobody runs."""
        assert set(WORKFLOWS) == set(WORKFLOW_BY_KIND.values())

    @pytest.mark.parametrize("kind", [None, "", "nonsense", 42, object()])
    def test_an_unknown_kind_gets_the_default(self, kind):
        assert workflow_name_for(kind) == DEFAULT_WORKFLOW

    def test_the_enum_and_its_value_agree(self):
        from tasks.classify import TaskKind

        assert workflow_name_for(TaskKind.BUG_FIX) == workflow_name_for("bug_fix")
        assert workflow_name_for(TaskKind.BUG_FIX) == "bug-fix"

    def test_a_spec_is_routed_by_its_recorded_kind(self, tmp_path):
        from tasks.classify import TaskKind, classify
        from tasks.metadata import record_kind

        record_kind(tmp_path, classify("Fix crash on login", "", {}))
        assert workflow_for_spec(tmp_path, REPO_ROOT).parent.name == workflow_name_for(
            TaskKind.BUG_FIX
        )

    def test_a_spec_with_no_kind_gets_the_default(self, tmp_path):
        assert workflow_for_spec(tmp_path, REPO_ROOT).parent.name == DEFAULT_WORKFLOW

    def test_a_spec_with_unreadable_metadata_gets_the_default(self, tmp_path):
        (tmp_path / "task_metadata.json").write_text("{not json", encoding="utf-8")
        assert workflow_for_spec(tmp_path, REPO_ROOT).parent.name == DEFAULT_WORKFLOW

    def test_a_broken_kind_workflow_falls_back_to_the_default(self, tmp_path):
        """A malformed specialised workflow must not stop a build the default
        pipeline can run — and the fallback is logged, not silent."""
        root = tmp_path / "repo"
        for name in (DEFAULT_WORKFLOW, "bug-fix"):
            (root / "workflows" / name).mkdir(parents=True)
        (root / "workflows" / DEFAULT_WORKFLOW / "workflow.yaml").write_text(
            "phases:\n  - id: coding\n    impl: workpilot/coder\n", encoding="utf-8"
        )
        (root / "workflows" / "bug-fix" / "workflow.yaml").write_text(
            "phases: []\n", encoding="utf-8"
        )
        spec = tmp_path / "spec"
        spec.mkdir()
        (spec / "task_metadata.json").write_text(
            '{"kind": "bug_fix"}', encoding="utf-8"
        )
        assert load_workflow_for_spec(spec, root).name == DEFAULT_WORKFLOW

    def test_a_broken_default_workflow_is_fatal(self, tmp_path):
        root = tmp_path / "repo"
        (root / "workflows" / DEFAULT_WORKFLOW).mkdir(parents=True)
        (root / "workflows" / DEFAULT_WORKFLOW / "workflow.yaml").write_text(
            "phases: []\n", encoding="utf-8"
        )
        with pytest.raises(WorkflowError):
            load_workflow_for_spec(tmp_path / "spec", root)


# ---------------------------------------------------------------------------
# Every workflow, honest everywhere
# ---------------------------------------------------------------------------


class TestEveryWorkflow:
    @pytest.mark.parametrize("name", WORKFLOWS)
    def test_it_loads_and_names_itself(self, name):
        assert _load(name).name == name

    @pytest.mark.parametrize("name", WORKFLOWS)
    @pytest.mark.parametrize("effort", EFFORT_ORDER)
    def test_every_phase_that_runs_has_its_implementation(
        self, name, effort, inventory
    ):
        """On a fresh clone: no bootstrap, no `_bmad/`, nothing vendored."""
        workflow = _load(name)
        available, gated = inventory
        profile = resolve_profile(workflow, effort, changed_files=None)
        missing = [
            f"{m.phase_id}: {m.reason}"
            for m in validate_impls(workflow, available, gated=gated)
            if profile.will_run(m.phase_id)
        ]
        assert missing == []

    @pytest.mark.parametrize("name", WORKFLOWS)
    def test_every_fallback_resolves_too(self, name, inventory):
        """A fallback that is not on disk is a hole the profile cannot fill."""
        available, gated = inventory
        for phase in _load(name).phases:
            if phase.fallback:
                pack, _, skill = phase.fallback.partition("/")
                if pack == "workpilot":
                    continue  # WorkPilot's own Python, not a skill on disk
                assert skill in available.get(pack, set()), (name, phase.id)

    @pytest.mark.parametrize("name", WORKFLOWS)
    @pytest.mark.parametrize("provider", _providers())
    def test_it_resolves_on_every_provider(self, name, provider, monkeypatch):
        monkeypatch.setenv("OPENAI_AUTH_MODE", "api-key")
        profile = resolve_profile(_load(name), "high", provider=provider)
        assert profile.run, (name, provider)
        for resolved in profile.run:
            assert resolved.dispatch in {
                "inline",
                "fresh-context",
                "subagent-per-task",
                "sequential-reset",
            }

    @pytest.mark.parametrize("name", WORKFLOWS)
    def test_every_agent_and_roster_it_names_exists(self, name):
        from agents.tools_pkg.models import AGENT_CONFIGS
        from subagents.phases import ROSTERS

        for phase in _load(name).phases:
            if phase.agent:
                assert phase.agent in AGENT_CONFIGS, (name, phase.id, phase.agent)
            if phase.roster:
                assert phase.roster in ROSTERS, (name, phase.id, phase.roster)
            if phase.id in BUILTIN_EXECUTORS or phase.id in ELSEWHERE:
                continue
            # A skill phase runs under the agent the runner's table names,
            # or the one it declares; both must exist.
            agent = phase.agent or SKILL_PHASE_AGENTS.get(phase.id, "analyzer")
            assert agent in AGENT_CONFIGS, (name, phase.id, agent)

    @pytest.mark.parametrize("name", WORKFLOWS)
    def test_every_phase_is_paid_for_as_a_known_config_phase(self, name):
        for phase in _load(name).phases:
            if phase.id in BUILTIN_EXECUTORS or phase.id in ELSEWHERE:
                continue
            assert phase.id in CONFIG_PHASE, (name, phase.id)

    @pytest.mark.parametrize("name", WORKFLOWS)
    def test_every_skill_phase_belongs_to_exactly_one_window(self, name):
        """Declared, resolved, printed — and run by nobody, or by two windows.

        The windows are named by `planning`, `coding` and `qa`; a workflow
        that declares none of them (investigation, run) or only some (docs,
        spike) must still hand each skill phase to one window.
        """
        profile = resolve_profile(_load(name), "ultrathink", changed_files=None)
        seen = [
            r.id
            for after, before in WINDOWS
            for r in phases_between(profile, after=after, before=before)
        ]
        expected = {
            r.id
            for r in profile.run
            if r.id not in BUILTIN_EXECUTORS and r.id not in ELSEWHERE
        }
        assert set(seen) == expected, name
        assert len(seen) == len(set(seen)), f"{name}: a phase runs twice"

    @pytest.mark.parametrize("name", WORKFLOWS)
    def test_a_reporting_phase_has_a_reader_or_is_the_deliverable(self, name):
        """Every token has a reader (principle 5 of the plan).

        A skill phase declared after the last builtin consumer has no agent
        reading its report; that is allowed only when the report *is* what
        the task delivers — the phases the kind's workflow is built around.
        """
        from workflows.handoff import CONSUMERS

        workflow = _load(name)
        ids = [p.id for p in workflow.phases]
        last_consumer = max((ids.index(c) for c in CONSUMERS if c in ids), default=-1)
        deliverables = {"investigate", "procedure", "execute", "verdict", "proofread"}
        # `cross-review` is read by the pull request step, which holds a
        # disagreement back (`cross_review.blocking_verdict`).
        allowed_after = {"architecture-map", "verify-replay", "cross-review", "observe"}
        for i, phase in enumerate(workflow.phases):
            if i > last_consumer and phase.id not in BUILTIN_EXECUTORS:
                assert phase.id in deliverables | allowed_after, (name, phase.id)

    def test_a_workflow_that_asks_for_no_code_says_so(self):
        from cli.build_commands import _workflow_writes_code

        for name in WORKFLOWS:
            profile = resolve_profile(_load(name), "medium")
            writes = _workflow_writes_code(profile)
            assert writes == (name not in {"investigation", "run"}), name
        assert _workflow_writes_code(None) is True

    def test_the_kinds_that_write_code_keep_planning_and_coding(self):
        """The coder loop plans on its first run whatever the profile says,
        so a workflow that starts it must declare both phases: a workflow
        that announced coding without planning would describe a build that
        does not exist."""
        for name in WORKFLOWS:
            ids = {p.id for p in _load(name).phases}
            if ids & {"planning", "coding"}:
                assert {"planning", "coding"} <= ids, name

    def test_the_kind_specific_phases_are_never_pruned(self):
        """The phase a kind is built around runs at every effort."""
        for name, phase_id in (
            ("bug-fix", "reproduce"),
            ("hotfix", "reproduce"),
            ("hotfix", "review"),
            ("investigation", "investigate"),
            ("run", "procedure"),
            ("docs", "proofread"),
            ("spike", "verdict"),
            ("spike", "brainstorm"),
        ):
            for effort in EFFORT_ORDER:
                profile = resolve_profile(_load(name), effort)
                assert profile.will_run(phase_id), (name, phase_id, effort)

    def test_a_refactoring_promises_its_tests_unchanged(self):
        verify = _load("refactoring").phase("verify")
        assert TESTS_UNCHANGED in (verify.hard_gate or "")

    def test_the_run_workflow_executes_behind_an_irreversible_gate(self):
        """Lot 3: the executor exists, and the phase that runs it is declared
        irreversible so the build stops before it until a person resumes."""
        wf = _load("run")
        ids = [p.id for p in wf.phases]
        assert ids == ["procedure", "execute", "observe"]
        assert wf.phase("procedure").gate == "human"
        assert wf.phase("execute").irreversible is True

    def test_the_run_and_investigation_phases_write_no_code(self):
        """An investigation reads only; the operator may run an allowlisted
        command to check a precondition but never edits a file."""
        from agents.tools_pkg.models import AGENT_CONFIGS

        investigate = _load("investigation").phase("investigate")
        agent = investigate.agent or SKILL_PHASE_AGENTS.get("investigate", "analyzer")
        assert not set(AGENT_CONFIGS[agent]["tools"]) & {"Write", "Edit", "Bash"}
        procedure = _load("run").phase("procedure")
        agent = procedure.agent or SKILL_PHASE_AGENTS.get("procedure", "analyzer")
        assert agent == "operator"
        assert not set(AGENT_CONFIGS[agent]["tools"]) & {"Write", "Edit"}

    def test_the_skills_the_workflows_name_are_emitted(self):
        """`.agents/skills/` is what the build reads; `skills:build --check`
        keeps it in step, this keeps the five new procedures on that path."""
        for skill in (
            "reproduce",
            "investigate",
            "runbook",
            "proofread",
            "spike-verdict",
        ):
            assert (REPO_ROOT / ".agents" / "skills" / skill / "SKILL.md").is_file()
            assert (REPO_ROOT / "skills" / "tooling" / skill / "SKILL.md").is_file()


# ---------------------------------------------------------------------------
# `fallback:` and `irreversible:` in the spec
# ---------------------------------------------------------------------------


class TestSpecFields:
    def test_fallback_and_irreversible_are_read(self, tmp_path):
        path = write_workflow(
            tmp_path,
            "phases:\n"
            "  - id: prd\n"
            "    impl: bmad/bmad-create-prd\n"
            "    fallback: workpilot/spec\n"
            "  - id: execute\n"
            "    impl: tooling/execute-runbook\n"
            "    irreversible: true\n",
        )
        workflow = load_workflow(path)
        assert workflow.phase("prd").fallback == "workpilot/spec"
        assert workflow.phase("prd").irreversible is False
        assert workflow.phase("execute").fallback is None
        assert workflow.phase("execute").irreversible is True

    def test_only_a_run_execution_is_irreversible(self):
        """`irreversible` is off everywhere but on the one phase that acts on
        something a discarded branch cannot undo (lot 3)."""
        for name in WORKFLOWS:
            for phase in _load(name).phases:
                expected = name == "run" and phase.id == "execute"
                assert phase.irreversible is expected, (name, phase.id)

    @pytest.mark.parametrize(
        "body,message",
        [
            (
                "phases:\n  - id: a\n    impl: p/s\n    fallback: nopack\n",
                "fallback",
            ),
            (
                "phases:\n  - id: a\n    impl: p/s\n    fallback: p/s\n",
                "impl itself",
            ),
            (
                "phases:\n  - id: a\n    impl: p/s\n    irreversible: yes please\n",
                "irreversible",
            ),
        ],
    )
    def test_a_malformed_field_is_fatal(self, tmp_path, body, message):
        with pytest.raises(WorkflowError, match=message):
            load_workflow(write_workflow(tmp_path, body))

    def test_with_impl_keeps_everything_but_the_impl(self):
        phase = Phase(
            id="prd",
            impl="bmad/bmad-create-prd",
            fallback="workpilot/spec",
            agent="spec_critic",
            roster="spec",
            gate="human",
        )
        played = phase.with_impl(phase.fallback)
        assert played.impl == "workpilot/spec"
        assert played.fallback is None
        assert (played.id, played.agent, played.roster, played.gate) == (
            "prd",
            "spec_critic",
            "spec",
            "human",
        )


# ---------------------------------------------------------------------------
# Substitution in the engine
# ---------------------------------------------------------------------------

_WITH_FALLBACK = (
    "phases:\n"
    "  - id: brainstorm\n"
    "    impl: bmad/bmad-brainstorming\n"
    "    fallback: tooling/brainstorm-approaches\n"
    "  - id: coding\n"
    "    impl: tooling/tdd-cycle\n"
)


class TestSubstitution:
    def _inventory(self, *, bmad: bool):
        available = {"tooling": {"brainstorm-approaches", "tdd-cycle"}}
        if bmad:
            available["bmad"] = {"bmad-brainstorming"}
        return available, frozenset()

    def test_a_missing_impl_with_an_installed_fallback_runs_the_fallback(
        self, tmp_path
    ):
        workflow = load_workflow(write_workflow(tmp_path, _WITH_FALLBACK))
        profile = resolve_profile(
            workflow, "high", inventory=self._inventory(bmad=False)
        )
        brainstorm = next(r for r in profile.run if r.id == "brainstorm")
        assert brainstorm.impl == "tooling/brainstorm-approaches"
        assert brainstorm.phase.impl == "tooling/brainstorm-approaches"
        assert brainstorm.substituted_from == "bmad/bmad-brainstorming"
        assert "not installed" in brainstorm.substitution_reason

    def test_an_installed_impl_is_not_substituted(self, tmp_path):
        workflow = load_workflow(write_workflow(tmp_path, _WITH_FALLBACK))
        profile = resolve_profile(
            workflow, "high", inventory=self._inventory(bmad=True)
        )
        brainstorm = next(r for r in profile.run if r.id == "brainstorm")
        assert brainstorm.impl == "bmad/bmad-brainstorming"
        assert brainstorm.substituted_from is None

    def test_without_an_inventory_nothing_is_substituted(self, tmp_path):
        """The runner decides at run time, against the target project."""
        workflow = load_workflow(write_workflow(tmp_path, _WITH_FALLBACK))
        profile = resolve_profile(workflow, "high")
        brainstorm = next(r for r in profile.run if r.id == "brainstorm")
        assert brainstorm.impl == "bmad/bmad-brainstorming"
        assert brainstorm.substituted_from is None

    def test_the_profile_says_what_it_substituted(self, tmp_path):
        workflow = load_workflow(write_workflow(tmp_path, _WITH_FALLBACK))
        profile = resolve_profile(
            workflow, "high", inventory=self._inventory(bmad=False)
        )
        text = profile.describe()
        assert "tooling/brainstorm-approaches" in text
        assert "for bmad/bmad-brainstorming" in text
        assert "not installed" in text

    def test_validate_impls_is_quiet_when_the_fallback_resolves(self, tmp_path):
        workflow = load_workflow(write_workflow(tmp_path, _WITH_FALLBACK))
        available, gated = self._inventory(bmad=False)
        assert validate_impls(workflow, available, gated=gated) == []

    def test_validate_impls_reports_both_when_neither_resolves(self, tmp_path):
        workflow = load_workflow(write_workflow(tmp_path, _WITH_FALLBACK))
        missing = validate_impls(workflow, {"tooling": {"tdd-cycle"}})
        assert [m.phase_id for m in missing] == ["brainstorm"]
        assert "bmad" in missing[0].reason
        assert "fallback tooling/brainstorm-approaches" in missing[0].reason

    def test_a_missing_fallback_does_not_stand_in(self, tmp_path):
        """Standing a missing implementation in for another missing one would
        hide the gap `validate_impls` exists to show."""
        workflow = load_workflow(write_workflow(tmp_path, _WITH_FALLBACK))
        profile = resolve_profile(
            workflow, "high", inventory=({"tooling": {"tdd-cycle"}}, frozenset())
        )
        brainstorm = next(r for r in profile.run if r.id == "brainstorm")
        assert brainstorm.impl == "bmad/bmad-brainstorming"
        assert brainstorm.substituted_from is None

    def test_the_substituted_phase_still_degrades_by_provider(self, tmp_path):
        body = (
            "phases:\n"
            "  - id: coding\n"
            "    impl: bmad/bmad-dev-story\n"
            "    fallback: tooling/tdd-cycle\n"
            "    dispatch: subagent-per-task\n"
        )
        workflow = load_workflow(write_workflow(tmp_path, body))
        inventory = ({"tooling": {"tdd-cycle"}}, frozenset())
        profile = resolve_profile(
            workflow, "high", provider="opencode", inventory=inventory
        )
        coding = profile.run[0]
        assert coding.impl == "tooling/tdd-cycle"
        assert coding.dispatch == "sequential-reset"
        assert coding.substituted_from == "bmad/bmad-dev-story"


# ---------------------------------------------------------------------------
# Substitution in the runner, against the target project
# ---------------------------------------------------------------------------


def _write_skill(root: Path, name: str, body: str, *, runtime: str | None = None):
    path = root / ".agents" / "skills" / name / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    gate = (
        ""
        if runtime is None
        else f'metadata:\n  workpilot:\n    requires: {{ runtime: "{runtime}" }}\n'
    )
    path.write_text(
        f"---\nname: {name}\ndescription: d\n{gate}---\n\n{body}\n", encoding="utf-8"
    )


class TestRuntimeFallback:
    def _ctx(self, tmp_path: Path):
        from workflows import PhaseContext

        spec = tmp_path / "spec"
        spec.mkdir(parents=True, exist_ok=True)
        (tmp_path / "project").mkdir(parents=True, exist_ok=True)
        return PhaseContext(
            project_dir=tmp_path / "project",
            spec_dir=spec,
            model="m",
            repo_root=tmp_path,
            effort="high",
        )

    def _phase(self, **kw) -> Phase:
        return Phase(id="brainstorm", impl="bmad/bmad-brainstorming", **kw)

    def test_the_fallback_is_played_when_the_impl_is_not_on_disk(self, tmp_path):
        from workflows.runner import _locate_procedure

        _write_skill(tmp_path, "brainstorm-approaches", "Compare approaches.")
        phase = self._phase(fallback="tooling/brainstorm-approaches")
        procedure, why = _locate_procedure(phase, self._ctx(tmp_path), None)
        assert procedure is not None
        body, _source, played = procedure
        assert "Compare approaches" in body
        assert played == "tooling/brainstorm-approaches"
        assert "played by tooling/brainstorm-approaches" in why
        assert "no SKILL.md for bmad/bmad-brainstorming" in why

    def test_the_fallback_is_played_when_the_impl_needs_an_absent_runtime(
        self, tmp_path
    ):
        """The case lot 2 is built on: the BMAD skill is on disk (committed)
        and its runtime is not in the target project."""
        from workflows.runner import _locate_procedure

        _write_skill(tmp_path, "bmad-brainstorming", "BMAD.", runtime="_bmad/x.py")
        _write_skill(tmp_path, "brainstorm-approaches", "Compare approaches.")
        phase = self._phase(fallback="tooling/brainstorm-approaches")
        procedure, why = _locate_procedure(phase, self._ctx(tmp_path), None)
        assert procedure is not None
        assert procedure[2] == "tooling/brainstorm-approaches"
        assert "runtime not present" in why

    def test_the_impl_wins_when_it_can_start(self, tmp_path):
        from workflows.runner import _locate_procedure

        _write_skill(tmp_path, "bmad-brainstorming", "BMAD.")
        _write_skill(tmp_path, "brainstorm-approaches", "Compare approaches.")
        phase = self._phase(fallback="tooling/brainstorm-approaches")
        procedure, why = _locate_procedure(phase, self._ctx(tmp_path), None)
        assert procedure is not None
        assert procedure[2] == "bmad/bmad-brainstorming"
        assert why == ""

    def test_neither_is_reported_with_both_reasons(self, tmp_path):
        from workflows.runner import _locate_procedure

        phase = self._phase(fallback="tooling/brainstorm-approaches")
        procedure, why = _locate_procedure(phase, self._ctx(tmp_path), None)
        assert procedure is None
        assert "bmad/bmad-brainstorming" in why
        assert "tooling/brainstorm-approaches" in why

    def test_the_outcome_names_the_implementation_that_ran(self, tmp_path, monkeypatch):
        """What a phase reports is what it did, not what it was asked."""
        from tests.test_workflow_runner import _install_fake_agent_stack
        from workflows import run_skill_phase

        seen: dict = {}
        _install_fake_agent_stack(monkeypatch, seen)
        _write_skill(tmp_path, "brainstorm-approaches", "Compare approaches.")
        phase = self._phase(fallback="tooling/brainstorm-approaches")
        resolved = ResolvedPhase(phase=phase, dispatch="inline")
        outcome = asyncio.run(run_skill_phase(resolved, self._ctx(tmp_path)))
        assert outcome.succeeded is True
        assert outcome.impl == "tooling/brainstorm-approaches"
        assert "Compare approaches" in seen["prompt"]


# ---------------------------------------------------------------------------
# Windows on workflows that do not declare every boundary
# ---------------------------------------------------------------------------


def _profile(ids: list[str]):
    body = "phases:\n" + "".join(
        f"  - id: {i}\n    impl: {'workpilot' if i in BUILTIN_EXECUTORS else 'p'}/{i}\n"
        for i in ids
    )
    return resolve_profile(load_workflow_from_text(body), "high")


def load_workflow_from_text(body: str):
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "workflow.yaml"
        p.write_text(body, encoding="utf-8")
        return load_workflow(p)


class TestWindowsWithoutBoundaries:
    def _windows(self, profile):
        return [
            [r.id for r in phases_between(profile, after=a, before=b)]
            for a, b in WINDOWS
        ]

    def test_no_builtin_at_all_runs_everything_once_up_front(self):
        assert self._windows(_profile(["investigate", "report"])) == [
            ["investigate", "report"],
            [],
            [],
            [],
        ]

    def test_no_qa_runs_the_post_coding_phases_to_the_end(self):
        assert self._windows(
            _profile(["planning", "coding", "proofread", "verdict"])
        ) == [[], [], ["proofread", "verdict"], []]

    def test_no_planning_closes_the_first_window_at_coding(self):
        assert self._windows(
            _profile(["reproduce", "coding", "review", "qa", "after"])
        ) == [["reproduce"], [], ["review"], ["after"]]

    def test_the_feature_pipeline_is_unchanged(self):
        ids = ["docs", "a", "planning", "b", "coding", "c", "qa", "d"]
        assert self._windows(_profile(ids)) == [["a"], ["b"], ["c"], ["d"]]


# ---------------------------------------------------------------------------
# The `tests-unchanged` gate
# ---------------------------------------------------------------------------


class TestTestsUnchanged:
    @pytest.mark.parametrize(
        "path,expected",
        [
            ("tests/test_x.py", True),
            ("apps/backend/x.py", False),
            ("src/__tests__/a.ts", True),
            ("src/a.test.ts", True),
            ("src/a.spec.ts", True),
            ("pkg/x_test.go", True),
            ("Project.Tests/FooTests.cs", True),
            ("spec/models/user_spec.rb", True),
            ("src/contest.py", False),
            ("src/testing_utils.py", False),
            ("docs/testing.md", False),
        ],
    )
    def test_is_test_file(self, path, expected):
        assert is_test_file(path) is expected

    def _profile(self):
        return _profile_with_gate()

    def test_it_holds_when_the_diff_touches_no_test(self):
        report = evaluate_hard_gates(
            self._profile(), Path("/nonexistent"), changed_files=["src/a.py"]
        )
        gate = next(r for r in report.results if r.gate == TESTS_UNCHANGED)
        assert gate.held is True

    def test_it_fails_when_a_test_changed(self):
        report = evaluate_hard_gates(
            self._profile(),
            Path("/nonexistent"),
            changed_files=["src/a.py", "tests/test_a.py"],
        )
        gate = next(r for r in report.results if r.gate == TESTS_UNCHANGED)
        assert gate.held is False
        assert "tests/test_a.py" in gate.detail
        assert report.blocking

    def test_an_unknown_change_set_is_unknown_not_a_pass(self):
        report = evaluate_hard_gates(self._profile(), Path("/nonexistent"))
        gate = next(r for r in report.results if r.gate == TESTS_UNCHANGED)
        assert gate.held is None


def _profile_with_gate():
    body = (
        "phases:\n"
        "  - id: verify\n"
        "    impl: tooling/verify\n"
        f"    hard_gate: {TESTS_UNCHANGED}\n"
    )
    return resolve_profile(load_workflow_from_text(body), "high")


# ---------------------------------------------------------------------------
# The profile API follows the kind
# ---------------------------------------------------------------------------


class TestProfileApi:
    @pytest.fixture
    def client(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from workflows.api import router

        app = FastAPI()
        app.include_router(router)
        return TestClient(app)

    def _project(self, tmp_path: Path, kind: str | None) -> Path:
        spec = tmp_path / ".workpilot" / "specs" / "001-x"
        spec.mkdir(parents=True)
        if kind:
            (spec / "task_metadata.json").write_text(
                json.dumps({"kind": kind}), encoding="utf-8"
            )
        return tmp_path

    def test_without_a_workflow_parameter_the_kind_decides(self, client, tmp_path):
        project = self._project(tmp_path, "investigation")
        res = client.get(
            "/api/workflow-profile/",
            params={"project_dir": str(project), "spec_id": "001-x"},
        ).json()
        assert res["success"] is True
        assert res["profile"]["workflow"] == "investigation"
        assert [p["id"] for p in res["profile"]["phases"]] == ["investigate", "observe"]

    def test_no_kind_is_the_default_pipeline(self, client, tmp_path):
        project = self._project(tmp_path, None)
        res = client.get(
            "/api/workflow-profile/",
            params={"project_dir": str(project), "spec_id": "001-x"},
        ).json()
        assert res["profile"]["workflow"] == DEFAULT_WORKFLOW

    def test_an_explicit_workflow_still_wins(self, client, tmp_path):
        project = self._project(tmp_path, "investigation")
        res = client.get(
            "/api/workflow-profile/",
            params={
                "project_dir": str(project),
                "spec_id": "001-x",
                "workflow": "bug-fix",
            },
        ).json()
        assert res["profile"]["workflow"] == "bug-fix"

    def test_the_payload_carries_the_new_fields(self, client, tmp_path):
        project = self._project(tmp_path, "refactoring")
        res = client.get(
            "/api/workflow-profile/",
            params={"project_dir": str(project), "spec_id": "001-x"},
        ).json()
        for phase in res["profile"]["phases"]:
            assert set(phase) >= {
                "fallback",
                "irreversible",
                "substitutedFrom",
                "substitutionReason",
            }
