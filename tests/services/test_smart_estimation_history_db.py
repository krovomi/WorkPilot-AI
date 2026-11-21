"""Smart estimation against a real build history.

The analytics schema is created in an in-memory SQLite database and filled
with builds, phases and QA results; the service reads it through `get_db`,
as it does the project's own database.
"""

from __future__ import annotations

import importlib
import sys
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

import pytest
from analytics.database_schema import Base, Build, BuildPhase, BuildStatus, QAResult
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

# Other suites stub this module into sys.modules (tests/conftest.py); this one
# needs the real one.
for _stub in ("services", "services.smart_estimation_service"):
    if isinstance(sys.modules.get(_stub), MagicMock):
        del sys.modules[_stub]
estimation = importlib.import_module("services.smart_estimation_service")


@pytest.fixture
def history(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine)

    def get_db():
        db = sessions()
        try:
            yield db
        finally:
            db.close()

    monkeypatch.setattr(estimation, "get_db", get_db)
    db = sessions()
    yield db
    db.close()


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _build(db, build_id: str, name: str, **fields) -> None:
    db.add(
        Build(
            build_id=build_id,
            spec_id=build_id,
            spec_name=name,
            started_at=fields.pop("started_at", _now() - timedelta(days=1)),
            **fields,
        )
    )
    db.commit()


@pytest.fixture
def service():
    return estimation.SmartEstimationService()


def test_similar_recent_builds_inform_the_estimate(history, service):
    _build(
        history,
        "b1",
        "export invoices to pdf",
        total_duration_seconds=5 * 3600,
        qa_iterations=4,
        total_tokens_used=20_000,
        total_cost_usd=3.0,
        status=BuildStatus.FAILED,
    )
    history.add(
        BuildPhase(
            build_id="b1", phase_name="coding", phase_type="coder", success=False
        )
    )
    history.add(QAResult(build_id="b1", iteration=1))
    _build(
        history,
        "b2",
        "export invoices to csv",
        total_duration_seconds=1.5 * 3600,
        qa_iterations=1,
        total_tokens_used=6_000,
        total_cost_usd=1.0,
        status=BuildStatus.COMPLETE,
    )
    _build(history, "b3", "rename the logo", total_duration_seconds=600)
    _build(
        history,
        "old",
        "export invoices to pdf",
        started_at=_now() - timedelta(days=200),
    )

    result = service.analyze_task_description("export invoices to pdf", "/tmp")

    by_id = {t["build_id"]: t for t in result.similar_tasks}
    assert set(by_id) == {"b1", "b2"}
    assert result.similar_tasks[0]["build_id"] == "b1"
    assert by_id["b1"]["complexity_score"] == 1 + 3 + 2 + 2 + 1
    assert by_id["b2"]["complexity_score"] == 1 + 1 + 1
    assert result.estimated_duration_hours == pytest.approx((5 + 1.5) / 2)
    assert result.estimated_qa_iterations == pytest.approx(2.5)
    assert result.token_cost_estimate == pytest.approx(2.0)
    assert result.estimated_tokens == pytest.approx(13_000)
    assert any("historically score" in r for r in result.reasoning)
    assert any("1 similar tasks failed" in r for r in result.recommendations)
    assert 0.5 < result.confidence_level <= 1.0


def test_similar_builds_without_figures_fall_back_to_the_score(history, service):
    for i in range(5):
        _build(history, f"b{i}", "export invoices to pdf")

    result = service.analyze_task_description("export invoices to pdf", "/tmp")

    assert len(result.similar_tasks) == 5
    assert result.similar_tasks[0]["duration_hours"] is None
    score = result.complexity_score
    assert result.estimated_qa_iterations == max(1.0, score / 3.0)
    assert result.token_cost_estimate == score * 0.5
    assert result.estimated_tokens == score * 25_000.0
    assert result.confidence_level == pytest.approx(1.0)


