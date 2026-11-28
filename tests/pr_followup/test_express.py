"""The express lane: a project's own Dependabot and Renovate PRs, merged in N0 (K1).

The pull requests come from a stand-in forge; git, the fetch of the PR's head
from a real (bare) origin, the facts and the approvals engine run for real.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from pr_followup import express
from pr_followup.express import (
    all_passed,
    candidates,
    github_slug,
    judge,
    run_lane,
)
from pr_followup.model import Check, CheckState, PRSnapshot, ReviewThread

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "express_lane_runner.py"
PATCH = "Bump lodash from 4.17.20 to 4.17.21"
MAJOR = "Bump lodash from 3.10.1 to 4.17.21"
GREEN = (Check("unit", CheckState.PASSED),)


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    ).stdout.strip()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A project cloned from a bare origin, with ``main`` pushed."""
    origin = tmp_path / "origin.git"
    _git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    project = tmp_path / "project"
    _git(tmp_path, "clone", "-q", str(origin), str(project))
    for key, value in (
        ("user.name", "t"),
        ("user.email", "t@t"),
        ("commit.gpgsign", "false"),
    ):
        _git(project, "config", key, value)
    (project / "package.json").write_text('{"name": "app"}\n', encoding="utf-8")
    (project / "app.js").write_text("module.exports = 1;\n", encoding="utf-8")
    _git(project, "add", ".")
    _git(project, "commit", "-qm", "base")
    _git(project, "push", "-q", "origin", "HEAD:main")
    return project


def _bot_pr(project: Path, number: int, path: str, title: str) -> PRSnapshot:
    """A commit on top of main, pushed where GitHub keeps a PR's head."""
    _git(project, "checkout", "-q", "-B", f"bot/{number}", "origin/main")
    (project / path).write_text(f"{title}\n", encoding="utf-8")
    _git(project, "add", path)
    _git(project, "commit", "-qm", title)
    _git(project, "push", "-q", "origin", f"HEAD:refs/pull/{number}/head")
    _git(project, "checkout", "-q", "main")
    return PRSnapshot(
        url=f"https://github.com/acme/app/pull/{number}",
        number=number,
        head_sha=_git(project, "rev-parse", f"bot/{number}"),
        head_branch=f"dependabot/npm/{number}",
        base_branch="main",
        title=title,
        checks=GREEN,
    )


def _row(number: int, author: str = "app/dependabot", **extra) -> dict:
    return {
        "number": number,
        "title": PATCH,
        "author": {"login": author},
        "isDraft": False,
        "isCrossRepository": False,
        **extra,
    }


class Lane:
    """The stand-in ``gh`` (for ``pr list``) and forge (snapshot, merge)."""

    def __init__(self, rows: list[dict], snaps: dict[int, PRSnapshot], ok=True):
        self.rows = rows
        self.snaps = snaps
        self.ok = ok
        self.list_code = 0
        self.calls: list[list[str]] = []
        self.merged: list[tuple[int, str]] = []

    async def gh(self, args: list[str]) -> tuple[int, str, str]:
        self.calls.append(args)
        if self.list_code:
            return self.list_code, "", "HTTP 401: Bad credentials\nmore"
        return 0, json.dumps(self.rows), ""

    def forge(self, pr, gh):
        lane = self

        class Forge:
            async def snapshot(self) -> PRSnapshot:
                return lane.snaps[pr.number]

            async def merge(self, head_sha: str) -> tuple[bool, str]:
                lane.merged.append((pr.number, head_sha))
                return lane.ok, "" if lane.ok else "Head branch was modified"

        assert pr.owner == "acme" and pr.repo == "app" and gh == lane.gh
        return Forge()


@pytest.fixture
def lane(monkeypatch):
    def make(rows, snaps, mode="enforce", ok=True) -> Lane:
        fake = Lane(rows, snaps, ok)
        monkeypatch.setenv("WORKPILOT_APPROVALS", mode)
        monkeypatch.setattr(express, "github_slug", lambda _p: ("acme", "app"))
        monkeypatch.setattr(express, "GitHubForge", fake.forge)
        return fake

    return make


