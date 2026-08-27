"""Tests for the resolved-profile endpoint the Kanban reads.

Chantier 4 asks for the user to see what an effort level buys *before* the
build runs. Three properties this endpoint has to hold to be worth showing:

* dropped phases are returned in their declared position, with their reason —
  a list of survivors cannot answer "what would one level more give me";
* resolving is **side-effect free**, because the UI may poll it and the other
  provider-resolution path eats the single-shot "resume with X" marker;
* a caller cannot walk out of the project or the workflows folder.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from workflows.api import router  # noqa: E402

_app = FastAPI()
_app.include_router(router)
_client = TestClient(_app)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / ".workpilot" / "specs" / "001-x").mkdir(parents=True)
    return tmp_path


def get(**params):
    """Call the endpoint the way the renderer does — over HTTP.

    Through the app rather than the function, so query parsing, the
    `includeLevels` alias and the optional-parameter defaults are exercised
    instead of being bypassed by a direct Python call.
    """
    clean = {k: v for k, v in params.items() if v is not None}
    return _client.get("/api/workflow-profile/", params=clean).json()


def ask(project: Path, **kwargs):
    return get(project_dir=str(project), spec_id="001-x", **kwargs)


class TestResolution:
    def test_it_returns_the_shipped_pipeline(self, project):
        res = ask(project, effort="high")
        assert res["success"] is True
        ids = [p["id"] for p in res["profile"]["phases"]]
        assert ids[0] == "brainstorm"
        assert ids[-1] == "observe"

    def test_dropped_phases_stay_in_place_with_a_reason(self, project):
        res = ask(project, effort="low")
        by_id = {p["id"]: p for p in res["profile"]["phases"]}
        assert by_id["brainstorm"]["runs"] is False
        assert by_id["brainstorm"]["skipReason"] == "effort"
        assert by_id["brainstorm"]["minEffort"] == "high"
        # …and the position is preserved, not filtered out.
        assert [p["id"] for p in res["profile"]["phases"]][0] == "brainstorm"

    def test_the_hard_gate_runs_at_the_cheapest_level(self, project):
        res = ask(project, effort="low")
        verify = next(p for p in res["profile"]["phases"] if p["id"] == "verify")
        assert verify["runs"] is True
        assert verify["hardGate"] == "tests-pass"

    def test_a_degradation_is_reported_not_hidden(self, project, monkeypatch):
        import types

        import skills_registry.providers as providers

        monkeypatch.setattr(
            providers,
            "get_provider_capabilities",
            lambda name: types.SimpleNamespace(supports_subagents=False),
        )
        res = ask(project, effort="high", provider="mistral")
        coding = next(p for p in res["profile"]["phases"] if p["id"] == "coding")
        assert coding["dispatch"] == "sequential-reset"
        assert coding["degradedFrom"] == "subagent-per-task"
        assert coding["degradedReason"]

    def test_each_level_is_priced(self, project):
        res = ask(project, effort="medium")
        counts = {lvl["effort"]: lvl["count"] for lvl in res["profile"]["levels"]}
        assert counts["low"] < counts["medium"] < counts["high"] < counts["ultrathink"]

    def test_levels_can_be_left_out(self, project):
        res = ask(project, effort="medium", includeLevels="false")
        assert "levels" not in res["profile"]

    def test_the_deterministic_phase_is_flagged(self, project):
        res = ask(project, effort="low")
        design = next(p for p in res["profile"]["phases"] if p["id"] == "design-check")
        assert design["deterministic"] is True
        assert design["runs"] is True


class TestItDoesNotTouchAnything:
    def test_resolving_leaves_the_resume_marker_alone(self, project, monkeypatch):
        """The UI may poll this. It must not eat a single-shot choice."""
        from core.client import RESUME_WITH_PROVIDER_FILE

        monkeypatch.delenv("AUTO_CLAUDE_PROVIDER", raising=False)
        spec = project / ".workpilot" / "specs" / "001-x"
        marker = spec / RESUME_WITH_PROVIDER_FILE
        marker.write_text("copilot", encoding="utf-8")

        assert ask(project)["success"] is True
        assert marker.exists()


class TestItAnswersForRealProjects:
    """The regression that shipped and had to be undone.

    A `py/path-injection` autofix confined `project_dir` to the WorkPilot
    repository. It silenced the alert and the feature with it: WorkPilot builds
    *other people's* projects, so the project directory is outside this
    repository by definition. Ten tests failed and the endpoint answered
    nothing for any real user.
    """

    def test_a_project_outside_this_repository_is_answered(self, project):
        # `project` is a tmp_path fixture — the shape of a real user's checkout.
        # Assert the property under test, not the runner's temp layout: macOS
        # resolves tmp_path under /private/var and Windows under C:\, so a
        # prefix check on "/tmp" tests the platform, not the containment.
        assert not project.resolve().is_relative_to(REPO_ROOT.resolve())

        res = ask(project, effort="high")
        assert res["success"] is True
        assert res["profile"]["runCount"] > 0

    def test_the_same_holds_for_an_explicit_spec_dir(self, project):
        spec = project / ".workpilot" / "specs" / "001-x"
        res = get(spec_dir=str(spec), effort="high")
        assert res["success"] is True


class TestItRefusesToWander:
    def test_a_path_carrying_dot_dot_is_refused(self, project):
        """An explicit refusal, not a behaviour change.

        `resolve()` normalises `..` away, so this rejects nothing that would
        otherwise have been reachable. What is asserted is that the endpoint
        says so by name, with a reason from `_REASONS` rather than a message
        built from the caller's own input.

        An earlier version of this docstring claimed the check kept
        `py/path-injection` off the file. It does not — a full scan still
        reports it, because an unconstrained project path is the feature. See
        `core.api_safety` for where that judgement is now recorded.
        """
        res = get(project_dir=f"{project}/../..", spec_id="001-x")
        assert res["success"] is False
        assert res["error"] == "the path must not contain '..'"

    @pytest.mark.parametrize("spec_id", ["../..", "a/b", "", ".", ".."])
    def test_a_spec_id_is_a_directory_name(self, project, spec_id):
        res = get(project_dir=str(project), spec_id=spec_id)
        assert res["success"] is False

    def test_a_workflow_name_cannot_escape_the_folder(self, project):
        res = ask(project, workflow="../../etc")
        assert res["success"] is False
        assert res["reason"] == "workflow"

    def test_a_missing_spec_is_an_error_not_a_guess(self, tmp_path):
        res = get(project_dir=str(tmp_path), spec_id="404-nope")
        assert res["success"] is False

    def test_neither_form_of_address_is_an_error(self, tmp_path):
        res = get()
        assert res["success"] is False
        assert res["reason"] == "addressing"
        assert "spec_dir" in res["error"]

    def test_the_error_never_echoes_a_resolved_path(self, project):
        """What a caller is told is a literal written in the module.

        An exception message here carries the resolved filesystem path it
        failed on, which is exactly the detail an error must not hand back.
        The log keeps it; the response does not.
        """
        missing = project / "nope"
        res = get(spec_dir=str(missing))
        assert res["success"] is False
        assert res["reason"] == "missing"
        assert str(missing) not in res["error"]
        assert "nope" not in res["error"]
