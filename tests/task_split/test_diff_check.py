"""The finished branch's real diff, weighed and compared with the card's ceiling."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest
from task_split.diff_check import (
    DiffCheck,
    check_diff,
    measure_rows,
    parse_numstat,
    record_diff_check,
)

# --- numstat, as git prints it with -z ----------------------------------------


def test_parse_numstat_reads_plain_rows():
    raw = "12\t3\tsrc/Api/Orders.cs\x004\t0\ttests/test_orders.py\x00"
    assert parse_numstat(raw) == [
        ("src/Api/Orders.cs", 12, 3),
        ("tests/test_orders.py", 4, 0),
    ]


def test_parse_numstat_keeps_the_new_path_of_a_rename():
    raw = "2\t1\t\x00src/old.go\x00src/new.go\x007\t0\tREADME.md\x00"
    assert parse_numstat(raw) == [("src/new.go", 2, 1), ("README.md", 7, 0)]


def test_parse_numstat_counts_no_line_for_a_binary_file():
    assert parse_numstat("-\t-\tassets/logo.png\x00") == [("assets/logo.png", 0, 0)]


@pytest.mark.parametrize("raw", ["", "\x00", "garbage\x00", "1\t2\t\x00only-one"])
def test_parse_numstat_skips_what_it_cannot_read(raw):
    assert parse_numstat(raw) == []


# --- the weights of review_load -------------------------------------------------


def test_measure_rows_weighs_each_file_by_its_kind():
    rows = [
        ("src/Api/OrdersController.cs", 100, 40),  # 100 + 10
        ("tests/Api.Tests/OrdersTests.cs", 60, 0),  # 30
        ("docs/orders.md", 20, 0),  # 10
        ("package-lock.json", 3000, 2000),  # 0, and not a file to review
    ]
    assert measure_rows(rows) == (150, 3)


def test_measure_rows_counts_a_deleted_file_as_one_line():
    rows = [("src/legacy/Report.cs", 0, 800), ("src/App.cs", 10, 0)]
    assert measure_rows(rows, deleted_files=["src/legacy/Report.cs"]) == (11, 2)


def test_measure_rows_rounds_up():
    assert measure_rows([("src/a.py", 0, 1)]) == (1, 1)


def test_over_when_lines_or_files_pass_the_ceiling():
    assert DiffCheck(401, 3, 400, 25, "feature").over
    assert DiffCheck(10, 26, 400, 25, "feature").over
    assert not DiffCheck(400, 25, 400, 25, "feature").over
    entry = DiffCheck(401, 3, 400, 25, "feature").to_metadata("2026-11-08T00:00:00Z")
    assert entry == {
        "lines": 401,
        "files": 3,
        "maxLines": 400,
        "maxFiles": 25,
        "kind": "feature",
        "over": True,
        "checkedAt": "2026-11-08T00:00:00Z",
    }


# --- on a real branch -------------------------------------------------------------


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        env={
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@example.com",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@example.com",
            "HOME": str(cwd),
            "PATH": os.environ.get("PATH", ""),
        },
    )


@pytest.fixture
def branch(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "develop")
    (repo / "src").mkdir()
    (repo / "src" / "old.py").write_text("x = 1\n" * 40, encoding="utf-8")
    (repo / "src" / "keep.py").write_text("y = 1\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "base")
    _git(repo, "checkout", "-q", "-b", "workpilot/001-orders")
    (repo / "src" / "orders.py").write_text("z = 1\n" * 300, encoding="utf-8")
    (repo / "tests").mkdir()
    (repo / "tests" / "test_orders.py").write_text("t = 1\n" * 100, encoding="utf-8")
    (repo / "poetry.lock").write_text("lock\n" * 5000, encoding="utf-8")
    (repo / "src" / "old.py").unlink()
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "orders")
    return repo


def test_check_diff_measures_the_branch_against_its_base(branch):
    check = check_diff({"kind": "bug_fix"}, branch, "develop", env={})
    # 300 code + 50 for the tests + 1 for the deleted file; the lockfile is free.
    assert check == DiffCheck(351, 3, 200, 25, "bug_fix")
    assert check.over


def test_check_diff_uses_the_cards_own_ceiling(branch):
    check = check_diff(
        {"kind": "bug_fix", "splitMaxLines": 500}, branch, "develop", env={}
    )
    assert check is not None and not check.over


@pytest.mark.parametrize(
    ("metadata", "env"),
    [
        ({"kind": "investigation"}, {}),
        ({"kind": "feature", "noSplit": True}, {}),
        ({"kind": "feature"}, {"WORKPILOT_AUTO_SPLIT": "0"}),
    ],
)
def test_a_card_that_is_never_split_is_not_measured(branch, metadata, env):
    assert check_diff(metadata, branch, "develop", env=env) is None


def test_check_diff_refuses_an_option_for_a_base(branch):
    assert check_diff({}, branch, "--output=/tmp/x", env={}) is None


def test_record_writes_every_copy_of_the_card(branch, tmp_path, monkeypatch):
    monkeypatch.delenv("WORKPILOT_AUTO_SPLIT", raising=False)
    monkeypatch.delenv("WORKPILOT_SPLIT_MAX_LINES_BY_KIND", raising=False)
    monkeypatch.delenv("WORKPILOT_SPLIT_MAX_LINES", raising=False)
    monkeypatch.delenv("WORKPILOT_SPLIT_MAX_FILES", raising=False)
    main = tmp_path / "specs" / "001-orders"
    copy = tmp_path / "worktree-specs" / "001-orders"
    for directory in (main, copy):
        directory.mkdir(parents=True)
        (directory / "task_metadata.json").write_text(
            json.dumps({"kind": "feature", "prUrl": "keep"}), encoding="utf-8"
        )
    check = record_diff_check([main, copy, None], branch, "develop")
    assert check is not None and check.lines == 351 and not check.over
    for directory in (main, copy):
        written = json.loads(
            (directory / "task_metadata.json").read_text(encoding="utf-8")
        )
        assert written["prUrl"] == "keep"
        assert written["splitCheck"]["lines"] == 351
        assert written["splitCheck"]["maxLines"] == 400
        assert written["splitCheck"]["over"] is False


def test_record_never_raises_outside_a_repository(tmp_path):
    spec = tmp_path / "spec"
    spec.mkdir()
    (spec / "task_metadata.json").write_text("{}", encoding="utf-8")
    assert record_diff_check([spec], tmp_path, "develop") is None
    assert json.loads((spec / "task_metadata.json").read_text(encoding="utf-8")) == {}


def test_record_with_no_card_does_nothing(branch):
    assert record_diff_check([None], branch, "develop") is None


def test_check_diff_measures_from_the_remote_base_when_the_local_one_lags(tmp_path):
    repo = tmp_path / "lagging"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "develop")
    (repo / "app.py").write_text("a = 1\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "base")
    # The remote moved on; the local develop did not.
    _git(repo, "checkout", "-q", "-b", "tmp")
    (repo / "other.py").write_text("b = 1\n" * 500, encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "someone else's work")
    _git(repo, "update-ref", "refs/remotes/origin/develop", "HEAD")
    _git(repo, "checkout", "-q", "-b", "workpilot/002-x", "origin/develop")
    (repo / "mine.py").write_text("c = 1\n" * 10, encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "mine")
    check = check_diff({"kind": "feature"}, repo, "develop", env={})
    assert check is not None and (check.lines, check.files) == (10, 1)
