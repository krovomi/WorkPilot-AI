"""Run a recorded test where it was proposed: the review card's worktree (#387).

The test file was written there by the export; the worktree is prepared by
the project's recipe first (``prepare_worktree``, passed in by the runner, so
this module does not import ``core``), then the format's own runner runs it,
as an argument list without a shell. The process gets the runner's
environment, which has no provider, key or Claude profile (S1); the app does
not run a test that reads a secret from the environment.

The first run of each test (by the digest of its code) is kept in the
project, ``.workpilot/browser-agent/recorder-runs.json``: how many recorded
tests passed the first time they ran is the recorder's own measure.
"""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from foundation.json_ledger import update_json
from foundation.log_redaction import redact_text
from foundation.platform import is_windows

from .e2e_stacks import KIND_BY_TYPE

TIMEOUT_S = 600
#: The end of the output shown in the app.
MAX_OUTPUT = 4000
#: First runs kept per project; the oldest go first.
MAX_RUNS = 500
RUNS_FILE = Path(".workpilot") / "browser-agent" / "recorder-runs.json"
#: The extension of each format's file, as the export names it.
EXTENSIONS = {
    "playwright-ts": "ts",
    "playwright-python": "py",
    "cypress": "js",
    "selenium-python": "py",
    "selenium-java": "java",
    "selenium-csharp": "cs",
    "selenium-ruby": "rb",
    "selenium-js": "cjs",
    "webdriverio": "js",
    "webdriverio-ts": "ts",
}
_WDIO_CONFIGS = ("wdio.conf.ts", "wdio.conf.js", "wdio.conf.mjs", "wdio.conf.cjs")


def _which(name: str) -> str:
    return shutil.which(name) or name


def _python(root: Path) -> str:
    """The worktree's own virtual environment, or the Python on the PATH."""
    venv = root / ".venv" / ("Scripts/python.exe" if is_windows() else "bin/python")
    if venv.exists():
        return str(venv)
    return shutil.which("python3") or shutil.which("python") or sys.executable


def command_for(fmt: str, root: Path, rel: str) -> list[str]:
    """The command that runs the test ``rel`` of format ``fmt`` in ``root``."""
    if fmt == "playwright-ts":
        return [_which("npx"), "playwright", "test", rel, "--reporter=line"]
    if fmt in ("playwright-python", "selenium-python"):
        return [_python(root), "-m", "pytest", rel, "-q"]
    if fmt == "selenium-js":
        return [_which("npx"), "mocha", rel, "--timeout", "120000"]
    if fmt in ("webdriverio", "webdriverio-ts"):
        config = next((c for c in _WDIO_CONFIGS if (root / c).is_file()), None)
        if config is None:
            raise ValueError("WebdriverIO needs a wdio.conf file at the project root.")
        return [_which("npx"), "wdio", "run", config, "--spec", rel]
    kind = {
        "cypress": "cypress",
        "selenium-java": "junit",
        "selenium-csharp": "dotnet",
        "selenium-ruby": "rspec",
    }[fmt]
    return KIND_BY_TYPE[kind].commands(root, [rel])[0]


def locate_test(root: Path, rel: str, fmt: str) -> Path:
    """``rel`` resolved inside ``root``, with its format's extension, or ``ValueError``."""
    resolved_root = root.resolve()
    target = (resolved_root / rel).resolve()
    if resolved_root not in target.parents or not target.is_file():
        raise ValueError("The recorded test is not in the review card's worktree.")
    if not target.name.endswith("." + EXTENSIONS[fmt]):
        raise ValueError("The recorded test does not have its format's extension.")
    return target


@dataclass
class RunResult:
    passed: bool
    exit_code: int | None
    duration_ms: int
    output: str
    setup: str
    first: bool
    first_runs: int
    first_passed: int

    def to_dict(self) -> dict[str, object]:
        return {
            "passed": self.passed,
            "exitCode": self.exit_code,
            "durationMs": self.duration_ms,
            "output": self.output,
            "setup": self.setup,
            "firstRun": self.first,
            "firstRuns": self.first_runs,
            "firstPassed": self.first_passed,
        }


def record_first_run(project: Path, digest: str, passed: bool) -> tuple[bool, int, int]:
    """Keeps the first run of ``digest``; (was it the first, first runs, passed)."""
    seen = {"first": False}

    def change(current: object) -> dict[str, object]:
        runs = current.get("runs") if isinstance(current, dict) else None
        runs = runs if isinstance(runs, dict) else {}
        if digest not in runs:
            seen["first"] = True
            runs[digest] = {
                "passed": passed,
                "at": datetime.now(UTC).isoformat(timespec="seconds"),
            }
            while len(runs) > MAX_RUNS:
                runs.pop(next(iter(runs)))
        return {"runs": runs}

    written = update_json(project / RUNS_FILE, dict, change)
    runs = [r for r in written["runs"].values() if isinstance(r, dict)]
    return seen["first"], len(runs), sum(1 for r in runs if r.get("passed") is True)


def run_recorded_test(
    project: Path,
    root: Path,
    rel: str,
    fmt: str,
    prepare: Callable[[], str],
    run: Callable[..., subprocess.CompletedProcess[str]] | None = None,
) -> RunResult:
    """Prepare ``root``, run the test ``rel`` there, and count its first run."""
    target = locate_test(root, rel, fmt)
    code = target.read_text(encoding="utf-8")
    command = command_for(fmt, root, target.relative_to(root.resolve()).as_posix())
    setup = prepare()
    start = time.monotonic()
    try:
        proc = (run or subprocess.run)(
            command,
            cwd=str(root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=TIMEOUT_S,
            shell=False,
        )
        exit_code: int | None = proc.returncode
        output = (proc.stdout or "") + (proc.stderr or "")
    except subprocess.TimeoutExpired:
        exit_code, output = None, f"The test ran longer than {TIMEOUT_S} s."
    except FileNotFoundError:
        exit_code, output = None, f"Not found: {command[0]}. Install the test runner."
    duration = int((time.monotonic() - start) * 1000)
    passed = exit_code == 0
    digest = hashlib.sha256(code.encode("utf-8")).hexdigest()
    first, runs, first_passed = record_first_run(project, digest, passed)
    return RunResult(
        passed,
        exit_code,
        duration,
        redact_text(output[-MAX_OUTPUT:]),
        setup,
        first,
        runs,
        first_passed,
    )
