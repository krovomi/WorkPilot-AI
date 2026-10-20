"""The two git facts a verification needs: what changed, and at which commit.

Only for callers with nothing better — the build hands the loop the worktree
manager's list of changed files, which is the authority. The CLI, the API and
the MCP server attached to a bare checkout ask here: the diff against the
branch this one forked from, plus what is staged, unstaged or untracked.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

__all__ = ["changed_files", "head_sha", "fingerprint"]

_BASES = (
    "@{upstream}",
    "origin/develop",
    "develop",
    "origin/main",
    "main",
    "origin/master",
    "master",
)


def _git(project_dir: Path, *args: str) -> tuple[int, str]:
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv
            ["git", *args],
            cwd=str(project_dir),
            capture_output=True,
            text=True,
            errors="replace",
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return 1, ""
    return completed.returncode, completed.stdout


def head_sha(project_dir: Path | str) -> str:
    code, out = _git(Path(project_dir), "rev-parse", "HEAD")
    return out.strip() if code == 0 else ""


def fingerprint(project_dir: Path | str) -> str:
    """A hash of the working tree's code: HEAD, the uncommitted diff, the
    untracked files. Equal fingerprints mean nothing a replay could catch
    changed — whether QA committed its fixes or left them in the tree."""
    import hashlib

    root = Path(project_dir)
    digest = hashlib.sha256(head_sha(root).encode())
    _code, diff = _git(
        root, "diff", "HEAD", "--no-color", "--", ".", ":(exclude).workpilot"
    )
    digest.update(diff.encode("utf-8", errors="replace"))
    _code, untracked = _git(
        root,
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ".",
        ":(exclude).workpilot",
    )
    digest.update(untracked.encode("utf-8", errors="replace"))
    return digest.hexdigest()


def changed_files(project_dir: Path | str) -> list[str]:
    root = Path(project_dir)
    files: list[str] = []
    for base in _BASES:
        code, merge_base = _git(root, "merge-base", "HEAD", base)
        if code == 0 and merge_base.strip():
            code, out = _git(root, "diff", "--name-only", merge_base.strip(), "HEAD")
            if code == 0:
                files += [line.strip() for line in out.splitlines() if line.strip()]
            break
    code, out = _git(root, "status", "--porcelain", "-z")
    if code == 0:
        for entry in out.split("\0"):
            if len(entry) > 3:
                files.append(entry[3:].strip())
    seen: set[str] = set()
    return [f for f in files if not (f in seen or seen.add(f))]
