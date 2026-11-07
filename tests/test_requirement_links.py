"""Requirement → subtask → files → tests, kept after the task (prospective P3).

Each test pins a rule:

* a requirement's files are the ones its subtasks' sessions wrote (Agent
  Trace), restricted to the task's diff; without records, the plan's declared
  files, and the links say so;
* its tests are the ones the repository's conventions point to, plus the test
  files it wrote, and a file without a test is listed as untested;
* a spec without requirement ids gives no links rather than empty ones;
* the links are kept beside the spec and in the project's ledger, never
  through a link, and the ledger answers which earlier requirements touched
  the same files;
* the traceability route serves them, read back, with the earlier ones.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from requirement_trace import (  # noqa: E402
    LEDGER_DIR,
    LINKS_FILE,
    compute_links,
    earlier_requirements,
    write_links,
)

SPEC = """# Orders

## Functional requirements

- **FR-001**: List the orders
- **FR-002**: Export the orders
- **FR-003**: Archive an order
"""

PLAN = {
    "phases": [
        {
            "subtasks": [
                {
                    "id": "s1",
                    "requirements": ["FR-001"],
                    "files_to_modify": ["src/orders.py"],
                },
                {
                    "id": "s2",
                    "requirements": "FR-002",
                    "files_to_create": ["src/export.ts"],
                },
            ]
        }
    ]
}


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(  # noqa: S603 - fixed argv
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
    )


def _record(subtask: str, *paths: str) -> str:
    return json.dumps(
        {
            "files": [{"path": p} for p in paths],
            "metadata": {"ai.workpilot": {"subtask_id": subtask}},
        }
    )


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "project"
    for rel in ("src/orders.py", "tests/test_orders.py", "src/export.ts", "README.md"):
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("x\n", encoding="utf-8")
    (root / ".gitignore").write_text(".workpilot/\n", encoding="utf-8")
    _git(root, "init", "-q")
    _git(root, "add", ".")
    _git(root, "commit", "-q", "-m", "one")
    spec = root / ".workpilot" / "specs" / "001-orders"
    spec.mkdir(parents=True)
    (spec / "spec.md").write_text(SPEC, encoding="utf-8")
    (spec / "implementation_plan.json").write_text(json.dumps(PLAN), encoding="utf-8")
    return root, spec


def _with_records(spec: Path) -> None:
    (spec / "agent-trace.jsonl").write_text(
        "\n".join(
            [
                _record("s1", "src/orders.py", "tests/test_orders.py"),
                _record("s2", "src/export.ts", "README.md"),
                "not json",
            ]
        )
        + "\n",
        encoding="utf-8",
    )


def _by_id(links: dict) -> dict:
    return {r["id"]: r for r in links["requirements"]}


class TestLinks:
    def test_files_from_the_sessions_tests_from_the_conventions(self, project):
        root, spec = project
        _with_records(spec)
        links = compute_links(root, [spec])
        assert links["source"] == "agent-trace"
        reqs = _by_id(links)
        assert reqs["FR-001"]["subtasks"] == ["s1"]
        assert reqs["FR-001"]["files"] == ["src/orders.py", "tests/test_orders.py"]
        assert reqs["FR-001"]["tests"] == ["tests/test_orders.py"]
        assert reqs["FR-001"]["untested"] == []
        assert reqs["FR-002"]["tests"] == []
        # A README is not code a convention maps: not called untested.
        assert reqs["FR-002"]["untested"] == ["src/export.ts"]
        assert reqs["FR-003"] == {
            "id": "FR-003",
            "title": "Archive an order",
            "subtasks": [],
            "files": [],
            "tests": [],
            "untested": [],
        }

    def test_restricted_to_the_task_diff(self, project):
        root, spec = project
        _with_records(spec)
        links = compute_links(root, [spec], changed_files=["src/export.ts"])
        reqs = _by_id(links)
        assert reqs["FR-001"]["files"] == []
        assert reqs["FR-002"]["files"] == ["src/export.ts"]

    def test_without_records_the_plan_says_so(self, project):
        root, spec = project
        links = compute_links(root, [spec])
        assert links["source"] == "plan"
        assert _by_id(links)["FR-001"]["files"] == ["src/orders.py"]
        assert _by_id(links)["FR-001"]["tests"] == ["tests/test_orders.py"]

    def test_no_requirement_id_no_links(self, project):
        root, spec = project
        (spec / "spec.md").write_text("# Orders\n\n1. List them\n", encoding="utf-8")
        assert compute_links(root, [spec]) is None
        assert compute_links(root, [root / "nowhere"]) is None


class TestLedger:
    def test_kept_beside_the_spec_and_in_the_ledger(self, project, tmp_path):
        root, spec = project
        _with_records(spec)
        worktree_copy = tmp_path / "worktree-spec"
        worktree_copy.mkdir()
        links = write_links(root, [worktree_copy, spec], root)
        assert links is not None
        assert (worktree_copy / LINKS_FILE).is_file() and (spec / LINKS_FILE).is_file()
        # The ledger keeps the spec that has spec.md: the project's copy here.
        assert (root / LEDGER_DIR / "001-orders.json").is_file()

        other = root / LEDGER_DIR / "002-archive.json"
        other.write_text(
            json.dumps(
                {
                    "spec": "002-archive",
                    "requirements": [
                        {
                            "id": "FR-001",
                            "title": "Archive",
                            "files": ["src/orders.py", "src/archive.py"],
                            "tests": ["tests/test_orders.py"],
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        found = earlier_requirements(root, ["src/orders.py", "src/x.py"], "001-orders")
        assert found == [
            {
                "spec": "002-archive",
                "id": "FR-001",
                "title": "Archive",
                "files": ["src/orders.py"],
                "tests": ["tests/test_orders.py"],
            }
        ]
        assert earlier_requirements(root, [], "001-orders") == []

    def test_never_written_through_a_link(self, project, tmp_path):
        root, spec = project
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        (root / LEDGER_DIR.parent).mkdir(exist_ok=True)
        (root / LEDGER_DIR).symlink_to(elsewhere, target_is_directory=True)
        assert write_links(root, [spec], root) is None
        assert list(elsewhere.iterdir()) == []
        assert earlier_requirements(root, ["src/orders.py"]) == []


def test_the_route_serves_the_links_and_the_earlier_ones(project):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from spec.api import router

    root, spec = project
    _with_records(spec)
    write_links(root, [spec], root)
    (root / LEDGER_DIR / "000-first.json").write_text(
        json.dumps(
            {
                "spec": "000-first",
                "requirements": [{"id": "FR-009", "files": ["src/export.ts"]}],
            }
        ),
        encoding="utf-8",
    )
    app = FastAPI()
    app.include_router(router)
    body = (
        TestClient(app)
        .get(
            "/api/spec-traceability/",
            params={"project_dir": str(root), "spec_id": "001-orders"},
        )
        .json()
    )
    links = body["traceability"]["links"]
    assert _by_id(links)["FR-001"]["tests"] == ["tests/test_orders.py"]
    assert [(e["spec"], e["id"]) for e in links["earlier"]] == [("000-first", "FR-009")]

    (spec / LINKS_FILE).unlink()
    body = (
        TestClient(app)
        .get(
            "/api/spec-traceability/",
            params={"project_dir": str(root), "spec_id": "001-orders"},
        )
        .json()
    )
    assert body["traceability"]["links"] is None
