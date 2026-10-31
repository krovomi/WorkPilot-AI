"""The learning loop's analysis is heuristic, and says so (N8 A1, F131).

`LearningLoopService._run_analysis` used to import `core.session`, a module
that has never existed: every analysis ended in its `ImportError` branch and in
`_heuristic_extract`, while the status line announced an AI analysis. The dead
call is gone; these tests pin what the service really does, so that wiring a
model in later is a visible change rather than an import that starts working.
That `learning_loop` imports neither `core` nor `agents` is
`tests/test_import_contracts.py`'s to say.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import agent_runtime
import pytest
from learning_loop.service import LearningLoopService


class _NoModel:
    """A runtime that fails the test if the analysis reaches for a model."""

    def __getattr__(self, name):
        raise AssertionError(f"the learning analysis called the runtime ({name})")


@pytest.fixture
def service(tmp_path: Path, monkeypatch) -> LearningLoopService:
    monkeypatch.setattr(agent_runtime, "_runtime", _NoModel())
    return LearningLoopService(tmp_path)


def test_an_escalated_build_yields_the_heuristic_pattern(service) -> None:
    builds = [{"spec_id": "001-x", "had_escalation": True, "context_tags": ["api"]}]
    statuses: list[str] = []

    report = asyncio.run(service._run_analysis(builds, statuses.append))

    assert [p.agent_phase for p in report.patterns_found] == ["qa_fixing"]
    assert [p.source_build_ids for p in report.patterns_found] == [["001-x"]]
    assert statuses and not any("AI" in status for status in statuses)
