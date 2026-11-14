"""The WinDev integrity gate in the QA loop (docs/architecture/windev.md).

A change confined to code blocks passes; anything only the editor writes
(a binary element, an invented control, a new element) rejects the pass with
a fix request that says what to put back. The change set is read from git
as the loop reads it, so the gate sees what the reviewer saw.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from foundation.change_scope import ChangeScope, change_scope
from qa.loop import _coverage_gate
from qa.windev_gate import RECORD, windev_changes, windev_gate, windev_only

from tests.windev.samples import NATIVE, WINDOW, procedure_set, project_file


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.fixture
def task(tmp_path: Path):
    """A WinDev project committed on main, and a spec whose reviewer approved."""
    repo = tmp_path / "wt"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@example.test")
    _git(repo, "config", "user.name", "t")
    (repo / "Gestion.wdp").write_text(project_file(), encoding="utf-8")
    (repo / "COL_Clients.wdg").write_text(procedure_set(), encoding="utf-8")
    (repo / "FEN_Clients.wdw").write_text(WINDOW, encoding="utf-8")
    (repo / "Gestion.wda").write_bytes(NATIVE + b"\x00\x01")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "base")
    spec = tmp_path / "spec"
    spec.mkdir()
    (spec / "implementation_plan.json").write_text(
        json.dumps({"qa_signoff": {"status": "approved"}}), encoding="utf-8"
    )
    return repo, spec


def _run(repo: Path, spec: Path):
    scope = change_scope(repo, "main")
    return scope, windev_gate(spec, repo, 1, scope)


def test_a_change_inside_a_code_block_passes(task):
    repo, spec = task
    path = repo / "COL_Clients.wdg"
    path.write_text(
        path.read_text(encoding="utf-8").replace("0.1\n", "0.15\n"), encoding="utf-8"
    )
    scope, gate = _run(repo, spec)
    assert gate is None
    record = json.loads((spec / RECORD).read_text(encoding="utf-8"))
    assert record["status"] == "ok"
    assert record["checked"] == ["COL_Clients.wdg"]
    assert record["codeLinesChanged"] == 2
    # Only WinDev code changed: there is no coverage to demand.
    assert windev_only(scope)
    assert _coverage_gate(spec, 1, scope) is None


def test_an_invented_control_and_a_modified_binary_reject_the_pass(task):
    repo, spec = task
    window = repo / "FEN_Clients.wdw"
    window.write_text(
        window.read_text(encoding="utf-8").replace(
            "  -\n    name : SAI_Nom\n",
            "  -\n    name : SAI_Prenom\n"
            "    identifier : 0x24f4cd010a15ffff\n"
            "    internal_properties : InventedByAModel\n"
            "  -\n    name : SAI_Nom\n",
        ),
        encoding="utf-8",
    )
    (repo / "Gestion.wda").write_bytes(NATIVE + b"\x00\x02")
    (repo / "FEN_Nouvelle.wdw").write_text(WINDOW, encoding="utf-8")
    _, gate = _run(repo, spec)
    assert gate is not None
    issues, verdict = gate
    assert "WinDev" in verdict
    descriptions = " ".join(i["description"] for i in issues)
    assert "FEN_Clients.wdw" in descriptions
    assert "Gestion.wda: binary WinDev file modified" in descriptions
    assert "FEN_Nouvelle.wdw" in descriptions
    fix = (spec / "QA_FIX_REQUEST.md").read_text(encoding="utf-8")
    assert "git checkout" in fix and "-- Gestion.wda" in fix
    assert "À faire dans l'éditeur WinDev" in fix
    plan = json.loads((spec / "implementation_plan.json").read_text(encoding="utf-8"))
    assert plan["qa_signoff"]["status"] == "rejected"
    record = json.loads((spec / RECORD).read_text(encoding="utf-8"))
    assert record["status"] == "fail"
    assert {p["rule"] for p in record["problems"]} >= {
        "identifier-written",
        "internal_properties-written",
        "binary-element",
        "element-created",
    }


def test_a_change_without_windev_files_or_without_a_base_is_not_judged(task):
    repo, spec = task
    (repo / "notes.txt").write_text("x\n", encoding="utf-8")
    _, gate = _run(repo, spec)
    assert gate is None
    assert not (spec / RECORD).exists()
    unknown = ChangeScope("full", "unknown", files=("COL_Clients.wdg",), base="")
    assert windev_gate(spec, repo, 1, unknown) is None
    assert windev_gate(spec, repo, 1, None) is None
    assert not windev_only(None)


def test_a_path_outside_the_worktree_or_an_unknown_base_is_unchecked(task):
    repo, _ = task
    base = _git(repo, "rev-parse", "HEAD")
    changes, unreadable = windev_changes(
        repo, ("../outside.wdw", "COL_Clients.wdg", "COL_Clients.wdg.binary"), base
    )
    assert [c.path for c in changes] == ["COL_Clients.wdg"]
    assert unreadable == []
    changes, unreadable = windev_changes(repo, ("COL_Clients.wdg",), "0" * 40)
    assert changes == [] and unreadable == ["COL_Clients.wdg"]


def test_a_mixed_change_keeps_the_coverage_gate():
    scope = ChangeScope(
        "full", "test", files=("COL_Clients.wdg", "api/Service.cs"), base="abc"
    )
    assert not windev_only(scope)
    assert windev_only(ChangeScope("full", "t", files=("X.wdw.binary",), base="a"))
