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

import logging
import os
import re
import shutil
import subprocess
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = [
    "SyncResult",
    "ensure_repo",
    "sync",
    "pull_if_stale",
    "remote_url",
    "set_remote",
    "normalize_remote",
    "clone",
    "ensure_ignored",
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
    step: str | None = None
    """Where it failed: ``commit``, ``fetch``, ``pull``, ``push`` or ``git``."""

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
        # Notes are UTF-8; the platform default on Windows is not, and a
        # conflicted note decoded as cp1252 is written back as mojibake.
        encoding="utf-8",
        errors="replace",
        timeout=_GIT_TIMEOUT_S,
        check=check,
        env=env,
    )


def _has_identity(root: Path) -> bool:
    # git needs both; a machine with an e-mail and no name refuses to commit.
    return bool(
        _git(root, "config", "user.email").stdout.strip()
        and _git(root, "config", "user.name").stdout.strip()
    )


def _commit(root: Path, message: str, result: SyncResult | None = None) -> bool:
    """Commit everything on disk. A refusal is recorded on *result*.

    It used to be ignored, and a commit that failed left the working tree
    dirty: the rebase after it refused ("unstaged changes"), the merge
    refused ("would be overwritten") and the sync reported a merge problem
    for what was an index lock or a missing identity.
    """
    added = _git(root, "add", "-A")
    if not _git(root, "status", "--porcelain").stdout.strip():
        return False
    ident = [] if _has_identity(root) else _AUTHOR
    done = _git(root, *ident, "commit", "-q", "-m", message)
    if done.returncode != 0 and result is not None:
        result.step = "commit"
        result.error = (done.stderr or added.stderr).strip()[-500:] or "commit refused"
    return done.returncode == 0


_IGNORED = (
    # Obsidian's workspace layout changes on every click; committing it would
    # make every sync a conflict between two window layouts.
    ".obsidian/workspace*.json",
    ".obsidian/cache",
    ".trash/",
    ".DS_Store",
    # Rebuilt from the notes after every pull; committed, two machines each
    # adding a note would conflict on them at every sync.
    "graphify-out/",
    ".workpilot-brain/INSTRUCTIONS.md",
)


def ensure_ignored(root: Path) -> None:
    """Add the lines the brain needs to ``.gitignore``, keeping everything else.

    Run on every repository, not only one this module created: a vault a
    person plugs in is often already a git repository (the obsidian-git
    plugin), and its ignore file is theirs to keep.
    """
    path = root / ".gitignore"
    try:
        current = path.read_text(encoding="utf-8") if path.is_file() else ""
    except OSError:
        return
    present = {line.strip() for line in current.splitlines()}
    missing = [line for line in _IGNORED if line not in present]
    if not missing:
        return
    sep = "" if not current or current.endswith("\n") else "\n"
    block = "# WorkPilot Brain\n" if "# WorkPilot Brain" not in present else ""
    path.write_text(current + sep + block + "\n".join(missing) + "\n", encoding="utf-8")


def ensure_repo(root: Path) -> bool:
    """Make *root* a git repository if it is not one. False when git is absent."""
    if not git_available():
        return False
    root.mkdir(parents=True, exist_ok=True)
    if not (root / ".git").exists():
        if _git(root, "init", "-q").returncode != 0:
            return False
        _git(root, "symbolic-ref", "HEAD", "refs/heads/main")
    ensure_ignored(root)
    return True


_GITHUB_SHORTHAND = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$"
)
_REMOTE = re.compile(
    r"^(?:https?://[^\s]+|ssh://[^\s]+|git@[A-Za-z0-9.-]+:[^\s]+|file://[^\s]+|/[^\s]*|[A-Za-z]:[\\/][^\s]*)$"
)


def normalize_remote(value: str) -> str:
    """A git remote the brain may clone from and push to, or ``ValueError``.

    ``owner/repo`` is GitHub shorthand. Everything else must name its transport
    — https, ssh, ``git@host:``, file, or a local path — because the value ends
    up in ``git clone`` and ``git remote add``: a string starting with ``-`` is
    an option there (``--upload-pack=…`` runs a program), and ``ext::`` is a
    transport that runs one too. Both are refused before git ever sees them.
    """
    text = (value or "").strip()
    if not text:
        raise ValueError("an empty remote")
    if _GITHUB_SHORTHAND.fullmatch(text):
        return f"https://github.com/{text.removesuffix('.git')}.git"
    if text.startswith("-") or "::" in text or not _REMOTE.fullmatch(text):
        raise ValueError(f"not a git remote: {text!r}")
    return text


