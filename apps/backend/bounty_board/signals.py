"""
Bounty Board — deterministic evidence about what a contestant actually produced.

Nothing here calls a model or the network. Everything is measured from the
contestant's worktree: what the diff contains, and what the project's own test
command says about it. That is the whole point — a judge that scores prose can
be fooled by prose, and the previous one was: it read the length of the
contestant's answer and the rank of its latency, so the contest was decided by
how many characters the model's *name* happened to have.

Two rules govern every function below, and they are the ones that keep a score
honest:

* **A signal with no evidence is `None`, never zero.** A project with no test
  command has not failed its tests. `judge.py` renormalises the weights over
  the signals that were actually measured, the same way `validate_pkg` reports
  coverage as *not applicable* rather than 0% on a spec that declares no ids.
* **The measurement is reported with its provenance.** Every `Evidence` carries
  the command that produced it and why a signal is missing, because a number
  whose origin nobody can check is how the previous board stayed wrong for so
  long.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
import signal
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

# How long the project's own test suite may run, per contestant. A suite that
# has not answered by then is reported `timeout` — which is not a failure the
# contestant caused, so the judge treats it as no evidence rather than as 0.
DEFAULT_TEST_TIMEOUT_S = 900


@dataclass
class DiffEvidence:
    """What the contestant changed, measured against the branch it started from."""

    files_changed: int = 0
    insertions: int = 0
    deletions: int = 0
    available: bool = False
    unavailable_reason: str | None = None
    patch: str = ""

    @property
    def is_empty(self) -> bool:
        """True when the contestant produced no change at all."""
        return self.files_changed == 0 and self.insertions == 0 and self.deletions == 0


@dataclass
class TestEvidence:
    """What the project's own test command said about the contestant's worktree."""

    # passed | failed | timeout | no-command | no-change | skipped | error
    status: str = "no-command"
    command: str | None = None
    passed: int = 0
    failed: int = 0
    exit_code: int | None = None
    output_tail: str = ""

    @property
    def conclusive(self) -> bool:
        """Whether this ran to a verdict the judge may score.

        `timeout`, `no-command`, `no-change`, `skipped` and `error` all mean
        "we do not know", and the judge must not read any of them as a
        contestant failing its tests.
        """
        return self.status in ("passed", "failed")


@dataclass
class Evidence:
    """Everything measurable about one contestant's worktree."""

    diff: DiffEvidence = field(default_factory=DiffEvidence)
    tests: TestEvidence = field(default_factory=TestEvidence)

    def to_dict(self) -> dict:
        payload = {"diff": asdict(self.diff), "tests": asdict(self.tests)}
        # The patch is the judge's input, not the UI's: it can be megabytes and
        # the archive on disk is read back by the Kanban.
        payload["diff"].pop("patch", None)
        return payload


# ─── git ───────────────────────────────────────────────────────────────────────


def _run_git(
    args: list[str], cwd: Path, timeout: int = 60
) -> subprocess.CompletedProcess:
    """Run git in `cwd`. Never raises — a git that is absent is an unavailable
    signal, not a crash in the middle of judging."""
    try:
        return subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("git %s failed in %s: %s", " ".join(args), cwd, exc)
        return subprocess.CompletedProcess(
            args, returncode=127, stdout="", stderr=str(exc)
        )


def is_git_repo(path: Path) -> bool:
    """Whether `path` sits inside a git work tree."""
    result = _run_git(["rev-parse", "--is-inside-work-tree"], cwd=path)
    return result.returncode == 0 and result.stdout.strip() == "true"


def collect_diff(
    worktree: Path, base_ref: str, *, max_patch_bytes: int = 200_000
) -> DiffEvidence:
    """Measure what the contestant changed in `worktree` since `base_ref`.

    Both committed and uncommitted work counts: a contestant that edited files
    and never committed still did the work, and scoring it zero would reward
    the habit of committing over the habit of being right.
    """
    if not worktree.exists():
        return DiffEvidence(unavailable_reason=f"worktree missing: {worktree}")
    if not is_git_repo(worktree):
        return DiffEvidence(unavailable_reason="not a git worktree")

    # `git add -A -N` registers new files as intent-to-add so that `git diff`
    # shows them. Without it a contestant that only created files reads as an
    # empty diff — the single worst way this could be unfair.
    _run_git(["add", "-A", "-N"], cwd=worktree)

    stat = _run_git(["diff", "--shortstat", base_ref], cwd=worktree)
    if stat.returncode != 0:
        return DiffEvidence(
            unavailable_reason=f"git diff against {base_ref} failed: {stat.stderr.strip()[:200]}"
        )

    evidence = DiffEvidence(available=True)
    text = stat.stdout
    if match := re.search(r"(\d+) files? changed", text):
        evidence.files_changed = int(match.group(1))
    if match := re.search(r"(\d+) insertions?", text):
        evidence.insertions = int(match.group(1))
    if match := re.search(r"(\d+) deletions?", text):
        evidence.deletions = int(match.group(1))

    patch = _run_git(["diff", base_ref], cwd=worktree, timeout=120)
    if patch.returncode == 0:
        evidence.patch = patch.stdout[:max_patch_bytes]

    return evidence


# ─── tests ─────────────────────────────────────────────────────────────────────


