"""The skills check in CI compares the committed outputs, and the sync keeps them current.

lint.yml used to run `skills_cli.py build` right before `build --check`: the
build rewrote the outputs, so the check passed whatever was committed, and the
outputs read in production fell behind their sources (F125).
"""

from __future__ import annotations

from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

WORKFLOWS = Path(__file__).resolve().parents[1] / ".github" / "workflows"


def _steps(workflow: str, job: str) -> list[dict]:
    data = yaml.safe_load((WORKFLOWS / workflow).read_text(encoding="utf-8"))
    return data["jobs"][job]["steps"]


def _runs(steps: list[dict]) -> list[str]:
    return [step.get("run", "") for step in steps]


def test_lint_checks_the_skills_outputs_without_rebuilding_them_first():
    runs = _runs(_steps("lint.yml", "skills"))
    check = [i for i, run in enumerate(runs) if "skills_cli.py build --check" in run]
    assert check, "the skills job no longer checks the outputs"
    rebuilds = [
        i
        for i, run in enumerate(runs[: check[0]])
        if "skills_cli.py" in run and "build" in run and "--check" not in run
    ]
    assert rebuilds == [], "a build before the check makes it pass on stale outputs"


def test_the_weekly_sync_commits_the_rebuilt_outputs():
    steps = _steps("skills-sync.yml", "sync")
    runs = _runs(steps)
    build = [
        i
        for i, run in enumerate(runs)
        if run.strip() == "python3 scripts/skills_cli.py build"
    ]
    commit = [i for i, run in enumerate(runs) if "git commit" in run]
    assert build and commit and build[0] < commit[0]
    assert "git add -A" in runs[commit[0]]


def test_the_weekly_sync_builds_from_committed_content_only():
    """The bootstrapped packs are gitignored; built with them on disk, the
    outputs could not be reproduced by lint.yml's check (#683)."""
    runs = _runs(_steps("skills-sync.yml", "sync"))
    bootstrap = [i for i, run in enumerate(runs) if "skills_cli.py bootstrap" in run]
    clean = [
        i for i, run in enumerate(runs) if run.strip() == "git clean -fdX -- skills/"
    ]
    build = [
        i
        for i, run in enumerate(runs)
        if run.strip() == "python3 scripts/skills_cli.py build"
    ]
    assert bootstrap and clean and build
    assert bootstrap[0] < clean[0] < build[0]


def _named(steps: list[dict], name: str) -> dict:
    return next(step for step in steps if step.get("name") == name)


def test_the_sync_pull_request_is_opened_with_a_token_that_starts_ci():
    """GitHub starts no workflow for a push or a pull request made with the
    default token: #1059 never got a single check, so it could not merge."""
    steps = _steps("skills-sync.yml", "sync")
    open_pr = _named(steps, "Open a pull request")
    assert open_pr["env"]["GH_TOKEN"] == "${{ secrets.PAT_TOKEN || github.token }}"
    assert "x-access-token:${GH_TOKEN}@github.com" in open_pr["run"]
    assert '--head "$branch"' in open_pr["run"]


def test_the_sync_keeps_no_token_in_the_checkout():
    """The build runs on upstream content; the write token only exists in the
    step that pushes."""
    checkout = _named(_steps("skills-sync.yml", "sync"), "Checkout")
    assert checkout["with"]["persist-credentials"] is False
    others = [
        step
        for step in _steps("skills-sync.yml", "sync")
        if step.get("name") != "Open a pull request"
    ]
    assert all("PAT_TOKEN" not in str(step) for step in others)
