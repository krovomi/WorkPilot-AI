"""Choosing what the generated tests are written against, end to end.

The unit-level rules live in ``apps/backend/test_generation/test_libraries.py``.
What is pinned here is the surface the Kanban actually calls: the runner action
that answers "what will these tests use?" before a generation, the flag that
carries the answer into the prompt, and the separate action that adds the
missing packages to the project.
"""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "test_generation_runner.py"

if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from test_generation.libraries import resolve_selection  # noqa: E402
from test_generation.package_install import (  # noqa: E402
    InstallStep,
    find_dotnet_test_project,
    install_missing,
)

CSPROJ_WITH_XUNIT = """<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="xunit" Version="2.9.0" />
  </ItemGroup>
</Project>
"""


def _write(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _solution(root: Path) -> Path:
    """A .NET solution with a source project and a test project beside it."""
    (root / ".git").mkdir(parents=True)
    _write(root / "src" / "App.csproj", "<Project />")
    source = _write(root / "src" / "Program.cs", "class Program {}")
    _write(root / "tests" / "App.Tests" / "App.Tests.csproj", CSPROJ_WITH_XUNIT)
    return source


def _load_runner():
    spec = importlib.util.spec_from_file_location("tg_runner_libs", RUNNER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class TestResolveLibrariesAction:
    """The pre-flight that fills the picker before anything is generated."""

    def _run(self, *args: str) -> dict:
        proc = subprocess.run(
            [sys.executable, str(RUNNER), *args],
            capture_output=True,
            text=True,
            cwd=str(BACKEND),
        )
        line = next(
            (
                line
                for line in proc.stdout.splitlines()
                if line.startswith("__TEST_GENERATION_RESULT__:")
            ),
            None,
        )
        assert line is not None, (
            f"no result line.\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
        )
        return json.loads(line[len("__TEST_GENERATION_RESULT__:") :])

    def test_it_reports_the_catalogue_and_what_the_project_has(self, tmp_path: Path):
        source = _solution(tmp_path)

        payload = self._run(
            "--action",
            "resolve-libraries",
            "--file-path",
            str(source),
            "--project-path",
            str(tmp_path),
        )

        libraries = payload["libraries"]
        assert payload["success"] is True
        assert libraries["language"] == "csharp"
        assert "xunit" in libraries["installed"]
        # The project decided; nothing was chosen behind the user's back.
        assert libraries["explicit"] is False
        assert libraries["selected"] == ["xunit"]
        offered = {entry["id"] for entry in libraries["libraries"]}
        assert {"fluentassertions", "moq", "nsubstitute"} <= offered
        assert libraries["missing"] == []

    def test_an_explicit_choice_reports_what_is_missing(self, tmp_path: Path):
        source = _solution(tmp_path)

        libraries = self._run(
            "--action",
            "resolve-libraries",
            "--file-path",
            str(source),
            "--project-path",
            str(tmp_path),
            "--test-libraries",
            "xunit,fluentassertions,moq",
        )["libraries"]

        assert libraries["explicit"] is True
        assert [entry["package"] for entry in libraries["missing"]] == [
            "FluentAssertions",
            "Moq",
        ]
        assert libraries["install_commands"] == [
            "dotnet add <test project> package FluentAssertions",
            "dotnet add <test project> package Moq",
        ]


class TestSelectionReachesThePrompt:
    """The choice is only worth making if the model is told about it."""

    def test_the_prompt_names_the_chosen_libraries(self, tmp_path: Path):
        from agents.test_generator import TestGeneratorAgent

        source = _solution(tmp_path)
        agent = TestGeneratorAgent()
        framework_info = {
            "language": "csharp",
            "test_framework": "xUnit",
            "project_root": str(tmp_path),
            "details": "",
        }

        section = agent._libraries_section(
            str(tmp_path), framework_info, ["xunit", "fluentassertions", "moq"]
        )
        prompt = agent._generate_unit_prompt(
            "class Program {}", str(source), framework_info, "", 3, section
        )

        assert "FluentAssertions" in prompt
        assert "new Mock<T>()" in prompt
        assert "ONLY these libraries" in prompt

    def test_without_a_choice_the_project_still_reaches_the_prompt(
        self, tmp_path: Path
    ):
        from agents.test_generator import TestGeneratorAgent

        _solution(tmp_path)
        framework_info = {
            "language": "csharp",
            "test_framework": "xUnit",
            "project_root": str(tmp_path),
            "details": "",
        }

        section = TestGeneratorAgent()._libraries_section(
            str(tmp_path), framework_info, None
        )

        assert "xUnit" in section
        assert "FluentAssertions" not in section

    def test_an_unreadable_project_costs_the_hint_not_the_generation(self):
        from agents.test_generator import TestGeneratorAgent

        section = TestGeneratorAgent()._libraries_section(
            "/nope/does/not/exist",
            {"language": "csharp", "test_framework": "xUnit", "project_root": ""},
            None,
        )

        # Falls back to the language's recommended set rather than raising.
        assert "xUnit" in section


class TestInstallingTheMissingPackages:
    def test_it_finds_the_test_project_beside_the_test_file(self, tmp_path: Path):
        _solution(tmp_path)

        found = find_dotnet_test_project(tmp_path / "tests" / "App.Tests", tmp_path)

        assert found == tmp_path / "tests" / "App.Tests" / "App.Tests.csproj"

    def test_it_finds_a_test_project_when_the_directory_has_none(self, tmp_path: Path):
        _solution(tmp_path)

        found = find_dotnet_test_project(None, tmp_path)

        assert found is not None
        assert "test" in found.stem.lower()

    def test_it_adds_one_package_per_command(self, tmp_path: Path, monkeypatch):
        _solution(tmp_path)
        selection = resolve_selection(
            tmp_path, "csharp", ["xunit", "fluentassertions", "moq"]
        )
        ran: list[list[str]] = []

        monkeypatch.setattr(
            "test_generation.package_install.find_executable",
            lambda name: f"/usr/bin/{name}",
        )
        monkeypatch.setattr(
            "test_generation.package_install._run",
            lambda command, cwd: (ran.append(command), InstallStep(command, True, ""))[
                1
            ],
        )

        report = install_missing(selection, tmp_path, tmp_path / "tests" / "App.Tests")

        assert report.ok is True
        assert report.installed == ["fluentassertions", "moq"]
        # xunit is already referenced: it is not re-added.
        assert [command[-1] for command in ran] == ["FluentAssertions", "Moq"]
        assert all("add" in command for command in ran)

    def test_a_failed_command_is_reported_not_raised(self, tmp_path: Path, monkeypatch):
        _solution(tmp_path)
        selection = resolve_selection(tmp_path, "csharp", ["moq"])

        monkeypatch.setattr(
            "test_generation.package_install.find_executable",
            lambda name: f"/usr/bin/{name}",
        )
        monkeypatch.setattr(
            "test_generation.package_install._run",
            lambda command, cwd: InstallStep(command, False, "NU1101: not found"),
        )

        report = install_missing(selection, tmp_path)

        assert report.ok is False
        assert report.installed == []
        assert "NU1101" in report.steps[0].output

    def test_no_dotnet_reports_the_commands_instead_of_failing_silently(
        self, tmp_path: Path, monkeypatch
    ):
        _solution(tmp_path)
        selection = resolve_selection(tmp_path, "csharp", ["moq"])

        monkeypatch.setattr(
            "test_generation.package_install.find_executable", lambda name: None
        )

        report = install_missing(selection, tmp_path)

        assert report.ok is False
        assert report.reason == "dotnet_not_found"
        assert any("Moq" in command for command in report.manual_commands)

    def test_nothing_missing_runs_nothing(self, tmp_path: Path, monkeypatch):
        _solution(tmp_path)
        selection = resolve_selection(tmp_path, "csharp", ["xunit"])

        def _explode(*_args, **_kwargs):  # pragma: no cover — must not be reached
            raise AssertionError("no command should run")

        monkeypatch.setattr("test_generation.package_install._run", _explode)

        report = install_missing(selection, tmp_path)

        assert report.ok is True
        assert report.reason == "nothing_missing"

    @pytest.mark.parametrize("ecosystem_language", ["python"])
    def test_pip_is_reported_never_run(
        self, tmp_path: Path, monkeypatch, ecosystem_language: str
    ):
        """A pip install lands in whichever environment happens to be active."""
        _write(tmp_path / "requirements.txt", "pytest\n")
        selection = resolve_selection(
            tmp_path, ecosystem_language, ["pytest", "hypothesis"]
        )

        def _explode(*_args, **_kwargs):  # pragma: no cover — must not be reached
            raise AssertionError("no command should run")

        monkeypatch.setattr("test_generation.package_install._run", _explode)

        report = install_missing(selection, tmp_path)

        assert report.manual_commands == ["pip install hypothesis"]


class TestAddPackagesAction:
    def test_it_refuses_without_a_selection(self, tmp_path: Path):
        proc = subprocess.run(
            [
                sys.executable,
                str(RUNNER),
                "--action",
                "add-packages",
                "--project-path",
                str(tmp_path),
            ],
            capture_output=True,
            text=True,
            cwd=str(BACKEND),
        )

        assert proc.returncode == 1
        structured = next(
            json.loads(line[len("__TG_ERROR__:") :])
            for line in proc.stdout.splitlines()
            if line.startswith("__TG_ERROR__:")
        )
        assert structured["code"] == "invalid_input"

    def test_generation_never_installs_anything(self, tmp_path: Path):
        """The two actions are separate on purpose: writing a test must not
        edit the project's .csproj."""
        runner = _load_runner()

        assert "add-packages" in runner._ACTION_HANDLERS
        assert "resolve-libraries" in runner._ACTION_HANDLERS
        source = Path(runner.__file__).read_text(encoding="utf-8")
        generate_unit = source.split("def _run_generate_unit")[1].split("def ")[0]
        assert "install" not in generate_unit
