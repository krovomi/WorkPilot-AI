"""The captures branch, written with plumbing against a real bare remote."""

from __future__ import annotations

import io
import json
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from core.capture_hosting.branch import BranchStore, spec_key
from PIL import Image


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", "-q", str(remote)], check=True)
    work = tmp_path / "work"
    work.mkdir()
    _git(work, "init", "-q", "-b", "main")
    _git(work, "config", "user.name", "Dev")
    _git(work, "config", "user.email", "dev@example.com")
    (work / "app.txt").write_text("code\n", encoding="utf-8")
    _git(work, "add", "app.txt")
    _git(work, "commit", "-q", "-m", "init")
    _git(work, "remote", "add", "origin", str(remote))
    _git(work, "push", "-q", "origin", "main")
    return work


def _png(path: Path, colour: tuple[int, int, int]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), colour).save(buffer, format="PNG")
    path.write_bytes(buffer.getvalue())
    return path


def _remote_files(repo: Path, branch: str = "workpilot-captures") -> list[str]:
    remote = repo.parent / "remote.git"
    return _git(remote, "ls-tree", "-r", "--name-only", branch).splitlines()


def test_a_key_names_one_task_s_pull_request():
    assert spec_key("001-login", 12) == "001-login-pr12"
    odd = spec_key("../../etc", 3)
    assert odd.endswith("-pr3") and "/" not in odd and ".." not in odd


def test_the_images_go_to_a_branch_that_shares_nothing_with_the_code(repo):
    shots = repo.parent / "shots"
    files = {
        "captures/published/task/web--orders.png": _png(shots / "a.png", (1, 2, 3)),
        "captures/published/base/web--orders.png": _png(shots / "b.png", (4, 5, 6)),
    }
    status_before = _git(repo, "status", "--porcelain")
    result = BranchStore(repo, "origin", "workpilot-captures").update(
        "001-x-pr1", files
    )
    assert result.ok, result.reason
    after = result.paths["captures/published/task/web--orders.png"]
    assert after.startswith("001-x-pr1/after/a-") and after.endswith(".png")
    assert result.paths["captures/published/base/web--orders.png"].startswith(
        "001-x-pr1/before/b-"
    )
    listed = _remote_files(repo)
    assert set(listed) == {"README.md", "index.json", *result.paths.values()}
    remote = repo.parent / "remote.git"
    parents = _git(remote, "rev-list", "--parents", "-n", "1", "workpilot-captures")
    assert len(parents.split()) == 1  # no parent: never merged by mistake
    # The person's checkout and branch are untouched.
    assert _git(repo, "status", "--porcelain") == status_before
    assert _git(repo, "branch", "--show-current") == "main"


def test_a_second_task_keeps_the_first_and_an_update_replaces_its_own(repo):
    shots = repo.parent / "shots"
    store = BranchStore(repo, "origin", "workpilot-captures")
    first = store.update("001-x-pr1", {"t/a.png": _png(shots / "a.png", (1, 1, 1))})
    store.update("002-y-pr2", {"t/b.png": _png(shots / "b.png", (2, 2, 2))})
    again = store.update("001-x-pr1", {"t/a.png": _png(shots / "a.png", (9, 9, 9))})
    listed = _remote_files(repo)
    assert first.paths["t/a.png"] not in listed  # new bytes, new path
    assert again.paths["t/a.png"] in listed
    assert any(p.startswith("002-y-pr2/") for p in listed)
    store.update("002-y-pr2", None)
    assert not any(p.startswith("002-y-pr2/") for p in _remote_files(repo))
    index = json.loads(
        _git(repo.parent / "remote.git", "show", "workpilot-captures:index.json")
    )
    assert set(index["tasks"]) == {"001-x-pr1"}


def test_tasks_older_than_the_retention_are_purged(repo):
    shots = repo.parent / "shots"
    start = datetime(2026, 11, 1, tzinfo=UTC)
    old = BranchStore(repo, "origin", "workpilot-captures", now=lambda: start)
    old.update("001-x-pr1", {"t/a.png": _png(shots / "a.png", (1, 1, 1))})
    later = BranchStore(
        repo,
        "origin",
        "workpilot-captures",
        retention_days=30,
        now=lambda: start + timedelta(days=31),
    )
    result = later.update("002-y-pr2", {"t/b.png": _png(shots / "b.png", (2, 2, 2))})
    assert result.purged == 1
    assert not any(p.startswith("001-x-pr1/") for p in _remote_files(repo))
    kept = BranchStore(
        repo,
        "origin",
        "workpilot-captures",
        retention_days=0,
        now=lambda: start + timedelta(days=900),
    )
    assert (
        kept.update("003-z-pr3", {"t/c.png": _png(shots / "c.png", (3, 3, 3))}).purged
        == 0
    )


def test_removing_what_was_never_published_pushes_nothing(repo):
    result = BranchStore(repo, "origin", "workpilot-captures").update("001-x-pr1", None)
    assert result.ok
    remote = repo.parent / "remote.git"
    assert _git(remote, "branch", "--list", "workpilot-captures") == ""


