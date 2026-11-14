"""Every stack's test command, and .NET's choice of what ``dotnet test`` is given.

The flaky detective said "the command failed before running the tests" on a
.NET solution that listed no test project: ``dotnet test Rag.sln`` restored,
built, ran nothing and exited 0. These tests hold the fix (target the test
projects, Microsoft.Testing.Platform's own report options) and the stacks added
with it (Jest without a plugin, ``node --test``, cargo, PHPUnit/Pest, RSpec,
Dart/Flutter, Swift). The fixtures are trimmed from real runs.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from runners import flaky_tests_runner as ftr  # noqa: E402
from suite_runner import converters, dotnet  # noqa: E402
from suite_runner import runs as tr  # noqa: E402
from suite_runner.only import dotnet_filters  # noqa: E402

XUNIT = '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="xunit" Version="2.9.3" /></ItemGroup></Project>'
XUNIT_V3 = '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="xunit.v3.mtp-v2" Version="3.2.0" /></ItemGroup></Project>'
MSTEST = '<Project Sdk="MSTest.Sdk/4.0.2"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>'
LIBRARY = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>'


def _write(path: Path, text: str = "") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _sln(root: Path, name: str, *projects: str) -> Path:
    body = "Microsoft Visual Studio Solution File, Format Version 12.00\n"
    for index, project in enumerate(projects):
        stem = Path(project).stem
        body += (
            f'Project("{{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}}") = "{stem}", '
            f'"{project.replace("/", chr(92))}", "{{00000000-0000-0000-0000-00000000000{index}}}"\n'
            "EndProject\n"
        )
    return _write(root / name, body)


def _rag(root: Path) -> None:
    """Leub's layout: Rag.sln lists the four layers, not the tests."""
    layers = [
        f"src/Rag.{n}/Rag.{n}.csproj"
        for n in ("Domain", "Application", "Infrastructure", "Api")
    ]
    for layer in layers:
        _write(root / layer, LIBRARY)
    _sln(root, "Rag.sln", *layers)


# --- .NET: what dotnet test is given ------------------------------------------


@pytest.mark.parametrize(
    ("stem", "text", "expected"),
    [
        ("Rag.Tests", LIBRARY, True),  # a Directory.Build.props adds the packages
        ("RagTests", LIBRARY, True),
        ("Rag.Api.IntegrationTest", LIBRARY, True),
        ("Contest", LIBRARY, False),
        ("Rag.Latest", LIBRARY, False),
        ("Rag.Api", XUNIT, True),
        ("Rag.Api", MSTEST, True),
        (
            "Rag.Tests",
            "<Project><PropertyGroup><IsTestProject>false</IsTestProject></PropertyGroup></Project>",
            False,
        ),
        (
            "Checks",
            "<Project><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>",
            True,
        ),
    ],
)
def test_a_test_project_is_recognised(stem: str, text: str, expected: bool) -> None:
    assert dotnet.is_test_project(Path(f"{stem}.csproj"), text) is expected


def test_a_solution_without_tests_is_not_the_target(tmp_path: Path) -> None:
    _rag(tmp_path)
    _write(tmp_path / "tests" / "Rag.Tests" / "Rag.Tests.csproj", XUNIT)
    plan = dotnet.dotnet_plan(tmp_path)
    assert plan is not None
    assert plan.target == "tests/Rag.Tests/Rag.Tests.csproj"
    assert plan.command == "dotnet test tests/Rag.Tests/Rag.Tests.csproj"


def test_the_solution_that_lists_the_tests_wins(tmp_path: Path) -> None:
    _rag(tmp_path)
    _write(tmp_path / "tests" / "Rag.Tests" / "Rag.Tests.csproj", XUNIT)
    _sln(
        tmp_path,
        "All.sln",
        "src/Rag.Api/Rag.Api.csproj",
        "tests/Rag.Tests/Rag.Tests.csproj",
    )
    plan = dotnet.dotnet_plan(tmp_path)
    assert plan is not None and plan.target == "All.sln"


