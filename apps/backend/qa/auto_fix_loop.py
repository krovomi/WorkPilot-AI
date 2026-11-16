"""
Auto-Fix Loop Module
====================

Intelligent auto-fix loops that automatically detect and fix test failures.

Features:
- Automatic test execution and failure detection
- Intelligent failure analysis and fix generation
- Configurable retry limits (default: 5 attempts)
- Learning from common errors using the project's memory (the shared brain)
- Comprehensive success tracking and metrics
- Human escalation after max attempts

Usage:
    from qa.auto_fix_loop import AutoFixLoop

    loop = AutoFixLoop(project_dir, spec_dir, model)
    success = await loop.run_until_green(max_attempts=5)
"""

import asyncio
import contextlib
import re
import time
from dataclasses import dataclass
from pathlib import Path

from agents.memory_manager import get_memory_context, save_session_memory
from analysis.test_discovery import TestDiscovery
from core.client import create_agent_client
from core.task_event import TaskEventEmitter
from foundation.debug import (
    debug,
    debug_error,
    debug_section,
    debug_success,
    debug_warning,
)
from phase_config import get_phase_model, get_phase_thinking_budget
from task_logger import LogPhase, get_task_logger

from .auto_fix_metrics import record_auto_fix_run
from .fixer import run_qa_fixer_session

# Configuration
DEFAULT_MAX_AUTO_FIX_ATTEMPTS = 5
TEST_EXECUTION_TIMEOUT = 300.0  # 5 minutes

_JEST_SUMMARY = re.compile(
    r"Tests:\s+(?:(?P<failed>\d+)\s+failed,\s+)?(?:\d+\s+\w+,\s+)*?"
    r"\d+\s+passed,\s+(?P<total>\d+)\s+total",
    re.IGNORECASE,
)
#: What the fix request keeps of a run's output: its end, where the failures are.
_MAX_OUTPUT_IN_REQUEST = 20_000


def _tail(output: str) -> str:
    if len(output) <= _MAX_OUTPUT_IN_REQUEST:
        return output
    return "[... earlier output cut ...]\n" + output[-_MAX_OUTPUT_IN_REQUEST:]


_COUNT = re.compile(r"\b(\d+)\s+(passed|failed|errors?)\b", re.IGNORECASE)


@dataclass
class AutoFixTestResult:
    """Result of test execution."""

    executed: bool
    passed: bool
    output: str
    error: str | None
    duration: float
    test_count: int = 0
    failed_count: int = 0


@dataclass
class AutoFixAttempt:
    """Record of a single auto-fix attempt."""

    attempt_number: int
    test_result: AutoFixTestResult
    fix_applied: bool
    fix_status: str
    duration: float
    error_pattern: str | None = None
    timestamp: float = 0.0


