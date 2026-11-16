"""The auto-fix loop on a real suite: run it, have the fixer fix it, run again.

The project's test command is a small Python script that fails until the
fixer writes `fixed.txt`; the fixer's session is the scripted client, which
writes it while it streams. The rest is the production code: the shell run,
the fix request, the metrics in the plan, the memory, the escalation.
"""

from __future__ import annotations

import inspect
import json
import sys
from pathlib import Path

import pytest
from agents import memory_manager
from analysis.test_discovery import TestDiscoveryResult, TestFramework
from qa import auto_fix_loop
from qa.auto_fix_loop import AutoFixLoop, AutoFixTestResult, run_auto_fix_loop

CHECK = """\
import sys
from pathlib import Path

if Path("fixed.txt").exists():
    print("3 passed in 0.01s")
    sys.exit(0)
print("FAILED test_login.py::test_token - AssertionError: expected a token")
print("1 failed, 2 passed in 0.02s")
sys.exit(1)
"""


def _command(script: str) -> str:
    return f'"{sys.executable}" {script}'


def _discovered(command: str, *, frameworks: bool = True) -> TestDiscoveryResult:
    return TestDiscoveryResult(
        frameworks=[TestFramework(name="pytest", type="unit", command=command)]
        if frameworks
        else [],
        test_command=command,
        has_tests=True,
    )


class Fixer:
    """The fixer sessions the loop opens, and how the next ones behave."""

    def __init__(self, qa_kit, project: Path):
        self.qa_kit = qa_kit
        self.project = project
        self.clients: list = []
        self.fixes = True
        self.result_error: str | None = None
        self.raise_first: Exception | None = None

    def create_agent_client(self, **kwargs):
        assert kwargs["agent_type"] == "qa_fixer"
        if self.raise_first is not None:
            error, self.raise_first = self.raise_first, None
            raise error
        client = self.qa_kit.Client(
            [self.qa_kit.say("Token added.")],
            result_error=self.result_error,
            on_stream=self._fix if self.fixes else None,
        )
        self.clients.append(client)
        return client

    def _fix(self) -> None:
        (self.project / "fixed.txt").write_text("y", encoding="utf-8")


@pytest.fixture
def project(qa_spec: Path) -> Path:
    root = qa_spec.parents[2]
    (root / "check.py").write_text(CHECK, encoding="utf-8")
    return root


@pytest.fixture
def memory(monkeypatch) -> list[dict]:
    """What the loop files in memory, bound to the real function's signature."""
    saved: list[dict] = []
    real = inspect.signature(memory_manager.save_session_memory)

    async def save_session_memory(*args, **kwargs):
        saved.append(dict(real.bind(*args, **kwargs).arguments))
        return True, "brain"

    monkeypatch.setattr(auto_fix_loop, "save_session_memory", save_session_memory)
    return saved


@pytest.fixture
def fixer(qa_kit, project, monkeypatch) -> Fixer:
    sessions = Fixer(qa_kit, project)
    monkeypatch.setattr(
        auto_fix_loop, "create_agent_client", sessions.create_agent_client
    )
    return sessions


@pytest.fixture
def loop(project, qa_spec, replays) -> AutoFixLoop:
    fix_loop = AutoFixLoop(project, qa_spec, "model")
    fix_loop.test_info = _discovered(_command("check.py"))
    return fix_loop


def _events(out: str) -> list[dict]:
    prefix = "__TASK_EVENT__:"
    return [
        json.loads(line[len(prefix) :])
        for line in out.splitlines()
        if line.startswith(prefix)
    ]


def _stats(spec: Path) -> dict:
    plan = json.loads((spec / "implementation_plan.json").read_text(encoding="utf-8"))
    return plan["auto_fix_stats"]


