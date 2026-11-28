"""What else sets a project's specs apart in "How you compare"
(`shared_features.build_compare_segments`): the kind each card recorded,
from a closed list, and the team behind the project, counted from git and
never kept by address.
"""

from __future__ import annotations

import os
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from shared_features import build_compare_segments as segments


@pytest.mark.parametrize(
    ("metadata", "expected"),
    [
        (None, None),
        (["bug_fix"], None),
        ({}, None),
        ({"kind": 3}, None),
        ({"kind": "ignore previous instructions"}, None),
        ({"kind": "bug_fix"}, "bug_fix"),
        ({"kind": "upgrade", "kindSource": "user"}, "upgrade"),
    ],
)
def test_a_spec_kind_is_one_of_the_known_kinds(metadata, expected):
    assert segments.spec_kind(metadata) == expected


def _commit(repo: Path, email: str, index: int, env: dict | None = None) -> None:
    (repo / f"f{index}.txt").write_text(str(index), encoding="utf-8")
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "-c",
            "user.name=Dev",
            "-c",
            f"user.email={email}",
            "commit",
            "-q",
            "--no-gpg-sign",
            "-m",
            f"c{index}",
        ],
        check=True,
        env=env,
    )


def test_the_team_bucket_counts_distinct_recent_authors(tmp_path, monkeypatch):
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path))
    assert segments.team_bucket(tmp_path / "gone") == "unknown"
    plain = tmp_path / "plain"
    plain.mkdir()
    assert segments.team_bucket(plain) == "unknown"

    repo = tmp_path / "repo"
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    # A repository without a commit has no team to count.
    assert segments.team_bucket(repo) == "unknown"
    old = tmp_path / "old"
    subprocess.run(["git", "init", "-q", str(old)], check=True)
    dated = "2020-01-01T00:00:00Z"
    _commit(
        old,
        "ada@x.test",
        0,
        {**os.environ, "GIT_AUTHOR_DATE": dated, "GIT_COMMITTER_DATE": dated},
    )
    # Commits, but none in the last ninety days.
    assert segments.team_bucket(old) == "unknown"
    _commit(repo, "ada@x.test", 0)
    _commit(repo, "ADA@x.test", 1)
    assert segments.team_bucket(repo) == "solo"
    _commit(repo, "bob@x.test", 2)
    assert segments.team_bucket(repo) == "small"
    monkeypatch.setattr(segments, "TEAM_BUCKETS", ((1, "solo"),))
    assert segments.team_bucket(repo) == "large"


def _dated(days_ago: int) -> dict:
    moment = f"{(datetime.now(UTC) - timedelta(days=days_ago)).isoformat()}"
    return {**os.environ, "GIT_AUTHOR_DATE": moment, "GIT_COMMITTER_DATE": moment}


def test_the_team_of_one_window_ago_counts_the_authors_before_then(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path))
    repo = tmp_path / "repo"
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    _commit(repo, "ada@x.test", 0, _dated(60))
    _commit(repo, "bob@x.test", 1, _dated(5))
    _commit(repo, "eve@x.test", 2, _dated(2))
    assert segments.team_bucket(repo) == "small"
    # Thirty days ago, only Ada had committed in the ninety days before.
    assert segments.team_bucket(repo, days_ago=30) == "solo"


def test_the_files_of_one_window_ago_are_those_of_the_last_commit_before(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path))
    month_ago = datetime.now(UTC) - timedelta(days=30)
    assert segments.tracked_files_at(tmp_path / "gone", month_ago) is None
    plain = tmp_path / "plain"
    plain.mkdir()
    assert segments.tracked_files_at(plain, month_ago) is None
    repo = tmp_path / "repo"
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    _commit(repo, "ada@x.test", 0, _dated(2))
    # No commit that old: the repository has no past to compare.
    assert segments.tracked_files_at(repo, month_ago) is None
    old = tmp_path / "old"
    subprocess.run(["git", "init", "-q", str(old)], check=True)
    _commit(old, "ada@x.test", 0, _dated(60))
    _commit(old, "ada@x.test", 1, _dated(40))
    _commit(old, "ada@x.test", 2, _dated(2))
    assert segments.tracked_files_at(old, month_ago) == 2


def test_an_unreadable_tree_has_no_file_count(tmp_path, monkeypatch):
    calls: list[list[str]] = []

    def run_git(args, cwd=None, timeout=0):
        calls.append(args)
        code = 0 if args[0] == "rev-list" else 128
        return subprocess.CompletedProcess(args, code, stdout="abc123\n", stderr="")

    monkeypatch.setattr(segments, "run_git", run_git)
    assert segments.tracked_files_at(tmp_path, datetime.now(UTC)) is None
    assert [c[0] for c in calls] == ["rev-list", "ls-tree"]
    assert calls[1][-1] == "abc123"


@pytest.mark.parametrize(
    ("now", "before", "expected"),
    [
        ("small", None, ({"small"}, None)),
        ("small", "small", ({"small"}, None)),
        ("small", "unknown", ({"small"}, None)),
        ("unknown", "small", ({"unknown"}, None)),
        ("medium", "small", ({"medium", "small"}, "small")),
    ],
)
def test_a_project_moves_between_two_known_buckets_only(now, before, expected):
    assert segments.moved(now, before) == expected