def discover_test_command(project_dir: Path) -> str | None:
    """The test command this project declares for itself.

    Read from the project's own CI configuration via `analysis.ci_discovery`,
    which already answers this question for the QA loop. Guessing a second
    answer here is how a repository ends up with two detectors that disagree.
    """
    try:
        from analysis.ci_discovery import get_ci_test_commands
    except ImportError:  # pragma: no cover - analysis package always present in-app
        logger.debug("analysis.ci_discovery unavailable; no test command")
        return None

    try:
        commands = get_ci_test_commands(project_dir) or {}
    except Exception:  # noqa: BLE001 - discovery must never break judging
        logger.debug("CI discovery failed for %s", project_dir, exc_info=True)
        return None

    # Prefer the unit suite: it is the one that runs in a worktree without a
    # database, a browser or a deployed environment behind it.
    for key in ("unit", "test", "backend", "frontend", "default"):
        if command := (commands.get(key) or "").strip():
            return command
    for command in commands.values():
        if command and command.strip():
            return command.strip()
    return None


def _parse_test_counts(output: str) -> tuple[int, int]:
    """Extract (passed, failed) from common test-runner output."""
    # pytest: "5 passed, 2 failed" in either order
    passed = failed = 0
    if match := re.search(r"(\d+) passed", output):
        passed = int(match.group(1))
    if match := re.search(r"(\d+) failed", output):
        failed = int(match.group(1))
    if passed or failed:
        return passed, failed

    # vitest / jest: "Tests  3 failed | 12 passed (15)"
    if match := re.search(r"Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed", output):
        return int(match.group(2)), int(match.group(1) or 0)

    # dotnet test: "Passed! - Failed: 0, Passed: 12"
    if match := re.search(r"Failed:\s*(\d+),\s*Passed:\s*(\d+)", output):
        return int(match.group(2)), int(match.group(1))

    return 0, 0


async def run_tests(
    worktree: Path,
    command: str | None,
    *,
    timeout_s: int = DEFAULT_TEST_TIMEOUT_S,
) -> TestEvidence:
    """Run the project's own test command inside the contestant's worktree.

    The exit code is the verdict — the parsed counts are for the reader, never
    for the pass/fail decision, because a suite whose format nobody here
    recognises would otherwise silently read as "0 passed, 0 failed" and look
    like a failure.

    **This executes a shell script, and it has to.** What `discover_test_command`
    returns is a CI `run:` block, which is a script and not an argv list — in
    this repository it is ``source .venv/bin/activate`` followed by ``pytest``.
    Splitting that into arguments would run `source` with pytest's flags and
    measure nothing. `qa/auto_fix_loop._run_tests` reached the same conclusion
    and uses the same call; running the project's declared test command is one
    question, and two answers to it would drift.

    The trust boundary is therefore the project the user asked WorkPilot to
    build, which is the boundary every agent phase already works inside. This
    is not safer than `subprocess.run(shell=True)` — it is the same shell — it
    is the house pattern for this operation, and it does not block the event
    loop for the length of a test suite, which the synchronous version did.
    """
    if not command:
        return TestEvidence(status="no-command")
    if not worktree.exists():
        return TestEvidence(
            status="error", command=command, output_tail="worktree missing"
        )

    # A contestant's suite must not inherit the bounty's own provider
    # selection: a test that reads SELECTED_LLM_PROVIDER would see the judge's
    # configuration rather than the project's.
    env = {k: v for k, v in os.environ.items() if k != "SELECTED_LLM_PROVIDER"}

    try:
        process = await asyncio.create_subprocess_shell(
            command,
            cwd=str(worktree),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            # Its own process group, so a suite that spawns a dev server or a
            # database is killed with it below. Without this a timeout reaps
            # the shell and leaves its children holding the ports the next
            # contestant's suite needs.
            start_new_session=os.name != "nt",
        )
    except (OSError, ValueError) as exc:
        return TestEvidence(
            status="error", command=command, output_tail=str(exc)[:2000]
        )

    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(), timeout=timeout_s
        )
    except (TimeoutError, asyncio.TimeoutError):
        _terminate_process_tree(process)
        with contextlib.suppress(Exception):
            await process.wait()
        return TestEvidence(status="timeout", command=command)

    output = stdout.decode("utf-8", "replace") + stderr.decode("utf-8", "replace")
    passed, failed = _parse_test_counts(output)
    return TestEvidence(
        status="passed" if process.returncode == 0 else "failed",
        command=command,
        passed=passed,
        failed=failed,
        exit_code=process.returncode,
        output_tail=output[-4000:],
    )


def _terminate_process_tree(process: asyncio.subprocess.Process) -> None:
    """Kill the test suite and anything it started."""
    if os.name != "nt":
        with contextlib.suppress(OSError, ProcessLookupError):
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            return
    with contextlib.suppress(OSError, ProcessLookupError):
        process.kill()


async def collect_evidence(
    worktree: Path,
    base_ref: str,
    test_command: str | None,
    *,
    run_test_suite: bool = True,
    timeout_s: int = DEFAULT_TEST_TIMEOUT_S,
) -> Evidence:
    """Everything measurable about one contestant, in one call."""
    diff = collect_diff(worktree, base_ref)

    if not run_test_suite:
        return Evidence(
            diff=diff, tests=TestEvidence(status="skipped", command=test_command)
        )

    # A measured, empty diff means there is nothing the suite could be about:
    # running it would measure the base branch and hand every do-nothing
    # contestant a clean pass. When the diff could not be measured at all we
    # still run, because the contestant may well have written files.
    if diff.available and diff.is_empty:
        return Evidence(
            diff=diff, tests=TestEvidence(status="no-change", command=test_command)
        )

    return Evidence(
        diff=diff, tests=await run_tests(worktree, test_command, timeout_s=timeout_s)
    )
