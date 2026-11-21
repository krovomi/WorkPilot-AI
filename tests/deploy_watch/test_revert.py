"""The revert PR of a deployment judged critical (#366)."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from core import deploy_revert
from deploy_watch import revert
from deploy_watch.revert import (
    RevertRequest,
    open_revert,
    request_for,
    revert_in,
    target_branch,
)

SHA = "b" * 40


def _git(repo, *args):
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


def _commit(repo: Path, name: str, text: str) -> str:
    (repo / name).write_text(text, encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-qm", f"edit {name}")
    return _git(repo, "rev-parse", "HEAD")


@pytest.fixture
def repo(tmp_path):
    _git(tmp_path, "init", "-q", "-b", "main")
    _git(tmp_path, "config", "user.email", "t@example.com")
    _git(tmp_path, "config", "user.name", "t")
    _commit(tmp_path, "app.txt", "one\n")
    return tmp_path


class TestRevertIn:
    def test_a_commit(self, repo):
        bad = _commit(repo, "app.txt", "two\n")
        assert revert_in(repo, bad) == "ready"
        assert (repo / "app.txt").read_text(encoding="utf-8") == "one\n"
        assert _git(repo, "log", "-1", "--format=%s").startswith("Revert")

    def test_a_merge_commit_against_its_first_parent(self, repo):
        _git(repo, "checkout", "-qb", "feature")
        _commit(repo, "feature.txt", "new\n")
        _git(repo, "checkout", "-q", "main")
        _git(repo, "merge", "-q", "--no-ff", "-m", "merge", "feature")
        merge = _git(repo, "rev-parse", "HEAD")
        assert revert_in(repo, merge) == "ready"
        assert not (repo / "feature.txt").exists()

    def test_a_conflict_leaves_nothing_behind(self, repo):
        bad = _commit(repo, "app.txt", "two\n")
        _commit(repo, "app.txt", "three\n")
        head = _git(repo, "rev-parse", "HEAD")
        assert revert_in(repo, bad) == "conflict"
        assert _git(repo, "rev-parse", "HEAD") == head
        assert _git(repo, "status", "--porcelain") == ""

    def test_not_on_the_branch(self, repo):
        _git(repo, "checkout", "-qb", "pr")
        elsewhere = _commit(repo, "pr.txt", "x\n")
        _git(repo, "checkout", "-q", "main")
        assert revert_in(repo, elsewhere) == "not_on_branch"

    @pytest.mark.parametrize("sha", ["", "HEAD", "--abort", "g" * 40])
    def test_not_a_commit_id(self, repo, sha):
        assert revert_in(repo, sha) == "no_commit"

    def test_unknown_commit(self, repo):
        assert revert_in(repo, "c" * 40) == "unknown_commit"

    @pytest.mark.parametrize("failing", ["merge-base", "rev-list"])
    def test_git_fails(self, repo, monkeypatch, failing):
        bad = _commit(repo, "app.txt", "two\n")
        real = revert.run_git

        def run_git(args, cwd=None):
            if args[0] == failing:
                return subprocess.CompletedProcess(args, 128, "", "boom")
            return real(args, cwd=cwd)

        monkeypatch.setattr(revert, "run_git", run_git)
        assert revert_in(repo, bad) == "failed"


class TestRequest:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("main", "main"),
            ("refs/heads/release/1.2", "release/1.2"),
            ("-x", ""),
            ("a..b", ""),
            ("a b", ""),
            (None, ""),
        ],
    )
    def test_target_branch(self, raw, expected):
        assert target_branch(raw) == expected

    def test_request(self):
        request = request_for("17", SHA, "## Numbers\n", "main")
        assert request.name == "deploy-revert-17"
        assert request.target == "main"
        assert request.title == f"Revert {SHA[:12]}: deployment 17 failed its watch"
        assert f"This reverts `{SHA}`" in request.body
        assert "## Numbers" in request.body


class TestOpenRevert:
    def test_offline_and_bad_input(self):
        opener = lambda r: pytest.fail("must not open")  # noqa: E731
        assert open_revert("17", SHA, "", offline=True, opener=opener) == {
            "status": "offline"
        }
        for run_id, sha in (("x", SHA), ("17", ""), ("17", "HEAD")):
            assert open_revert(run_id, sha, "", offline=False, opener=opener) == {
                "status": "no_commit"
            }
        assert open_revert("17", SHA, "", offline=False, opener=None) == {
            "status": "unavailable"
        }

    def test_opened(self):
        seen: list[RevertRequest] = []

        def opener(request):
            seen.append(request)
            return {
                "status": "opened",
                "url": "https://github.com/o/r/pull/3",
                "provider": "github",
            }

        result = open_revert(
            "17", SHA, "body", target="release", offline=False, opener=opener
        )
        assert result == {
            "status": "opened",
            "sha": SHA,
            "url": "https://github.com/o/r/pull/3",
            "provider": "github",
        }
        assert seen[0].target == "release"

    @pytest.mark.parametrize(
        "answer",
        [None, {"status": "merged"}, {"status": "opened", "url": "http://x/pr/1"}],
    )
    def test_answers_are_bounded(self, answer):
        result = open_revert("17", SHA, "", offline=False, opener=lambda r: answer)
        assert "url" not in result and "provider" not in result
        expected = "opened" if answer and answer["status"] == "opened" else "failed"
        assert result["status"] == expected

    def test_opener_fails(self):
        def opener(_request):
            raise OSError("no network")

        assert open_revert("17", SHA, "", offline=False, opener=opener) == {
            "status": "failed",
            "error": "OSError",
        }


class FakeManager:
    """`WorktreeManager`, as far as the revert opener uses it."""

    branch_exists = False
    create_error: Exception | None = None
    pr_result: dict = {}
    remove_error: Exception | None = None

    def __init__(self, project_dir, base_branch=None):
        self.project_dir = project_dir
        self.base_branch = base_branch or "main"
        self.calls: list[tuple] = []
        FakeManager.last = self

    def get_branch_name(self, name):
        return f"workpilot/{name}"

    def _branch_exists(self, branch):
        return self.branch_exists

    def find_existing_pr_url(self, name, target):
        self.calls.append(("find", name, target))
        return None

    def create_worktree(self, name):
        if self.create_error:
            raise self.create_error

        class Info:
            path = self.project_dir

        return Info()

    def push_and_create_pr(self, name, **kwargs):
        self.calls.append(("pr", name, kwargs))
        return self.pr_result

    def remove_worktree(self, name, delete_branch=False):
        self.calls.append(("remove", name, delete_branch))
        if self.remove_error:
            raise self.remove_error


@pytest.fixture
def manager(monkeypatch):
    class Manager(FakeManager):
        pass

    monkeypatch.setattr(deploy_revert, "WorktreeManager", Manager)
    monkeypatch.setattr(deploy_revert, "revert_in", lambda path, sha: "ready")
    return Manager


REQUEST = RevertRequest("17", SHA, "Revert", "body", target="release")


class TestForgeOpener:
    def test_opens_the_pr_on_its_own_branch(self, tmp_path, manager):
        manager.pr_result = {
            "success": True,
            "pushed": True,
            "pr_url": "https://gitlab.com/o/r/-/merge_requests/4",
            "provider": "gitlab",
        }
        result = deploy_revert.open_revert_pr(tmp_path)(REQUEST)
        assert result == {
            "status": "opened",
            "url": "https://gitlab.com/o/r/-/merge_requests/4",
            "provider": "gitlab",
        }
        calls = manager.last.calls
        assert calls[0] == (
            "pr",
            "deploy-revert-17",
            {"target_branch": "release", "title": "Revert", "body": "body"},
        )
        # Pushed: the branch stays, the worktree goes.
        assert calls[1] == ("remove", "deploy-revert-17", False)

    def test_already_open(self, tmp_path, manager):
        manager.pr_result = {"success": True, "pushed": True, "already_exists": True}
        assert deploy_revert.open_revert_pr(tmp_path)(REQUEST)["status"] == "exists"

    def test_an_existing_branch_is_not_reverted_twice(self, tmp_path, manager):
        manager.branch_exists = True
        result = deploy_revert.open_revert_pr(tmp_path)(
            RevertRequest("17", SHA, "t", "b")
        )
        assert result == {"status": "exists", "url": ""}
        assert manager.last.calls == [("find", "deploy-revert-17", "main")]

    def test_no_worktree(self, tmp_path, manager):
        manager.create_error = ValueError("bad name")
        assert deploy_revert.open_revert_pr(tmp_path)(REQUEST) == {"status": "failed"}
        assert manager.last.calls == []

    def test_revert_not_ready(self, tmp_path, manager, monkeypatch):
        monkeypatch.setattr(deploy_revert, "revert_in", lambda path, sha: "conflict")
        assert deploy_revert.open_revert_pr(tmp_path)(REQUEST) == {"status": "conflict"}
        # Nothing pushed: the branch goes with the worktree.
        assert manager.last.calls == [("remove", "deploy-revert-17", True)]

    def test_push_or_pr_fails(self, tmp_path, manager):
        manager.pr_result = {"success": False, "pushed": False, "error": "denied"}
        manager.remove_error = RuntimeError("dirty")
        assert deploy_revert.open_revert_pr(tmp_path)(REQUEST) == {
            "status": "failed",
            "provider": "",
        }
        assert manager.last.calls[-1] == ("remove", "deploy-revert-17", True)


def test_a_real_worktree(tmp_path, monkeypatch):
    """The opener with the real WorktreeManager: the revert lands on its branch."""
    from core.worktree import WorktreeManager

    origin, project = tmp_path / "origin.git", tmp_path / "project"
    _git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    _git(tmp_path, "clone", "-q", str(origin), str(project))
    _git(project, "config", "user.email", "t@example.com")
    _git(project, "config", "user.name", "t")
    _commit(project, "app.txt", "one\n")
    bad = _commit(project, "app.txt", "two\n")
    _git(project, "push", "-q", "origin", "main")
    seen = {}

    def push_and_create_pr(self, name, **kwargs):
        path = self.get_worktree_path(name)
        seen["text"] = (path / "app.txt").read_text(encoding="utf-8")
        seen["branch"] = _git(path, "branch", "--show-current")
        return {"success": True, "pushed": False, "pr_url": "https://x/pr/1"}

    monkeypatch.setattr(WorktreeManager, "push_and_create_pr", push_and_create_pr)
    result = deploy_revert.open_revert_pr(project)(
        RevertRequest("17", bad, "Revert", "body", target="main")
    )
    assert result["status"] == "opened"
    assert seen == {"text": "one\n", "branch": "workpilot/deploy-revert-17"}
    # Never on the default branch; the worktree is gone afterwards.
    assert (project / "app.txt").read_text(encoding="utf-8") == "two\n"
    assert not (
        project / ".workpilot" / "worktrees" / "tasks" / "deploy-revert-17"
    ).exists()