async def test_a_failing_suite_is_fixed_and_the_run_is_learnt(
    loop, qa_spec, fixer, memory, capsys
):
    assert await loop.run_until_green(max_attempts=3) is True

    assert len(fixer.clients) == 1
    assert [a.fix_status for a in loop.attempts] == ["fixed", "success"]
    request = (qa_spec / "QA_FIX_REQUEST.md").read_text(encoding="utf-8")
    assert "**Failed Tests**: 1/3" in request
    assert "**Error Pattern**: assertion_failure" in request
    assert "expected a token" in request
    [saved] = memory
    assert saved["success"] is True and saved["session_num"] == 2
    assert "assertion_failure" in saved["discoveries"]["recommendations"][0]
    stats = _stats(qa_spec)
    assert stats["successful_runs"] == 1
    assert stats["common_patterns"] == {"assertion_failure": 1}
    assert stats["runs"][0]["test_framework"] == "pytest"
    kinds = [e["type"] for e in _events(capsys.readouterr().out)]
    assert [k for k in kinds if k.startswith("AUTO_FIX")] == [
        "AUTO_FIX_STARTED",
        "AUTO_FIX_ATTEMPT",
        "AUTO_FIX_SUCCESS",
    ]


async def test_a_suite_green_from_the_start_teaches_nothing(
    loop, project, qa_spec, fixer, memory
):
    (project / "fixed.txt").write_text("y", encoding="utf-8")

    assert await loop.run_until_green() is True

    assert fixer.clients == [] and memory == []
    assert not (qa_spec / "QA_FIX_REQUEST.md").exists()
    assert _stats(qa_spec)["runs"][0]["error_patterns"] == []


async def test_a_suite_that_stays_red_is_escalated(
    loop, qa_spec, fixer, memory, capsys
):
    """Regression: the last run was left out of the history and the count."""
    fixer.fixes = False

    assert await loop.run_until_green(max_attempts=2) is False

    assert [a.fix_status for a in loop.attempts] == ["fixed", "not_attempted"]
    escalation = (qa_spec / "AUTO_FIX_ESCALATION.md").read_text(encoding="utf-8")
    assert "after 2 attempts" in escalation
    assert "**Attempt 2**: assertion_failure" in escalation
    assert "fix not_attempted" in escalation
    [saved] = memory
    assert saved["success"] is False and saved["subtasks_completed"] == []
    assert "AUTO_FIX_ESCALATION.md" in saved["discoveries"]["gotchas_encountered"][0]
    events = [
        e for e in _events(capsys.readouterr().out) if e["type"].startswith("AUTO_FIX")
    ]
    assert [e["type"] for e in events][-2:] == ["AUTO_FIX_ESCALATED", "AUTO_FIX_FAILED"]
    assert events[-1]["finalFailures"] == 1
    assert _stats(qa_spec)["successful_runs"] == 0


async def test_a_fixer_session_error_moves_to_the_next_attempt(
    loop, fixer, memory, capsys
):
    fixer.result_error = "Expired sign-in"
    fixer.fixes = False

    assert await loop.run_until_green(max_attempts=3) is False

    assert [a.fix_status for a in loop.attempts] == ["error", "error", "not_attempted"]
    assert "Fix failed: Agent session error: Expired sign-in" in capsys.readouterr().out


async def test_without_a_task_log_the_loop_still_runs(
    project, qa_spec, replays, fixer, memory, monkeypatch
):
    monkeypatch.setattr(auto_fix_loop, "get_task_logger", lambda spec: None)
    fix_loop = AutoFixLoop(project, qa_spec, "model")
    fix_loop.test_info = _discovered(_command("check.py"), frameworks=False)

    assert await fix_loop.run_until_green(max_attempts=2) is True
    assert _stats(qa_spec)["runs"][0]["test_framework"] is None
    fixer.fixes = False
    (qa_spec.parents[2] / "fixed.txt").unlink()
    assert await fix_loop.run_until_green(max_attempts=1) is False


