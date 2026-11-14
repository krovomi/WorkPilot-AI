"""Run a project's tests several times and keep the reports of each run.

A flaky test is one that passes and fails on the same code. Finding one needs
several runs of the same suite, and few projects keep the report of every CI
run on the developer's disk: the detective that only read reports already
there answered "0 tests" on most projects. So the detective runs the suite
itself, N times, with the flag that makes the stack write a machine-readable
report (TRX for .NET, JUnit XML elsewhere, converted by ``converters`` when the
runner speaks another format), and keeps each run's report under
``.workpilot/flaky-tests/runs/`` so later scans see the history too.

The command is one of the stack's own, detected from the project's manifests
(never a command line from the UI). It runs without a shell, in the project's
folder, with the backend's credentials stripped from its environment, and a
timeout or a cancel takes the whole process tree (``dotnet test`` starts a
test host, ``npx`` a node).
"""

from __future__ import annotations

import contextlib
import json
import re
import shutil
import signal
import subprocess
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field, replace
from pathlib import Path

from foundation.platform import is_windows, split_command
from security.child_env import env_without_credentials

from .converters import (
    cargo_output_to_junit,
    dart_json_to_junit,
    go_json_to_junit,
    jest_json_to_junit,
    rspec_json_to_junit,
)
from .dotnet import DotnetPlan, dotnet_plan, dotnet_steps

__all__ = [
    "COMMAND_IDS",
    "HISTORY_DIR",
    "RunOutcome",
    "TestCommand",
    "detect_test_commands",
    "go_json_to_junit",
    "install_cancel_handler",
    "run_once",
]

#: Where each run's reports are kept, relative to the project.
HISTORY_DIR = Path(".workpilot") / "flaky-tests" / "runs"

#: The commands the detective knows how to make write a report.
COMMAND_IDS = (
    "dotnet",
    "pytest",
    "vitest",
    "jest",
    "node",
    "maven",
    "gradle",
    "go",
    "cargo",
    "phpunit",
    "pest",
    "rspec",
    "dart",
    "flutter",
    "swift",
)

#: What a failed run shows of its output; the whole log stays in the run folder.
OUTPUT_TAIL_CHARS = 12000


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
    #: For .NET: the test projects and the runner (``dotnet.DotnetPlan``).
    dotnet: DotnetPlan | None = None

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
    #: The run's whole output.
    log: Path | None = None


# --- detection --------------------------------------------------------


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


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


def _uses_node_test(root: Path) -> bool:
    """A ``node --test`` in a script of ``package.json``."""
    scripts = _package_json(root).get("scripts")
    if not isinstance(scripts, dict):
        return False
    return any(
        isinstance(line, str) and re.search(r"\bnode\b[^&|;]*\s--test\b", line)
        for line in scripts.values()
    )


def _has_pytest(root: Path) -> bool:
    if any((root / name).is_file() for name in ("pytest.ini", "conftest.py")):
        return True
    for name in ("pyproject.toml", "setup.cfg", "tox.ini"):
        if "pytest" in _read(root / name):
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


def _composer_packages(root: Path) -> set[str]:
    try:
        data = json.loads(_read(root / "composer.json") or "{}")
    except ValueError:
        return set()
    names: set[str] = set()
    for key in ("require", "require-dev"):
        section = data.get(key) if isinstance(data, dict) else None
        if isinstance(section, dict):
            names.update(str(n).lower() for n in section)
    return names


def _vendor_bin(root: Path, name: str) -> str:
    """Composer's ``vendor/bin/<name>`` when installed, else the tool on PATH."""
    return f"vendor/bin/{name}" if (root / "vendor" / "bin" / name).is_file() else name


def _php_command(root: Path) -> TestCommand | None:
    packages = _composer_packages(root)
    if "pestphp/pest" in packages:
        return TestCommand("pest", "Pest", _vendor_bin(root, "pest"))
    has_config = any(
        (root / n).is_file()
        for n in ("phpunit.xml", "phpunit.xml.dist", "phpunit.dist.xml")
    )
    if "phpunit/phpunit" in packages or has_config:
        return TestCommand("phpunit", "PHPUnit", _vendor_bin(root, "phpunit"))
    return None


def _uses_rspec(root: Path) -> bool:
    if (root / ".rspec").is_file() or re.search(
        r"""['"]rspec""", _read(root / "Gemfile")
    ):
        return True
    spec = root / "spec"
    return spec.is_dir() and any(spec.rglob("*_spec.rb"))


