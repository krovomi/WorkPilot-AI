"""Build and test outputs that must never reach a task's branch.

A task runs in a worktree where the agent builds and tests the project, then
commits with ``git add .``. When the target project has no ``.gitignore`` for
its build outputs, everything the build left behind goes into the branch:
for a .NET project ``bin/``, ``obj/`` and ``TestResults/`` (hundreds of DLLs
and a coverage report for a one-line change), for a Node project
``node_modules/``, for Python ``__pycache__/``. The diff shown for review and
the PR then drown the real change.

Two layers, both provider-agnostic since they act on git, not on the agent:

* :func:`ensure_artifact_excludes` writes a managed block of patterns into the
  repository's ``info/exclude``. Git reads that file on every ``git add``, so
  whatever agent runs the commit, the outputs stay untracked. The file is
  local to the clone (never committed) and shared by the worktrees and the
  main checkout. ``bin/`` and ``obj/`` are excluded in every project, at any
  depth; any other pattern is left out when the project already versions a
  file it would match: a project that commits its ``dist/`` keeps doing so.
* :func:`strip_committed_artifacts` is the safety net for what was committed
  before the excludes existed (or with ``git add -f``): files the branch
  *added* that the project's ``.gitignore`` or the excludes ignore are taken
  out of the index, in a commit of their own. Files already on the base
  branch are never touched.
"""

from __future__ import annotations

import logging
import tempfile
from collections.abc import Callable, Iterable
from fnmatch import fnmatch
from pathlib import Path, PurePosixPath
from subprocess import CompletedProcess

from foundation.git_executable import get_isolated_git_env, run_git

logger = logging.getLogger(__name__)

BLOCK_BEGIN = "# >>> workpilot: build and test outputs (managed block) >>>"
BLOCK_END = "# <<< workpilot: build and test outputs <<<"

# Excluded in every project, at any depth, even when the base branch already
# versions files under them: MSBuild writes bin/ and obj/ next to each
# project, and they must never show up in a task's changes (Leub, 31 Oct).
ALWAYS_EXCLUDED: tuple[str, ...] = ("[Bb]in/", "[Oo]bj/")

# Output directories and files that are never source, whatever the stack.
COMMON_PATTERNS: tuple[str, ...] = (
    *ALWAYS_EXCLUDED,
    "node_modules/",
    "__pycache__/",
    "*.py[cod]",
    ".pytest_cache/",
    ".mypy_cache/",
    ".ruff_cache/",
    ".tox/",
    ".nox/",
    ".venv/",
    "*.egg-info/",
    "htmlcov/",
    ".coverage",
    ".coverage.*",
    ".nyc_output/",
    "TestResults/",
    ".gradle/",
    ".next/",
    ".nuxt/",
    ".turbo/",
    ".parcel-cache/",
)

# Output directories whose name is a source directory elsewhere (``build/``
# and ``dist/`` are sometimes committed), so they are excluded only when a
# file of the stack that produces them is present. Marker globs match a file
# name.
STACK_PATTERNS: tuple[tuple[tuple[str, ...], tuple[str, ...]], ...] = (
    # .NET: MSBuild writes bin/<Configuration>/ and obj/ next to each project.
    (
        ("*.csproj", "*.fsproj", "*.vbproj", "*.sln", "*.slnx"),
        (
            ".vs/",
            "*.user",
            "*.suo",
        ),
    ),
    (("package.json",), ("dist/", "coverage/")),
    (("pyproject.toml", "setup.py", "setup.cfg"), ("build/", "dist/")),
    (("Cargo.toml", "pom.xml"), ("target/",)),
    (
        ("build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"),
        ("build/",),
    ),
)

GitRunner = Callable[..., CompletedProcess]


def _lines(output: str, *, nul: bool = False) -> list[str]:
    parts = output.split("\0") if nul else output.splitlines()
    return [p.strip() for p in parts if p.strip()]


def _exclude_file(worktree: Path, git: GitRunner) -> Path | None:
    """The ``info/exclude`` git reads for this worktree (the common dir's)."""
    result = git(["rev-parse", "--git-common-dir"], cwd=worktree)
    if result.returncode != 0 or not result.stdout.strip():
        return None
    common = Path(result.stdout.strip())
    if not common.is_absolute():
        common = worktree / common
    return common / "info" / "exclude"


