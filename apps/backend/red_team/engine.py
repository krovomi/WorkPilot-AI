"""The red team run: attack tests written in a throwaway copy, then run by WorkPilot.

1. The attack surface of the diff (``surface``). No source line: nothing to
   attack, status ``none``.
2. A scratch copy of the worktree (``mutation_gate.sandbox``): nothing written
   during the run can reach the task's branch.
3. **Attack**: a session (any provider, handed in by the caller) writes attack
   tests in the project's own test framework and lists them in
   ``red-team-attacks.json``. Every non-test file it changed is put back as it
   was: an attack that edits the code it attacks proves nothing. **Replay**:
   the attack files of the previous run are written back instead, without a
   model (regression hunting, on each later QA pass).
4. WorkPilot runs the attack tests itself, never trusting what the session
   said: the stack's runner with its machine report where there is one
   (``suite_runner``), the attack's file alone elsewhere. A failure is
   run a second time; one that does not fail again is flaky and dropped.
5. ``fail`` when an attack crashed the changed code (``reports.classify``),
   ``pass`` when attacks ran and none did, ``unknown`` when none could run.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import tempfile
import time
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath

from foundation.git_executable import run_git
from mutation_gate.commands import command_for_tests, project_root
from mutation_gate.sandbox import scratch_copy
from mutation_gate.scope import is_test_path

from .payloads import MODES
from .prompt import build_prompt
from .reports import (
    CRASH,
    RESISTANT,
    UNEXPECTED,
    TestResult,
    classify,
    find_result,
    parse_cargo_output,
    read_reports,
)
from .surface import Surface, attack_surface

__all__ = [
    "MANIFEST",
    "Attack",
    "RedTeamReport",
    "Session",
    "run_red_team",
]

MANIFEST = "red-team-attacks.json"
MAX_ATTACKS = 12
MAX_ATTACK_FILES = 12
MAX_ATTACK_FILE_BYTES = 64 * 1024
NOT_RUN = "not_run"
FLAKY = "flaky"

PASS, FAIL, UNKNOWN, NONE = "pass", "fail", "unknown", "none"

#: ``(copy, prompt) -> None``: one agent session whose project is the copy.
Session = Callable[[Path, str], Awaitable[object]]

# What a session of any provider raises when it cannot run.
_SESSION_ERRORS = (
    ImportError,
    OSError,
    RuntimeError,
    TimeoutError,
    TypeError,
    ValueError,
)
_SAFE_PATH = re.compile(r"[A-Za-z0-9_./@+-]+")
_TEXT_LIMIT = 500

_COMMAND_FOR_SUFFIX = {
    ".py": ("pytest",),
    ".js": ("vitest", "jest"), ".jsx": ("vitest", "jest"), ".mjs": ("vitest", "jest"),
    ".cjs": ("vitest", "jest"), ".ts": ("vitest", "jest"), ".tsx": ("vitest", "jest"),
    ".mts": ("vitest", "jest"), ".cts": ("vitest", "jest"),
    ".cs": ("dotnet",), ".fs": ("dotnet",), ".vb": ("dotnet",),
    ".java": ("maven", "gradle"), ".kt": ("gradle", "maven"), ".kts": ("gradle",),
    ".groovy": ("gradle",), ".scala": ("maven", "gradle"),
    ".go": ("go",),
}  # fmt: skip
_NARROWED = {"pytest", "vitest", "jest"}


@dataclass
class Attack:
    id: str
    mode: str
    test: str
    file: str
    target: str = ""
    input: str = ""
    expect: str = ""
    outcome: str = NOT_RUN
    detail: str = ""


@dataclass
class RedTeamReport:
    status: str = UNKNOWN
    reason: str = ""
    base: str = ""
    #: ``attack`` (a session wrote the tests) or ``replay`` (the previous ones).
    run: str = "attack"
    attacks: list[Attack] = field(default_factory=list)
    warnings: list[dict] = field(default_factory=list)
    targets: list[dict] = field(default_factory=list)
    #: The attack files, by path: what a replay writes back.
    files: dict[str, str] = field(default_factory=dict)
    restored: list[str] = field(default_factory=list)
    duration_s: float = 0.0
    finished_at: float = 0.0

    def count(self, outcome: str) -> int:
        return sum(1 for a in self.attacks if a.outcome == outcome)

    @property
    def crashes(self) -> list[Attack]:
        return [a for a in self.attacks if a.outcome == CRASH]

    def to_dict(self) -> dict:
        data = asdict(self)
        data["counts"] = {
            "crash": self.count(CRASH),
            "unexpected": self.count(UNEXPECTED),
            "resistant": self.count(RESISTANT),
            "warning": len(self.warnings),
            "not_run": self.count(NOT_RUN) + self.count(FLAKY),
        }
        return data


# --- the copy ---------------------------------------------------------------


def _status(copy: Path) -> dict[str, str]:
    """``{path: sha256}`` of every file git sees as changed or new in the copy."""
    listed = run_git(["status", "--porcelain", "-z", "--untracked-files=all"], cwd=copy)
    if listed.returncode != 0:
        raise OSError("git status failed in the red team copy")
    state: dict[str, str] = {}
    entries = listed.stdout.split("\0")
    skip = False
    for entry in entries:
        if skip:
            skip = False
            continue
        if len(entry) < 4:
            continue
        code, path = entry[:2], entry[3:]
        if "R" in code or "C" in code:
            skip = True  # the next entry is the rename's source
        state[path] = _digest(copy / path)
    return state


def _digest(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return "missing"


def _written(before: dict[str, str], after: dict[str, str]) -> list[str]:
    return sorted(p for p, digest in after.items() if before.get(p) != digest)


def _restore(project_dir: Path, copy: Path, path: str) -> None:
    """Put ``path`` back as the task left it: its content in the worktree, or nothing."""
    source = project_dir / path
    target = copy / path
    if source.is_file() and not source.is_symlink():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
    elif target.is_file() or target.is_symlink():
        target.unlink()


def _safe_relative(path: str) -> str | None:
    norm = path.replace("\\", "/").removeprefix("./")
    pure = PurePosixPath(norm)
    if not norm or pure.is_absolute() or ".." in pure.parts or ":" in norm:
        return None
    return pure.as_posix()


def _text(value: object) -> str:
    return str(value or "").strip()[:_TEXT_LIMIT]


def _read_manifest(copy: Path, written: set[str]) -> list[Attack]:
    path = copy / MANIFEST
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    finally:
        path.unlink(missing_ok=True)
    entries = data.get("attacks") if isinstance(data, dict) else data
    attacks: list[Attack] = []
    for raw in entries if isinstance(entries, list) else []:
        if not isinstance(raw, dict):
            continue
        file = _safe_relative(_text(raw.get("file")))
        test = _text(raw.get("test"))[:200]
        if not file or not test or file not in written:
            continue
        mode = _text(raw.get("mode")).lower()
        attacks.append(
            Attack(
                id=f"a{len(attacks) + 1}",
                mode=mode if mode in MODES else "fuzz",
                test=test,
                file=file,
                target=_text(raw.get("target")),
                input=_text(raw.get("input")),
                expect=_text(raw.get("expect")),
            )
        )
        if len(attacks) >= MAX_ATTACKS:
            break
    return attacks


def _keep_files(copy: Path, attacks: list[Attack]) -> dict[str, str]:
    files: dict[str, str] = {}
    for attack in attacks:
        if attack.file in files or len(files) >= MAX_ATTACK_FILES:
            continue
        try:
            data = (copy / attack.file).read_bytes()
        except OSError:
            continue
        if len(data) <= MAX_ATTACK_FILE_BYTES:
            files[attack.file] = data.decode("utf-8", errors="replace")
    return files


def _write_back(copy: Path, files: dict[str, str]) -> list[str]:
    written = []
    for raw, content in files.items():
        path = _safe_relative(raw)
        if path is None or not is_test_path(path):
            continue
        target = copy / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        written.append(path)
    return written


# --- running the attacks ----------------------------------------------------


def _localise(copy: Path, root: Path, files: list[str]) -> list[str]:
    prefix = root.relative_to(copy).as_posix()
    if prefix == ".":
        return list(files)
    return [f[len(prefix) + 1 :] for f in files if f.startswith(prefix + "/")]


def _run_reported(copy: Path, root: Path, files: list[str], timeout: float):
    from suite_runner.runs import TestCommand, detect_test_commands, run_once

    suffix = PurePosixPath(files[0]).suffix.lower()
    wanted = _COMMAND_FOR_SUFFIX.get(suffix, ())
    command = next((c for c in detect_test_commands(root) if c.id in wanted), None)
    if command is None:
        return None
    local = _localise(copy, root, files)
    if (
        command.id in _NARROWED
        and local
        and all(_SAFE_PATH.fullmatch(p) for p in local)
    ):
        command = TestCommand(
            command.id, command.label, f"{command.command} {' '.join(local)}"
        )
    with tempfile.TemporaryDirectory(prefix="workpilot-red-team-") as out:
        outcome = run_once(command, root, Path(out), timeout_s=timeout)
        results = read_reports(outcome.reports)
        if not results and (outcome.error or outcome.timed_out):
            raise OSError(outcome.error or "the test run timed out")
        return results


def _run_console(copy: Path, file: str, attacks: list[Attack], timeout: float):
    """A stack without a machine report: the attack file alone, its exit code."""
    from security.child_env import env_without_credentials

    found = command_for_tests(copy, file, [file])
    if found is None:
        raise OSError(f"no test command for {file}")
    argv, cwd = found
    try:
        done = subprocess.run(  # noqa: S603 - argv list, no shell
            argv,
            cwd=str(cwd),
            env=env_without_credentials(extra={"CI": "1", "NO_COLOR": "1"}),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise OSError(f"the test run failed to complete: {exc}") from exc
    output = (done.stdout or "") + "\n" + (done.stderr or "")
    cargo = parse_cargo_output(output)
    if cargo:
        return cargo
    if done.returncode == 0:
        return [TestResult(a.test, True) for a in attacks]
    tail = output[-4000:]
    return [TestResult(a.test, False, tail) for a in attacks if a.test in output]


def _run(copy: Path, attacks: list[Attack], timeout: float) -> list[TestResult]:
    results: list[TestResult] = []
    by_root: dict[Path, list[str]] = {}
    for attack in attacks:
        root = project_root(copy, attack.file)
        files = by_root.setdefault(root, [])
        if attack.file not in files:
            files.append(attack.file)
    for root, files in by_root.items():
        by_suffix: dict[str, list[str]] = {}
        for f in files:
            by_suffix.setdefault(PurePosixPath(f).suffix.lower(), []).append(f)
        for group in by_suffix.values():
            reported = _run_reported(copy, root, group, timeout)
            if reported is not None:
                results += reported
                continue
            for f in group:
                results += _run_console(
                    copy, f, [a for a in attacks if a.file == f], timeout
                )
    return results


def _judge(
    attacks: list[Attack], results: list[TestResult], sources: list[str]
) -> None:
    for attack in attacks:
        result = find_result(attack.test, results)
        if result is None:
            attack.outcome, attack.detail = (
                NOT_RUN,
                "the runner did not report this test",
            )
            continue
        attack.outcome = classify(result, sources)
        attack.detail = "" if result.passed else result.message[:1500]


# --- the run ----------------------------------------------------------------


async def run_red_team(
    project_dir: Path,
    base: str,
    files: list[str],
    *,
    session: Session | None,
    previous: dict | None = None,
    run_timeout: float = 600.0,
) -> RedTeamReport:
    """Attack (or replay ``previous``) the diff of ``files`` against ``base``. Never raises."""
    started = time.monotonic()
    project_dir = Path(project_dir).resolve()
    report = RedTeamReport(base=base)
    try:
        await _run_in_copy(
            project_dir, base, files, session, previous, run_timeout, report
        )
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        report.status, report.reason = (
            UNKNOWN,
            f"the red team could not run: {exc}"[:300],
        )
    report.duration_s = round(time.monotonic() - started, 1)
    report.finished_at = time.time()
    return report


async def _run_in_copy(
    project_dir, base, files, session, previous, timeout, report
) -> None:
    surface: Surface = attack_surface(project_dir, base, files)
    report.warnings = surface.warnings
    report.targets = [t.to_dict() for t in surface.targets]
    if not surface.targets:
        report.status, report.reason = NONE, "no source line in the diff to attack"
        return
    replay = previous if previous and previous.get("files") else None
    with scratch_copy(project_dir) as copy:
        if replay is not None:
            report.run = "replay"
            written = set(_write_back(copy, dict(replay.get("files") or {})))
            report.attacks = [
                Attack(
                    **{k: v for k, v in a.items() if k in Attack.__dataclass_fields__}
                )
                for a in replay.get("attacks") or []
                if isinstance(a, dict) and a.get("file") in written
            ]
            for attack in report.attacks:
                attack.outcome, attack.detail = NOT_RUN, ""
            report.files = {
                p: replay["files"][p] for p in written if p in replay["files"]
            }
        else:
            if session is None:
                report.status, report.reason = (
                    UNKNOWN,
                    "no session to write the attacks",
                )
                return
            before = _status(copy)
            try:
                await session(copy, build_prompt(surface, copy))
            except _SESSION_ERRORS as exc:  # a gate reports, it does not abort QA
                report.status = UNKNOWN
                report.reason = f"the attack session failed: {exc}"[:300]
                return
            changed = _written(before, _status(copy))
            tests = {p for p in changed if is_test_path(p)}
            for path in changed:
                if path != MANIFEST and path not in tests:
                    _restore(project_dir, copy, path)
                    report.restored.append(path)
            report.attacks = _read_manifest(copy, tests)
            report.files = _keep_files(copy, report.attacks)
        if not report.attacks:
            report.status = UNKNOWN
            report.reason = (
                "the previous attacks could not be written back"
                if replay
                else "the session wrote no attack test listed in " + MANIFEST
            )
            return
        _judge(report.attacks, _run(copy, report.attacks, timeout), surface.sources)
        failing = [a for a in report.attacks if a.outcome in (CRASH, UNEXPECTED)]
        if failing:
            again: list[Attack] = [Attack(**asdict(a)) for a in failing]
            _judge(again, _run(copy, again, timeout), surface.sources)
            for first, second in zip(failing, again, strict=True):
                if second.outcome != first.outcome:
                    first.outcome = FLAKY
                    first.detail = "did not fail the same way twice"
    crashed = report.count(CRASH)
    ran = crashed + report.count(UNEXPECTED) + report.count(RESISTANT)
    if crashed:
        report.status = FAIL
        report.reason = f"{crashed} attack(s) crashed the changed code"
    elif ran:
        report.status = PASS
        report.reason = f"{ran} attack(s) ran, none crashed the changed code"
    else:
        report.status = UNKNOWN
        report.reason = "no attack test could be run"