def _dart_command(root: Path) -> TestCommand | None:
    pubspec = _read(root / "pubspec.yaml")
    if not pubspec:
        return None
    if re.search(r"(?m)^\s*sdk:\s*flutter\s*$", pubspec):
        return TestCommand("flutter", "Flutter", "flutter test")
    return TestCommand("dart", "Dart", "dart test")


def detect_test_commands(project: Path) -> list[TestCommand]:
    """The test commands of the project's stack, most likely first."""
    commands: list[TestCommand] = []

    plan = dotnet_plan(project)
    if plan:
        commands.append(
            TestCommand(
                "dotnet", "C# / .NET", plan.command, target=plan.target, dotnet=plan
            )
        )

    js = _js_dependencies(project)
    if "vitest" in js:
        commands.append(TestCommand("vitest", "Vitest", "npx vitest run"))
    if "jest" in js:
        commands.append(TestCommand("jest", "Jest", "npx jest --ci"))
    if not {"vitest", "jest"} & js and _uses_node_test(project):
        commands.append(TestCommand("node", "Node.js test runner", "node --test"))

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
    if (project / "Cargo.toml").is_file():
        commands.append(TestCommand("cargo", "Rust", "cargo test --no-fail-fast"))

    php = _php_command(project)
    if php:
        commands.append(php)
    if _uses_rspec(project):
        rspec = "bundle exec rspec" if (project / "Gemfile").is_file() else "rspec"
        commands.append(TestCommand("rspec", "RSpec", rspec))
    dart = _dart_command(project)
    if dart:
        commands.append(dart)
    if (project / "Package.swift").is_file():
        commands.append(TestCommand("swift", "Swift", "swift test"))

    return commands


# --- one run ----------------------------------------------------------


class _Unselectable(Exception):
    """The stack has no filter for the tests named."""


@dataclass(frozen=True)
class _Invocation:
    #: The command lines of one run, in order (one per .NET test project at most).
    steps: list[list[str]]
    env: dict[str, str] = field(default_factory=dict)
    #: Reports are found by what changed in the tree, not in ``out_dir``.
    collect_changed: bool = False
    #: The converter that turns the runner's own output into JUnit
    #: (``converters``): go, jest, cargo, dart, rspec; "" for none.
    convert: str = ""

    @property
    def argv(self) -> list[str]:
        return self.steps[0] if self.steps else []


def _invocation(
    command: TestCommand,
    project: Path,
    out_dir: Path,
    *,
    no_build: bool,
    only: list[str] | None = None,
) -> _Invocation:
    names = list(only or [])
    if command.id == "dotnet" and command.dotnet is not None:
        from .only import dotnet_filters

        filters = dotnet_filters(names) if names else None
        return _Invocation(
            dotnet_steps(command.dotnet, out_dir, no_build=no_build, filters=filters)
        )
    out = str(out_dir)
    base = split_command(command.command, project)
    invocation = _report_invocation(command.id, base, out_dir, out, no_build=no_build)
    if names:
        from .only import filter_args

        extra = filter_args(command.id, names)
        if not extra:
            raise _Unselectable("the tests named cannot be selected with this command")
        invocation = replace(
            invocation, steps=[[*step, *extra] for step in invocation.steps]
        )
    return invocation


def _report_invocation(
    cid: str, base: list[str], out_dir: Path, out: str, *, no_build: bool
) -> _Invocation:
    """The stack's own command with the options that make it write a report."""
    junit = str(out_dir / "junit.xml")
    if cid == "dotnet":  # a command built by hand, without its projects
        argv = [
            *base,
            "--logger",
            "trx;LogFilePrefix=flaky",
            "--results-directory",
            out,
        ]
        return _Invocation([[*argv, "--no-build"] if no_build else argv])
    if cid == "pytest":
        return _Invocation([[*base, "-q", f"--junitxml={junit}"]])
    if cid == "vitest":
        return _Invocation(
            [
                [
                    *base,
                    "--reporter=default",
                    "--reporter=junit",
                    f"--outputFile.junit={junit}",
                ]
            ]
        )
    if cid == "jest":
        # Jest's own JSON: no reporter package needed in the project.
        json_file = str(out_dir / "jest.json")
        return _Invocation(
            [[*base, "--json", f"--outputFile={json_file}"]], convert="jest"
        )
    if cid == "node":
        return _Invocation(
            [
                [
                    *base,
                    "--test-reporter=spec",
                    "--test-reporter-destination=stdout",
                    "--test-reporter=junit",
                    f"--test-reporter-destination={junit}",
                ]
            ]
        )
    if cid == "go":
        # -count=1: a cached result is not a run.
        return _Invocation([[*base[:2], "-json", "-count=1", *base[2:]]], convert="go")
    if cid == "cargo":
        return _Invocation([base], convert="cargo")
    if cid in ("phpunit", "pest"):
        return _Invocation([[*base, "--log-junit", junit]])
    if cid == "rspec":
        json_file = str(out_dir / "rspec.json")
        return _Invocation(
            [[*base, "--format", "progress", "--format", "json", "--out", json_file]],
            convert="rspec",
        )
    if cid in ("dart", "flutter"):
        json_file = str(out_dir / "dart.json")
        return _Invocation(
            [[*base, "--file-reporter", f"json:{json_file}"]], convert="dart"
        )
    if cid == "swift":
        return _Invocation([[*base, "--parallel", "--xunit-output", junit]])
    # Maven and Gradle write their reports where they always do; the run
    # collects what it changed.
    return _Invocation([base], collect_changed=True)


