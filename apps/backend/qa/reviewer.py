"""
QA Reviewer Agent Session
==========================

Runs QA validation sessions to review implementation against
acceptance criteria.

Memory Integration:
- Retrieves past patterns, gotchas, and insights before QA session
- Saves QA findings (bugs, patterns, validation outcomes) after session
"""

import json
import re
import time
from datetime import UTC, datetime
from pathlib import Path

from agents.agent_audit import audit_event
from agents.memory_manager import get_memory_context, save_session_memory
from core.agent_client import AgentClient
from core.usage_tracker import record_qa_result as _ut_record_qa
from foundation.change_scope import ChangeScope
from foundation.debug import (
    debug,
    debug_detailed,
    debug_error,
    debug_section,
    debug_success,
    debug_warning,
)
from prompts_pkg import (
    get_qa_reviewer_light_prompt,
    get_qa_reviewer_prompt,
    get_qa_reviewer_targeted_prompt,
)
from task_logger import LogPhase, get_task_logger

from .criteria import (
    get_qa_signoff_status,
    load_implementation_plan,
    save_implementation_plan,
)
from .report import render_qa_report
from .session_stream import stream_session

# How a failed pass reads. The loop classifies the message (`classify_qa_error`)
# to tell the next pass what actually went wrong: every error used to be
# reported back as "you did NOT update implementation_plan.json", including the
# ones where the agent had updated it and broken the JSON, or where the session
# itself had failed — so the retry fixed nothing and the third pass failed the
# same way.
QA_ERROR_NO_SIGNOFF = "QA agent did not update implementation_plan.json"
QA_ERROR_INVALID_PLAN = "QA agent left implementation_plan.json as invalid JSON"
QA_ERROR_SIGNOFF_WRITE = "Failed to write qa_signoff"

# `SIGN-OFF: APPROVED`, `Status: REJECTED`, `Verdict: APPROVED`. Matched after
# markdown emphasis is stripped: the prompt's own templates bold the label
# (`**SIGN-OFF**: APPROVED`, `**Status**: REJECTED`), and the `**` between the
# label and the colon defeated every pattern.
_VERDICT_RE = re.compile(
    r"\b(?:SIGN[\-\s]*OFF|STATUS|VERDICT)\s*:\s*(APPROVED|REJECTED)\b"
)
_MARKDOWN_EMPHASIS_RE = re.compile(r"[*_`]")

# The files the reviewer writes its verdict into besides the plan, in the order
# they are trusted.
_SESSION_REPORT_FILES = ("qa_report.md", "QA_FIX_REQUEST.md")


def classify_qa_error(message: str) -> str:
    """The kind of a QA error message, for the next pass's self-correction."""
    if message.startswith(QA_ERROR_INVALID_PLAN):
        return "invalid_implementation_plan_json"
    if message.startswith((QA_ERROR_NO_SIGNOFF, QA_ERROR_SIGNOFF_WRITE)):
        return "missing_implementation_plan_update"
    return "session_error"


def _extract_verdict_from_response(response_text: str) -> str | None:
    """
    Parse the QA agent's response text to extract APPROVED/REJECTED verdict.

    This is a fallback for when the agent doesn't properly update
    implementation_plan.json. We look for clear verdict signals in the
    agent's output text.

    Returns: "approved", "rejected", or None if inconclusive.
    """
    if not response_text:
        return None

    text_upper = _MARKDOWN_EMPHASIS_RE.sub("", response_text).upper()

    # The last explicit verdict wins: the agent states its own at the end, and
    # may quote the previous pass's ("the last status: REJECTED") on the way.
    verdicts = _VERDICT_RE.findall(text_upper)
    if verdicts:
        return verdicts[-1].lower()

    # Pattern: "QA VALIDATION COMPLETE" + "APPROVED ✓" or "REJECTED ✗"
    if "QA VALIDATION COMPLETE" in text_upper:
        if "APPROVED" in text_upper:
            return "approved"
        if "REJECTED" in text_upper:
            return "rejected"

    return None


def _verdict_from_session_reports(spec_dir: Path, since: float) -> str | None:
    """The verdict in a report the reviewer wrote during this session.

    The prompt has the reviewer write `qa_report.md` (and `QA_FIX_REQUEST.md`
    when it rejects) before it updates the plan, and the session can end
    between the two. A file older than `since` belongs to a previous pass.
    """
    for name in _SESSION_REPORT_FILES:
        path = spec_dir / name
        try:
            if path.stat().st_mtime < since:
                continue
            verdict = _extract_verdict_from_response(
                path.read_text(encoding="utf-8", errors="replace")
            )
        except OSError:
            continue
        if verdict:
            return verdict
    return None


