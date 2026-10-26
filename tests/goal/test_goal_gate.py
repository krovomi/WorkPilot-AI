"""The gate in a real git repository: protected paths, the change set, the cap."""

from __future__ import annotations

import json
import shlex
import subprocess
import sys
from pathlib import Path

import pytest
from goal.check import GoalRun
from goal.gate import (
    GOAL_ISSUE_TITLE,
    budget_exceeded,
    evaluate_goal,
    fix_request,
    read_goal,
    record_verdict,
)
from goal.protect import matches, protected_changes
from goal.spec import GOAL_FILENAME, GoalSpec
from goal.spend import task_spend

PY = shlex.quote(sys.executable)


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q", "-b", "develop")
    _git(root, "config", "user.email", "t@example.com")
    _git(root, "config", "user.name", "t")
    (root / "tests").mkdir()
    (root / "tests" / "test_app.py").write_text(
        "def test_x():\n    assert False\n", encoding="utf-8"
    )
    (root / "app.py").write_text("X = 1\n", encoding="utf-8")
    (root / ".gitignore").write_text(".workpilot/\n", encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "base")
    _git(root, "checkout", "-qb", "task")
    spec = root / ".workpilot" / "specs" / "001-x"
    spec.mkdir(parents=True)
    (spec / "implementation_plan.json").write_text("{}", encoding="utf-8")
    return root


def _spec_dir(repo: Path) -> Path:
    return repo / ".workpilot" / "specs" / "001-x"


def _passing() -> GoalSpec:
    return GoalSpec(command=f"{PY} -c pass", protected=("tests/**",))


@pytest.mark.parametrize(
    ("path", "pattern", "expected"),
    [
        ("tests/test_app.py", "tests/**", True),
        ("tests/unit/test_a.py", "tests", True),
        ("tests/unit/test_a.py", "tests/", True),
        ("src/tests.py", "tests", False),
        ("src/a.test.ts", "**/*.test.ts", True),
        ("a.test.ts", "**/*.test.ts", True),
        ("src/deep/a.ts", "src/*.ts", False),
        ("src/a.ts", "src/*.ts", True),
        ("tests\\unit\\x.py", "tests/**", True),
    ],
)
def test_globs(path, pattern, expected):
    assert matches(path, pattern) is expected


def test_untouched_protected_paths_let_the_command_decide(repo: Path):
    (repo / "app.py").write_text("X = 2\n", encoding="utf-8")
    verdict = evaluate_goal(_passing(), repo, _spec_dir(repo))
    assert verdict.status == "met"


def test_an_edited_test_is_unmet_without_running_the_command(repo: Path):
    (repo / "tests" / "test_app.py").write_text(
        "def test_x():\n    pass\n", encoding="utf-8"
    )
    ran = []

    def runner(spec, worktree):
        ran.append(spec)
        return GoalRun("met", exit_code=0)

    verdict = evaluate_goal(_passing(), repo, _spec_dir(repo), runner=runner)
    assert verdict.status == "unmet"
    assert verdict.protected_changed == ["tests/test_app.py"]
    assert ran == []
    assert verdict.issues()[0]["title"] == GOAL_ISSUE_TITLE


@pytest.mark.parametrize("how", ["commit", "delete", "rename", "new-file"])
def test_every_way_of_touching_a_protected_path_is_seen(repo: Path, how: str):
    test = repo / "tests" / "test_app.py"
    if how == "commit":
        test.write_text("def test_x():\n    pass\n", encoding="utf-8")
        _git(repo, "commit", "-qam", "weaken")
    elif how == "delete":
        test.unlink()
    elif how == "rename":
        _git(repo, "mv", "tests/test_app.py", "app_test_moved.py")
        _git(repo, "commit", "-qm", "move")
    else:
        (repo / "tests" / "conftest.py").write_text(
            "collect_ignore = ['test_app.py']\n", encoding="utf-8"
        )
    assert protected_changes(repo, ["develop"], ["tests/**"])


def test_an_unknown_fork_point_is_an_error_not_a_pass(repo: Path):
    verdict = evaluate_goal(
        GoalSpec(command=f"{PY} -c pass", protected=("tests/**",)),
        repo,
        _spec_dir(repo),
        runner=lambda *_: GoalRun("met", exit_code=0),
    )
    assert verdict.status == "met"
    _git(repo, "branch", "-D", "develop")
    verdict = evaluate_goal(
        _passing(), repo, _spec_dir(repo), runner=lambda *_: GoalRun("met", exit_code=0)
    )
    assert verdict.status == "error"
    assert not verdict.fixable


