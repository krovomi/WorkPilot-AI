"""
QA Validation Loop Orchestration
=================================

Main QA loop that coordinates reviewer and fixer sessions until
approval or max iterations.
"""

import asyncio
import os
import subprocess
import time as time_module
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

from core.client import create_agent_client
from core.progress import count_subtasks, is_build_complete
from core.task_event import TaskEventEmitter
from foundation.base_branch import detect_base_branch
from foundation.build_signals import BuildPaused
from foundation.change_scope import ChangeScope, change_scope
from foundation.debug import (
    debug,
    debug_error,
    debug_section,
    debug_success,
    debug_warning,
)
from foundation.pause_state import is_paused, read_pause_state
from foundation.phase_event import ExecutionPhase, emit_phase
from goal import (
    GoalSpec,
    GoalVerdict,
    budget_exceeded,
    evaluate_goal,
    fix_request,
    read_goal,
    record_verdict,
)
from integrations.linear.updater import (
    LinearTaskState,
    is_linear_enabled,
    linear_qa_approved,
    linear_qa_max_iterations,
    linear_qa_rejected,
    linear_qa_started,
)
from phase_config import (
    get_phase_model,
    get_phase_provider,
    get_phase_thinking_budget,
)
from security.constants import PROJECT_DIR_ENV_VAR
from security.qa_scanner import run_qa_security_scan
from task_logger import (
    LogEntryType,
    LogPhase,
    get_task_logger,
)

from .budget import (
    MAX_QA_ITERATIONS,
    qa_iteration_cap,
    recurring_issue_threshold,
)
from .criteria import (
    get_qa_iteration_count,
    get_qa_signoff_status,
    is_qa_approved,
)
from .fixer import run_qa_fixer_session
from .report import (
    create_manual_test_plan,
    escalate_to_human,
    get_iteration_history,
    get_recurring_issue_summary,
    has_recurring_issues,
    is_no_test_project,
    record_iteration,
    render_fix_request,
    run_visual_qa,
    write_visual_qa_report,
)
from .reviewer import classify_qa_error, run_qa_agent_session


def _ensure_fix_request_file(
    spec_dir: Path, issues: list[dict], qa_iteration: int
) -> bool:
    """
    Garantit qu'un ``QA_FIX_REQUEST.md`` à jour existe avant de lancer le fixer.

    Le fichier est rendu par Python depuis ``issues_found`` (le reviewer ne le
    rédige plus : c'était une quatrième copie des mêmes issues, en tokens de
    sortie). Il est réécrit à chaque passe qui a des issues, sinon une version
    d'une passe précédente enverrait le fixer sur des problèmes déjà corrigés.
    Sans issues, un fichier existant (retour humain) est conservé.

    Returns:
        ``True`` si le fichier existe à la sortie, ``False`` sinon.
    """
    fix_request_file = spec_dir / "QA_FIX_REQUEST.md"
    if issues and render_fix_request(spec_dir, issues, qa_iteration):
        debug(
            "qa_loop",
            "Rendered QA_FIX_REQUEST.md from issues_found",
            iteration=qa_iteration,
            issue_count=len(issues),
        )
        return True
    if fix_request_file.exists():
        return True
    debug_warning(
        "qa_loop",
        "Cannot write QA_FIX_REQUEST.md: reviewer reported no issues",
        iteration=qa_iteration,
    )
    return False


# Configuration
MAX_CONSECUTIVE_ERRORS = 3  # Stop after 3 consecutive errors without progress


@dataclass(frozen=True)
class DotnetTestRun:
    """What `dotnet test` said, for the QA verdict.

    ``status`` is ``passed`` (every test project ran green), ``failed`` (at
    least one returned non-zero or timed out) or ``unavailable`` (no test
    project, no dotnet CLI): only the last one calls for a manual plan.
    """

    status: str
    detail: str = ""


DOTNET_TEST_TIMEOUT_SECONDS = 300
_DOTNET_OUTPUT_TAIL = 4000