def test_test_projects_outside_any_solution_run_one_by_one(tmp_path: Path) -> None:
    _rag(tmp_path)
    _write(tmp_path / "tests" / "Rag.Domain.Tests" / "Rag.Domain.Tests.csproj", XUNIT)
    _write(tmp_path / "tests" / "Rag.Api.Tests" / "Rag.Api.Tests.csproj", XUNIT)
    plan = dotnet.dotnet_plan(tmp_path)
    assert plan is not None and plan.target == ""
    steps = dotnet.dotnet_steps(plan, tmp_path / "out", no_build=True)
    assert [s[2] for s in steps] == [
        "tests/Rag.Api.Tests/Rag.Api.Tests.csproj",
        "tests/Rag.Domain.Tests/Rag.Domain.Tests.csproj",
    ]
    # Two projects finishing in the same second never write the same file.
    assert [s[4] for s in steps] == [
        "trx;LogFilePrefix=flaky-01",
        "trx;LogFilePrefix=flaky-02",
    ]
    assert all(s[-1] == "--no-build" for s in steps)
    assert " && " in plan.command


def test_a_path_with_spaces_stays_one_argument(tmp_path: Path) -> None:
    root = tmp_path / "IA - LLM - RAG" / "dotnet"
    _write(root / "My Tests" / "My.Tests.csproj", XUNIT)
    plan = dotnet.dotnet_plan(root)
    assert plan is not None
    (step,) = dotnet.dotnet_steps(plan, root / "out dir", no_build=False)
    assert step[:3] == ["dotnet", "test", "My Tests/My.Tests.csproj"]
    assert step[step.index("--results-directory") + 1] == str(root / "out dir")
    assert plan.command == 'dotnet test "My Tests/My.Tests.csproj"'


def test_no_test_project_means_no_dotnet_command(tmp_path: Path) -> None:
    _rag(tmp_path)
    assert dotnet.dotnet_plan(tmp_path) is None
    assert dotnet.has_dotnet_projects(tmp_path)
    with pytest.raises(ftr.RunError, match="^no_dotnet_tests:"):
        ftr._pick_command(tmp_path, "dotnet")


def test_microsoft_testing_platform_uses_each_framework_report(tmp_path: Path) -> None:
    _write(
        tmp_path / "global.json",
        '{\n  // .NET 10\n  "test": {"runner": "Microsoft.Testing.Platform"}\n}',
    )
    _write(tmp_path / "tests" / "A.Tests" / "A.Tests.csproj", XUNIT_V3)
    _write(tmp_path / "tests" / "B.Tests" / "B.Tests.csproj", MSTEST)
    _sln(
        tmp_path,
        "Sol.sln",
        "tests/A.Tests/A.Tests.csproj",
        "tests/B.Tests/B.Tests.csproj",
    )
    plan = dotnet.dotnet_plan(tmp_path)
    assert plan is not None and plan.mtp
    assert plan.xunit_v3 == ("tests/A.Tests/A.Tests.csproj",)
    filters = dotnet_filters(["A.T.Flaky", "B.T.Slow"])
    xunit, mstest = dotnet.dotnet_steps(
        plan, tmp_path / "out", no_build=False, filters=filters
    )
    # MTP refuses --logger: each test app gets its own report option.
    assert "--logger" not in xunit + mstest
    assert xunit[2:4] == ["--project", "tests/A.Tests/A.Tests.csproj"]
    assert "--report-xunit-trx" in xunit and "--report-trx" in mstest
    assert xunit[-4:] == ["--filter-method", "A.T.Flaky", "--filter-method", "B.T.Slow"]
    assert mstest[-2] == "--filter" and "FullyQualifiedName~A.T.Flaky" in mstest[-1]
    assert plan.command.startswith(
        "dotnet test --project tests/A.Tests/A.Tests.csproj && "
    )


def test_mtp_is_off_without_global_json_runner(tmp_path: Path) -> None:
    _write(tmp_path / "global.json", '{"sdk": {"version": "10.0.100"}}')
    _write(tmp_path / "T.Tests.csproj", XUNIT)
    plan = dotnet.dotnet_plan(tmp_path)
    assert plan is not None and not plan.mtp


def test_trx_names_carry_their_class(tmp_path: Path) -> None:
    # MSTest writes testName="Flaky": two classes with a Flaky would merge.
    trx = _write(
        tmp_path / "ms.trx",
        '<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">'
        '<Results><UnitTestResult testId="a" testName="Flaky" outcome="Failed" duration="00:00:00.01"/>'
        '<UnitTestResult testId="b" testName="X3.T.Ok" outcome="Passed"/></Results>'
        '<TestDefinitions><UnitTest id="a"><TestMethod className="Ms.T" name="Flaky"/></UnitTest>'
        '<UnitTest id="b"><TestMethod className="X3.T" name="Ok"/></UnitTest></TestDefinitions>'
        "</TestRun>",
    )
    names = {r.test_name: r.passed for r in ftr._parse_report_file(trx, "r")}
    assert names == {"Ms.T.Flaky": False, "X3.T.Ok": True}


