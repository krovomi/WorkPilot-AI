"""The brain's git sync on the paths the round trips in ``test_brain`` do not
take: a busy or stale lock, a remote that refuses, git that times out, and the
histories a rebase cannot replay."""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest
from brain import sync as brain_sync
from brain.sync import (
    SyncResult,
    brain_lock,
    clone,
    ensure_attributes,
    ensure_ignored,
    ensure_repo,
    pull_if_stale,
    pull_interval,
    remote_url,
    set_remote,
    sync,
)

needs_git = pytest.mark.skipif(
    shutil.which("git") is None, reason="git is not installed"
)


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    monkeypatch.setenv("BRAIN_PULL_INTERVAL", "0")


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.email=v@x", "-c", "user.name=v", *args],
        cwd=cwd,
        capture_output=True,
        encoding="utf-8",
        check=True,
    ).stdout


def bare(tmp_path: Path, name: str = "remote.git") -> Path:
    remote = tmp_path / name
    subprocess.run(["git", "init", "-q", "--bare", str(remote)], check=True)
    return remote


def brain(tmp_path: Path, name: str, remote: Path | None = None) -> Path:
    root = tmp_path / name
    assert ensure_repo(root)
    if remote is not None:
        set_remote(root, str(remote))
    return root


def note(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def with_git(monkeypatch, answer):
    """Run the real git, except where *answer* returns a result of its own."""
    real = brain_sync._git

    def fake(root, *args, check=False):
        given = answer(args)
        return given if given is not None else real(root, *args, check=check)

    monkeypatch.setattr(brain_sync, "_git", fake)


def refused(*args: str, stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(list(args), 1, "", stderr)


# --------------------------------------------------------------------------- #
# The repository's own files
# --------------------------------------------------------------------------- #


class TestRepositoryFiles:
    def test_attributes_wait_for_a_repository(self, tmp_path):
        ensure_attributes(tmp_path)
        assert not (tmp_path / ".git").exists()

    @needs_git
    def test_attributes_that_cannot_be_written_are_logged(self, tmp_path, caplog):
        root = brain(tmp_path, "vault")
        attributes = root / ".git" / "info" / "attributes"
        attributes.unlink()
        attributes.mkdir()

        with caplog.at_level("DEBUG", logger="brain.sync"):
            ensure_attributes(root)

        assert "git attributes not written" in caplog.text

    def test_an_ignore_file_that_cannot_be_read_is_left_alone(
        self, tmp_path, monkeypatch
    ):
        (tmp_path / ".gitignore").write_text("mine\n", encoding="utf-8")
        real = Path.read_text

        def unreadable(self, *args, **kwargs):
            if self.name == ".gitignore":
                raise PermissionError("denied")
            return real(self, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", unreadable)

        ensure_ignored(tmp_path)

        monkeypatch.undo()
        assert (tmp_path / ".gitignore").read_text(encoding="utf-8") == "mine\n"

    def test_an_ignore_file_that_cannot_be_written_is_logged(self, tmp_path, caplog):
        # A read-only share, or a folder in its place: the brain still opens,
        # it only goes on without its ignore lines.
        (tmp_path / ".gitignore").mkdir()

        with caplog.at_level("DEBUG", logger="brain.sync"):
            ensure_ignored(tmp_path)

        assert "ignore file not written" in caplog.text

    def test_without_git_there_is_no_repository(self, tmp_path, monkeypatch):
        monkeypatch.setattr(brain_sync, "git_available", lambda: False)
        assert ensure_repo(tmp_path / "vault") is False
        assert sync(tmp_path / "vault").skipped == "no-git"

    @needs_git
    def test_a_refused_init_is_no_repository(self, tmp_path, monkeypatch):
        with_git(monkeypatch, lambda a: refused(*a) if a[0] == "init" else None)
        assert ensure_repo(tmp_path / "vault") is False

    @needs_git
    def test_a_second_remote_replaces_the_first(self, tmp_path):
        root = brain(tmp_path, "vault", bare(tmp_path, "one.git"))
        second = bare(tmp_path, "two.git")

        set_remote(root, str(second))

        assert remote_url(root) == str(second)


@needs_git
class TestRemoteBranch:
    def vault(self, tmp_path, branches: list[str], head: str) -> Path:
        remote = bare(tmp_path, "vault.git")
        seed = tmp_path / "seed"
        seed.mkdir()
        git(seed, "init", "-q")
        note(seed, "Vault.md", "from the vault\n")
        git(seed, "add", "-A")
        git(seed, "commit", "-qm", "vault")
        for name in branches:
            git(seed, "push", "-q", str(remote), f"HEAD:refs/heads/{name}")
        git(remote, "symbolic-ref", "HEAD", f"refs/heads/{head}")
        return remote

    def branches(self, remote: Path) -> list[str]:
        return git(remote, "branch", "--format=%(refname:short)").split()

    def test_the_remote_default_among_several(self, tmp_path):
        remote = self.vault(tmp_path, ["dev", "stable"], head="stable")
        root = brain(tmp_path, "brain", remote)
        note(root, "knowledge/a.md", "x\n")

        result = sync(root, "a")

        assert result.pushed and self.branches(remote) == ["dev", "stable"]
        assert git(remote, "log", "-1", "--format=%s", "stable") == "a\n"

    def test_master_when_the_remote_default_is_not_there(self, tmp_path):
        remote = self.vault(tmp_path, ["dev", "master"], head="trunk")
        root = brain(tmp_path, "brain", remote)

        result = sync(root, "a")

        assert result.pushed and self.branches(remote) == ["dev", "master"]
        assert (root / "Vault.md").is_file()

    def test_no_remote_without_a_repository(self, tmp_path):
        assert remote_url(tmp_path) is None


# --------------------------------------------------------------------------- #
# Clone
# --------------------------------------------------------------------------- #


class TestClone:
    @pytest.mark.parametrize(
        ("raised", "said"),
        [
            (subprocess.TimeoutExpired(["git"], 1), "git clone timed out"),
            (PermissionError("/home/me/secret/path"), "git clone could not start"),
        ],
    )
    def test_a_clone_that_does_not_run_says_so_without_its_paths(
        self, tmp_path, monkeypatch, raised, said
    ):
        def run(*_a, **_k):
            raise raised

        monkeypatch.setattr(brain_sync.subprocess, "run", run)

        assert clone("owner/repo", tmp_path / "vault") == said


# --------------------------------------------------------------------------- #
# The lock
# --------------------------------------------------------------------------- #


class TestLock:
    def test_a_lock_held_by_another_writer_is_not_taken(self, tmp_path):
        with brain_lock(tmp_path) as first:
            with brain_lock(tmp_path, timeout_s=0.2) as second:
                assert first is True and second is False
            # The writer that did not get it does not release it either.
            assert (tmp_path / brain_sync._LOCK_NAME).is_dir()
        assert not (tmp_path / brain_sync._LOCK_NAME).exists()

    def test_a_stale_lock_is_taken_over(self, tmp_path):
        lock = tmp_path / brain_sync._LOCK_NAME
        lock.mkdir()
        old = time.time() - brain_sync._STALE_LOCK_S - 10
        os.utime(lock, (old, old))

        with brain_lock(tmp_path, timeout_s=0) as acquired:
            assert acquired

    def test_a_lock_released_while_it_is_looked_at_is_tried_again(
        self, tmp_path, monkeypatch
    ):
        lock = tmp_path / brain_sync._LOCK_NAME
        lock.mkdir()
        real = Path.stat

        def vanished(self, *args, **kwargs):
            if self == lock:
                os.rmdir(lock)
                raise FileNotFoundError(lock)
            return real(self, *args, **kwargs)

        monkeypatch.setattr(Path, "stat", vanished)

        with brain_lock(tmp_path, timeout_s=0) as acquired:
            assert acquired

    @needs_git
    def test_a_sync_while_another_writer_holds_the_lock(self, tmp_path, monkeypatch):
        root = brain(tmp_path, "vault")
        real = brain_sync.brain_lock
        monkeypatch.setattr(
            brain_sync, "brain_lock", lambda where, timeout_s=30.0: real(where, 0.2)
        )

        with real(root):
            assert sync(root).skipped == "locked"


# --------------------------------------------------------------------------- #
# Pull and push
# --------------------------------------------------------------------------- #


@needs_git
class TestPull:
    def test_a_new_machine_takes_the_remote_as_it_is(self, tmp_path):
        remote = bare(tmp_path)
        first = brain(tmp_path, "A", remote)
        note(first, "knowledge/a.md", "from A\n")
        assert sync(first, "a").pushed
        empty = tmp_path / "B"
        empty.mkdir()
        git(empty, "init", "-q")
        git(empty, "remote", "add", "origin", str(remote))
        # Nothing to commit on this side: the ignore file the sync writes is
        # itself ignored here, so the repository has no commit when it pulls.
        (empty / ".git" / "info").mkdir(exist_ok=True)
        (empty / ".git" / "info" / "exclude").write_text(".gitignore\n", "utf-8")

        result = sync(empty, "b")

        assert result.pulled and result.received == []
        assert (empty / "knowledge" / "a.md").read_text(encoding="utf-8") == (
            "from A\n"
        )

    def test_a_history_a_rebase_cannot_replay_is_merged(self, tmp_path):
        # Locally a line is changed and changed back: replaying the first commit
        # conflicts with the remote, but the two trees do not disagree.
        remote = bare(tmp_path)
        a = brain(tmp_path, "A", remote)
        note(a, "knowledge/x.md", "base\n")
        assert sync(a, "base").pushed
        b = tmp_path / "B"
        git(tmp_path, "clone", "-q", "-b", "main", str(remote), str(b))
        note(b, "knowledge/x.md", "from B\n")
        git(b, "commit", "-qam", "b")
        git(b, "push", "-q", "origin", "HEAD")
        note(a, "knowledge/x.md", "changed here\n")
        git(a, "commit", "-qam", "change")
        note(a, "knowledge/x.md", "base\n")
        git(a, "commit", "-qam", "change back")

        result = sync(a, "a")

        assert result.pulled and result.pushed and result.conflicts == []
        assert (a / "knowledge" / "x.md").read_text(encoding="utf-8") == "from B\n"
        assert "Merge" in git(a, "log", "-1", "--format=%s")

    def test_a_note_deleted_here_and_changed_there_keeps_theirs(self, tmp_path):
        remote = bare(tmp_path)
        a = brain(tmp_path, "A", remote)
        note(a, "knowledge/x.md", "base\n")
        assert sync(a, "base").pushed
        b = tmp_path / "B"
        git(tmp_path, "clone", "-q", "-b", "main", str(remote), str(b))
        note(b, "knowledge/x.md", "changed there\n")
        git(b, "commit", "-qam", "b")
        git(b, "push", "-q", "origin", "HEAD")
        (a / "knowledge" / "x.md").unlink()

        result = sync(a, "a")

        assert result.conflicts == ["knowledge/x.md"] and result.pushed
        [theirs] = list((a / "knowledge").glob("x.conflict-*.md"))
        assert theirs.read_text(encoding="utf-8") == "changed there\n"

    def test_a_note_changed_here_and_deleted_there_stays(self, tmp_path):
        remote = bare(tmp_path)
        a = brain(tmp_path, "A", remote)
        note(a, "knowledge/x.md", "base\n")
        assert sync(a, "base").pushed
        b = tmp_path / "B"
        git(tmp_path, "clone", "-q", "-b", "main", str(remote), str(b))
        git(b, "rm", "-q", "knowledge/x.md")
        git(b, "commit", "-qm", "b")
        git(b, "push", "-q", "origin", "HEAD")
        note(a, "knowledge/x.md", "changed here\n")

        result = sync(a, "a")

        assert result.conflicts == ["knowledge/x.md"] and result.pushed
        assert (a / "knowledge" / "x.md").read_text(encoding="utf-8") == (
            "changed here\n"
        )
        assert list((a / "knowledge").glob("x.conflict-*")) == []

    def conflicted(self, tmp_path) -> Path:
        remote = bare(tmp_path)
        a = brain(tmp_path, "A", remote)
        b = brain(tmp_path, "B", remote)
        note(a, "knowledge/x.md", "A\n")
        assert sync(a, "a").pushed
        note(b, "knowledge/x.md", "B\n")
        return b

    def test_a_merge_git_refuses_before_merging_anything(self, tmp_path, monkeypatch):
        b = self.conflicted(tmp_path)
        with_git(
            monkeypatch,
            lambda a: (
                refused(*a, stderr="error: index.lock exists")
                if "merge" in a and "--no-edit" in a
                else None
            ),
        )

        result = sync(b, "b")

        assert (result.step, result.error) == ("pull", "error: index.lock exists")
        assert not result.pulled and not result.pushed

    def test_a_merge_that_cannot_be_committed_is_abandoned(self, tmp_path, monkeypatch):
        b = self.conflicted(tmp_path)
        with_git(
            monkeypatch,
            lambda a: (
                refused(*a)
                if "commit" in a and any("keep both" in x for x in a)
                else None
            ),
        )

        result = sync(b, "b")

        assert result.step == "pull" and not result.pulled
        assert result.error == (
            "merge could not be completed; local copy left unchanged"
        )
        assert (b / "knowledge" / "x.md").read_text(encoding="utf-8") == "B\n"

    def test_a_push_the_remote_refuses(self, tmp_path):
        remote = bare(tmp_path)
        hook = remote / "hooks" / "pre-receive"
        hook.write_text("#!/bin/sh\necho 'read only' >&2\nexit 1\n", encoding="utf-8")
        hook.chmod(0o755)
        root = brain(tmp_path, "A", remote)
        note(root, "knowledge/a.md", "x\n")

        result = sync(root, "a")

        assert result.committed and not result.pushed
        assert result.step == "push" and "read only" in result.error

    def test_a_sync_without_push_leaves_the_remote_alone(self, tmp_path):
        remote = bare(tmp_path)
        root = brain(tmp_path, "A", remote)
        note(root, "knowledge/a.md", "x\n")

        result = sync(root, "a", push=False)

        assert result.committed and not result.pushed and result.error is None
        assert git(remote, "branch") == ""


# --------------------------------------------------------------------------- #
# Git that does not answer
# --------------------------------------------------------------------------- #


@needs_git
@pytest.mark.parametrize(
    ("raised", "skipped", "error"),
    [
        (subprocess.TimeoutExpired(["git"], 60), "offline", "git timed out"),
        (
            PermissionError(13, "Permission denied"),
            None,
            "PermissionError: Permission denied",
        ),
        (OSError("no reason"), None, "OSError: OS error"),
    ],
)
def test_git_that_does_not_answer(tmp_path, monkeypatch, raised, skipped, error):
    root = brain(tmp_path, "A", bare(tmp_path))

    def fetch(args):
        if args[0] == "fetch":
            raise raised
        return None

    with_git(monkeypatch, fetch)

    result = sync(root, "a")

    assert (result.skipped, result.step, result.error) == (skipped, "git", error)


# --------------------------------------------------------------------------- #
# When to pull before a read
# --------------------------------------------------------------------------- #


@needs_git
class TestPullBeforeARead:
    def test_a_recent_pull_is_not_repeated(self, tmp_path, monkeypatch):
        root = brain(tmp_path, "A", bare(tmp_path))
        assert isinstance(pull_if_stale(root), SyncResult)
        monkeypatch.setenv("BRAIN_PULL_INTERVAL", "3600")

        assert pull_if_stale(root) is None

    def test_a_pull_time_that_cannot_be_read_is_a_pull_now(self, tmp_path, monkeypatch):
        root = brain(tmp_path, "A", bare(tmp_path))
        (root / ".git" / brain_sync._STAMP_NAME).write_text("soon", encoding="utf-8")
        monkeypatch.setenv("BRAIN_PULL_INTERVAL", "3600")

        assert isinstance(pull_if_stale(root), SyncResult)

    def test_a_pull_time_that_cannot_be_written_is_logged(self, tmp_path, caplog):
        root = brain(tmp_path, "A", bare(tmp_path))
        (root / ".git" / brain_sync._STAMP_NAME).mkdir()

        with caplog.at_level("DEBUG", logger="brain.sync"):
            result = sync(root, "a")

        assert result.error is None and "could not record the pull time" in caplog.text


def test_an_interval_that_is_not_a_number_is_the_default(monkeypatch):
    monkeypatch.setenv("BRAIN_PULL_INTERVAL", "often")
    assert pull_interval() == 60.0
