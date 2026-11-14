"""No tracked symbolic link points outside the repository.

A worktree often links ``apps/backend/.venv`` or ``node_modules`` to the main
checkout's. Once such a link was committed (``apps/backend/.venv`` pointing at
``/home/claude/workpilot-ai/...``): in every other clone it is a dead link, and
``pnpm run install:all`` cannot create the backend's virtual environment where
the dead link sits. ``.gitignore`` now ignores ``.venv`` whatever its type;
this test refuses any tracked link whose target is absolute or leaves the
repository, whatever its name.
"""

from __future__ import annotations

import subprocess
from pathlib import Path, PurePosixPath

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent


def _tracked_links() -> list[tuple[str, str]]:
    try:
        listing = subprocess.run(
            ["git", "ls-files", "-s", "-z"],
            cwd=REPO_ROOT,
            capture_output=True,
            check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        pytest.skip("not a git checkout")
        return []
    links: list[tuple[str, str]] = []
    for entry in listing.split(b"\0"):
        if not entry.startswith(b"120000 "):
            continue
        meta, _, path = entry.partition(b"\t")
        blob = meta.split()[1].decode()
        target = subprocess.run(
            ["git", "cat-file", "-p", blob],
            cwd=REPO_ROOT,
            capture_output=True,
            check=True,
        ).stdout.decode("utf-8", "replace")
        links.append((path.decode("utf-8", "replace"), target))
    return links


def _escapes(path: str, target: str) -> bool:
    if target.startswith(("/", "\\")) or (len(target) > 1 and target[1] == ":"):
        return True
    depth = len(PurePosixPath(path).parent.parts)
    for part in PurePosixPath(target.replace("\\", "/")).parts:
        depth += -1 if part == ".." else (0 if part == "." else 1)
        if depth < 0:
            return True
    return False


@pytest.mark.parametrize(
    ("path", "target", "escapes"),
    [
        ("apps/backend/.venv", "/home/someone/repo/apps/backend/.venv", True),
        ("apps/backend/.venv", "C:\\work\\repo\\.venv", True),
        ("apps/frontend/node_modules", "../../../other/node_modules", True),
        ("docs/link.md", "../README.md", False),
        ("a/b/c", "../../d/./e", False),
    ],
)
def test_escape_rule(path, target, escapes):
    assert _escapes(path, target) is escapes


def test_no_tracked_link_leaves_the_repository():
    bad = [
        f"{path} -> {target}"
        for path, target in _tracked_links()
        if _escapes(path, target)
    ]
    assert not bad, (
        "tracked symbolic links pointing outside the repository: " + ", ".join(bad)
    )


def test_a_venv_link_is_ignored():
    for path in ("apps/backend/.venv", ".venv"):
        result = subprocess.run(
            ["git", "check-ignore", "--no-index", "-q", path],
            cwd=REPO_ROOT,
            capture_output=True,
        )
        if result.returncode == 128:
            pytest.skip("not a git checkout")
        assert result.returncode == 0, f"{path} is not ignored"
