"""The judge: the card's hidden tests, run in a copy, read from their reports.

The suites are found once, on the target, from the runnable test files the
card changed:

* ``.py``: pytest, from the copy's root, with a JUnit report;
* ``.ts``/``.js`` and kin: Vitest or Jest, whichever the nearest
  ``package.json`` with one of them declares, from that package's folder,
  with the JSON report both share;
* ``_test.go``: ``go test -json`` on the package, from its module;
* ``.cs`` in a test project: ``dotnet test`` on that project, with a TRX
  report.

A project the detection gets wrong declares its judge in
``.workpilot/bench.json`` (read from the project, never from a copy, so an
agent cannot rewrite its own judge)::

    {"judge": {"argv": ["make", "test-report"], "cwd": ".",
               "report": "junit", "output": "out/report.xml"}}

``{report}`` in ``argv`` is replaced by the report's path, ``{files}`` by the
card's runnable test files. Each run has a constructed environment without
credentials (``judge_env``) and a timeout, ``WORKPILOT_BENCH_JUDGE_TIMEOUT``
seconds (900 by default); the run's whole process tree is ended with it.
"""

from __future__ import annotations

import os
import signal
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath

from foundation.platform import find_executable, is_windows

from .layout import BenchError, config_path, read_json
from .reports import FORMATS, read_report

TIMEOUT_ENV = "WORKPILOT_BENCH_JUDGE_TIMEOUT"
DEFAULT_TIMEOUT = 900
MAX_TIMEOUT = 7200
_LOG_TAIL = 20_000

# What a test run may inherit from the bench's own environment: where the
# tools and their caches are, the locale, the OS's own folders. No key, no
# token, no proxy credential, no variable a repository could have set.
_ENV_KEEP = {
    "PATH",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "GOPATH",
    "GOROOT",
    "GOCACHE",
    "GOMODCACHE",
    "GOFLAGS",
    "DOTNET_ROOT",
    "NUGET_PACKAGES",
    "JAVA_HOME",
}
_JS_EXT = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts")


@dataclass
class Suite:
    """One runner invocation of the judge."""

    kind: str  # pytest | vitest | jest | go | dotnet | custom
    cwd: str  # posix, relative to the copy's root
    report: str  # one of reports.FORMATS
    files: list[str] = field(default_factory=list)  # relative to ``cwd``
    argv: list[str] = field(default_factory=list)  # custom only
    output: str = ""  # custom only: the report, relative to ``cwd``

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> Suite:
        return cls(
            kind=str(data["kind"]),
            cwd=str(data.get("cwd") or "."),
            report=str(data["report"]),
            files=[str(f) for f in data.get("files") or []],
            argv=[str(a) for a in data.get("argv") or []],
            output=str(data.get("output") or ""),
        )


@dataclass
class Outcome:
    results: dict[str, str]
    timed_out: bool = False
    errors: list[str] = field(default_factory=list)


def timeout_seconds() -> int:
    raw = os.environ.get(TIMEOUT_ENV, "").strip()
    try:
        value = int(raw) if raw else DEFAULT_TIMEOUT
    except ValueError:
        value = DEFAULT_TIMEOUT
    return max(30, min(MAX_TIMEOUT, value))


def judge_env(copy_dir: Path) -> dict[str, str]:
    env = {
        key: value
        for key, value in os.environ.items()
        if key.upper() in _ENV_KEEP and value
    }
    env["CI"] = "1"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONUTF8"] = "1"
    # The copy's code comes before anything an editable install of the
    # project put on the path.
    paths = [str(copy_dir)]
    if (copy_dir / "src").is_dir():
        paths.append(str(copy_dir / "src"))
    env["PYTHONPATH"] = os.pathsep.join(paths)
    return env


# --------------------------------------------------------------------------
# Detection, on the target


def _nearest(start: PurePosixPath, root: Path, predicate) -> PurePosixPath | None:
    current = start
    while True:
        if predicate(root / current):
            return current
        if current == PurePosixPath("."):
            return None
        current = current.parent


