"""End-to-end tests of the stacks besides Playwright (JS/TS) and pytest.

Browser tests are written in every ecosystem: Playwright for .NET and Java,
Cypress, Selenium/Selenide under JUnit, chromedp or playwright-go under
``go test``, Capybara under RSpec, Laravel Dusk under PHPUnit. Each kind
below says which files it owns and how to run a group of them; results come
from the exit code (one status per file), since those tools have no common
report format.

Commands are argument lists run without a shell, from the project folder.
"""

from __future__ import annotations

import shutil
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from foundation.platform import is_windows

from .models import TestInfo, TestResult

TIMEOUT_S = 600


def _which(name: str) -> str:
    """The executable as installed (``npx.cmd``, ``mvn.cmd`` on Windows)."""
    return shutil.which(name) or name


def _nearest(start: Path, root: Path, pattern: str) -> Path | None:
    """The closest folder from ``start`` up to ``root`` holding ``pattern``."""
    current = start
    while True:
        if any(current.glob(pattern)):
            return current
        if current == root or root not in current.parents:
            return None
        current = current.parent


def _cypress(root: Path, files: list[str]) -> list[list[str]]:
    return [[_which("npx"), "cypress", "run", "--spec", ",".join(files)]]


def _dotnet(root: Path, files: list[str]) -> list[list[str]]:
    projects = sorted(
        {str(_nearest((root / f).parent, root, "*.csproj") or root) for f in files}
    )
    return [[_which("dotnet"), "test", project] for project in projects]


def _jvm(root: Path, files: list[str]) -> list[list[str]]:
    classes = sorted({Path(f).stem for f in files})
    if (root / "pom.xml").exists():
        wrapper = root / ("mvnw.cmd" if is_windows() else "mvnw")
        mvn = str(wrapper) if wrapper.exists() else _which("mvn")
        return [[mvn, "-q", "test", f"-Dtest={','.join(classes)}"]]
    wrapper = root / ("gradlew.bat" if is_windows() else "gradlew")
    gradle = str(wrapper) if wrapper.exists() else _which("gradle")
    command = [gradle, "test"]
    for name in classes:
        command += ["--tests", name]
    return [command]


def _go(root: Path, files: list[str]) -> list[list[str]]:
    packages = sorted({"./" + Path(f).parent.as_posix() for f in files})
    return [[_which("go"), "test", *packages]]


def _rspec(root: Path, files: list[str]) -> list[list[str]]:
    return [[_which("bundle"), "exec", "rspec", *files]]


def _phpunit(root: Path, files: list[str]) -> list[list[str]]:
    if (root / "artisan").exists() and any("Browser" in f for f in files):
        return [[_which("php"), "artisan", "dusk", *files]]
    return [[_which("php"), "vendor/bin/phpunit", *files]]


@dataclass(frozen=True)
class E2EKind:
    type: str
    patterns: tuple[str, ...]
    commands: Callable[[Path, list[str]], list[list[str]]]
    install_hint: str


#: Checked before the Playwright/pytest patterns: ``*.cy.ts`` is a ``*.ts``.
KINDS: tuple[E2EKind, ...] = (
    E2EKind("cypress", ("*.cy.ts", "*.cy.js"), _cypress, "npm install cypress"),
    E2EKind(
        "dotnet", ("*Tests.cs", "*Test.cs", "*E2E.cs"), _dotnet, ".NET SDK (dotnet)"
    ),
    E2EKind(
        "junit",
        ("*Test.java", "*IT.java", "*Test.kt", "*IT.kt"),
        _jvm,
        "Maven or Gradle and a JDK",
    ),
    E2EKind("go", ("*_test.go",), _go, "Go toolchain"),
    E2EKind("rspec", ("*_spec.rb",), _rspec, "Ruby and Bundler"),
    E2EKind("phpunit", ("*Test.php",), _phpunit, "PHP and Composer"),
)

KIND_BY_TYPE = {kind.type: kind for kind in KINDS}


def classify(path: Path) -> str | None:
    """The E2E kind of ``path``, or None when Playwright/pytest owns it."""
    for kind in KINDS:
        if any(path.match(pattern) for pattern in kind.patterns):
            return kind.type
    return None


def run_kind(root: Path, kind_type: str, tests: list[TestInfo]) -> list[TestResult]:
    """Run one kind's tests; one result per file, from the exit codes."""
    kind = KIND_BY_TYPE[kind_type]
    files = [t.path for t in tests]
    failures: list[str] = []
    start = time.time()
    try:
        for command in kind.commands(root, files):
            proc = subprocess.run(
                command,
                cwd=str(root),
                capture_output=True,
                text=True,
                timeout=TIMEOUT_S,
                shell=False,
            )
            if proc.returncode != 0:
                failures.append((proc.stdout + proc.stderr)[-500:])
    except subprocess.TimeoutExpired:
        return _all(tests, "error", TIMEOUT_S * 1000, f"Timed out ({TIMEOUT_S}s)")
    except FileNotFoundError:
        return _all(tests, "error", 0, f"Tool not found: install {kind.install_hint}")
    duration = (time.time() - start) * 1000
    if failures:
        return _all(tests, "failed", duration, "\n".join(failures)[-500:])
    return _all(tests, "passed", duration, None)


def _all(
    tests: list[TestInfo], status: str, duration_ms: float, message: str | None
) -> list[TestResult]:
    share = duration_ms / max(len(tests), 1)
    return [
        TestResult(
            name=t.name,
            path=t.path,
            status=status,
            duration_ms=round(share, 2),
            error_message=message,
        )
        for t in tests
    ]
