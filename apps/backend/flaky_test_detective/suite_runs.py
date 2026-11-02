"""Run a project's tests several times and keep the reports of each run.

A flaky test is one that passes and fails on the same code. Finding one needs
several runs of the same suite, and few projects keep the report of every CI
run on the developer's disk: the detective that only read reports already
there answered "0 tests" on most projects. So the detective runs the suite
itself, N times, with the flag that makes the stack write a machine-readable
report (TRX for .NET, JUnit XML elsewhere), and keeps each run's report under
``.workpilot/flaky-tests/runs/`` so later scans see the history too.

The command is one of the stack's own, detected from the project's manifests
(never a command line from the UI). It runs without a shell, in the project's
folder, with the backend's credentials stripped from its environment, and a
timeout or a cancel takes the whole process tree (``dotnet test`` starts a
test host, ``npx`` a node).
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import time
import xml.etree.ElementTree as ET
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path

from foundation.platform import is_windows, split_command
from security.child_env import env_without_credentials

__all__ = [
    "COMMAND_IDS",
    "HISTORY_DIR",
    "RunOutcome",
    "TestCommand",
    "detect_test_commands",
    "install_cancel_handler",
    "run_once",
]

#: Where each run's reports are kept, relative to the project.
HISTORY_DIR = Path(".workpilot") / "flaky-tests" / "runs"

#: The commands the detective knows how to make write a report.
COMMAND_IDS = ("dotnet", "pytest", "vitest", "jest", "maven", "gradle", "go")

_IGNORED_DIRS = {
    "node_modules",
    ".git",
    ".venv",
    "venv",
    "__pycache__",
    "bin",
    "obj",
    ".workpilot",
    ".worktrees",
    "dist",
    "build",
    "target",
}
OUTPUT_TAIL_CHARS = 4000


@dataclass(frozen=True)
class TestCommand:
    """A test command of the project's stack."""

    __test__ = False  # not a pytest class, despite its name

    id: str
    label: str
    #: The command as shown to the person, without the report arguments.
    command: str
    #: For .NET: the solution or project ``dotnet test`` is given.
    target: str = ""

    def to_dict(self) -> dict[str, str]:
        return {"id": self.id, "label": self.label, "command": self.command}


@dataclass
class RunOutcome:
    """What one run of the suite left behind."""

    exit_code: int | None
    timed_out: bool = False
    #: Set when the command could not be started at all.
    error: str = ""
    duration_s: float = 0.0
    reports: list[Path] = field(default_factory=list)
    output_tail: str = ""


# --- detection --------------------------------------------------------


def _shallow_files(root: Path, suffixes: tuple[str, ...], max_depth: int) -> list[Path]:
    """Files ending in ``suffixes`` at most ``max_depth`` levels down,
    shallowest first, then by path: the root solution wins over a sample's."""
    found: list[tuple[int, str, Path]] = []
    root_depth = len(root.parts)
    for dirpath, dirnames, files in os.walk(root):
        here = Path(dirpath)
        depth = len(here.parts) - root_depth
        dirnames[:] = sorted(
            d for d in dirnames if d not in _IGNORED_DIRS and not d.startswith(".")
        )
        if depth >= max_depth:
            dirnames[:] = []
        for name in files:
            if name.lower().endswith(suffixes):
                path = here / name
                found.append((depth, path.as_posix().lower(), path))
    return [p for _d, _k, p in sorted(found)]


def _dotnet_target(root: Path) -> str | None:
    solutions = _shallow_files(root, (".sln", ".slnx"), max_depth=2)
    if solutions:
        return solutions[0].relative_to(root).as_posix()
    projects = _shallow_files(root, (".csproj", ".fsproj", ".vbproj"), max_depth=3)
    if not projects:
        return None
    tests = [p for p in projects if "test" in p.stem.lower()]
    return (tests or projects)[0].relative_to(root).as_posix()


