"""`main` receives `develop` by merge commits only.

Releases 1.3.0 to 1.3.3 reached `main` as squashes: `main` and `develop` stopped
sharing history and every `develop -> main` pull request conflicted on files
both sides had changed the same way. The ruleset now allows merge commits only
on `main`; these keep the release workflows from asking for anything else.
"""

from __future__ import annotations

from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

WORKFLOWS = Path(__file__).resolve().parents[1] / ".github" / "workflows"


def _load(name: str) -> dict:
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    "workflow", ["release.yml", "prepare-release.yml", "beta-release.yml"]
)
def test_release_workflows_never_squash_or_rebase(workflow):
    text = (WORKFLOWS / workflow).read_text(encoding="utf-8")
    assert "--squash" not in text
    assert "--rebase" not in text


def test_readme_reaches_main_by_merge_commit():
    steps = _load("release.yml")["jobs"]["update-readme"]["steps"]
    carry = next(s for s in steps if s.get("name") == "Carry the README to main")
    assert "gh pr merge" in carry["run"]
    assert "--merge" in carry["run"]


def test_readme_commit_is_shared_with_develop():
    steps = _load("release.yml")["jobs"]["update-readme"]["steps"]
    shared = next(s for s in steps if s.get("id") == "readme")
    run = shared["run"]
    # Built on main, then merged into develop: one commit, both histories.
    assert run.index("origin/main") < run.index("git merge --no-ff")


def test_guard_runs_on_every_push_to_main():
    data = _load("main-history-guard.yml")
    on = data.get("on", data.get(True))
    assert on["push"]["branches"] == ["main"]
    assert "paths" not in on["push"]