def test_the_task_base_branch_is_used(repo: Path):
    _git(repo, "checkout", "-q", "develop")
    _git(repo, "checkout", "-qb", "release")
    (repo / "tests" / "test_app.py").write_text(
        "# changed on release\n", encoding="utf-8"
    )
    _git(repo, "commit", "-qam", "release change")
    _git(repo, "checkout", "-qb", "task2")
    spec_dir = _spec_dir(repo)
    (spec_dir / "task_metadata.json").write_text(
        json.dumps({"baseBranch": "release"}), encoding="utf-8"
    )
    # Forked from `release`: the test file is the base's, not the task's change.
    assert evaluate_goal(_passing(), repo, spec_dir).status == "met"
    (spec_dir / "task_metadata.json").write_text(
        json.dumps({"baseBranch": "--evil"}), encoding="utf-8"
    )
    assert evaluate_goal(_passing(), repo, spec_dir).status == "unmet"


def test_the_commands_own_script_is_protected(repo: Path):
    (repo / "check.sh").write_text("exit 1\n", encoding="utf-8")
    _git(repo, "add", "check.sh")
    _git(repo, "commit", "-qm", "script")
    _git(repo, "branch", "-f", "develop", "HEAD")
    (repo / "check.sh").write_text("exit 0\n", encoding="utf-8")
    verdict = evaluate_goal(
        GoalSpec(command="sh ./check.sh"),
        repo,
        _spec_dir(repo),
        runner=lambda *_: GoalRun("met", exit_code=0),
    )
    assert verdict.status == "unmet"
    assert verdict.protected_changed == ["check.sh"]


def _ledger(project: Path, rows: list[dict]) -> None:
    path = project / ".workpilot" / "cost_data.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"usages": rows}), encoding="utf-8")


def test_spend_adds_both_ledgers_for_this_task_only(tmp_path: Path):
    main = tmp_path / "main"
    wt = main / ".workpilot" / "worktrees" / "tasks" / "001-x"
    main_spec = main / ".workpilot" / "specs" / "001-x"
    wt_spec = wt / ".workpilot" / "specs" / "001-x"
    main_spec.mkdir(parents=True)
    wt_spec.mkdir(parents=True)
    _ledger(
        main, [{"spec_id": "001-x", "cost": 1.0}, {"spec_id": "002-y", "cost": 9.0}]
    )
    _ledger(
        wt,
        [
            {"spec_id": "001-x", "cost": 0.5},
            {"spec_id": "001-x", "cost": 0, "input_tokens": 10},
        ],
    )
    spend = task_spend(main_spec, wt_spec)
    assert spend.usd == 1.5
    assert spend.complete is False
    assert task_spend(main_spec, main_spec).usd == 1.0


def test_the_cap_stops_at_the_floor(tmp_path: Path):
    spec_dir = tmp_path / "p" / ".workpilot" / "specs" / "001-x"
    spec_dir.mkdir(parents=True)
    goal = GoalSpec(command="x", max_cost_usd=2.0)
    _ledger(tmp_path / "p", [{"spec_id": "001-x", "cost": 1.0}])
    assert budget_exceeded(goal, spec_dir) is None
    _ledger(
        tmp_path / "p",
        [
            {"spec_id": "001-x", "cost": 2.0},
            {"spec_id": "001-x", "cost": 0, "output_tokens": 5},
        ],
    )
    over = budget_exceeded(goal, spec_dir)
    assert over is not None and over.status == "budget"
    assert "at least $2.00" in over.reason
    assert budget_exceeded(GoalSpec(command="x"), spec_dir) is None


def test_an_invalid_goal_file_is_a_verdict(tmp_path: Path):
    (tmp_path / GOAL_FILENAME).write_text('{"command": ""}', encoding="utf-8")
    goal, invalid = read_goal(tmp_path)
    assert goal is None
    assert invalid is not None and invalid.status == "invalid"


def test_the_verdict_reaches_the_plan(repo: Path):
    spec_dir = _spec_dir(repo)
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps({"title": "t"}), encoding="utf-8"
    )
    verdict = evaluate_goal(
        GoalSpec(command=f"{PY} -c 'raise SystemExit(2)'"), repo, spec_dir
    )
    record_verdict(verdict, spec_dir)
    plan = json.loads(
        (spec_dir / "implementation_plan.json").read_text(encoding="utf-8")
    )
    assert plan["title"] == "t"
    assert plan["goal"]["status"] == "unmet"
    record = json.loads((spec_dir / "goal_result.json").read_text(encoding="utf-8"))
    assert record["run"]["exit_code"] == 2


def test_the_fix_request_quotes_the_output(repo: Path):
    verdict = evaluate_goal(
        GoalSpec(command="x", protected=("tests/**",)),
        repo,
        _spec_dir(repo),
        runner=lambda *_: GoalRun(
            "unmet",
            exit_code=1,
            output_tail="FAILED tests/test_app.py",
            detail="exit code 1, expected 0",
        ),
    )
    text = fix_request(verdict, _spec_dir(repo))
    assert "FAILED tests/test_app.py" in text
    assert "`tests/**`" in text
    assert "Do not skip, delete or weaken a test" in text