def _package_json(root: Path) -> dict:
    try:
        data = json.loads((root / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _js_dependencies(root: Path) -> set[str]:
    data = _package_json(root)
    names: set[str] = set()
    for key in ("dependencies", "devDependencies"):
        section = data.get(key)
        if isinstance(section, dict):
            names.update(section)
    return names


def _has_pytest(root: Path) -> bool:
    if any((root / name).is_file() for name in ("pytest.ini", "conftest.py")):
        return True
    for name in ("pyproject.toml", "setup.cfg", "tox.ini"):
        try:
            text = (root / name).read_text(encoding="utf-8")
        except OSError:
            continue
        if "pytest" in text:
            return True
    tests = root / "tests"
    return tests.is_dir() and any(tests.glob("test_*.py"))


def _python(root: Path) -> str:
    """The project's own interpreter when it has a virtualenv."""
    for venv in (".venv", "venv"):
        for candidate in (
            root / venv / "Scripts" / "python.exe",
            root / venv / "bin" / "python",
        ):
            if candidate.is_file():
                return candidate.relative_to(root).as_posix()
    return "python" if is_windows() else "python3"


def detect_test_commands(project: Path) -> list[TestCommand]:
    """The test commands of the project's stack, most likely first."""
    commands: list[TestCommand] = []

    target = _dotnet_target(project)
    if target:
        commands.append(
            TestCommand("dotnet", "C# / .NET", f"dotnet test {target}", target=target)
        )

    js = _js_dependencies(project)
    if "vitest" in js:
        commands.append(TestCommand("vitest", "Vitest", "npx vitest run"))
    if "jest" in js and "jest-junit" in js:
        commands.append(TestCommand("jest", "Jest", "npx jest --ci"))

    if _has_pytest(project):
        commands.append(
            TestCommand("pytest", "pytest", f"{_python(project)} -m pytest")
        )

    if (project / "pom.xml").is_file():
        mvn = "./mvnw" if (project / "mvnw").is_file() else "mvn"
        commands.append(TestCommand("maven", "Maven", f"{mvn} test"))
    if any((project / n).is_file() for n in ("build.gradle", "build.gradle.kts")):
        gradle = "./gradlew" if (project / "gradlew").is_file() else "gradle"
        commands.append(
            TestCommand("gradle", "Gradle", f"{gradle} cleanTest test --continue")
        )

    if (project / "go.mod").is_file():
        commands.append(TestCommand("go", "Go", "go test ./..."))

    return commands


# --- one run ----------------------------------------------------------


@dataclass(frozen=True)
class _Invocation:
    argv: list[str]
    env: dict[str, str] = field(default_factory=dict)
    #: Reports are found by what changed in the tree, not in ``out_dir``.
    collect_changed: bool = False
    #: ``go test -json``: the report is built from the output.
    go_json: bool = False


def _invocation(
    command: TestCommand, project: Path, out_dir: Path, *, no_build: bool
) -> _Invocation:
    out = str(out_dir)
    base = split_command(command.command, project)
    if command.id == "dotnet":
        argv = [
            *base,
            "--logger",
            "trx;LogFilePrefix=flaky",
            "--results-directory",
            out,
        ]
        if no_build:
            argv.append("--no-build")
        return _Invocation(argv)
    if command.id == "pytest":
        return _Invocation([*base, "-q", f"--junitxml={out_dir / 'junit.xml'}"])
    if command.id == "vitest":
        return _Invocation(
            [
                *base,
                "--reporter=default",
                "--reporter=junit",
                f"--outputFile.junit={out_dir / 'junit.xml'}",
            ]
        )
    if command.id == "jest":
        return _Invocation(
            [*base, "--reporters=default", "--reporters=jest-junit"],
            env={"JEST_JUNIT_OUTPUT_DIR": out, "JEST_JUNIT_OUTPUT_NAME": "junit.xml"},
        )
    if command.id == "go":
        # -count=1: a cached result is not a run.
        return _Invocation([*base[:2], "-json", "-count=1", *base[2:]], go_json=True)
    # Maven and Gradle write their reports where they always do; the run
    # collects what it changed.
    return _Invocation(base, collect_changed=True)


_current: subprocess.Popen | None = None


def _kill_tree(process: subprocess.Popen) -> None:
    """The process and everything it started (test hosts, node workers)."""
    if is_windows():  # pragma: no cover - Windows leg
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(process.pid)],
            capture_output=True,
            check=False,
        )
        return
    import psutil

    try:
        children = psutil.Process(process.pid).children(recursive=True)
    except psutil.Error:
        children = []
    for proc in children:
        try:
            proc.kill()
        except psutil.Error:
            pass
    try:
        process.kill()
    except OSError:
        pass


def install_cancel_handler() -> None:
    """A SIGTERM (cancel, server job stopped) also stops the running suite."""

    def handler(signum: int, _frame: object) -> None:
        if _current is not None and _current.poll() is None:
            _kill_tree(_current)
        raise SystemExit(128 + signum)

    try:
        signal.signal(signal.SIGTERM, handler)
    except ValueError:  # pragma: no cover - not the main thread
        pass