def test_a_race_with_another_publish_is_retried(repo):
    shots = repo.parent / "shots"
    store = BranchStore(repo, "origin", "workpilot-captures")
    store.update("001-x-pr1", {"t/a.png": _png(shots / "a.png", (1, 1, 1))})
    real = store._push
    calls: list[str] = []

    def push(commit: str, lease: str) -> str:
        calls.append(lease)
        if len(calls) == 1:
            # Another task publishes between our read and our push.
            other = BranchStore(repo, "origin", "workpilot-captures")
            other.update("009-z-pr9", {"t/z.png": _png(shots / "z.png", (5, 5, 5))})
        return real(commit, lease)

    store._push = push  # type: ignore[method-assign]
    result = store.update("002-y-pr2", {"t/b.png": _png(shots / "b.png", (2, 2, 2))})
    assert result.ok and len(calls) == 2
    listed = _remote_files(repo)
    assert any(p.startswith("009-z-pr9/") for p in listed)
    assert any(p.startswith("002-y-pr2/") for p in listed)


def test_an_unreachable_remote_is_a_reason_not_an_error(repo):
    store = BranchStore(repo, "nowhere", "workpilot-captures")
    result = store.update(
        "001-x-pr1", {"t/a.png": _png(repo.parent / "a.png", (1, 1, 1))}
    )
    assert (result.ok, result.reason) == (False, "remote-unreachable")


# ── When one git step fails ──────────────────────────────────────────────


class _Done:
    def __init__(self, returncode: int, stdout: str = "", stderr: str = ""):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


def _failing(verb: str, answer: _Done | None = None):
    """The real git, except `verb`, which answers `answer` (a failure)."""
    from foundation.git_executable import run_git

    def git(args, **kwargs):
        if args[0] == verb:
            return answer or _Done(1, "", "fatal: refused")
        return run_git(args, **kwargs)

    return git


def _published_once(repo: Path) -> dict[str, Path]:
    files = {
        "captures/published/task/home.png": _png(repo.parent / "s" / "a.png", (1, 2, 3))
    }
    assert (
        BranchStore(repo, "origin", "workpilot-captures").update("001-x-pr1", files).ok
    )
    return files


@pytest.mark.parametrize(
    ("verb", "answer", "reason"),
    [
        ("fetch", None, "fetch-failed"),
        ("ls-tree", None, "read-failed"),
        ("hash-object", _Done(0, "not a sha"), "write-failed"),
        ("read-tree", None, "write-failed"),
        ("update-index", None, "write-failed"),
        ("write-tree", _Done(0, ""), "write-failed"),
        ("commit-tree", _Done(0, "zzz"), "write-failed"),
        ("push", _Done(1, "", "remote: hook declined"), "push-refused"),
    ],
)
def test_a_git_step_that_fails_is_the_result_s_reason_and_nothing_moves(
    repo, verb, answer, reason
):
    files = _published_once(repo)
    before = _remote_files(repo)
    store = BranchStore(
        repo, "origin", "workpilot-captures", git=_failing(verb, answer)
    )
    result = store.update("002-y-pr2", files)
    assert (result.ok, result.reason, result.paths) == (False, reason, {})
    assert _remote_files(repo) == before


def test_a_branch_that_keeps_moving_gives_up_busy(repo):
    files = _published_once(repo)
    store = BranchStore(
        repo,
        "origin",
        "workpilot-captures",
        git=_failing("push", _Done(1, "", "! [rejected] (stale info)")),
    )
    assert store.update("002-y-pr2", files).reason == "busy"


def test_an_index_that_is_not_json_is_read_as_empty(repo):
    files = _published_once(repo)
    from foundation.git_executable import run_git

    def git(args, **kwargs):
        if args[:2] == ["cat-file", "blob"]:
            return _Done(0, "{broken")
        return run_git(args, **kwargs)

    result = BranchStore(repo, "origin", "workpilot-captures", git=git).update(
        "002-y-pr2", files
    )
    assert result.ok
    index = json.loads(
        _git(repo.parent / "remote.git", "show", "workpilot-captures:index.json")
    )
    assert set(index["tasks"]) == {"002-y-pr2"}


def test_dates_without_a_zone_or_unreadable_age_like_any_other(repo):
    start = datetime(2026, 1, 1, tzinfo=UTC)
    store = BranchStore(
        repo,
        "origin",
        "workpilot-captures",
        now=lambda: start + timedelta(days=31),
    )
    index = {
        "tasks": {
            "naive-old": {"updatedAt": "2025-12-01T00:00:00"},
            "naive-new": {
                "updatedAt": (start + timedelta(days=30))
                .replace(tzinfo=None)
                .isoformat()
            },
            "garbled": {"updatedAt": "yesterday"},
            "empty": None,
        }
    }
    assert store._expired(index) == {"naive-old", "garbled", "empty"}