def clone(remote: str, root: Path, timeout_s: int = 180) -> str | None:
    """Clone *remote* into *root*; returns None, or why it failed."""
    url = normalize_remote(remote)
    root.parent.mkdir(parents=True, exist_ok=True)
    try:
        done = subprocess.run(
            ["git", "clone", "-q", "--", url, str(root)],
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_s,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
    except subprocess.TimeoutExpired:
        return "git clone timed out"
    except OSError as exc:
        return str(exc)
    if done.returncode != 0:
        return done.stderr.strip()[-500:] or "git clone failed"
    return None


def remote_url(root: Path) -> str | None:
    if not (root / ".git").exists() or not git_available():
        return None
    out = _git(root, "remote", "get-url", "origin")
    if out.returncode != 0:
        return None
    return out.stdout.strip() or None


def set_remote(root: Path, url: str) -> None:
    url = normalize_remote(url)
    ensure_repo(root)
    if remote_url(root):
        _git(root, "remote", "set-url", "--", "origin", url, check=True)
    else:
        _git(root, "remote", "add", "--", "origin", url, check=True)


def _branch(root: Path) -> str:
    out = _git(root, "symbolic-ref", "--short", "HEAD").stdout.strip()
    return out or "main"


def _remote_branch(root: Path, local: str) -> str:
    """The branch of ``origin`` this brain follows, after a fetch.

    The local one when the remote has it. Otherwise the remote's only
    branch, or its default: a brain started here on ``main`` and plugged
    into a vault kept on ``master`` used to find no ``origin/main``, take the
    remote for empty, and push a second branch beside the vault instead of
    pulling it.
    """
    if _git(root, "rev-parse", "--verify", "-q", f"origin/{local}").returncode == 0:
        return local
    names = [
        ref.removeprefix("origin/")
        for ref in _git(
            root, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"
        ).stdout.split()
        if ref.startswith("origin/") and ref != "origin/HEAD"
    ]
    if len(names) == 1:
        return names[0]
    head = _git(root, "ls-remote", "--symref", "origin", "HEAD").stdout
    match = re.search(r"^ref: refs/heads/(\S+)\s+HEAD", head, re.M)
    if match and match.group(1) in names:
        return match.group(1)
    for name in ("main", "master"):
        if name in names:
            return name
    return local


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


def _conflicted(root: Path) -> list[str]:
    """The unmerged paths, as they are on disk.

    ``-z`` and not line output: git quotes a path with a non-ASCII byte and
    escapes it in octal (``"Id\\303\\251es.md"``), so a French note came back
    as a name no file has — ``git show :2:<that>`` failed, nothing was
    resolved, and the note was committed and pushed with its conflict
    markers in it.
    """
    out = _git(root, "diff", "--name-only", "-z", "--diff-filter=U").stdout
    return sorted({rel for rel in out.split("\0") if rel})


def _keep_both(root: Path, their_ref: str) -> list[str]:
    """Resolve every conflicted file by keeping ours in place and theirs beside it."""
    conflicted = _conflicted(root)
    short = _git(root, "rev-parse", "--short", their_ref).stdout.strip() or "remote"
    for rel in conflicted:
        ours = _git(root, "show", f":2:{rel}")
        theirs = _git(root, "show", f":3:{rel}")
        target = root / rel
        if ours.returncode == 0:
            target.write_text(ours.stdout, encoding="utf-8", newline="")
        if theirs.returncode == 0:
            stem, dot, ext = rel.rpartition(".")
            side = (
                f"{stem}.conflict-{short}.{ext}" if dot else f"{rel}.conflict-{short}"
            )
            (root / side).write_text(theirs.stdout, encoding="utf-8", newline="")
        # Neither side readable (deleted on one, changed on the other): whatever
        # is on disk stays, and `git add -A` below records it.
    _git(root, "add", "-A")
    return conflicted


def _pull(root: Path, result: SyncResult) -> str:
    """Bring ``origin`` in; returns the remote branch the push goes to."""
    fetch = _git(root, "fetch", "-q", "origin")
    if fetch.returncode != 0:
        result.skipped = "offline"
        result.step = "fetch"
        result.error = fetch.stderr.strip()[-500:] or None
        return _branch(root)
    branch = _remote_branch(root, _branch(root))
    remote_ref = f"origin/{branch}"
    if _git(root, "rev-parse", "--verify", "-q", remote_ref).returncode != 0:
        # An empty remote: nothing to pull, the push below creates the branch.
        return branch
    if _git(root, "rev-parse", "--verify", "-q", "HEAD").returncode != 0:
        _git(root, "reset", "-q", "--hard", remote_ref)
        result.pulled = True
        return branch
    ident = [] if _has_identity(root) else _AUTHOR
    rebase = _git(root, *ident, "rebase", "-q", remote_ref)
    if rebase.returncode == 0:
        result.pulled = True
        return branch
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
        return branch
    if not _conflicted(root):
        # Refused before merging anything: nothing to keep both sides of.
        _git(root, "merge", "--abort")
        result.step = "pull"
        result.error = (merge.stderr or rebase.stderr).strip()[-500:] or "merge refused"
        return branch
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
        result.step = "pull"
        result.error = (
            committed.stderr.strip()[-500:]
            or "merge could not be completed; local copy left unchanged"
        )
    return branch


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
            result.committed = _commit(root, message, result)
            if result.error:
                return result
            result.remote = remote_url(root)
            if not result.remote:
                result.skipped = "no-remote"
                return result
            branch = _pull(root, result)
            if result.skipped == "offline" or result.error:
                return result
            _stamp(root)
            if push:
                pushed = _git(root, "push", "-q", "-u", "origin", f"HEAD:{branch}")
                result.pushed = pushed.returncode == 0
                if not result.pushed:
                    result.step = "push"
                    result.error = pushed.stderr.strip()[-500:] or "push refused"
        except subprocess.TimeoutExpired:
            result.skipped = "offline"
            result.step = result.step or "git"
            result.error = "git timed out"
        except OSError as exc:
            result.step = result.step or "git"
            result.error = f"{type(exc).__name__}: {exc.strerror or 'OS error'}"
    return result


def _stamp(root: Path) -> None:
    try:
        (root / ".git" / _STAMP_NAME).write_text(str(time.time()), encoding="utf-8")
    except OSError as exc:
        # Only costs an early re-pull on the next read; not worth failing a sync.
        logger.debug("could not record the pull time in %s: %s", root, exc)


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