def _read_plan_text(spec_dir: Path) -> str | None:
    """implementation_plan.json as it is on disk, or None when unreadable."""
    try:
        return (spec_dir / "implementation_plan.json").read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _plan_json_error(spec_dir: Path) -> str | None:
    """Why implementation_plan.json does not parse; None when it does or is absent.

    `load_implementation_plan` answers None for both a missing file and a
    broken one, which made a plan the reviewer had edited into invalid JSON
    read as a plan it had never touched.
    """
    plan_file = spec_dir / "implementation_plan.json"
    if not plan_file.exists():
        return None
    try:
        json.loads(plan_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return f"{e.msg} at line {e.lineno} column {e.colno}"
    except (OSError, UnicodeDecodeError) as e:
        return str(e)
    return None


def _restore_plan(spec_dir: Path, plan_before: str | None) -> bool:
    """Put back the plan as it was before the session, if that copy parses."""
    if plan_before is None:
        return False
    try:
        json.loads(plan_before)
        (spec_dir / "implementation_plan.json").write_text(
            plan_before, encoding="utf-8"
        )
    except (json.JSONDecodeError, OSError):
        return False
    return True


def _programmatic_qa_signoff(
    spec_dir: Path,
    verdict: str,
    qa_session: int,
) -> bool:
    """
    Programmatically write the qa_signoff to implementation_plan.json.

    This is a fallback when the agent produces a clear verdict in its
    response text but fails to update the file itself.

    Returns True if successfully written.
    """
    plan = load_implementation_plan(spec_dir)
    if not plan:
        return False

    now = datetime.now(UTC).isoformat()

    if verdict == "approved":
        plan["qa_signoff"] = {
            "status": "approved",
            "timestamp": now,
            "qa_session": qa_session,
            "report_file": "qa_report.md",
            "tests_passed": {},
            "verified_by": "qa_agent (auto-extracted from response)",
        }
    elif verdict == "rejected":
        plan["qa_signoff"] = {
            "status": "rejected",
            "timestamp": now,
            "qa_session": qa_session,
            "issues_found": [],
            "fix_request_file": "QA_FIX_REQUEST.md",
        }
    else:
        return False

    return save_implementation_plan(spec_dir, plan)


def _what_went_wrong(error_type: str | None) -> str:
    """The self-correction paragraph for the kind of error the last pass hit."""
    if error_type == "invalid_implementation_plan_json":
        return (
            "You edited `implementation_plan.json` but left it as invalid JSON, so "
            "the framework could not read your `qa_signoff`. The copy from before "
            "your session has been restored. Read the file again and edit only the "
            "`qa_signoff` field; do not rewrite the rest of the plan."
        )
    if error_type == "session_error":
        return (
            "The session ended on an error before any verdict was recorded. This "
            "is not a mistake in the file: run the review again and record your "
            "verdict as soon as you have it."
        )
    return (
        "You did NOT update the `implementation_plan.json` file with the required "
        "`qa_signoff` object."
    )


# =============================================================================
# QA REVIEWER SESSION
# =============================================================================


async def run_qa_agent_session(
    client: AgentClient,
    project_dir: Path,
    spec_dir: Path,
    qa_session: int,
    max_iterations: int,
    verbose: bool = False,
    previous_error: dict | None = None,
    jev_advice: str = "",
    review_scope: ChangeScope | None = None,
    commands_seen: list[str] | None = None,
) -> tuple[str, str]:
    """
    Run a QA reviewer agent session.

    Args:
        client: the reviewer's client, from `create_agent_client` (any provider)
        project_dir: Project root directory (for capability detection)
        spec_dir: Spec directory
        qa_session: QA iteration number
        max_iterations: Maximum number of QA iterations
        verbose: Whether to show detailed output
        previous_error: Error context from previous iteration for self-correction
        review_scope: The change set's scope (`foundation.change_scope`). A
            light scope gets the text-only prompt with the spec and the diff
            inlined, and none of the memory or learned code patterns: they
            are about code this change did not touch. A targeted scope gets
            the prompt that names the tests to run, without them either.
        commands_seen: When given, every shell command the reviewer ran is
            appended to it (the targeted gate's evidence).

    Returns:
        (status, response_text) where status is:
        - "approved" if QA approves
        - "rejected" if QA finds issues
        - "error" if an error occurred
    """
    debug_section("qa_reviewer", f"QA Reviewer Session {qa_session}")
    debug(
        "qa_reviewer",
        "Starting QA reviewer session",
        spec_dir=str(spec_dir),
        qa_session=qa_session,
        max_iterations=max_iterations,
    )
    audit_event(
        project_dir,
        kind="agent_invoked",
        actor="qa_reviewer",
        correlation_id=spec_dir.name,
        summary=f"QA reviewer session {qa_session} invoked",
        payload={"qa_session": qa_session, "max_iterations": max_iterations},
    )

    print(f"\n{'=' * 70}")
    print(f"  QA REVIEWER SESSION {qa_session}")
    print("  Validating all acceptance criteria...")
    print(f"{'=' * 70}\n")

    task_logger = get_task_logger(spec_dir)

    # Load QA prompt with dynamically-injected project-specific MCP tools
    # This includes Electron validation for Electron apps, Puppeteer for web, etc.
    scoped = review_scope is not None and not review_scope.is_full
    if review_scope is not None and review_scope.is_light:
        prompt = get_qa_reviewer_light_prompt(spec_dir, project_dir, review_scope)
    elif review_scope is not None and review_scope.is_targeted:
        prompt = get_qa_reviewer_targeted_prompt(spec_dir, project_dir, review_scope)
    else:
        prompt = get_qa_reviewer_prompt(spec_dir, project_dir)
    if jev_advice:
        prompt += "\n\n" + jev_advice
    debug_detailed(
        "qa_reviewer",
        "Loaded QA reviewer prompt with project-specific tools",
        prompt_length=len(prompt),
        project_dir=str(project_dir),
    )

    # Retrieve memory context for QA (past patterns, gotchas, validation insights)
    qa_memory_context = (
        ""
        if scoped
        else await get_memory_context(
            spec_dir,
            project_dir,
            {
                "description": "QA validation and acceptance criteria review",
                "id": f"qa_reviewer_{qa_session}",
            },
        )
    )
    if qa_memory_context:
        prompt += "\n\n" + qa_memory_context
        print("✓ Memory context loaded for QA reviewer")
        debug_success("qa_reviewer", "Project memory loaded for QA")

    # Learning Loop: inject patterns learned from previous builds (qa_review phase)
    try:
        from learning_loop.prompt_injection import get_learning_context

        learning_context = (
            "" if scoped else get_learning_context(project_dir, "qa_review")
        )
        if learning_context:
            prompt += "\n\n" + learning_context
            debug_success("qa_reviewer", "Learning loop patterns injected for QA")
    except Exception:
        # L'injection de patterns est un bonus : sans elle le prompt reste valide.
        pass

    # Add session context
    prompt += f"\n\n---\n\n**QA Session**: {qa_session}\n"
    prompt += f"**Max Iterations**: {max_iterations}\n"

    # Add error context for self-correction if previous iteration failed
    if previous_error:
        debug(
            "qa_reviewer",
            "Adding error context for self-correction",
            error_type=previous_error.get("error_type"),
            consecutive_errors=previous_error.get("consecutive_errors"),
        )
        what_went_wrong = _what_went_wrong(previous_error.get("error_type"))
        prompt += f"""

---

## ⚠️ CRITICAL: PREVIOUS ITERATION FAILED - SELF-CORRECTION REQUIRED

The previous QA session failed with the following error:

**Error**: {previous_error.get("error_message", "Unknown error")}
**Consecutive Failures**: {previous_error.get("consecutive_errors", 1)}

### What Went Wrong

{what_went_wrong}

### Required Action

After completing your QA review, you MUST:

1. **Read the current implementation_plan.json**:
   ```bash
   cat {spec_dir}/implementation_plan.json
   ```

2. **Update it with your qa_signoff** by editing the JSON file to add/update the `qa_signoff` field:

   If APPROVED:
   ```json
   {{
     "qa_signoff": {{
       "status": "approved",
       "timestamp": "[current ISO timestamp]",
       "qa_session": {qa_session},
       "report_file": "qa_report.md",
       "tests_passed": {{"unit": "X/Y", "integration": "X/Y", "e2e": "X/Y"}},
       "coverage": {{"measured": true, "unit": 100, "integration": 100, "e2e": null}},
       "verified_by": "qa_agent"
     }}
   }}
   ```

   If REJECTED:
   ```json
   {{
     "qa_signoff": {{
       "status": "rejected",
       "timestamp": "[current ISO timestamp]",
       "qa_session": {qa_session},
       "issues_found": [
         {{"type": "critical", "title": "[issue]", "location": "[file:line]", "fix_required": "[description]"}}
       ],
       "fix_request_file": "QA_FIX_REQUEST.md"
     }}
   }}
   ```

3. **Use the Edit tool or Write tool** to update the file. The file path is:
   `{spec_dir}/implementation_plan.json`
   Change only the `qa_signoff` field and keep the file valid JSON: no comments,
   no trailing commas, every other field left exactly as it is.

### FAILURE TO DO THIS WILL CAUSE ANOTHER ERROR

This is attempt {previous_error.get("consecutive_errors", 1) + 1}. If you fail to update implementation_plan.json again, the QA process will be escalated to human review.

---

"""
        print(
            f"\n⚠️  Retry with self-correction context (attempt {previous_error.get('consecutive_errors', 1) + 1})"
        )

    # What the plan held before the reviewer touched it, so an edit that
    # breaks its JSON can be undone instead of failing every following pass.
    plan_before = _read_plan_text(spec_dir)
    session_started_at = time.time()

    try:
        outcome = await stream_session(
            client,
            prompt,
            agent_type="qa_reviewer",
            agent_name="QA Reviewer",
            tool_label="QA Tool",
            spec_dir=spec_dir,
            project_dir=project_dir,
            task_logger=task_logger,
            verbose=verbose,
            commands_seen=commands_seen,
        )
    except Exception as e:
        debug_error(
            "qa_reviewer",
            f"QA session exception: {e}",
            exception_type=type(e).__name__,
        )
        print(f"Error during QA session: {e}")
        if task_logger:
            task_logger.log_error(f"QA session error: {e}", LogPhase.VALIDATION)
        return "error", str(e)

    return await _process_qa_result(
        spec_dir,
        project_dir,
        qa_session,
        outcome.response_text,
        outcome.message_count,
        outcome.tool_count,
        result_error=outcome.result_error,
        plan_before=plan_before,
        session_started_at=session_started_at,
    )


# =============================================================================
# SHARED QA RESULT POST-PROCESSING
# =============================================================================


async def _process_qa_result(
    spec_dir: Path,
    project_dir: Path,
    qa_session: int,
    response_text: str,
    message_count: int,
    tool_count: int,
    result_error: str | None = None,
    plan_before: str | None = None,
    session_started_at: float | None = None,
) -> tuple[str, str]:
    """
    Shared post-processing logic for QA reviewer sessions.

    Checks implementation_plan.json for QA signoff, saves memory insights,
    extracts verdicts from response text as fallback.

    Used by both the Claude SDK path and the AgentClient path.
    """
    plan_error = _plan_json_error(spec_dir)
    if plan_error:
        # The reviewer's edit broke the plan. Left as is, every later pass
        # reads nothing, and so does the rest of the pipeline: put the copy
        # from before the session back, and take the verdict from the
        # reviewer's text or reports below. Whatever qa_signoff the restored
        # copy holds is the previous pass's, never this one's.
        restored = _restore_plan(spec_dir, plan_before)
        debug_error(
            "qa_reviewer",
            f"implementation_plan.json is invalid JSON after the session: {plan_error}",
            restored=restored,
        )
        print(
            f"\n⚠️  implementation_plan.json is invalid JSON ({plan_error})"
            + ("; restored the copy from before the session." if restored else ".")
        )
        status = None
    else:
        status = get_qa_signoff_status(spec_dir)
        # qa_report.md is rendered from the sign-off rather than written by the
        # reviewer: one copy of the issues in output tokens, not five.
        render_qa_report(spec_dir, status)
    debug(
        "qa_reviewer",
        "QA session completed",
        message_count=message_count,
        tool_count=tool_count,
        response_length=len(response_text),
        qa_status=status.get("status") if status else "unknown",
    )
    qa_status_value = status.get("status") if status else "unknown"
    audit_event(
        project_dir,
        kind="agent_completed" if qa_status_value == "approved" else "agent_failed",
        actor="qa_reviewer",
        correlation_id=spec_dir.name,
        summary=f"QA reviewer session {qa_session} → {qa_status_value}",
        payload={
            "qa_session": qa_session,
            "verdict": qa_status_value,
            "result_error": (str(result_error)[:500] if result_error else ""),
        },
    )

    qa_discoveries = {
        "files_understood": {},
        "patterns_found": [],
        "gotchas_encountered": [],
    }

    if status and status.get("status") == "approved":
        debug_success("qa_reviewer", "QA APPROVED")
        _ut_record_qa(project_dir, spec_dir.name, passed=True, score=100.0)
        qa_discoveries["patterns_found"].append(
            f"QA session {qa_session}: All acceptance criteria validated successfully"
        )
        await save_session_memory(
            spec_dir=spec_dir,
            project_dir=project_dir,
            subtask_id=f"qa_reviewer_{qa_session}",
            session_num=qa_session,
            success=True,
            subtasks_completed=[f"qa_reviewer_{qa_session}"],
            discoveries=qa_discoveries,
        )
        return ("approved", response_text)

    if status and status.get("status") == "rejected":
        debug_error("qa_reviewer", "QA REJECTED")
        _ut_record_qa(project_dir, spec_dir.name, passed=False, score=0.0)
        issues = status.get("issues_found", [])
        for issue in issues:
            qa_discoveries["gotchas_encountered"].append(
                f"QA Issue ({issue.get('type', 'unknown')}): {issue.get('title', 'No title')} at {issue.get('location', 'unknown')}"
            )
        await save_session_memory(
            spec_dir=spec_dir,
            project_dir=project_dir,
            subtask_id=f"qa_reviewer_{qa_session}",
            session_num=qa_session,
            success=False,
            subtasks_completed=[],
            discoveries=qa_discoveries,
        )
        return ("rejected", response_text)

    if status and status.get("status") not in ("approved", "rejected"):
        non_standard = status.get("status", "unknown")
        debug_warning(
            "qa_reviewer",
            f"QA agent wrote non-standard status: {non_standard} — treating as human escalation",
        )
        print(f"\n⚠️  QA agent set non-standard status: {non_standard}")
        print("Treating as human escalation (manual verification required).")
        return ("human_escalation", response_text)

    # Agent didn't update the file — try to extract verdict from response,
    # then from the reports it wrote during this session
    extracted_verdict = _extract_verdict_from_response(response_text)
    if not extracted_verdict and session_started_at is not None:
        extracted_verdict = _verdict_from_session_reports(spec_dir, session_started_at)

    if extracted_verdict:
        debug(
            "qa_reviewer",
            f"Extracted verdict from response: {extracted_verdict}",
            message_count=message_count,
            tool_count=tool_count,
        )
        print(
            f"\n⚠️  Agent didn't update implementation_plan.json, "
            f"but verdict detected: {extracted_verdict.upper()}"
        )

        if _programmatic_qa_signoff(spec_dir, extracted_verdict, qa_session):
            render_qa_report(spec_dir, get_qa_signoff_status(spec_dir))
            debug_success(
                "qa_reviewer",
                f"Programmatically wrote qa_signoff: {extracted_verdict}",
            )
            print(
                f"✅ Programmatically updated implementation_plan.json "
                f"with status: {extracted_verdict}"
            )
            return (extracted_verdict, response_text)

        debug_error(
            "qa_reviewer",
            "Failed to programmatically write qa_signoff",
        )
        if plan_error:
            return ("error", f"{QA_ERROR_INVALID_PLAN} ({plan_error})")
        return ("error", QA_ERROR_SIGNOFF_WRITE)

    # Agent didn't update the status and no clear verdict in response
    debug_error(
        "qa_reviewer",
        "QA agent did not update implementation_plan.json",
        message_count=message_count,
        tool_count=tool_count,
        response_preview=response_text[:500] if response_text else "empty",
    )

    if result_error:
        return ("error", f"Agent session error: {result_error}")

    if plan_error:
        return ("error", f"{QA_ERROR_INVALID_PLAN} ({plan_error})")

    error_details = []
    if message_count == 0:
        error_details.append("No messages received from agent")
    if tool_count == 0:
        error_details.append("No tools were used by agent")
    if not response_text:
        error_details.append("Agent produced no output")

    error_msg = QA_ERROR_NO_SIGNOFF
    if error_details:
        error_msg += f" ({'; '.join(error_details)})"

    return ("error", error_msg)
