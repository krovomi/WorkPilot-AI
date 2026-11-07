"""Review comments: the orchestrator decides which ones a session addressed.

`addressed` follows the session's diff, never a reply of the model; a
comment the diff does not touch stays open; one whose lines are gone is
`stale`, never moved to a guessed line.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from foundation.review_comments import (
    REVIEW_COMMENTS_FILE,
    load_comments,
    mark_addressed,
    touched_ranges,
)

SERVICE = [
    "class OrderService:",
    "    def total(self, order):",
    "        return sum(i.price for i in order.items)",
    "",
    "    def cancel(self, order):",
    "        order.status = 'cancelled'",
    "",
    "    def ship(self, order):",
    "        order.status = 'shipped'",
]


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    _git(tmp_path, "init", "-q", "-b", "main")
    (tmp_path / "order_service.py").write_text(
        "\n".join(SERVICE) + "\n", encoding="utf-8"
    )
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-q", "-m", "base")
    return tmp_path


def _comment(cid: str, line: int, *, side: str = "new") -> dict:
    return {
        "id": cid,
        "path": "order_service.py",
        "side": side,
        "line": line,
        "excerpt": SERVICE[line - 2 : line + 1],
        "excerpt_offset": 1,
        "text": "handle a null order",
        "status": "open",
        "updated_at": "2026-11-06T10:00:00+00:00",
    }


def _write(spec: Path, comments: list[dict]) -> None:
    spec.mkdir(parents=True, exist_ok=True)
    (spec / REVIEW_COMMENTS_FILE).write_text(
        json.dumps({"comments": comments}), encoding="utf-8"
    )


def test_the_session_diff_decides_which_comment_is_addressed(
    repo: Path, tmp_path: Path
):
    spec = tmp_path / "spec"
    # Line 3 (total) is touched by the fix; line 9 (ship) is not.
    _write(spec, [_comment("total", 3), _comment("ship", 9)])
    before = _git(repo, "rev-parse", "HEAD")
    lines = list(SERVICE)
    lines[2] = "        return sum(i.price for i in order.items) if order else 0"
    (repo / "order_service.py").write_text("\n".join(lines) + "\n", encoding="utf-8")

    assert mark_addressed(spec, repo, before, session=0) == 1

    status = {c["id"]: c["status"] for c in load_comments(spec)}
    assert status == {"total": "addressed", "ship": "open"}


def test_a_comment_follows_its_lines_when_they_move(repo: Path, tmp_path: Path):
    spec = tmp_path / "spec"
    _write(spec, [_comment("cancel", 6)])
    # Two lines added above, committed before the fixer's session.
    (repo / "order_service.py").write_text(
        "\n".join(["# orders", "# v2", *SERVICE]) + "\n", encoding="utf-8"
    )
    _git(repo, "commit", "-qam", "header")
    before = _git(repo, "rev-parse", "HEAD")
    moved = ["# orders", "# v2", *SERVICE]
    moved[7] = "        order.status = 'cancelled'  # refund too"
    (repo / "order_service.py").write_text("\n".join(moved) + "\n", encoding="utf-8")

    assert mark_addressed(spec, repo, before) == 1
    assert load_comments(spec)[0]["status"] == "addressed"


def test_a_comment_whose_lines_are_gone_is_stale(repo: Path, tmp_path: Path):
    spec = tmp_path / "spec"
    _write(spec, [_comment("cancel", 6)])
    (repo / "order_service.py").write_text(
        "class OrderService:\n    pass\n", encoding="utf-8"
    )
    _git(repo, "commit", "-qam", "rewrite")
    before = _git(repo, "rev-parse", "HEAD")

    mark_addressed(spec, repo, before)

    assert load_comments(spec)[0]["status"] == "stale"


def test_nothing_changes_without_a_start_or_for_removed_lines(
    repo: Path, tmp_path: Path
):
    spec = tmp_path / "spec"
    _write(
        spec,
        [_comment("old", 3, side="old"), {**_comment("done", 3), "status": "resolved"}],
    )
    before = _git(repo, "rev-parse", "HEAD")
    (repo / "order_service.py").write_text("changed\n", encoding="utf-8")

    assert mark_addressed(spec, repo, None) == 0
    assert mark_addressed(spec, repo, before) == 0
    assert [c["status"] for c in load_comments(spec)] == ["open", "resolved"]


def test_touched_ranges_reads_old_side_hunks():
    diff = (
        "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n"
        "@@ -3 +3 @@\n-x\n+y\n@@ -10,0 +11,2 @@\n+z\n+w\n"
        "diff --git a/new.py b/new.py\n--- /dev/null\n+++ b/new.py\n@@ -0,0 +1 @@\n+n\n"
    )
    assert touched_ranges(diff) == {"a.py": [(3, 3), (10, 11)], "new.py": [(0, 1)]}


def test_malformed_files_read_as_no_comment(tmp_path: Path):
    (tmp_path / REVIEW_COMMENTS_FILE).write_text("{not json", encoding="utf-8")
    assert load_comments(tmp_path) == []
    (tmp_path / REVIEW_COMMENTS_FILE).write_text(
        json.dumps({"comments": [{"id": 1}, {"id": "a", "path": "x", "line": 2}]}),
        encoding="utf-8",
    )
    assert [c["id"] for c in load_comments(tmp_path)] == ["a"]


def test_agents_cannot_write_the_comments():
    """An agent that could write it would mark its own work reviewed."""
    from security.path_guard import protected_config_refusal, protected_config_target

    assert protected_config_target(f".workpilot/specs/001-x/{REVIEW_COMMENTS_FILE}")
    reason = protected_config_refusal(REVIEW_COMMENTS_FILE, Path("."))
    assert reason and "line comments" in reason
    assert "security configuration" not in reason
