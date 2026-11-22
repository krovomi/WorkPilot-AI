"""What the plan reads from the server's clone with git, and the code of a
card's files.

Every git call takes an argument list (no shell), a timeout and an output
cap; an answer over the cap, a timeout or an error is no answer. The diff
runs with ``--no-ext-diff --no-textconv``, so no program a repository's
attributes name ever runs. Object ids passed to ``merge-tree`` are checked
against ``^[0-9a-f]{40}$|^[0-9a-f]{64}$``.

A card's build workspace is ``<clone>/.workpilot/worktrees/tasks/<card>``,
resolved and kept inside the clone. Its files are read only when, resolved,
they stay inside the root they are read from, are regular text files of at
most ``MAX_CODE_FILE_BYTES``, and are the very file checked (device and
inode). Dependency manifests and shared configuration (``.env`` among them)
are never read, and a removed symbol the secret redaction would mask is
dropped: a value never becomes a link served to a client.
"""

from __future__ import annotations

import os
import re
import stat
import subprocess
from collections.abc import Callable
from pathlib import Path

from .code_links import SpecCode, build_spec_code
from .planner import MAX_LISTED_FILES, MergeOutcome
from .scorer import CoChangeIndex, Footprint, file_weight, normalize_path

MAX_WORKTREE_FILES = 2_000
GIT_TIMEOUT_S = 15
GIT_CAP = 8 * 1024 * 1024
HEAD_TIMEOUT_S = 5

FRAGILE_COMMITS = 300
MIN_CO_CHANGES = 3
MAX_FILES_PER_COMMIT = 20
LOG_TIMEOUT_S = 10

MAX_CODE_FILE_BYTES = 256 * 1024
MAX_SPEC_CODE_FILES = 300
MAX_PLAN_CODE_FILES = 3_000
BINARY_PROBE_BYTES = 8_000

OBJECT_ID = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
#: A branch name a card or the project may give; anything else is not used.
BRANCH = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$")
_BUILD_OUTPUT_DIRS = frozenset({"bin", "obj"})


def git(cwd: Path, args: list[str], *, timeout: float = GIT_TIMEOUT_S) -> str | None:
    """Git's output, or None (error, timeout, output over the cap)."""
    result = git_run(cwd, args, timeout=timeout)
    if result is None or result[0] != 0:
        return None
    return result[1]


