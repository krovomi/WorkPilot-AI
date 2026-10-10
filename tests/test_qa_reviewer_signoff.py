"""
How a QA reviewer pass that did not leave a readable qa_signoff is settled.

"The QA agent failed 3 time(s) in a row" came from three ways a pass could end
without a verdict the loop could read, each told back to the next pass as
"you did NOT update implementation_plan.json":

- the reviewer edited the plan into invalid JSON — the file was updated, and
  stayed unreadable for every pass after it;
- the reviewer stated its verdict in the format the prompt itself prescribes
  (``**SIGN-OFF**: APPROVED``), which the fallback parser did not match;
- the verdict was in qa_report.md, which nothing read.
"""

import asyncio
import json
import time
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from qa import reviewer
from qa.reviewer import (
    QA_ERROR_INVALID_PLAN,
    QA_ERROR_NO_SIGNOFF,
    _extract_verdict_from_response,
    _process_qa_result,
    classify_qa_error,
)


@pytest.fixture
def spec_dir(tmp_path: Path) -> Path:
    (tmp_path / "implementation_plan.json").write_text(
        json.dumps({"feature": "x", "phases": [{"id": "p1"}]}), encoding="utf-8"
    )
    return tmp_path


def _process(spec_dir: Path, response: str, **kwargs) -> tuple[str, str]:
    with (
        patch.object(reviewer, "audit_event"),
        patch.object(reviewer, "save_session_memory", AsyncMock()),
        patch.object(reviewer, "_ut_record_qa", None),
    ):
        return asyncio.run(
            _process_qa_result(spec_dir, spec_dir, 3, response, 5, 5, **kwargs)
        )


@pytest.mark.parametrize(
    ("text", "verdict"),
    [
        ("## Verdict\n\n**SIGN-OFF**: APPROVED\n", "approved"),
        ("**Status**: REJECTED", "rejected"),
        ("Sign-off: **APPROVED**", "approved"),
        ("`Verdict`: REJECTED", "rejected"),
        ("The last status: REJECTED. Fixed now.\nSIGN-OFF: APPROVED", "approved"),
        ("**SIGN-OFF**: [APPROVED / REJECTED]", None),
        ("Nothing conclusive here.", None),
    ],
)
def test_verdict_survives_the_prompts_own_markdown(text, verdict):
    assert _extract_verdict_from_response(text) == verdict


def test_invalid_plan_is_restored_and_the_verdict_still_recorded(spec_dir):
    plan_file = spec_dir / "implementation_plan.json"
    before = plan_file.read_text(encoding="utf-8")
    plan_file.write_text(
        '{"feature": "x", "qa_signoff": {"status": "approved",}}', encoding="utf-8"
    )

    status, _ = _process(
        spec_dir,
        "=== QA VALIDATION COMPLETE ===\n\n**Status**: APPROVED ✓",
        plan_before=before,
        session_started_at=time.time(),
    )

    assert status == "approved"
    plan = json.loads(plan_file.read_text(encoding="utf-8"))
    assert plan["phases"] == [{"id": "p1"}]
    assert plan["qa_signoff"]["status"] == "approved"


def test_invalid_plan_without_verdict_says_so(spec_dir):
    plan_file = spec_dir / "implementation_plan.json"
    before = plan_file.read_text(encoding="utf-8")
    plan_file.write_text("{ not json", encoding="utf-8")

    status, message = _process(
        spec_dir, "I edited the plan.", plan_before=before, session_started_at=0.0
    )

    assert status == "error"
    assert message.startswith(QA_ERROR_INVALID_PLAN)
    assert classify_qa_error(message) == "invalid_implementation_plan_json"
    # The next pass reads a plan, not the broken edit.
    assert json.loads(plan_file.read_text(encoding="utf-8")) == json.loads(before)


def test_verdict_read_from_the_report_written_this_session(spec_dir):
    started = time.time()
    (spec_dir / "qa_report.md").write_text(
        "# QA Report\n\n## Verdict\n\n**SIGN-OFF**: REJECTED\n", encoding="utf-8"
    )

    status, _ = _process(spec_dir, "", session_started_at=started)

    assert status == "rejected"
    plan = json.loads(
        (spec_dir / "implementation_plan.json").read_text(encoding="utf-8")
    )
    assert plan["qa_signoff"]["status"] == "rejected"


def test_a_previous_passs_report_is_not_this_passs_verdict(spec_dir):
    (spec_dir / "qa_report.md").write_text("**SIGN-OFF**: APPROVED", encoding="utf-8")

    status, message = _process(spec_dir, "", session_started_at=time.time() + 60)

    assert status == "error"
    assert message.startswith(QA_ERROR_NO_SIGNOFF)
    assert classify_qa_error(message) == "missing_implementation_plan_update"


def test_a_session_failure_is_not_reported_as_a_missing_update(spec_dir):
    status, message = _process(
        spec_dir, "", result_error="API overloaded", session_started_at=time.time()
    )

    assert status == "error"
    assert classify_qa_error(message) == "session_error"
    assert "did NOT update" not in reviewer._what_went_wrong("session_error")