async def _run(project: Path, fake: Lane) -> tuple[dict, list[dict]]:
    lines: list[dict] = []
    result = await run_lane(project, fake.gh, lines.append)
    return result, lines


# --- which remote is a GitHub repository -------------------------------------


@pytest.mark.parametrize(
    ("url", "slug"),
    [
        ("https://github.com/acme/app.git", ("acme", "app")),
        ("https://github.com/acme/app", ("acme", "app")),
        ("git@github.com:acme/my.app.git", ("acme", "my.app")),
        ("ssh://git@github.com/acme-co/app/", ("acme-co", "app")),
        ("https://gitlab.com/acme/app.git", None),
        ("https://github.com/acme/app/extra", None),
        ("https://github.com/-acme/app", None),
        ("https://github.com/acme/..", None),
        ("https://github.com.evil.io/acme/app", None),
        ("https://github.com/acme/app;rm", None),
    ],
)
def test_only_a_github_origin_has_a_slug(repo, url, slug):
    _git(repo, "remote", "set-url", "origin", url)
    assert github_slug(repo) == slug


def test_a_project_without_an_origin_has_no_slug(tmp_path):
    _git(tmp_path, "init", "-q")
    assert github_slug(tmp_path) is None


# --- which pull requests are candidates ---------------------------------------


def test_only_the_two_bots_open_candidates():
    rows = [
        _row(1),
        _row(2, "renovate[bot]"),
        _row(3, "leub"),
        _row(4, "dependabot"),
        _row(5, isDraft=True),
        _row(6, isCrossRepository=True),
        _row(0),
        {**_row(7), "number": "7"},
        {"number": 8, "author": "app/renovate", "title": None},
        "not a row",
    ]
    found = candidates(json.dumps(rows))
    assert [(c.number, c.author) for c in found] == [
        (1, "app/dependabot"),
        (2, "renovate[bot]"),
    ]
    assert found[0].title == PATCH


@pytest.mark.parametrize("raw", ["", "not json", '{"number": 1}', "null"])
def test_an_unreadable_list_has_no_candidate(raw):
    assert candidates(raw) == []


def test_the_candidates_are_bounded():
    rows = [_row(n) for n in range(1, express.MAX_PRS + 20)]
    assert len(candidates(json.dumps(rows))) == express.MAX_PRS


# --- which checks count as green ----------------------------------------------


@pytest.mark.parametrize(
    ("checks", "threads", "error", "green"),
    [
        (GREEN, (), "", True),
        ((), (), "", False),
        (GREEN + (Check("lint", CheckState.FAILED),), (), "", False),
        (GREEN + (Check("e2e", CheckState.PENDING),), (), "", False),
        (GREEN, (), "gh failed", False),
        (GREEN, (ReviewThread(id="t", path="a.js", line=1, comments=()),), "", False),
    ],
)
def test_only_all_passed_checks_are_green(checks, threads, error, green):
    snap = PRSnapshot(url="u", checks=checks, threads=threads, error=error)
    assert all_passed(snap) is green


# --- the lane -----------------------------------------------------------------


async def test_enforce_merges_a_green_patch_bump_at_the_judged_head(repo, lane):
    snap = _bot_pr(repo, 11, "package-lock.json", PATCH)
    fake = lane([_row(11)], {11: snap})
    result, lines = await _run(repo, fake)
    assert result == {"seen": 1, "merged": 1}
    assert fake.merged == [(11, snap.head_sha)]
    assert lines == [
        {
            "pr": 11,
            "author": "app/dependabot",
            "tier": "N0",
            "action": "merge",
            "mode": "enforce",
            "merged": True,
        }
    ]
    assert fake.calls[0][:4] == ["pr", "list", "-R", "acme/app"]


