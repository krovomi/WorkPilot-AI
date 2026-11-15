"""Benchmark Runner - Times the project's own test suite, whatever its stack.

The suite is found from the project's manifests (``package.json``, Python
markers, ``go.mod``, ``Cargo.toml``, a .NET project, Maven or Gradle). The build
script is reported, never run, to avoid its side effects.
"""

import json
import shutil
import subprocess
import time
from pathlib import Path

from foundation.platform import get_python_commands

from .models import BenchmarkResult

JS_RUNNERS = ("vitest", "jest", "mocha")

# framework -> the command that runs its suite (Python's is resolved apart).
TEST_COMMANDS: dict[str, list[str]] = {
    "vitest": ["npx", "vitest", "run", "--reporter=verbose"],
    "jest": ["npx", "jest", "--passWithNoTests"],
    "mocha": ["npx", "mocha"],
    "go": ["go", "test", "./..."],
    "cargo": ["cargo", "test", "--quiet"],
    "dotnet": ["dotnet", "test", "--nologo"],
    "maven": ["mvn", "-q", "test"],
    "gradle": ["gradle", "test", "--quiet"],
}

# marker file (or glob) -> framework, checked after package.json and Python.
STACK_MARKERS: tuple[tuple[str, str], ...] = (
    ("go.mod", "go"),
    ("Cargo.toml", "cargo"),
    ("*.sln", "dotnet"),
    ("*.csproj", "dotnet"),
    ("*.fsproj", "dotnet"),
    ("pom.xml", "maven"),
    ("build.gradle", "gradle"),
    ("build.gradle.kts", "gradle"),
)


class BenchmarkRunner:
    """Runs benchmarks for the project and captures timing data."""

    def __init__(self, project_dir: str):
        self.project_dir = Path(project_dir)

    def _package_json(self) -> dict:
        try:
            data = json.loads(
                (self.project_dir / "package.json").read_text(encoding="utf-8")
            )
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def detect_test_framework(self) -> str:
        """Detect which test framework the project uses ("unknown" if none)."""
        package = self._package_json()
        deps = {
            **(package.get("dependencies") or {}),
            **(package.get("devDependencies") or {}),
        }
        for runner in JS_RUNNERS:
            if runner in deps:
                return runner

        if any(
            (self.project_dir / marker).exists()
            for marker in ("pytest.ini", "setup.cfg", "pyproject.toml", "conftest.py")
        ):
            return "pytest"
        requirements = self.project_dir / "requirements.txt"
        if requirements.is_file() and "pytest" in requirements.read_text(
            encoding="utf-8", errors="ignore"
        ):
            return "pytest"

        for marker, framework in STACK_MARKERS:
            if any(self.project_dir.glob(marker)):
                return framework
        return "unknown"

    def run_benchmarks(self, timeout_seconds: int = 60) -> list[BenchmarkResult]:
        """Run available benchmarks and return results."""
        results = []
        build_result = self.run_build_timing()
        if build_result:
            results.append(build_result)

        framework = self.detect_test_framework()
        if framework != "unknown":
            results.append(self._run_tests(framework, timeout_seconds))
        return results

    def run_build_timing(self) -> BenchmarkResult | None:
        """Report the build script if ``package.json`` declares one (not run)."""
        scripts = self._package_json().get("scripts") or {}
        if "build" not in scripts:
            return None
        return BenchmarkResult(
            name="build_check",
            duration_ms=0,
            metadata={
                "build_command": scripts["build"],
                "note": "Build timing not executed to avoid side effects",
            },
        )

    def _test_command(self, framework: str) -> list[str]:
        if framework == "pytest":
            for python in get_python_commands():
                if shutil.which(python[0]):
                    return [*python, "-m", "pytest", "--tb=no", "-q"]
            return ["python", "-m", "pytest", "--tb=no", "-q"]
        return list(TEST_COMMANDS[framework])

    def _run_tests(self, framework: str, timeout: int) -> BenchmarkResult:
        """Run the suite once and time it."""
        name = "pytest" if framework == "pytest" else f"{framework}_tests"
        cmd = self._test_command(framework)
        # On Windows npx, mvn or gradle are .cmd scripts: run them by full path.
        executable = shutil.which(cmd[0])
        if executable is None:
            return BenchmarkResult(
                name=name,
                duration_ms=0,
                metadata={"error": f"Command not found: {cmd[0]}"},
            )

        start = time.perf_counter()
        try:
            done = subprocess.run(
                [executable, *cmd[1:]],
                cwd=str(self.project_dir),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return BenchmarkResult(
                name=name,
                duration_ms=timeout * 1000,
                metadata={"error": f"Timed out after {timeout}s"},
            )
        except OSError as error:
            return BenchmarkResult(
                name=name, duration_ms=0, metadata={"error": str(error)}
            )
        output = (done.stdout or "") + (done.stderr or "")
        return BenchmarkResult(
            name=name,
            duration_ms=(time.perf_counter() - start) * 1000,
            metadata={"output_preview": output[-500:], "exit_code": done.returncode},
        )