def _report_snapshot(project: Path, globs: Iterable[str]) -> dict[Path, float]:
    snapshot: dict[Path, float] = {}
    for pattern in globs:
        for path in project.glob(pattern):
            parts = set(path.relative_to(project).parts)
            if path.is_file() and not parts & {"node_modules", ".git", ".workpilot"}:
                try:
                    snapshot[path] = path.stat().st_mtime
                except OSError:
                    continue
    return snapshot


def _copy_changed(
    before: dict[Path, float], after: dict[Path, float], out_dir: Path
) -> list[Path]:
    copied: list[Path] = []
    for index, (path, mtime) in enumerate(sorted(after.items())):
        if before.get(path) == mtime:
            continue
        target = out_dir / f"{index:03d}-{path.name}"
        try:
            shutil.copy2(path, target)
        except OSError:
            continue
        copied.append(target)
    return copied


def go_json_to_junit(lines: Iterable[str], out_file: Path) -> Path | None:
    """A JUnit XML report from ``go test -json`` output, or None if no test ran."""
    results: dict[tuple[str, str], tuple[str, float, list[str]]] = {}
    output: dict[tuple[str, str], list[str]] = {}
    for line in lines:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict) or not event.get("Test"):
            continue
        key = (str(event.get("Package", "")), str(event["Test"]))
        action = event.get("Action")
        if action == "output":
            output.setdefault(key, []).append(str(event.get("Output", "")))
        elif action in ("pass", "fail", "skip"):
            results[key] = (
                action,
                float(event.get("Elapsed") or 0),
                output.get(key, []),
            )
    if not results:
        return None
    suite = ET.Element("testsuite", name="go test", tests=str(len(results)))
    for (package, test), (action, elapsed, out) in sorted(results.items()):
        case = ET.SubElement(
            suite, "testcase", classname=package, name=test, time=f"{elapsed:.3f}"
        )
        if action == "fail":
            text = "".join(out)[-2000:]
            failure = ET.SubElement(case, "failure", message=text.strip()[:500])
            failure.text = text
        elif action == "skip":
            ET.SubElement(case, "skipped")
    ET.ElementTree(suite).write(out_file, encoding="utf-8", xml_declaration=True)
    return out_file


def _tail(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return text[-OUTPUT_TAIL_CHARS:]


def run_once(
    command: TestCommand,
    project: Path,
    out_dir: Path,
    *,
    timeout_s: float,
    no_build: bool = False,
    report_globs: Iterable[str] = (),
    popen: Callable[..., subprocess.Popen] = subprocess.Popen,
) -> RunOutcome:
    """Run the suite once; its reports end up in ``out_dir``. Never raises."""
    global _current
    out_dir.mkdir(parents=True, exist_ok=True)
    log = out_dir / "output.log"
    try:
        invocation = _invocation(command, project, out_dir, no_build=no_build)
    except ValueError as exc:
        return RunOutcome(None, error=f"the command cannot be parsed: {exc}")
    if not invocation.argv:
        return RunOutcome(None, error="the command is empty")

    globs = list(report_globs)
    before = _report_snapshot(project, globs) if invocation.collect_changed else {}
    env = env_without_credentials(
        extra={"CI": "1", "NO_COLOR": "1", "FORCE_COLOR": "0", **invocation.env}
    )
    started = time.monotonic()
    timed_out = False
    with log.open("w", encoding="utf-8", errors="replace") as sink:
        try:
            process = popen(  # noqa: S603 - argv list, no shell
                invocation.argv,
                cwd=str(project),
                env=env,
                stdout=sink,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
            )
        except (OSError, ValueError) as exc:
            return RunOutcome(None, error=f"the command could not start: {exc}")
        _current = process
        try:
            exit_code = process.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            _kill_tree(process)
            try:
                exit_code = process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                exit_code = None
        finally:
            _current = None

    outcome = RunOutcome(
        exit_code,
        timed_out=timed_out,
        duration_s=time.monotonic() - started,
        output_tail=_tail(log),
    )
    if invocation.go_json:
        try:
            lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            lines = []
        report = go_json_to_junit(lines, out_dir / "junit.xml")
        outcome.reports = [report] if report else []
    elif invocation.collect_changed:
        outcome.reports = _copy_changed(
            before, _report_snapshot(project, globs), out_dir
        )
    else:
        outcome.reports = sorted(
            p for p in out_dir.rglob("*") if p.suffix.lower() in (".trx", ".xml")
        )
    return outcome
