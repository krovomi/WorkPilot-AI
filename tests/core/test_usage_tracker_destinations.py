"""Where one agent session's usage goes, and that no destination stops a build.

`record_session_usage` writes four places (cost_data.json, the analytics
database, the dashboard snapshot, the carbon ledger). The database here is a
real SQLite file in the test's directory, with the analytics schema; the JSON
ledgers are real files. A destination that cannot be written (its path is a
directory, its table is missing) is logged and the others are still written.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from analytics import database
from analytics.database_schema import Base, Build, BuildStatus, TokenUsage
from core import usage_tracker
from core.usage_tracker import (
    backfill_carbon_ledger_from_cost_data,
    build_seconds,
    finish_build,
    on_merge,
    record_build_end,
    record_merge,
    record_qa_result,
    record_session_usage,
    record_task_status,
    spec_complexity,
    start_build,
)
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def analytics_db(tmp_path, monkeypatch):
    """The analytics database, as a SQLite file of this test."""
    engine = create_engine(f"sqlite:///{(tmp_path / 'analytics.db').as_posix()}")
    monkeypatch.setattr(database, "SessionLocal", sessionmaker(bind=engine))
    monkeypatch.setattr(
        database, "create_tables", lambda: Base.metadata.create_all(bind=engine)
    )
    yield sessionmaker(bind=engine)
    engine.dispose()


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "shop"
    spec_dir = root / ".workpilot" / "specs" / "007-cart"
    spec_dir.mkdir(parents=True)
    return root, spec_dir


@pytest.fixture(autouse=True)
def _no_builds_left(monkeypatch):
    monkeypatch.setattr(usage_tracker, "_active_builds", {})


def session(root: Path, spec_dir: Path, **overrides) -> None:
    values = {
        "spec_dir": spec_dir,
        "project_dir": root,
        "phase": "coding",
        "agent_type": "coder",
        "model": "claude-sonnet-5",
        "provider": "anthropic",
        "input_tokens": 100,
        "output_tokens": 50,
        "cost_usd": 0.25,
        "cache_creation_input_tokens": 10,
        "cache_read_input_tokens": 40,
    }
    values.update(overrides)
    record_session_usage(**values)


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


class TestABuild:
    def test_its_sessions_add_up_in_the_database_and_the_build_record(
        self, analytics_db, project
    ):
        root, spec_dir = project
        build_id = start_build(
            spec_dir, root, "007-cart", None, "claude-sonnet-5", "anthropic"
        )

        session(root, spec_dir)
        session(root, spec_dir, phase="qa_review", input_tokens=20, cost_usd=0.05)
        info = finish_build(spec_dir)

        assert info["build_id"] == build_id
        assert info["spec_name"] == "007-cart"
        assert info["total_input_tokens"] == 120
        assert info["total_cache_read_tokens"] == 80
        assert info["total_cost"] == pytest.approx(0.30)
        assert build_seconds(info) >= 0
        with analytics_db() as db:
            build = db.query(Build).filter_by(build_id=build_id).one()
            assert build.status == BuildStatus.COMPLETE
            assert build.total_tokens_used == 220
            assert build.project_path == str(root)
            assert build.total_duration_seconds is not None
            phases = [row.operation_type for row in db.query(TokenUsage).all()]
            assert phases == ["coding", "qa_review"]

    def test_a_failed_build_is_marked_failed(self, analytics_db, project):
        root, spec_dir = project
        build_id = start_build(spec_dir, root, "007-cart", "Cart", "m", "openai")
        session(root, spec_dir)

        finish_build(spec_dir, status="failed")

        with analytics_db() as db:
            build = db.query(Build).filter_by(build_id=build_id).one()
            assert build.status == BuildStatus.FAILED
            assert build.spec_name == "Cart"

    def test_a_build_with_no_session_has_no_row_to_close(self, analytics_db, project):
        root, spec_dir = project
        start_build(spec_dir, root, "007-cart", None, "m", "anthropic")

        assert finish_build(spec_dir)["status"] == "complete"
        with analytics_db() as db:
            assert db.query(Build).count() == 0

    def test_finishing_a_build_that_never_started_says_so(self, project):
        assert finish_build(project[1]) is None

    def test_a_session_outside_any_build_gets_a_build_row_of_its_own(
        self, analytics_db, project
    ):
        root, spec_dir = project

        session(root, spec_dir)

        with analytics_db() as db:
            [build] = db.query(Build).all()
            assert build.spec_id == "007-cart"
            assert build.project_path is None
            assert build.status == BuildStatus.CODING


class TestEachDestination:
    def test_a_session_reaches_the_three_ledgers(self, analytics_db, project):
        root, spec_dir = project

        session(root, spec_dir, provider="ollama", model="qwen3", cost_usd=0.0)

        [usage] = read(root / ".workpilot" / "cost_data.json")["usages"]
        assert usage["task_id"] == "007-cart" and usage["usage_source"] == "reported"
        snapshot = read(root / ".workpilot" / "dashboard_snapshot.json")
        assert snapshot["tokens_by_provider"] == {"ollama": 150}
        [carbon] = read(root / ".workpilot" / "carbon-ledger.json")
        assert carbon["source"] == "llm_local"
        assert carbon["tokens_in"] == 150

    def test_a_ledger_that_cannot_be_written_leaves_the_others(
        self, analytics_db, project, caplog
    ):
        root, spec_dir = project
        (root / ".workpilot" / "cost_data.json").mkdir()
        (root / ".workpilot" / "carbon-ledger.json").mkdir()

        with caplog.at_level(logging.WARNING, logger=usage_tracker.__name__):
            session(root, spec_dir)

        assert "cost_data.json write failed" in caplog.text
        assert "carbon-ledger write failed" in caplog.text
        assert (
            read(root / ".workpilot" / "dashboard_snapshot.json")["total_tokens"] == 150
        )
        with analytics_db() as db:
            assert db.query(TokenUsage).count() == 1

    def test_a_snapshot_that_cannot_be_written_is_logged(
        self, analytics_db, project, caplog
    ):
        root, spec_dir = project
        (root / ".workpilot" / "dashboard_snapshot.json").mkdir()

        with caplog.at_level(logging.WARNING, logger=usage_tracker.__name__):
            session(root, spec_dir)
            record_task_status(root, "007-cart", "completed")
            record_qa_result(root, "007-cart", passed=True)
            record_merge(root, automatic=True)

        for line in (
            "dashboard_snapshot write failed",
            "record_task_status failed",
            "record_qa_result failed",
            "record_merge failed",
        ):
            assert line in caplog.text
        assert read(root / ".workpilot" / "cost_data.json")["usages"]

    def test_a_database_without_its_tables_is_logged(
        self, analytics_db, project, monkeypatch, caplog
    ):
        root, spec_dir = project
        monkeypatch.setattr(database, "create_tables", lambda: None)
        start_build(spec_dir, root, "007-cart", None, "m", "anthropic")

        with caplog.at_level(logging.WARNING, logger=usage_tracker.__name__):
            session(root, spec_dir)
            finish_build(spec_dir)

        assert "analytics DB write failed" in caplog.text
        assert "Could not write build to analytics DB" in caplog.text
        assert read(root / ".workpilot" / "cost_data.json")["usages"]

    def test_no_analytics_module_means_no_database_write(self, project, monkeypatch):
        root, spec_dir = project
        monkeypatch.setitem(sys.modules, "analytics.database", None)
        start_build(spec_dir, root, "007-cart", None, "m", "anthropic")

        session(root, spec_dir)

        assert finish_build(spec_dir)["status"] == "complete"
        assert read(root / ".workpilot" / "cost_data.json")["usages"]

    def test_ledgers_found_in_another_shape_are_started_again(
        self, analytics_db, project
    ):
        root, spec_dir = project
        workpilot = root / ".workpilot"
        (workpilot / "cost_data.json").write_text('{"usages": 3}', encoding="utf-8")
        (workpilot / "carbon-ledger.json").write_text("{}", encoding="utf-8")
        (workpilot / "dashboard_snapshot.json").write_text(
            '{"tokens_by_provider": [], "total_tokens": null}', encoding="utf-8"
        )

        session(root, spec_dir)

        assert len(read(workpilot / "cost_data.json")["usages"]) == 1
        assert len(read(workpilot / "carbon-ledger.json")) == 1
        assert read(workpilot / "dashboard_snapshot.json")["total_tokens"] == 150

    def test_a_cost_data_file_that_is_not_an_object_is_replaced(
        self, analytics_db, project
    ):
        root, spec_dir = project
        (root / ".workpilot" / "cost_data.json").write_text("[]", encoding="utf-8")

        session(root, spec_dir)

        assert read(root / ".workpilot" / "cost_data.json")["budgets"] == {}


class TestTheEndOfABuild:
    def test_a_completed_build_counts_its_time_by_complexity(
        self, project, monkeypatch
    ):
        root, spec_dir = project
        monkeypatch.setattr(
            usage_tracker, "_write_build_to_analytics_db", lambda info: None
        )
        (spec_dir / "complexity_assessment.json").write_text(
            '{"complexity": " Complex "}', encoding="utf-8"
        )
        start_build(spec_dir, root, "007-cart", None, "m", "anthropic")
        usage_tracker._active_builds[str(spec_dir)]["started_at"] = (
            "2026-11-14T10:00:00+00:00"
        )

        record_build_end(root, spec_dir, "complete", "completed")

        snapshot = read(root / ".workpilot" / "dashboard_snapshot.json")
        assert snapshot["tasks_by_status"] == {"completed": 1}
        [seconds] = snapshot["avg_completion_by_complexity"]["complex"]
        assert seconds > 0

    def test_telemetry_that_fails_never_stops_the_build(
        self, project, monkeypatch, caplog
    ):
        root, spec_dir = project

        def broken(*args, **kwargs):
            raise TypeError("snapshot schema changed")

        monkeypatch.setattr(usage_tracker, "record_task_status", broken)

        with caplog.at_level(logging.DEBUG, logger=usage_tracker.__name__):
            record_build_end(root, spec_dir, "failed", "error")

        assert "build end not recorded" in caplog.text

    @pytest.mark.parametrize(
        ("content", "complexity"),
        [
            (None, "standard"),
            ("[1]", "standard"),
            ('{"complexity": "  "}', "standard"),
            ("{", "standard"),
            ('{"complexity": "Simple"}', "simple"),
        ],
    )
    def test_the_complexity_is_the_assessments(self, tmp_path, content, complexity):
        if content is not None:
            (tmp_path / "complexity_assessment.json").write_text(
                content, encoding="utf-8"
            )

        assert spec_complexity(tmp_path) == complexity

    @pytest.mark.parametrize(
        "info",
        [None, {}, {"started_at": "yesterday", "completed_at": "now"}],
    )
    def test_a_build_without_usable_times_lasted_0_seconds(self, info):
        assert build_seconds(info) == 0.0

    def test_a_qa_result_and_a_merge_are_counted(self, project):
        root, _ = project

        record_qa_result(root, "007-cart", passed=True, score=8.0)
        record_qa_result(root, "007-cart", passed=False, score=4.0)
        on_merge(SimpleNamespace(project_dir=root, automatic=False))

        snapshot = read(root / ".workpilot" / "dashboard_snapshot.json")
        assert snapshot["qa_first_pass_rate"] == 50.0
        assert snapshot["qa_avg_score"] == 6.0
        assert snapshot["merge_manual_count"] == 1


class TestCarbonBackfill:
    def test_the_ledger_is_rebuilt_from_every_cost_file_once(self, project):
        root, _ = project
        workpilot = root / ".workpilot"
        usage = {
            "provider": "anthropic",
            "model": "claude-sonnet-5",
            "input_tokens": 10,
            "output_tokens": 5,
            "cache_read_input_tokens": 2,
            "timestamp": "2026-11-14T10:00:00+00:00",
            "task_id": "007-cart",
            "phase": "coding",
            "agent_type": "coder",
        }
        (workpilot / "cost_data.json").write_text(
            json.dumps({"usages": [usage]}), encoding="utf-8"
        )
        task = workpilot / "worktrees" / "tasks" / "007-cart" / ".workpilot"
        task.mkdir(parents=True)
        (task / "cost_data.json").write_text(
            json.dumps({"usages": [usage, {**usage, "phase": "qa_review"}]}),
            encoding="utf-8",
        )
        broken = workpilot / "worktrees" / "tasks" / "008-x" / ".workpilot"
        broken.mkdir(parents=True)
        (broken / "cost_data.json").write_text("{", encoding="utf-8")

        assert backfill_carbon_ledger_from_cost_data(root) == 2

        ledger = read(workpilot / "carbon-ledger.json")
        assert [entry["phase"] for entry in ledger] == ["coding", "qa_review"]
        assert ledger[0]["tokens_in"] == 12
        assert ledger[0]["agent"] == "coder"

    def test_a_project_with_no_cost_file_gets_an_empty_ledger(self, project):
        root, _ = project

        assert backfill_carbon_ledger_from_cost_data(root) == 0
        assert read(root / ".workpilot" / "carbon-ledger.json") == []