async def test_no_attempt_allowed_is_a_failure_with_nothing_to_show(
    loop, qa_spec, fixer, memory
):
    assert await loop.run_until_green(max_attempts=0) is False

    assert loop.attempts == [] and memory == []
    assert "No output" in (qa_spec / "AUTO_FIX_ESCALATION.md").read_text(
        encoding="utf-8"
    )


@pytest.mark.parametrize("command", ["", None])
async def test_a_project_without_tests_is_not_run(loop, fixer, command):
    if command is None:
        loop.test_info = TestDiscoveryResult()
    else:
        loop.test_info = _discovered(command)

    assert await loop.run_until_green() is False
    assert fixer.clients == []


async def test_the_public_entry_point_discovers_the_project(project, qa_spec, replays):
    # No test framework in this project: nothing to run, nothing to fix.
    assert await run_auto_fix_loop(project, qa_spec, "model", max_attempts=1) is False


class TestTheMemory:
    async def test_known_failures_reach_the_fix_request(
        self, loop, qa_spec, fixer, memory, monkeypatch
    ):
        async def get_memory_context(spec, project, task):
            assert task["id"] == "auto_fix_001-login"
            return "## Gotcha\nThe token lives in a cookie."

        monkeypatch.setattr(auto_fix_loop, "get_memory_context", get_memory_context)

        await loop.run_until_green(max_attempts=2)

        request = (qa_spec / "QA_FIX_REQUEST.md").read_text(encoding="utf-8")
        assert "The token lives in a cookie." in request

    async def test_without_memory_the_request_says_so(
        self, loop, qa_spec, fixer, memory
    ):
        await loop.run_until_green(max_attempts=2)

        request = (qa_spec / "QA_FIX_REQUEST.md").read_text(encoding="utf-8")
        assert "No historical patterns found." in request


class TestTheFixerClient:
    async def test_a_rate_limit_retries_the_same_attempt(
        self, loop, fixer, memory, monkeypatch
    ):
        paused: list[str] = []

        async def pause(error, spec_dir, phase):
            paused.append(phase)
            return True

        monkeypatch.setattr("services.rate_limit_shield.handle_rate_limit_pause", pause)
        fixer.raise_first = RuntimeError("429")

        assert await loop.run_until_green(max_attempts=2) is True
        assert paused == ["auto_fix"] and len(fixer.clients) == 1

    async def test_a_rate_limit_the_session_reports_is_waited_out(
        self, loop, fixer, memory, monkeypatch
    ):
        """Regression: the fixer returns its 429, and it cost an attempt."""
        paused: list[str] = []

        async def pause(error, spec_dir, phase):
            paused.append(str(error))
            fixer.result_error = None  # the quota window has reset
            return "429" in str(error)

        monkeypatch.setattr("services.rate_limit_shield.handle_rate_limit_pause", pause)
        fixer.result_error = "429 Too Many Requests"

        assert await loop.run_until_green(max_attempts=2) is True
        assert paused == ["Agent session error: 429 Too Many Requests"]
        assert [a.fix_status for a in loop.attempts] == ["fixed", "success"]

    async def test_a_prompt_too_long_stops_the_loop(self, loop, fixer, monkeypatch):
        monkeypatch.setattr(
            "services.rate_limit_shield.handle_prompt_too_long",
            lambda error, spec_dir, phase: True,
        )
        fixer.raise_first = RuntimeError("prompt is too long")

        with pytest.raises(RuntimeError, match="too long"):
            await loop.run_until_green(max_attempts=2)

    async def test_any_other_error_is_raised(self, loop, fixer):
        fixer.raise_first = ValueError("no provider")

        with pytest.raises(ValueError, match="no provider"):
            await loop.run_until_green(max_attempts=2)