# --- the other stacks -----------------------------------------------------------


def test_each_stack_is_detected(tmp_path: Path) -> None:
    def ids(files: dict[str, str]) -> list[str]:
        root = tmp_path / str(len(list(tmp_path.iterdir())))
        for name, text in files.items():
            _write(root / name, text)
        return [c.id for c in tr.detect_test_commands(root)]

    assert ids({"Cargo.toml": "[package]"}) == ["cargo"]
    assert ids(
        {"composer.json": json.dumps({"require-dev": {"phpunit/phpunit": "^11"}})}
    ) == ["phpunit"]
    assert ids(
        {"composer.json": json.dumps({"require-dev": {"pestphp/pest": "^3"}})}
    ) == ["pest"]
    assert ids({"phpunit.xml.dist": "<phpunit/>"}) == ["phpunit"]
    assert ids({"Gemfile": 'gem "rspec"'}) == ["rspec"]
    assert ids({"Gemfile": 'gem "rails"'}) == []
    assert ids({"pubspec.yaml": "name: a\ndev_dependencies:\n  test: any\n"}) == [
        "dart"
    ]
    assert ids(
        {"pubspec.yaml": "name: a\ndependencies:\n  flutter:\n    sdk: flutter\n"}
    ) == ["flutter"]
    assert ids({"Package.swift": "// swift-tools-version:5.9"}) == ["swift"]


def test_php_and_ruby_use_the_installed_binaries(tmp_path: Path) -> None:
    _write(
        tmp_path / "composer.json",
        json.dumps({"require-dev": {"phpunit/phpunit": "^11"}}),
    )
    _write(tmp_path / "vendor" / "bin" / "phpunit")
    _write(tmp_path / "Gemfile", "gem 'rspec'")
    commands = {c.id: c.command for c in tr.detect_test_commands(tmp_path)}
    assert commands == {"phpunit": "vendor/bin/phpunit", "rspec": "bundle exec rspec"}


@pytest.mark.parametrize(
    ("cid", "command", "expected", "convert"),
    [
        ("jest", "npx jest --ci", ["--json", "--outputFile={out}/jest.json"], "jest"),
        (
            "node",
            "node --test",
            ["--test-reporter=junit", "--test-reporter-destination={out}/junit.xml"],
            "",
        ),
        ("cargo", "cargo test --no-fail-fast", ["--no-fail-fast"], "cargo"),
        ("phpunit", "phpunit", ["--log-junit", "{out}/junit.xml"], ""),
        ("pest", "pest", ["--log-junit", "{out}/junit.xml"], ""),
        (
            "rspec",
            "rspec",
            ["progress", "--format", "json", "--out", "{out}/rspec.json"],
            "rspec",
        ),
        ("dart", "dart test", ["--file-reporter", "json:{out}/dart.json"], "dart"),
        (
            "flutter",
            "flutter test",
            ["--file-reporter", "json:{out}/dart.json"],
            "dart",
        ),
        (
            "swift",
            "swift test",
            ["--parallel", "--xunit-output", "{out}/junit.xml"],
            "",
        ),
    ],
)
def test_report_options_per_stack(
    tmp_path: Path, cid: str, command: str, expected: list[str], convert: str
) -> None:
    out = tmp_path / "out"
    invocation = tr._invocation(
        tr.TestCommand(cid, cid, command), tmp_path, out, no_build=False
    )
    argv = invocation.argv
    wanted = [part.replace("{out}/", str(out) + os.sep) for part in expected]
    start = next(i for i, part in enumerate(argv) if part == wanted[0])
    assert argv[start : start + len(wanted)] == wanted
    assert invocation.convert == convert


def test_a_name_the_stack_cannot_filter_is_refused(tmp_path: Path) -> None:
    command = tr.TestCommand("cargo", "Rust", "cargo test")
    outcome = tr.run_once(
        command, tmp_path, tmp_path / "run", timeout_s=5, only=["--nocapture"]
    )
    assert outcome.error == "the tests named cannot be selected with this command"


# --- converters (fixtures from real runs) ---------------------------------------

