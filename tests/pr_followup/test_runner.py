"""The runner's inputs come from the app: resolved and contained before use."""

from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path

import pytest

RUNNER = (
    Path(__file__).resolve().parents[2]
    / "apps"
    / "backend"
    / "runners"
    / "pr_followup_runner.py"
)


def _runner():
    spec = importlib.util.spec_from_file_location("pr_followup_runner", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _layout(tmp_path: Path) -> Path:
    project = tmp_path / "project"
    (project / ".workpilot" / "worktrees" / "tasks" / "001-x").mkdir(parents=True)
    (project / ".workpilot" / "specs" / "001-x").mkdir(parents=True)
    return project


def _args(project: Path, **kw) -> argparse.Namespace:
    values = {
        "project_dir": str(project),
        "spec_dir": str(project / ".workpilot" / "specs" / "001-x"),
        "spec_name": "001-x",
        "worktree_dir": None,
    }
    values.update(kw)
    return argparse.Namespace(**values)


def test_the_default_worktree_is_the_tasks(tmp_path: Path) -> None:
    project = _layout(tmp_path)
    _, spec, worktree = _runner()._resolve_inputs(_args(project))
    assert (
        worktree == (project / ".workpilot" / "worktrees" / "tasks" / "001-x").resolve()
    )
    assert spec.name == "001-x"


@pytest.mark.parametrize("name", ["../001-x", "", "-rf", "a/b"])
def test_a_spec_name_that_is_a_path_is_refused(tmp_path: Path, name: str) -> None:
    project = _layout(tmp_path)
    with pytest.raises(ValueError, match="spec name"):
        _runner()._resolve_inputs(_args(project, spec_name=name))


def test_a_spec_dir_outside_the_project_is_refused(tmp_path: Path) -> None:
    project = _layout(tmp_path)
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    with pytest.raises(ValueError, match="spec directory"):
        _runner()._resolve_inputs(_args(project, spec_dir=str(outside)))


def test_a_symlink_out_of_the_project_is_refused(tmp_path: Path) -> None:
    project = _layout(tmp_path)
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    link = project / ".workpilot" / "specs" / "link"
    link.symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="spec directory"):
        _runner()._resolve_inputs(_args(project, spec_dir=str(link)))
