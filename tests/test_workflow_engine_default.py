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

import json
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
    def test_no_reasoning_task_still_runs_validation(self, tmp_path, monkeypatch):
        """The UI's per-phase `none` setting must not remove QA after coding."""
        monkeypatch.delenv("WORKPILOT_WORKFLOW_ENGINE", raising=False)
        spec = tmp_path / "002-namespace"
        spec.mkdir()
        (spec / "task_metadata.json").write_text(
            json.dumps(
                {
                    "provider": "openai",
                    "thinkingLevel": "ultrathink",
                    "phaseThinking": dict.fromkeys(
                        ("spec", "planning", "coding", "qa"), "none"
                    ),
                }
            ),
            encoding="utf-8",
        )
        for changed_files in (None, ["src/Rag.Api/Program.cs"]):
            profile = _resolve_workflow_profile(spec, changed_files, announce=False)
            assert profile.effort == "none"
            assert profile.will_run("qa")
            assert profile.phase_ids.index("coding") < profile.phase_ids.index("qa")
            # The verification runs before QA (the reviewer gets its evidence)
            # and is replayed after it, without a model.
            assert profile.phase_ids.index("verify") < profile.phase_ids.index("qa")
            assert profile.phase_ids.index("qa") < profile.phase_ids.index(
                "verify-replay"
            )

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
        assert profile.declared[0] == "docs"
        assert profile.declared[-1] == "observe"
        assert "qa" in profile.declared

    def test_the_documentation_phase_survives_the_weakest_effort(
        self, tmp_path, monkeypatch
    ):
        """`docs` costs no API call, so no effort level may drop it.

        The phase reads manifests and counts imports; pruning it saves nothing
        and buys a coder writing against remembered API signatures.
        """
        monkeypatch.delenv("WORKPILOT_WORKFLOW_ENGINE", raising=False)
        spec = tmp_path / "001-x"
        spec.mkdir()
        (spec / "task_metadata.json").write_text(
            '{"phase_thinking": {"coding": "low"}}', encoding="utf-8"
        )
        profile = _resolve_workflow_profile(spec, announce=False)
        assert profile.will_run("docs")


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


class TestTheProfileFollowsTheTaskEngine:
    """A task resumed "with X" records X in task_metadata.json and locks it.

    The profile is resolved at the start of the build: it must name the engine
    the task owns, not the app-wide default.
    """

    def test_resolving_a_profile_uses_the_locked_engine(self, tmp_path, monkeypatch):
        monkeypatch.delenv("WORKPILOT_WORKFLOW_ENGINE", raising=False)
        monkeypatch.delenv("AUTO_CLAUDE_PROVIDER", raising=False)
        monkeypatch.setenv("SELECTED_LLM_PROVIDER", "openai")
        spec = tmp_path / "001-x"
        spec.mkdir()
        (spec / "task_metadata.json").write_text(
            '{"engineLocked": true, "provider": "copilot"}', encoding="utf-8"
        )

        profile = _resolve_workflow_profile(spec, announce=False)
        assert profile is not None
        assert profile.provider == "copilot"