def detect_patterns(files: Iterable[str]) -> list[str]:
    """Patterns that apply to a project, from the paths of its files."""
    names = {PurePosixPath(f).name for f in files}
    patterns = list(COMMON_PATTERNS)
    for markers, stack_patterns in STACK_PATTERNS:
        if any(fnmatch(name, marker) for name in names for marker in markers):
            patterns.extend(p for p in stack_patterns if p not in patterns)
    return patterns


def _versioned_patterns(
    worktree: Path, base_ref: str, patterns: list[str], git: GitRunner
) -> set[str]:
    """The patterns that match a file ``base_ref`` tracks.

    Read from the base branch, not from the worktree's index: the branch may
    already hold the outputs this module is about, and they must not count as
    "the project versions them". A throwaway index keeps the worktree's own
    index untouched.
    """
    with tempfile.TemporaryDirectory(prefix="workpilot-index-") as tmp:
        env = get_isolated_git_env()
        env["GIT_INDEX_FILE"] = str(Path(tmp) / "index")
        read = git(["read-tree", base_ref], cwd=worktree, env=env)
        if read.returncode != 0:
            # Unknown base (empty repository): nothing is versioned yet.
            return set()
        versioned = set()
        for pattern in patterns:
            result = git(["ls-files", "-c", "-i", "-x", pattern], cwd=worktree, env=env)
            if result.returncode == 0 and result.stdout.strip():
                versioned.add(pattern)
        return versioned


def render_block(patterns: Iterable[str]) -> str:
    body = "\n".join(patterns)
    return f"{BLOCK_BEGIN}\n{body}\n{BLOCK_END}\n"


def replace_block(content: str, block: str) -> str:
    """``content`` with its managed block replaced by ``block`` (or appended)."""
    start = content.find(BLOCK_BEGIN)
    end = content.find(BLOCK_END, start + 1) if start != -1 else -1
    if start != -1 and end != -1:
        tail = content[end + len(BLOCK_END) :].lstrip("\n")
        return content[:start] + block + tail
    if content and not content.endswith("\n"):
        content += "\n"
    return content + block


def ensure_artifact_excludes(
    worktree: Path, base_ref: str = "HEAD", git: GitRunner = run_git
) -> list[str]:
    """Write the managed exclude block for the project in ``worktree``.

    ``base_ref`` is the branch the task started from: a pattern matching a
    file it tracks is left out.

    Idempotent: the block is rewritten in place, the rest of the file is kept.

    Returns:
        The patterns written (empty when git could not be read).
    """
    exclude = _exclude_file(worktree, git)
    if exclude is None:
        return []

    # Tracked and untracked-not-ignored files: a project the agent is creating
    # in this task (a new .csproj) counts as much as one already committed.
    listing = git(
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=worktree,
    )
    files = _lines(listing.stdout, nul=True) if listing.returncode == 0 else []
    patterns = detect_patterns(files)
    versioned = _versioned_patterns(worktree, base_ref, patterns, git)
    patterns = [p for p in patterns if p in ALWAYS_EXCLUDED or p not in versioned]

    try:
        current = exclude.read_text(encoding="utf-8") if exclude.exists() else ""
        updated = replace_block(current, render_block(patterns))
        if updated != current:
            exclude.parent.mkdir(parents=True, exist_ok=True)
            exclude.write_text(updated, encoding="utf-8")
    except OSError as exc:
        logger.warning("[build_artifacts] Could not write %s: %s", exclude, exc)
        return []
    _freeze_tracked_outputs(worktree, base_ref, git)
    return patterns


def _tracked_outputs(worktree: Path, git: GitRunner) -> set[str]:
    """Tracked files under a ``bin/`` or ``obj/`` folder, at any depth."""
    args = ["ls-files", "-z", "-c", "-i"]
    for pattern in ALWAYS_EXCLUDED:
        args += ["-x", pattern]
    result = git(args, cwd=worktree)
    return set(_lines(result.stdout, nul=True)) if result.returncode == 0 else set()


