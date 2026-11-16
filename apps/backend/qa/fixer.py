"""
QA Fixer Agent Session
=======================

Runs QA fixer sessions to resolve issues identified by the reviewer.

Memory Integration:
- Retrieves past patterns, fixes, and gotchas before fixing
- Saves fix outcomes and learnings after session
"""

from pathlib import Path

from agents.agent_audit import audit_event
from agents.memory_manager import get_memory_context, save_session_memory
from core.agent_client import AgentClient
from foundation.debug import (
    debug,
    debug_detailed,
    debug_error,
    debug_section,
    debug_success,
)
from foundation.steering import load_messages, mark_delivered, pending, steering_section
from task_logger import LogPhase, get_task_logger

from .criteria import get_qa_signoff_status
from .session_stream import stream_session

# =============================================================================
# QA FIXER SESSION
# =============================================================================


async def run_qa_fixer_session(
    client: AgentClient,
    spec_dir: Path,
    fix_session: int,
    verbose: bool = False,
    project_dir: Path | None = None,
) -> tuple[str, str]:
    """
    Run a QA fixer agent session.

    Args:
        client: the fixer's client, from `create_agent_client` (any provider)
        spec_dir: Spec directory
        fix_session: Fix iteration number
        verbose: Whether to show detailed output
        project_dir: Project root directory (for memory context)

    Returns:
        (status, response_text) where status is:
        - "fixed" if fixes were applied
        - "error" if an error occurred
    """
    # Derive project_dir from spec_dir if not provided
    # spec_dir is typically: /project/.workpilot/specs/001-name/
    if project_dir is None:
        # Walk up from spec_dir to find project root
        project_dir = spec_dir.parent.parent.parent
    debug_section("qa_fixer", f"QA Fixer Session {fix_session}")
    debug(
        "qa_fixer",
        "Starting QA fixer session",
        spec_dir=str(spec_dir),
        fix_session=fix_session,
    )
    audit_event(
        project_dir,
        kind="agent_invoked",
        actor="qa_fixer",
        correlation_id=spec_dir.name,
        summary=f"QA fixer session {fix_session} invoked",
        payload={"fix_session": fix_session},
    )

    print(f"\n{'=' * 70}")
    print(f"  QA FIXER SESSION {fix_session}")
    print("  Applying fixes from QA_FIX_REQUEST.md...")
    print(f"{'=' * 70}\n")

    # Check that fix request file exists
    fix_request_file = spec_dir / "QA_FIX_REQUEST.md"
    if not fix_request_file.exists():
        debug_error("qa_fixer", "QA_FIX_REQUEST.md not found")
        return "error", "QA_FIX_REQUEST.md not found"

    task_logger = get_task_logger(spec_dir)

    # Load fixer prompt through its builder: {{SPEC_DIR}} / {{MIN_COVERAGE}}
    # filled in and the verify section attached. The raw file used to be sent
    # as is, placeholders and all.
    from prompts_pkg import get_qa_fixer_prompt

    prompt = get_qa_fixer_prompt(spec_dir, project_dir)
    debug_detailed("qa_fixer", "Loaded QA fixer prompt", prompt_length=len(prompt))

    # Retrieve memory context for fixer (past fixes, patterns, gotchas)
    fixer_memory_context = await get_memory_context(
        spec_dir,
        project_dir,
        {
            "description": "Fixing QA issues and implementing corrections",
            "id": f"qa_fixer_{fix_session}",
        },
    )
    if fixer_memory_context:
        prompt += "\n\n" + fixer_memory_context
        print("✓ Memory context loaded for QA fixer")
        debug_success("qa_fixer", "Memory context loaded for fixer")

    # What the person sent while the task ran, not aimed at one subtask
    # (`foundation.steering`): marked delivered once the prompt is sent.
    steering = pending(load_messages(spec_dir), None)
    if steering:
        from security.untrusted import quote_untrusted

        prompt += "\n\n" + steering_section(
            steering,
            lambda context: quote_untrusted(
                context,
                kind="preview_element",
                source="task preview",
                spec_dir=spec_dir,
            ),
        )

    # Learning Loop: inject patterns learned from previous builds (qa_fixing phase)
    try:
        from learning_loop.prompt_injection import get_learning_context

        learning_context = get_learning_context(
            project_dir, "qa_fixing", spec_dir=spec_dir
        )
        if learning_context:
            prompt += "\n\n" + learning_context
            debug_success("qa_fixer", "Learning loop patterns injected for fixer")
    except Exception:
        # L'injection de patterns est un bonus : sans elle le prompt reste valide.
        pass

    # The developer's personal style, measured by the coach (#376); "" when off.
    from agent_coach.profile_injector import profile_block

    style = profile_block(project_dir)
    if style:
        prompt += "\n\n" + style

    # Add session context - use full path so agent can find files
    prompt += f"\n\n---\n\n**Fix Session**: {fix_session}\n"
    prompt += f"**Spec Directory**: {spec_dir}\n"
    prompt += f"**Spec Name**: {spec_dir.name}\n"
    prompt += f"\n**IMPORTANT**: All spec files are located in: `{spec_dir}/`\n"
    prompt += f"The fix request file is at: `{spec_dir}/QA_FIX_REQUEST.md`\n"

    try:
        outcome = await stream_session(
            client,
            prompt,
            agent_type="qa_fixer",
            agent_name="QA Fixer",
            tool_label="Fixer Tool",
            spec_dir=spec_dir,
            project_dir=project_dir,
            task_logger=task_logger,
            verbose=verbose,
            # Delivered once the person's messages reached the model.
            on_query_sent=lambda: mark_delivered(
                steering, spec_dir, session=fix_session, subtask_id=None
            ),
        )
    except Exception as e:
        debug_error(
            "qa_fixer",
            f"Fixer session exception: {e}",
            exception_type=type(e).__name__,
        )
        print(f"Error during fixer session: {e}")
        if task_logger:
            task_logger.log_error(f"QA fixer error: {e}", LogPhase.VALIDATION)
        return "error", str(e)

    if outcome.result_error:
        # The provider ended the session (rate limit, sign-in, crash): nothing
        # says a fix was made. It used to come back as "fixed", and the loop
        # spent a review pass on code nobody had touched.
        if task_logger:
            task_logger.log_error(
                f"QA fixer session error: {outcome.result_error}", LogPhase.VALIDATION
            )
        return "error", f"Agent session error: {outcome.result_error}"

    return await _process_fixer_result(
        spec_dir,
        project_dir,
        fix_session,
        outcome.response_text,
        outcome.message_count,
        outcome.tool_count,
    )


