"""Pull and push: the brain stays the same brain on every machine and agent.

The brain is a git repository, and every modification is a commit. That gives
three things for free: a history (who wrote what, and when), a transport (any
git remote — GitHub, a bare repo on a NAS, a USB key), and a merge.

    sync()   commit what changed on disk -> pull (rebase) -> push

``sync`` is the one entry point, and it runs at two moments:

| When | Why |
|---|---|
| before a read (throttled by ``BRAIN_PULL_INTERVAL``) | an agent never answers from a brain another agent updated a minute ago |
| after every write | a note written here is on the remote before the tool call returns |

Committing *before* pulling is what makes edits made outside any agent —
a person typing in Obsidian — reach the remote too: the next agent that reads
the brain carries them along.

**Nothing is ever lost in a conflict.** Notes are one file each, so two agents
rarely touch the same file; when they do, a rebase is tried, then a merge, and
if the same lines still disagree both versions are kept — ours at the path,
theirs beside it as ``<name>.conflict-<short sha>.md`` — and the conflict is
reported. Picking a winner silently would be deciding, on a person's behalf,
which of two agents was right.

**Nothing here can break an agent.** No git, no remote, no network: the brain
works locally and the result says why nothing was pushed.

**One writer at a time.** Several agents share one working tree on one machine;
two ``git commit`` at once collide on ``.git/index.lock``. A lock directory
(``mkdir`` is atomic on every platform) serialises them, and a lock older than
``_STALE_LOCK_S`` is taken over — a crashed agent must not freeze the brain.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path

__all__ = [
    "SyncResult",
    "ensure_repo",
    "sync",
    "pull_if_stale",
    "remote_url",
    "set_remote",
    "brain_lock",
    "git_available",
]

_LOCK_NAME = "workpilot-brain.lock"
_STAMP_NAME = "workpilot-brain-last-pull"
_STALE_LOCK_S = 120
_GIT_TIMEOUT_S = 60

_AUTHOR = ["-c", "user.name=WorkPilot Brain", "-c", "user.email=brain@workpilot.local"]


@dataclass
class SyncResult:
    committed: bool = False
    pulled: bool = False
    pushed: bool = False
    remote: str | None = None
    conflicts: list[str] = field(default_factory=list)
    skipped: str | None = None
    """Why a step did not run: ``no-git``, ``no-remote``, ``offline``…"""
    error: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def git_available() -> bool:
    return shutil.which("git") is not None


def _git(root: Path, *args: str, check: bool = False) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env.setdefault("GIT_TERMINAL_PROMPT", "0")
    return subprocess.run(
        ["git", *args],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=_GIT_TIMEOUT_S,
        check=check,
        env=env,
    )


def _has_identity(root: Path) -> bool:
    return bool(_git(root, "config", "user.email").stdout.strip())


def _commit(root: Path, message: str) -> bool:
    _git(root, "add", "-A")
    if not _git(root, "status", "--porcelain").stdout.strip():
        return False
    ident = [] if _has_identity(root) else _AUTHOR
    return _git(root, *ident, "commit", "-q", "-m", message).returncode == 0


def ensure_repo(root: Path) -> bool:
    """Make *root* a git repository if it is not one. False when git is absent."""
    if not git_available():
        return False
    root.mkdir(parents=True, exist_ok=True)
    if (root / ".git").exists():
        return True
    if _git(root, "init", "-q").returncode != 0:
        return False
    _git(root, "symbolic-ref", "HEAD", "refs/heads/main")
    gitignore = root / ".gitignore"
    if not gitignore.exists():
        # Obsidian's workspace layout changes on every click; committing it
        # would make every sync a conflict between two window layouts.
        # The graph and the digest are rebuilt from the notes after every pull;
        # committing them would make two machines conflict on every sync.
        gitignore.write_text(
            ".obsidian/workspace*.json\n.obsidian/cache\n.trash/\n.DS_Store\n"
            "graphify-out/\nINSTRUCTIONS.md\n",
            encoding="utf-8",
        )
    return True


def remote_url(root: Path) -> str | None:
    if not (root / ".git").exists() or not git_available():
        return None
    out = _git(root, "remote", "get-url", "origin")
    if out.returncode != 0:
        return None
    return out.stdout.strip() or None


def set_remote(root: Path, url: str) -> None:
    ensure_repo(root)
    if remote_url(root):
        _git(root, "remote", "set-url", "origin", url, check=True)
    else:
        _git(root, "remote", "add", "origin", url, check=True)


def _branch(root: Path) -> str:
    out = _git(root, "symbolic-ref", "--short", "HEAD").stdout.strip()
    return out or "main"


@contextmanager
def brain_lock(root: Path, timeout_s: float = 30.0):
    """Serialise writers on this machine. Yields whether the lock was obtained."""
    lock_parent = root / ".git" if (root / ".git").is_dir() else root
    lock_parent.mkdir(parents=True, exist_ok=True)
    lock = lock_parent / _LOCK_NAME
    deadline = time.monotonic() + timeout_s
    acquired = False
    while True:
        try:
            lock.mkdir()
            acquired = True
            break
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > _STALE_LOCK_S:
                    shutil.rmtree(lock, ignore_errors=True)
                    continue
            except OSError:
                continue
            if time.monotonic() >= deadline:
                break
            time.sleep(0.1)
    try:
        yield acquired
    finally:
        if acquired:
            shutil.rmtree(lock, ignore_errors=True)


def _keep_both(root: Path, their_ref: str) -> list[str]:
    """Resolve every conflicted file by keeping ours in place and theirs beside it."""
    conflicted = [
        line.strip()
        for line in _git(
            root, "diff", "--name-only", "--diff-filter=U"
        ).stdout.splitlines()
        if line.strip()
    ]
    short = _git(root, "rev-parse", "--short", their_ref).stdout.strip() or "remote"
    for rel in conflicted:
        ours = _git(root, "show", f":2:{rel}")
        theirs = _git(root, "show", f":3:{rel}")
        target = root / rel
        if ours.returncode == 0:
            target.write_text(ours.stdout, encoding="utf-8")
        if theirs.returncode == 0:
            stem, dot, ext = rel.rpartition(".")
            side = (
                f"{stem}.conflict-{short}.{ext}" if dot else f"{rel}.conflict-{short}"
            )
            (root / side).write_text(theirs.stdout, encoding="utf-8")
        elif ours.returncode != 0:
            # deleted on both sides differently: keep whatever is on disk
            pass
    _git(root, "add", "-A")
    return conflicted


def _pull(root: Path, result: SyncResult) -> None:
    branch = _branch(root)
    fetch = _git(root, "fetch", "-q", "origin")
    if fetch.returncode != 0:
        result.skipped = "offline"
        result.error = fetch.stderr.strip()[-500:] or None
        return
    remote_ref = f"origin/{branch}"
    if _git(root, "rev-parse", "--verify", "-q", remote_ref).returncode != 0:
        # An empty remote: nothing to pull, the push below creates the branch.
        return
    if _git(root, "rev-parse", "--verify", "-q", "HEAD").returncode != 0:
        _git(root, "reset", "-q", "--hard", remote_ref)
        result.pulled = True
        return
    ident = [] if _has_identity(root) else _AUTHOR
    rebase = _git(root, *ident, "rebase", "-q", remote_ref)
    if rebase.returncode == 0:
        result.pulled = True
        return
    _git(root, "rebase", "--abort")
    merge = _git(
        root,
        *ident,
        "merge",
        "-q",
        "--no-edit",
        "--allow-unrelated-histories",
        remote_ref,
    )
    if merge.returncode == 0:
        result.pulled = True
        return
    result.conflicts = _keep_both(root, remote_ref)
    committed = _git(
        root,
        *ident,
        "commit",
        "-q",
        "-m",
        f"brain: keep both sides of {len(result.conflicts)} conflict(s)",
    )
    result.pulled = committed.returncode == 0
    if not result.pulled:
        _git(root, "merge", "--abort")
        result.error = "merge could not be completed; local copy left unchanged"


def sync(root: Path, message: str = "brain: sync", *, push: bool = True) -> SyncResult:
    """Commit local changes, pull the remote, push the result."""
    result = SyncResult()
    if not ensure_repo(root):
        result.skipped = "no-git"
        return result
    with brain_lock(root) as acquired:
        if not acquired:
            result.skipped = "locked"
            return result
        try:
            result.committed = _commit(root, message)
            result.remote = remote_url(root)
            if not result.remote:
                result.skipped = "no-remote"
                return result
            _pull(root, result)
            if result.skipped == "offline" or result.error:
                return result
            _stamp(root)
            if push:
                pushed = _git(root, "push", "-q", "-u", "origin", _branch(root))
                result.pushed = pushed.returncode == 0
                if not result.pushed:
                    result.error = pushed.stderr.strip()[-500:] or "push refused"
        except subprocess.TimeoutExpired:
            result.skipped = "offline"
            result.error = "git timed out"
        except OSError as exc:
            result.error = str(exc)
    return result


def _stamp(root: Path) -> None:
    try:
        (root / ".git" / _STAMP_NAME).write_text(str(time.time()), encoding="utf-8")
    except OSError:
        pass


def _last_pull(root: Path) -> float:
    try:
        return float((root / ".git" / _STAMP_NAME).read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return 0.0


def pull_interval() -> float:
    try:
        return max(0.0, float(os.environ.get("BRAIN_PULL_INTERVAL", "60")))
    except ValueError:
        return 60.0


def pull_if_stale(root: Path) -> SyncResult | None:
    """A sync before a read, at most once per ``BRAIN_PULL_INTERVAL`` seconds."""
    if not (root / ".git").exists() or not remote_url(root):
        return None
    if time.time() - _last_pull(root) < pull_interval():
        return None
    return sync(root, "brain: local edits")