def _js_runner(folder: Path) -> str | None:
    data = read_json(folder / "package.json")
    if data is None:
        return None
    declared: set[str] = set()
    for key in ("dependencies", "devDependencies"):
        section = data.get(key)
        if isinstance(section, dict):
            declared |= set(section)
    if "vitest" in declared:
        return "vitest"
    if "jest" in declared:
        return "jest"
    return None


def custom_suite(project_dir: Path) -> Suite | None:
    config = read_json(config_path(project_dir))
    judge = (config or {}).get("judge")
    if judge is None:
        return None
    if not isinstance(judge, dict):
        raise BenchError("bench.json: judge must be an object")
    argv = judge.get("argv")
    report = judge.get("report")
    output = judge.get("output") or ""
    cwd = judge.get("cwd") or "."
    if (
        not isinstance(argv, list)
        or not argv
        or not all(isinstance(a, str) and a for a in argv)
    ):
        raise BenchError("bench.json: judge.argv must be a list of strings")
    if report not in FORMATS:
        raise BenchError(
            f"bench.json: judge.report must be one of {', '.join(FORMATS)}"
        )
    if not isinstance(output, str) or not isinstance(cwd, str):
        raise BenchError("bench.json: judge.output and judge.cwd must be strings")
    if "{report}" not in argv and not output and report != "go-json":
        raise BenchError("bench.json: give judge.output or use {report} in argv")
    for value in (cwd, output):
        posix = PurePosixPath(value or ".")
        if posix.is_absolute() or ".." in posix.parts:
            raise BenchError("bench.json: paths stay inside the project")
    return Suite(kind="custom", cwd=cwd, report=report, argv=argv, output=output)


def detect_suites(
    project_dir: Path, checkout: Path, runnable: list[str]
) -> list[Suite]:
    """The suites that run ``runnable`` in ``checkout``. Raises ``BenchError``."""
    custom = custom_suite(project_dir)
    if custom is not None:
        cwd = PurePosixPath(custom.cwd)
        custom.files = [_relative_to(PurePosixPath(f), cwd) for f in runnable]
        return [custom]

    suites: dict[tuple[str, str], Suite] = {}

    def add(kind: str, cwd: PurePosixPath, report: str, item: str) -> None:
        suite = suites.setdefault(
            (kind, cwd.as_posix()), Suite(kind=kind, cwd=cwd.as_posix(), report=report)
        )
        if item not in suite.files:
            suite.files.append(item)

    for name in runnable:
        path = PurePosixPath(name)
        if path.suffix == ".py":
            add("pytest", PurePosixPath("."), "junit", name)
        elif path.suffix in _JS_EXT:
            package = _nearest(
                path.parent, checkout, lambda d: _js_runner(d) is not None
            )
            if package is None:
                raise BenchError(f"{name}: no package.json declares vitest or jest")
            kind = _js_runner(checkout / package) or ""
            add(kind, package, "jest-json", _relative_to(path, package))
        elif path.suffix == ".go":
            module = _nearest(path.parent, checkout, lambda d: (d / "go.mod").is_file())
            if module is None:
                raise BenchError(f"{name}: no go.mod above it")
            package = "./" + _relative_to(path.parent, module)
            add("go", module, "go-json", package.rstrip("/.") or ".")
        elif path.suffix == ".cs":
            project = _nearest(
                path.parent, checkout, lambda d: d.is_dir() and any(d.glob("*.csproj"))
            )
            if project is None:
                raise BenchError(f"{name}: no .csproj above it")
            csproj = sorted((checkout / project).glob("*.csproj"))[0].name
            add("dotnet", project, "trx", csproj)
        else:
            raise BenchError(f"{name}: no judge for this kind of test")
    if not suites:
        raise BenchError("no runnable test")
    return list(suites.values())