CARGO = """\
     Running unittests src/lib.rs (target/debug/deps/rustapp-ba76bde961f977cc)

running 3 tests
test tests::skipped ... ignored
test tests::ok ... ok
test tests::flaky ... FAILED

failures:

---- tests::flaky stdout ----

thread 'tests::flaky' (8605) panicked at src/lib.rs:8:9:
odd nanos

failures:
    tests::flaky

test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.07s

     Running tests/api.rs (target/debug/deps/api-1a2b)

running 1 test
test ok ... ok, finished in 0.01s
   Doc-tests rustapp

running 0 tests
"""

DART = [
    {"suite": {"id": 0, "path": "test/a_test.dart"}, "type": "suite", "time": 0},
    {
        "test": {"id": 1, "name": "loading test/a_test.dart", "suiteID": 0},
        "type": "testStart",
        "time": 2,
    },
    {
        "testID": 1,
        "result": "success",
        "skipped": False,
        "hidden": True,
        "type": "testDone",
        "time": 347,
    },
    {"test": {"id": 3, "name": "ok", "suiteID": 0}, "type": "testStart", "time": 350},
    {
        "testID": 3,
        "result": "success",
        "skipped": False,
        "hidden": False,
        "type": "testDone",
        "time": 359,
    },
    {
        "test": {"id": 5, "name": "grp flaky", "suiteID": 0},
        "type": "testStart",
        "time": 360,
    },
    {
        "testID": 5,
        "error": "Expected: true\n  Actual: <false>\n",
        "isFailure": True,
        "type": "error",
        "time": 371,
    },
    {
        "testID": 5,
        "result": "failure",
        "skipped": False,
        "hidden": False,
        "type": "testDone",
        "time": 371,
    },
    {
        "test": {"id": 6, "name": "loading test/broken_test.dart", "suiteID": 1},
        "type": "testStart",
        "time": 2,
    },
    {"suite": {"id": 1, "path": "test/broken_test.dart"}, "type": "suite", "time": 0},
    {
        "testID": 6,
        "error": "Error: Expected ';'",
        "isFailure": False,
        "type": "error",
        "time": 5,
    },
    {
        "testID": 6,
        "result": "error",
        "skipped": False,
        "hidden": True,
        "type": "testDone",
        "time": 6,
    },
    {"success": False, "type": "done", "time": 379},
]


def _results(report: Path | None) -> dict[str, bool]:
    assert report is not None
    return {r.test_name: r.passed for r in ftr._parse_report_file(report, "r")}


def test_cargo_output_becomes_junit(tmp_path: Path) -> None:
    report = converters.cargo_output_to_junit(CARGO.splitlines(), tmp_path / "j.xml")
    assert _results(report) == {
        "src/lib.rs::tests::ok": True,
        "src/lib.rs::tests::flaky": False,  # ignored left out
        "tests/api.rs::ok": True,
    }
    runs = ftr._parse_report_file(report, "r")  # type: ignore[arg-type]
    assert "odd nanos" in next(r for r in runs if not r.passed).error_message
    assert (
        converters.cargo_output_to_junit(["error[E0425]: oops"], tmp_path / "n.xml")
        is None
    )


def test_dart_json_becomes_junit(tmp_path: Path) -> None:
    lines = [json.dumps(e) for e in DART]
    report = converters.dart_json_to_junit(lines, tmp_path / "j.xml")
    assert _results(report) == {
        "test/a_test.dart::ok": True,
        "test/a_test.dart::grp flaky": False,
        # A file that does not compile fails its hidden loading test: shown.
        "test/broken_test.dart::loading test/broken_test.dart": False,
    }


def test_jest_json_becomes_junit(tmp_path: Path) -> None:
    root = tmp_path / "web"
    data = {
        "testResults": [
            {
                "name": str(root / "src" / "a.test.js"),
                "status": "failed",
                "assertionResults": [
                    {
                        "ancestorTitles": [],
                        "title": "ok",
                        "status": "passed",
                        "duration": 3,
                    },
                    {
                        "ancestorTitles": ["grp"],
                        "title": "flaky",
                        "status": "failed",
                        "failureMessages": ["Expected: < 0.5"],
                    },
                    {"ancestorTitles": [], "title": "later", "status": "todo"},
                ],
            },
            {
                "name": str(root / "src" / "b.test.js"),
                "status": "failed",
                "message": "SyntaxError",
                "assertionResults": [],
            },
        ]
    }
    source = _write(tmp_path / "jest.json", json.dumps(data))
    report = converters.jest_json_to_junit(source, tmp_path / "j.xml", root)
    assert _results(report) == {
        "src/a.test.js::ok": True,
        "src/a.test.js::grp > flaky": False,
        "src/b.test.js::src/b.test.js": False,
    }


