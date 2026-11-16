"""Find the first commit where a test broke, between the last green and the red (#375).

``git bisect run`` driven from Python, so that every step is bounded and
reported, and so that it never touches the person's working copy:

1. Both commits are checked: hexadecimal ids only (:func:`is_commit_sha`),
   resolved by git, the green one an ancestor of the red one (a rebase or a
   squash that lost it ends the bisect: ``unavailable``).
2. A temporary git worktree is added under the system temporary folder,
   detached at the red commit. The project's ignored dependency folders
   (``node_modules``, ``.venv``…) are linked into it when it has none, so the
   stack's own test command can run there.
3. The test command is the stack's (``suite_runner.detect_test_commands``:
   .NET, pytest, Vitest, Jest, node, Maven, Gradle, Go, Rust, PHP, RSpec,
   Dart, Swift), narrowed to the failing tests through the stack's filter
   when it has one, run without a shell and without the backend's
   credentials (``suite_runner.run_once``).
4. The red commit is run :attr:`BisectBudget.flaky_runs` times: a pass among
   them is a flaky test, and a bisect on a flaky test finds noise (``flaky``).
   The green commit must pass in the clean checkout (``good_fails`` otherwise:
   the environment, not a commit, is what breaks).
5. Binary search over ``git rev-list --first-parent good..bad``. A commit that
   cannot be tested (no test selected, a timeout, a command that does not
   start) is skipped and its neighbour tried; when only skipped commits are
   left, the culprit is one of them (``ambiguous``).
6. The worktree is removed, whatever happened.

Bounded: at most :attr:`BisectBudget.max_runs` test runs and
:attr:`BisectBudget.max_seconds` in all (``budget`` when exceeded, with the
range still open). Results are cached by range and tests, so a regression
that breaks several tests is bisected once.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import time
from collections.abc import Callable, Sequence
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from foundation.file_utils import write_json_atomic
from suite_runner.runs import RunOutcome, TestCommand, detect_test_commands, run_once

from .triggers import git, is_commit_sha

logger = logging.getLogger(__name__)

__all__ = [
    "BisectBudget",
    "BisectResult",
    "BisectStep",
    "CACHE_FILE",
    "run_bisect",
]

CACHE_FILE = Path(".workpilot") / "self-healing" / "bisect_cache.json"
_MAX_CACHE = 50
#: Ignored folders a clean checkout lacks and the test command needs.
LINKED_DEPENDENCIES = ("node_modules", ".venv", "venv", "vendor", "packages")
_UNSELECTABLE = "the tests named cannot be selected"
_GIT_TIMEOUT = 120


@dataclass(frozen=True)
class BisectBudget:
    max_runs: int = 16
    max_seconds: float = 1800.0
    run_timeout: float = 600.0
    flaky_runs: int = 3


@dataclass
class BisectStep:
    sha: str
    outcome: str  # good | bad | skip
    role: str  # bad-check | flaky-check | good-check | search
    seconds: float = 0.0
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "sha": self.sha,
            "outcome": self.outcome,
            "role": self.role,
            "seconds": round(self.seconds, 1),
            "detail": self.detail,
        }


@dataclass
class BisectResult:
    #: found | ambiguous | flaky | not_reproduced | good_fails | budget |
    #: unavailable
    status: str
    good: str = ""
    bad: str = ""
    first_bad: str = ""
    first_bad_subject: str = ""
    #: When the search could not narrow to one commit: the commits left.
    candidates: list[str] = field(default_factory=list)
    steps: list[BisectStep] = field(default_factory=list)
    commits_in_range: int = 0
    command: str = ""
    narrowed: bool = False
    reason: str = ""
    cached: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "good": self.good,
            "bad": self.bad,
            "first_bad": self.first_bad,
            "first_bad_subject": self.first_bad_subject,
            "candidates": self.candidates,
            "steps": [s.to_dict() for s in self.steps],
            "tested": len(self.steps),
            "commits_in_range": self.commits_in_range,
            "command": self.command,
            "narrowed": self.narrowed,
            "reason": self.reason,
            "cached": self.cached,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> BisectResult:
        steps = [
            BisectStep(
                sha=str(s.get("sha", "")),
                outcome=str(s.get("outcome", "")),
                role=str(s.get("role", "")),
                seconds=float(s.get("seconds", 0) or 0),
                detail=str(s.get("detail", "")),
            )
            for s in data.get("steps") or []
            if isinstance(s, dict)
        ]
        return cls(
            status=str(data.get("status", "")),
            good=str(data.get("good", "")),
            bad=str(data.get("bad", "")),
            first_bad=str(data.get("first_bad", "")),
            first_bad_subject=str(data.get("first_bad_subject", "")),
            candidates=[str(c) for c in data.get("candidates") or []],
            steps=steps,
            commits_in_range=int(data.get("commits_in_range", 0) or 0),
            command=str(data.get("command", "")),
            narrowed=bool(data.get("narrowed", False)),
            reason=str(data.get("reason", "")),
            cached=bool(data.get("cached", False)),
        )


StepCallback = Callable[[BisectStep, int], None]


def _resolve(project: Path, sha: str) -> str:
    out = git(project, ["rev-parse", "--verify", "--quiet", f"{sha}^{{commit}}"])
    full = (out or "").strip()
    return full if is_commit_sha(full) else ""


def _cache_key(good: str, bad: str, tests: Sequence[str]) -> str:
    return f"{good}..{bad}|{','.join(sorted(set(tests)))}"


def _read_cache(project: Path) -> dict[str, Any]:
    try:
        data = json.loads((project / CACHE_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_cache(project: Path, key: str, result: BisectResult) -> None:
    data = _read_cache(project)
    data.pop(key, None)
    data[key] = result.to_dict()
    while len(data) > _MAX_CACHE:
        data.pop(next(iter(data)))
    try:
        (project / CACHE_FILE).parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(project / CACHE_FILE, data)
    except OSError as exc:
        logger.debug("bisect cache not written: %s", exc)


class _Checkout:
    """A temporary worktree of ``project``, detached, removed on exit."""

    def __init__(self, project: Path, sha: str):
        self.project = project
        self.sha = sha
        self.root = Path(tempfile.mkdtemp(prefix="workpilot-bisect-"))
        self.path = self.root / "checkout"
        self.linked: list[str] = []

    def __enter__(self) -> _Checkout:
        out = git(
            self.project,
            ["worktree", "add", "--detach", "--force", str(self.path), self.sha],
            timeout=_GIT_TIMEOUT,
        )
        if out is None or not self.path.is_dir():
            self.close()
            raise OSError("git could not add a temporary worktree")
        for name in LINKED_DEPENDENCIES:
            source, target = self.project / name, self.path / name
            if source.is_dir() and not target.exists():
                try:
                    os.symlink(source, target, target_is_directory=True)
                    self.linked.append(name)
                except OSError:
                    logger.debug("could not link %s into the bisect checkout", name)
        return self

    def checkout(self, sha: str) -> bool:
        if git(self.path, ["checkout", "--detach", "--force", "--quiet", sha]) is None:
            return False
        excludes = [arg for name in self.linked for arg in ("-e", name)]
        git(self.path, ["clean", "-fdq", *excludes])
        return True

    def close(self) -> None:
        for name in self.linked:
            # The links go first, so that nothing below follows one.
            with suppress(OSError):
                (self.path / name).unlink()
        git(
            self.project,
            ["worktree", "remove", "--force", str(self.path)],
            timeout=_GIT_TIMEOUT,
        )
        shutil.rmtree(self.root, ignore_errors=True)
        git(self.project, ["worktree", "prune"])

    def __exit__(self, *_exc: object) -> None:
        self.close()


class _Search:
    """The runs of one bisect, against its budget."""

    def __init__(
        self,
        checkout: _Checkout,
        command: TestCommand,
        failing: Sequence[str],
        budget: BisectBudget,
        out_dir: Path,
        on_step: StepCallback | None,
        runner: Callable[..., RunOutcome],
    ):
        self.checkout = checkout
        self.command = command
        self.failing = list(failing)
        self.narrow = bool(self.failing)
        self.budget = budget
        self.out_dir = out_dir
        self.on_step = on_step
        self.runner = runner
        self.started = time.monotonic()
        self.steps: list[BisectStep] = []

    def exhausted(self) -> bool:
        return (
            len(self.steps) >= self.budget.max_runs
            or time.monotonic() - self.started >= self.budget.max_seconds
        )

    def _run(self) -> RunOutcome:
        remaining = self.budget.max_seconds - (time.monotonic() - self.started)
        timeout = max(1.0, min(self.budget.run_timeout, remaining))
        out = self.out_dir / f"run-{len(self.steps):02d}"
        outcome = self.runner(
            self.command,
            self.checkout.path,
            out,
            timeout_s=timeout,
            only=self.failing if self.narrow else (),
        )
        if self.narrow and outcome.error.startswith(_UNSELECTABLE):
            self.narrow = False
            outcome = self.runner(
                self.command, self.checkout.path, out, timeout_s=timeout
            )
        return outcome

    def _verdict(self, outcome: RunOutcome) -> tuple[str, str]:
        if outcome.error:
            return "skip", outcome.error[:200]
        if outcome.timed_out or outcome.exit_code is None:
            return "skip", "timed out"
        if outcome.exit_code == 0:
            return "good", ""
        if self.command.id == "pytest" and outcome.exit_code == 5:
            return "skip", "no test selected at this commit"
        return "bad", f"exit code {outcome.exit_code}"

    def test(self, sha: str, role: str) -> str:
        started = time.monotonic()
        if not self.checkout.checkout(sha):
            verdict, detail = "skip", "checkout failed"
        else:
            verdict, detail = self._verdict(self._run())
        step = BisectStep(sha, verdict, role, time.monotonic() - started, detail)
        self.steps.append(step)
        if self.on_step is not None:
            self.on_step(step, len(self.steps))
        return verdict


def _subject(project: Path, sha: str) -> str:
    return (git(project, ["show", "-s", "--format=%s", sha]) or "").strip()[:200]


def _search(search: _Search, commits: list[str], result: BisectResult) -> None:
    """Binary search; ``commits[-1]`` is known bad, the commit before ``commits[0]`` good."""
    lo, hi = -1, len(commits) - 1
    skipped: set[int] = set()
    while hi - lo > 1:
        middle = (lo + hi) // 2
        untested = [i for i in range(lo + 1, hi) if i not in skipped]
        if not untested:
            result.status = "ambiguous"
            result.candidates = commits[lo + 1 : hi + 1]
            result.reason = "the commits left could not be tested"
            return
        if search.exhausted():
            result.status = "budget"
            result.candidates = commits[lo + 1 : hi + 1]
            result.reason = "the bisect budget ran out before one commit was left"
            return
        index = min(untested, key=lambda i: (abs(i - middle), i))
        verdict = search.test(commits[index], "search")
        if verdict == "good":
            lo = index
        elif verdict == "bad":
            hi = index
        else:
            skipped.add(index)
    result.status = "found"
    result.first_bad = commits[hi]


def run_bisect(
    project_dir: str | Path,
    good: str,
    bad: str,
    failing_tests: Sequence[str] = (),
    *,
    budget: BisectBudget | None = None,
    command: TestCommand | None = None,
    on_step: StepCallback | None = None,
    use_cache: bool = True,
    runner: Callable[..., RunOutcome] = run_once,
) -> BisectResult:
    """Bisect ``good..bad`` on ``failing_tests``. Never raises, never edits the working copy."""
    project = Path(project_dir)
    budget = budget or BisectBudget()
    if not (is_commit_sha(good) and is_commit_sha(bad)):
        return BisectResult("unavailable", reason="commits are named by their hex id")
    good_full, bad_full = _resolve(project, good), _resolve(project, bad)
    if not good_full or not bad_full:
        return BisectResult(
            "unavailable", good=good, bad=bad, reason="commit not found in this repo"
        )
    result = BisectResult("unavailable", good=good_full, bad=bad_full)
    if good_full == bad_full:
        result.reason = "the green and the failing commit are the same"
        return result
    if git(project, ["merge-base", "--is-ancestor", good_full, bad_full]) is None:
        result.reason = (
            "the green commit is not an ancestor of the failing one "
            "(rewritten history?)"
        )
        return result
    failing = [str(t) for t in failing_tests if t][:20]
    key = _cache_key(good_full, bad_full, failing)
    if use_cache and isinstance(cached := _read_cache(project).get(key), dict):
        hit = BisectResult.from_dict(cached)
        hit.cached = True
        return hit
    commits = (
        git(
            project,
            ["rev-list", "--first-parent", "--reverse", f"{good_full}..{bad_full}"],
        )
        or ""
    ).split()
    result.commits_in_range = len(commits)
    if not commits:
        result.reason = "no commit between the green and the failing one"
        return result

    try:
        with _Checkout(project, bad_full) as checkout:
            if command is None:
                detected = detect_test_commands(checkout.path)
                if not detected:
                    result.reason = "no test command was detected for this stack"
                    return result
                command = detected[0]
            result.command = command.command
            with tempfile.TemporaryDirectory(prefix="workpilot-bisect-runs-") as runs:
                search = _Search(
                    checkout, command, failing, budget, Path(runs), on_step, runner
                )
                _bisect(search, good_full, bad_full, commits, result)
                result.narrowed = search.narrow
                result.steps = search.steps
    except OSError as exc:
        result.status = "unavailable"
        result.reason = str(exc)[:200]
        return result
    if result.first_bad:
        result.first_bad_subject = _subject(project, result.first_bad)
    if result.status in ("found", "ambiguous", "flaky"):
        _write_cache(project, key, result)
    return result


def _bisect(
    search: _Search,
    good: str,
    bad: str,
    commits: list[str],
    result: BisectResult,
) -> None:
    if search.test(bad, "bad-check") != "bad":
        result.status = "not_reproduced"
        result.reason = (
            "the failing test passes at the failing commit in a clean checkout"
        )
        return
    for _ in range(max(search.budget.flaky_runs - 1, 0)):
        if search.test(bad, "flaky-check") == "good":
            result.status = "flaky"
            result.reason = "the test passed on a rerun of the failing commit"
            return
    if search.test(good, "good-check") != "good":
        result.status = "good_fails"
        result.reason = (
            "the green commit does not pass in a clean checkout: the environment "
            "breaks the test, not a commit"
        )
        return
    _search(search, commits, result)
