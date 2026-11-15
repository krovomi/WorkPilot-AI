"""The post-commit hook earlier versions installed comes back out of a project.

It called a module that does not exist, so it never recorded anything. A
project's own hook, or its own part of a hook WorkPilot appended to, is kept.
"""

from __future__ import annotations

import pytest
from core.workspace import workspace_setup
from core.workspace.workspace_setup import remove_timeline_hook

WHOLE_HOOK = """#!/bin/bash
#
# Git post-commit hook for FileTimelineTracker
# =============================================
#
COMMIT_HASH=$(git rev-parse HEAD)
exit 0
"""

PROJECT_HOOK = "#!/bin/sh\necho 'project hook'\n"

APPENDED = (
    PROJECT_HOOK
    + "\n\n# FileTimelineTracker integration\n"
    + "\n#\n# Git post-commit hook for FileTimelineTracker\nexit 0\n"
)


@pytest.fixture(autouse=True)
def fresh_session(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(workspace_setup, "_git_hook_check_done", False)


def _hooks(project):
    hooks = project / ".git" / "hooks"
    hooks.mkdir(parents=True)
    return hooks


def test_a_hook_that_was_entirely_workpilots_is_deleted(tmp_path):
    hook = _hooks(tmp_path) / "post-commit"
    hook.write_text(WHOLE_HOOK, encoding="utf-8")

    assert remove_timeline_hook(tmp_path) is True
    assert not hook.exists()


def test_an_appended_hook_gives_the_project_its_own_part_back(tmp_path):
    hooks = _hooks(tmp_path)
    (hooks / "post-commit").write_text(APPENDED, encoding="utf-8")
    (hooks / "post-commit.backup").write_text(PROJECT_HOOK, encoding="utf-8")

    assert remove_timeline_hook(tmp_path) is True
    assert (hooks / "post-commit").read_text(encoding="utf-8") == PROJECT_HOOK
    assert not (hooks / "post-commit.backup").exists()


def test_a_backup_that_says_something_else_is_kept(tmp_path):
    hooks = _hooks(tmp_path)
    (hooks / "post-commit").write_text(APPENDED, encoding="utf-8")
    (hooks / "post-commit.backup").write_text("#!/bin/sh\nold\n", encoding="utf-8")

    assert remove_timeline_hook(tmp_path) is True
    assert (hooks / "post-commit.backup").read_text(encoding="utf-8") == (
        "#!/bin/sh\nold\n"
    )


def test_a_project_hook_is_left_alone(tmp_path):
    hook = _hooks(tmp_path) / "post-commit"
    hook.write_text(PROJECT_HOOK + "# mentions FileTimelineTracker\n", encoding="utf-8")

    assert remove_timeline_hook(tmp_path) is False
    assert hook.read_text(encoding="utf-8") == (
        PROJECT_HOOK + "# mentions FileTimelineTracker\n"
    )


@pytest.mark.parametrize("relative", [True, False])
def test_a_worktree_git_file_is_followed(tmp_path, relative):
    real = tmp_path / "repo-git"
    (real / "hooks").mkdir(parents=True)
    (real / "hooks" / "post-commit").write_text(WHOLE_HOOK, encoding="utf-8")
    project = tmp_path / "project"
    project.mkdir()
    target = "../repo-git" if relative else real.as_posix()
    (project / ".git").write_text(f"gitdir: {target}\n", encoding="utf-8")

    assert remove_timeline_hook(project) is True
    assert not (real / "hooks" / "post-commit").exists()


@pytest.mark.parametrize("git_file", [None, "not a gitdir line\n"])
def test_nothing_to_do_outside_a_repository(tmp_path, git_file):
    if git_file is not None:
        (tmp_path / ".git").write_text(git_file, encoding="utf-8")
    assert remove_timeline_hook(tmp_path) is False


def test_no_hook_at_all(tmp_path):
    _hooks(tmp_path)
    assert remove_timeline_hook(tmp_path) is False


def test_a_hook_that_cannot_be_read_is_reported_not_raised(tmp_path):
    (_hooks(tmp_path) / "post-commit").write_bytes(b"\xff\xfe\x00")
    assert remove_timeline_hook(tmp_path) is False


def test_it_looks_once_per_session(tmp_path):
    hook = _hooks(tmp_path) / "post-commit"
    assert remove_timeline_hook(tmp_path) is False
    hook.write_text(WHOLE_HOOK, encoding="utf-8")
    assert remove_timeline_hook(tmp_path) is False
    assert hook.exists()
