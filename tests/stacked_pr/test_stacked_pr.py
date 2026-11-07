"""A task stacked on another one (killer feature F6), on the backend side.

B's worktree starts from A's local commit, even when the remote has an older
A; B's PR pushes A first and targets A's branch; with ``gh stack`` the two
PRs are linked, and a failed link never undoes B's PR. ``gh`` is simulated:
no test reaches GitHub.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from core import stacked_pr
from core.stacked_pr import gh_stack_available, link_after_pr, push_parent, stack_info
from core.worktree import WorktreeManager
from foundation.base_branch import detect_base_branch


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.fixture
def project(tmp_path):
    remote = tmp_path / "remote.git"
    _git(tmp_path, "init", "-q", "--bare", "-b", "develop", str(remote))
    root = tmp_path / "project"
    root.mkdir()
    _git(root, "init", "-q", "-b", "develop")
    _git(root, "config", "user.email", "t@example.test")
    _git(root, "config", "user.name", "t")
    (root / ".gitignore").write_text(".workpilot/\n", encoding="utf-8")
    (root / "app.py").write_text("A = 0\n", encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "base")
    _git(root, "remote", "add", "origin", str(remote))
    _git(root, "push", "-q", "-u", "origin", "develop")
    return root


def _stack_metadata(root: Path, spec: str, parent: str, sha: str) -> Path:
    spec_dir = root / ".workpilot" / "specs" / spec
    spec_dir.mkdir(parents=True, exist_ok=True)
    (spec_dir / "task_metadata.json").write_text(
        json.dumps(
            {
                "baseBranch": f"workpilot/{parent}",
                "useLocalBranch": True,
                "stackParent": parent,
                "stackParentSha": sha,
                "stackTrunk": "develop",
            }
        ),
        encoding="utf-8",
    )
    return spec_dir


def test_b_starts_from_as_local_commit_not_a_stale_remote(project):
    a = WorktreeManager(project, base_branch="develop").create_worktree("001-a")
    (a.path / "app.py").write_text("A = 1\n", encoding="utf-8")
    _git(a.path, "commit", "-qam", "A first")
    _git(a.path, "push", "-q", "-u", "origin", "workpilot/001-a")
    (a.path / "app.py").write_text("A = 2\n", encoding="utf-8")
    _git(a.path, "commit", "-qam", "A after its push")
    a_sha = _git(a.path, "rev-parse", "HEAD")

    spec_dir = _stack_metadata(project, "002-b", "001-a", a_sha)
    assert detect_base_branch(spec_dir, project) == "workpilot/001-a"
    b = WorktreeManager(
        project, base_branch="workpilot/001-a", use_local_branch=True
    ).create_worktree("002-b")
    assert _git(b.path, "rev-parse", "HEAD") == a_sha


def test_the_stack_is_only_read_for_a_pr_that_targets_the_parent(project):
    spec_dir = _stack_metadata(project, "002-b", "001-a", "abc")
    info = stack_info(spec_dir, "workpilot/001-a")
    assert info is not None and info.parent_branch == "workpilot/001-a"
    assert info.trunk == "develop"
    assert stack_info(spec_dir, "develop") is None  # moved onto the trunk already
    bad = _stack_metadata(project, "003-c", "../../etc", "abc")
    assert stack_info(bad, "workpilot/../../etc") is None


def test_the_parent_branch_is_pushed_before_bs_pr(project):
    manager = WorktreeManager(project, base_branch="develop")
    a = manager.create_worktree("001-a")
    (a.path / "app.py").write_text("A = 1\n", encoding="utf-8")
    _git(a.path, "commit", "-qam", "A")
    spec_dir = _stack_metadata(project, "002-b", "001-a", "x")
    assert push_parent(manager, stack_info(spec_dir, "workpilot/001-a")) is None
    remote_sha = _git(project, "ls-remote", "origin", "refs/heads/workpilot/001-a")
    assert remote_sha.split()[0] == _git(a.path, "rev-parse", "HEAD")


class _FakeGh:
    def __init__(self, installed: bool, link_code: int):
        self.installed = installed
        self.link_code = link_code
        self.calls: list[list[str]] = []

    def __call__(self, argv, **_kwargs):
        self.calls.append(argv)
        if argv[1:3] == ["extension", "list"]:
            out = "gh stack\tgithub/gh-stack\tv1.0.0\n" if self.installed else ""
            return subprocess.CompletedProcess(argv, 0, out, "")
        if argv[1:3] == ["stack", "link"]:
            return subprocess.CompletedProcess(argv, self.link_code, "", "boom")
        raise AssertionError(argv)


def test_gh_stack_links_the_two_branches_on_the_trunk(project, monkeypatch):
    fake = _FakeGh(installed=True, link_code=0)
    monkeypatch.setattr(stacked_pr.subprocess, "run", fake)
    spec_dir = _stack_metadata(project, "002-b", "001-a", "x")
    manager = WorktreeManager(project, base_branch="develop")
    linked = link_after_pr(
        manager, stack_info(spec_dir, "workpilot/001-a"), "002-b", "gh"
    )
    assert linked == (True, "")
    assert fake.calls[-1] == [
        "gh",
        "stack",
        "link",
        "--base",
        "develop",
        "workpilot/001-a",
        "workpilot/002-b",
    ]


def test_without_gh_stack_the_pr_targeting_the_parent_is_the_fallback(
    project, monkeypatch
):
    fake = _FakeGh(installed=False, link_code=0)
    monkeypatch.setattr(stacked_pr.subprocess, "run", fake)
    assert gh_stack_available("gh", project) is False
    spec_dir = _stack_metadata(project, "002-b", "001-a", "x")
    manager = WorktreeManager(project, base_branch="develop")
    linked, note = link_after_pr(
        manager, stack_info(spec_dir, "workpilot/001-a"), "002-b", "gh"
    )
    assert linked is False and "not installed" in note
    assert not any(c[1:3] == ["stack", "link"] for c in fake.calls)


def test_a_failed_link_leaves_bs_pr_created(project, monkeypatch):
    import core.worktree_pr as worktree_pr

    fake = _FakeGh(installed=True, link_code=4)
    monkeypatch.setattr(stacked_pr.subprocess, "run", fake)
    monkeypatch.setattr(worktree_pr, "get_gh_executable", lambda: "gh")
    monkeypatch.setattr(worktree_pr, "detect_git_provider", lambda *_a, **_k: "github")
    _stack_metadata(project, "002-b", "001-a", "x")
    manager = WorktreeManager(project, base_branch="develop")
    pushed: list[str] = []
    created: list[str | None] = []
    monkeypatch.setattr(manager, "_cross_review_hold", lambda _s: None)
    monkeypatch.setattr(manager, "_has_uncommitted_changes", lambda _s: (False, []))
    monkeypatch.setattr(manager, "_apply_discard_list", lambda *_a: [])
    monkeypatch.setattr(manager, "_strip_workpilot_artifacts", lambda _s: [])
    monkeypatch.setattr(manager, "strip_build_artifacts", lambda _s: None)
    monkeypatch.setattr(manager, "_count_commits_ahead", lambda *_a: 1)
    monkeypatch.setattr(manager, "worktree_exists", lambda _s: True)
    monkeypatch.setattr(
        manager,
        "push_branch",
        lambda spec, force=False: (
            pushed.append(spec)
            or {"success": True, "branch": f"workpilot/{spec}", "remote": "origin"}
        ),
    )
    monkeypatch.setattr(
        manager,
        "create_pull_request",
        lambda **kw: (
            created.append(kw["target_branch"])
            or {"success": True, "pr_url": "https://github.com/o/r/pull/2"}
        ),
    )
    result = manager.push_and_create_pr(
        spec_name="002-b", target_branch="workpilot/001-a", body="b"
    )
    assert result["success"] is True
    assert result["pr_url"] == "https://github.com/o/r/pull/2"
    assert result["stack_linked"] is False
    assert "GitHub API" in result["stack_note"]
    assert pushed == ["002-b", "001-a"]  # B, then its parent
    assert created == ["workpilot/001-a"]
