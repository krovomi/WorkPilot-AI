"""The CI/CD bisect (#375), on a real temporary git repository.

The test command is the stack's own (pytest here, run by the interpreter of
this test session); the bisect runs it in a temporary worktree and must leave
the repository's working copy, HEAD and worktree list exactly as they were.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from self_healing.cicd import bisect as bisect_module
from self_healing.cicd.bisect import BisectBudget, run_bisect
from self_healing.cicd.flow import render_first_bad
from self_healing.cicd.green import last_green, record_green
from self_healing.cicd.triggers import (
    evaluate_triggers,
    failing_test_files,
    is_commit_sha,
)
from self_healing.incident_responder.orchestrator import IncidentResponderOrchestrator
from suite_runner.runs import RunOutcome, TestCommand

PYTEST = TestCommand(
    "pytest", "pytest", f'"{sys.executable}" -m pytest -p no:cacheprovider'
)
FAILING = ["tests/test_calc.py::test_add"]
DAY = 86400


def git(repo: Path, *args: str, when: int | None = None) -> str:
    env = dict(os.environ)
    if when is not None:
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = f"@{when} +0000"
    return subprocess.run(
        [
            "git",
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.invalid",
            "-c",
            "commit.gpgsign=false",
            *args,
        ],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
        env=env,
    ).stdout.strip()


def commit(
    repo: Path, files: dict[str, str], message: str, when: int | None = None
) -> str:
    for name, text in files.items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", message, when=when)
    return git(repo, "rev-parse", "HEAD")


GOOD_CALC = "def add(a, b):\n    return a + b\n"
BAD_CALC = "def add(a, b):\n    return a - b\n"
TEST = "from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n"


@pytest.fixture
def repo(tmp_path: Path) -> dict:
    root = tmp_path / "proj"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    (root / ".gitignore").write_text(".workpilot/\n", encoding="utf-8")
    start = int(time.time()) - 60 * DAY
    shas = [
        commit(
            root,
            {
                "pytest.ini": "[pytest]\npythonpath = .\n",
                "calc.py": GOOD_CALC,
                "tests/test_calc.py": TEST,
                ".gitignore": ".workpilot/\n",
            },
            "start",
            when=start,
        )
    ]
    for index in range(1, 8):
        files = {f"notes/{index}.txt": f"note {index}\n"}
        if index == 4:
            files["calc.py"] = BAD_CALC
        shas.append(commit(root, files, f"change {index}", when=start + index * DAY))
    return {"root": root, "shas": shas, "culprit": shas[4]}


def _state(root: Path) -> tuple[str, str, str]:
    return (
        git(root, "rev-parse", "HEAD"),
        git(root, "status", "--porcelain"),
        git(root, "worktree", "list", "--porcelain"),
    )


def test_the_first_bad_commit_is_found_without_touching_the_copy(repo):
    root, shas = repo["root"], repo["shas"]
    before = _state(root)
    seen: list[str] = []

    result = run_bisect(
        root,
        shas[0][:10],
        shas[-1],
        FAILING,
        command=PYTEST,
        on_step=lambda step, tested: seen.append(
            f"{tested}:{step.role}:{step.outcome}"
        ),
    )

    assert result.status == "found", result.reason
    assert result.first_bad == repo["culprit"]
    assert result.first_bad_subject == "change 4"
    assert result.narrowed
    assert seen[:4] == [
        "1:bad-check:bad",
        "2:flaky-check:bad",
        "3:flaky-check:bad",
        "4:good-check:good",
    ]
    assert len(result.steps) <= 4 + 3  # log2(7) search steps at most
    assert _state(root) == before

    again = run_bisect(root, shas[0], shas[-1], FAILING, command=PYTEST)
    assert again.cached and again.first_bad == repo["culprit"]


def test_the_stack_s_command_is_detected_in_the_checkout(repo, monkeypatch):
    root, shas = repo["root"], repo["shas"]
    detected = []

    def detect(path):
        detected.append(path)
        return [PYTEST]

    monkeypatch.setattr(bisect_module, "detect_test_commands", detect)
    result = run_bisect(root, shas[0], shas[-1], FAILING, use_cache=False)
    assert result.first_bad == repo["culprit"]
    assert detected and detected[0] != root and "workpilot-bisect-" in str(detected[0])
    assert not detected[0].exists()  # removed afterwards


def test_a_flaky_test_is_not_bisected(repo, tmp_path):
    root, shas = repo["root"], repo["shas"]
    counter = tmp_path / "runs.txt"
    flaky = (
        "from pathlib import Path\n\n\ndef test_add():\n"
        f"    counter = Path({str(counter)!r})\n"
        "    runs = int(counter.read_text()) if counter.exists() else 0\n"
        "    counter.write_text(str(runs + 1))\n"
        "    assert runs % 2 == 1\n"
    )
    bad = commit(root, {"tests/test_calc.py": flaky}, "flaky test")
    result = run_bisect(root, shas[0], bad, FAILING, command=PYTEST)
    assert result.status == "flaky"
    assert [s.role for s in result.steps] == ["bad-check", "flaky-check"]


def test_a_green_commit_that_fails_here_is_not_trusted(repo):
    root, shas = repo["root"], repo["shas"]
    result = run_bisect(root, shas[5], shas[-1], FAILING, command=PYTEST)
    assert result.status == "good_fails"
    assert result.first_bad == ""


def test_a_test_that_passes_at_the_failing_commit_is_not_reproduced(repo):
    root, shas = repo["root"], repo["shas"]
    result = run_bisect(root, shas[0], shas[2], FAILING, command=PYTEST)
    assert result.status == "not_reproduced"


def test_rewritten_history_ends_the_bisect(repo):
    root, shas = repo["root"], repo["shas"]
    git(root, "checkout", "-q", "-b", "side", shas[0])
    side = commit(root, {"side.txt": "x\n"}, "side")
    git(root, "checkout", "-q", "main")
    result = run_bisect(root, side, shas[-1], FAILING, command=PYTEST)
    assert result.status == "unavailable"
    assert "ancestor" in result.reason


@pytest.mark.parametrize(
    "hostile", ["HEAD", "main", "--output=/tmp/x", "abc123; rm -rf /", "a" * 41, ""]
)
def test_only_commit_ids_are_accepted(repo, hostile, monkeypatch):
    calls = []
    monkeypatch.setattr(bisect_module, "git", lambda *a, **k: calls.append(a))
    result = run_bisect(repo["root"], hostile, repo["shas"][-1], command=PYTEST)
    assert result.status == "unavailable"
    assert calls == []
    assert not is_commit_sha(hostile)


def _fake_runner(verdicts: dict[str, int | None]):
    """exit code by commit: None is a run that could not happen."""

    def run(command, checkout, out_dir, *, timeout_s, only=()):
        head = git(checkout, "rev-parse", "HEAD")
        code = verdicts.get(head, 0)
        if code is None:
            return RunOutcome(None, error="the command could not start")
        return RunOutcome(code)

    return run


def test_untestable_commits_leave_the_culprit_among_them(repo):
    root, shas = repo["root"], repo["shas"]
    verdicts: dict[str, int | None] = dict.fromkeys(shas[4:], 1)
    verdicts.update({shas[3]: None, shas[4]: None})
    result = run_bisect(
        root, shas[0], shas[-1], FAILING, command=PYTEST, runner=_fake_runner(verdicts)
    )
    assert result.status == "ambiguous"
    assert result.candidates[0] in (shas[3], shas[4])
    assert repo["culprit"] in result.candidates


def test_the_budget_stops_the_search(repo):
    root, shas = repo["root"], repo["shas"]
    verdicts = dict.fromkeys(shas[4:], 1)
    result = run_bisect(
        root,
        shas[0],
        shas[-1],
        FAILING,
        command=PYTEST,
        budget=BisectBudget(max_runs=4),
        runner=_fake_runner(verdicts),
    )
    assert result.status == "budget"
    assert len(result.steps) == 4
    assert repo["culprit"] in result.candidates


# ── triggers ───────────────────────────────────────────────────


def test_triggers_read_the_history(repo):
    root, shas = repo["root"], repo["shas"]
    deps = commit(root, {"package.json": '{"dependencies": {"x": "2"}}\n'}, "bump x")
    last = commit(root, {"calc.py": BAD_CALC + "# comment\n"}, "comment")
    triggers = evaluate_triggers(root, last, FAILING, good=shas[0])
    assert triggers.trivial_diff and triggers.changed_lines == 1
    # The test file was last touched 60 days ago.
    assert triggers.old_tests == ["tests/test_calc.py"]
    assert triggers.dependency_files == ["package.json"]
    assert set(triggers.reasons) == {"trivial_diff", "old_test", "dependency_changed"}
    _ = deps


def test_a_big_recent_change_fires_nothing(repo):
    root = repo["root"]
    big = "\n".join(f"x{i} = {i}" for i in range(40))
    last = commit(
        root, {"calc.py": GOOD_CALC + big, "tests/test_calc.py": TEST + "\n"}, "big"
    )
    assert not evaluate_triggers(root, last, FAILING).fired


def test_failing_test_names_point_at_files_inside_the_repo_only(repo):
    root = repo["root"]
    names = [
        "tests/test_calc.py::test_add",
        "tests/test_calc.py > adds",
        "../../etc/passwd::x",
        "TestCalc.test_add",
    ]
    assert failing_test_files(root, names) == ["tests/test_calc.py"]


def test_the_last_green_commit_is_kept_per_branch(repo):
    root, shas = repo["root"], repo["shas"]
    assert record_green(root, "main", shas[2])
    assert not record_green(root, "main", "HEAD")
    assert last_green(root, "main") == shas[2]
    assert last_green(root, "develop") == ""


# ── the incident and the fixer's prompt ────────────────────────


async def test_a_fired_trigger_bisects_and_names_the_culprit(
    repo, tmp_path, monkeypatch
):
    root, shas = repo["root"], repo["shas"]
    last = commit(root, {"notes/x.txt": "x\n"}, "tiny")
    monkeypatch.setattr(bisect_module, "detect_test_commands", lambda _path: [PYTEST])
    orchestrator = IncidentResponderOrchestrator(
        root, data_dir=tmp_path / "state", auto_fix=False
    )
    record_green(root, "main", shas[0])

    operation = await orchestrator.handle_cicd_failure(
        commit_sha=last,
        branch="main",
        test_output="FAILED tests/test_calc.py::test_add - assert -1 == 5",
    )

    incident = operation.incident
    assert incident.source_data["bisect_triggers"]["fired"]
    assert incident.source_data["bisect"]["status"] == "found"
    assert incident.regression_commit == repo["culprit"]
    prompt = orchestrator.cicd.build_agent_prompt(incident)
    assert repo["culprit"] in prompt
    assert "return a - b" in prompt  # the culprit's diff, not the last commit's


async def test_bisect_on_demand_needs_a_green_commit(repo, tmp_path):
    root = repo["root"]
    orchestrator = IncidentResponderOrchestrator(
        root, data_dir=tmp_path / "state", auto_fix=False, auto_bisect=False
    )
    operation = await orchestrator.handle_cicd_failure(
        commit_sha=repo["shas"][-1],
        branch="main",
        test_output="FAILED tests/test_calc.py::test_add",
    )
    result = await orchestrator.bisect_incident(operation.incident.id)
    assert result.status == "unavailable"
    assert "no green commit" in render_first_bad(operation.incident.source_data)
    assert await orchestrator.bisect_incident("nope") is None


# ── the edges of a run ─────────────────────────────────────────


def _runner(verdicts: dict[str, RunOutcome]):
    """The outcome by commit; a commit not named passes."""

    def run(command, checkout, out_dir, *, timeout_s, only=()):
        return verdicts.get(git(checkout, "rev-parse", "HEAD"), RunOutcome(0))

    return run


def test_tests_that_cannot_be_named_run_the_whole_suite(repo):
    root, shas = repo["root"], repo["shas"]
    calls: list = []
    base = _fake_runner(dict.fromkeys(shas[4:], 1))

    def run(command, checkout, out_dir, *, timeout_s, only=()):
        calls.append(tuple(only))
        if only:
            return RunOutcome(None, error=f"{bisect_module._UNSELECTABLE} by pytest")
        return base(command, checkout, out_dir, timeout_s=timeout_s)

    result = run_bisect(root, shas[0], shas[-1], FAILING, command=PYTEST, runner=run)
    assert result.status == "found" and result.first_bad == repo["culprit"]
    assert not result.narrowed
    assert calls[0] == tuple(FAILING) and all(c == () for c in calls[1:])


def test_timeouts_and_empty_selections_are_skipped(repo):
    root, shas = repo["root"], repo["shas"]
    verdicts = dict.fromkeys(shas[5:], RunOutcome(1))
    verdicts[shas[3]] = RunOutcome(None, timed_out=True)
    verdicts[shas[4]] = RunOutcome(5)
    result = run_bisect(
        root, shas[0], shas[-1], FAILING, command=PYTEST, runner=_runner(verdicts)
    )
    assert result.status == "ambiguous"
    details = {s.sha: s.detail for s in result.steps}
    assert details[shas[3]] == "timed out"
    assert details[shas[4]] == "no test selected at this commit"


def test_a_commit_that_cannot_be_checked_out_is_skipped(repo, monkeypatch):
    root, shas = repo["root"], repo["shas"]
    real = bisect_module._Checkout.checkout
    monkeypatch.setattr(
        bisect_module._Checkout,
        "checkout",
        lambda self, sha: sha != shas[4] and real(self, sha),
    )
    result = run_bisect(
        root,
        shas[0],
        shas[-1],
        FAILING,
        command=PYTEST,
        runner=_runner(dict.fromkeys(shas[4:], RunOutcome(1))),
    )
    assert {s.detail for s in result.steps if s.sha == shas[4]} == {"checkout failed"}


def test_a_checkout_refuses_an_unknown_commit(repo):
    root, shas = repo["root"], repo["shas"]
    with bisect_module._Checkout(root, shas[-1]) as checkout:
        assert not checkout.checkout("f" * 40)
        assert checkout.checkout(shas[0])


def test_dependency_folders_are_lent_never_removed(repo, monkeypatch):
    root, shas = repo["root"], repo["shas"]
    (root / "node_modules").mkdir()
    (root / "node_modules" / "dep.js").write_text("x\n", encoding="utf-8")
    (root / "vendor").mkdir()
    real_symlink = os.symlink

    def symlink(source, target, target_is_directory=False):
        if Path(target).name == "vendor":
            raise OSError("no links here")
        real_symlink(source, target, target_is_directory=target_is_directory)

    monkeypatch.setattr(bisect_module.os, "symlink", symlink)
    seen: list = []

    def run(command, checkout, out_dir, *, timeout_s, only=()):
        seen.append(
            (
                (checkout / "node_modules" / "dep.js").is_file(),
                (checkout / "vendor").exists(),
            )
        )
        head = git(checkout, "rev-parse", "HEAD")
        return RunOutcome(1 if head in shas[4:] else 0)

    result = run_bisect(root, shas[0], shas[-1], FAILING, command=PYTEST, runner=run)
    assert result.status == "found"
    assert set(seen) == {(True, False)}
    assert (root / "node_modules" / "dep.js").is_file()


def test_commits_that_do_not_make_a_range(repo, monkeypatch):
    root, shas = repo["root"], repo["shas"]
    unknown = run_bisect(root, "deadbeef1", shas[-1], command=PYTEST)
    assert unknown.status == "unavailable" and "not found" in unknown.reason
    same = run_bisect(root, shas[2], shas[2][:9], command=PYTEST)
    assert "the same" in same.reason

    real_git = bisect_module.git
    monkeypatch.setattr(
        bisect_module,
        "git",
        lambda project, args, **kw: (
            None if args[0] == "rev-list" else real_git(project, args, **kw)
        ),
    )
    empty = run_bisect(root, shas[0], shas[-1], command=PYTEST)
    assert "no commit between" in empty.reason


def test_a_stack_without_a_test_command_is_not_bisected(repo, monkeypatch):
    root, shas = repo["root"], repo["shas"]
    monkeypatch.setattr(bisect_module, "detect_test_commands", lambda _path: [])
    result = run_bisect(root, shas[0], shas[-1], FAILING)
    assert result.status == "unavailable"
    assert "no test command" in result.reason
    assert _state(root)[2].count("worktree ") == 1


def test_a_worktree_git_will_not_add_ends_the_bisect(repo, monkeypatch):
    root, shas = repo["root"], repo["shas"]
    real_git = bisect_module.git
    monkeypatch.setattr(
        bisect_module,
        "git",
        lambda project, args, **kw: (
            None if args[:2] == ["worktree", "add"] else real_git(project, args, **kw)
        ),
    )
    result = run_bisect(root, shas[0], shas[-1], FAILING, command=PYTEST)
    assert result.status == "unavailable"
    assert "temporary worktree" in result.reason


def test_the_cache_is_bounded_and_never_fails_the_bisect(tmp_path, monkeypatch):
    monkeypatch.setattr(bisect_module, "_MAX_CACHE", 1)
    first = bisect_module.BisectResult("found", first_bad="a" * 40)
    bisect_module._write_cache(tmp_path, "one", first)
    bisect_module._write_cache(tmp_path, "two", first)
    assert list(bisect_module._read_cache(tmp_path)) == ["two"]

    def refuse(*_a, **_k):
        raise OSError("read-only")

    monkeypatch.setattr(bisect_module, "write_json_atomic", refuse)
    bisect_module._write_cache(tmp_path, "three", first)
    assert list(bisect_module._read_cache(tmp_path)) == ["two"]


# ── the parts around it ────────────────────────────────────────


def test_git_that_cannot_start_is_none(tmp_path):
    from self_healing.cicd.triggers import git as triggers_git

    assert triggers_git(tmp_path / "missing", ["status"]) is None


def test_triggers_need_commit_ids(repo):
    root = repo["root"]
    assert evaluate_triggers(root, "HEAD", FAILING).changed_lines is None
    assert not evaluate_triggers(root, repo["shas"][-1], FAILING, good="main").fired
    assert failing_test_files(root, ["test_add", ""]) == []


def test_the_green_record_is_bounded_and_may_fail(repo, monkeypatch):
    from self_healing.cicd import green as green_module

    root, shas = repo["root"], repo["shas"]
    monkeypatch.setattr(green_module, "_MAX_BRANCHES", 1)
    record_green(root, "main", shas[1])
    record_green(root, "develop", shas[2])
    assert (last_green(root, "main"), last_green(root, "develop")) == ("", shas[2])
    monkeypatch.setattr(green_module, "_MAX_BRANCHES", 2)
    record_green(root, "main", shas[1])
    record_green(root, "develop", shas[3])
    assert (last_green(root, "main"), last_green(root, "develop")) == (shas[1], shas[3])

    def refuse(*_a, **_k):
        raise OSError("read-only")

    monkeypatch.setattr(green_module, "write_json_atomic", refuse)
    assert not record_green(root, "main", shas[3])


def test_a_bisect_without_a_culprit_leaves_the_regression_alone():
    from self_healing.cicd.flow import apply_bisect
    from self_healing.incident_responder.models import Incident, IncidentMode

    incident = Incident(mode=IncidentMode.CICD, source_data={"diff_summary": "d"})
    apply_bisect(
        incident,
        bisect_module.BisectResult("not_reproduced"),
        lambda _sha: pytest.fail("no diff to read"),
    )
    assert incident.source_data["bisect"]["status"] == "not_reproduced"
    assert incident.source_data["diff_summary"] == "d"


@pytest.mark.parametrize(
    ("data", "expected"),
    [
        (
            {"bisect": {"status": "ambiguous", "candidates": ["a" * 40]}},
            "`aaaaaaaaaaaa`",
        ),
        ({"bisect": {"status": "budget", "candidates": []}}, "not to a single one"),
        ({"bisect": {"status": "flaky"}}, "flaky"),
        (
            {"bisect": {"status": "good_fails", "reason": "green fails"}},
            "ended `good_fails` (green fails)",
        ),
        (
            {"bisect_triggers": {"fired": True, "reasons": ["old_test"]}},
            "(old_test), but no bisect ran",
        ),
        ({}, "the last commit is the first suspect"),
    ],
)
def test_the_prompt_says_what_the_bisect_found(data, expected):
    assert expected in render_first_bad(data)


async def test_bisect_on_demand_from_a_named_green_commit(repo, tmp_path, monkeypatch):
    root, shas = repo["root"], repo["shas"]
    monkeypatch.setattr(bisect_module, "detect_test_commands", lambda _path: [PYTEST])
    orchestrator = IncidentResponderOrchestrator(
        root, data_dir=tmp_path / "state", auto_fix=False, auto_bisect=False
    )
    operation = await orchestrator.handle_cicd_failure(
        commit_sha=shas[-1],
        branch="main",
        test_output="FAILED tests/test_calc.py::test_add",
    )
    steps: list = []
    result = await orchestrator.bisect_incident(
        operation.incident.id, shas[0], on_step=lambda step, n: steps.append(n)
    )
    assert result.status == "found" and result.first_bad == repo["culprit"]
    assert operation.incident.source_data["last_green"] == shas[0]
    assert steps[0] == 1
