"""BMAD on demand, by `impl` + `fallback` (kanban-task-types, lot 2).

What this pins:

* a phase may be conditional on the task — ``when: kind == feature and
  complexity == complex`` — and an unknown fact reads as matching;
* "installed" for a runtime-gated skill is a question about the project
  being built: on a project without `_bmad/` every BMAD phase is played by
  its fallback, the profile says so, and WorkPilot's committed mock runtime
  never counts as the real one;
* a phase whose fallback is WorkPilot's own Python (`workpilot/spec`) opens
  no session and belongs to no window;
* the handoff reads the spec's workflow, so a bug-fix's reproduction report
  reaches its planner.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from workflows.engine import BUILTIN_PACKS, ProjectCheck, ResolvedPhase  # noqa: E402
from workflows.handoff import feeding_phases, reports_for  # noqa: E402
from workflows.registry import workflow_for  # noqa: E402
from workflows.runner import phases_between, skill_requires  # noqa: E402
from workflows.spec import Phase, WorkflowError, _parse_condition  # noqa: E402
from workflows.task_facts import task_facts  # noqa: E402

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
MOCK_MARKER_FILE = REPO_ROOT / "_bmad" / "scripts" / "resolve_customization.py"


@pytest.fixture(scope="module")
def inventory():
    from skills_registry.packs import load_packs

    return pack_inventory(load_packs(REPO_ROOT / "skills"))


def _load(name: str):
    return load_workflow(REPO_ROOT / "workflows" / name / "workflow.yaml")


def _bare_project(tmp_path: Path) -> Path:
    project = tmp_path / "project"
    project.mkdir(parents=True, exist_ok=True)
    return project


def _bmad_project(tmp_path: Path) -> Path:
    """A project where BMAD's installer has written its runtime."""
    project = _bare_project(tmp_path)
    runtime = project / "_bmad" / "scripts" / "resolve_customization.py"
    runtime.parent.mkdir(parents=True, exist_ok=True)
    runtime.write_text("print('real')\n", encoding="utf-8")
    return project


def _mock_project(tmp_path: Path) -> Path:
    """A project carrying WorkPilot's own stand-in — this repository's."""
    project = _bare_project(tmp_path)
    runtime = project / "_bmad" / "scripts" / "resolve_customization.py"
    runtime.parent.mkdir(parents=True, exist_ok=True)
    runtime.write_text(MOCK_MARKER_FILE.read_text(encoding="utf-8"), encoding="utf-8")
    return project