_current: subprocess.Popen | None = None  # the step running now


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
    # A process already gone is what we wanted.
    for proc in children:
        with contextlib.suppress(psutil.Error):
            proc.kill()
    with contextlib.suppress(OSError):
        process.kill()


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


def _tail(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return text[-OUTPUT_TAIL_CHARS:]


def _convert(kind: str, log: Path, out_dir: Path, project: Path) -> list[Path]:
    """The JUnit report built from a runner's own format (``converters``)."""
    junit = out_dir / "junit.xml"
    if kind == "jest":
        report = jest_json_to_junit(out_dir / "jest.json", junit, project)
    elif kind == "rspec":
        report = rspec_json_to_junit(out_dir / "rspec.json", junit)
    else:
        source = out_dir / "dart.json" if kind == "dart" else log
        try:
            lines = source.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            lines = []
        convert = {
            "go": go_json_to_junit,
            "cargo": cargo_output_to_junit,
            "dart": dart_json_to_junit,
        }[kind]
        report = convert(lines, junit)
    return [report] if report else []


def _run_steps(
    steps: list[list[str]],
    project: Path,
    env: dict[str, str],
    sink,
    *,
    timeout_s: float,
    popen: Callable[..., subprocess.Popen],
) -> tuple[int | None, bool, str]:
    """Run each command line in turn into ``sink``: (exit code, timed out, error).

    The exit code is the first that is not 0; the timeout covers them all.
    """
    global _current
    deadline = time.monotonic() + timeout_s
    worst: int | None = 0
    for argv in steps:
        if len(steps) > 1:
            sink.write(f"$ {' '.join(argv)}\n")
            sink.flush()
        try:
            process = popen(  # noqa: S603 - argv list, no shell
                argv,
                cwd=str(project),
                env=env,
                stdout=sink,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
            )
        except (OSError, ValueError) as exc:
            return None, False, f"the command could not start: {exc}"
        _current = process
        try:
            code = process.wait(timeout=max(1.0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            _kill_tree(process)
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                pass
            return None, True, ""
        finally:
            _current = None
        if worst == 0 and code != 0:
            worst = code
    return worst, False, ""


def run_once(
    command: TestCommand,
    project: Path,
    out_dir: Path,
    *,
    timeout_s: float,
    no_build: bool = False,
    report_globs: Iterable[str] = (),
    popen: Callable[..., subprocess.Popen] = subprocess.Popen,
    only: Iterable[str] = (),
) -> RunOutcome:
    """Run the suite once; its reports end up in ``out_dir``. Never raises.

    ``only`` keeps the tests named, through the stack's own filter.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    log = out_dir / "output.log"
    try:
        invocation = _invocation(
            command, project, out_dir, no_build=no_build, only=list(only)
        )
    except _Unselectable as exc:
        return RunOutcome(None, error=str(exc))
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
    with log.open("w", encoding="utf-8", errors="replace") as sink:
        exit_code, timed_out, error = _run_steps(
            invocation.steps, project, env, sink, timeout_s=timeout_s, popen=popen
        )
    if error:
        return RunOutcome(None, error=error, log=log)

    outcome = RunOutcome(
        exit_code,
        timed_out=timed_out,
        duration_s=time.monotonic() - started,
        output_tail=_tail(log),
        log=log,
    )
    if invocation.convert:
        outcome.reports = _convert(invocation.convert, log, out_dir, project)
    elif invocation.collect_changed:
        outcome.reports = _copy_changed(
            before, _report_snapshot(project, globs), out_dir
        )
    else:
        outcome.reports = sorted(
            p for p in out_dir.rglob("*") if p.suffix.lower() in (".trx", ".xml")
        )
    return outcome