# =============================================================================
# SHARED FIXER RESULT POST-PROCESSING
# =============================================================================


async def _process_fixer_result(
    spec_dir: Path,
    project_dir: Path,
    fix_session: int,
    response_text: str,
    message_count: int,
    tool_count: int,
) -> tuple[str, str]:
    """Audit the finished fixer session and save it to the project's memory.

    A fixer that applied its fixes without setting `ready_for_qa_revalidation`
    still counts as fixed: the next review pass is the judge.
    """
    status = get_qa_signoff_status(spec_dir)
    ready = bool(status and status.get("ready_for_qa_revalidation"))
    debug(
        "qa_fixer",
        "Fixer session completed",
        message_count=message_count,
        tool_count=tool_count,
        response_length=len(response_text),
        ready_for_revalidation=ready,
    )
    audit_event(
        project_dir,
        kind="agent_completed",
        actor="qa_fixer",
        correlation_id=spec_dir.name,
        summary=f"QA fixer session {fix_session} completed (ready_for_revalidation={ready})",
        payload={"fix_session": fix_session, "ready_for_revalidation": ready},
    )
    debug_success(
        "qa_fixer",
        "Fixes applied, ready for QA revalidation"
        if ready
        else "Fixes assumed applied (status not updated)",
    )
    await save_session_memory(
        spec_dir=spec_dir,
        project_dir=project_dir,
        subtask_id=f"qa_fixer_{fix_session}",
        session_num=fix_session,
        success=True,
        subtasks_completed=[f"qa_fixer_{fix_session}"],
        discoveries={
            "files_understood": {},
            # A session log line is not a pattern: filed as one, it was
            # recalled as a "learned pattern" by every later session.
            "patterns_found": [],
            "gotchas_encountered": [],
        },
    )
    return "fixed", response_text