async def test_observe_prints_the_decision_and_never_merges(repo, lane):
    snap = _bot_pr(repo, 12, "package-lock.json", PATCH)
    fake = lane([_row(12)], {12: snap}, mode="observe")
    result, lines = await _run(repo, fake)
    assert result == {"seen": 1, "merged": 0}
    assert fake.merged == []
    assert lines[0]["tier"] == "N0" and lines[0]["merged"] is False
    assert lines[0]["mode"] == "observe"


async def test_an_unknown_mode_is_observe(repo, lane):
    snap = _bot_pr(repo, 13, "package-lock.json", PATCH)
    fake = lane([_row(13)], {13: snap}, mode="yes-please")
    result, _lines = await _run(repo, fake)
    assert result["merged"] == 0 and fake.merged == []


async def test_off_does_not_even_list(repo, lane):
    fake = lane([_row(14)], {}, mode="off")
    assert await _run(repo, fake) == ({"skipped": "approval tiers are off"}, [])
    assert fake.calls == []


async def test_a_major_bump_is_left_to_a_person(repo, lane):
    snap = _bot_pr(repo, 15, "package-lock.json", MAJOR)
    fake = lane([_row(15, title=MAJOR)], {15: snap})
    result, lines = await _run(repo, fake)
    assert result == {"seen": 1, "merged": 0} and fake.merged == []
    assert lines[0]["tier"] == "N2"


async def test_a_bump_that_changes_code_is_not_n0(repo, lane):
    snap = _bot_pr(repo, 16, "app.js", PATCH)
    fake = lane([_row(16)], {16: snap})
    _result, lines = await _run(repo, fake)
    assert lines[0]["tier"] != "N0" and fake.merged == []


async def test_a_red_or_running_check_is_skipped_unjudged(repo, lane, monkeypatch):
    red = _bot_pr(repo, 17, "package-lock.json", PATCH)
    red = PRSnapshot(**{**red.__dict__, "checks": (Check("unit", CheckState.FAILED),)})
    running = PRSnapshot(
        **{**red.__dict__, "number": 18, "checks": (Check("u", CheckState.PENDING),)}
    )
    monkeypatch.setattr(express, "judge", lambda *_a: pytest.fail("judged"))
    fake = lane([_row(17), _row(18)], {17: red, 18: running})
    result, lines = await _run(repo, fake)
    assert result == {"seen": 2, "merged": 0} and fake.merged == []
    assert [line["skipped"] for line in lines] == ["checks not all passed"] * 2


async def test_a_person_s_pr_is_never_looked_at(repo, lane):
    fake = lane([_row(19, "leub")], {})
    assert await _run(repo, fake) == ({"seen": 0, "merged": 0}, [])


async def test_a_refused_merge_is_reported(repo, lane):
    snap = _bot_pr(repo, 20, "package-lock.json", PATCH)
    fake = lane([_row(20)], {20: snap}, ok=False)
    result, lines = await _run(repo, fake)
    assert result == {"seen": 1, "merged": 0}
    assert lines[0]["merged"] is False
    assert lines[0]["mergeError"] == "Head branch was modified"


async def test_a_head_the_origin_does_not_have_is_skipped(repo, lane):
    snap = _bot_pr(repo, 21, "package-lock.json", PATCH)
    gone = PRSnapshot(**{**snap.__dict__, "number": 22})
    fake = lane([_row(22)], {22: gone})
    _result, lines = await _run(repo, fake)
    assert lines[0]["skipped"] == "git could not fetch the pull request"
    assert fake.merged == []


async def test_a_head_git_cannot_diff_is_skipped(repo, lane):
    snap = _bot_pr(repo, 23, "package-lock.json", PATCH)
    wrong = PRSnapshot(**{**snap.__dict__, "head_sha": "c" * 40})
    fake = lane([_row(23)], {23: wrong})
    _result, lines = await _run(repo, fake)
    assert "change set" in lines[0]["skipped"] and fake.merged == []


