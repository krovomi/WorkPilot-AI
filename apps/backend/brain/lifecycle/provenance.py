"""Which notes of a project memory came signed by a trusted key (#352).

The vault is a git repository shared through a remote: whoever can push
there can put a note in front of every agent of the team. When a project
lists its trusted signers (`signers.py`), each note's last change is
attributed to its commit and that commit's signature is checked by git
itself (``%G?`` / ``%GF``, the machinery of ``git verify-commit``, with
``gpg.ssh.allowedSignersFile`` pointing at the list for SSH keys):

| Verdict | When |
|---|---|
| ``own`` | written on this machine and not synced yet: a change on disk, or a commit no remote has |
| ``verified`` | its last commit is signed by a key on the list |
| ``unverified`` | anything else: unsigned, signed by another key, a signature git cannot check, a conflict copy (the other side's text) |

An unverified note stays readable wherever a person reads memory, with a
mark; it is kept out of what agents are given (`project_memory`,
`Brain.recall`, the MCP server, `mem_search`, the learning loop's prompt
patterns) and no automatic conflict rule settles a pair it is part of.

**The list protects itself.** A change to it that came from someone else
counts only when a key already on it signed that change (the first list a
project gets opens the opt-in as it is). Without that, anyone who can push a
note could also push a list naming their own key, or an empty one. The
person's own edit (on disk, or a commit no remote has) always counts.

**Opt-in.** No list, or an empty one: `verdicts` answers no verdict and
every note behaves as before, at the cost of one ``git log`` per reading.

**Cached per commit.** What git says of a signature does not change for a
commit, so it is kept in ``.workpilot-brain/signatures.json`` (this
machine's, git-ignored): ``G`` and ``U`` (a good signature, known key or
not) and ``N`` (none). A verdict is recomputed from those facts and the
current list, so a key removed from the list stops counting at once. What
git could not check (``E``: a GPG key missing from this keyring) is asked
again next time.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from foundation.json_ledger import update_json
from foundation.platform import find_executable

from ..notes import inside
from ..sync import _git, git_available
from . import signers as signers_list
from .signers import Signer

logger = logging.getLogger(__name__)

__all__ = [
    "CACHE",
    "Trust",
    "Verdict",
    "effective",
    "signing_enabled",
    "unverified",
    "unverified_among",
    "verdicts",
]

CACHE = ".workpilot-brain/signatures.json"
ALLOWED = ".workpilot-brain/allowed_signers"
_GOOD = frozenset({"G", "U"})
_CACHED = frozenset({"G", "U", "N"})
_MAX_CACHE = 20_000
_CHUNK = 200
_MEMO_SIZE = 32
_FORMAT = "--format=%H%x1f%G?%x1f%GF%x1f%GP"

Fact = tuple[str, str, str]
"""``(%G?, %GF, %GP)``: the status, the key's fingerprint, the primary key's."""


@dataclass(frozen=True)
class Verdict:
    status: str
    """``own``, ``verified`` or ``unverified``."""
    signer: str = ""
    """The list's name for the key that signed a verified note."""

    def to_dict(self) -> dict[str, str]:
        return {"status": self.status, "signer": self.signer}


@dataclass
class Trust:
    signers: list[Signer] = field(default_factory=list)
    """The list in effect on this machine."""
    rejected: list[str] = field(default_factory=list)
    """Changes to the list someone else pushed, signed by no listed key."""

    @property
    def active(self) -> bool:
        return bool(self.signers)


class _Everything(frozenset):
    """Every note: what a list that cannot be checked leaves to agents is nothing."""

    def __contains__(self, item: object) -> bool:
        return True


_memo: dict[tuple[str, ...], tuple[Trust, dict[str, Verdict]]] = {}
_memo_lock = threading.Lock()


def signing_enabled(root: Path) -> bool:
    """Whether this machine's git signs its commits (``commit.gpgsign``)."""
    if not git_available() or not (root / ".git").exists():
        return False
    try:
        out = _git(root, "config", "--bool", "commit.gpgsign").stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return out.strip() == "true"


# -- git facts -----------------------------------------------------------------


def _show(root: Path, rev: str, rel: str) -> str:
    done = _git(root, "show", f"{rev}:{rel}")
    return done.stdout if done.returncode == 0 else ""


def _own(root: Path) -> frozenset[str]:
    """The commits no remote has: this machine's, not synced yet."""
    out = _git(root, "rev-list", "HEAD", "--not", "--remotes").stdout
    return frozenset(out.split())


def _dirty(root: Path, pathspec: str) -> frozenset[str]:
    """Paths changed on disk and not committed (new files too)."""
    out = _git(
        root, "status", "--porcelain", "-z", "--untracked-files=all", "--", pathspec
    ).stdout
    found: set[str] = set()
    parts = out.split("\0")
    index = 0
    while index < len(parts):
        entry = parts[index]
        index += 1
        if len(entry) < 4:
            continue
        found.add(entry[3:])
        if entry[0] in "RC":
            index += 1  # the original path of a rename follows
    return frozenset(found)


