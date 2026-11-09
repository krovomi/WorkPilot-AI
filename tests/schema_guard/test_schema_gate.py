"""The schema guard in the QA loop and as the hard gate `migration-safe` (#386).

By default it warns: the record and the log say what a live database would
not survive, and the approval stands. ``strict`` (or a workflow declaring
`migration-safe`) sends an error back to the fixer with the expand/contract
plan. A migration that existed before the task and was changed is an error;
an absent or switched-off guard is never a pass.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from foundation.change_scope import ChangeScope
from qa.schema_gate import SCHEMA_GUARD_ENV, render_fix_request, schema_gate
from schema_guard import check, load_record
from workflows.engine import resolve_profile
from workflows.hard_gates import MIGRATION_SAFE
from workflows.spec import load_workflow

from workflows import evaluate_hard_gates

REPO_ROOT = Path(__file__).resolve().parents[2]
OLD = "prisma/migrations/20261101_init/migration.sql"
NEW = "prisma/migrations/20261109_role/migration.sql"


@pytest.fixture(autouse=True)
def default_mode(monkeypatch):
    monkeypatch.delenv(SCHEMA_GUARD_ENV, raising=False)


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


def _write(repo: Path, relative: str, text: str) -> None:
    (repo / relative).parent.mkdir(parents=True, exist_ok=True)
    (repo / relative).write_text(text, encoding="utf-8")


@pytest.fixture
def task(tmp_path):
    """A Prisma project whose task adds a NOT NULL column and edits the first migration."""
    repo = tmp_path / "wt"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@example.test")
    _git(repo, "config", "user.name", "t")
    _write(
        repo, "prisma/schema.prisma", 'datasource db {\n  provider = "postgresql"\n}\n'
    )
    _write(repo, OLD, 'CREATE TABLE "User" ("id" SERIAL NOT NULL);\n')
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "base")
    base = _git(repo, "rev-parse", "HEAD")
    _write(repo, NEW, 'ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL;\n')
    _write(repo, OLD, 'CREATE TABLE "User" ("id" SERIAL NOT NULL, "x" INT);\n')
    _write(repo, "src/app.ts", "export {}\n")
    spec = tmp_path / "spec"
    spec.mkdir()
    (spec / "implementation_plan.json").write_text(
        json.dumps({"qa_signoff": {"status": "approved"}}), encoding="utf-8"
    )
    scope = ChangeScope("full", "test", files=(NEW, OLD, "src/app.ts"), base=base)
    return repo, spec, scope


def _migration_gate(spec: Path, tmp_path: Path):
    source = REPO_ROOT / "workflows" / "feature-build" / "workflow.yaml"
    text = source.read_text(encoding="utf-8").replace(
        "deps-exist,proof-checks", "deps-exist,proof-checks,migration-safe"
    )
    target = tmp_path / "wf" / "workflow.yaml"
    target.parent.mkdir(exist_ok=True)
    target.write_text(text, encoding="utf-8")
    report = evaluate_hard_gates(resolve_profile(load_workflow(target), "medium"), spec)
    return next(r for r in report.results if r.gate == MIGRATION_SAFE)


def test_by_default_it_warns_and_the_approval_stands(task, tmp_path):
    repo, spec, scope = task

    assert schema_gate(spec, repo, 1, scope) is None

    record = load_record(spec)
    assert record["status"] == "fail" and record["engine"] == "postgres"
    assert {m["path"]: m["new"] for m in record["migrations"]} == {
        NEW: True,
        OLD: False,
    }
    kinds = sorted((f["kind"], f["path"]) for f in record["findings"])
    assert kinds == [("edited", OLD), ("not_null", NEW)]
    assert record["plan"][0].startswith("Expand:")
    assert not (spec / "QA_FIX_REQUEST.md").exists()
    held = _migration_gate(spec, tmp_path)
    assert held.held is False and f"{NEW}:1" in held.detail


def test_strict_sends_the_fixer_back_with_the_plan(task, monkeypatch):
    repo, spec, scope = task
    monkeypatch.setenv(SCHEMA_GUARD_ENV, "strict")

    gate = schema_gate(spec, repo, 3, scope)

    assert gate is not None
    issues, verdict = gate
    assert "pass #3" in verdict
    assert {i["type"] for i in issues} == {"unsafe_migration"}
    fix = (spec / "QA_FIX_REQUEST.md").read_text(encoding="utf-8")
    assert f"`{NEW}:1` adds a NOT NULL column" in fix
    assert "changes a migration that existed before the task" in fix
    assert "Do not" in fix and "edit a migration that existed" in fix
    # The statement is quoted from the repository: fenced as data.
    statement = fix.index('ADD COLUMN "role"')
    assert "<user_content>" in fix[:statement] and "</user_content>" in fix[statement:]
    plan = json.loads((spec / "implementation_plan.json").read_text(encoding="utf-8"))
    assert plan["qa_signoff"]["status"] == "rejected"


def test_a_safe_migration_holds_the_gate(task, tmp_path, monkeypatch):
    repo, spec, scope = task
    monkeypatch.setenv(SCHEMA_GUARD_ENV, "strict")
    _write(repo, NEW, 'ALTER TABLE "User" ADD COLUMN "role" TEXT;\n')
    safe = ChangeScope("full", "test", files=(NEW,), base=scope.base)

    assert schema_gate(spec, repo, 1, safe) is None

    held = _migration_gate(spec, tmp_path)
    assert held.held is True and held.detail == "1 migration(s) checked"


def test_no_migration_in_the_change_set_holds(task, tmp_path):
    repo, spec, scope = task
    none = ChangeScope("full", "test", files=("src/app.ts",), base=scope.base)

    assert schema_gate(spec, repo, 1, none) is None

    held = _migration_gate(spec, tmp_path)
    assert held.held is True and held.detail == "no migration in the change set"


def test_off_or_an_unknown_change_set_is_unknown(task, tmp_path, monkeypatch):
    repo, spec, scope = task
    assert schema_gate(spec, repo, 1, ChangeScope("full", "unavailable")) is None
    assert _migration_gate(spec, tmp_path).held is None

    monkeypatch.setenv(SCHEMA_GUARD_ENV, "off")
    assert schema_gate(spec, repo, 1, scope) is None
    held = _migration_gate(spec, tmp_path)
    assert held.held is None and SCHEMA_GUARD_ENV in held.detail


def test_a_typo_reads_as_warn(task, monkeypatch):
    repo, spec, scope = task
    monkeypatch.setenv(SCHEMA_GUARD_ENV, "sctrict")
    assert schema_gate(spec, repo, 1, scope) is None
    assert load_record(spec)["mode"] == "warn"


def test_without_a_record_the_gate_is_unknown(tmp_path):
    held = _migration_gate(tmp_path / "nothing", tmp_path)
    assert held.held is None and "did not run" in held.detail


def test_a_deleted_migration_is_an_edit(task):
    repo, _, scope = task
    (repo / OLD).unlink()
    report = check(repo, [OLD], scope.base)
    assert [(f.kind, f.message) for f in report.findings] == [
        ("edited", "deletes a migration that existed before the task")
    ]


@pytest.mark.skipif(not hasattr(Path, "symlink_to"), reason="no symlinks")
def test_a_linked_or_outside_path_is_not_read(task, tmp_path):
    repo, _, scope = task
    outside = tmp_path / "outside.sql"
    outside.write_text("DROP TABLE users;", encoding="utf-8")
    link = repo / "db" / "migrations" / "1_x.sql"
    link.parent.mkdir(parents=True)
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlinks need privileges here")
    report = check(repo, ["db/migrations/1_x.sql", "../outside.sql"], scope.base)
    assert report.findings == []


def test_the_fix_request_lists_warnings_apart(task):
    repo, _, scope = task
    _write(
        repo,
        NEW,
        'ALTER TABLE "User" DROP COLUMN "x";\nCREATE INDEX "i" ON "User"("id");\n',
    )
    report = check(repo, [NEW], scope.base)
    text = render_fix_request(report)
    blocking, rest = text.split("## Also worth fixing (not blocking)")
    assert "drops a column" in blocking and "CONCURRENTLY" in rest
