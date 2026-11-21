"""What else sets a project's specs apart in "How you compare"
(`shared_features.build_compare_segments`): the kind each card recorded,
from a closed list, and the team behind the project, counted from git and
never kept by address.
"""

from __future__ import annotations

import os
import subprocess
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