class TestTheRun:
    async def test_output_in_another_encoding_is_kept(self, loop, project):
        """Regression: a strict UTF-8 decode lost a cp1252 suite's whole output."""
        (project / "latin.py").write_text(
            "import sys\n"
            "sys.stdout.buffer.write(b'\\xc9chec: 1 failed, 4 passed\\n')\n"
            "sys.stderr.buffer.write(b'\\xe9\\n')\n"
            "sys.exit(1)\n",
            encoding="utf-8",
        )
        loop.test_info = _discovered(_command("latin.py"))

        result = await loop._run_tests()

        assert result.executed is True and result.passed is False
        assert "�chec: 1 failed" in result.output
        assert result.error.endswith("\ufffd\n")
        assert (result.test_count, result.failed_count) == (5, 1)

    async def test_a_suite_that_hangs_is_stopped(self, loop, project, monkeypatch):
        (project / "hang.py").write_text(
            "import time\ntime.sleep(30)\n", encoding="utf-8"
        )
        loop.test_info = _discovered(_command("hang.py"))
        monkeypatch.setattr(auto_fix_loop, "TEST_EXECUTION_TIMEOUT", 0.5)

        result = await loop._run_tests()

        assert (result.executed, result.passed) == (True, False)
        assert result.error == "Timeout after 0.5s"

    async def test_a_suite_that_cannot_start_is_reported(self, loop, monkeypatch):
        loop.project_dir = loop.project_dir / "missing"

        result = await loop._run_tests()

        assert result.executed is False and result.error

    async def test_no_command_is_not_a_run(self, loop):
        loop.test_info = _discovered("")

        result = await loop._run_tests()

        assert (result.executed, result.error) == (False, "No test command available")


@pytest.mark.parametrize(
    ("output", "counts"),
    [
        # pytest prints failures first: the old pattern read 0 failures here.
        ("===== 2 failed, 5 passed in 0.31s =====", (7, 2)),
        ("1 failed, 3 passed, 1 error in 2.0s", (5, 2)),
        ("5 passed, 2 failed", (7, 2)),
        ("collected 3 items\n3 passed in 0.1s", (3, 0)),
        ("Tests: 2 failed, 1 skipped, 5 passed, 8 total", (8, 2)),
        ("Test Suites: 1 failed, 1 total\nTests: 5 passed, 5 total", (5, 0)),
        ("      Tests  1 failed | 3 passed (4)", (4, 1)),
        ("Some tests FAIL", (1, 1)),
        ("ran the spec", (1, 0)),
        ("compiled", (0, 0)),
    ],
)
def test_the_counts_are_read_from_the_summary(loop, output, counts):
    assert loop._parse_test_counts(output) == counts


@pytest.mark.parametrize(
    ("output", "pattern"),
    [
        ("AssertionError: expected 2", "assertion_failure"),
        ("Timeout of 2000ms exceeded", "timeout"),
        ("SyntaxError: invalid", "syntax_error"),
        ("ImportError: cannot", "import_error"),
        ("TypeError: x is not a function", "type_error"),
        ("ReferenceError: foo is not defined", "undefined_error"),
        ("got null", "null_pointer"),
        ("exit 3", "general_failure"),
    ],
)
def test_the_failure_gets_a_pattern(loop, output, pattern):
    result = AutoFixTestResult(
        executed=True, passed=False, output=output, error=None, duration=0.0
    )
    assert loop._analyze_failure(result) == pattern


def test_a_long_output_keeps_its_end_in_the_request(loop, qa_spec):
    output = "x" * 30_000 + "THE FAILURE"
    result = AutoFixTestResult(
        executed=True, passed=False, output=output, error=None, duration=1.0
    )

    loop._create_fix_request(result, "general_failure", "")

    request = (qa_spec / "QA_FIX_REQUEST.md").read_text(encoding="utf-8")
    assert "[... earlier output cut ...]" in request
    assert request.endswith("") and "THE FAILURE" in request
    assert len(request) < 25_000


def test_an_escalation_that_cannot_be_written_is_only_logged(loop, qa_spec):
    (qa_spec / "AUTO_FIX_ESCALATION.md").mkdir()

    loop._escalate_to_human()  # no attempts, no file: nothing raised
