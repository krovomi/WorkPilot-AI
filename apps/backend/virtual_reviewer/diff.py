"""What a task changed, from ``git diff HEAD`` in its worktree.

Files, insertion and deletion counts, and a bounded excerpt of the diff, for
the virtual reviewer's prompt. It lived in ``agents/self_review.py``, the
opt-in coder self-review that wrote a stub from this summary and no model ever
read; that writer was removed by audit lot L10, and this helper is what was
left of it worth keeping. Never raises.
"""

from __future__ import annotations

import logging
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from rtk import capture_for_model

logger = logging.getLogger(__name__)

# How many characters of git diff go into a prompt. Beyond this the excerpt is
# truncated: a 100k diff would blow the context budget.
_MAX_DIFF_CHARS = 32_000


@dataclass
class DiffSummary:
    """Compact representation of what a task changed."""

    files_changed: list[str] = field(default_factory=list)
    insertions: int = 0
    deletions: int = 0
    diff_excerpt: str = ""
    truncated: bool = False
    error: str | None = None  # populated when git was unavailable / failed

    def to_dict(self) -> dict[str, Any]:
        return {
            "files_changed": list(self.files_changed),
            "insertions": self.insertions,
            "deletions": self.deletions,
            "diff_excerpt": self.diff_excerpt,
            "truncated": self.truncated,
            "error": self.error,
        }


def _git(
    args: list[str], cwd: Path, *, for_model: bool = False
) -> tuple[int, str, str]:
    """Run a git command, return (returncode, stdout, stderr). Never raises.

    `for_model` says the output is going into a prompt and nowhere else, which
    is what lets it go through rtk and come back condensed. It is off by
    default because most calls here are parsed rather than read: `--name-only`
    feeds a file list and `--numstat` feeds a counter, and condensing either
    saves nothing — none of it is ever sent to a model — while breaking the
    caller.

    The flag lives on this wrapper rather than at the call site so the module
    keeps one place where git is executed. A second execution path would be
    invisible to anything that stands in for this function.
    """
    if for_model:
        capture = capture_for_model(["git", *args], cwd=cwd, timeout=15)
        return capture.returncode, capture.text, ""
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, "", str(exc)


def compute_diff_summary(spec_dir: Path, project_dir: Path) -> DiffSummary:
    """Build a DiffSummary from ``git diff HEAD`` in ``project_dir``.

    Spec_dir is currently only used to pick a label (the spec id) — the
    actual diff lives in the worktree where the coder ran. Caller passes
    the worktree path as ``project_dir``.
    """
    project_dir = Path(project_dir)
    if not project_dir.is_dir():
        return DiffSummary(error=f"project_dir is not a directory: {project_dir}")

    # First check we're inside a git repo.
    rc, _, err = _git(["rev-parse", "--is-inside-work-tree"], project_dir)
    if rc != 0:
        return DiffSummary(error=f"not a git repo: {err.strip() or 'unknown error'}")

    # Files changed (staged + unstaged).
    rc, files_out, files_err = _git(["diff", "HEAD", "--name-only"], project_dir)
    files = (
        [line.strip() for line in files_out.splitlines() if line.strip()]
        if rc == 0
        else []
    )

    # Numstat — fast win for insertions/deletions.
    rc, numstat_out, _ = _git(["diff", "HEAD", "--numstat"], project_dir)
    insertions = 0
    deletions = 0
    if rc == 0:
        for line in numstat_out.splitlines():
            parts = line.split("\t", 2)
            if len(parts) < 2:
                continue
            try:
                insertions += int(parts[0])
                deletions += int(parts[1])
            except ValueError:
                # "-" for binary files; skip.
                continue

    # Excerpt of the actual diff — the one capture in this function a model
    # reads, so the one that asks for rtk. The two above deliberately do not.
    rc, diff_out, _ = _git(["diff", "HEAD"], project_dir, for_model=True)
    if rc != 0:
        diff_out = ""

    truncated = False
    if len(diff_out) > _MAX_DIFF_CHARS:
        diff_out = diff_out[:_MAX_DIFF_CHARS] + "\n…[truncated by diff excerpt cap]…\n"
        truncated = True

    return DiffSummary(
        files_changed=files,
        insertions=insertions,
        deletions=deletions,
        diff_excerpt=diff_out,
        truncated=truncated,
        error=None if rc == 0 else (files_err.strip() or None),
    )
