"""The test command of the project's stack, as an argument list, never a shell line.

One command per mutated file: narrowed to that file's tests where the runner
takes test paths (pytest, Vitest, Jest, PHPUnit, RSpec, ExUnit, Dart and
Flutter) or a package (Go), the whole suite elsewhere (.NET, Maven, Gradle,
Cargo, SwiftPM, `npm test`). A test path with a character a Windows command
line would interpret is not passed: the whole suite runs instead.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path, PurePosixPath

from foundation.platform import build_windows_command, is_windows

__all__ = ["project_root", "command_for_tests"]

_SAFE = re.compile(r"[A-Za-z0-9_./@+-]+")
_NO_TEST_SCRIPT = "no test specified"


def _resolve(argv: list[str], cwd: Path) -> list[str]:
    """``npx`` → ``npx.cmd`` through ``cmd.exe`` on Windows, as the shell would."""
    if not is_windows():
        return argv
    program = argv[0]
    candidates = [program]
    if not os.path.splitext(program)[1]:
        candidates += [program + ext for ext in (".exe", ".cmd", ".bat")]
    for name in candidates:
        local = cwd / name
        found = str(local) if local.is_file() else shutil.which(name)
        if found:
            return build_windows_command(found, argv[1:])
    return argv


def _package_json(root: Path) -> dict:
    try:
        data = json.loads((root / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _js(root: Path, tests: list[str]) -> list[str] | None:
    pkg = _package_json(root)
    if not pkg:
        return None
    deps = {
        **(pkg.get("dependencies") or {}),
        **(pkg.get("devDependencies") or {}),
    }
    if "vitest" in deps:
        return ["npx", "vitest", "run", *tests]
    if "jest" in deps:
        return ["npx", "jest", "--ci", *tests]
    script = str((pkg.get("scripts") or {}).get("test") or "")
    if script and _NO_TEST_SCRIPT not in script:
        return ["npm", "test", "--silent"]
    return None


def _python(root: Path) -> str:
    for venv in (".venv", "venv"):
        for candidate in (venv + "/Scripts/python.exe", venv + "/bin/python"):
            if (root / candidate).is_file():
                return str(root / candidate)
    return "python" if is_windows() else "python3"


def _has_pytest(root: Path) -> bool:
    if (root / "pytest.ini").is_file() or (root / "conftest.py").is_file():
        return True
    for name in ("pyproject.toml", "setup.cfg", "tox.ini"):
        try:
            if "pytest" in (root / name).read_text(encoding="utf-8"):
                return True
        except OSError:
            continue
    tests = root / "tests"
    return tests.is_dir() and any(tests.rglob("test_*.py"))


def _dotnet_target(root: Path) -> str | None:
    for pattern in ("*.sln", "*.slnx", "*.csproj", "*.fsproj"):
        found = sorted(root.glob(pattern))
        if found:
            return found[0].name
    return None


def _flutter(root: Path) -> bool:
    try:
        return "sdk: flutter" in (root / "pubspec.yaml").read_text(encoding="utf-8")
    except OSError:
        return False


def _command(root: Path, source: str, tests: list[str]) -> list[str] | None:
    suffix = PurePosixPath(source).suffix.lower()
    if suffix in (".py",) and _has_pytest(root):
        return [
            _python(root),
            "-m",
            "pytest",
            "-q",
            "-x",
            "-p",
            "no:cacheprovider",
            *tests,
        ]
    if suffix in (
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".ts",
        ".tsx",
        ".mts",
        ".cts",
        ".vue",
        ".svelte",
    ):
        return _js(root, tests)
    if suffix in (".cs", ".fs", ".razor", ".cshtml"):
        target = _dotnet_target(root)
        return ["dotnet", "test", target, "--nologo"] if target else None
    if suffix in (".java", ".kt", ".kts", ".scala", ".groovy"):
        if (root / "pom.xml").is_file():
            return ["./mvnw" if (root / "mvnw").is_file() else "mvn", "-q", "test"]
        if any((root / n).is_file() for n in ("build.gradle", "build.gradle.kts")):
            return ["./gradlew" if (root / "gradlew").is_file() else "gradle", "test"]
        return None
    if suffix == ".go" and (root / "go.mod").is_file():
        package = PurePosixPath(source).parent.as_posix()
        return ["go", "test", "./" if package == "." else f"./{package}/"]
    if suffix == ".rs" and (root / "Cargo.toml").is_file():
        return ["cargo", "test", "--quiet"]
    if suffix == ".php" and (root / "vendor" / "bin" / "phpunit").is_file():
        return ["php", "vendor/bin/phpunit", *tests]
    if suffix == ".rb" and (root / "Gemfile").is_file():
        return ["bundle", "exec", "rspec", *tests] if (root / "spec").is_dir() else None
    if suffix == ".dart" and (root / "pubspec.yaml").is_file():
        return ["flutter" if _flutter(root) else "dart", "test", *tests]
    if suffix == ".swift" and (root / "Package.swift").is_file():
        return ["swift", "test"]
    if suffix in (".ex", ".exs") and (root / "mix.exs").is_file():
        return ["mix", "test", *tests]
    return None


_MARKERS = (
    "package.json", "pyproject.toml", "pytest.ini", "setup.cfg", "go.mod",
    "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json",
    "Gemfile", "pubspec.yaml", "Package.swift", "mix.exs",
)  # fmt: skip


def _is_project(directory: Path) -> bool:
    return (
        any((directory / m).is_file() for m in _MARKERS)
        or any(directory.glob("*.sln"))
        or any(directory.glob("*.csproj"))
    )


def project_root(copy: Path, source: str) -> Path:
    """The nearest folder above ``source`` that holds a project (a monorepo's package)."""
    directory = (copy / source).parent
    while directory != copy and copy in directory.parents:
        if _is_project(directory):
            return directory
        directory = directory.parent
    return copy


def command_for_tests(
    copy: Path, source: str, tests: list[str]
) -> tuple[list[str], Path] | None:
    """The argv that runs ``source``'s tests and the folder it runs in, or None.

    ``source`` and ``tests`` are relative to ``copy`` (the repository).
    """
    root = project_root(copy, source)
    prefix = root.relative_to(copy).as_posix()
    inside = [
        t[len(prefix) + 1 :] if prefix != "." else t
        for t in tests
        if prefix == "." or t.startswith(prefix + "/")
    ]
    safe = [t for t in inside if _SAFE.fullmatch(t)]
    if len(safe) != len(inside):
        safe = []
    local = source[len(prefix) + 1 :] if prefix != "." else source
    argv = _command(root, local, safe)
    return (_resolve(argv, root), root) if argv else None