class AutoFixLoop:
    """
    Orchestrates automatic test-fix-test loops until all tests pass.

    The loop:
    1. Runs tests to detect failures
    2. Analyzes failure output
    3. Generates and applies fixes using Claude
    4. Re-runs tests
    5. Repeats until tests pass or max attempts reached
    """

    def __init__(
        self,
        project_dir: Path,
        spec_dir: Path,
        model: str,
        verbose: bool = False,
    ):
        """
        Initialize auto-fix loop.

        Args:
            project_dir: Project root directory
            spec_dir: Spec directory
            model: Claude model to use
            verbose: Whether to show detailed output
        """
        self.project_dir = project_dir
        self.spec_dir = spec_dir
        self.model = model
        self.verbose = verbose
        self.task_logger = get_task_logger(spec_dir)
        self.task_event_emitter = TaskEventEmitter.from_spec_dir(spec_dir)
        self.attempts: list[AutoFixAttempt] = []

        # Initialize test discovery
        self.test_discovery = TestDiscovery()
        self.test_info = self.test_discovery.discover(project_dir)

    async def run_until_green(
        self, max_attempts: int = DEFAULT_MAX_AUTO_FIX_ATTEMPTS
    ) -> bool:
        """
        Run auto-fix loop until all tests pass or max attempts reached.

        Args:
            max_attempts: Maximum number of fix attempts (default: 5)

        Returns:
            True if all tests pass, False otherwise
        """
        debug_section("auto_fix_loop", "Auto-Fix Loop")
        debug(
            "auto_fix_loop",
            "Starting auto-fix loop",
            project_dir=str(self.project_dir),
            spec_dir=str(self.spec_dir),
            max_attempts=max_attempts,
        )

        print("\n" + "=" * 70)
        print("  🔄 AUTO-FIX LOOP")
        print("  Intelligent test-fix-test automation")
        print("=" * 70)

        # Check if tests are available
        if not (self.test_info.has_tests and self.test_info.test_command):
            debug_warning("auto_fix_loop", "No tests found in project")
            print("\n⚠️  No tests found in project. Cannot run auto-fix loop.")
            return False

        # Emit start event
        self.task_event_emitter.emit(
            "AUTO_FIX_STARTED",
            {
                "maxAttempts": max_attempts,
                "testCommand": self.test_info.test_command,
                "frameworks": [f.name for f in self.test_info.frameworks],
            },
        )

        # Load memory context for common test failures
        memory_context = await self._load_memory_context()

        # Start validation phase
        if self.task_logger:
            self.task_logger.start_phase(
                LogPhase.VALIDATION, "Starting auto-fix loop..."
            )

        attempt_number = 0
        while attempt_number < max_attempts:
            attempt_number += 1
            attempt_start = time.time()

            debug_section("auto_fix_loop", f"Attempt {attempt_number}/{max_attempts}")
            print(f"\n--- Auto-Fix Attempt {attempt_number}/{max_attempts} ---")

            # Step 1: Run tests
            debug("auto_fix_loop", "Executing tests...")
            test_result = await self._run_tests()

            if test_result.passed:
                # Success! All tests passed
                duration = time.time() - attempt_start
                attempt = AutoFixAttempt(
                    attempt_number=attempt_number,
                    test_result=test_result,
                    fix_applied=False,
                    fix_status="success",
                    duration=duration,
                    timestamp=time.time(),
                )
                self.attempts.append(attempt)

                debug_success(
                    "auto_fix_loop",
                    "All tests passed!",
                    attempts=attempt_number,
                    duration=f"{duration:.1f}s",
                )

                print("\n" + "=" * 70)
                print("  ✅ ALL TESTS PASSED!")
                print("=" * 70)
                print(f"\nTests fixed successfully after {attempt_number} attempt(s).")

                await self._save_to_memory(success=True)
                self._update_metrics(success=True, attempts=attempt_number)

                # Emit success event
                self.task_event_emitter.emit(
                    "AUTO_FIX_SUCCESS",
                    {
                        "attempts": attempt_number,
                        "duration": duration,
                        "testsRun": test_result.test_count,
                    },
                )

                # End validation phase successfully
                if self.task_logger:
                    self.task_logger.end_phase(
                        LogPhase.VALIDATION,
                        success=True,
                        message=f"Auto-fix successful after {attempt_number} attempts",
                    )

                return True

            # Tests failed - analyze and fix
            debug_warning(
                "auto_fix_loop",
                "Tests failed",
                failed_count=test_result.failed_count,
                total_count=test_result.test_count,
            )

            print(f"\n❌ Tests failed: {test_result.failed_count} failures")
            print(f"   Test output: {test_result.output[:500]}")

            if attempt_number >= max_attempts:
                # The last run is part of the history: without it the
                # escalation showed the run before it, and counted one
                # attempt fewer than the loop made.
                self.attempts.append(
                    AutoFixAttempt(
                        attempt_number=attempt_number,
                        test_result=test_result,
                        fix_applied=False,
                        fix_status="not_attempted",
                        duration=time.time() - attempt_start,
                        error_pattern=self._analyze_failure(test_result),
                        timestamp=time.time(),
                    )
                )
                debug_error(
                    "auto_fix_loop",
                    "Max attempts reached without success",
                    attempts=attempt_number,
                )
                break

            # Step 2: Analyze failure and generate fix
            debug("auto_fix_loop", "Analyzing test failures...")
            error_pattern = self._analyze_failure(test_result)

            # Emit attempt event
            self.task_event_emitter.emit(
                "AUTO_FIX_ATTEMPT",
                {
                    "attempt": attempt_number,
                    "maxAttempts": max_attempts,
                    "failedTests": test_result.failed_count,
                    "errorPattern": error_pattern,
                },
            )

            # Step 3: Generate fix request
            self._create_fix_request(test_result, error_pattern, memory_context)

            # Step 4: Apply fix using QA fixer
            debug("auto_fix_loop", "Applying automated fix...")
            print("\n🔧 Applying automated fix...")

            fix_status, fix_response = await self._apply_fix(attempt_number)

            duration = time.time() - attempt_start
            attempt = AutoFixAttempt(
                attempt_number=attempt_number,
                test_result=test_result,
                fix_applied=(fix_status == "fixed"),
                fix_status=fix_status,
                duration=duration,
                error_pattern=error_pattern,
                timestamp=time.time(),
            )
            self.attempts.append(attempt)

            if fix_status == "error":
                debug_error("auto_fix_loop", f"Fix error: {fix_response[:200]}")
                print(f"\n❌ Fix failed: {fix_response[:200]}")
                # Continue to next attempt
                continue

            debug_success("auto_fix_loop", "Fix applied, re-running tests...")
            print("\n✅ Fix applied. Re-running tests...")

        # Max attempts reached without success
        debug_error("auto_fix_loop", "Auto-fix loop failed", attempts=attempt_number)
        print("\n" + "=" * 70)
        print("  ⚠️  AUTO-FIX FAILED")
        print("=" * 70)
        print(f"\nFailed to fix tests after {max_attempts} attempts.")
        print("Escalating to human review...")

        await self._save_to_memory(success=False)
        self._update_metrics(success=False, attempts=attempt_number)

        # Escalate to human
        self._escalate_to_human()

        # Emit failure event
        self.task_event_emitter.emit(
            "AUTO_FIX_FAILED",
            {
                "attempts": attempt_number,
                "maxAttempts": max_attempts,
                "finalFailures": (
                    self.attempts[-1].test_result.failed_count if self.attempts else 0
                ),
            },
        )

        # End validation phase as failed
        if self.task_logger:
            self.task_logger.end_phase(
                LogPhase.VALIDATION,
                success=False,
                message=f"Auto-fix failed after {attempt_number} attempts",
            )

        return False

    async def _run_tests(self) -> AutoFixTestResult:
        """Run the project's declared test command; its exit code is the verdict.

        The command is the project's own script (a CI ``run:`` block, say), so
        it runs in a shell, as `bounty_board.signals` explains.
        """
        start_time = time.time()
        test_cmd = self.test_info.test_command
        if not test_cmd:
            return AutoFixTestResult(
                executed=False,
                passed=False,
                output="",
                error="No test command available",
                duration=0.0,
            )

        debug("auto_fix_loop", f"Executing: {test_cmd}")
        try:
            proc = await asyncio.create_subprocess_shell(
                test_cmd,
                cwd=self.project_dir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError as e:
            debug_error("auto_fix_loop", f"Test execution failed: {e}")
            return AutoFixTestResult(
                executed=False,
                passed=False,
                output="",
                error=str(e),
                duration=time.time() - start_time,
            )

        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=TEST_EXECUTION_TIMEOUT
            )
        except TimeoutError:
            debug_error("auto_fix_loop", "Tests timed out")
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            await proc.wait()
            return AutoFixTestResult(
                executed=True,
                passed=False,
                output="",
                error=f"Timeout after {TEST_EXECUTION_TIMEOUT}s",
                duration=TEST_EXECUTION_TIMEOUT,
            )

        passed = proc.returncode == 0
        # A suite prints in its own encoding (a Windows console's code page,
        # a test's binary fixture): a strict decode turned a failing run into
        # "Test execution failed" and lost its whole output.
        output = stdout.decode("utf-8", errors="replace")
        error_output = stderr.decode("utf-8", errors="replace")
        test_count, failed_count = self._parse_test_counts(output + error_output)
        return AutoFixTestResult(
            executed=True,
            passed=passed,
            output=output + "\n" + error_output,
            error=None if passed else error_output,
            duration=time.time() - start_time,
            test_count=test_count,
            failed_count=failed_count,
        )

    def _parse_test_counts(self, output: str) -> tuple[int, int]:
        """(total, failed) read from the runner's summary, for the fix request.

        Jest and Vitest print ``Tests: 2 failed, 5 passed, 7 total``; pytest
        prints ``2 failed, 5 passed, 1 error in 0.3s``, failures first, which
        the old pattern (``passed`` then ``failed``) read as 0 failures.
        """
        jest = _JEST_SUMMARY.search(output)
        if jest:
            return int(jest.group("total")), int(jest.group("failed") or 0)
        counts: dict[str, int] = {}
        for number, kind in _COUNT.findall(output):
            # The last summary wins: a suite may echo an earlier one.
            counts[kind.lower().rstrip("s")] = int(number)
        if counts:
            failed = counts.get("failed", 0) + counts.get("error", 0)
            return counts.get("passed", 0) + failed, failed
        # A runner whose summary nobody here recognises: one run, failed when
        # it says so. The exit code, not this, decides pass or fail.
        lowered = output.lower()
        if any(word in lowered for word in ("test", "spec", "pass", "fail", "error")):
            return 1, 1 if "fail" in lowered else 0
        return 0, 0

    def _analyze_failure(self, test_result: AutoFixTestResult) -> str:
        """
        Analyze test failure to identify error pattern.

        Returns:
            Error pattern identifier
        """
        output = test_result.output.lower()

        # Common error patterns
        if "assertion" in output or "expected" in output:
            return "assertion_failure"
        elif "timeout" in output:
            return "timeout"
        elif "syntax" in output or "syntaxerror" in output:
            return "syntax_error"
        elif "import" in output or "module" in output:
            return "import_error"
        elif "type" in output and "error" in output:
            return "type_error"
        elif "undefined" in output or "is not defined" in output:
            return "undefined_error"
        elif "null" in output or "none" in output:
            return "null_pointer"
        else:
            return "general_failure"

    def _create_fix_request(
        self, test_result: AutoFixTestResult, error_pattern: str, memory_context: str
    ) -> None:
        """Create QA_FIX_REQUEST.md for the fixer agent."""
        fix_request_file = self.spec_dir / "QA_FIX_REQUEST.md"

        content = f"""# Auto-Fix Request

## Test Execution Failed

The automated tests have failed. Please analyze the test output below and apply fixes to make the tests pass.

### Test Command
```bash
{self.test_info.test_command}
```

### Test Results
- **Status**: FAILED
- **Failed Tests**: {test_result.failed_count}/{test_result.test_count}
- **Error Pattern**: {error_pattern}
- **Duration**: {test_result.duration:.2f}s

### Test Output
```
{_tail(test_result.output)}
```

### Error Details
```
{test_result.error or "See output above"}
```

### Memory Context - Common Patterns
{memory_context}

### Instructions
1. Analyze the test failures carefully
2. Identify the root cause of the failures
3. Apply minimal fixes to make tests pass
4. Ensure fixes don't break existing functionality
5. Update implementation_plan.json with fixes_applied status

**IMPORTANT**: Focus on fixing the actual code issues, not just the tests.
"""

        fix_request_file.write_text(content, encoding="utf-8")
        debug("auto_fix_loop", "Created fix request file", path=str(fix_request_file))

    async def _apply_fix(self, attempt_number: int) -> tuple[str, str]:
        """
        Apply fix using QA fixer agent.

        Wraps the session in the shared rate-limit shield: if the LLM call hits
        a rate-limit, we pause until the quota window resets and retry the same
        attempt rather than burning one of the limited attempts on a 429.
        """
        from services.rate_limit_shield import (
            handle_prompt_too_long,
            handle_rate_limit_pause,
        )

        # Get model and thinking budget
        qa_model = get_phase_model(self.spec_dir, "qa", self.model)
        fixer_thinking_budget = get_phase_thinking_budget(self.spec_dir, "qa")

        while True:
            try:
                fix_client = create_agent_client(
                    project_dir=self.project_dir,
                    spec_dir=self.spec_dir,
                    model=qa_model,
                    agent_type="qa_fixer",
                    max_thinking_tokens=fixer_thinking_budget,
                )
                async with fix_client:
                    fix_status, fix_response = await run_qa_fixer_session(
                        fix_client,
                        self.spec_dir,
                        attempt_number,
                        self.verbose,
                        self.project_dir,
                    )
            except Exception as e:
                # Prompt-too-long is a permanent failure; stop retrying and
                # surface a "reset conversation / switch provider" choice
                # to the user via the halt marker file.
                if handle_prompt_too_long(e, self.spec_dir, "auto_fix"):
                    raise
                if await handle_rate_limit_pause(e, self.spec_dir, "auto_fix"):
                    # Shield paused-and-resumed; retry the same attempt.
                    continue
                raise
            # The fixer returns the provider's own error instead of raising
            # it: a rate limit reached here cost an attempt, unshielded.
            if fix_status == "error" and await handle_rate_limit_pause(
                RuntimeError(fix_response), self.spec_dir, "auto_fix"
            ):
                continue
            return fix_status, fix_response

    async def _load_memory_context(self) -> str:
        """What the project's memory knows about its test failures."""
        memory_context = await get_memory_context(
            self.spec_dir,
            self.project_dir,
            {
                "description": "Analyzing common test failure patterns for auto-fix",
                "id": f"auto_fix_{self.spec_dir.name}",
            },
        )
        if memory_context:
            debug_success("auto_fix_loop", "Loaded memory context for auto-fix")
            return memory_context
        return "No historical patterns found."

    def _patterns(self) -> list[str]:
        """The failure patterns met in this run, first seen first."""
        return list(
            dict.fromkeys(a.error_pattern for a in self.attempts if a.error_pattern)
        )

    async def _save_to_memory(self, success: bool) -> None:
        """File what this run learnt in the project's memory.

        It used to call `save_session_memory` with four positional arguments
        it does not take: the TypeError was caught and logged, and no auto-fix
        run was ever saved. A suite that passed on the first run taught
        nothing, and is not saved.
        """
        patterns = self._patterns()
        if not patterns:
            return
        command = self.test_info.test_command
        attempts = len(self.attempts)
        if success:
            lesson = {
                "recommendations": [
                    f"Failures of `{command}` ({', '.join(patterns)}) were fixed "
                    f"automatically in {attempts} attempts."
                ]
            }
        else:
            lesson = {
                "gotchas_encountered": [
                    f"Auto-fix could not make `{command}` pass in {attempts} "
                    f"attempts ({', '.join(patterns)}); see AUTO_FIX_ESCALATION.md."
                ]
            }
        run_id = f"auto_fix_{self.spec_dir.name}"
        await save_session_memory(
            spec_dir=self.spec_dir,
            project_dir=self.project_dir,
            subtask_id=run_id,
            session_num=attempts,
            success=success,
            subtasks_completed=[run_id] if success else [],
            discoveries={
                "files_understood": {},
                "patterns_found": [],
                "gotchas_encountered": [],
                **lesson,
            },
        )
        debug_success("auto_fix_loop", "Saved auto-fix run to memory")

    def _update_metrics(self, success: bool, attempts: int) -> None:
        """Record the run in the plan's ``auto_fix_stats``, patterns included.

        The loop kept its own copy of `auto_fix_metrics.record_run`, without
        the patterns: the dashboard's common patterns stayed empty.
        """
        frameworks = self.test_info.frameworks
        record_auto_fix_run(
            self.spec_dir,
            success=success,
            attempts=attempts,
            duration=sum(a.duration for a in self.attempts),
            error_patterns=self._patterns(),
            test_framework=frameworks[0].name if frameworks else None,
        )

    def _escalate_to_human(self) -> None:
        """Escalate to human review after auto-fix failure."""
        try:
            escalation_file = self.spec_dir / "AUTO_FIX_ESCALATION.md"

            # Build summary of attempts
            attempts_summary = "\n".join(
                f"**Attempt {a.attempt_number}**: {a.error_pattern} "
                f"({a.duration:.1f}s, fix {a.fix_status})"
                for a in self.attempts
            )

            content = f"""# Auto-Fix Escalation

## Auto-Fix Loop Failed

The automated test-fix loop was unable to resolve all test failures after {len(self.attempts)} attempts.

### Summary
- **Max Attempts**: {len(self.attempts)}
- **Test Command**: `{self.test_info.test_command}`
- **Final Status**: FAILED

### Attempt History
{attempts_summary}

### Last Test Output
```
{self.attempts[-1].test_result.output if self.attempts else "No output"}
```

### Next Steps
1. Review the test failures manually
2. Check if tests are flaky or environment-dependent
3. Verify that the implementation is correct
4. Run tests locally: `{self.test_info.test_command}`

### Files to Review
- Implementation: See spec files in `{self.spec_dir}/`
- Test output: Above
- Fix requests: `{self.spec_dir}/QA_FIX_REQUEST.md`

**Manual intervention required.**
"""

            escalation_file.write_text(content, encoding="utf-8")
            debug_success(
                "auto_fix_loop",
                "Created escalation file",
                path=str(escalation_file),
            )

            print(f"\n📋 Escalation report: {escalation_file}")

            # Also emit escalation event
            self.task_event_emitter.emit(
                "AUTO_FIX_ESCALATED",
                {
                    "attempts": len(self.attempts),
                    "escalationFile": str(escalation_file),
                },
            )

        except OSError as e:
            debug_error("auto_fix_loop", f"Failed to create escalation: {e}")


# =============================================================================
# PUBLIC API
# =============================================================================


async def run_auto_fix_loop(
    project_dir: Path,
    spec_dir: Path,
    model: str,
    max_attempts: int = DEFAULT_MAX_AUTO_FIX_ATTEMPTS,
    verbose: bool = False,
) -> bool:
    """
    Run auto-fix loop until tests pass or max attempts reached.

    Args:
        project_dir: Project root directory
        spec_dir: Spec directory
        model: Claude model to use
        max_attempts: Maximum fix attempts (default: 5)
        verbose: Whether to show detailed output

    Returns:
        True if tests pass, False otherwise
    """
    loop = AutoFixLoop(project_dir, spec_dir, model, verbose)
    return await loop.run_until_green(max_attempts)