def test_three_similar_builds_raise_the_confidence_less_than_five(history, service):
    for i in range(3):
        _build(history, f"b{i}", "export invoices")

    result = service.analyze_task_description("export invoices", "/tmp")

    assert len(result.similar_tasks) == 3
    assert result.confidence_level == pytest.approx(0.3 + 0.3 + 0.3)


def test_a_history_that_fails_mid_read_gives_no_similar_task(
    history, service, monkeypatch
):
    _build(history, "b1", "export invoices")

    def broken(*args, **kwargs):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(service, "_calculate_text_similarity", broken)

    assert service._find_similar_tasks("export invoices", None) == []


def test_empty_text_is_not_similar_to_anything(service):
    assert service._calculate_text_similarity("", "anything") == 0.0
    assert service._calculate_text_similarity("a b", "") == 0.0


@pytest.mark.parametrize(
    ("hours", "added"),
    [(4.5, 3), (2.5, 2), (1.5, 1), (0.5, 0)],
)
def test_a_longer_build_counts_as_more_complex(service, hours, added):
    build = Build(total_duration_seconds=hours * 3600, qa_iterations=0)

    assert service._infer_complexity_from_metrics(build, [], []) == 1 + added


def test_a_heavy_build_is_capped_at_thirteen(service):
    build = Build(
        total_duration_seconds=10 * 3600, qa_iterations=9, total_tokens_used=10**6
    )
    failed = [BuildPhase(success=False) for _ in range(5)]

    assert (
        service._infer_complexity_from_metrics(build, failed, []) == 1 + 3 + 2 + 2 + 2
    )


@pytest.mark.parametrize(
    ("files", "added"),
    [(11, 4), (6, 3), (4, 2), (2, 1), (1, 0)],
)
def test_more_files_impacted_score_higher(service, files, added):
    factors = estimation.TaskComplexityFactors(files, 0.0, [], [], [])

    assert service._calculate_complexity_score(factors, []) == 1 + added


@pytest.mark.parametrize(
    ("score", "expected"),
    [
        (3, "relatively straightforward"),
        (6, "moderate complexity"),
        (9, "multiple integration points"),
        (12, "highly complex"),
    ],
)
def test_the_reasoning_names_the_score_band(service, score, expected):
    factors = estimation.TaskComplexityFactors(6, 0.0, [], ["risk"], [])

    reasoning = service._generate_reasoning(factors, [], score)

    assert reasoning[0].startswith("High file impact (6 files)")
    assert "Identified 1 risk factors" in reasoning[1]
    assert expected in reasoning[-1]


def test_recommendations_follow_risk_size_and_files(service):
    big = estimation.TaskComplexityFactors(8, 0.0, [], ["risk"], [])
    medium = estimation.TaskComplexityFactors(2, 0.0, [], [], [])

    for_big = service._generate_recommendations(big, 9, [])
    for_medium = service._generate_recommendations(medium, 5, [])

    assert "Break this task into smaller sub-tasks for better manageability" in for_big
    assert "Plan for incremental deployment to reduce risk" in for_big
    assert "Consider creating a separate branch for this high-risk task" in for_big
    assert for_medium == ["Consider pair programming for complex sections"]


def test_the_shared_service_is_one_instance():
    assert (
        estimation.get_smart_estimation_service()
        is estimation.get_smart_estimation_service()
    )


def test_a_small_token_count_adds_nothing(service):
    build = Build(total_duration_seconds=None, qa_iterations=0, total_tokens_used=4_000)

    assert service._infer_complexity_from_metrics(build, [], []) == 1


def test_complexity_indicators_and_moderate_impact_are_named(service):
    factors = service._extract_complexity_factors("make the cache distributed", "/tmp")
    moderate = estimation.TaskComplexityFactors(3, 0.0, [], [], [])

    assert "Caching strategies require careful invalidation" in (
        factors.complexity_indicators
    )
    assert service._generate_reasoning(moderate, [], 2)[0] == (
        "Moderate file impact (3 files)"
    )
