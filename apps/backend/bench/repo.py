"""Git for the bench: the target of a card, its hidden tests, isolated copies.

A finished card's work entered the base branch at one commit, its *target*:
the merge of ``workpilot/<spec>``, or the commit a pull request was squashed
into. Its first parent is the *base*: the code as it was before the card. The
tests the card added or changed between the two are the *hidden tests*: the
replay's judge, which no replaying agent ever sees.

A copy is a new repository holding the history of one commit and nothing
else: ``git init``, then a shallow fetch of that commit from the project. The
target, a descendant of the base, is not an ancestor of anything fetched, so
it is not in a copy made at the base; the copy has no remote either, so no
``git fetch`` run inside it can bring the target in.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from foundation.git_executable import (
    get_git_executable,
    get_isolated_git_env,
    run_git,
)
from foundation.platform import find_executable

from .layout import COMMIT, BenchError

# Directories whose files are tests, wherever they are.
_TEST_DIRS = {"tests", "test", "__tests__"}
_DOTNET_TEST_DIR = re.compile(r"\.(Unit|Integration)?Tests?$")
_RUNNABLE = (
    re.compile(r"^test_[^/]*\.py$"),
    re.compile(r"^[^/]*_test\.py$"),
    re.compile(r"^[^/]*\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$"),
    re.compile(r"^[^/]*_test\.go$"),
    re.compile(r"^[^/]*Tests?\.cs$"),
)
# Files that change what a test run does without being tests: they belong to
# the judge, so a copy gets them as the base or the target has them.
_JUDGE_FILES = re.compile(
    r"^(conftest\.py|pytest\.ini|sitecustomize\.py|usercustomize\.py"
    r"|(vitest|jest)\.(config|setup|workspace)\.[cm]?[jt]s"
    r"|setupTests\.[jt]sx?)$"
)
_JS_IN_TEST_DIR = re.compile(r"\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$")
_PR_URL = re.compile(r"^https://[A-Za-z0-9.-]+/[\w.-]+/[\w.-]+/pulls?/\d+$")
_GH_TIMEOUT = 20


@dataclass
class TestChanges:
    """The tests a card changed, as git saw them between base and target."""

    changed: list[str] = field(default_factory=list)  # added or modified
    deleted: list[str] = field(default_factory=list)

    @property
    def runnable(self) -> list[str]:
        return [p for p in self.changed if is_runnable_test(p)]


def git(args: list[str], cwd: Path, timeout: int = 120) -> str:
    result = run_git(args, cwd=cwd, timeout=timeout)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip().splitlines()
        reason = detail[-1][:300] if detail else f"exit {result.returncode}"
        raise BenchError(f"git {args[0]} failed: {reason}")
    return result.stdout


def resolve_commit(project_dir: Path, rev: str) -> str | None:
    result = run_git(
        ["rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}"], cwd=project_dir
    )
    sha = result.stdout.strip()
    return sha if result.returncode == 0 and COMMIT.match(sha) else None


def parents(project_dir: Path, sha: str) -> list[str]:
    line = git(["rev-list", "--parents", "-n", "1", sha], project_dir).split()
    return line[1:]


def is_test_path(path: str) -> bool:
    parts = PurePosixPath(path).parts
    if not parts or parts[0] == ".workpilot":
        return False
    folders = parts[:-1]
    if any(part in _TEST_DIRS for part in folders):
        return True
    if any(_DOTNET_TEST_DIR.search(part) for part in folders):
        return True
    return bool(_JUDGE_FILES.match(parts[-1])) or is_runnable_test(path)


def is_runnable_test(path: str) -> bool:
    """A file a test runner is given, not only a file the tests read."""
    posix = PurePosixPath(path)
    if not posix.parts or posix.parts[0] == ".workpilot":
        return False
    name = posix.name
    if any(pattern.match(name) for pattern in _RUNNABLE):
        return not name.endswith(".cs") or _in_dotnet_tests(posix)
    if "__tests__" in posix.parts[:-1] and _JS_IN_TEST_DIR.search(name):
        return True
    return False


def _in_dotnet_tests(path: PurePosixPath) -> bool:
    return path.name.endswith(("Tests.cs", "Test.cs")) or any(
        _DOTNET_TEST_DIR.search(part) for part in path.parts[:-1]
    )


def test_changes(project_dir: Path, base: str, target: str) -> TestChanges:
    out = git(
        ["diff", "--name-status", "--no-renames", "-z", base, target], project_dir
    )
    fields = out.split("\0")
    changes = TestChanges()
    for status, path in zip(fields[0::2], fields[1::2], strict=False):
        if not path or not is_test_path(path):
            continue
        if status.startswith(("A", "M", "T")):
            changes.changed.append(path)
        elif status.startswith("D"):
            changes.deleted.append(path)
    return changes


def merge_of_branch(project_dir: Path, spec_id: str) -> tuple[str | None, str]:
    """The merge commit that brought ``workpilot/<spec>`` in, and a note.

    Every branch but the task branches is searched, so a card merged into
    ``develop`` is found as well as one merged into ``main``. When the branch
    was merged more than once, the first merge is the card's work; the later
    ones carry its fixes, which are not part of the card as it was asked.
    """
    refs = [
        line
        for line in git(
            ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"],
            project_dir,
        ).splitlines()
        if line and "/workpilot/" not in line and not line.endswith("/HEAD")
    ]
    if not refs:
        return None, ""
    # A spec id is [A-Za-z0-9._-]: the dot is its only regex character.
    pattern = "workpilot/" + spec_id.replace(".", r"\.") + r"([^A-Za-z0-9._-]|$)"
    out = git(
        [
            "log",
            "--merges",
            "--extended-regexp",
            f"--grep={pattern}",
            # Parents before children: two merges made in the same second are
            # still ordered, which the commit time alone does not do.
            "--topo-order",
            "--reverse",
            "--format=%H",
            *refs,
            "--",
        ],
        project_dir,
    )
    found = list(dict.fromkeys(sha for sha in out.split() if COMMIT.match(sha)))
    if not found:
        return None, ""
    note = (
        f"{len(found)} merges of the branch: the first one is used"
        if len(found) > 1
        else ""
    )
    return found[0], note


def merge_of_pr(project_dir: Path, pr_url: str) -> str | None:
    """The commit a merged pull request landed as, asked of ``gh``.

    Best effort: ``gh`` may be missing or signed out, and the commit may not
    have been fetched yet. ``None`` then, and the person gives the commit.
    """
    if not isinstance(pr_url, str) or not _PR_URL.match(pr_url):
        return None
    gh = find_executable("gh")
    if not gh:
        return None
    env = {
        key: value
        for key, value in os.environ.items()
        if key in _GH_ENV or key.startswith(("GH_", "XDG_"))
    }
    try:
        result = subprocess.run(
            [gh, "pr", "view", pr_url, "--json", "state,mergeCommit"],
            cwd=project_dir,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_GH_TIMEOUT,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    try:
        data = json.loads(result.stdout)
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get("state") != "MERGED":
        return None
    oid = (data.get("mergeCommit") or {}).get("oid")
    if not isinstance(oid, str) or not COMMIT.match(oid):
        return None
    return resolve_commit(project_dir, oid)


_GH_ENV = {
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "GITHUB_TOKEN",
}


def read_blob(project_dir: Path, commit: str, path: str) -> bytes:
    result = subprocess.run(
        [get_git_executable(), "cat-file", "blob", f"{commit}:{path}"],
        cwd=project_dir,
        env=get_isolated_git_env(),
        capture_output=True,
        timeout=60,
        stdin=subprocess.DEVNULL,
    )
    if result.returncode != 0:
        raise BenchError(f"cannot read {path} at {commit[:12]}")
    return result.stdout


def isolated_copy(project_dir: Path, commit: str, dest: Path, depth: int) -> None:
    """A new repository at ``commit``, with ``depth`` commits of its history.

    The commit is fetched by id. A git that refuses that (protocol v0 without
    ``allowReachableSHA1InWant``) gets it through a ref made for the fetch in
    the project and deleted right after.
    """
    if dest.exists() or dest.is_symlink():
        raise BenchError(f"{dest.name} already exists")
    dest.mkdir(parents=True)
    git(["init", "-q"], dest)
    source = project_dir.resolve().as_uri()
    fetch = ["fetch", "-q", "--no-tags", f"--depth={depth}", source]
    if run_git([*fetch, commit], cwd=dest, timeout=600).returncode != 0:
        ref = f"refs/workpilot-bench/{secrets.token_hex(8)}"
        git(["update-ref", ref, commit], project_dir)
        try:
            git([*fetch, ref], dest, timeout=600)
        finally:
            run_git(["update-ref", "-d", ref], cwd=project_dir)
    git(["checkout", "-q", "-b", "bench", "FETCH_HEAD"], dest)
    head = git(["rev-parse", "HEAD"], dest).strip()
    if head != commit:
        raise BenchError(f"the copy is at {head[:12]}, not {commit[:12]}")
    git(["config", "user.name", "WorkPilot bench"], dest)
    git(["config", "user.email", "bench@workpilot.invalid"], dest)
    exclude = dest / ".git" / "info" / "exclude"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    with exclude.open("a", encoding="utf-8") as handle:
        handle.write("\n.workpilot/\n")


def reset_agent_tests(copy_dir: Path, base: str, changes: TestChanges) -> list[str]:
    """Put back, as the base has them, the test files the agent changed.

    The judge is the base's tests with the card's changes on top. A test file
    the replaying agent added, changed or deleted, and that the card did not
    touch, goes back to its base version (or away, if the agent added it),
    so neither the agent's own tests nor a ``conftest.py`` it wrote decide.
    Returns the paths put back.
    """
    touched: set[str] = set()
    out = git(["diff", "--name-only", "--no-renames", "-z", base], copy_dir)
    touched |= {p for p in out.split("\0") if p}
    out = git(["ls-files", "--others", "--exclude-standard", "-z"], copy_dir)
    touched |= {p for p in out.split("\0") if p}
    hidden = set(changes.changed) | set(changes.deleted)
    reset: list[str] = []
    for path in sorted(touched):
        if path in hidden or not is_test_path(path):
            continue
        dest = safe_destination(copy_dir, path)
        if dest.is_symlink() or dest.is_file():
            dest.unlink()
        elif dest.is_dir():
            shutil.rmtree(dest)
        listed = run_git(["cat-file", "-e", f"{base}:{path}"], cwd=copy_dir)
        if listed.returncode == 0:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(read_blob(copy_dir, base, path))
        reset.append(path)
    return reset


def contains(copy_dir: Path, commit: str) -> bool:
    """Whether ``commit`` is in the copy's object store."""
    return (
        run_git(["cat-file", "-e", f"{commit}^{{commit}}"], cwd=copy_dir).returncode
        == 0
    )


