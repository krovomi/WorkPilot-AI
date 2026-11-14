"""How ``dotnet test`` runs a .NET project's tests and writes a TRX report.

``dotnet test Rag.sln`` on a solution that holds no test project restores,
builds and exits 0 without running a test: the detective then said "the
command failed before running the tests" on a solution whose tests live in
projects the solution does not list. So the target is chosen by the test
projects, not by the first solution found: the shallowest solution that lists
one, else the test projects themselves, one ``dotnet test`` each.

Two runners exist. VSTest (the default) takes ``--logger trx``. Microsoft.Testing.
Platform (``global.json`` → ``"test": {"runner": "Microsoft.Testing.Platform"}``,
the .NET 10 mode) refuses ``--logger`` and asks each test app for its own report
option: ``--report-trx`` (MSTest, NUnit, TUnit with the TRX extension) or
``--report-xunit-trx`` (xunit.v3). Each test project then runs on its own, with
its own option.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

__all__ = [
    "DotnetPlan",
    "dotnet_plan",
    "dotnet_steps",
    "has_dotnet_projects",
    "is_test_project",
    "solution_projects",
]

_PROJECT_SUFFIXES = (".csproj", ".fsproj", ".vbproj")
_SOLUTION_SUFFIXES = (".sln", ".slnx")
_IGNORED = {
    "node_modules",
    "bin",
    "obj",
    "dist",
    "build",
    "target",
    "packages",
    "artifacts",
}

_IS_TEST = re.compile(r"<IsTestProject>\s*(true|false)\s*</IsTestProject>", re.I)
_TEST_SDK = re.compile(r"""Sdk\s*=\s*["'](MSTest\.Sdk|TUnit\.Sdk)""", re.I)
_TEST_PACKAGE = re.compile(
    r"""<PackageReference[^>]*\bInclude\s*=\s*["']("""
    r"Microsoft\.NET\.Test\.Sdk|xunit|xunit\.core|xunit\.v3[\w.-]*|NUnit|"
    r"MSTest|MSTest\.TestFramework|TUnit[\w.-]*|Expecto|"
    r"Microsoft\.Testing\.Platform[\w.-]*"
    r""")["']""",
    re.I,
)
_XUNIT_V3 = re.compile(r"""<PackageReference[^>]*\bInclude\s*=\s*["']xunit\.v3""", re.I)
# Rag.Tests, Rag.UnitTests, RagTests, Rag.Api.IntegrationTest… never Contest.
_CAMEL_TESTS = re.compile(r"(^|[a-z0-9])(Tests?|Specs?)$")
_SLN_PROJECT = re.compile(r'^Project\("[^"]*"\)\s*=\s*"[^"]*",\s*"([^"]+)"', re.M)
_SLNX_PROJECT = re.compile(r"""<Project\b[^>]*\bPath\s*=\s*["']([^"']+)["']""")
_MAX_DEPTH = 5


@dataclass(frozen=True)
class DotnetPlan:
    """What ``dotnet test`` is given."""

    #: A solution or project that lists every test, or "" for one run per project.
    target: str
    #: The test projects, relative to the project root, POSIX separators.
    projects: tuple[str, ...]
    #: Microsoft.Testing.Platform chosen in ``global.json``.
    mtp: bool = False
    #: The test projects that use xunit.v3 (``--report-xunit-trx``).
    xunit_v3: tuple[str, ...] = ()

    @property
    def command(self) -> str:
        """The command shown to the person, without the report options."""
        if self.mtp:
            # One run per test project, each with its own report option.
            return " && ".join(
                f"dotnet test --project {_shown(p)}" for p in self.projects
            )
        if self.target:
            return f"dotnet test {_shown(self.target)}"
        return " && ".join(f"dotnet test {_shown(p)}" for p in self.projects)


def _shown(path: str) -> str:
    return f'"{path}"' if " " in path else path


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return ""


def is_test_project(path: Path, text: str | None = None) -> bool:
    """Whether the project runs tests: it says so, or references a test framework."""
    body = _read(path) if text is None else text
    declared = _IS_TEST.search(body)
    if declared:
        return declared.group(1).lower() == "true"
    if _TEST_SDK.search(body) or _TEST_PACKAGE.search(body):
        return True
    # A Directory.Build.props can add the packages to every *.Tests project.
    last = re.split(r"[._-]", path.stem)[-1]
    return last.lower() in {"test", "tests", "spec", "specs"} or bool(
        _CAMEL_TESTS.search(last)
    )


def _walk(root: Path, suffixes: tuple[str, ...], max_depth: int) -> list[Path]:
    found: list[tuple[int, str, Path]] = []
    root_depth = len(root.parts)
    for dirpath, dirnames, files in os.walk(root):
        here = Path(dirpath)
        depth = len(here.parts) - root_depth
        dirnames[:] = sorted(
            d for d in dirnames if d.lower() not in _IGNORED and not d.startswith(".")
        )
        if depth >= max_depth:
            dirnames[:] = []
        for name in files:
            if name.lower().endswith(suffixes):
                path = here / name
                found.append((depth, path.as_posix().lower(), path))
    return [p for _d, _k, p in sorted(found)]


