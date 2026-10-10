"""How many QA passes a task may run depends on the effort it was given.

The loop used to stop at 50 review + fix rounds at every effort, each of them
re-reading the diff (audit F17, lot L10). The cap is now the QA phase's
effort, a per-environment override can set it within the old ceiling, and an
issue that keeps coming back still escalates to a human inside every budget.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps" / "backend"))

from qa import loop as qa_loop  # noqa: E402
from qa.criteria import save_implementation_plan, should_run_fixes  # noqa: E402
from qa.loop import (  # noqa: E402
    MAX_QA_ITERATIONS,
    QA_ITERATIONS_BY_EFFORT,
    QA_MAX_ITERATIONS_ENV,
    qa_iteration_cap,
    recurring_issue_threshold,
)
from qa.report import (  # noqa: E402
    RECURRING_ISSUE_THRESHOLD,
    escalate_to_human,
    record_iteration,
)
from workflows.spec import EFFORT_ORDER  # noqa: E402


@pytest.fixture(autouse=True)
def _no_override(monkeypatch):
    monkeypatch.delenv(QA_MAX_ITERATIONS_ENV, raising=False)


def _spec(tmp_path: Path, qa_effort: str | None = None) -> Path:
    spec = tmp_path / "001-task"
    spec.mkdir()
    if qa_effort is not None:
        (spec / "task_metadata.json").write_text(
            json.dumps({"phaseThinking": {"qa": qa_effort}}), encoding="utf-8"
        )
    return spec


class TestCapByEffort:
    def test_every_effort_level_has_a_cap(self):
        assert set(QA_ITERATIONS_BY_EFFORT) == set(EFFORT_ORDER)

    def test_more_effort_never_buys_fewer_passes(self):
        caps = [QA_ITERATIONS_BY_EFFORT[e] for e in EFFORT_ORDER]
        assert caps == sorted(caps)
        assert caps[-1] < MAX_QA_ITERATIONS

    @pytest.mark.parametrize("effort", EFFORT_ORDER)
    def test_the_qa_phase_effort_decides(self, tmp_path, effort):
        spec = _spec(tmp_path, effort)
        assert qa_iteration_cap(spec) == QA_ITERATIONS_BY_EFFORT[effort]

    def test_an_unknown_effort_gets_the_default_cap(self, tmp_path, monkeypatch):
        monkeypatch.setattr(qa_loop, "get_phase_thinking", lambda *_a: "extreme")
        assert qa_iteration_cap(_spec(tmp_path)) == QA_ITERATIONS_BY_EFFORT["high"]

    def test_an_unreadable_effort_gets_the_default_cap(self, tmp_path, monkeypatch):
        def boom(*_a):
            raise OSError("unreadable")

        monkeypatch.setattr(qa_loop, "get_phase_thinking", boom)
        assert qa_iteration_cap(_spec(tmp_path)) == QA_ITERATIONS_BY_EFFORT["high"]


class TestOverride:
    def test_the_override_wins_over_the_effort(self, tmp_path, monkeypatch):
        monkeypatch.setenv(QA_MAX_ITERATIONS_ENV, "7")
        assert qa_iteration_cap(_spec(tmp_path, "none")) == 7

    def test_the_override_stays_under_the_ceiling(self, tmp_path, monkeypatch):
        monkeypatch.setenv(QA_MAX_ITERATIONS_ENV, "500")
        assert qa_iteration_cap(_spec(tmp_path)) == MAX_QA_ITERATIONS

    @pytest.mark.parametrize("raw", ["0", "-3", "many", " "])
    def test_a_meaningless_override_is_ignored(self, tmp_path, monkeypatch, raw):
        monkeypatch.setenv(QA_MAX_ITERATIONS_ENV, raw)
        assert (
            qa_iteration_cap(_spec(tmp_path, "low")) == QA_ITERATIONS_BY_EFFORT["low"]
        )


class TestEscalation:
    @pytest.mark.parametrize("effort", EFFORT_ORDER)
    def test_a_recurring_issue_escalates_within_every_budget(self, effort):
        cap = QA_ITERATIONS_BY_EFFORT[effort]
        threshold = recurring_issue_threshold(cap)
        # An issue present in every pass reaches the threshold before the
        # budget ends: the loop stops on the escalation, which names it, and
        # not on "maximum iterations", which does not.
        assert 2 <= threshold <= cap

    def test_the_configured_threshold_holds_when_the_budget_allows(self):
        assert recurring_issue_threshold(100) == RECURRING_ISSUE_THRESHOLD

    def test_the_report_states_the_budget_and_threshold(self, tmp_path):
        spec = _spec(tmp_path, "none")
        save_implementation_plan(spec, {"feature": "x"})
        record_iteration(spec, 1, "rejected", [{"title": "Login fails"}])
        asyncio.run(
            escalate_to_human(
                spec,
                [{"title": "Login fails", "occurrence_count": 3}],
                3,
                max_iterations=3,
                threshold=3,
            )
        )
        report = (spec / "QA_ESCALATION.md").read_text(encoding="utf-8")
        assert "**Iteration**: 3/3" in report
        assert "(3+ occurrences)" in report

    def test_the_report_defaults_to_the_task_cap(self, tmp_path):
        spec = _spec(tmp_path, "low")
        save_implementation_plan(spec, {"feature": "x"})
        record_iteration(spec, 1, "rejected", [{"title": "x"}])
        asyncio.run(escalate_to_human(spec, [{"title": "x"}], 2))
        report = (spec / "QA_ESCALATION.md").read_text(encoding="utf-8")
        assert f"**Iteration**: 2/{QA_ITERATIONS_BY_EFFORT['low']}" in report


class TestFixer:
    def _rejected_at(self, spec: Path, session: int) -> None:
        save_implementation_plan(
            spec,
            {
                "feature": "x",
                "qa_signoff": {"status": "rejected", "qa_session": session},
            },
        )

    def test_the_fixer_runs_under_the_cap(self, tmp_path):
        spec = _spec(tmp_path, "none")
        self._rejected_at(spec, QA_ITERATIONS_BY_EFFORT["none"] - 1)
        assert should_run_fixes(spec) is True

    def test_the_fixer_stops_at_the_cap(self, tmp_path):
        spec = _spec(tmp_path, "none")
        self._rejected_at(spec, QA_ITERATIONS_BY_EFFORT["none"])
        assert should_run_fixes(spec) is False
