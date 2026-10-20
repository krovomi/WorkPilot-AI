"""Requirement identity, open questions, and plan coverage.

The three signals this covers did not exist before: a requirement had no name
that survived reordering, a guess left no trace, and nothing could say which
requirement no subtask had claimed. The tests that matter most here are the
ones asserting what stays *silent* — a spec written before identifiers existed
must not start emitting warnings on every build, or the new signals become
noise on the way to being ignored.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from spec.traceability import (  # noqa: E402
    compute_coverage,
    parse_open_questions,
    parse_requirements,
    plan_requirement_refs,
)
from spec.validate_pkg.validators.implementation_plan_validator import (  # noqa: E402
    ImplementationPlanValidator,
)
from spec.validate_pkg.validators.spec_document_validator import (  # noqa: E402
    SpecDocumentValidator,
)

SPEC = """# Specification: Export widgets

## Overview

Widgets can be exported.

## Workflow Type

**Type**: feature

## Task Scope

### This Task Will:
- Add an export endpoint

## Requirements

### Functional Requirements

1. **FR-001 — List widgets**
   - Description: return every widget
   - Acceptance: 200 with a JSON array

2. **FR-002**: Export widgets
   - Description: download the list [NEEDS CLARIFICATION: CSV or XLSX?]
   - Acceptance: a file comes back

- NFR-001 - Responds in under 200 ms

### Edge Cases

1. **No widgets** - empty file [NEEDS CLARIFICATION]

## Success Criteria

1. [ ] (FR-001) the list endpoint answers
2. [ ] (FR-002) the export endpoint answers
"""

LEGACY_SPEC = """# Specification: Older task

## Overview

Written before requirement identifiers existed.

## Workflow Type

**Type**: feature

## Task Scope

### This Task Will:
- Change a label

## Requirements

### Functional Requirements

1. **Change the label**
   - Description: the button says Export
   - Acceptance: it says Export

## Success Criteria

