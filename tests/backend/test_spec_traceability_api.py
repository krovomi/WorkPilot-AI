"""The endpoint the Kanban reads open questions and coverage from.

It recomputes rather than reading back the `traceability.json` a build wrote,
and the tests below pin that: the panel is opened on tasks that have never
been planned, where the file does not exist and the answer still has to be
right.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from spec.api import router  # noqa: E402

SPEC = """# Specification: Export

## Requirements

### Functional Requirements

1. **FR-001 — List** [NEEDS CLARIFICATION: paginated or not?]
   - Acceptance: 200
2. **FR-002 — Export**
   - Acceptance: a file
"""

PLAN = {
    "feature": "Export",
    "workflow_type": "feature",
    "phases": [
        {
            "id": "phase-1",
            "name": "Backend",
            "subtasks": [
                {
                    "id": "subtask-1-1",
                    "description": "List",
                    "status": "pending",
                    "requirements": ["FR-001"],
                }
            ],
        }
    ],
}


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


@pytest.fixture
def project(tmp_path):
    spec_dir = tmp_path / ".workpilot" / "specs" / "001-export"
    spec_dir.mkdir(parents=True)
    (spec_dir / "spec.md").write_text(SPEC, encoding="utf-8")
    return tmp_path, spec_dir


def _get(client, **params):
    return client.get("/api/spec-traceability/", params=params).json()


class TestAddressing:
    def test_the_pair_names_the_spec_directory(self, client, project):
        root, _ = project
        body = _get(client, project_dir=str(root), spec_id="001-export")
        assert body["success"] is True
        assert body["traceability"]["spec"] == "001-export"

    def test_an_explicit_spec_directory_works_too(self, client, project):
        _, spec_dir = project
        body = _get(client, spec_dir=str(spec_dir))
        assert body["success"] is True

    def test_neither_is_refused_by_name(self, client):
        body = _get(client)
        assert body["success"] is False
        assert body["reason"] == "addressing"

    def test_a_spec_id_that_is_a_path_is_refused(self, client, project):
        root, _ = project
        body = _get(client, project_dir=str(root), spec_id="../../etc")
        assert body["success"] is False
        assert body["reason"] in ("spec_id", "traversal")

    def test_the_error_never_echoes_a_filesystem_path(self, client, project):
        root, _ = project
        body = _get(client, project_dir=str(root), spec_id="no-such-spec")
        assert body["success"] is False
        assert str(root) not in json.dumps(body)


class TestAnswer:
    def test_open_questions_are_reported_before_any_plan_exists(self, client, project):
        """The case the file cannot cover: a task nobody has planned yet."""
        root, spec_dir = project
        assert not (spec_dir / "implementation_plan.json").exists()

        body = _get(client, project_dir=str(root), spec_id="001-export")
        questions = body["traceability"]["open_questions"]
        assert [q["question"] for q in questions] == ["paginated or not?"]
        assert body["traceability"]["coverage"]["applicable"] is False

    def test_coverage_appears_once_there_is_a_plan(self, client, project):
        root, spec_dir = project
        (spec_dir / "implementation_plan.json").write_text(
            json.dumps(PLAN), encoding="utf-8"
        )

        coverage = _get(client, project_dir=str(root), spec_id="001-export")[
            "traceability"
        ]["coverage"]
        assert coverage["applicable"] is True
        assert coverage["uncovered"] == ["FR-002"]
        assert coverage["percent"] == 50.0

    def test_it_answers_from_disk_not_from_the_written_record(self, client, project):
        """A stale `traceability.json` must not be what the panel shows."""
        root, spec_dir = project
        (spec_dir / "traceability.json").write_text(
            json.dumps({"spec": "stale", "requirements": [], "open_questions": []}),
            encoding="utf-8",
        )

        body = _get(client, project_dir=str(root), spec_id="001-export")
        assert body["traceability"]["spec"] == "001-export"
        assert len(body["traceability"]["open_questions"]) == 1
