"""Integration tests before code, for an ASP.NET Core API (plan of 29 October, IA6).

The phase hands the session one job — the spec's acceptance criteria as HTTP
tests — and then trusts nothing it says: Python reads what was written, runs
it, and sets the goal only for red tests confined to a test project. Every
other outcome leaves the task without a goal it did not ask for.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

import goal.check as goal_check  # noqa: E402
from goal.check import GoalRun  # noqa: E402
from goal.spec import GOAL_FILENAME, load_goal  # noqa: E402

from workflows import spec_by_example_phase as sbe  # noqa: E402

API_CSPROJ = '<Project Sdk="Microsoft.NET.Sdk.Web">\n</Project>\n'
TEST_CSPROJ = (
    '<Project Sdk="Microsoft.NET.Sdk">\n'
    "  <ItemGroup>\n"
    '    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />\n'
    '    <PackageReference Include="xunit" Version="2.9.2" />\n'
    "  </ItemGroup>\n"
    "</Project>\n"
)
TEST_FILE = "tests/Api.Tests/OrdersEndpointTests.cs"


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=True
    ).stdout


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


@pytest.fixture(autouse=True)
def _switch_off(monkeypatch):
    monkeypatch.delenv(sbe.ENV_SWITCH, raising=False)


@pytest.fixture
def api(tmp_path) -> Path:
    """An ASP.NET Core solution: an API project and an xUnit test project."""
    repo = tmp_path / "shop"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@example.com")
    _git(repo, "config", "user.name", "t")
    _write(repo, "Shop.sln", "Microsoft Visual Studio Solution File\n")
    _write(repo, "src/Api/Api.csproj", API_CSPROJ)
    _write(repo, "src/Api/Program.cs", "var app = WebApplication.Create();\n")
    _write(repo, "tests/Api.Tests/Api.Tests.csproj", TEST_CSPROJ)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "init")
    return repo


@pytest.fixture
def spec_dir(tmp_path) -> Path:
    path = tmp_path / "wt-specs" / "007-orders"
    path.mkdir(parents=True)
    return path


@pytest.fixture
def ctx(api, spec_dir, tmp_path):
    source = tmp_path / "main-specs" / spec_dir.name
    source.mkdir(parents=True)
    return SimpleNamespace(
        project_dir=api,
        spec_dir=spec_dir,
        source_spec_dir=source,
        model="sonnet",
        verbose=False,
    )


@pytest.fixture
def resolved():
    phase = SimpleNamespace(id="spec-by-example", impl="tooling/tdd-cycle")
    return SimpleNamespace(phase=phase, dispatch="fresh-context")


class TestWhetherItRuns:
    def test_off_by_default(self, spec_dir):
        assert sbe.enabled(spec_dir) is False

    def test_the_project_switch(self, spec_dir, monkeypatch):
        monkeypatch.setenv(sbe.ENV_SWITCH, "1")
        assert sbe.enabled(spec_dir) is True

    def test_the_task_wins_both_ways(self, spec_dir, monkeypatch):
        meta = spec_dir / "task_metadata.json"
        monkeypatch.setenv(sbe.ENV_SWITCH, "1")
        meta.write_text(json.dumps({"specByExample": False}), encoding="utf-8")
        assert sbe.enabled(spec_dir) is False

        monkeypatch.delenv(sbe.ENV_SWITCH)
        meta.write_text(json.dumps({"specByExample": True}), encoding="utf-8")
        assert sbe.enabled(spec_dir) is True

        # Anything but a boolean is not a choice.
        meta.write_text(json.dumps({"specByExample": "yes"}), encoding="utf-8")
        assert sbe.enabled(spec_dir) is False


class TestTestProjects:
    def test_found_and_http_tests_first(self, api):
        _write(
            api,
            "tests/Web.Tests/Web.Tests.csproj",
            TEST_CSPROJ.replace(
                "</ItemGroup>",
                '<PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" />'
                "</ItemGroup>",
            ),
        )
        names = [p.name for p in sbe.test_projects(api)]
        assert names == ["Web.Tests.csproj", "Api.Tests.csproj"]

    def test_the_api_project_is_not_a_test_project(self, api):
        assert not sbe.is_test_project(api / "src/Api/Api.csproj")

    def test_a_file_belongs_to_the_nearest_test_project(self, api):
        root = api.resolve()
        owner = sbe.owning_test_project(root / "tests/Api.Tests/Orders/A.cs", root)
        assert owner == root / "tests/Api.Tests/Api.Tests.csproj"
        assert sbe.owning_test_project(root / "src/Api/Program.cs", root) is None
        assert sbe.owning_test_project(root / "README.md", root) is None


class TestWhatWasWritten:
    def test_new_and_reedited_files_count(self, api):
        _write(api, "notes.txt", "dirty before\n")
        before = sbe.changed_paths(api)
        _write(api, TEST_FILE, "public class OrdersEndpointTests {}\n")
        _write(api, "notes.txt", "edited again\n")
        after = sbe.changed_paths(api)

        assert sbe.written_since(before, after) == ["notes.txt", TEST_FILE]

    def test_files_are_sorted_into_tests_and_outside(self, api):
        tests, outside, projects = sbe.classify(
            api,
            [
                TEST_FILE,
                "tests/Api.Tests/Api.Tests.csproj",
                "Shop.sln",
                "src/Api/Program.cs",
            ],
        )
        assert tests == [TEST_FILE, "tests/Api.Tests/Api.Tests.csproj"]
        assert outside == ["src/Api/Program.cs"]
        assert [p.name for p in projects] == ["Api.Tests.csproj"]

    def test_a_solution_file_in_a_subfolder_is_not_exempt(self, api):
        _, outside, _ = sbe.classify(api, ["src/Other.sln"])
        assert outside == ["src/Other.sln"]


class TestTheGoal:
    def test_one_project_is_named(self, api):
        project = api.resolve() / "tests/Api.Tests/Api.Tests.csproj"
        assert (
            sbe.goal_command(api, [project])
            == 'dotnet test "tests/Api.Tests/Api.Tests.csproj"'
        )

    def test_several_projects_run_the_solution(self, api):
        root = api.resolve()
        projects = [root / "a/A.Tests.csproj", root / "b/B.Tests.csproj"]
        assert sbe.goal_command(api, projects) == 'dotnet test "Shop.sln"'
        (api / "Shop.sln").unlink()
        assert sbe.goal_command(api, projects) is None

    def test_protected_are_the_files_written_up_to_the_cap(self, api):
        project = api.resolve() / "tests/Api.Tests/Api.Tests.csproj"
        few = [TEST_FILE, "tests/Api.Tests/Api.Tests.csproj"]
        assert sbe.protected_paths(few, [project], api) == [TEST_FILE]
        many = [f"tests/Api.Tests/T{i}.cs" for i in range(sbe.MAX_PROTECTED + 1)]
        assert sbe.protected_paths(many, [project], api) == ["tests/Api.Tests/**/*.cs"]

    @pytest.mark.parametrize(
        ("run", "state"),
        [
            (GoalRun("error", detail="could not start"), "error"),
            (GoalRun("met", exit_code=0), "green"),
            (GoalRun("unmet", exit_code=1, output_tail="error CS0246: type"), "broken"),
            (GoalRun("unmet", exit_code=1, output_tail="Build FAILED."), "broken"),
            (GoalRun("unmet", exit_code=1, output_tail="Failed! - Failed: 3"), "red"),
        ],
    )
    def test_how_a_run_reads(self, run, state):
        assert sbe.read_run(run) == state

    def test_the_goal_is_the_one_the_gate_reads(self, tmp_path):
        main, worktree = tmp_path / "main", tmp_path / "wt"
        main.mkdir()
        worktree.mkdir()
        written = sbe.write_goal(
            [main, worktree], 'dotnet test "T.csproj"', [TEST_FILE]
        )

        assert written == [main / GOAL_FILENAME, worktree / GOAL_FILENAME]
        goal = load_goal(main, worktree)
        assert goal.command == 'dotnet test "T.csproj"'
        assert goal.expected_exit == 0 and goal.protected == (TEST_FILE,)
        raw = json.loads((main / GOAL_FILENAME).read_text(encoding="utf-8"))
        assert raw["origin"] == sbe.ORIGIN
        assert not list(main.glob("*.tmp"))


class TestThePhase:
    def _run(self, resolved, ctx):
        return asyncio.run(sbe.run_spec_by_example_phase(resolved, ctx))

    def _session_writes(self, monkeypatch, files: dict[str, str], calls=None):
        async def session(ctx, prompt):
            if calls is not None:
                calls.append(prompt)
            for rel, text in files.items():
                _write(Path(ctx.project_dir), rel, text)
            return "continue", "I wrote the tests."

        monkeypatch.setattr(sbe, "_session", session)

    def _dotnet(self, monkeypatch, run: GoalRun, seen=None):
        def fake(spec, worktree, **_kwargs):
            if seen is not None:
                seen.append(spec.command)
            return run

        monkeypatch.setattr(goal_check, "run_goal", fake)

    def _goals(self, ctx):
        return [
            d / GOAL_FILENAME
            for d in (ctx.spec_dir, ctx.source_spec_dir)
            if (d / GOAL_FILENAME).exists()
        ]

    def test_off_it_opens_no_session(self, resolved, ctx, monkeypatch):
        async def boom(*_a, **_k):
            raise AssertionError("no session when the switch is off")

        monkeypatch.setattr(sbe, "_session", boom)
        result = self._run(resolved, ctx)
        assert result.succeeded is None and "not turned on" in result.detail

    def test_not_an_aspnet_project(self, resolved, ctx, monkeypatch, api):
        monkeypatch.setenv(sbe.ENV_SWITCH, "1")
        (api / "src/Api/Api.csproj").write_text(
            '<Project Sdk="Microsoft.NET.Sdk">\n</Project>\n', encoding="utf-8"
        )
        result = self._run(resolved, ctx)
        assert result.succeeded is None and "ASP.NET Core" in result.detail

    def test_a_goal_the_person_set_stays(self, resolved, ctx, monkeypatch):
        monkeypatch.setenv(sbe.ENV_SWITCH, "1")
        mine = {"command": "dotnet test", "expectedExit": 0}
        (ctx.source_spec_dir / GOAL_FILENAME).write_text(
            json.dumps(mine), encoding="utf-8"
        )
        self._session_writes(monkeypatch, {TEST_FILE: "x"})

        result = self._run(resolved, ctx)
        assert result.succeeded is None and "already has a goal" in result.detail
        assert (
            json.loads(
                (ctx.source_spec_dir / GOAL_FILENAME).read_text(encoding="utf-8")
            )
            == mine
        )
        assert not (ctx.project_dir / TEST_FILE).exists()

    def test_red_tests_become_the_goal(self, resolved, ctx, monkeypatch):
        monkeypatch.setenv(sbe.ENV_SWITCH, "1")
        prompts: list[str] = []
        commands: list[str] = []
        self._session_writes(
            monkeypatch,
            {TEST_FILE: "public class OrdersEndpointTests {}\n"},
            calls=prompts,
        )
        self._dotnet(
            monkeypatch,
            GoalRun("unmet", exit_code=1, output_tail="Failed! - Failed: 2"),
            commands,
        )

        result = self._run(resolved, ctx)

        assert result.succeeded is True, result.detail
        assert "tests/Api.Tests/Api.Tests.csproj" in prompts[0]
        assert "WebApplicationFactory<Program>" in prompts[0]
        assert commands == ['dotnet test "tests/Api.Tests/Api.Tests.csproj"']
        goal = load_goal(ctx.source_spec_dir)
        assert goal.command == commands[0]
        assert goal.protected == (TEST_FILE,)
        assert len(self._goals(ctx)) == 2

    def test_code_outside_the_tests_sets_no_goal(self, resolved, ctx, monkeypatch):
        monkeypatch.setenv(sbe.ENV_SWITCH, "1")
        self._session_writes(
            monkeypatch,
            {TEST_FILE: "x", "src/Api/OrdersController.cs": "public class C {}"},
        )
        self._dotnet(monkeypatch, GoalRun("unmet", exit_code=1, output_tail="Failed!"))

        result = self._run(resolved, ctx)
        assert result.succeeded is False
        assert "src/Api/OrdersController.cs" in result.detail
        assert self._goals(ctx) == []
        # Nothing is reverted: the files stay for the person to review.
        assert (ctx.project_dir / "src/Api/OrdersController.cs").exists()

    def test_tests_that_do_not_compile_set_no_goal(self, resolved, ctx, monkeypatch):
        monkeypatch.setenv(sbe.ENV_SWITCH, "1")
        self._session_writes(monkeypatch, {TEST_FILE: "x"})
        self._dotnet(
            monkeypatch,
            GoalRun("unmet", exit_code=1, output_tail="error CS0246: Order not found"),
        )
        result = self._run(resolved, ctx)
        assert result.succeeded is False and "do not compile" in result.detail
        assert self._goals(ctx) == []

    def test_green_tests_describe_nothing_missing(self, resolved, ctx, monkeypatch):
        monkeypatch.setenv(sbe.ENV_SWITCH, "1")
        self._session_writes(monkeypatch, {TEST_FILE: "x"})
        self._dotnet(monkeypatch, GoalRun("met", exit_code=0))
        result = self._run(resolved, ctx)
        assert result.succeeded is None and "already pass" in result.detail
        assert self._goals(ctx) == []

    def test_no_test_written(self, resolved, ctx, monkeypatch):
        monkeypatch.setenv(sbe.ENV_SWITCH, "1")
        self._session_writes(monkeypatch, {})
        result = self._run(resolved, ctx)
        assert result.succeeded is False and "no test" in result.detail

    def test_without_dotnet_no_goal(self, resolved, ctx, monkeypatch):
        monkeypatch.setenv(sbe.ENV_SWITCH, "1")
        self._session_writes(monkeypatch, {TEST_FILE: "x"})
        self._dotnet(
            monkeypatch, GoalRun("error", detail="the command could not start")
        )
        result = self._run(resolved, ctx)
        assert result.succeeded is None and "could not run" in result.detail
        assert self._goals(ctx) == []

    def test_a_session_that_cannot_open_is_reported(self, resolved, ctx, monkeypatch):
        monkeypatch.setenv(sbe.ENV_SWITCH, "1")

        async def refused(*_a, **_k):
            raise RuntimeError("provider unavailable")

        monkeypatch.setattr(sbe, "_session", refused)
        result = self._run(resolved, ctx)
        assert result.succeeded is None and "provider unavailable" in result.detail
        assert self._goals(ctx) == []