def _relative_to(path: PurePosixPath, folder: PurePosixPath) -> str:
    if folder == PurePosixPath("."):
        return path.as_posix()
    return path.relative_to(folder).as_posix()


# --------------------------------------------------------------------------
# Running, in a copy


def _python(project_dir: Path) -> str:
    for venv in (".venv", "venv"):
        candidate = (
            project_dir / venv / "Scripts" / "python.exe"
            if is_windows()
            else project_dir / venv / "bin" / "python"
        )
        if candidate.is_file():
            return str(candidate)
    found = find_executable("python3") or find_executable("python")
    if not found:
        raise BenchError("no Python to run pytest")
    return found


def link_dependencies(project_dir: Path, copy_dir: Path, package: str) -> None:
    """Point the copy's ``node_modules`` at the project's.

    Done at judge time only: a build never sees a link into the project. The
    judge always runs on the project's installed dependencies, as the target
    was judged: a ``node_modules`` the agent installed in the copy is moved
    aside to ``node_modules.agent``, so no package it wrote there decides.
    """
    folders = {PurePosixPath(package), PurePosixPath(".")}
    for folder in folders:
        source = project_dir / folder / "node_modules"
        dest = copy_dir / folder / "node_modules"
        if not source.is_dir():
            continue
        if not dest.parent.is_dir() or dest.parent.is_symlink():
            continue
        if dest.is_symlink() or dest.exists():
            try:
                if dest.resolve() == source.resolve():
                    continue
            except OSError:
                # An unresolvable link is not the project's: set it aside below.
                pass
            aside = dest.with_name("node_modules.agent")
            if aside.exists() or aside.is_symlink():
                raise BenchError(f"{folder}/node_modules.agent already exists")
            dest.rename(aside)
        if is_windows():
            # A junction needs no privilege.
            subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(dest), str(source)],
                capture_output=True,
                check=False,
                stdin=subprocess.DEVNULL,
            )
        else:
            dest.symlink_to(source, target_is_directory=True)


def unlink_dependencies(copy_dir: Path, suites: list[Suite]) -> None:
    """Remove the links ``link_dependencies`` made, before a copy is deleted:
    deleting a copy must never walk into the project's ``node_modules``."""
    for folder in {PurePosixPath(s.cwd) for s in suites} | {PurePosixPath(".")}:
        link = copy_dir / folder / "node_modules"
        try:
            if link.is_symlink():
                link.unlink()
            elif getattr(os.path, "isjunction", lambda _p: False)(link):
                os.rmdir(link)
        except OSError:
            # Nothing left to remove: the link is already gone.
            pass


def _js_bin(project_dir: Path, package: str, runner: str) -> Path:
    """The runner's script, from the project's own ``node_modules``: the
    package's, or the workspace root's where it is hoisted."""
    for folder in dict.fromkeys((project_dir / package, project_dir)):
        home = folder / "node_modules" / runner
        manifest = read_json(home / "package.json")
        if manifest is None:
            continue
        bin_field = manifest.get("bin")
        entry = bin_field.get(runner) if isinstance(bin_field, dict) else bin_field
        if not isinstance(entry, str) or not entry:
            raise BenchError(f"{runner} declares no executable")
        script = (home / entry).resolve()
        if not script.is_file():
            raise BenchError(f"{runner}'s executable is missing")
        return script
    raise BenchError(f"{runner} is not installed in the project")


