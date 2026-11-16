"""The coder's helpers: the commits it counts, the plan it reads, the spec it
syncs back from the worktree to the main project."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from agents import utils


def test_the_commits_of_a_repository_are_counted(temp_git_repo: Path) -> None:
    assert utils.get_commit_count(temp_git_repo) >= 1
    assert utils.get_latest_commit(temp_git_repo)


def test_a_folder_that_is_no_repository_has_no_commit(tmp_path: Path) -> None:
    folder = tmp_path / "plain"
    folder.mkdir()

    assert utils.get_commit_count(folder) == 0
    assert utils.get_latest_commit(folder) is None


def test_a_plan_that_is_missing_or_broken_is_none(tmp_path: Path) -> None:
    assert utils.load_implementation_plan(tmp_path) is None
    (tmp_path / "implementation_plan.json").write_text("{", encoding="utf-8")
    assert utils.load_implementation_plan(tmp_path) is None


def test_a_subtask_and_its_phase_are_found_by_id() -> None:
    plan = {"phases": [{"id": "p1", "subtasks": [{"id": "1.1"}, {"id": "1.2"}]}]}

    assert utils.find_subtask_in_plan(plan, "1.2") == {"id": "1.2"}
    assert utils.find_phase_for_subtask(plan, "1.2")["id"] == "p1"
    assert utils.find_subtask_in_plan(plan, "9") is None
    assert utils.find_phase_for_subtask(plan, "9") is None


# -- syncing the spec back to the main project -------------------------------------


@pytest.fixture
def worktree_spec(tmp_path: Path) -> Path:
    spec = tmp_path / "worktree" / ".workpilot" / "specs" / "001-login"
    (spec / "memory" / "sessions").mkdir(parents=True)
    (spec / "implementation_plan.json").write_text(
        json.dumps({"phases": []}), encoding="utf-8"
    )
    (spec / "memory" / "gotchas.md").write_text("cookies", encoding="utf-8")
    (spec / "memory" / "sessions" / "1.json").write_text("{}", encoding="utf-8")
    return spec


def test_every_spec_file_reaches_the_main_project(
    worktree_spec: Path, tmp_path: Path
) -> None:
    main = tmp_path / "main" / ".workpilot" / "specs" / "001-login"

    assert utils.sync_spec_to_source(worktree_spec, main) is True

    assert (main / "implementation_plan.json").is_file()
    assert (main / "memory" / "gotchas.md").read_text(encoding="utf-8") == "cookies"
    assert (main / "memory" / "sessions" / "1.json").is_file()


def test_nothing_is_synced_without_a_separate_main_spec(worktree_spec: Path) -> None:
    assert utils.sync_spec_to_source(worktree_spec, None) is False
    assert utils.sync_spec_to_source(worktree_spec, worktree_spec) is False


def test_a_spec_folder_that_is_gone_syncs_nothing(tmp_path: Path) -> None:
    assert utils.sync_spec_to_source(tmp_path / "gone", tmp_path / "main") is False


def test_one_item_that_cannot_be_copied_does_not_stop_the_others(
    worktree_spec: Path, tmp_path: Path
) -> None:
    main = tmp_path / "main"
    main.mkdir()
    # A file where the worktree has the memory folder: that folder fails.
    (main / "memory").write_text("in the way", encoding="utf-8")

    assert utils.sync_spec_to_source(worktree_spec, main) is True

    assert (main / "implementation_plan.json").is_file()
    assert (main / "memory").read_text(encoding="utf-8") == "in the way"


def test_links_are_never_followed_into_the_main_project(
    worktree_spec: Path, tmp_path: Path
) -> None:
    secret = tmp_path / "secret.txt"
    secret.write_text("TOP SECRET", encoding="utf-8")
    try:
        (worktree_spec / "notes.md").symlink_to(secret)
        (worktree_spec / "memory" / "key.md").symlink_to(secret)
    except OSError:
        pytest.skip("symlinks unavailable")
    main = tmp_path / "main"

    utils.sync_spec_to_source(worktree_spec, main)

    assert not (main / "notes.md").exists()
    assert not (main / "memory" / "key.md").exists()
    assert (main / "memory" / "gotchas.md").is_file()
