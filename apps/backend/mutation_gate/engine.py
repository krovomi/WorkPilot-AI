"""Run the mutants of the diff in a throwaway copy and score the tests.

1. The lines the task wrote (`scope.changed_lines`). A task that wrote only
   tests (the `test` workflow) mutates the sources those tests target.
2. The mutants, at most ``max_mutants``, shared across the files (the plan's
   first), spread over each file's lines.
3. In a scratch copy (`sandbox.scratch_copy`): each command runs once on the
   unmutated code and must pass, else the verdict is ``unknown``. Then each
   mutant alone, with a timeout: a failing or timed-out run killed it.
4. The score is killed / (killed + survived). ``pass`` at the threshold or
   above, ``fail`` below with the survivors, ``unknown`` when nothing could
   be measured or the time budget ran out. Never a pass by default.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import signal
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from foundation.git_executable import run_git
from foundation.platform import is_windows
from foundation.touched_tests import map_tests

from .commands import command_for_tests, project_root
from .mutator import Mutant, mutants_for
from .native import native_plan
from .sandbox import scratch_copy
from .scope import changed_lines, is_test_path

logger = logging.getLogger(__name__)

__all__ = ["MutationReport", "run_mutation_gate", "select_mutants", "targets_of_tests"]

PASS, FAIL, UNKNOWN = "pass", "fail", "unknown"
_MIN_TIMEOUT = 30.0


@dataclass
class MutationReport:
    status: str
    reason: str = ""
    threshold: int = 0
    score: int | None = None
    engine: str = "generic"
    base: str = ""
    results: list[dict] = field(default_factory=list)

    @property
    def survivors(self) -> list[dict]:
        return [r for r in self.results if r.get("outcome") == "survived"]

    def to_dict(self) -> dict:
        killed = sum(1 for r in self.results if r.get("outcome") == "killed")
        return {
            "status": self.status,
            "reason": self.reason,
            "threshold": self.threshold,
            "score": self.score,
            "engine": self.engine,
            "base": self.base,
            "killed": killed,
            "survived": len(self.survivors),
            "results": self.results,
        }


def _env() -> dict[str, str]:
    try:
        from security.child_env import env_without_credentials

        env = env_without_credentials(os.environ)
    except ImportError:  # pragma: no cover - the backend always has it
        env = dict(os.environ)
    # No watch mode, no colours, no prompt: one run, then exit.
    # No bytecode cache: a mutant of the same size written within the same
    # second would otherwise run the stale `.pyc` of the original.
    env.update(CI="1", NO_COLOR="1", FORCE_COLOR="0", PYTHONDONTWRITEBYTECODE="1")
    return env


def _kill(process: subprocess.Popen) -> None:
    if is_windows():  # pragma: no cover - Windows leg
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(process.pid)],
            capture_output=True,
            check=False,
        )
        return
    with contextlib.suppress(OSError):
        os.killpg(process.pid, signal.SIGKILL)


def run_command(argv: list[str], cwd: Path, timeout: float) -> tuple[int | None, float]:
    """The exit code (None on timeout) and the duration. No shell, ever."""
    started = time.monotonic()
    kwargs: dict = {}
    if not is_windows():
        kwargs["start_new_session"] = True  # one group: the run and its workers
    try:
        process = subprocess.Popen(
            argv,
            cwd=cwd,
            env=_env(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **kwargs,
        )
    except OSError:
        return 127, 0.0
    try:
        code = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill(process)
        with contextlib.suppress(subprocess.TimeoutExpired):
            process.wait(timeout=10)
        return None, time.monotonic() - started
    return code, time.monotonic() - started


def _stem(path: str) -> str:
    name = PurePosixPath(path).name
    for marker in (".test", ".spec", "_test", "_spec", "Tests", "Test", "Spec"):
        name = name.replace(marker, "")
    if name.startswith("test_"):
        name = name[5:]
    return name.split(".")[0].lower()


def targets_of_tests(tests: list[str], repo_files: list[str]) -> list[str]:
    """The sources the changed tests are the tests of (by the conventions)."""
    stems = {_stem(t) for t in tests}
    candidates = [
        f
        for f in repo_files
        if not is_test_path(f) and PurePosixPath(f).stem.lower() in stems
    ]
    mapping, _ = map_tests(candidates, repo_files)
    wanted = set(tests)
    return sorted(src for src, found in mapping.items() if wanted & set(found))


def select_mutants(
    candidates: dict[str, list[Mutant]], max_mutants: int, first: tuple[str, ...] = ()
) -> list[Mutant]:
    """At most ``max_mutants``: one per file in turn, spread over each file's lines."""
    order = sorted(candidates, key=lambda p: (p not in first, p))
    queues = {}
    for path in order:
        items = candidates[path]
        # Spread: take every k-th so a long file is not tested on its top only.
        step = max(1, len(items) // max(1, max_mutants))
        queues[path] = items[::step] + [m for i, m in enumerate(items) if i % step]
    chosen: list[Mutant] = []
    while len(chosen) < max_mutants and any(queues.values()):
        for path in order:
            if queues[path] and len(chosen) < max_mutants:
                chosen.append(queues[path].pop(0))
    return chosen


def _read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _repo_files(project_dir: Path) -> list[str]:
    listed = run_git(
        ["ls-files", "--cached", "--others", "--exclude-standard"], cwd=project_dir
    )
    return listed.stdout.splitlines() if listed.returncode == 0 else []


def _all_lines(project_dir: Path, path: str) -> set[int]:
    text = _read(project_dir / path) or ""
    return set(range(1, text.count("\n") + 2)) if text else set()


def run_mutation_gate(
    project_dir: Path,
    base: str,
    files: list[str],
    *,
    threshold: int,
    max_mutants: int = 20,
    total_timeout: float = 900.0,
    first: tuple[str, ...] = (),
) -> MutationReport:
    """The gate's verdict on ``files`` (the task's change set) against ``base``."""
    project_dir = Path(project_dir).resolve()
    report = MutationReport(status=UNKNOWN, threshold=threshold, base=base)
    try:
        lines = changed_lines(project_dir, base, files)
    except OSError as exc:
        report.reason = f"the diff could not be read: {exc}"
        return report
    repo_files = _repo_files(project_dir)
    if not lines:
        tests = [f for f in files if is_test_path(f)]
        targets = targets_of_tests(tests, repo_files) if tests else []
        lines = {t: _all_lines(project_dir, t) for t in targets}
        lines = {p: s for p, s in lines.items() if s}
        if not lines:
            report.status = PASS
            report.reason = "no source line in the diff, nothing for a test to protect"
            return report
    candidates = {
        path: found
        for path, wanted in lines.items()
        if (text := _read(project_dir / path)) is not None
        and (found := mutants_for(path, text, wanted))
    }
    if not candidates:
        report.status = PASS
        report.reason = "the changed lines hold no operator to invert"
        return report
    chosen = select_mutants(candidates, max_mutants, first)
    deadline = time.monotonic() + total_timeout
    try:
        with scratch_copy(project_dir) as copy:
            _run_all(copy, chosen, repo_files, report, deadline, lines)
    except OSError as exc:
        report.status = UNKNOWN
        report.reason = f"the scratch copy could not be made: {exc}"
        return report
    return _score(report)


def _run_native(
    copy: Path, lines: dict[str, set[int]], report, deadline: float
) -> bool:
    """A native tool's results into ``report``; False to use the generic engine."""
    roots = {project_root(copy, p) for p in lines}
    if len(roots) != 1:
        return False
    root = roots.pop()
    prefix = root.relative_to(copy).as_posix()
    local = {
        (p[len(prefix) + 1 :] if prefix != "." else p): s for p, s in lines.items()
    }
    diff_file = copy.parent / "task.diff"
    diff = run_git(["diff", "--no-color", report.base, "--", *lines], cwd=copy)
    if diff.returncode == 0:
        diff_file.write_text(diff.stdout, encoding="utf-8")
    plan = native_plan(root, local, diff_file if diff.returncode == 0 else None)
    if plan is None:
        return False
    code, _ = run_command(plan.argv, root, max(60.0, deadline - time.monotonic()))
    try:
        data = json.loads((root / plan.report).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        logger.info(
            "mutation: %s wrote no report (exit %s), generic engine", plan.engine, code
        )
        return False
    results = plan.reader(data)
    if not results:
        return False
    for r in results:
        if prefix != ".":
            r["path"] = f"{prefix}/{r['path']}"
    report.engine = plan.engine
    report.results = results
    return True


def _run_all(copy, chosen, repo_files, report, deadline, lines) -> None:
    if _run_native(copy, lines, report, deadline):
        return
    commands: dict[str, tuple[list[str], Path] | None] = {}
    baselines: dict[tuple, float] = {}
    for mutant in chosen:
        if mutant.path not in commands:
            mapping, _ = map_tests([mutant.path], repo_files)
            commands[mutant.path] = command_for_tests(
                copy, mutant.path, list(mapping.get(mutant.path, ()))
            )
        found = commands[mutant.path]
        if found is None:
            report.reason = f"no test command found for {mutant.path}"
            report.results = []
            return
        argv, cwd = found
        key = (tuple(argv), str(cwd))
        if key not in baselines:
            remaining = deadline - time.monotonic()
            code, took = run_command(argv, cwd, max(1.0, remaining))
            if code != 0:
                report.reason = (
                    "the time budget ran out before the suite finished"
                    if code is None
                    else f"the tests fail before any mutation ({' '.join(argv[:3])} …, exit {code})"
                )
                report.results = []
                return
            baselines[key] = took
        if time.monotonic() >= deadline:
            report.reason = "the time budget ran out"
            report.results.append(_result(mutant, "not-run"))
            continue
        report.results.append(
            _result(mutant, _run_one(copy, mutant, argv, cwd, baselines[key], deadline))
        )


def _run_one(
    copy: Path, mutant: Mutant, argv, cwd, baseline: float, deadline: float
) -> str:
    target = copy / mutant.path
    original = target.read_bytes()
    try:
        text = original.decode("utf-8")
        target.write_bytes(mutant.apply(text).encode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return "not-run"
    _touch(target)
    try:
        timeout = min(
            max(_MIN_TIMEOUT, baseline * 3 + 10), max(1.0, deadline - time.monotonic())
        )
        code, _ = run_command(argv, cwd, timeout)
        return "killed" if code != 0 else "survived"  # a timeout (None) killed it
    finally:
        target.write_bytes(original)
        _touch(target)


_clock = [0.0]


def _touch(path: Path) -> None:
    """A new modification time on every write: caches keyed on it must rebuild."""
    _clock[0] = max(time.time(), _clock[0] + 2.0)
    with contextlib.suppress(OSError):
        os.utime(path, (_clock[0], _clock[0]))


def _result(mutant: Mutant, outcome: str) -> dict:
    return {
        "path": mutant.path,
        "line": mutant.line,
        "description": mutant.description,
        "original": mutant.original,
        "replacement": mutant.replacement,
        "outcome": outcome,
    }


def _score(report: MutationReport) -> MutationReport:
    killed = sum(1 for r in report.results if r["outcome"] == "killed")
    survived = len(report.survivors)
    if killed + survived == 0:
        report.status = UNKNOWN
        report.reason = report.reason or "no mutant could be run"
        return report
    report.score = round(100 * killed / (killed + survived))
    if any(r["outcome"] == "not-run" for r in report.results):
        report.status = UNKNOWN
        report.reason = report.reason or "some mutants could not be run"
    elif report.score >= report.threshold:
        report.status = PASS
        report.reason = f"{killed} of {killed + survived} mutants caught"
    else:
        report.status = FAIL
        report.reason = f"{survived} of {killed + survived} mutants survived the tests"
    return report