def test_rspec_json_becomes_junit(tmp_path: Path) -> None:
    data = {
        "examples": [
            {
                "file_path": "./spec/a_spec.rb",
                "full_description": "Calc adds",
                "status": "passed",
                "run_time": 0.001,
            },
            {
                "file_path": "./spec/a_spec.rb",
                "full_description": "Calc flakes",
                "status": "failed",
                "exception": {"message": "expected 1, got 0"},
            },
            {
                "file_path": "./spec/a_spec.rb",
                "full_description": "Calc later",
                "status": "pending",
            },
        ]
    }
    source = _write(tmp_path / "rspec.json", json.dumps(data))
    report = converters.rspec_json_to_junit(source, tmp_path / "j.xml")
    assert _results(report) == {
        "spec/a_spec.rb::Calc adds": True,
        "spec/a_spec.rb::Calc flakes": False,
    }
    assert (
        converters.rspec_json_to_junit(tmp_path / "missing.json", tmp_path / "x.xml")
        is None
    )


# --- several steps, and a run that ran no test ---------------------------------


class _Process:
    def __init__(self, code: int) -> None:
        self.code = code
        self.pid = 1

    def wait(self, timeout: float | None = None) -> int:
        return self.code

    def poll(self) -> int:
        return self.code


def test_steps_run_in_turn_and_the_first_failure_is_the_exit_code(
    tmp_path: Path,
) -> None:
    _write(tmp_path / "tests" / "A.Tests" / "A.Tests.csproj", XUNIT)
    _write(tmp_path / "tests" / "B.Tests" / "B.Tests.csproj", XUNIT)
    (command,) = tr.detect_test_commands(tmp_path)
    seen: list[list[str]] = []
    codes = iter([1, 0])

    def popen(argv, **kwargs):
        seen.append(argv)
        out = Path(argv[argv.index("--results-directory") + 1])
        _write(out / f"{len(seen)}.trx", "<TestRun/>")
        return _Process(next(codes))

    outcome = tr.run_once(
        command, tmp_path, tmp_path / "run", timeout_s=60, popen=popen
    )
    assert len(seen) == 2 and outcome.exit_code == 1
    assert [p.name for p in outcome.reports] == ["1.trx", "2.trx"]
    assert "$ dotnet test tests/A.Tests/A.Tests.csproj" in outcome.output_tail


def _run_with(monkeypatch: pytest.MonkeyPatch, outcome: tr.RunOutcome) -> None:
    monkeypatch.setattr(ftr, "run_once", lambda *a, **k: outcome)
    monkeypatch.setattr(ftr, "install_cancel_handler", lambda: None)


def test_a_run_that_ran_no_test_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write(tmp_path / "go.mod", "module x")
    log = _write(
        tmp_path / ".workpilot" / "flaky-tests" / "runs" / "s" / "run-01" / "output.log"
    )
    _run_with(monkeypatch, tr.RunOutcome(0, output_tail="Restored App.csproj", log=log))
    with pytest.raises(ftr.RunError) as error:
        ftr.run_repeated(
            tmp_path, runs=3, command_id="go", threshold=0.05, min_runs=2, timeout_s=60
        )
    head, log_line, tail = str(error.value).split("\n", 2)
    assert head.startswith("no_tests:")
    assert log_line == "log: .workpilot/flaky-tests/runs/s/run-01/output.log"
    assert tail == "Restored App.csproj"


def test_an_empty_report_is_no_test_and_a_failure_without_report_is_no_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write(tmp_path / "go.mod", "module x")
    empty = _write(tmp_path / "junit.xml", "<testsuite/>")
    _run_with(monkeypatch, tr.RunOutcome(5, reports=[empty]))
    with pytest.raises(ftr.RunError, match="^no_tests:"):
        ftr.run_repeated(
            tmp_path, runs=2, command_id="go", threshold=0.05, min_runs=2, timeout_s=60
        )
    _run_with(monkeypatch, tr.RunOutcome(1, output_tail="error CS1002"))
    with pytest.raises(ftr.RunError, match="^no_results:"):
        ftr.run_repeated(
            tmp_path, runs=2, command_id="go", threshold=0.05, min_runs=2, timeout_s=60
        )