def _freeze_tracked_outputs(worktree: Path, base_ref: str, git: GitRunner) -> None:
    """Make ``git add`` blind to what a build rewrites in tracked bin/ and obj/.

    Excludes only apply to untracked files: when the project (or an earlier
    task merged before this fix) versions ``obj/project.nuget.cache``, every
    restore rewrites it and ``git add .`` stages the change. ``skip-worktree``
    lives in this worktree's own index, so the main checkout is untouched.
    Only files of the base branch are frozen: what the branch added is
    untracked by :func:`strip_committed_artifacts` instead.
    """
    added = _branch_changes(worktree, base_ref, "A", git) or set()
    tracked = _tracked_outputs(worktree, git) - added
    if tracked:
        git(
            ["update-index", "-z", "--skip-worktree", "--stdin"],
            cwd=worktree,
            input_data="\0".join(sorted(tracked)),
        )


def _branch_changes(
    worktree: Path, base_ref: str, diff_filter: str, git: GitRunner
) -> set[str] | None:
    result = git(
        [
            "diff",
            "-z",
            "--name-only",
            f"--diff-filter={diff_filter}",
            f"{base_ref}...HEAD",
        ],
        cwd=worktree,
    )
    if result.returncode != 0:
        logger.warning(
            "[build_artifacts] Cannot diff against %s: %s", base_ref, result.stderr
        )
        return None
    return set(_lines(result.stdout, nul=True))


def strip_committed_artifacts(
    worktree: Path, base_ref: str, git: GitRunner = run_git
) -> list[str]:
    """Take the build and test outputs out of the branch's changes.

    * Ignored files the branch added (``.gitignore`` or the managed excludes)
      are untracked.
    * Files under ``bin/`` or ``obj/`` that the base branch versions and the
      branch changed go back to their base version in the index.

    The files on disk are kept (the build still needs them); the result is
    committed so the review diff, the PR and the merge no longer carry them.

    Returns:
        The paths taken out of the branch's changes.
    """
    if not worktree.exists():
        return []
    ensure_artifact_excludes(worktree, base_ref, git)

    ignored = git(["ls-files", "-z", "-c", "-i", "--exclude-standard"], cwd=worktree)
    if ignored.returncode != 0:
        return []
    added = _branch_changes(worktree, base_ref, "A", git)
    modified = _branch_changes(worktree, base_ref, "MT", git)
    if added is None or modified is None:
        return []
    to_untrack = sorted(set(_lines(ignored.stdout, nul=True)) & added)
    to_restore = sorted(_tracked_outputs(worktree, git) & modified)
    if not to_untrack and not to_restore:
        return []

    if to_untrack:
        rm = git(
            [
                "rm",
                "-r",
                "--cached",
                "--quiet",
                "--ignore-unmatch",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            cwd=worktree,
            input_data="\0".join(to_untrack),
        )
        if rm.returncode != 0:
            logger.warning("[build_artifacts] git rm --cached failed: %s", rm.stderr)
            return []
    if to_restore:
        merge_base = git(["merge-base", base_ref, "HEAD"], cwd=worktree)
        restore = git(
            [
                "restore",
                f"--source={merge_base.stdout.strip()}",
                "--staged",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            cwd=worktree,
            input_data="\0".join(to_restore),
        )
        if merge_base.returncode != 0 or restore.returncode != 0:
            logger.warning("[build_artifacts] git restore failed: %s", restore.stderr)
            to_restore = []

    stripped = to_untrack + to_restore
    if not stripped:
        return []
    commit = git(
        ["commit", "-m", "workpilot: exclude build and test outputs from the branch"],
        cwd=worktree,
    )
    if commit.returncode != 0 and "nothing to commit" not in (
        commit.stdout + commit.stderr
    ):
        logger.warning("[build_artifacts] Commit failed: %s", commit.stderr)
        git(
            ["reset", "-q", "HEAD", "--pathspec-from-file=-", "--pathspec-file-nul"],
            cwd=worktree,
            input_data="\0".join(stripped),
        )
        return []

    _freeze_tracked_outputs(worktree, base_ref, git)
    logger.info(
        "[build_artifacts] Removed %d build/test output(s) from %s.",
        len(stripped),
        worktree,
    )
    return stripped
