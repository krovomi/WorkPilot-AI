"""The commits of a range, read once with every field the surgeon needs.

``read_range(repo, base, head)`` returns the commits of ``base..head``, oldest
first: author, date, message, files with their line counts, merge parents and
whether the commit is signed. Every call goes through ``foundation.git_executable``
with an argument list (no shell, S4); a revision the person typed is checked
by ``git rev-parse --verify`` before it reaches any other command.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from foundation.git_executable import run_git

MAX_COMMITS = 300
_REVISION = re.compile(r"^[\w][\w./@^~{}-]{0,199}$")
_DEFAULT_CANDIDATES = ("main", "master", "develop", "trunk")


class SurgeonError(ValueError):
    """A range, a plan or a repository the surgeon will not work on."""


@dataclass
class FileChange:
    path: str
    added: int = 0
    deleted: int = 0
    binary: bool = False


@dataclass
class Commit:
    sha: str
    parents: list[str]
    author_name: str
    author_email: str
    author_date: str
    message: str
    files: list[FileChange] = field(default_factory=list)
    signed: bool = False

    @property
    def subject(self) -> str:
        return self.message.split("\n", 1)[0].strip()

    @property
    def body(self) -> str:
        parts = self.message.split("\n", 1)
        return parts[1].strip() if len(parts) > 1 else ""

    @property
    def is_merge(self) -> bool:
        return len(self.parents) > 1

    @property
    def lines(self) -> int:
        return sum(f.added + f.deleted for f in self.files)

    def to_dict(self) -> dict[str, object]:
        return {
            "sha": self.sha,
            "subject": self.subject,
            "body": self.body,
            "message": self.message,
            "author": self.author_name,
            "date": self.author_date,
            "files": [f.path for f in self.files][:200],
            "fileCount": len(self.files),
            "lines": self.lines,
            "signed": self.signed,
            "merge": self.is_merge,
        }


def git(repo: Path, *args: str, timeout: int = 60) -> str:
    result = run_git(list(args), cwd=repo, timeout=timeout)
    if result.returncode != 0:
        raise SurgeonError(
            (result.stderr or result.stdout or "git failed").strip()[:400]
        )
    return result.stdout


def verify(repo: Path, revision: str) -> str:
    """The full sha of ``revision``, or SurgeonError when it is not one."""
    if not _REVISION.match(revision or "") or ".." in revision:
        raise SurgeonError(f"not a revision: {revision[:80]!r}")
    result = run_git(
        ["rev-parse", "--verify", "--quiet", f"{revision}^{{commit}}"], cwd=repo
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise SurgeonError(f"no commit named {revision[:80]!r} in this repository")
    return result.stdout.strip()


def current_branch(repo: Path) -> str:
    result = run_git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd=repo)
    return result.stdout.strip() if result.returncode == 0 else ""


def default_branch(repo: Path) -> str:
    """The branch a feature branch starts from: origin's HEAD, else a usual name."""
    result = run_git(
        ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cwd=repo
    )
    if result.returncode == 0 and result.stdout.strip():
        return result.stdout.strip()
    for name in _DEFAULT_CANDIDATES:
        if (
            run_git(["rev-parse", "--verify", "--quiet", name], cwd=repo).returncode
            == 0
        ):
            return name
    return ""


def default_base(repo: Path, head: str = "HEAD") -> str:
    """Where the current branch left its default branch (their merge base)."""
    target = default_branch(repo)
    if not target:
        raise SurgeonError("no default branch found: choose the commit to start from")
    base = git(repo, "merge-base", target, head).strip()
    if base == verify(repo, head):
        raise SurgeonError(
            f"the branch has no commit of its own over {target}: choose the commit to start from"
        )
    return base


def _signed(repo: Path, base: str, head: str) -> set[str]:
    out = git(repo, "log", "--pretty=raw", f"{base}..{head}", timeout=120)
    signed: set[str] = set()
    sha = ""
    for line in out.splitlines():
        if line.startswith("commit "):
            sha = line.split()[1]
        elif line.startswith("gpgsig") and sha:
            signed.add(sha)
    return signed


def read_range(
    repo: Path, base: str, head: str = "HEAD", limit: int = MAX_COMMITS
) -> list[Commit]:
    """The commits of ``base..head``, oldest first; SurgeonError past ``limit``."""
    base_sha, head_sha = verify(repo, base), verify(repo, head)
    count = int(
        git(repo, "rev-list", "--count", f"{base_sha}..{head_sha}").strip() or 0
    )
    if count == 0:
        raise SurgeonError("no commit between the start and the branch")
    if count > limit:
        raise SurgeonError(
            f"{count} commits in the range, {limit} at most: choose a later start"
        )
    out = git(
        repo,
        "log",
        "--reverse",
        "--no-renames",
        "--numstat",
        "--format=%x1e%H%x00%P%x00%an%x00%ae%x00%aI%x00%B%x00",
        f"{base_sha}..{head_sha}",
        timeout=120,
    )
    signed = _signed(repo, base_sha, head_sha)
    commits: list[Commit] = []
    for record in out.split("\x1e")[1:]:
        parts = record.split("\x00")
        if len(parts) < 7:
            continue
        sha, parents, name, email, date, message, stats = parts[:7]
        files: list[FileChange] = []
        for line in stats.strip().splitlines():
            cells = line.split("\t", 2)
            if len(cells) != 3:
                continue
            binary = cells[0] == "-"
            files.append(
                FileChange(
                    path=cells[2],
                    added=0 if binary else int(cells[0] or 0),
                    deleted=0 if binary else int(cells[1] or 0),
                    binary=binary,
                )
            )
        commits.append(
            Commit(
                sha=sha,
                parents=parents.split(),
                author_name=name,
                author_email=email,
                author_date=date,
                message=message.strip(),
                files=files,
                signed=sha in signed,
            )
        )
    return commits


def recent_subjects(repo: Path, count: int = 100) -> list[str]:
    result = run_git(["log", f"-{count}", "--no-merges", "--format=%s"], cwd=repo)
    return (
        [s for s in result.stdout.splitlines() if s.strip()]
        if result.returncode == 0
        else []
    )
