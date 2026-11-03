"""The GitHub workflows open the hermes learning cycle.

`hermes.loop.SURFACES` listed ``github`` and nothing called it. A finished pull
request review, follow-up review or issue triage now turns the cycle, so what
hermes learned meanwhile reaches ``skills/_proposed/`` without waiting for the
next build. Desktop only, like the hermes API.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from hermes.loop import SURFACES  # noqa: E402
from runners.github import hermes_observe  # noqa: E402
from runners.github.hermes_observe import SURFACE, observe_with_hermes  # noqa: E402

_real_server_mode = hermes_observe._server_mode


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    """Never the brain or the hermes home of whoever runs the suite."""
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(tmp_path / "absent-brain"))
    monkeypatch.setattr(hermes_observe, "_server_mode", lambda: False)


@pytest.fixture
def home(tmp_path: Path, monkeypatch) -> Path:
    """A hermes home holding one skill the agent authored itself."""
    root = tmp_path / "hermes-home"
    skill = root / "skills" / "diagnose-the-flake" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text(
        "---\nname: diagnose-the-flake\ndescription: A learned procedure.\n---\n\n"
        "Do the thing.\n",
        encoding="utf-8",
    )
    usage = root / "skills" / ".usage.json"
    usage.write_text(
        '{"diagnose-the-flake": {"created_by": "agent"}}', encoding="utf-8"
    )
    monkeypatch.setenv("HERMES_HOME", str(root))
    return root


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    root.mkdir()
    return root


def _proposed(project: Path) -> list[str]:
    return sorted(p.name for p in (project / "skills" / "_proposed").glob("*.md"))


def test_the_surface_is_a_known_one():
    assert SURFACE in SURFACES


def test_a_finished_github_workflow_files_what_hermes_learned(home, project):
    result = asyncio.run(observe_with_hermes(project))

    assert result is not None and result.proposed == 1
    assert _proposed(project) == ["hermes--diagnose-the-flake.md"]
    body = (
        project / "skills" / "_proposed" / "hermes--diagnose-the-flake.md"
    ).read_text(encoding="utf-8")
    assert "surface: github" in body


def test_server_mode_skips_the_turn(home, project, monkeypatch):
    """On a shared server $HERMES_HOME is the server's, not the tenant's."""
    monkeypatch.setattr(hermes_observe, "_server_mode", lambda: True)

    assert asyncio.run(observe_with_hermes(project)) is None
    assert not (project / "skills" / "_proposed").exists()


def test_server_mode_is_read_from_the_server_roots(monkeypatch, tmp_path):
    monkeypatch.setattr("foundation.api_safety.server_mode_roots", lambda: [tmp_path])
    assert _real_server_mode() is True
    monkeypatch.setattr("foundation.api_safety.server_mode_roots", lambda: None)
    assert _real_server_mode() is False


def test_an_absent_hermes_files_nothing(project, monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "nowhere"))
    monkeypatch.setattr("hermes.readiness._executable", lambda: None)

    result = asyncio.run(observe_with_hermes(project))

    assert result is not None and not result.ran
    assert not (project / "skills" / "_proposed").exists()


def test_an_issue_triage_turns_the_cycle(home, project):
    """Through the orchestrator, end to end on its own flow, with GitHub faked."""
    from runners.github.orchestrator import GitHubOrchestrator

    saved: list[int] = []

    class _Result:
        labels_to_add: list[str] = []
        labels_to_remove: list[str] = []

        def __init__(self, number: int):
            self.number = number

        async def save(self, _github_dir: Path) -> None:
            saved.append(self.number)

    async def _triage(issue, _all):
        return _Result(issue["number"])

    async def _fetch(number):
        return {"number": number}

    orch = GitHubOrchestrator.__new__(GitHubOrchestrator)
    orch.project_dir = project
    orch.github_dir = project / ".workpilot" / "github"
    orch._report_progress = lambda *a, **k: None
    orch._fetch_issue_data = _fetch
    orch.triage_engine = SimpleNamespace(triage_single_issue=_triage)

    results = asyncio.run(orch.triage_issues(issue_numbers=[7]))

    assert saved == [7] and len(results) == 1
    assert _proposed(project) == ["hermes--diagnose-the-flake.md"]


def test_the_review_workflows_turn_the_cycle_after_saving():
    """Both PR review paths call it once their result is saved, never before:
    the verdict must not depend on what hermes filed."""
    source = (
        REPO_ROOT / "apps" / "backend" / "runners" / "github" / "orchestrator.py"
    ).read_text(encoding="utf-8")
    for method, nxt in (
        ("async def review_pr(", "async def followup_review_pr("),
        ("async def followup_review_pr(", "def _generate_verdict("),
    ):
        body = source[source.index(method) : source.index(nxt)]
        assert body.count("await observe_with_hermes(self.project_dir)") == 1, method
        assert body.index("await result.save(self.github_dir)") < body.index(
            "await observe_with_hermes(self.project_dir)"
        ), method