def write_workflow(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "workflow.yaml"
    p.write_text(body, encoding="utf-8")
    return p


# ---------------------------------------------------------------------------
# `when:` on the task
# ---------------------------------------------------------------------------


class TestWhenOnTheTask:
    def test_the_three_forms_parse(self):
        globs, facts = _parse_condition(
            'kind == feature and complexity == complex and touches("a,b")', "x"
        )
        assert globs == ("a", "b")
        assert facts == (("kind", "feature"), ("complexity", "complex"))

    @pytest.mark.parametrize(
        "raw,message",
        [
            ("kind == nonsense", "expected one of"),
            ("complexity == huge", "expected one of"),
            ("kind == feature and kind == docs", "compared twice"),
            ('touches("a") and touches("b")', "two touches"),
            ("effort == high", "unsupported condition"),
        ],
    )
    def test_a_bad_condition_is_a_load_error(self, raw, message):
        with pytest.raises(WorkflowError, match=message):
            _parse_condition(raw, "x")

    def test_a_lens_takes_only_touches(self, tmp_path):
        body = (
            "phases:\n"
            "  - id: review\n"
            "    impl: p/s\n"
            "    lenses:\n"
            "      x: kind == feature\n"
        )
        with pytest.raises(WorkflowError, match="lens condition"):
            load_workflow(write_workflow(tmp_path, body))

    def _workflow(self, tmp_path):
        return load_workflow(
            write_workflow(
                tmp_path,
                "phases:\n"
                "  - id: prd\n"
                "    impl: p/prd\n"
                "    when: kind == feature and complexity == complex\n"
                "  - id: coding\n"
                "    impl: workpilot/coder\n",
            )
        )

    def test_a_matching_task_runs_it(self, tmp_path):
        profile = resolve_profile(
            self._workflow(tmp_path),
            "high",
            task={"kind": "feature", "complexity": "complex"},
        )
        assert profile.will_run("prd")

    @pytest.mark.parametrize(
        "task",
        [
            {"kind": "bug_fix", "complexity": "complex"},
            {"kind": "feature", "complexity": "simple"},
            {"kind": "feature", "complexity": "standard"},
        ],
    )
    def test_a_different_task_skips_it_with_the_reason(self, tmp_path, task):
        profile = resolve_profile(self._workflow(tmp_path), "high", task=task)
        assert not profile.will_run("prd")
        assert {p.id: why for p, why in profile.skipped}["prd"] == "task"
        assert "not this task: kind == feature and complexity == complex" in (
            profile.describe()
        )

    def test_an_unknown_fact_reads_as_matching(self, tmp_path):
        """Erring towards running, as `touches()` does on an unknown diff."""
        for task in (None, {}, {"kind": "feature"}, {"complexity": "complex"}):
            profile = resolve_profile(self._workflow(tmp_path), "high", task=task)
            assert profile.will_run("prd"), task

    def test_the_facts_are_read_from_the_spec_directory(self, tmp_path):
        spec = tmp_path / "spec"
        spec.mkdir()
        assert task_facts(spec) == {}
        (spec / "task_metadata.json").write_text(
            json.dumps({"kind": "feature"}), encoding="utf-8"
        )
        (spec / "complexity_assessment.json").write_text(
            json.dumps({"complexity": "Complex", "confidence": 0.9}), encoding="utf-8"
        )
        assert task_facts(spec) == {"kind": "feature", "complexity": "complex"}

    def test_unreadable_facts_are_absent_not_wrong(self, tmp_path):
        spec = tmp_path / "spec"
        spec.mkdir()
        (spec / "complexity_assessment.json").write_text("{nope", encoding="utf-8")
        assert task_facts(spec) == {}
        assert task_facts(None) == {}


# ---------------------------------------------------------------------------
# The project decides whether BMAD is installed
# ---------------------------------------------------------------------------


def _bmad_phases(name: str) -> list[Phase]:
    return [p for p in _load(name).phases if p.pack == "bmad"]


class TestBmadByProject:
    def test_the_shipped_workflows_declare_bmad_only_with_a_fallback(self):
        declared = [(n, p.id) for n in WORKFLOWS for p in _bmad_phases(n)]
        assert declared, "lot 2 declares BMAD somewhere"
        for name in WORKFLOWS:
            for phase in _bmad_phases(name):
                assert phase.fallback, (name, phase.id)
                assert not phase.fallback.startswith("bmad/"), (name, phase.id)

    def test_bmad_is_declared_where_its_value_is_documentary(self):
        """Brainstorming, a PRD, research — never a phase that writes code."""
        for name in WORKFLOWS:
            for phase in _bmad_phases(name):
                assert phase.id in {"prd", "brainstorm"}, (name, phase.id)
                assert phase.id not in {"coding", "qa", "verify"}

    @pytest.mark.parametrize("name", WORKFLOWS)
    @pytest.mark.parametrize("effort", EFFORT_ORDER)
    def test_on_a_bare_project_no_phase_is_played_by_bmad(
        self, name, effort, inventory, tmp_path
    ):
        project = ProjectCheck(REPO_ROOT, _bare_project(tmp_path))
        profile = resolve_profile(
            _load(name), effort, inventory=inventory, project=project
        )
        for resolved in profile.run:
            assert resolved.phase.pack != "bmad", (name, effort, resolved.id)
            if resolved.substituted_from:
                assert resolved.substituted_from.startswith("bmad/")
                assert "runtime not present" in resolved.substitution_reason

    def test_on_this_repository_the_mock_runtime_does_not_count(
        self, inventory, tmp_path
    ):
        """`_bmad/scripts/resolve_customization.py` is committed here as a
        stand-in that exits 2. The build counts it as present so the skills
        are emitted; a phase that ran one would pay a session for a script
        that fails on its first call."""
        project = ProjectCheck(REPO_ROOT, _mock_project(tmp_path))
        profile = resolve_profile(
            _load("feature-build"), "high", inventory=inventory, project=project
        )
        brainstorm = next(r for r in profile.run if r.id == "brainstorm")
        assert brainstorm.impl == "tooling/brainstorm-approaches"
        assert "mock" in brainstorm.substitution_reason

    def test_on_a_project_with_the_runtime_bmad_plays(self, inventory, tmp_path):
        project = ProjectCheck(REPO_ROOT, _bmad_project(tmp_path))
        profile = resolve_profile(
            _load("feature-build"),
            "ultrathink",
            inventory=inventory,
            project=project,
            task={"kind": "feature", "complexity": "complex"},
        )
        by_id = {r.id: r for r in profile.run}
        assert by_id["brainstorm"].impl == "bmad/bmad-brainstorming"
        assert by_id["brainstorm"].substituted_from is None
        assert by_id["prd"].impl == "bmad/bmad-prd"
        spike = resolve_profile(
            _load("spike"), "low", inventory=inventory, project=project
        )
        assert next(r for r in spike.run if r.id == "brainstorm").impl == (
            "bmad/bmad-deep-recon"
        )

    def test_a_bug_never_loads_a_bmad_skill(self, inventory, tmp_path):
        """Cost principle: a bug at medium charges no BMAD prompt."""
        project = ProjectCheck(REPO_ROOT, _bmad_project(tmp_path))
        for name in ("bug-fix", "hotfix", "refactoring", "test", "docs", "run"):
            profile = resolve_profile(
                _load(name), "ultrathink", inventory=inventory, project=project
            )
            assert all(r.phase.pack != "bmad" for r in profile.run), name

    def test_a_simple_feature_gets_no_prd_even_with_bmad(self, inventory, tmp_path):
        project = ProjectCheck(REPO_ROOT, _bmad_project(tmp_path))
        profile = resolve_profile(
            _load("feature-build"),
            "ultrathink",
            inventory=inventory,
            project=project,
            task={"kind": "feature", "complexity": "simple"},
        )
        assert not profile.will_run("prd")

    def test_validate_impls_is_quiet_on_a_fresh_clone(self, inventory):
        """The BMAD skills are committed, so the pack inventory has them; the
        fallback covers the project that lacks the runtime. Neither side
        reports a missing implementation."""
        available, gated = inventory
        for name in WORKFLOWS:
            assert validate_impls(_load(name), available, gated=gated) == [], name

    def test_the_runner_reads_the_mock_as_absent(self, tmp_path):
        requires = {"runtime": "_bmad/scripts/resolve_customization.py"}
        ok, why = skill_requires(requires, _mock_project(tmp_path))
        assert ok is False and "mock" in why
        ok, _ = skill_requires(requires, _bmad_project(tmp_path))
        assert ok is True


# ---------------------------------------------------------------------------
# A fallback that is WorkPilot itself
# ---------------------------------------------------------------------------


class TestWorkpilotFallback:
    def test_a_phase_played_by_workpilot_belongs_to_no_window(
        self, inventory, tmp_path
    ):
        project = ProjectCheck(REPO_ROOT, _bare_project(tmp_path))
        profile = resolve_profile(
            _load("feature-build"),
            "ultrathink",
            inventory=inventory,
            project=project,
            task={"kind": "feature", "complexity": "complex"},
        )
        prd = next(r for r in profile.run if r.id == "prd")
        assert prd.impl == "workpilot/spec"
        pre = [r.id for r in phases_between(profile, after=None, before="planning")]
        assert "prd" not in pre
        assert "brainstorm" in pre

    def test_the_runner_opens_no_session_for_it(self, tmp_path, monkeypatch):
        from tests.test_workflow_runner import _install_fake_agent_stack
        from workflows import PhaseContext, run_skill_phase

        seen: dict = {}
        _install_fake_agent_stack(monkeypatch, seen)
        spec = tmp_path / "spec"
        spec.mkdir()
        ctx = PhaseContext(
            project_dir=_bare_project(tmp_path),
            spec_dir=spec,
            model="m",
            repo_root=tmp_path,
            effort="high",
        )
        phase = Phase(id="prd", impl="workpilot/spec")
        outcome = asyncio.run(
            run_skill_phase(ResolvedPhase(phase=phase, dispatch="inline"), ctx)
        )
        assert outcome.succeeded is True
        assert "WorkPilot itself" in outcome.detail
        assert "prompt" not in seen

    def test_every_workpilot_impl_of_every_workflow_has_an_executor(self):
        """`workpilot/<x>` means WorkPilot's Python runs it, or already did.
        Each one is named here so a new one is a deliberate addition."""
        known = {"libdocs", "planner", "coder", "qa-loop", "observe", "spec"}
        for name in WORKFLOWS:
            for phase in _load(name).phases:
                for impl in (phase.impl, phase.fallback):
                    if impl and impl.split("/")[0] in BUILTIN_PACKS:
                        assert impl.split("/")[1] in known, (name, phase.id, impl)


# ---------------------------------------------------------------------------
# The handoff follows the spec's workflow
# ---------------------------------------------------------------------------


class TestHandoffByKind:
    def test_a_bug_fix_planner_reads_the_reproduction(self, tmp_path):
        spec = tmp_path / "spec"
        (spec / "workflow").mkdir(parents=True)
        (spec / "task_metadata.json").write_text(
            json.dumps({"kind": "bug_fix"}), encoding="utf-8"
        )
        (spec / "workflow" / "reproduce.md").write_text(
            "## Bug\n\nWhen X, Y instead of Z.\n", encoding="utf-8"
        )
        reports = reports_for(spec, "planning")
        assert [r.phase_id for r in reports] == ["reproduce"]
        assert "When X" in reports[0].text

    def test_the_declared_order_is_the_kinds(self):
        declared = [
            p.id for p in load_workflow(workflow_for("bug_fix", REPO_ROOT)).phases
        ]
        assert feeding_phases(declared, "planning") == ["reproduce"]
        declared = [
            p.id for p in load_workflow(workflow_for("feature", REPO_ROOT)).phases
        ]
        assert feeding_phases(declared, "planning") == ["prd", "brainstorm"]


# ---------------------------------------------------------------------------
# The profile API
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

    def _spec(self, tmp_path: Path, kind: str, complexity: str) -> Path:
        spec = tmp_path / ".workpilot" / "specs" / "001-x"
        spec.mkdir(parents=True)
        (spec / "task_metadata.json").write_text(
            json.dumps({"kind": kind}), encoding="utf-8"
        )
        (spec / "complexity_assessment.json").write_text(
            json.dumps({"complexity": complexity}), encoding="utf-8"
        )
        return tmp_path

    def test_a_simple_feature_shows_the_prd_skipped_for_the_task(
        self, client, tmp_path
    ):
        project = self._spec(tmp_path, "feature", "simple")
        res = client.get(
            "/api/workflow-profile/",
            params={
                "project_dir": str(project),
                "spec_id": "001-x",
                "effort": "ultrathink",
            },
        ).json()
        prd = next(p for p in res["profile"]["phases"] if p["id"] == "prd")
        assert prd["runs"] is False
        assert prd["skipReason"] == "task"
        assert prd["whenTask"] == ["kind == feature", "complexity == complex"]
        assert prd["conditional"] is True

    def test_a_project_without_bmad_shows_the_substitution(self, client, tmp_path):
        project = self._spec(tmp_path, "feature", "complex")
        res = client.get(
            "/api/workflow-profile/",
            params={
                "project_dir": str(project),
                "spec_id": "001-x",
                "effort": "ultrathink",
            },
        ).json()
        by_id = {p["id"]: p for p in res["profile"]["phases"]}
        assert by_id["prd"]["impl"] == "workpilot/spec"
        assert by_id["prd"]["substitutedFrom"] == "bmad/bmad-prd"
        assert by_id["brainstorm"]["impl"] == "tooling/brainstorm-approaches"
        assert by_id["brainstorm"]["substitutedFrom"] == "bmad/bmad-brainstorming"
        assert res["profile"]["missing"] == []