def safe_destination(root: Path, relative: str) -> Path:
    """``root/relative``, refused when a link or ``..`` would lead out of it.

    A replaying agent wrote the copy: it may have put a link where a test
    folder was. Every existing folder on the way must be a real folder, and
    the resolved path must stay in the copy.
    """
    rel = PurePosixPath(relative)
    if rel.is_absolute() or ".." in rel.parts or not rel.parts:
        raise BenchError(f"refused path {relative!r}")
    current = root
    for part in rel.parts[:-1]:
        current = current / part
        if current.is_symlink():
            raise BenchError(f"{relative}: a folder on its path is a link")
        if current.exists() and not current.is_dir():
            raise BenchError(f"{relative}: a file stands where a folder should be")
    dest = root / Path(*rel.parts)
    real_root = root.resolve()
    if not dest.parent.resolve().is_relative_to(real_root):
        raise BenchError(f"{relative} leads out of the copy")
    return dest


def overlay_tests(
    project_dir: Path, target: str, copy_dir: Path, changes: TestChanges
) -> None:
    """Put the card's tests, as the target has them, into a copy."""
    for path in changes.deleted:
        dest = safe_destination(copy_dir, path)
        if dest.is_symlink() or dest.is_file():
            dest.unlink()
        elif dest.is_dir():
            shutil.rmtree(dest)
    for path in changes.changed:
        dest = safe_destination(copy_dir, path)
        if dest.is_symlink():
            dest.unlink()
        elif dest.is_dir():
            shutil.rmtree(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(read_blob(project_dir, target, path))
