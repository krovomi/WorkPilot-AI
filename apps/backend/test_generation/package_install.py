"""Adding the chosen test packages to the project — the explicit half.

`libraries.py` decides what the tests are written against and stays pure. This
module is the part that touches the user's solution, and it is deliberately a
separate, separately-invoked step: a generation that quietly ran
`dotnet add package` would edit a `.csproj` nobody asked it to edit, and the
first anyone would know is a diff in a file they did not open.

So this runs only from the runner's `add-packages` action, which the UI calls
from a button the user presses after seeing exactly which packages are missing.

Two ecosystems can be installed here — NuGet through `dotnet add package` and
npm through the project's own package manager. For the others the commands are
reported rather than run: pip installs into whichever environment happens to be
active, and a Maven coordinate goes into a `pom.xml` by hand or not at all.
Reporting a command a person then runs is honest; guessing an environment is
not.
"""

from __future__ import annotations

import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from core.platform import find_executable
from test_generation.libraries import (
    NPM,
    NUGET,
    LibrarySelection,
    TestLibrary,
    install_commands,
    missing_packages,
)

# A package restore reaches the network; anything slower than this is stuck.
_TIMEOUT_SECONDS = 180


@dataclass
class InstallStep:
    """One command that was run, and what it did."""

    command: list[str]
    ok: bool
    output: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class InstallReport:
    """What was installed, what was not, and what the user must do by hand."""

    ok: bool
    installed: list[str] = field(default_factory=list)
    steps: list[InstallStep] = field(default_factory=list)
    # Ecosystems this module will not touch, as commands to run.
    manual_commands: list[str] = field(default_factory=list)
    # Why nothing ran, when nothing ran.
    reason: str = ""
    target: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "installed": list(self.installed),
            "steps": [step.to_dict() for step in self.steps],
            "manual_commands": list(self.manual_commands),
            "reason": self.reason,
            "target": self.target,
        }


def find_dotnet_test_project(
    test_dir: str | Path | None, project_root: str | Path
) -> Path | None:
    """The `.csproj` the test file belongs to.

    Looked for in the test directory first, then upwards to the project root:
    a solution keeps `tests/App.Tests/App.Tests.csproj`, and the file may have
    been written one level below that. The search never leaves the project
    root — adding a package reference to a project outside it is not a mistake
    worth being able to make.
    """
    root = Path(project_root).resolve()
    if test_dir:
        current = Path(test_dir).resolve()
        for _ in range(6):
            found = _first_project_file(current)
            if found is not None:
                return found
            if current == root or current.parent == current:
                break
            current = current.parent

    # Nothing beside the tests: take a test-looking project under the root.
    candidates = sorted(root.glob("**/*.csproj"))
    for candidate in candidates[:200]:
        if "test" in candidate.stem.lower():
            return candidate
    return None


def _first_project_file(directory: Path) -> Path | None:
    if not directory.is_dir():
        return None
    try:
        projects = sorted(
            path
            for path in directory.iterdir()
            if path.suffix.lower() in (".csproj", ".fsproj")
        )
    except OSError:
        return None
    return projects[0] if projects else None


def _npm_command(project_root: Path) -> list[str] | None:
    """The package manager this project actually uses, from its lockfile."""
    if (project_root / "pnpm-lock.yaml").is_file():
        manager, args = "pnpm", ["add", "-D"]
    elif (project_root / "yarn.lock").is_file():
        manager, args = "yarn", ["add", "-D"]
    else:
        manager, args = "npm", ["install", "--save-dev"]
    executable = find_executable(manager)
    return [executable, *args] if executable else None


def _run(command: list[str], cwd: Path) -> InstallStep:
    try:
        completed = subprocess.run(  # noqa: S603 — argv list, no shell
            command,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_SECONDS,
            check=False,
        )
        output = (completed.stdout or "") + (completed.stderr or "")
        return InstallStep(command, completed.returncode == 0, output.strip()[-4000:])
    except subprocess.TimeoutExpired:
        return InstallStep(
            command, False, f"The command did not finish in {_TIMEOUT_SECONDS}s."
        )
    except OSError as exc:
        return InstallStep(command, False, f"{type(exc).__name__}: {exc}")


def install_missing(
    selection: LibrarySelection,
    project_root: str | Path,
    test_dir: str | Path | None = None,
) -> InstallReport:
    """Add the selected-but-absent packages to the project.

    Reports rather than raises: the generated test file already exists by the
    time anyone presses this, so a failed install is something to read and act
    on, not something that should look like the generation failed.
    """
    root = Path(project_root).resolve()
    missing = missing_packages(selection)
    if not missing:
        return InstallReport(ok=True, reason="nothing_missing")
    if not root.is_dir():
        return InstallReport(ok=False, reason="project_not_found")

    by_ecosystem: dict[str, list[TestLibrary]] = {}
    for library in missing:
        by_ecosystem.setdefault(library.ecosystem, []).append(library)

    report = InstallReport(ok=True)

    if NUGET in by_ecosystem:
        _install_nuget(by_ecosystem.pop(NUGET), root, test_dir, report)
    if NPM in by_ecosystem:
        _install_npm(by_ecosystem.pop(NPM), root, report)

    # Whatever is left is reported as a command, not run.
    for libraries in by_ecosystem.values():
        leftover = LibrarySelection(
            selection.language, libraries, selection.installed_ids, selection.explicit
        )
        report.manual_commands.extend(install_commands(leftover))

    return report


def _install_nuget(
    libraries: list[TestLibrary],
    root: Path,
    test_dir: str | Path | None,
    report: InstallReport,
) -> None:
    project = find_dotnet_test_project(test_dir, root)
    if project is None:
        report.ok = False
        report.reason = "no_test_project"
        report.manual_commands.extend(
            f"dotnet add <test project> package {library.package}"
            for library in libraries
        )
        return

    dotnet = find_executable("dotnet")
    if dotnet is None:
        report.ok = False
        report.reason = "dotnet_not_found"
        report.manual_commands.extend(
            f"dotnet add {project.name} package {library.package}"
            for library in libraries
        )
        return

    report.target = str(project)
    for library in libraries:
        # One package per command: `dotnet add package` takes a single id, and
        # a batch that stops halfway would leave the report unable to say which
        # ones landed.
        step = _run([dotnet, "add", str(project), "package", library.package], root)
        report.steps.append(step)
        if step.ok:
            report.installed.append(library.id)
        else:
            report.ok = False


def _install_npm(
    libraries: list[TestLibrary], root: Path, report: InstallReport
) -> None:
    command = _npm_command(root)
    packages = [library.package for library in libraries]
    if command is None:
        report.ok = False
        report.reason = report.reason or "npm_not_found"
        report.manual_commands.append(f"npm install --save-dev {' '.join(packages)}")
        return

    step = _run([*command, *packages], root)
    report.steps.append(step)
    if step.ok:
        report.installed.extend(library.id for library in libraries)
    else:
        report.ok = False
