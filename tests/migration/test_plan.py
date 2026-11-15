"""The migration plan the Code Migration page saves, from detection to disk.

`MigrationOrchestrator.start_migration` reads a real project, refuses a pair
the planner does not know, and writes the plan to `.workpilot/migration/`.
The planner itself is exercised on every pair it has a dedicated phase for.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from migration.config import SUPPORTED_MIGRATIONS
from migration.models import (
    MigrationPhase,
    MigrationPlan,
    MigrationState,
    MigrationStep,
    RiskLevel,
    StackInfo,
)
from migration.orchestrator import MigrationOrchestrator
from migration.planner import MigrationPlanner

#: The phases every plan has, around the pair's own transformation phases.
COMMON = ["analysis", "planning", "backup", "validation", "autofix", "reporting"]


def _stack(framework: str, **extra) -> StackInfo:
    return StackInfo(framework=framework, language="x", version="1", **extra)


def _plan(source: str, target: str) -> MigrationPlan:
    return MigrationPlanner(_stack(source), _stack(target)).create_plan()


def _ids(plan: MigrationPlan) -> list[str]:
    return [phase.id for phase in plan.phases]


class TestPlanner:
    @pytest.mark.parametrize(
        ("pair", "own_phases", "effort", "hours"),
        [
            (
                ("react", "vue"),
                ["react_components", "state_management", "routing", "styling"],
                "High",
                40.0,
            ),
            (
                ("mysql", "postgresql"),
                ["schema_migration", "data_migration", "application_updates"],
                "High",
                30.0,
            ),
            (("python2", "python3"), ["python_migration"], "Medium", 20.0),
            (("rest", "graphql"), ["graphql_migration"], "High", 50.0),
            (("javascript", "typescript"), ["typescript_migration"], "Medium", 15.0),
        ],
    )
    def test_a_known_pair_gets_its_own_phases(self, pair, own_phases, effort, hours):
        config = SUPPORTED_MIGRATIONS[pair]
        assert config["estimated_effort_hours"] == hours  # the table's figure

        plan = _plan(*pair)

        assert _ids(plan) == COMMON[:3] + own_phases + COMMON[3:]
        assert plan.total_steps == sum(len(p.steps) for p in plan.phases)
        assert plan.estimated_effort == effort
        assert plan.estimated_duration_hours == hours

    def test_a_pair_with_no_dedicated_phase_still_gets_the_common_plan(self):
        plan = _plan("flask", "fastapi")

        assert _ids(plan) == COMMON
        assert plan.estimated_duration_hours == float(
            SUPPORTED_MIGRATIONS[("flask", "fastapi")]["estimated_effort_hours"]
        )

    def test_an_unlisted_pair_is_planned_with_default_effort(self):
        plan = _plan("cobol", "rust")

        assert plan.estimated_effort == "Medium"
        assert plan.estimated_duration_hours == 20.0

    def test_steps_depend_only_on_steps_of_the_plan(self):
        for source, target in SUPPORTED_MIGRATIONS:
            plan = _plan(source, target)
            known = {s.id for p in plan.phases for s in p.steps}
            for phase in plan.phases:
                for step in phase.steps:
                    assert set(step.dependencies) <= known, (source, target, step.id)

    @pytest.mark.parametrize(
        ("hours", "effort"),
        [
            (5, "Low"),
            (10, "Medium"),
            (29, "Medium"),
            (30, "High"),
            (59, "High"),
            (60, "Very High"),
        ],
    )
    def test_effort_follows_the_estimated_hours(self, hours, effort):
        planner = MigrationPlanner(_stack("a"), _stack("b"))

        assert planner._calculate_effort({"estimated_effort_hours": hours}) == effort

    @pytest.mark.parametrize(
        ("levels", "risk"),
        [
            ([], RiskLevel.LOW),
            ([RiskLevel.LOW, RiskLevel.LOW, RiskLevel.MEDIUM], RiskLevel.LOW),
            ([RiskLevel.MEDIUM, RiskLevel.MEDIUM], RiskLevel.MEDIUM),
            ([RiskLevel.HIGH, RiskLevel.MEDIUM], RiskLevel.HIGH),
            ([RiskLevel.CRITICAL, RiskLevel.HIGH], RiskLevel.CRITICAL),
        ],
    )
    def test_risk_is_the_average_of_the_phases(self, levels, risk):
        planner = MigrationPlanner(_stack("a"), _stack("b"))
        phases = [
            MigrationPhase(id=str(i), name="p", description="d", risk_level=lvl)
            for i, lvl in enumerate(levels)
        ]

        assert planner._calculate_risk(phases) is risk

    def test_a_risky_plan_needs_an_approval(self, monkeypatch):
        monkeypatch.setattr(
            MigrationPlanner, "_calculate_risk", lambda self, phases: RiskLevel.HIGH
        )

        assert _plan("react", "vue").approvals_required is True

    def test_the_rule_based_plans_are_low_or_medium_risk(self):
        # Six common low-to-medium phases weigh every average down: no pair
        # in the table asks for an approval today.
        for source, target in SUPPORTED_MIGRATIONS:
            plan = _plan(source, target)
            assert plan.risk_level in {RiskLevel.LOW, RiskLevel.MEDIUM}
            assert plan.approvals_required is False


class TestModels:
    def test_a_plan_serialises_to_plain_json(self):
        plan = _plan("react", "vue")

        data = json.loads(json.dumps(plan.to_dict()))

        assert data["source_stack"]["framework"] == "react"
        assert data["risk_level"] == plan.risk_level.value
        assert data["phases"][0]["risk_level"] == "low"
        assert data["phases"][0]["steps"][0]["id"] == "analyze_source_code"
        assert data["created_at"] == plan.created_at.isoformat()

    def test_a_step_and_a_phase_keep_their_fields(self):
        step = MigrationStep(
            id="s",
            title="t",
            description="d",
            category="c",
            files_affected=["a"],
            transformation_type="x",
            expected_changes=1,
        )
        phase = MigrationPhase(id="p", name="n", description="d", steps=[step])

        assert phase.to_dict()["steps"] == [step.to_dict()]
        assert step.to_dict()["status"] == "pending"
        assert phase.to_dict()["risk_level"] == "medium"


def _flask_project(root: Path) -> Path:
    root.mkdir()
    (root / "requirements.txt").write_text("flask==3.0\n", encoding="utf-8")
    (root / "app.py").write_text("from flask import Flask\n", encoding="utf-8")
    return root


class TestOrchestrator:
    def test_a_known_pair_is_planned_and_saved(self, tmp_path):
        project = _flask_project(tmp_path / "api")

        context = MigrationOrchestrator(str(project)).start_migration(
            target_framework="fastapi", target_language="python"
        )

        assert context.state is MigrationState.PLANNING
        assert context.source_stack.framework == "flask"
        assert context.target_stack.framework == "fastapi"
        assert _ids(context.plan) == COMMON
        saved = project / ".workpilot" / "migration" / f"{context.migration_id}.json"
        data = json.loads(saved.read_text(encoding="utf-8"))
        assert data["migration_id"] == context.migration_id
        assert data["state"] == "planning"
        assert data["plan"]["target_stack"]["framework"] == "fastapi"
        assert data["started_at"] == context.started_at.isoformat()
        # Planning never touches the project's own files.
        assert (project / "app.py").read_text(
            encoding="utf-8"
        ) == "from flask import Flask\n"

    def test_an_unknown_pair_is_refused_and_nothing_is_written(self, tmp_path):
        project = _flask_project(tmp_path / "api")
        orchestrator = MigrationOrchestrator(str(project))

        with pytest.raises(ValueError, match="from flask to cobol is not supported"):
            orchestrator.start_migration(target_framework="cobol", target_language="x")

        assert orchestrator.context is None
        assert not (project / ".workpilot").exists()

    def test_a_context_without_a_plan_serialises(self, tmp_path):
        from migration.models import MigrationContext

        context = MigrationContext(
            migration_id="m",
            source_stack=_stack("a"),
            target_stack=_stack("b"),
            project_dir=str(tmp_path),
        )

        assert context.to_dict()["plan"] is None