@pytest.mark.parametrize("base", ["", "-x", "a..b", "main;rm", "../main"])
async def test_an_odd_base_is_never_fetched(repo, lane, base):
    snap = _bot_pr(repo, 24, "package-lock.json", PATCH)
    odd = PRSnapshot(**{**snap.__dict__, "base_branch": base})
    fake = lane([_row(24)], {24: odd})
    _result, lines = await _run(repo, fake)
    assert lines[0]["skipped"] == "git could not fetch the pull request"


async def test_a_failing_judge_is_a_skip(repo, lane, monkeypatch):
    snap = _bot_pr(repo, 25, "package-lock.json", PATCH)

    def broken(*_args):
        raise OSError("disk gone")

    monkeypatch.setattr(express, "judge", broken)
    fake = lane([_row(25)], {25: snap})
    _result, lines = await _run(repo, fake)
    assert lines[0]["skipped"] == "disk gone" and fake.merged == []


async def test_a_list_gh_refuses_is_an_error(repo, lane):
    fake = lane([], {})
    fake.list_code = 1
    assert await _run(repo, fake) == ({"error": "HTTP 401: Bad credentials"}, [])


async def test_a_list_failure_without_a_message_is_still_an_error(repo, lane):
    fake = lane([], {})

    async def silent(_args):
        return 1, "", ""

    fake.gh = silent
    assert (await run_lane(repo, silent, lambda _l: None)) == {
        "error": "gh pr list failed"
    }


async def test_a_project_whose_origin_is_not_github_is_skipped(repo, monkeypatch):
    monkeypatch.setenv("WORKPILOT_APPROVALS", "enforce")

    async def gh(_args):
        pytest.fail("listed")

    assert await run_lane(repo, gh, lambda _l: None) == {
        "skipped": "origin is not a GitHub repository"
    }


def test_judge_reads_the_policy_of_the_project(repo, monkeypatch):
    monkeypatch.setenv("WORKPILOT_APPROVALS", "enforce")
    (repo / "workpilot.policy.yaml").write_text(
        "approvals:\n  mode: observe\n", encoding="utf-8"
    )
    snap = _bot_pr(repo, 26, "package-lock.json", PATCH)
    decision = judge(repo, snap)
    assert decision["tier"] == "N0" and decision["merges"] is False


# --- the runner the desktop app starts ----------------------------------------


def _runner():
    spec = importlib.util.spec_from_file_location("express_lane_runner", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_runner_prints_the_lines_then_the_result(repo, monkeypatch, capsys):
    runner = _runner()

    async def fake_lane(project, gh, emit):
        assert project == repo.resolve() and callable(gh)
        emit({"pr": 1, "merged": True})
        return {"seen": 1, "merged": 1}

    monkeypatch.setattr(runner, "run_lane", fake_lane)
    assert runner.run(["--project-dir", str(repo)]) == 0
    out = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert out == [{"pr": 1, "merged": True}, {"result": {"seen": 1, "merged": 1}}]


def test_the_runner_refuses_a_worktree(repo, monkeypatch, capsys):
    runner = _runner()
    tree = repo / ".workpilot" / "worktrees" / "tasks" / "001-x"
    tree.mkdir(parents=True)
    monkeypatch.setattr(runner, "run_lane", lambda *_a: pytest.fail("ran"))
    assert runner.run(["--project-dir", str(tree)]) == 1
    assert "not a worktree" in json.loads(capsys.readouterr().out)["error"]


def test_the_runner_refuses_a_missing_project(tmp_path, capsys):
    runner = _runner()
    assert runner.run(["--project-dir", str(tmp_path / "gone")]) == 1
    assert "error" in json.loads(capsys.readouterr().out)


def test_the_runner_as_a_process_reports_a_non_github_origin(repo):
    proc = subprocess.run(
        [sys.executable, str(RUNNER), "--project-dir", str(repo)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**os.environ, "WORKPILOT_APPROVALS": "enforce"},
        timeout=60,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    last = json.loads(proc.stdout.splitlines()[-1])
    assert last == {"result": {"skipped": "origin is not a GitHub repository"}}
