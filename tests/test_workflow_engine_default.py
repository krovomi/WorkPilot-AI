"""The engine's default, and the evidence its hard gate reads.

Two things B.8 changes and one it exposes:

* the declarative pipeline is what runs unless someone opts out;
* `verify` — the phase that *declares* `hard_gate: tests-pass` — can finally
  supply the evidence the gate reads, which until it was executed could only
  ever come from a report written by a different phase;
* and "unknown" survives both readers saying nothing, because a gate nobody
  evaluated is not a gate that passed.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from cli.build_commands import (  # noqa: E402
    _resolve_workflow_profile,
    _tests_went_green,
)


class TestTheEngineIsOnByDefault:
    def test_an_unset_flag_resolves_a_profile(self, tmp_path, monkeypatch):
        monkeypatch.delenv("WORKPILOT_WORKFLOW_ENGINE", raising=False)
        spec = tmp_path / "001-x"
        spec.mkdir()
        profile = _resolve_workflow_profile(spec, announce=False)
        assert profile is not None
        assert profile.workflow == "feature-build"

    @pytest.mark.parametrize("value", ["0", "false", "off", "no", "OFF", " 0 "])
    def test_it_can_be_switched_off(self, tmp_path, monkeypatch, value):
        monkeypatch.setenv("WORKPILOT_WORKFLOW_ENGINE", value)
        spec = tmp_path / "001-x"
        spec.mkdir()
        assert _resolve_workflow_profile(spec, announce=False) is None

    @pytest.mark.parametrize("value", ["1", "true", "yes", ""])
    def test_anything_else_leaves_it_on(self, tmp_path, monkeypatch, value):
        monkeypatch.setenv("WORKPILOT_WORKFLOW_ENGINE", value)
        spec = tmp_path / "001-x"
        spec.mkdir()
        assert _resolve_workflow_profile(spec, announce=False) is not None

    def test_the_resolved_profile_keeps_the_declared_order(self, tmp_path, monkeypatch):
        monkeypatch.delenv("WORKPILOT_WORKFLOW_ENGINE", raising=False)
        spec = tmp_path / "001-x"
        spec.mkdir()
        profile = _resolve_workflow_profile(spec, announce=False)
        assert profile.declared[0] == "brainstorm"
        assert profile.declared[-1] == "observe"
        assert "qa" in profile.declared


class TestTestEvidence:
    def _spec(self, tmp_path: Path) -> Path:
        spec = tmp_path / "001-x"
        spec.mkdir()
        return spec

    def test_nothing_said_stays_unknown(self, tmp_path):
        assert _tests_went_green(self._spec(tmp_path)) is None

    def test_the_qa_report_is_read(self, tmp_path):
        spec = self._spec(tmp_path)
        (spec / "qa_report.md").write_text("Tests: pass\n", encoding="utf-8")
        assert _tests_went_green(spec) is True

    def test_the_verify_phase_can_supply_the_evidence_itself(self, tmp_path):
        """The gap this closes.

        `verify` declares the gate. On a build with QA pruned by effort there
        was no qa_report.md at all, so the non-negotiable gate had nothing to
        read and reported unknown on every single run.
        """
        spec = self._spec(tmp_path)
        (spec / "workflow").mkdir()
        (spec / "workflow" / "verify.md").write_text(
            "Ran the suite.\n\nTests: pass\n", encoding="utf-8"
        )
        assert _tests_went_green(spec) is True

    def test_a_failure_anywhere_beats_a_pass_elsewhere(self, tmp_path):
        spec = self._spec(tmp_path)
        (spec / "qa_report.md").write_text("Tests: pass\n", encoding="utf-8")
        (spec / "workflow").mkdir()
        (spec / "workflow" / "verify.md").write_text("Tests: fail\n", encoding="utf-8")
        assert _tests_went_green(spec) is False

    def test_an_unreadable_report_is_unknown_not_green(self, tmp_path):
        spec = self._spec(tmp_path)
        (spec / "qa_report.md").write_text("the run was inconclusive", encoding="utf-8")
        assert _tests_went_green(spec) is None