1. [ ] The button says Export
"""


def _plan(**overrides) -> dict:
    plan = {
        "feature": "Export widgets",
        "workflow_type": "feature",
        "phases": [
            {
                "id": "phase-1",
                "name": "Backend",
                "type": "implementation",
                "subtasks": [
                    {
                        "id": "subtask-1-1",
                        "description": "List endpoint",
                        "status": "pending",
                        "requirements": ["FR-001"],
                    },
                    {
                        "id": "subtask-1-2",
                        "description": "Export endpoint",
                        "status": "pending",
                        "requirements": ["FR-002", "NFR-001"],
                    },
                ],
            }
        ],
    }
    plan.update(overrides)
    return plan


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------


def test_requirements_are_read_in_every_shape_a_model_writes():
    ids = [req.id for req in parse_requirements(SPEC)]
    assert ids == ["FR-001", "FR-002", "NFR-001"]

    titles = {req.id: req.title for req in parse_requirements(SPEC)}
    assert titles["FR-001"] == "List widgets"
    assert titles["FR-002"] == "Export widgets"
    assert titles["NFR-001"] == "Responds in under 200 ms"


def test_a_mention_is_not_a_second_declaration():
    """`(FR-001)` in Success Criteria refers to the requirement above it."""
    declarations = parse_requirements(SPEC)
    assert len(declarations) == 3
    # The declaration kept is the one in the Requirements section, not the
    # later reference in Success Criteria.
    assert declarations[0].line < SPEC.index("## Success Criteria")


def test_repeated_declaration_keeps_the_first():
    spec = "- **FR-001** — first\n\n## Later\n\n- **FR-001** — restated\n"
    (only,) = parse_requirements(spec)
    assert only.title == "first"
    assert only.line == 1


def test_open_questions_carry_their_section_and_survive_a_missing_question():
    questions = parse_open_questions(SPEC)
    assert len(questions) == 2

    first, second = questions
    assert first.question == "CSV or XLSX?"
    assert first.section == "Functional Requirements"
    assert second.question == ""
    assert second.section == "Edge Cases"
    assert "unspecified" in second.describe()


def test_a_spec_with_nothing_open_reports_nothing():
    assert parse_open_questions(LEGACY_SPEC) == []


def test_plan_refs_accept_a_string_and_inherit_from_the_phase():
    plan = {
        "phases": [
            {
                "id": "phase-1",
                "requirements": ["FR-003"],
                "subtasks": [
                    {"id": "a", "requirements": "FR-001, FR-002"},
                    {"id": "b"},  # inherits the phase's
                ],
            }
        ]
    }
    refs = plan_requirement_refs(plan)
    assert refs["a"] == ("FR-001", "FR-002")
    assert refs["b"] == ("FR-003",)


# --------------------------------------------------------------------------
# Coverage
# --------------------------------------------------------------------------


def test_full_coverage():
    coverage = compute_coverage(SPEC, _plan())
    assert coverage.applicable
    assert coverage.uncovered == ()
    assert coverage.unknown_refs == {}
    assert coverage.percent == 100.0


def test_a_requirement_no_subtask_claims_is_named():
    plan = _plan()
    plan["phases"][0]["subtasks"][1]["requirements"] = ["FR-002"]
    coverage = compute_coverage(SPEC, plan)

    assert coverage.uncovered == ("NFR-001",)
    assert coverage.percent == 66.7
    assert "2/3" in coverage.summary()


def test_a_reference_the_spec_does_not_declare_is_drift():
    plan = _plan()
    plan["phases"][0]["subtasks"][0]["requirements"] = ["FR-009"]
    coverage = compute_coverage(SPEC, plan)

    assert coverage.unknown_refs == {"FR-009": ("subtask-1-1",)}
    assert "FR-001" in coverage.uncovered


def test_coverage_is_not_applicable_rather_than_zero():
    """A spec with no ids is not a spec with 0% coverage."""
    assert compute_coverage(LEGACY_SPEC, _plan()).applicable is False
    assert compute_coverage(SPEC, None).applicable is False

    plan = _plan()
    for subtask in plan["phases"][0]["subtasks"]:
        subtask.pop("requirements")
    silent = compute_coverage(SPEC, plan)
    assert silent.applicable is False
    assert "no subtask references" in silent.reason


# --------------------------------------------------------------------------
# Validators
# --------------------------------------------------------------------------


def _spec_dir(tmp_path: Path, spec: str, plan: dict | None) -> Path:
    (tmp_path / "spec.md").write_text(spec, encoding="utf-8")
    if plan is not None:
        (tmp_path / "implementation_plan.json").write_text(
            json.dumps(plan), encoding="utf-8"
        )
    return tmp_path


def test_spec_validator_reports_open_questions_without_failing(tmp_path):
    result = SpecDocumentValidator(_spec_dir(tmp_path, SPEC, None)).validate()

    assert result.valid, result.errors
    assert any("2 open question(s)" in w for w in result.warnings)
    assert any("CSV or XLSX?" in w for w in result.warnings)


def test_spec_validator_says_when_requirements_cannot_be_referenced(tmp_path):
    result = SpecDocumentValidator(_spec_dir(tmp_path, LEGACY_SPEC, None)).validate()

    assert result.valid, result.errors
    assert any("No FR-### requirement identifiers" in w for w in result.warnings)


def test_plan_validator_names_the_unclaimed_requirement(tmp_path):
    plan = _plan()
    plan["phases"][0]["subtasks"][1]["requirements"] = ["FR-002"]
    result = ImplementationPlanValidator(_spec_dir(tmp_path, SPEC, plan)).validate()

    assert result.valid, result.errors
    assert any("NFR-001" in w for w in result.warnings)


def test_plan_validator_is_silent_on_a_legacy_spec(tmp_path):
    """The signal must cost nothing to projects that predate it."""
    plan = _plan()
    for subtask in plan["phases"][0]["subtasks"]:
        subtask.pop("requirements")
    result = ImplementationPlanValidator(
        _spec_dir(tmp_path, LEGACY_SPEC, plan)
    ).validate()

    assert result.valid, result.errors
    assert result.warnings == []


def test_plan_validator_survives_a_missing_spec(tmp_path):
    result = ImplementationPlanValidator(_spec_dir(tmp_path, "", _plan())).validate()
    assert result.valid, result.errors
