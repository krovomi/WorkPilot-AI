"""The guard in the QA loop and as the hard gate `deps-exist`.

A blocked package sends the fixer back with a `QA_FIX_REQUEST.md`; anything
else lets the approval stand. The record the gate writes is what `deps-exist`
reads, and an absent or uncertain record is never a pass.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from foundation.change_scope import ChangeScope
from qa.dependency_gate import DEPENDENCY_GUARD_ENV, dependency_gate
from workflows.engine import resolve_profile
from workflows.hard_gates import DEPS_EXIST
from workflows.spec import load_workflow

from workflows import evaluate_hard_gates

REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("WORKPILOT_DEPGUARD_HOME", str(home))
    monkeypatch.delenv(DEPENDENCY_GUARD_ENV, raising=False)
    for name in ("NPM_CONFIG_REGISTRY", "npm_config_registry", "APPDATA"):
        monkeypatch.delenv(name, raising=False)


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.fixture
def task(tmp_path):
    """A worktree whose task added `zod` and `react-quantum-state` to package.json."""
    repo = tmp_path / "wt"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@example.test")
    _git(repo, "config", "user.name", "t")
    (repo / "package.json").write_text(
        '{"dependencies": {"react": "^18"}}', encoding="utf-8"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "base")
    base = _git(repo, "rev-parse", "HEAD")
    (repo / "package.json").write_text(
        '{"dependencies": {"react": "^18", "zod": "^3", "react-quantum-state": "^1"}}',
        encoding="utf-8",
    )
    spec = tmp_path / "spec"
    spec.mkdir()
    (spec / "implementation_plan.json").write_text(
        json.dumps({"qa_signoff": {"status": "approved"}}), encoding="utf-8"
    )
    scope = ChangeScope("full", "test", files=("package.json",), base=base)
    return repo, spec, scope


def fetch_404_for(name: str):
    def fetch(url: str) -> tuple[int, bytes]:
        return (404, b"") if url.endswith("/" + name) else (200, b"{}")

    return fetch


def _deps_gate(spec: Path):
    workflow = load_workflow(
        REPO_ROOT / "workflows" / "feature-build" / "workflow.yaml"
    )
    report = evaluate_hard_gates(resolve_profile(workflow, "medium"), spec)
    return next(r for r in report.results if r.gate == DEPS_EXIST)


def test_an_invented_package_rejects_the_pass_and_briefs_the_fixer(task):
    repo, spec, scope = task

    gate = dependency_gate(
        spec, repo, 2, scope, fetch=fetch_404_for("react-quantum-state")
    )

    assert gate is not None
    issues, verdict = gate
    assert "pass #2" in verdict
    assert [i["type"] for i in issues] == ["missing_dependency"]
    assert "react-quantum-state" in issues[0]["description"]
    fix = (spec / "QA_FIX_REQUEST.md").read_text(encoding="utf-8")
    assert "`react-quantum-state` (npm)" in fix
    assert "Never create or publish a package" in fix
    plan = json.loads((spec / "implementation_plan.json").read_text(encoding="utf-8"))
    assert plan["qa_signoff"]["status"] == "rejected"
    held = _deps_gate(spec)
    assert held.held is False
    assert "react-quantum-state" in held.detail


def test_existing_packages_let_the_approval_stand(task):
    repo, spec, scope = task

    assert dependency_gate(spec, repo, 1, scope, fetch=lambda u: (200, b"{}")) is None

    assert not (spec / "QA_FIX_REQUEST.md").exists()
    held = _deps_gate(spec)
    assert held.held is True
    assert "2 new package(s)" in held.detail


def test_a_registry_that_does_not_answer_never_blocks_and_never_passes(task):
    repo, spec, scope = task

    assert dependency_gate(spec, repo, 1, scope, fetch=lambda u: (0, b"")) is None

    held = _deps_gate(spec)
    assert held.held is None
    assert "zod" in held.detail


def test_strict_offline_mode_asks_no_registry(task):
    repo, spec, scope = task
    (repo / ".workpilot").mkdir()
    (repo / ".workpilot" / "offline-mode.json").write_text(
        json.dumps({"airgapStrict": True}), encoding="utf-8"
    )

    def fetch(url):
        raise AssertionError("no call in strict offline mode")

    assert dependency_gate(spec, repo, 1, scope, fetch=fetch) is None
    assert _deps_gate(spec).held is None


def test_no_new_dependency_holds(task):
    repo, spec, scope = task
    no_manifest = ChangeScope("full", "test", files=("src/app.ts",), base=scope.base)

    assert dependency_gate(spec, repo, 1, no_manifest, fetch=fetch_404_for("x")) is None

    held = _deps_gate(spec)
    assert held.held is True
    assert held.detail == "no new dependency"


def test_an_unknown_change_set_is_unknown(task):
    repo, spec, _ = task
    assert dependency_gate(spec, repo, 1, ChangeScope("full", "unavailable")) is None
    assert _deps_gate(spec).held is None
    assert dependency_gate(spec, repo, 1, None) is None
    assert _deps_gate(spec).held is None


def test_switched_off_it_says_so_and_is_not_a_pass(task, monkeypatch):
    repo, spec, scope = task
    monkeypatch.setenv(DEPENDENCY_GUARD_ENV, "0")

    def fetch(url):
        raise AssertionError("a disabled guard asks nothing")

    assert dependency_gate(spec, repo, 1, scope, fetch=fetch) is None
    held = _deps_gate(spec)
    assert held.held is None
    assert DEPENDENCY_GUARD_ENV in held.detail


def test_without_a_record_the_gate_is_unknown(tmp_path):
    held = _deps_gate(tmp_path)
    assert held.held is None
    assert "did not run" in held.detail


@pytest.mark.parametrize("kind", ["feature-build", "bug-fix", "hotfix", "refactoring"])
def test_the_workflows_that_add_code_declare_it(kind):
    workflow = load_workflow(REPO_ROOT / "workflows" / kind / "workflow.yaml")
    gates = ",".join(p.hard_gate for p in workflow.phases if p.hard_gate)
    assert DEPS_EXIST in gates.split(",")