async def _run_dotnet_tests(project_dir: Path) -> DotnetTestRun:
    """Run ``dotnet test`` on every test project, without blocking the loop."""
    test_projects = []
    for csproj in project_dir.glob("**/*.csproj"):
        try:
            content = csproj.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if any(
            fw in content
            for fw in ["NUnit", "xunit", "MSTest", "Microsoft.NET.Test.Sdk"]
        ):
            test_projects.append(csproj)

    if not test_projects:
        return DotnetTestRun("unavailable", "no .NET test project found")

    debug("qa_loop", f"Found {len(test_projects)} test project(s)")
    print(f"   Found {len(test_projects)} test project(s)")

    failures: list[str] = []
    for test_project in test_projects:
        name = str(test_project.relative_to(project_dir))
        print(f"   Running tests in: {name}")
        try:
            process = await asyncio.create_subprocess_exec(
                "dotnet",
                "test",
                str(test_project),
                "-c",
                "Debug",
                cwd=str(project_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
        except FileNotFoundError:
            debug_error("qa_loop", "dotnet CLI not found on PATH")
            return DotnetTestRun("unavailable", "dotnet CLI not found on PATH")
        try:
            output, _ = await asyncio.wait_for(
                process.communicate(), timeout=DOTNET_TEST_TIMEOUT_SECONDS
            )
        except TimeoutError:
            process.kill()
            await process.wait()
            print("      ❌ Tests timed out")
            failures.append(
                f"{name}: timed out after {DOTNET_TEST_TIMEOUT_SECONDS} seconds"
            )
            continue
        text = output.decode("utf-8", errors="replace")
        if process.returncode == 0:
            print("      ✅ Tests passed")
            debug("qa_loop", f"dotnet test passed for {test_project.name}")
        else:
            print("      ❌ Tests failed")
            debug_warning(
                "qa_loop",
                f"dotnet test returned {process.returncode} for {test_project.name}",
            )
            failures.append(
                f"{name}: exit code {process.returncode}\n{text[-_DOTNET_OUTPUT_TAIL:]}"
            )

    if failures:
        return DotnetTestRun("failed", "\n\n".join(failures))
    return DotnetTestRun("passed", f"{len(test_projects)} test project(s) passed")


def dotnet_test_advice(run: DotnetTestRun, spec_dir: Path) -> str:
    """The reviewer's note on a failed ``dotnet test``; empty otherwise.

    The output comes from the project under review, so it enters the prompt
    fenced as data (docs/rules/security.md, S2).
    """
    if run.status != "failed":
        return ""
    from security.untrusted import quote_untrusted

    return (
        "## dotnet test failed\n\n"
        "WorkPilot ran `dotnet test` before this review and it failed. A failing "
        "test suite is a rejection unless the failure is shown to predate this "
        "build. Output:\n\n"
        + quote_untrusted(
            run.detail, kind="tool_output", source="dotnet test", spec_dir=spec_dir
        )
    )


async def _handle_rate_limit_in_qa(
    error: Exception,
    spec_dir: Path,
    source_spec_dir: Path | None,
) -> bool:
    """
    Thin wrapper around the shared rate-limit shield.

    Kept as a module-local alias so existing call sites and tests that patch
    `qa.loop._handle_rate_limit_in_qa` don't need to change.
    """
    from services.rate_limit_shield import handle_rate_limit_pause

    return await handle_rate_limit_pause(error, spec_dir, "qa", source_spec_dir)


# =============================================================================
# QA VALIDATION LOOP
# =============================================================================


class _Next(Enum):
    """What the loop does after a handler: its exits, and the two ways on."""

    APPROVED = "approved"  # return True
    FAILED = "failed"  # return False
    EXHAUSTED = "exhausted"  # leave the loop for the hand-over summary
    RETRY = "retry"  # same pass again: the iteration was given back
    NEXT = "next"  # next pass


@dataclass(frozen=True)
class _QaScope:
    """What every pass of one loop run shares and never changes."""

    project_dir: Path
    spec_dir: Path
    source_spec_dir: Path | None
    verbose: bool
    task_logger: Any
    emitter: Any
    linear_task: Any
    max_iterations: int
    recurring_threshold: int

    @property
    def has_linear_task(self) -> bool:
        return bool(self.linear_task and self.linear_task.task_id)


@dataclass
class _QaState:
    """What the passes carry from one to the next."""

    qa_iteration: int
    consecutive_errors: int = 0
    # The last reviewer error, fed back to the next pass for self-correction.
    last_error_context: dict | None = None
    max_iterations_emitted: bool = False
    # The change set the last reviewer pass judged (`foundation.change_scope`).
    # Read by the coverage gate: a text-only change has no coverage to measure.
    review_scope: ChangeScope | None = None

    def reset_errors(self) -> None:
        self.consecutive_errors = 0
        self.last_error_context = None


async def run_qa_validation_loop(
    project_dir: Path,
    spec_dir: Path,
    model: str,
    verbose: bool = False,
    source_spec_dir: Path | None = None,
    jev_run=None,
) -> bool:
    """
    Run the full QA validation loop.

    This is the self-validating loop:
    1. QA Agent reviews
    2. If rejected → Fixer Agent fixes
    3. QA Agent re-reviews
    4. Loop until approved or max iterations

    Enhanced with:
    - Iteration tracking with detailed history
    - Recurring issue detection (3+ occurrences → human escalation)
    - No-test project handling

    Args:
        project_dir: Project root directory
        spec_dir: Spec directory
        model: Claude model to use
        verbose: Whether to show detailed output

    Returns:
        True if QA approved, False otherwise
    """
    # Set environment variable for security hooks to find the correct project directory
    # This is needed because os.getcwd() may return the wrong directory in worktree mode
    os.environ[PROJECT_DIR_ENV_VAR] = str(project_dir.resolve())
    task_event_emitter = TaskEventEmitter.from_spec_dir(spec_dir)

    # Clear a stale "local model can't call tools" halt marker from a previous
    # run — re-running QA (e.g. after switching to a tool-capable model or a
    # cloud provider) must not keep surfacing the old halt.
    from services.rate_limit_shield import LOCAL_MODEL_NO_TOOLS_HALT_FILE

    stale_halt = spec_dir / LOCAL_MODEL_NO_TOOLS_HALT_FILE
    if stale_halt.exists():
        try:
            stale_halt.unlink()
        except OSError:
            pass

    qa_cap = qa_iteration_cap(spec_dir)
    # Goal mode (goal/): a command decides "done", not the reviewer, and the
    # goal may buy its own number of passes.
    goal, goal_invalid = read_goal(spec_dir, source_spec_dir)
    if goal is not None and goal.max_rounds is not None:
        qa_cap = min(goal.max_rounds, MAX_QA_ITERATIONS)

    debug_section("qa_loop", "QA Validation Loop")
    debug(
        "qa_loop",
        "Starting QA validation loop",
        project_dir=str(project_dir),
        spec_dir=str(spec_dir),
        model=model,
        max_iterations=qa_cap,
    )

    print("\n" + "=" * 70)
    print("  QA VALIDATION LOOP")
    print("  Self-validating quality assurance")
    print("=" * 70)

    # Initialize task logger for the validation phase
    task_logger = get_task_logger(spec_dir)

    # Verify build is complete
    if not is_build_complete(spec_dir):
        debug_warning("qa_loop", "Build is not complete, cannot run QA")
        print("\n❌ Build is not complete. Cannot run QA validation.")
        completed, total = count_subtasks(spec_dir)
        debug("qa_loop", "Build progress", completed=completed, total=total)
        print(f"   Progress: {completed}/{total} subtasks completed")
        return False

    # Emit phase event at start of QA validation (before any early returns)
    emit_phase(ExecutionPhase.QA_REVIEW, "Starting QA validation")
    task_event_emitter.emit(
        "QA_STARTED",
        {"iteration": 1, "maxIterations": qa_cap},
    )

    # Check if there's pending human feedback that needs to be processed
    fix_request_file = spec_dir / "QA_FIX_REQUEST.md"
    has_human_feedback = fix_request_file.exists()

    # Check if already approved - but if there's human feedback, we need to process it first
    if (
        is_qa_approved(spec_dir)
        and not has_human_feedback
        and goal_invalid is None
        and _goal_still_met(goal, project_dir, spec_dir, source_spec_dir)
    ):
        debug_success("qa_loop", "Build already approved by QA")
        print("\n✅ Build already approved by QA.")
        task_event_emitter.emit(
            "QA_PASSED",
            {"iteration": 0, "testsRun": {}},
        )
        return True

    # If there's human feedback, we need to run the fixer first before re-validating
    if has_human_feedback and not await _apply_human_feedback(
        project_dir, spec_dir, model, task_event_emitter
    ):
        return False

    await _run_security_scan(project_dir, spec_dir, task_event_emitter)
    dotnet_advice = await _prepare_no_test_project(project_dir, spec_dir)

    # Start validation phase in task logger
    if task_logger:
        task_logger.start_phase(LogPhase.VALIDATION, "Starting QA validation...")

    linear_task = await _start_linear_review(spec_dir)

    qa_iteration = get_qa_iteration_count(spec_dir)
    # The budget is the task's, not the run's: a build paused and resumed in
    # the middle of QA continues the count rather than starting a new one. A
    # person's feedback is what opens a new budget — they have read the
    # result and asked for more.
    max_iterations = qa_iteration + qa_cap if has_human_feedback else qa_cap
    recurring_threshold = recurring_issue_threshold(qa_cap)
    if task_logger:
        task_logger.log(
            f"QA budget: {max_iterations - qa_iteration} review pass(es) "
            f"(effort-based cap {qa_cap}); an issue seen {recurring_threshold} "
            "times escalates to a human.",
            LogEntryType.INFO,
            LogPhase.VALIDATION,
        )
    scope = _QaScope(
        project_dir=project_dir,
        spec_dir=spec_dir,
        source_spec_dir=source_spec_dir,
        verbose=verbose,
        task_logger=task_logger,
        emitter=task_event_emitter,
        linear_task=linear_task,
        max_iterations=max_iterations,
        recurring_threshold=recurring_threshold,
    )
    state = _QaState(qa_iteration=qa_iteration)
    if goal_invalid is not None:
        return _stop_on_goal(scope, state, goal_invalid)

    while state.qa_iteration < max_iterations:
        _raise_if_paused(spec_dir)
        # The goal's spending cap is read before a pass, never after: a pass
        # begun past the cap is spent before anything can stop it.
        if goal is not None and (
            over := budget_exceeded(goal, spec_dir, source_spec_dir)
        ):
            return _stop_on_goal(scope, state, over)

        state.qa_iteration += 1
        iteration_start = time_module.time()
        _announce_pass(scope, state.qa_iteration)
        _apply_qa_hot_swap(spec_dir, task_logger)

        # What the captures of the running app show — OCR'd before the
        # reviewer's prompt is built, so the section it reads is current.
        if (visual := run_visual_qa(spec_dir, project_dir)) is not None:
            print(
                "🖼  Visual QA: "
                f"{visual['high']} high, {visual['medium']} medium, "
                f"{visual['low']} low finding(s) read from the captures"
            )

        # Run QA reviewer with phase-specific model and thinking budget
        qa_model = get_phase_model(spec_dir, "qa", model)
        jev_run, jev_advice = await _jev_review_advice(
            jev_run, project_dir, spec_dir, state.qa_iteration
        )
        review = await _run_reviewer(
            scope,
            state,
            qa_model,
            "\n\n".join(part for part in (dotnet_advice, jev_advice) if part),
        )
        if review is _Next.FAILED:
            return False
        if review is _Next.RETRY:
            continue
        status, response, client = review

        iteration_duration = time_module.time() - iteration_start
        write_visual_qa_report(spec_dir)
        debug(
            "qa_loop",
            "QA reviewer session completed",
            status=status,
            duration_seconds=f"{iteration_duration:.1f}",
            response_length=len(response),
        )
        _record_reviewer_opinion(project_dir, spec_dir, status)

        if _halted_on_local_model_without_tools(scope, state, client, qa_model):
            return False

        # A gate that overturns the reviewer's approval leaves its issues and
        # its verdict here; the rejection handler below logs, records and fixes
        # them like any other rejection.
        gate: tuple[list[dict], str] | None = None

        if status == "approved":
            # Reset error tracking on success
            state.reset_errors()
            debug_success(
                "qa_loop",
                "QA APPROVED",
                iteration=state.qa_iteration,
                duration=f"{iteration_duration:.1f}s",
            )
            record_iteration(
                spec_dir, state.qa_iteration, "approved", [], iteration_duration
            )
            gate = await _architecture_gate(
                scope, state.qa_iteration, qa_model
            ) or _coverage_gate(spec_dir, state.qa_iteration, state.review_scope)
            if gate is None and goal is not None:
                goal_gate = _goal_gate(scope, state, goal)
                if goal_gate is _Next.FAILED:
                    return False
                gate = goal_gate
            if gate is None:
                await _on_approved(scope, state.qa_iteration)
                return True
            status = "rejected"

        elif status == "human_escalation":
            if goal is not None:
                # The card says where the goal stands when the person opens it.
                record_verdict(
                    evaluate_goal(goal, project_dir, spec_dir, source_spec_dir),
                    spec_dir,
                )
            await _on_human_escalation(scope, state.qa_iteration, iteration_duration)
            return True

        # Not an `elif`: a gate above can turn the reviewer's approval into a
        # rejection, and an `elif` chained to `if status == "approved"` never
        # ran for it — the fixer was skipped and the next pass re-reviewed the
        # same code, until the budget ran out.
        nxt = _Next.NEXT
        if status == "rejected":
            nxt = await _on_rejected(scope, state, qa_model, gate, iteration_duration)
        elif status == "error":
            nxt = _on_reviewer_error(scope, state, response, client, qa_model)

        if nxt is _Next.FAILED:
            return False
        if nxt is _Next.EXHAUSTED:
            break

    return await _report_exhausted(scope, state)


# -----------------------------------------------------------------------------
# Before the passes
# -----------------------------------------------------------------------------


async def _apply_human_feedback(
    project_dir: Path, spec_dir: Path, model: str, task_event_emitter
) -> bool:
    """Run the fixer on a person's QA_FIX_REQUEST.md; False stops the loop."""
    fix_request_file = spec_dir / "QA_FIX_REQUEST.md"
    debug(
        "qa_loop",
        "Human feedback detected - will run fixer first",
        fix_request_file=str(fix_request_file),
    )
    emit_phase(ExecutionPhase.QA_FIXING, "Processing human feedback")
    task_event_emitter.emit(
        "QA_FIXING_STARTED",
        {"iteration": 0},
    )
    print("\n📝 Human feedback detected. Running QA Fixer first...")

    # Get model and thinking budget for fixer (uses QA phase config)
    qa_model = get_phase_model(spec_dir, "qa", model)
    fixer_thinking_budget = get_phase_thinking_budget(spec_dir, "qa")

    try:
        fix_client = create_agent_client(
            project_dir=project_dir,
            spec_dir=spec_dir,
            model=qa_model,
            agent_type="qa_fixer",
            max_thinking_tokens=fixer_thinking_budget,
        )
    except Exception as e:
        debug_error("qa_loop", f"Failed to create fixer client for human feedback: {e}")
        print(f"\n❌ Failed to create fixer client: {e}")
        task_event_emitter.emit(
            "QA_AGENT_ERROR",
            {"iteration": 0, "consecutiveErrors": 1, "error": str(e)[:500]},
        )
        return False

    try:
        async with fix_client:
            fix_status, fix_response = await run_qa_fixer_session(
                fix_client,
                spec_dir,
                0,
                False,  # iteration 0 for human feedback
            )
    except Exception as e:
        debug_error("qa_loop", f"Fixer session crashed during human feedback: {e}")
        fix_status = "error"
        fix_response = str(e)

    if fix_status == "error":
        debug_error("qa_loop", f"Fixer error: {fix_response[:200]}")
        print(f"\n❌ Fixer encountered error: {fix_response}")
        return False

    debug_success("qa_loop", "Human feedback fixes applied")
    task_event_emitter.emit(
        "QA_FIXING_COMPLETE",
        {"iteration": 0},
    )
    print("\n✅ Fixes applied based on human feedback. Running QA validation...")

    # Remove the fix request file after processing
    try:
        fix_request_file.unlink()
        debug("qa_loop", "Removed processed QA_FIX_REQUEST.md")
    except OSError:
        pass  # Ignore if file removal fails
    return True


async def _run_security_scan(
    project_dir: Path, spec_dir: Path, task_event_emitter
) -> None:
    """Feature 29 (QA Security Scanner), never blocking.

    Runs before the review passes so its findings are already in qa_report.md
    when the reviewer reads it.
    """
    print("\n🔐 Running security scan...")
    try:
        sec_passed, _, sec_issues = await run_qa_security_scan(project_dir, spec_dir)
        # Feed the Consensus Arbiter: persist the security scanner's findings as
        # security-domain opinions so the arbiter has real data to reconcile
        # against the QA reviewer's verdict. Overwrites each run (latest state).
        try:
            from consensus_arbiter.opinion_writer import record_security_opinions

            record_security_opinions(project_dir, sec_issues)
        except Exception as _op_err:  # never let the producer break QA
            debug_warning("qa_loop", f"Security opinion producer skipped: {_op_err}")
        if not sec_passed:
            critical_count = sum(1 for i in sec_issues if i.get("type") == "critical")
            high_count = sum(1 for i in sec_issues if i.get("type") == "high")
            debug_warning(
                "qa_loop",
                "Security scan found vulnerabilities",
                critical=critical_count,
                high=high_count,
            )
            print(
                f"   ⚠️  Security issues found: {critical_count} critical, {high_count} high"
            )
            task_event_emitter.emit(
                "SECURITY_SCAN_ISSUES",
                {
                    "critical": critical_count,
                    "high": high_count,
                    "issues": sec_issues[:10],
                },
            )
        else:
            print("   ✅ Security scan passed — no critical/high issues")
    except Exception as _sec_err:
        debug_warning("qa_loop", f"Security scan skipped (non-blocking): {_sec_err}")
        print(f"   ℹ️  Security scan skipped: {_sec_err}")


async def _prepare_no_test_project(project_dir: Path, spec_dir: Path) -> str:
    """For a project without tests: run `dotnet test` or write a manual plan.

    Returns what the reviewer is told about it, or "" for a project with tests.
    """
    if not is_no_test_project(spec_dir, project_dir):
        return ""
    print("\n⚠️  No test framework detected in project.")
    dotnet_advice = ""

    # Check if this is a .NET project with test projects available
    from foundation.dotnet_tools import detect_dotnet_project

    if detect_dotnet_project(project_dir):
        print("Detected .NET project — attempting to run dotnet test...")
        dotnet_run = await _run_dotnet_tests(project_dir)
        if dotnet_run.status == "passed":
            print(f"✅ dotnet test passed ({dotnet_run.detail})")
        elif dotnet_run.status == "failed":
            print("❌ dotnet test failed: the QA reviewer is told so")
        else:
            print(f"⚠️  dotnet test unavailable: {dotnet_run.detail}")
            print("Creating manual test plan as fallback...")
            manual_plan = create_manual_test_plan(spec_dir, spec_dir.name)
            print(f"📝 Manual test plan created: {manual_plan}")
        dotnet_advice = dotnet_test_advice(dotnet_run, spec_dir)
    else:
        print("Creating manual test plan...")
        manual_plan = create_manual_test_plan(spec_dir, spec_dir.name)
        print(f"📝 Manual test plan created: {manual_plan}")

    print("\nNote: Automated testing will be limited for this project.")
    return dotnet_advice


async def _start_linear_review(spec_dir: Path):
    """Move the Linear task to "In Review"; returns it, or None without Linear."""
    if not is_linear_enabled():
        return None
    linear_task = LinearTaskState.load(spec_dir)
    if linear_task and linear_task.task_id:
        print(f"Linear task: {linear_task.task_id}")
        # Update Linear to "In Review" when QA starts
        await linear_qa_started(spec_dir)
        print("Linear task moved to 'In Review'")
    return linear_task


# -----------------------------------------------------------------------------
# One review pass
# -----------------------------------------------------------------------------


def _raise_if_paused(spec_dir: Path) -> None:
    """Cooperative pause, checked between passes.

    QA is a loop of long sessions, so "pause" without a checkpoint here meant
    the user waited for the current pass to end and then watched the next one
    start.
    """
    if is_paused(spec_dir):
        pause_state = read_pause_state(spec_dir)
        print("\n⏸  QA PAUSED — reprise possible à tout moment")
        print(f"   Paused at: {pause_state.get('paused_at')}")
        raise BuildPaused(
            pause_state.get("paused_phase") or "qa_review",
            pause_state.get("paused_subtask_id"),
        )


def _announce_pass(scope: _QaScope, qa_iteration: int) -> None:
    debug_section("qa_loop", f"QA Iteration {qa_iteration}")
    debug(
        "qa_loop",
        f"Starting iteration {qa_iteration}/{scope.max_iterations}",
        iteration=qa_iteration,
        max_iterations=scope.max_iterations,
    )

    print(f"\n--- QA Iteration {qa_iteration}/{scope.max_iterations} ---")
    emit_phase(ExecutionPhase.QA_REVIEW, f"Running QA review iteration {qa_iteration}")
    # Sous-étape de la phase de validation, affichée dans la barre de phase
    # de l'UI (équivalent des « phase N: NOM » de la planification).
    # On n'affiche PAS "/{max_iterations}" : ce max est un garde-fou, pas
    # un objectif — la QA s'arrête dès qu'elle approuve. Le montrer comme
    # "PASS 2/50" se lisait à tort comme "2 sur 50 faites" (~4%) alors que la
    # phase était terminée. Le frontend reformate en "QA — vérification N".
    if scope.task_logger:
        scope.task_logger.start_subphase(
            f"QA REVIEW — PASS {qa_iteration}",
            phase=LogPhase.VALIDATION,
            print_to_console=False,
        )


def _apply_qa_hot_swap(spec_dir: Path, task_logger) -> None:
    """Hot LLM swap: apply a pending provider/model/effort change for QA.

    Applied before the reviewer client is built, so the next QA pass ("next
    turn") uses it. No marker → no-op.
    """
    try:
        from agents.hot_swap import (
            apply_hot_swap_to_metadata,
            consume_hot_swap_for_phase,
            describe_hot_swap,
        )

        _hot_req = consume_hot_swap_for_phase(spec_dir, "qa")
        if _hot_req is not None:
            apply_hot_swap_to_metadata(spec_dir, _hot_req)
            if task_logger:
                task_logger.log_info(describe_hot_swap(_hot_req))
    except Exception:  # noqa: BLE001 - never break QA on a hot-swap hiccup
        pass


async def _jev_review_advice(
    jev_run, project_dir: Path, spec_dir: Path, qa_iteration: int
):
    """The jev assessment of this pass; returns the run (built once) and its text."""
    from integrations.jev.adapters import assess_build
    from integrations.jev.models import JevContext
    from integrations.jev.rubrics import advice_text
    from integrations.jev.runtime import JevRun

    if jev_run is None:
        jev_run = JevRun.from_env(JevContext("feature-build", project_dir, spec_dir))
    if not hasattr(jev_run, "base_revision") and not jev_run.eligibility():
        from foundation.base_branch import detect_base_branch
        from integrations.jev.adapters import capture_base

        try:
            capture_base(jev_run, detect_base_branch(spec_dir, project_dir))
        except (OSError, ValueError):
            jev_run.base_revision = None
    jev_advice = advice_text(
        await assess_build(jev_run, "review", pass_id=f"qa-{qa_iteration}")
    )
    return jev_run, jev_advice


async def _run_reviewer(
    scope: _QaScope, state: _QaState, qa_model: str, advice: str
) -> tuple[str, str, Any] | _Next:
    """One reviewer session: (status, response, client), FAILED or RETRY."""
    spec_dir = scope.spec_dir
    qa_thinking_budget = get_phase_thinking_budget(spec_dir, "qa")
    qa_provider = get_phase_provider(spec_dir, phase="qa")
    state.review_scope = review_scope = _review_scope(scope)
    debug(
        "qa_loop",
        "Creating client for QA reviewer session...",
        model=qa_model,
        thinking_budget=qa_thinking_budget,
    )
    try:
        client = create_agent_client(
            project_dir=scope.project_dir,
            spec_dir=spec_dir,
            model=qa_model,
            agent_type="qa_reviewer",
            max_thinking_tokens=qa_thinking_budget,
            provider=qa_provider,
            # A text-only change has nothing for a test-runner subagent to
            # run: its roster would be context billed on every turn.
            use_subagents=not review_scope.is_light,
        )
    except Exception as e:
        debug_error("qa_loop", f"Failed to create QA reviewer client: {e}")
        print(f"\n❌ Failed to create QA reviewer client: {e}")
        scope.emitter.emit(
            "QA_AGENT_ERROR",
            {
                "iteration": state.qa_iteration,
                "consecutiveErrors": 1,
                "error": str(e)[:500],
            },
        )
        return _Next.FAILED

    try:
        async with client:
            debug("qa_loop", "Running QA reviewer agent session...")
            status, response = await run_qa_agent_session(
                client,
                scope.project_dir,  # Pass project_dir for capability-based tool injection
                spec_dir,
                state.qa_iteration,
                scope.max_iterations,
                scope.verbose,
                jev_advice=advice,
                previous_error=state.last_error_context,  # Pass error context for self-correction
                review_scope=review_scope,
            )
    except Exception as e:
        # Prompt-too-long errors are not retryable — the conversation
        # is already too big for the model's context window, so the next
        # attempt would fail identically. Halt the loop and let the UI
        # surface "reset conversation / switch provider" actions.
        if _halted_on_prompt_too_long(
            scope,
            e,
            "QA halted: prompt too long",
            "QA halted: prompt too long for the LLM context window",
        ):
            return _Next.FAILED

        # Rate-limit errors must not count toward MAX_CONSECUTIVE_ERRORS or
        # we escalate to human after 3 limit-hits in a row instead of waiting
        # for the quota window to reset (the same iteration would have succeeded).
        if await _handle_rate_limit_in_qa(e, spec_dir, scope.source_spec_dir):
            state.qa_iteration -= (
                1  # don't burn an iteration on a paused-then-resumed attempt
            )
            return _Next.RETRY
        debug_error("qa_loop", f"QA reviewer session crashed: {e}")
        print(f"\n❌ QA reviewer session error: {e}")
        status = "error"
        response = str(e)
    return status, response, client


def _review_scope(scope: _QaScope) -> ChangeScope:
    """How much review this pass's change set calls for, written to the task log.

    Read again on every pass: a fixer that touched code after a text-only
    first pass turns the next review into a full one.
    """
    try:
        review_scope = change_scope(
            scope.project_dir, detect_base_branch(scope.spec_dir, scope.project_dir)
        )
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        # Unknown is never light.
        debug_warning("qa_loop", f"Change scope unavailable, full review: {exc}")
        return ChangeScope("full", "change scope unavailable")
    if review_scope.is_light and not review_scope.files:
        message = (
            f"QA scope: light ({review_scope.reason} against the base branch) — "
            "the reviewer checks whether the repository already meets the spec; "
            "no test suite, coverage or repository scan."
        )
    elif review_scope.is_light:
        message = (
            f"QA scope: light ({review_scope.reason}: "
            f"{', '.join(review_scope.files)}) — the reviewer checks the change "
            "against the spec; no test suite, coverage or repository scan."
        )
    else:
        message = f"QA scope: full ({review_scope.reason})."
    print(f"\n🔎 {message}")
    if scope.task_logger:
        scope.task_logger.log(message, LogEntryType.INFO, LogPhase.VALIDATION)
    return review_scope


def _halted_on_prompt_too_long(
    scope: _QaScope, error: Exception, headline: str, phase_message: str
) -> bool:
    """A prompt-too-long session halts QA: retrying would fail the same way."""
    from services.rate_limit_shield import handle_prompt_too_long

    if not handle_prompt_too_long(error, scope.spec_dir, "qa"):
        return False
    debug_error("qa_loop", headline)
    print(f"\n⛔ {headline}. See task detail.")
    if scope.task_logger:
        scope.task_logger.end_phase(
            LogPhase.VALIDATION,
            success=False,
            message=phase_message,
        )
    return True


def _record_reviewer_opinion(project_dir: Path, spec_dir: Path, status: str) -> None:
    """Feed the Consensus Arbiter the reviewer's verdict, never blocking.

    The verdict becomes a qa-domain opinion over the files this task changed.
    When the security scanner flagged one of those files but QA approved it,
    the arbiter surfaces the disagreement for a human to settle.
    """
    try:
        from consensus_arbiter.opinion_writer import (
            get_task_changed_files,
            record_qa_reviewer_opinion,
        )

        _qa_signoff = get_qa_signoff_status(spec_dir) or {}
        record_qa_reviewer_opinion(
            project_dir,
            status,
            get_task_changed_files(project_dir, spec_dir),
            issues=_qa_signoff.get("issues_found"),
        )
    except Exception as _op_err:  # never let the producer break QA
        debug_warning("qa_loop", f"QA opinion producer skipped: {_op_err}")


def _halted_on_local_model_without_tools(
    scope: _QaScope, state: _QaState, client, qa_model: str
) -> bool:
    """Halt when a local model never emitted a real tool call.

    It cannot drive agentic QA — it can only hallucinate (e.g. a fabricated
    "spec file not found" tool result). Retrying with the same model is futile,
    so halt now with one clear, actionable message instead of burning
    MAX_CONSECUTIVE_ERRORS passes. (feat/local-llm-agnostic hardening)
    """
    from services.rate_limit_shield import handle_local_model_no_tools

    if not handle_local_model_no_tools(client, scope.spec_dir, "qa", qa_model):
        return False
    halt_msg = (
        f"QA halted: the local model « {qa_model} » did not call any "
        "tool, so it cannot validate the implementation. Switch the "
        "Validation phase to a more capable model (a larger local "
        "model, or a cloud provider like Anthropic/Claude) and re-run."
    )
    print(f"\n⛔ {halt_msg}")
    scope.emitter.emit(
        "QA_AGENT_ERROR",
        {
            "iteration": state.qa_iteration,
            "consecutiveErrors": 1,
            "reason": "local_model_no_tools",
            "error": halt_msg,
        },
    )
    if scope.task_logger:
        scope.task_logger.end_phase(
            LogPhase.VALIDATION,
            success=False,
            message=halt_msg,
        )
    emit_phase(ExecutionPhase.FAILED, "QA halted: local model can't call tools")
    return True


# -----------------------------------------------------------------------------
# The gates that can overturn an approval
# -----------------------------------------------------------------------------


async def _architecture_gate(
    scope: _QaScope, qa_iteration: int, qa_model: str
) -> tuple[list[dict], str] | None:
    """Architecture Enforcement Gate, run once the reviewer has approved.

    Deterministic analysis first (fast), AI review second (optional). Returns
    the issues and the verdict of a rejection, or None when it passes, is not
    installed or fails (it never blocks the pipeline).
    """
    try:
        from architecture.validator import (
            run_architecture_validation,
            write_architecture_fix_request,
        )

        debug_section("qa_loop", "Running Architecture Enforcement Gate")
        emit_phase(
            ExecutionPhase.QA_REVIEW,
            "Architecture validation",
        )

        arch_passed, arch_report = await run_architecture_validation(
            project_dir=scope.project_dir,
            spec_dir=scope.spec_dir,
            model=qa_model,
            verbose=scope.verbose,
        )

        # Save architecture report to implementation_plan
        from .criteria import load_implementation_plan, save_implementation_plan

        plan = load_implementation_plan(scope.spec_dir)
        if plan:
            plan["architecture_enforcement"] = arch_report
            save_implementation_plan(scope.spec_dir, plan)

        if arch_passed:
            return None
        # Architecture violations found — treat like a QA rejection
        arch_violations = arch_report.get("violations", [])
        debug_warning(
            "qa_loop",
            "Architecture violations found",
            violation_count=len(arch_violations),
        )
        print(
            f"\n🏗️  Architecture enforcement found {len(arch_violations)} violation(s)"
        )

        # Write architecture fix request for the fixer agent
        write_architecture_fix_request(scope.spec_dir, arch_report)

        issues = [
            {
                "title": f"Architecture: {v.get('type', 'violation')}",
                "description": v.get("description", ""),
                "type": "architecture_violation",
            }
            for v in arch_violations
        ]
        return issues, (
            f"QA pass #{qa_iteration} rejected: "
            f"{len(arch_violations)} architecture violation(s)"
        )

    except ImportError:
        # architecture package not available — skip gracefully
        debug_warning(
            "qa_loop",
            "Architecture enforcement package not available, skipping",
        )
    except Exception as e:
        # Architecture validation should not block the QA pipeline
        debug_warning(
            "qa_loop",
            f"Architecture validation error (non-blocking): {e}",
        )
    return None


def _coverage_gate(
    spec_dir: Path, qa_iteration: int, review_scope: ChangeScope | None = None
) -> tuple[list[dict], str] | None:
    """Coverage Enforcement Gate, run once QA and architecture approve.

    Enforces the minimum test coverage threshold (default 100% for unit +
    integration, e2e best-effort). Language-agnostic: validates the coverage
    numbers recorded by the QA reviewer in qa_signoff.coverage. Controlled by
    WORKPILOT_QA_MIN_COVERAGE (0 = disabled). Returns the issues and the
    verdict of a rejection, or None.

    Not applicable when git showed no file a program reads in the change
    set (text only, however large, or no change at all): coverage cannot have
    moved, and demanding a measurement is what sent the reviewer to run every
    suite of the repository with coverage for a `.txt`, then the fixer to
    invent placeholder test projects to produce a number. Decided from
    `review_scope` (git), never from what the reviewer wrote in its sign-off.
    """
    if review_scope is not None and not review_scope.touches_code:
        debug("qa_loop", "Coverage gate not applicable: no code in the change set")
        return None
    try:
        from .coverage_gate import (
            build_coverage_issues,
            mark_signoff_rejected,
            run_coverage_gate,
            write_coverage_fix_request,
        )

        coverage_report = run_coverage_gate(spec_dir)

        if not coverage_report["enabled"]:
            debug(
                "qa_loop",
                "Coverage enforcement gate disabled (WORKPILOT_QA_MIN_COVERAGE=0)",
            )
        elif coverage_report["warnings"]:
            for warning in coverage_report["warnings"]:
                debug_warning("qa_loop", f"Coverage: {warning}")

        if not coverage_report["enabled"] or coverage_report["passed"]:
            return None
        debug_warning(
            "qa_loop",
            "Coverage gate failed",
            min_coverage=coverage_report["min_coverage"],
            failures=len(coverage_report["failures"]),
        )
        print(
            "\n📊 Coverage enforcement: "
            f"{len(coverage_report['failures'])} requirement(s) "
            f"below {coverage_report['min_coverage']}% threshold"
        )

        # Write a coverage-specific fix request for the fixer agent
        write_coverage_fix_request(spec_dir, coverage_report)

        # Make the gate authoritative: persist rejected status so a
        # later loop invocation cannot short-circuit on a stale
        # "approved" qa_signoff written by the reviewer.
        mark_signoff_rejected(spec_dir, coverage_report)

        return (
            build_coverage_issues(coverage_report),
            f"QA pass #{qa_iteration} rejected by the coverage gate",
        )

    except ImportError:
        debug_warning(
            "qa_loop",
            "Coverage gate package not available, skipping",
        )
    except Exception as e:
        # Coverage gate must not crash the QA pipeline.
        debug_warning(
            "qa_loop",
            f"Coverage gate error (non-blocking): {e}",
        )
    return None


def _goal_still_met(
    goal: GoalSpec | None,
    project_dir: Path,
    spec_dir: Path,
    source_spec_dir: Path | None,
) -> bool:
    """Whether an earlier approval still stands against the goal.

    A goal added, or code changed, after QA approved: the approval says what
    a reviewer thought, the command says whether the task is done.
    """
    if goal is None:
        return True
    verdict = evaluate_goal(goal, project_dir, spec_dir, source_spec_dir)
    record_verdict(verdict, spec_dir)
    if not verdict.met:
        print(f"\n🎯 QA had approved, but the goal is not met: {verdict.reason}")
    return verdict.met


def _reject_signoff_for_goal(spec_dir: Path, issues: list[dict]) -> None:
    """``qa_signoff.status = rejected``: a later run must not read the
    reviewer's approval as the task's."""
    from .criteria import load_implementation_plan, save_implementation_plan

    plan = load_implementation_plan(spec_dir)
    if not plan:
        return
    signoff = plan.get("qa_signoff")
    signoff = signoff if isinstance(signoff, dict) else {}
    kept = [
        issue
        for issue in signoff.get("issues_found") or []
        if not (isinstance(issue, dict) and issue.get("type") == "goal")
    ]
    signoff.update(
        status="rejected", ready_for_qa_revalidation=False, issues_found=kept + issues
    )
    plan["qa_signoff"] = signoff
    save_implementation_plan(spec_dir, plan)


def _goal_gate(
    scope: _QaScope, state: _QaState, goal: GoalSpec
) -> tuple[list[dict], str] | _Next | None:
    """The goal gate, run once the reviewer and the other gates approve.

    None when the goal is met; the issues and the verdict of a rejection when
    it is not; ``_Next.FAILED`` when it cannot be checked, which no fix can
    answer.
    """
    verdict = evaluate_goal(
        goal, scope.project_dir, scope.spec_dir, scope.source_spec_dir
    )
    if verdict.met:
        record_verdict(verdict, scope.spec_dir)
        print(f"\n🎯 Goal met: {verdict.reason}")
        return None
    if not verdict.fixable:
        _stop_on_goal(scope, state, verdict)
        return _Next.FAILED
    print(f"\n🎯 Goal not met: {verdict.reason}")
    issues = verdict.issues()
    try:
        (scope.spec_dir / "QA_FIX_REQUEST.md").write_text(
            fix_request(verdict, scope.spec_dir), encoding="utf-8"
        )
    except OSError as exc:
        debug_warning("qa_loop", f"Could not write the goal's fix request: {exc}")
    _reject_signoff_for_goal(scope.spec_dir, issues)
    record_verdict(verdict, scope.spec_dir)
    return issues, f"QA pass #{state.qa_iteration} rejected by the goal gate"


def _stop_on_goal(scope: _QaScope, state: _QaState, verdict: GoalVerdict) -> bool:
    """The goal cannot go on (cap reached, unreadable, uncheckable): a person decides."""
    record_verdict(verdict, scope.spec_dir)
    print(f"\n🎯 Goal: {verdict.reason}")
    print("Handing over to human review.")
    if scope.task_logger:
        scope.task_logger.log_error(
            f"Goal: {verdict.reason}; handing over to human review.",
            LogPhase.VALIDATION,
        )
        scope.task_logger.end_phase(
            LogPhase.VALIDATION, success=False, message=f"Goal: {verdict.reason}"
        )
    emit_phase(ExecutionPhase.FAILED, "QA validation incomplete")
    _emit_max_iterations(scope, state)
    return False


# -----------------------------------------------------------------------------
# The verdicts
# -----------------------------------------------------------------------------


async def _on_approved(scope: _QaScope, qa_iteration: int) -> None:
    """The reviewer and both gates approved: validation is complete."""
    emit_phase(ExecutionPhase.COMPLETE, "QA validation passed")

    qa_status = get_qa_signoff_status(scope.spec_dir) or {}
    scope.emitter.emit(
        "QA_PASSED",
        {
            "iteration": qa_iteration,
            "testsRun": qa_status.get("tests_passed", {}),
        },
    )

    print("\n" + "=" * 70)
    print("  ✅ QA APPROVED + ARCHITECTURE CLEAN")
    print("=" * 70)
    print("\nAll acceptance criteria verified.")
    print("Architecture validation passed.")
    print("The implementation is production-ready.")
    print("\nNext steps:")
    print("  1. Review the auto-claude/* branch")
    print("  2. Create a PR and merge to main")

    # End validation phase successfully
    if scope.task_logger:
        scope.task_logger.log_success(
            f"QA pass #{qa_iteration} approved: all criteria met, "
            f"architecture clean. Validation complete.",
            LogPhase.VALIDATION,
        )
        scope.task_logger.end_phase(
            LogPhase.VALIDATION,
            success=True,
            message="QA validation passed - all criteria met, architecture clean",
        )

    # Update Linear: QA approved, awaiting human review
    if scope.has_linear_task:
        await linear_qa_approved(scope.spec_dir)
        print("\nLinear: Task marked as QA approved, awaiting human review")


async def _on_human_escalation(
    scope: _QaScope, qa_iteration: int, iteration_duration: float
) -> None:
    """The reviewer could not verify here (e.g. sandbox, no CLI): a person will."""
    debug(
        "qa_loop",
        "QA requires human verification",
        iteration=qa_iteration,
        duration=f"{iteration_duration:.1f}s",
    )
    qa_status = get_qa_signoff_status(scope.spec_dir) or {}
    notes = qa_status.get("next_steps", [])
    if scope.task_logger:
        _reason = (
            " (environment limitation: tests can't run here)"
            if qa_status.get("sandbox_limitation")
            else ""
        )
        scope.task_logger.log_info(
            f"QA pass #{qa_iteration}: code validated by review; manual "
            f"verification required{_reason}. Validation complete.",
            LogPhase.VALIDATION,
        )

    emit_phase(ExecutionPhase.COMPLETE, "QA requires manual verification")
    scope.emitter.emit(
        "QA_PASSED",
        {
            "iteration": qa_iteration,
            "testsRun": qa_status.get("tests_passed", {}),
            "manualVerificationRequired": True,
        },
    )

    print("\n" + "=" * 70)
    print("  ⚠️  QA REQUIRES MANUAL VERIFICATION")
    print("=" * 70)
    print("\nCode quality passed automated review.")
    print("Manual verification required (e.g. run tests outside sandbox).")
    if notes:
        print("\nNext steps:")
        for step in notes[:5]:
            print(f"  - {step}")

    if scope.task_logger:
        scope.task_logger.end_phase(
            LogPhase.VALIDATION,
            success=True,
            message="QA validation passed — manual verification required",
        )

    if scope.has_linear_task:
        await linear_qa_approved(scope.spec_dir)
        print("\nLinear: Task marked as QA approved, awaiting human review")


async def _on_rejected(
    scope: _QaScope,
    state: _QaState,
    qa_model: str,
    gate: tuple[list[dict], str] | None,
    iteration_duration: float,
) -> _Next:
    """A rejection, by the reviewer or a gate: escalate, hand over, or fix."""
    spec_dir = scope.spec_dir
    qa_iteration = state.qa_iteration
    max_iterations = scope.max_iterations
    # Reset error tracking on valid response (rejected is a valid response)
    state.reset_errors()

    debug_warning(
        "qa_loop",
        "QA REJECTED",
        iteration=qa_iteration,
        duration=f"{iteration_duration:.1f}s",
    )
    print(f"\n❌ QA found issues. Iteration {qa_iteration}/{max_iterations}")

    if gate is not None:
        current_issues, verdict = gate
    else:
        # Get issues from QA report
        qa_status = get_qa_signoff_status(spec_dir)
        current_issues = qa_status.get("issues_found", []) if qa_status else []
        verdict = (
            f"QA pass #{qa_iteration} rejected: {len(current_issues)} issue(s) found"
        )
    debug(
        "qa_loop",
        "Issues found by QA",
        issue_count=len(current_issues),
        issues=current_issues[:3] if current_issues else [],  # Show first 3
    )
    # A gate's issues share one title; their description says what failed.
    issue_label = "description" if gate is not None else "title"
    scope.emitter.emit(
        "QA_FAILED",
        {
            "iteration": qa_iteration,
            "issueCount": len(current_issues),
            "issues": [
                issue.get(issue_label, "")
                for issue in (current_issues[:5] if current_issues else [])
            ],
        },
    )

    # Check for recurring issues BEFORE recording current iteration
    # This prevents the current issues from matching themselves in history
    history = get_iteration_history(spec_dir)
    has_recurring, recurring_issues = has_recurring_issues(
        current_issues, history, threshold=scope.recurring_threshold
    )

    # Record rejected iteration AFTER checking for recurring issues
    record_iteration(
        spec_dir, qa_iteration, "rejected", current_issues, iteration_duration
    )

    # The verdict says what comes next: it used to promise a fix and
    # another pass even on the last pass, right before the hand-over.
    if scope.task_logger:
        if has_recurring or qa_iteration >= max_iterations:
            outcome = "handing over to human review."
        else:
            outcome = f"applying a fix, then re-reviewing (pass #{qa_iteration + 1})."
        scope.task_logger.log_error(f"{verdict}; {outcome}", LogPhase.VALIDATION)

    if has_recurring:
        await _escalate_recurring(scope, state, recurring_issues)
        return _Next.FAILED

    # Record rejection in Linear
    if scope.has_linear_task:
        issues_count = len(current_issues)
        await linear_qa_rejected(spec_dir, issues_count, qa_iteration)

    if qa_iteration >= max_iterations:
        print("\n⚠️  Maximum QA iterations reached.")
        print("Escalating to human review.")
        _emit_max_iterations(scope, state)
        return _Next.EXHAUSTED

    # QA_FIX_REQUEST.md est rendu depuis issues_found : le fixer lit
    # les issues de cette passe, jamais celles d'une passe précédente.
    # Un gate a déjà écrit le sien, plus précis : on le garde.
    return await _run_fixer(
        scope, state, qa_model, current_issues if gate is None else None
    )


async def _escalate_recurring(
    scope: _QaScope, state: _QaState, recurring_issues: list[dict]
) -> None:
    """An issue seen `recurring_threshold` times goes to a person."""
    qa_iteration = state.qa_iteration
    debug_error(
        "qa_loop",
        "Recurring issues detected - escalating to human",
        recurring_count=len(recurring_issues),
        threshold=scope.recurring_threshold,
    )
    print(
        f"\n⚠️  Recurring issues detected ({len(recurring_issues)} issue(s) appeared {scope.recurring_threshold}+ times)"
    )
    print("Escalating to human review due to recurring issues...")

    # Create escalation file
    await escalate_to_human(
        scope.spec_dir,
        recurring_issues,
        qa_iteration,
        max_iterations=scope.max_iterations,
        threshold=scope.recurring_threshold,
    )

    # End validation phase
    if scope.task_logger:
        scope.task_logger.end_phase(
            LogPhase.VALIDATION,
            success=False,
            message=f"QA escalated to human after {qa_iteration} iterations due to recurring issues",
        )

    # Update Linear
    if scope.has_linear_task:
        await linear_qa_max_iterations(scope.spec_dir, qa_iteration)
        print("\nLinear: Task marked as needing human intervention (recurring issues)")
    _emit_max_iterations(scope, state)


def _emit_max_iterations(scope: _QaScope, state: _QaState) -> None:
    """QA_MAX_ITERATIONS, once per run: the card moves to human review on it."""
    if state.max_iterations_emitted:
        return
    scope.emitter.emit(
        "QA_MAX_ITERATIONS",
        {"iteration": state.qa_iteration, "maxIterations": scope.max_iterations},
    )
    state.max_iterations_emitted = True


async def _run_fixer(
    scope: _QaScope,
    state: _QaState,
    qa_model: str,
    issues_to_render: list[dict] | None,
) -> _Next:
    """One fixer session after a rejection: NEXT pass, RETRY, FAILED or EXHAUSTED.

    `issues_to_render` are the reviewer's issues, rendered into
    QA_FIX_REQUEST.md; None keeps the request a gate already wrote.
    """
    spec_dir = scope.spec_dir
    qa_iteration = state.qa_iteration
    # Run fixer with phase-specific thinking budget
    fixer_thinking_budget = get_phase_thinking_budget(spec_dir, "qa")
    debug(
        "qa_loop",
        "Starting QA fixer session...",
        model=qa_model,
        thinking_budget=fixer_thinking_budget,
    )
    emit_phase(ExecutionPhase.QA_FIXING, "Fixing QA issues")
    if scope.task_logger:
        scope.task_logger.start_subphase(
            f"QA FIX — PASS {qa_iteration}",
            phase=LogPhase.VALIDATION,
            print_to_console=False,
        )
    scope.emitter.emit(
        "QA_FIXING_STARTED",
        {"iteration": qa_iteration},
    )
    print("\nRunning QA Fixer Agent...")

    if issues_to_render is not None:
        _ensure_fix_request_file(spec_dir, issues_to_render, qa_iteration)

    try:
        fix_client = create_agent_client(
            project_dir=scope.project_dir,
            spec_dir=spec_dir,
            model=qa_model,
            agent_type="qa_fixer",
            max_thinking_tokens=fixer_thinking_budget,
        )
    except Exception as e:
        debug_error("qa_loop", f"Failed to create QA fixer client: {e}")
        print(f"\n❌ Failed to create QA fixer client: {e}")
        record_iteration(
            spec_dir,
            qa_iteration,
            "error",
            [{"title": "Fixer client error", "description": str(e)}],
        )
        return _Next.EXHAUSTED

    try:
        async with fix_client:
            fix_status, fix_response = await run_qa_fixer_session(
                fix_client, spec_dir, qa_iteration, scope.verbose
            )
    except Exception as e:
        # Prompt-too-long is permanent — see the reviewer session.
        if _halted_on_prompt_too_long(
            scope,
            e,
            "QA fixer halted: prompt too long",
            "QA fixer halted: prompt too long for the LLM context window",
        ):
            return _Next.FAILED

        # Same rate-limit shield as the reviewer: pause-and-resume
        # instead of counting toward consecutive errors.
        if await _handle_rate_limit_in_qa(e, spec_dir, scope.source_spec_dir):
            state.qa_iteration -= 1
            return _Next.RETRY
        debug_error("qa_loop", f"QA fixer session crashed: {e}")
        fix_status = "error"
        fix_response = str(e)

    debug(
        "qa_loop",
        "QA fixer session completed",
        fix_status=fix_status,
        response_length=len(fix_response),
    )

    if fix_status == "error":
        debug_error("qa_loop", f"Fixer error: {fix_response[:200]}")
        print(f"\n❌ Fixer encountered error: {fix_response}")
        record_iteration(
            spec_dir,
            qa_iteration,
            "error",
            [{"title": "Fixer error", "description": fix_response}],
        )
        return _Next.EXHAUSTED

    debug_success("qa_loop", "Fixes applied, re-running QA validation")
    scope.emitter.emit(
        "QA_FIXING_COMPLETE",
        {"iteration": qa_iteration},
    )
    print("\n✅ Fixes applied. Re-running QA validation...")
    return _Next.NEXT


def _on_reviewer_error(
    scope: _QaScope, state: _QaState, response: str, client, qa_model: str
) -> _Next:
    """A pass without a verdict: feed the error back, or stop after three."""
    spec_dir = scope.spec_dir
    qa_iteration = state.qa_iteration
    state.consecutive_errors += 1
    consecutive_errors = state.consecutive_errors
    debug_error(
        "qa_loop",
        f"QA session error: {response[:200]}",
        consecutive_errors=consecutive_errors,
        max_consecutive=MAX_CONSECUTIVE_ERRORS,
    )
    print(f"\n❌ QA error: {response}")
    print(f"   Consecutive errors: {consecutive_errors}/{MAX_CONSECUTIVE_ERRORS}")
    record_iteration(
        spec_dir,
        qa_iteration,
        "error",
        [{"title": "QA error", "description": response}],
    )

    # Build error context for self-correction in next iteration
    error_type = classify_qa_error(response)
    state.last_error_context = {
        "error_type": error_type,
        "error_message": response,
        "consecutive_errors": consecutive_errors,
        "expected_action": "You MUST update implementation_plan.json with a qa_signoff object containing 'status': 'approved' or 'status': 'rejected'",
        "file_path": str(spec_dir / "implementation_plan.json"),
    }

    if consecutive_errors < MAX_CONSECUTIVE_ERRORS:
        print("Retrying with error feedback...")
        return _Next.NEXT

    debug_error(
        "qa_loop",
        f"Max consecutive errors ({MAX_CONSECUTIVE_ERRORS}) reached - escalating to human",
    )
    print(f"\n⚠️  {MAX_CONSECUTIVE_ERRORS} consecutive errors without progress.")
    print(f"Last error: {response}")
    print("Escalating to human review.")
    # The last pass's own error travels with the event: the card
    # used to say only "failed 3 time(s) in a row", and the reason
    # was in the task logs alone.
    scope.emitter.emit(
        "QA_AGENT_ERROR",
        {
            "iteration": qa_iteration,
            "consecutiveErrors": consecutive_errors,
            "error": response[:500],
        },
    )

    # A local model often emits *some* recoverable tool calls (so the
    # fast-halt above doesn't fire) yet never writes a valid
    # qa_signoff — it stalls here after 3 errors. Make the escalation
    # message name the likely cause so the user knows to switch model
    # instead of assuming a code bug.
    fail_message = f"QA agent failed {MAX_CONSECUTIVE_ERRORS} consecutive times" + (
        f" - the session itself failed: {response[:300]}"
        if error_type == "session_error"
        else " - unable to update implementation_plan.json"
    )
    try:
        provider = client.provider_name()
    except Exception:
        provider = ""
    if provider in ("ollama", "local", "lmstudio"):
        fail_message += (
            f". The local model « {qa_model} » likely can't complete "
            "tool-based QA — switch the Validation phase to a more "
            "capable model (a larger local model, or a cloud provider)."
        )

    # End validation phase as failed
    if scope.task_logger:
        scope.task_logger.end_phase(
            LogPhase.VALIDATION,
            success=False,
            message=fail_message,
        )
    return _Next.FAILED


# -----------------------------------------------------------------------------
# After the passes
# -----------------------------------------------------------------------------


async def _report_exhausted(scope: _QaScope, state: _QaState) -> bool:
    """The budget ran out without approval: hand over to a person."""
    spec_dir = scope.spec_dir
    qa_iteration = state.qa_iteration
    max_iterations = scope.max_iterations
    emit_phase(ExecutionPhase.FAILED, "QA validation incomplete")
    _emit_max_iterations(scope, state)
    debug_error(
        "qa_loop",
        "QA VALIDATION INCOMPLETE - max iterations reached",
        iterations=qa_iteration,
        max_iterations=max_iterations,
    )
    print("\n" + "=" * 70)
    print("  ⚠️  QA VALIDATION INCOMPLETE")
    print("=" * 70)
    print(f"\nReached maximum iterations ({max_iterations}) without approval.")
    print("\nRemaining issues require human review:")

    # Show iteration summary
    history = get_iteration_history(spec_dir)
    summary = get_recurring_issue_summary(history)
    debug(
        "qa_loop",
        "QA loop final summary",
        total_iterations=len(history),
        total_issues=summary.get("total_issues", 0),
        unique_issues=summary.get("unique_issues", 0),
    )
    if summary["total_issues"] > 0:
        print("\n📊 Iteration Summary:")
        print(f"   Total iterations: {len(history)}")
        print(f"   Total issues found: {summary['total_issues']}")
        print(f"   Unique issues: {summary['unique_issues']}")
        if summary.get("most_common"):
            print("   Most common issues:")
            for issue in summary["most_common"][:3]:
                print(f"     - {issue['title']} ({issue['occurrences']} occurrences)")

    # End validation phase as failed
    if scope.task_logger:
        scope.task_logger.end_phase(
            LogPhase.VALIDATION,
            success=False,
            message=f"QA validation incomplete after {qa_iteration} iterations",
        )

    # Show the fix request file if it exists
    fix_request_file = spec_dir / "QA_FIX_REQUEST.md"
    if fix_request_file.exists():
        print(f"\nSee: {fix_request_file}")

    qa_report_file = spec_dir / "qa_report.md"
    if qa_report_file.exists():
        print(f"See: {qa_report_file}")

    # Update Linear: max iterations reached, needs human intervention
    if scope.has_linear_task:
        await linear_qa_max_iterations(spec_dir, qa_iteration)
        print("\nLinear: Task marked as needing human intervention")

    print("\nManual intervention required.")
    return False
