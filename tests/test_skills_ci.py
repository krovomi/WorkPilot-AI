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