def solution_projects(solution: Path) -> list[Path]:
    """The projects a ``.sln`` or ``.slnx`` lists, resolved next to it."""
    text = _read(solution)
    pattern = _SLNX_PROJECT if solution.suffix.lower() == ".slnx" else _SLN_PROJECT
    projects: list[Path] = []
    for raw in pattern.findall(text):
        if not raw.lower().endswith(_PROJECT_SUFFIXES):
            continue  # a solution folder
        candidate = solution.parent / raw.replace("\\", "/")
        try:
            projects.append(candidate.resolve())
        except OSError:
            continue
    return projects


def _strip_json_comments(text: str) -> str:
    return re.sub(r"(?m)^\s*//.*$", "", text)


def _uses_mtp(root: Path) -> bool:
    """``global.json`` (the nearest one, as ``dotnet`` looks it up) picks the runner."""
    here = root.resolve()
    for folder in (here, *here.parents):
        candidate = folder / "global.json"
        if not candidate.is_file():
            continue
        try:
            data = json.loads(_strip_json_comments(_read(candidate)))
        except ValueError:
            return False
        test = data.get("test") if isinstance(data, dict) else None
        runner = test.get("runner") if isinstance(test, dict) else None
        return (
            isinstance(runner, str) and runner.lower() == "microsoft.testing.platform"
        )
    return False


def has_dotnet_projects(root: Path) -> bool:
    """A solution or a project, test or not: the stack is .NET."""
    return bool(_walk(root, (*_SOLUTION_SUFFIXES, *_PROJECT_SUFFIXES), 3))


def dotnet_plan(root: Path) -> DotnetPlan | None:
    """How to run the project's .NET tests, or None when it has no test project."""
    projects = _walk(root, _PROJECT_SUFFIXES, _MAX_DEPTH)
    tests: list[Path] = []
    xunit_v3: list[Path] = []
    for project in projects:
        text = _read(project)
        if is_test_project(project, text):
            tests.append(project)
            if _XUNIT_V3.search(text):
                xunit_v3.append(project)
    if not tests:
        return None

    def rel(path: Path) -> str:
        return path.relative_to(root).as_posix()

    target = ""
    listed = list(tests)
    # The shallowest solution that lists a test project: ``dotnet test`` on a
    # solution without one builds, runs nothing and exits 0.
    for solution in _walk(root, _SOLUTION_SUFFIXES, 3):
        members = set(solution_projects(solution))
        inside = [p for p in tests if p.resolve() in members]
        if inside:
            target, listed = rel(solution), inside
            break
    if not target and len(tests) == 1:
        target = rel(tests[0])
    names = [rel(p) for p in listed]
    return DotnetPlan(
        target=target,
        projects=tuple(names),
        mtp=_uses_mtp(root),
        xunit_v3=tuple(n for n in (rel(p) for p in xunit_v3) if n in names),
    )


def _mtp_report(project: str, plan: DotnetPlan, index: int) -> list[str]:
    name = f"flaky-{index:02d}.trx"
    if project in plan.xunit_v3:
        return ["--report-xunit-trx", "--report-xunit-trx-filename", name]
    return ["--report-trx", "--report-trx-filename", name]


def dotnet_steps(
    plan: DotnetPlan,
    out_dir: Path,
    *,
    no_build: bool,
    filters: dict[str, list[str]] | None = None,
) -> list[list[str]]:
    """The ``dotnet test`` command lines of one run, in order.

    ``filters`` maps ``"vstest"``/``"xunit_v3"`` to the arguments that keep only
    some tests: xunit.v3 under Microsoft.Testing.Platform has its own syntax.
    """
    out = str(out_dir)
    tail = ["--no-build"] if no_build else []
    chosen = filters or {}
    if plan.mtp:
        steps = []
        for index, project in enumerate(plan.projects, start=1):
            kind = "xunit_v3" if project in plan.xunit_v3 else "vstest"
            steps.append(
                [
                    "dotnet",
                    "test",
                    "--project",
                    project,
                    *_mtp_report(project, plan, index),
                    "--results-directory",
                    out,
                    *tail,
                    *chosen.get(kind, []),
                ]
            )
        return steps
    targets = [plan.target] if plan.target else list(plan.projects)
    return [
        [
            "dotnet",
            "test",
            target,
            # One prefix per command: two projects ending in the same second
            # would otherwise write the same file name.
            "--logger",
            f"trx;LogFilePrefix=flaky-{index:02d}",
            "--results-directory",
            out,
            *tail,
            *chosen.get("vstest", []),
        ]
        for index, target in enumerate(targets, start=1)
    ]
