"""Smart estimation degrades gracefully when there is no build history.

The complexity score and the risk factors are derived from the task
description alone. Only `similar_tasks` needs the analytics database, so a
machine that has never run an analytics-backed build (no `builds` table) must
still get an estimate — with a lower confidence, not an exception.
"""

import importlib
import sys
import unittest.mock
from pathlib import Path
from unittest.mock import MagicMock

import pytest

backend_path = Path(__file__).parent.parent.parent / "apps" / "backend"
sys.path.insert(0, str(backend_path))

sys.modules.setdefault("claude_agent_sdk", unittest.mock.MagicMock())

# Other suites stub `services.smart_estimation_service` into sys.modules to
# import their subject without its dependency chain (see the root conftest).
# This one needs the real module, so drop any stub before importing it.
for _poisoned in ("services", "services.smart_estimation_service"):
    if isinstance(sys.modules.get(_poisoned), MagicMock):
        del sys.modules[_poisoned]

smart_estimation_service = importlib.import_module("services.smart_estimation_service")
SmartEstimationService = smart_estimation_service.SmartEstimationService


@pytest.fixture
def service() -> SmartEstimationService:
    return SmartEstimationService()


def test_missing_history_table_yields_no_similar_tasks(service, monkeypatch):
    """A database error is an absent signal, not a failed estimation."""

    def explode():
        raise RuntimeError("no such table: builds")
        yield  # pragma: no cover - never reached, keeps this a generator

    monkeypatch.setattr(smart_estimation_service, "get_db", lambda: explode())

    factors = service._extract_complexity_factors("Add a widget", str(backend_path))
    assert service._find_similar_tasks("Add a widget", factors) == []


def test_estimate_still_produced_without_history(service, monkeypatch):
    """The full analysis survives an unreadable history."""
    monkeypatch.setattr(
        SmartEstimationService, "_find_similar_tasks", lambda *_args: []
    )

    result = service.analyze_task_description(
        "Migrate the authentication database schema and refactor the security layer",
        str(backend_path),
    )

    assert result.complexity_score >= 1
    assert result.risk_factors, "risk factors come from the description, not the DB"
    assert result.similar_tasks == []
    # No history to lean on, so the score must not claim high confidence.
    assert result.confidence_level <= 0.5
