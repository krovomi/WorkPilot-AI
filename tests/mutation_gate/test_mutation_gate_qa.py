"""The mutation gate in the QA loop and as the hard gate `tests-bite`.

A ``fail`` sends the fixer back with a `QA_FIX_REQUEST.md` naming each
survivor as a missing test; the fixer may then change tests only, anything
else it changed is restored. The record is what `tests-bite` reads, and an
absent, switched-off or unknown record is never a pass.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from foundation.change_scope import ChangeScope
from mutation_gate import commands, load_record, write_record
from qa import mutation_gate as gate_module
from qa.mutation_gate import (
    ISSUE_TYPE,
    MUTATION_ENV,
    guard_start,
    guard_test_only,
    mutation_gate,
    threshold_for,
)
from workflows.engine import resolve_profile
from workflows.hard_gates import TESTS_BITE
from workflows.spec import load_workflow

from workflows import evaluate_hard_gates

REPO_ROOT = Path(__file__).resolve().parents[2]


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    monkeypatch.delenv(MUTATION_ENV, raising=False)
    monkeypatch.setattr(commands, "_python", lambda _root: sys.executable)


@pytest.fixture
def task(tmp_path):
    """A worktree whose task wrote a rule and a test that asserts nothing."""
    repo = tmp_path / "wt"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@example.test")
    _git(repo, "config", "user.name", "t")
    (repo / "pytest.ini").write_text("[pytest]\npythonpath = .\n", encoding="utf-8")
    (repo / "shop.py").write_text(
        "def can_ship(t):\n    return True\n", encoding="utf-8"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "base")
    base = _git(repo, "rev-parse", "HEAD")
    (repo / "shop.py").write_text(
        "def can_ship(t):\n    return t >= 10\n", encoding="utf-8"
    )
    (repo / "tests").mkdir()
    (repo / "tests" / "test_shop.py").write_text(
        "from shop import can_ship\n\ndef test_it():\n    can_ship(3)\n",
        encoding="utf-8",
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "task")
    spec = tmp_path / "spec"
    spec.mkdir()
    (spec / "implementation_plan.json").write_text(
        json.dumps({"qa_signoff": {"status": "approved"}}), encoding="utf-8"
    )
    scope = ChangeScope(
        "full", "test", files=("shop.py", "tests/test_shop.py"), base=base
    )
    return repo, spec, scope


def _bite(spec: Path, workflow: str = "test"):
    loaded = load_workflow(REPO_ROOT / "workflows" / workflow / "workflow.yaml")
    report = evaluate_hard_gates(resolve_profile(loaded, "medium"), spec)
    return next(r for r in report.results if r.gate == TESTS_BITE)


def test_the_test_workflow_declares_it_and_the_feature_build_does_not():
    gates = lambda kind: ",".join(  # noqa: E731
        p.hard_gate
        for p in load_workflow(REPO_ROOT / "workflows" / kind / "workflow.yaml").phases
        if p.hard_gate
    ).split(",")
    assert TESTS_BITE in gates("test")
    assert TESTS_BITE not in gates("feature-build")


def test_who_asks_for_it(tmp_path, monkeypatch):
    monkeypatch.setattr(gate_module, "_declared", lambda _spec: False)
    assert threshold_for(tmp_path) is None  # nobody: the gate does not run
    monkeypatch.setattr(gate_module, "_declared", lambda _spec: True)
    assert threshold_for(tmp_path) == 60
    monkeypatch.setenv(MUTATION_ENV, "80")
    assert threshold_for(tmp_path) == 80
    monkeypatch.setenv(MUTATION_ENV, "0")
    assert threshold_for(tmp_path) == 0
    monkeypatch.setenv(MUTATION_ENV, "lots")  # a typo does not switch it off
    assert threshold_for(tmp_path) == 60


def test_survivors_reject_the_pass_with_a_test_only_fix_request(task, monkeypatch):
    repo, spec, scope = task
    monkeypatch.setenv(MUTATION_ENV, "60")
    rejected = mutation_gate(spec, repo, 2, scope)
    assert rejected is not None
    issues, verdict = rejected
    assert "mutant(s) the tests did not catch" in verdict
    assert issues and all(i["type"] == ISSUE_TYPE for i in issues)
    request = (spec / "QA_FIX_REQUEST.md").read_text(encoding="utf-8")
    assert "The tests still pass when `>= becomes >` at `shop.py:2`" in request
    assert "test files only" in request
    plan = json.loads((spec / "implementation_plan.json").read_text(encoding="utf-8"))
    assert plan["qa_signoff"]["status"] == "rejected"
    assert load_record(spec)["status"] == "fail"
    held = _bite(spec)
    assert held.held is False and "shop.py:2" in held.detail


def test_switched_off_is_recorded_and_never_a_pass(task, monkeypatch):
    repo, spec, scope = task
    monkeypatch.setenv(MUTATION_ENV, "0")
    assert mutation_gate(spec, repo, 1, scope) is None
    held = _bite(spec)
    assert held.held is None and MUTATION_ENV in held.detail


def test_without_a_record_the_gate_is_unknown(tmp_path):
    held = _bite(tmp_path)
    assert held.held is None and "did not run" in held.detail


def test_a_passing_record_holds(tmp_path):
    write_record(
        tmp_path, {"status": "pass", "score": 90, "threshold": 60, "results": []}
    )
    held = _bite(tmp_path)
    assert held.held is True and "90%" in held.detail


def test_an_unknown_change_set_does_not_reject(task, monkeypatch):
    repo, spec, _ = task
    monkeypatch.setenv(MUTATION_ENV, "60")
    assert mutation_gate(spec, repo, 1, None) is None
    assert load_record(spec)["status"] == "unknown"


def test_the_fixer_may_change_tests_only(task):
    repo, spec, _ = task
    gate = ([{"type": ISSUE_TYPE, "title": "t", "description": "d"}], "rejected")
    assert guard_start(repo, ([{"type": "other"}], "x")) is None
    head = guard_start(repo, gate)
    assert head
    # The fixer "kills" the mutant by changing the code, and adds a test.
    (repo / "shop.py").write_text(
        "def can_ship(t):\n    return t > 9\n", encoding="utf-8"
    )
    (repo / "helper.py").write_text("X = 1\n", encoding="utf-8")
    (repo / "tests" / "test_more.py").write_text(
        "def test_x():\n    assert True\n", encoding="utf-8"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "fixer")
    restored = guard_test_only(repo, spec, head)
    assert sorted(restored) == ["helper.py", "shop.py"]
    assert (repo / "shop.py").read_text(encoding="utf-8").endswith("t >= 10\n")
    assert not (repo / "helper.py").exists()
    assert (repo / "tests" / "test_more.py").is_file()
    assert _git(repo, "status", "--porcelain") == ""


@pytest.fixture
def failing(task, monkeypatch):
    monkeypatch.setenv(MUTATION_ENV, "60")
    return task


def test_the_plan_files_are_mutated_first(failing):
    repo, spec, scope = failing
    plan = json.loads((spec / "implementation_plan.json").read_text(encoding="utf-8"))
    plan["phases"] = [
        {"subtasks": [{"files_to_modify": ["./shop.py", 7], "files_to_create": None}]},
        None,
        {"subtasks": [None, {"files_to_create": ["tests\\test_shop.py", "shop.py"]}]},
    ]
    (spec / "implementation_plan.json").write_text(json.dumps(plan), encoding="utf-8")

    assert gate_module._plan_files(spec) == ("shop.py", "tests/test_shop.py")
    assert mutation_gate(spec, repo, 1, scope) is not None


def test_an_unreadable_workflow_declares_nothing(tmp_path, monkeypatch):
    from workflows.spec import WorkflowError

    def broken(spec_dir):
        raise WorkflowError("bad yaml")

    monkeypatch.setattr("workflows.registry.load_workflow_for_spec", broken)

    assert threshold_for(tmp_path) is None


def test_a_rejection_without_a_plan_still_stands(failing):
    repo, spec, scope = failing
    (spec / "implementation_plan.json").unlink()

    assert mutation_gate(spec, repo, 1, scope) is not None


def test_an_unwritable_fix_request_does_not_lose_the_rejection(failing):
    repo, spec, scope = failing
    (spec / "QA_FIX_REQUEST.md").mkdir()

    issues, verdict = mutation_gate(spec, repo, 1, scope)

    assert issues and "rejected" in verdict


def test_a_record_that_cannot_be_written_skips_the_gate(failing):
    from mutation_gate import RECORD_FILE as RECORD

    repo, spec, scope = failing
    (spec / RECORD).mkdir()

    assert mutation_gate(spec, repo, 1, scope) is None


def test_the_verdict_goes_to_the_task_log(failing, monkeypatch):
    repo, spec, scope = failing
    logged: list[tuple[str, str]] = []

    class Log:
        def log(self, message, kind, phase):
            logged.append((message, kind.value))

    mutation_gate(spec, repo, 1, scope, task_logger=Log())
    mutation_gate(spec, repo, 2, None, task_logger=Log())

    assert [kind for _, kind in logged] == ["error", "info"]
    assert "✗ shop.py:2" in logged[0][0]
    assert "the change set is unknown" in logged[1][0]


def test_a_fixer_that_changed_tests_only_keeps_its_work(task):
    repo, spec, _ = task
    head = guard_start(repo, ([{"type": ISSUE_TYPE}], "rejected"))
    (repo / "tests" / "test_more.py").write_text(
        "def test_x():\n    assert True\n", encoding="utf-8"
    )

    assert guard_test_only(repo, spec, head) == []
    assert guard_test_only(repo, spec, None) == []


def test_an_uncommitted_code_change_is_restored_with_nothing_to_commit(task, capsys):
    repo, spec, _ = task
    head = guard_start(repo, ([{"type": ISSUE_TYPE}], "rejected"))
    (repo / "shop.py").write_text("def can_ship(t):\n    return 1\n", encoding="utf-8")

    assert guard_test_only(repo, spec, head) == ["shop.py"]
    assert (repo / "shop.py").read_text(encoding="utf-8").endswith("t >= 10\n")
    assert "restored shop.py" in capsys.readouterr().out