def _last_commits(root: Path, pathspec: str) -> dict[str, str]:
    """Each path's last commit (merges aside: they carry their parents' work)."""
    out = _git(root, "log", "--format=%x1e%H", "--name-only", "-z", "--", pathspec)
    last: dict[str, str] = {}
    for chunk in out.stdout.split("\x1e"):
        sha, _, names = chunk.partition("\0")
        for name in names.split("\0"):
            name = name.strip("\n")
            if sha and name:
                last.setdefault(name, sha.strip())
    return last


def _read_cache(root: Path) -> dict[str, Fact]:
    try:
        data = json.loads(inside(root, CACHE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        sha: (fact[0], fact[1], fact[2])
        for sha, fact in data.items()
        if isinstance(fact, list)
        and len(fact) == 3
        and all(isinstance(part, str) for part in fact)
    }


def _save_cache(root: Path, new: dict[str, Fact]) -> None:
    def change(current: object) -> dict[str, list[str]]:
        kept = dict(current) if isinstance(current, dict) else {}
        kept.update({sha: list(fact) for sha, fact in new.items()})
        overflow = len(kept) - _MAX_CACHE
        for sha in list(kept)[: max(overflow, 0)]:
            del kept[sha]
        return kept

    try:
        update_json(inside(root, CACHE), dict, change)
    except OSError as exc:
        logger.debug("brain: signature cache not written: %s", exc)


def _allowed_file(root: Path, keys: list[Signer]) -> Path:
    """The list's SSH keys in git's ``allowed_signers`` form, for ``-c``."""
    path = inside(root, ALLOWED)
    text = "".join(f"{s.name} {s.key}\n" for s in keys if s.kind == "ssh")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(text, encoding="utf-8", newline="\n")
    os.replace(temporary, path)
    return path


def _facts(root: Path, shas: Iterable[str], keys: list[Signer]) -> dict[str, Fact]:
    """What git says of each commit's signature, from the cache when it can."""
    cache = _read_cache(root)
    wanted = list(dict.fromkeys(shas))
    found = {sha: cache[sha] for sha in wanted if sha in cache}
    missing = [sha for sha in wanted if sha not in found]
    if not missing:
        return found
    options = ["-c", f"gpg.ssh.allowedSignersFile={_allowed_file(root, keys)}"]
    # A signing-only program (a password manager's) cannot verify: the
    # stock ssh-keygen does, whatever signs this person's commits.
    keygen = find_executable("ssh-keygen")
    if keygen:
        options += ["-c", f"gpg.ssh.program={keygen}"]
    new: dict[str, Fact] = {}
    for start in range(0, len(missing), _CHUNK):
        chunk = missing[start : start + _CHUNK]
        out = _git(root, *options, "log", "--no-walk=unsorted", _FORMAT, *chunk)
        for line in out.stdout.splitlines():
            parts = line.split("\x1f")
            if len(parts) == 4:
                new[parts[0]] = (parts[1], parts[2], parts[3])
    found.update(new)
    keep = {sha: fact for sha, fact in new.items() if fact[0] in _CACHED}
    if keep:
        _save_cache(root, keep)
    return found


def _signed_by(fact: Fact | None, signers: list[Signer]) -> Signer | None:
    if fact is None or fact[0] not in _GOOD:
        return None
    status, key, primary = fact
    for signer in signers:
        if signer.kind == "ssh" and key == signer.fingerprint:
            return signer
        if signer.kind == "gpg" and signer.fingerprint in {
            key.upper(),
            primary.upper(),
        }:
            return signer
    return None


# -- the list in effect ----------------------------------------------------------


def _apply(
    accepted: list[Signer], before: list[Signer], after: list[Signer]
) -> list[Signer]:
    """The person's own change (*before* → *after*) applied to *accepted*."""
    removed = [s for s in before if s not in after]
    added = [s for s in after if s not in before]
    kept = [s for s in accepted if s not in removed]
    prints = {s.fingerprint for s in kept}
    return kept + [s for s in added if s.fingerprint not in prints]


def _disk(root: Path, rel: str) -> str:
    try:
        return inside(root, rel).read_text(encoding="utf-8")
    except (OSError, ValueError):
        return ""


def effective(root: Path, base: Path | str) -> Trust:
    """The trusted signers in effect for the memory at *base*, on this machine.

    The list's history, oldest first: a change of this machine's is taken as
    it is; one someone else pushed counts when no list was in effect yet (the
    opt-in) or when a key of the list in effect signed it, and is set aside
    otherwise. An edit on disk, not committed yet, is the person's own.
    """
    rel = signers_list.list_rel(base)
    on_disk = _disk(root, rel)
    if not git_available() or not (root / ".git").exists():
        return Trust(signers_list.parse(on_disk))
    out = _git(root, "log", "--reverse", "--format=%H%x1f%P", "--", rel).stdout
    history = [
        (sha, parents.split())
        for sha, _, parents in (line.partition("\x1f") for line in out.splitlines())
        if sha
    ]
    if not history:
        return Trust(signers_list.parse(on_disk))
    own = _own(root)
    commits = [(sha, parents) for sha, parents in history if len(parents) <= 1]
    facts = _facts(
        root, [sha for sha, _ in commits if sha not in own], signers_list.parse(on_disk)
    )
    trust = Trust()
    for sha, parents in commits:
        entries = signers_list.parse(_show(root, sha, rel))
        if sha in own:
            before = signers_list.parse(_show(root, parents[0], rel)) if parents else []
            trust.signers = _apply(trust.signers, before, entries)
        elif not trust.signers or _signed_by(facts.get(sha), trust.signers):
            trust.signers = entries
        else:
            trust.rejected.append(sha)
    if rel in _dirty(root, rel):
        head = signers_list.parse(_show(root, "HEAD", rel))
        trust.signers = _apply(trust.signers, head, signers_list.parse(on_disk))
    return trust


# -- the notes -----------------------------------------------------------------


def _judge(
    root: Path,
    base: Path | str,
    trust: Trust,
    dirty: frozenset[str],
    own: frozenset[str],
) -> dict[str, Verdict]:
    project = Path(base).parent.as_posix()
    tracked = _git(root, "ls-files", "-z", "--", project).stdout.split("\0")
    notes = {rel for rel in [*tracked, *dirty] if rel.endswith(".md")}
    last = _last_commits(root, project)
    received = {last[rel] for rel in notes if rel in last and last[rel] not in own}
    facts = _facts(root, received, trust.signers)
    out: dict[str, Verdict] = {}
    for rel in notes:
        sha = last.get(rel)
        if ".conflict-" in PurePosixPath(rel).name:
            # The other side's text, kept beside ours by a merge.
            out[rel] = Verdict("unverified")
        elif rel in dirty or (sha is not None and sha in own):
            out[rel] = Verdict("own")
        elif (signer := _signed_by(facts.get(sha or ""), trust.signers)) is not None:
            out[rel] = Verdict("verified", signer.name)
        else:
            out[rel] = Verdict("unverified")
    return out


def verdicts(root: Path, base: Path | str) -> tuple[Trust, dict[str, Verdict]]:
    """The list in effect and, when it names a key, a verdict per note of the
    project (vault paths). No list: no verdict, every note is trusted."""
    if not git_available() or not (root / ".git").exists():
        return effective(root, base), {}
    project = Path(base).parent.as_posix()
    head = _git(root, "rev-parse", "--verify", "-q", "HEAD").stdout.strip()
    dirty = _dirty(root, project)
    own = _own(root)
    key = (str(root), Path(base).as_posix(), head, *sorted(dirty), "|", *sorted(own))
    with _memo_lock:
        if key in _memo:
            return _memo[key]
    trust = effective(root, base)
    judged = _judge(root, base, trust, dirty, own) if trust.active else {}
    with _memo_lock:
        if len(_memo) >= _MEMO_SIZE:
            _memo.clear()
        _memo[key] = (trust, judged)
    return trust, judged


def _has_remote_refs(root: Path) -> bool:
    """Whether the repository ever fetched, read without running git."""
    git = root / ".git"
    if not git.is_dir():
        return git.exists()  # a ``gitdir:`` file: git knows, ask it
    refs = git / "refs" / "remotes"
    if refs.is_dir() and any(path.is_file() for path in refs.rglob("*")):
        return True
    try:
        return "refs/remotes/" in (git / "packed-refs").read_text(encoding="utf-8")
    except OSError:
        return False


def unverified(root: Path, base: Path | str) -> frozenset[str]:
    """The notes of the memory at *base*'s project that agents are not given.

    When the list cannot be checked (git timed out, a disk refused), every
    note is: a list that is there but unreadable must not let a pushed note
    through.
    """
    if not _has_remote_refs(root):
        # Never fetched: every commit is this machine's, nothing was received.
        return frozenset()
    try:
        _, judged = verdicts(root, base)
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        if not _disk(root, signers_list.list_rel(base)).strip():
            return frozenset()
        logger.warning("brain: note signatures not checked: %s", exc)
        return _Everything()
    return frozenset(rel for rel, v in judged.items() if v.status == "unverified")


def _memory_base(rel: str) -> str | None:
    parts = PurePosixPath(rel).parts
    if len(parts) >= 3 and parts[0] == "knowledge" and parts[1] == "projects":
        return f"knowledge/projects/{parts[2]}/memory"
    return None


def unverified_among(root: Path, rels: Iterable[str]) -> set[str]:
    """Which of *rels* (vault paths, any project) agents are not given.

    A note outside a project's folder is not covered by any list.
    """
    paths = [str(rel) for rel in rels]
    by_base: dict[str, frozenset[str]] = {}
    out: set[str] = set()
    for rel in paths:
        base = _memory_base(rel)
        if base is None:
            continue
        if base not in by_base:
            by_base[base] = unverified(root, base)
        if rel in by_base[base]:
            out.add(rel)
    return out
