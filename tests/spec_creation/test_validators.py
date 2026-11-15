"""The four checkpoints a spec passes, the report they print, and the
auto-fix that repairs a plan before they are asked again."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from spec.validate_pkg import SpecValidator, ValidationResult, auto_fix_plan
from spec.validate_pkg.auto_fix import _normalize_status, _repair_json_syntax


@pytest.fixture
def spec_dir(tmp_path: Path) -> Path:
    path = tmp_path / ".workpilot" / "specs" / "001-x"
    path.mkdir(parents=True)
    return path


def _plan(spec_dir: Path, plan) -> SpecValidator:
    text = plan if isinstance(plan, str) else json.dumps(plan)
    (spec_dir / "implementation_plan.json").write_text(text, encoding="utf-8")
    return SpecValidator(spec_dir)


def test_the_report_lists_errors_warnings_and_fixes() -> None:
    failing = ValidationResult(False, "plan", ["no phases"], ["short"], ["add one"])
    passing = ValidationResult(True, "spec", [], ["short"], ["never shown"])

    assert str(failing) == (
        "Checkpoint: plan\nStatus: FAIL\n\nErrors:\n  [X] no phases"
        "\n\nWarnings:\n  [!] short\n\nSuggested Fixes:\n  -> add one"
    )
    assert "Suggested Fixes" not in str(passing)
    assert str(passing).startswith("Checkpoint: spec\nStatus: PASS")


def test_prereqs(spec_dir: Path, tmp_path: Path) -> None:
    missing = SpecValidator(tmp_path / "nowhere").validate_prereqs()
    assert not missing.valid
    assert missing.fixes == [f"Create the directory {tmp_path / 'nowhere'}"]

    no_index = SpecValidator(spec_dir).validate_prereqs()
    assert no_index.errors == ["project_index.json not found"]
    assert "discovery phase" in no_index.fixes[0]

    (spec_dir.parents[1] / "project_index.json").write_text("{}", encoding="utf-8")
    elsewhere = SpecValidator(spec_dir).validate_prereqs()
    assert elsewhere.valid
    assert elsewhere.warnings == [
        "project_index.json exists in .workpilot/ but not in the spec folder"
    ]


def test_context(spec_dir: Path) -> None:
    validator = SpecValidator(spec_dir)
    assert "Write context.json" in validator.validate_context().fixes[0]

    (spec_dir / "context.json").write_text("{nope", encoding="utf-8")
    assert "invalid JSON" in validator.validate_context().errors[0]

    (spec_dir / "context.json").write_text('{"files_to_modify": []}', encoding="utf-8")
    result = validator.validate_context()
    assert result.errors == ["Missing required field: task_description"]
    assert len(result.warnings) == 3


def test_spec_document(spec_dir: Path) -> None:
    validator = SpecValidator(spec_dir)
    assert validator.validate_spec_document().errors == ["spec.md not found"]

    (spec_dir / "spec.md").write_text(
        "# Spec\n## Overview\nx\n## Workflow Type\nfeature\n## Task Scope\nx\n"
        "## Success Criteria\nx\n"
        "- Is it paged? [NEEDS CLARIFICATION: page size]\n"
        "- Sorted? [NEEDS CLARIFICATION: order]\n"
        "- Filtered? [NEEDS CLARIFICATION: filters]\n"
        "- Exported? [NEEDS CLARIFICATION: format]\n",
        encoding="utf-8",
    )
    result = validator.validate_spec_document()

    assert result.valid
    assert "spec.md seems too short (< 500 chars)" in result.warnings
    assert any("4 open question(s)" in w and "+1 more" in w for w in result.warnings)
    assert any("No FR-### requirement identifiers" in w for w in result.warnings)


def test_a_missing_or_unparseable_plan(spec_dir: Path) -> None:
    validator = SpecValidator(spec_dir)
    assert (
        "Write implementation_plan.json"
        in validator.validate_implementation_plan().fixes[0]
    )

    _plan(spec_dir, "{not json")
    result = validator.validate_implementation_plan()
    assert "invalid JSON" in result.errors[0]
    assert result.fixes == ["Rewrite implementation_plan.json as valid JSON"]


@pytest.mark.parametrize(
    ("plan", "error"),
    [
        (["a list"], "must contain a JSON object, not list"),
        (
            {"feature": "x", "workflow_type": "chore", "phases": []},
            "Invalid workflow_type: chore",
        ),
        (
            {"feature": "x", "workflow_type": "feature", "phases": []},
            "No phases defined",
        ),
        # Phases keyed by id: reported, not crashed on, so auto-fix can reshape it.
        (
            {
                "feature": "x",
                "workflow_type": "feature",
                "phases": {"1": {"name": "A"}},
            },
            "'phases' must be a list of phase objects, not dict",
        ),
        (
            {"feature": "x", "workflow_type": "feature", "phases": ["setup"]},
            "Phase 1: must be an object, not str",
        ),
        (
            {
                "feature": "x",
                "workflow_type": "feature",
                "phases": [{"id": "1", "name": "A", "subtasks": "all"}],
            },
            "Phase 1: 'subtasks' must be a list",
        ),
        (
            {
                "feature": "x",
                "workflow_type": "feature",
                "phases": [
                    {
                        "name": "A",
                        "subtasks": [
                            {"id": "1", "description": "d", "status": "pending"}
                        ],
                    }
                ],
            },
            "Phase 1: missing required field (need one of: phase, id)",
        ),
        (
            {
                "feature": "x",
                "workflow_type": "feature",
                "phases": [
                    {
                        "id": "1",
                        "name": "A",
                        "type": "party",
                        "subtasks": [
                            {"id": "1", "description": "d", "status": "pending"}
                        ],
                    }
                ],
            },
            "Phase 1: invalid type 'party'",
        ),
        (
            {
                "feature": "x",
                "workflow_type": "feature",
                "phases": [{"id": "1", "name": "A", "subtasks": ["write it"]}],
            },
            "Phase 1, Subtask 1: must be an object, not str",
        ),
        (
            {
                "feature": "x",
                "workflow_type": "feature",
                "phases": [
                    {
                        "id": "1",
                        "name": "A",
                        "subtasks": [
                            {"id": "1", "description": "d", "status": "doing"}
                        ],
                    }
                ],
            },
            "Phase 1, Subtask 1: invalid status 'doing'",
        ),
        (
            {
                "feature": "x",
                "workflow_type": "feature",
                "phases": [
                    {
                        "id": "1",
                        "name": "A",
                        "subtasks": [
                            {
                                "id": "1",
                                "description": "d",
                                "status": "pending",
                                "verification": "run it",
                            }
                        ],
                    }
                ],
            },
            "Phase 1, Subtask 1: verification must be an object",
        ),
        (
            {
                "feature": "x",
                "workflow_type": "feature",
                "phases": [
                    {
                        "id": "1",
                        "name": "A",
                        "subtasks": [
                            {
                                "id": "1",
                                "description": "d",
                                "status": "pending",
                                "verification": {},
                            }
                        ],
                    }
                ],
            },
            "Phase 1, Subtask 1: verification missing 'type'",
        ),
        (
            {
                "feature": "x",
                "workflow_type": "feature",
                "phases": [
                    {
                        "id": "1",
                        "name": "A",
                        "subtasks": [
                            {
                                "id": "1",
                                "description": "d",
                                "status": "pending",
                                "verification": {"type": "vibes"},
                            }
                        ],
                    }
                ],
            },
            "Phase 1, Subtask 1: invalid verification type 'vibes'",
        ),
        (
            {
                "feature": "x",
                "workflow_type": "feature",
                "phases": [
                    {
                        "id": "1",
                        "name": "A",
                        "depends_on": ["2"],
                        "subtasks": [
                            {"id": "1", "description": "d", "status": "pending"}
                        ],
                    },
                    {"id": "2", "name": "B", "depends_on": ["9"], "subtasks": []},
                ],
            },
            "Phase 1: cannot depend on phase 2 (would create cycle)",
        ),
    ],
)
def test_plan_errors(spec_dir: Path, plan, error: str) -> None:
    result = _plan(spec_dir, plan).validate_implementation_plan()

    assert not result.valid
    assert any(error in e for e in result.errors), result.errors


def test_requirement_coverage_is_a_warning(spec_dir: Path) -> None:
    (spec_dir / "spec.md").write_text(
        "## Requirements\n- FR-001: export\n- FR-002: import\n", encoding="utf-8"
    )
    plan = {
        "feature": "x",
        "workflow_type": "feature",
        "phases": [
            {
                "id": "1",
                "name": "A",
                "subtasks": [
                    {
                        "id": "1.1",
                        "description": "d",
                        "status": "pending",
                        "requirements": ["FR-001", "FR-009"],
                    }
                ],
            }
        ],
    }

    result = _plan(spec_dir, plan).validate_implementation_plan()

    assert result.valid
    assert "1 requirement(s) claimed by no subtask: FR-002" in result.warnings
    assert (
        "Subtask(s) 1.1 reference 'FR-009', which spec.md does not declare"
        in result.warnings
    )


def test_an_unreadable_spec_skips_the_coverage(spec_dir: Path, monkeypatch) -> None:
    (spec_dir / "spec.md").write_text(
        "## Requirements\n- FR-001: x\n", encoding="utf-8"
    )
    validator = _plan(
        spec_dir, {"feature": "x", "workflow_type": "feature", "phases": []}
    )
    original = Path.read_text

    def read(self, *args, **kwargs):
        if self.name == "spec.md":
            raise OSError("locked")
        return original(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read)

    assert validator.validate_implementation_plan().warnings == []


def test_validate_all_runs_the_four_checkpoints(spec_dir: Path) -> None:
    results = SpecValidator(spec_dir).validate_all()

    assert [r.checkpoint for r in results] == ["prereqs", "context", "spec", "plan"]


# --- auto-fix ---------------------------------------------------------------


def test_json_repair() -> None:
    assert _repair_json_syntax("") is None
    assert _repair_json_syntax("x" * (1024 * 1024 + 1)) is None
    assert json.loads(_repair_json_syntax('{"a": [1, 2,],}')) == {"a": [1, 2]}
    assert json.loads(_repair_json_syntax('{"status": pending}')) == {
        "status": "pending"
    }
    truncated = (
        '{"phases": [{"name": "A", "subtasks": [{"id": "1", "description": "half'
    )
    assert json.loads(_repair_json_syntax(truncated))["phases"][0]["name"] == "A"
    # A number cut after its dot loses the dot; a whole number is kept.
    assert json.loads(_repair_json_syntax('{"a": {"b": 1.')) == {"a": {"b": 1}}
    assert json.loads(_repair_json_syntax('{"phase": 2')) == {"phase": 2}
    assert json.loads(_repair_json_syntax('{"a": 1, "b')) == {"a": 1}
    assert _repair_json_syntax("not json at all {") is None


@pytest.mark.parametrize(
    ("value", "status"),
    [
        (None, "pending"),
        (" Completed ", "completed"),
        ("todo", "pending"),
        ("in-progress", "in_progress"),
        ("done", "completed"),
        ("someday", "pending"),
    ],
)
def test_status_normalization(value, status) -> None:
    assert _normalize_status(value) == status


def test_auto_fix_fills_in_what_the_schema_needs(spec_dir: Path) -> None:
    plan = {
        "title": "Export",
        "phases": [
            {
                "title": "Setup",
                "phase_id": "2",
                "depends_on": [],
                "chunks": [{"description": "a"}],
                "subtasks": [],
            },
            {
                "phase_id": 3.0,
                "depends_on": "2",
                "subtasks": [{"id": "x", "description": "b", "status": "done"}],
            },
            {
                "phase_id": "setup-db",
                "depends_on": None,
                "subtasks": [{"id": "y", "description": "c", "status": "pending"}],
            },
            {
                "phase_id": 7,
                "id": "seven",
                "subtasks": [{"id": "z", "description": "d"}],
            },
        ],
    }
    validator = _plan(spec_dir, plan)

    assert auto_fix_plan(spec_dir) is True

    fixed = json.loads((spec_dir / "implementation_plan.json").read_text("utf-8"))
    assert fixed["feature"] == "Export"
    assert fixed["workflow_type"] == "feature"
    first, second, third, fourth = fixed["phases"]
    assert (first["name"], first["phase"], first["id"]) == ("Setup", 2, "2")
    assert first["subtasks"][0]["id"] == "subtask-1-1"
    assert second["phase"] == 3 and second["depends_on"] == ["2"]
    assert second["subtasks"][0]["status"] == "completed"
    assert (
        third["id"] == "setup-db" and third["depends_on"] == [] and third["phase"] == 3
    )
    assert fourth["phase"] == 7 and fourth["id"] == "seven"
    assert fourth["subtasks"][0]["status"] == "pending"
    assert validator.validate_implementation_plan().valid


def test_auto_fix_without_a_plan_or_with_nothing_to_fix(spec_dir: Path) -> None:
    assert auto_fix_plan(spec_dir) is False
    _plan(
        spec_dir,
        {
            "feature": "x",
            "workflow_type": "feature",
            "phases": [
                {
                    "phase": 1,
                    "name": "A",
                    "depends_on": [],
                    "subtasks": [{"id": "1", "description": "d", "status": "pending"}],
                }
            ],
        },
    )
    assert auto_fix_plan(spec_dir) is False
    _plan(spec_dir, '"just a string"')
    assert auto_fix_plan(spec_dir) is False
    (spec_dir / "implementation_plan.json").write_bytes(b"\xff\xfe")
    assert auto_fix_plan(spec_dir) is False
    _plan(spec_dir, "{{{{ nothing here")
    assert auto_fix_plan(spec_dir) is False


def test_auto_fix_reads_a_fenced_or_truncated_plan(spec_dir: Path) -> None:
    body = json.dumps(
        {
            "feature": "x",
            "workflow_type": "feature",
            "phases": [
                {
                    "phase": 1,
                    "name": "A",
                    "depends_on": [],
                    "subtasks": [{"id": "1", "description": "d", "status": "pending"}],
                }
            ],
        }
    )
    _plan(spec_dir, f"Here is the plan:\n```json\n{body}\n```")
    assert auto_fix_plan(spec_dir) is True
    assert (
        json.loads((spec_dir / "implementation_plan.json").read_text("utf-8"))[
            "feature"
        ]
        == "x"
    )

    _plan(spec_dir, body.replace('"pending"}', '"pending"},', 1))
    assert auto_fix_plan(spec_dir) is True


def test_auto_fix_reshapes_a_flat_task_list(spec_dir: Path) -> None:
    _plan(spec_dir, {"tasks": ["Write the exporter", "Add the button"]})

    assert auto_fix_plan(spec_dir) is True
    assert SpecValidator(spec_dir).validate_implementation_plan().valid


def test_auto_fix_that_cannot_write_reports_no_fix(spec_dir: Path, monkeypatch) -> None:
    from spec.validate_pkg import auto_fix

    _plan(spec_dir, {"phases": [{"name": "A", "subtasks": [{"description": "d"}]}]})

    def refuse(*args, **kwargs):
        raise OSError("read-only")

    monkeypatch.setattr(auto_fix, "write_json_atomic", refuse)

    assert auto_fix_plan(spec_dir) is False


def test_a_phase_without_its_name_is_reported(spec_dir: Path) -> None:
    plan = {
        "feature": "x",
        "workflow_type": "feature",
        "phases": [
            {
                "id": "1",
                "subtasks": [{"id": "1", "description": "d", "status": "pending"}],
            }
        ],
    }

    errors = _plan(spec_dir, plan).validate_implementation_plan().errors

    assert errors == ["Phase 1: missing required field 'name'"]


def test_auto_fix_takes_legacy_chunks_and_fills_descriptions(spec_dir: Path) -> None:
    _plan(
        spec_dir,
        {
            "feature": "x",
            "workflow_type": "feature",
            "phases": [
                {
                    "phase": 1,
                    "name": "A",
                    "depends_on": [],
                    "subtasks": [],
                    "chunks": [{"id": "c1", "status": "pending"}],
                },
                {
                    "phase": 2,
                    "name": "B",
                    "depends_on": [],
                    "subtasks": [{"id": "s1", "status": "pending"}],
                },
            ],
        },
    )

    assert auto_fix_plan(spec_dir) is True

    fixed = json.loads((spec_dir / "implementation_plan.json").read_text("utf-8"))
    assert fixed["phases"][0]["subtasks"][0]["id"] == "c1"
    assert fixed["phases"][1]["subtasks"][0]["description"] == "No description"
