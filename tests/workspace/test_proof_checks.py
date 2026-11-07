"""Proof checkers as a hard gate (lot 6, P2).

A project declares its proof checkers in `[proofs]` of `worktree.toml`; QA
runs them in the task's worktree once the reviewer approves, from the
project's approved recipe only. A rejected proof sends the fixer back; a
checker missing, a time out or a recipe not approved is unknown, never a
pass; a project without proofs gets no line at all.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest
from core.workspace import proofs as proofs_mod
from core.workspace.proofs import (
    load_proof_record,
    main_project_of,
    run_proofs,
    write_proof_record,
)
from core.workspace.recipe import Recipe, parse_recipe
from core.workspace.recipe_run import approve_recipe
from qa.proof_gate import proof_gate
from workflows.engine import resolve_profile
from workflows.hard_gates import PROOF_CHECKS
from workflows.spec import load_workflow

from workflows import evaluate_hard_gates

REPO_ROOT = Path(__file__).resolve().parents[2]
PY = sys.executable


def _toml(*commands: list[str], timeout: int | None = None) -> str:
    listed = ", ".join(json.dumps(c) for c in commands)
    text = f"[proofs]\ncommands = [{listed}]\n"
    if timeout is not None:
        text += f"timeout_seconds = {timeout}\n"
    return text


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


@pytest.fixture
def task(tmp_path: Path):
    """A project with a commit, a task worktree, and the task's spec folder."""
    project = tmp_path / "project"
    project.mkdir()
    _git(project, "init", "-q")
    _git(
        project,
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "user.name=T",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
    )
    worktree = tmp_path / "wt"
    _git(project, "worktree", "add", "-q", "-b", "task", str(worktree))
    spec = tmp_path / "spec"
    spec.mkdir()
    (spec / "implementation_plan.json").write_text(
        json.dumps({"qa_signoff": {"status": "approved"}}), encoding="utf-8"
    )
    return project, worktree, spec


def declare(project: Path, text: str, *, approve: bool = True) -> None:
    folder = project / ".workpilot"
    folder.mkdir(exist_ok=True)
    (folder / "worktree.toml").write_text(text, encoding="utf-8")
    if approve:
        approve_recipe(project)


def _gate(spec: Path):
    workflow = load_workflow(
        REPO_ROOT / "workflows" / "feature-build" / "workflow.yaml"
    )
    report = evaluate_hard_gates(resolve_profile(workflow, "medium"), spec)
    return [r for r in report.results if r.gate == PROOF_CHECKS]


def test_the_table_is_read_and_a_shell_string_refused():
    recipe = parse_recipe(_toml(["dafny", "verify", "src/Cart.dfy"], timeout=120))
    assert recipe.proofs == (("dafny", "verify", "src/Cart.dfy"),)
    assert recipe.proof_timeout_seconds == 120
    refused = parse_recipe(_toml(["bash", "-c", "dafny verify x.dfy"]))
    assert refused.errors and not refused.proofs


def test_an_approval_given_before_proofs_existed_stays_valid():
    recipe = parse_recipe('[setup]\ncommands = [["npm", "ci"]]\n')
    old_payload = {
        "setup": recipe.setup,
        "copy": (),
        "link": (),
        "pass_env": (),
        "timeout": recipe.timeout_seconds,
        "ports": 0,
        "teardown": (),
    }
    old = hashlib.sha256(
        json.dumps(old_payload, sort_keys=True).encode("utf-8")
    ).hexdigest()
    assert recipe.digest == old
    with_proofs = parse_recipe(
        '[setup]\ncommands = [["npm", "ci"]]\n' + _toml(["lean", "x"])
    )
    assert with_proofs.digest != old


def test_the_project_of_a_worktree_is_found(task):
    project, worktree, _spec = task
    assert main_project_of(worktree).resolve() == project.resolve()


def test_a_project_without_proofs_is_not_concerned(task):
    project, worktree, spec = task
    assert proof_gate(spec, worktree, 1) is None
    assert load_proof_record(spec)["status"] == "none"
    assert _gate(spec) == []


def test_an_unapproved_recipe_runs_nothing_and_is_unknown(task, tmp_path):
    project, worktree, spec = task
    marker = tmp_path / "ran"
    declare(
        project, _toml([PY, "-c", f"open({str(marker)!r}, 'w').close()"]), approve=False
    )
    assert proof_gate(spec, worktree, 1) is None
    assert not marker.exists()
    [result] = _gate(spec)
    assert result.held is None and "not approved" in result.detail


def test_an_accepted_proof_holds(task):
    project, worktree, spec = task
    declare(project, _toml([PY, "-c", "print('verified')"]))
    assert proof_gate(spec, worktree, 1) is None
    [result] = _gate(spec)
    assert result.held is True


def test_a_rejected_proof_sends_the_fixer_back(task):
    project, worktree, spec = task
    declare(
        project,
        _toml(
            [PY, "-c", "import sys; print('postcondition might not hold'); sys.exit(4)"]
        ),
    )
    gate = proof_gate(spec, worktree, 3)
    assert gate is not None
    issues, verdict = gate
    assert "pass #3" in verdict
    assert [i["type"] for i in issues] == ["proof_rejected"]
    request = (spec / "QA_FIX_REQUEST.md").read_text(encoding="utf-8")
    assert "postcondition might not hold" in request
    assert "Do not weaken" in request
    plan = json.loads((spec / "implementation_plan.json").read_text(encoding="utf-8"))
    assert plan["qa_signoff"]["status"] == "rejected"
    [result] = _gate(spec)
    assert result.held is False


def test_a_missing_checker_or_a_time_out_is_unknown(task, monkeypatch):
    project, worktree, spec = task
    declare(project, _toml(["workpilot-no-such-verifier", "check"]))
    assert proof_gate(spec, worktree, 1) is None
    [result] = _gate(spec)
    assert result.held is None and "not installed" in result.detail
    monkeypatch.setattr(proofs_mod, "is_approved", lambda *_: True)
    slow = Recipe(
        "file",
        proofs=((PY, "-c", "import time; time.sleep(30)"),),
        proof_timeout_seconds=1,
    )
    report = run_proofs(project, worktree, "t", slow)
    assert report.status == "unknown"
    assert report.checks[0]["status"] == "timeout"


def test_the_worktree_copy_of_the_recipe_is_never_run(task, tmp_path):
    """An agent that edits worktree.toml in its branch changes nothing that runs."""
    project, worktree, spec = task
    declare(project, _toml([PY, "-c", "print('ok')"]))
    marker = tmp_path / "agent-ran"
    (worktree / ".workpilot").mkdir()
    (worktree / ".workpilot" / "worktree.toml").write_text(
        _toml([PY, "-c", f"open({str(marker)!r}, 'w').close()"]), encoding="utf-8"
    )
    assert proof_gate(spec, worktree, 1) is None
    assert not marker.exists()
    assert load_proof_record(spec)["status"] == "pass"


def test_no_record_is_unknown(tmp_path):
    [result] = _gate(tmp_path)
    assert result.held is None and "did not run" in result.detail
    write_proof_record(tmp_path, run_proofs(tmp_path, tmp_path, "t"))
    assert _gate(tmp_path) == []