def git_run(cwd: Path, args: list[str], *, timeout: float) -> tuple[int, str] | None:
    """(exit code, output) of git, or None when it could not answer."""
    from foundation.git_executable import get_git_executable, get_isolated_git_env

    try:
        completed = subprocess.run(
            [get_git_executable(), *args],
            cwd=cwd,
            capture_output=True,
            timeout=timeout,
            env=get_isolated_git_env(),
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if len(completed.stdout) > GIT_CAP:
        return None
    return completed.returncode, completed.stdout.decode("utf-8", errors="replace")


def _inside(root: Path, *parts: str) -> Path | None:
    base = os.path.realpath(root)
    candidate = os.path.realpath(os.path.join(base, *parts))
    if not candidate.startswith(base + os.sep):
        return None
    return Path(candidate)


def workspace_of(clone: Path, card: str) -> Path | None:
    """The card's build workspace, resolved inside the clone, or None."""
    path = _inside(clone, ".workpilot", "worktrees", "tasks", card)
    return path if path is not None and path.is_dir() else None


def is_card_file(file: str) -> bool:
    """A file of the card's own: not WorkPilot's, not build output."""
    normalized = file.replace("\\", "/")
    if (
        normalized == ".workpilot"
        or normalized.startswith(".workpilot/")
        or normalized.startswith(".workpilot-")
    ):
        return False
    return not any(s.lower() in _BUILD_OUTPUT_DIRS for s in normalized.split("/")[:-1])


def _merge_base(workspace: Path, base: str) -> str | None:
    if not BRANCH.match(base) or ".." in base:
        return None
    for ref in (base, f"origin/{base}"):
        found = git(workspace, ["merge-base", ref, "HEAD"])
        if found is not None and OBJECT_ID.match(found.strip()):
            return found.strip()
    return None


def changed_files(clone: Path, card: str, base: str) -> list[str] | None:
    """Files the card's workspace changed since its merge-base (commits, index,
    working tree, untracked), or None when it has none or git cannot say."""
    workspace = workspace_of(clone, card)
    if workspace is None:
        return None
    merge_base = _merge_base(workspace, base)
    if merge_base is None:
        return None
    outputs = [
        git(workspace, ["diff", "--name-only", "-z", "--no-renames", merge_base]),
        git(workspace, ["ls-files", "-z", "--others", "--exclude-standard"]),
    ]
    files: list[str] = []
    for output in outputs:
        for file in (output or "").split("\0"):
            file = file.strip()
            if file and is_card_file(file) and file not in files:
                files.append(file)
    return files[:MAX_WORKTREE_FILES]


def keep_diff_sections(diff: str, keep: Callable[[str], bool]) -> str:
    """The sections of a unified diff whose file passes ``keep``."""
    kept: list[str] = []
    keeping = False
    for line in diff.split("\n"):
        if line.startswith("diff --git "):
            keeping = keep(line[line.rfind(" b/") + 3 :])
        if keeping:
            kept.append(line)
    return "\n".join(kept)


def workspace_diff(clone: Path, card: str, base: str) -> str | None:
    workspace = workspace_of(clone, card)
    merge_base = _merge_base(workspace, base) if workspace is not None else None
    if workspace is None or merge_base is None:
        return None
    diff = git(
        workspace,
        [
            "diff",
            "--unified=0",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            merge_base,
        ],
    )
    return None if diff is None else keep_diff_sections(diff, is_card_file)


def workspace_head(clone: Path, card: str) -> str | None:
    workspace = workspace_of(clone, card)
    if workspace is None:
        return None
    head = git(
        workspace,
        ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        timeout=HEAD_TIMEOUT_S,
    )
    head = (head or "").strip()
    return head if OBJECT_ID.match(head) else None


def trial_merge(clone: Path, a: str, b: str, timeout: float) -> MergeOutcome | None:
    """``git merge-tree`` of two commits in the object store only; None when
    git cannot say (no common history, a git without ``--write-tree``)."""
    if not OBJECT_ID.match(a) or not OBJECT_ID.match(b):
        return None
    result = git_run(
        clone,
        ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", a, b],
        timeout=timeout,
    )
    if result is None:
        return None
    code, output = result
    if code == 0:
        return MergeOutcome("clean")
    tree, *files = output.split("\0")
    if code != 1 or not OBJECT_ID.match(tree):
        return None
    unique = list(dict.fromkeys(f for f in files if f))
    return MergeOutcome("conflict", tuple(unique[:MAX_LISTED_FILES]))


def parse_log(output: str) -> list[list[str]]:
    """``\\x1e`` opens each commit, ``\\0`` ends each path."""
    return [
        [f.lstrip("\n") for f in chunk.split("\0") if f.lstrip("\n")]
        for chunk in output.split("\x1e")[1:]
    ]


def co_change_index(commits: list[list[str]]) -> dict[str, frozenset[str]]:
    counts: dict[tuple[str, str], int] = {}
    for files in commits:
        unique = sorted({normalize_path(f) for f in files} - {""})
        if len(unique) < 2 or len(unique) > MAX_FILES_PER_COMMIT:
            continue
        for i, x in enumerate(unique):
            for y in unique[i + 1 :]:
                counts[(x, y)] = counts.get((x, y), 0) + 1
    index: dict[str, set[str]] = {}
    for (x, y), count in counts.items():
        if count >= MIN_CO_CHANGES:
            index.setdefault(x, set()).add(y)
            index.setdefault(y, set()).add(x)
    return {key: frozenset(value) for key, value in index.items()}


def read_co_changes(clone: Path) -> tuple[CoChangeIndex, int] | None:
    output = git(
        clone,
        [
            "log",
            f"--max-count={FRAGILE_COMMITS}",
            "--no-merges",
            "--no-renames",
            "--name-only",
            "-z",
            "--format=%x1e",
            "HEAD",
            "--",
        ],
        timeout=LOG_TIMEOUT_S,
    )
    if output is None:
        return None
    commits = parse_log(output)
    return co_change_index(commits), len(commits)


def read_text_inside(root: Path, relative: str) -> str | None:
    """The text of ``relative`` under ``root`` (resolved), or None."""
    try:
        real = os.path.realpath(os.path.join(root, relative))
        if not real.startswith(str(root) + os.sep):
            return None
        checked = os.stat(real)
        if not stat.S_ISREG(checked.st_mode) or checked.st_size > MAX_CODE_FILE_BYTES:
            return None
        fd = os.open(real, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            opened = os.fstat(fd)
            if (opened.st_ino, opened.st_dev) != (checked.st_ino, checked.st_dev):
                return None
            content = os.read(fd, MAX_CODE_FILE_BYTES + 1)
        finally:
            os.close(fd)
    except OSError:
        return None
    if len(content) > MAX_CODE_FILE_BYTES or b"\0" in content[:BINARY_PROBE_BYTES]:
        return None
    return content.decode("utf-8", errors="replace")


class CodeBudget:
    """Files read so far for one plan, and whether a limit cut a read."""

    def __init__(self) -> None:
        self.read = 0
        self.capped = False


def _is_code_file(normalized: str) -> bool:
    return file_weight(normalized) == 1


def read_spec_code(
    clone: Path, card: str, base: str, footprint: Footprint, budget: CodeBudget
) -> SpecCode:
    """A card's files (from its workspace, else the clone) and its diff, indexed."""
    from foundation.log_redaction import redact_text

    workspace = workspace_of(clone, card)
    root = Path(os.path.realpath(workspace or clone))
    wanted = [(n, d) for n, d in footprint.items() if _is_code_file(n)]
    allowed = max(
        0, min(len(wanted), MAX_SPEC_CODE_FILES, MAX_PLAN_CODE_FILES - budget.read)
    )
    if allowed < len(wanted):
        budget.capped = True
    budget.read += allowed
    files = []
    for normalized, display in wanted[:allowed]:
        text = read_text_inside(root, display)
        if text is not None:
            files.append((normalized, text))
    diff = workspace_diff(clone, card, base) if workspace is not None else None
    if diff is not None:
        diff = keep_diff_sections(diff, lambda f: _is_code_file(normalize_path(f)))
    code = build_spec_code(files, diff)
    code.removed = [s for s in code.removed if redact_text(s) == s]
    return code