def command_for(
    suite: Suite, project_dir: Path, copy_dir: Path, report: Path
) -> list[str]:
    if suite.kind == "custom":
        argv: list[str] = []
        for arg in suite.argv:
            if arg == "{files}":
                argv.extend(suite.files)
            else:
                argv.append(arg.replace("{report}", str(report)))
        return argv
    if suite.kind == "pytest":
        return [
            _python(project_dir),
            "-m",
            "pytest",
            "-p",
            "no:cacheprovider",
            "-q",
            "-o",
            "junit_family=xunit2",
            f"--junitxml={report}",
            *suite.files,
        ]
    if suite.kind in ("vitest", "jest"):
        node = find_executable("node")
        if not node:
            raise BenchError("no Node.js to run the tests")
        link_dependencies(project_dir, copy_dir, suite.cwd)
        script = str(_js_bin(project_dir, suite.cwd, suite.kind))
        if suite.kind == "vitest":
            return [
                node,
                script,
                "run",
                "--reporter=json",
                f"--outputFile={report}",
                *suite.files,
            ]
        return [
            node,
            script,
            "--ci",
            "--json",
            f"--outputFile={report}",
            "--runTestsByPath",
            *suite.files,
        ]
    if suite.kind == "go":
        go = find_executable("go")
        if not go:
            raise BenchError("no Go toolchain to run the tests")
        return [go, "test", "-json", "-count=1", *suite.files]
    if suite.kind == "dotnet":
        dotnet = find_executable("dotnet")
        if not dotnet:
            raise BenchError("no .NET SDK to run the tests")
        return [
            dotnet,
            "test",
            suite.files[0],
            "--logger",
            f"trx;LogFileName={report.name}",
            "--results-directory",
            str(report.parent),
        ]
    raise BenchError(f"unknown suite kind {suite.kind}")


def _end_tree(process: subprocess.Popen) -> None:
    if is_windows():
        subprocess.run(
            ["taskkill", "/T", "/F", "/PID", str(process.pid)],
            capture_output=True,
            check=False,
            stdin=subprocess.DEVNULL,
        )
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            # The group is already gone; the leader is killed just below.
            pass
    process.kill()


def _run(
    argv: list[str], cwd: Path, env: dict[str, str], log: Path
) -> tuple[bytes, bool]:
    options: dict = {}
    if is_windows():
        options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options["start_new_session"] = True
    process = subprocess.Popen(
        argv,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        **options,
    )
    timed_out = False
    try:
        output, _ = process.communicate(timeout=timeout_seconds())
    except subprocess.TimeoutExpired:
        timed_out = True
        _end_tree(process)
        output, _ = process.communicate()
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("ab") as handle:
        handle.write(f"$ {' '.join(argv)}\n".encode())
        handle.write(output[-_LOG_TAIL:] if output else b"")
        handle.write(b"\n")
    return output or b"", timed_out


def run_suites(
    suites: list[Suite], project_dir: Path, copy_dir: Path, scratch: Path, log: Path
) -> Outcome:
    """Every suite in ``copy_dir``; the union of their reports."""
    outcome = Outcome(results={})
    env = judge_env(copy_dir)
    scratch.mkdir(parents=True, exist_ok=True)
    for index, suite in enumerate(suites):
        cwd = copy_dir / suite.cwd
        if suite.kind == "custom" and suite.output:
            report = cwd / suite.output
        else:
            extension = {"junit": "xml", "trx": "trx"}.get(suite.report, "json")
            report = scratch / f"report-{index}.{extension}"
        if report.exists() and not report.is_symlink():
            report.unlink()
        try:
            argv = command_for(suite, project_dir, copy_dir, report)
        except BenchError as error:
            outcome.errors.append(str(error))
            continue
        if not cwd.is_dir() or cwd.is_symlink():
            outcome.errors.append(f"{suite.cwd} is missing in the copy")
            continue
        try:
            output, timed_out = _run(argv, cwd, env, log)
        except OSError as error:
            outcome.errors.append(f"{suite.kind} did not start: {error}")
            continue
        if timed_out:
            outcome.timed_out = True
            outcome.errors.append(f"{suite.kind} ran past {timeout_seconds()} s")
        if suite.report == "go-json" and not (suite.kind == "custom" and suite.output):
            report.write_bytes(output)
        prefix = "" if len(suites) == 1 else f"[{suite.kind}:{suite.cwd}] "
        for test_id, result in read_report(suite.report, report, cwd).items():
            outcome.results[prefix + test_id] = result
    return outcome
