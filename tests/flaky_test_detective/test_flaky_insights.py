"""A flaky test's verdict, location, causes in code, history and targeted re-runs (#351).

Every stack is read the same way, without a model: the test is found from the
name its report gives it, its body says why it may be flaky, the history says
since when and where, and a re-run keeps only the suspects with the stack's
own filter.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from flaky_test_detective.enrich import enrich_report, outcomes_of  # noqa: E402
from flaky_test_detective.flaky_analyzer import TestRun  # noqa: E402
from flaky_test_detective.history import (  # noqa: E402
    in_ci,
    load_history,
    record,
    summary,
)
from flaky_test_detective.insights import (  # noqa: E402
    find_test_files,
    locate_test,
    parse_test_name,
    source_causes,
    stack_of,
    verdict,
)
from suite_runner.only import filter_args  # noqa: E402


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


# --- verdict -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("rate", "expected"),
    [
        (0.9, "likely_bug"),
        (0.81, "likely_bug"),
        (0.8, "flaky"),
        (0.2, "flaky"),
        (0.19, "rare"),
        (0.05, "rare"),
    ],
)
def test_the_verdict_follows_the_failure_rate(rate: float, expected: str) -> None:
    assert verdict(rate) == expected


# --- names -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "parsed"),
    [
        ("tests.test_cart::test_adds[2]", ("tests.test_cart", "test_adds")),
        ("Shop.Tests.CartTests.Adds(qty: 2)", ("Shop.Tests.CartTests", "Adds")),
        ("src/cart.test.ts::Cart > adds an item", ("src/cart.test.ts", "adds an item")),
        ("com.shop.CartTest::addsItem", ("com.shop.CartTest", "addsItem")),
        ("TestCart/empty", ("", "TestCart/empty")),
    ],
)
def test_every_report_s_name_gives_its_test(name: str, parsed: tuple[str, str]) -> None:
    assert parse_test_name(name) == parsed


# --- location and causes -------------------------------------------------------------


@pytest.fixture
def project(tmp_path: Path) -> Path:
    _write(
        tmp_path / "tests" / "test_cart.py",
        "import time\n\n\ndef test_other():\n    assert True\n\n\n"
        "def test_adds(client):\n    time.sleep(0.5)  # wait for the worker\n"
        "    r = requests.get('https://api.shop.io/items')\n    assert r.ok\n\n\ndef test_last():\n    pass\n",
    )
    _write(
        tmp_path / "web" / "cart.test.ts",
        "beforeAll(() => { server.listen(4000); });\n\ndescribe('Cart', () => {\n"
        "  it('adds an item', async () => {\n    const id = Math.random();\n    await new Promise(r => setTimeout(r, 50));\n"
        "    expect(add(id)).toBe(true);\n  });\n});\n",
    )
    _write(
        tmp_path / "Shop.Tests" / "CartTests.cs",
        "public class CartTests\n{\n    private static int Count = 0;\n\n    [Fact]\n    public async Task Adds()\n    {\n"
        "        Count++;\n        var at = DateTime.Now;\n        await Task.Delay(100);\n        Assert.True(true);\n    }\n}\n",
    )
    _write(
        tmp_path / "cart" / "cart_test.go",
        "package cart\n\nfunc TestCart(t *testing.T) {\n\tgo func() { work() }()\n\ttime.Sleep(10 * time.Millisecond)\n}\n",
    )
    _write(tmp_path / "src" / "cart.py", "def adds():\n    time.sleep(1)\n")
    return tmp_path


def test_test_files_are_found_on_every_stack(project: Path) -> None:
    assert find_test_files(project) == [
        "Shop.Tests/CartTests.cs",
        "cart/cart_test.go",
        "tests/test_cart.py",
        "web/cart.test.ts",
    ]


def test_a_python_test_s_body_shows_its_sleep_and_its_network(project: Path) -> None:
    location = locate_test(project, "tests.test_cart::test_adds[2]")

    assert location is not None and (location.path, location.line) == (
        "tests/test_cart.py",
        8,
    )
    assert "test_last" not in location.body
    causes = {c.cause: c.evidence for c in source_causes(location)}
    assert set(causes) == {"timing", "network"}
    assert causes["timing"][0] == {
        "line": 9,
        "text": "time.sleep(0.5)  # wait for the worker",
    }


def test_a_titled_js_test_shows_randomness_timing_and_a_fixed_port(
    project: Path,
) -> None:
    location = locate_test(project, "web/cart.test.ts::Cart > adds an item")

    assert location is not None and location.line == 4
    causes = [c.cause for c in source_causes(location)]
    assert {"randomness", "timing", "resource_leak"} <= set(causes)


def test_a_dotnet_test_shows_static_state_the_clock_and_a_delay(project: Path) -> None:
    location = locate_test(project, "Shop.Tests.CartTests.Adds")

    assert location is not None and location.path == "Shop.Tests/CartTests.cs"
    assert {"randomness", "timing"} <= {c.cause for c in source_causes(location)}


def test_a_go_test_shows_its_goroutine(project: Path) -> None:
    location = locate_test(project, "cart::TestCart")

    assert location is not None
    assert {"concurrency", "timing"} <= {c.cause for c in source_causes(location)}


def test_a_test_nobody_wrote_is_not_found(project: Path) -> None:
    assert locate_test(project, "tests.test_cart::test_missing") is None


@pytest.mark.parametrize(
    ("path", "commands", "stack"),
    [
        ("a/test_x.py", [], "pytest"),
        ("a/x.test.ts", ["vitest", "jest"], "vitest"),
        ("a/x.test.js", ["jest"], "jest"),
        ("A/XTests.cs", [], "dotnet"),
        ("src/test/java/XTest.java", [], "jvm"),
        ("x_test.go", [], "go"),
        ("tests/x.rs", [], "rust"),
        ("spec/x_spec.rb", [], "ruby"),
    ],
)
def test_the_stack_of_a_test(path: str, commands: list[str], stack: str) -> None:
    assert stack_of(path, commands) == stack


# --- history ---------------------------------------------------------------------------


def test_the_history_keeps_failing_tests_and_their_trend(tmp_path: Path) -> None:
    record(
        tmp_path,
        {"a": (5, 1), "green": (5, 0)},
        at="2026-11-01T10:00:00+00:00",
        os_name="linux",
        ci=False,
    )
    tests = record(
        tmp_path,
        {"a": (5, 3), "green": (5, 0)},
        at="2026-11-02T10:00:00+00:00",
        os_name="windows",
        ci=True,
    )

    assert set(tests) == {"a"}
    info = summary(tests["a"])
    assert info["firstSeen"] == "2026-11-01T10:00:00+00:00"
    assert (info["trend"], info["systems"], info["ciOnly"]) == (
        "worse",
        ["linux", "windows"],
        False,
    )
    assert load_history(tmp_path) == tests


def test_a_test_failing_only_in_ci_says_so(tmp_path: Path) -> None:
    record(
        tmp_path, {"a": (5, 0)}, at="1", os_name="linux", ci=False
    )  # unknown yet: not kept
    record(tmp_path, {"a": (5, 2)}, at="2", os_name="linux", ci=True)
    tests = record(tmp_path, {"a": (5, 0)}, at="3", os_name="linux", ci=False)

    assert summary(tests["a"])["ciOnly"] is True
    assert summary(tests["a"])["trend"] == "better"


def test_the_history_is_never_written_through_a_link(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    project = tmp_path / "p"
    project.mkdir()
    (project / ".workpilot").symlink_to(outside, target_is_directory=True)

    record(project, {"a": (5, 2)})

    assert list(outside.iterdir()) == []


def test_ci_is_read_from_the_usual_variables() -> None:
    assert in_ci({"GITHUB_ACTIONS": "true"}) and in_ci({"CI": "1"})
    assert not in_ci({"CI": "false"}) and not in_ci({})


# --- targeted runs -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("command", "names", "args"),
    [
        (
            "pytest",
            ["tests.test_a::test_x[1]", "tests.test_a::test_y"],
            ["-k", "test_x or test_y"],
        ),
        (
            "vitest",
            ["src/a.test.ts::Cart > adds (1) item"],
            ["-t", "adds \\(1\\) item"],
        ),
        ("jest", ["Cart adds"], ["-t", "Cart adds"]),
        (
            "dotnet",
            ["Shop.Tests.CartTests.Adds(qty: 2)"],
            ["--filter", "FullyQualifiedName~Shop.Tests.CartTests.Adds"],
        ),
        ("go", ["cart::TestCart/empty", "TestPay"], ["-run", "^(TestCart|TestPay)$"]),
        (
            "maven",
            ["com.shop.CartTest::adds"],
            ["-Dtest=CartTest#adds", "-Dsurefire.failIfNoSpecifiedTests=false"],
        ),
        ("gradle", ["com.shop.CartTest::adds"], ["--tests", "com.shop.CartTest.adds"]),
        ("node", ["test::adds (1)"], ["--test-name-pattern=adds \\(1\\)"]),
        ("cargo", ["src/lib.rs::cart::adds"], ["--", "cart::adds"]),
        ("phpunit", ["CartTest::testAdds"], ["--filter=testAdds"]),
        ("pest", ["CartTest::testAdds"], ["--filter=testAdds"]),
        ("rspec", ["spec/cart_spec.rb::Cart adds"], ["--example=Cart adds"]),
        ("dart", ["test/cart_test.dart::cart adds"], ["--name=cart adds"]),
        ("flutter", ["test/w_test.dart::shows"], ["--name=shows"]),
        ("swift", ["CartTests.CartTests::testAdds"], ["--filter=testAdds"]),
    ],
)
def test_each_stack_keeps_only_the_suspects(
    command: str, names: list[str], args: list[str]
) -> None:
    assert filter_args(command, names) == args


def test_a_name_never_becomes_an_option() -> None:
    assert filter_args("pytest", ["--rootdir=/ ; rm -rf /"]) == ["-k", "rootdirrmrf"]
    args = filter_args("dotnet", ["A.B|FullyQualifiedName!=x", "A.C"])
    assert args == [
        "--filter",
        "FullyQualifiedName~A.BFullyQualifiedNamex|FullyQualifiedName~A.C",
    ]
    assert filter_args("go", ["$(id)"]) == []
    assert filter_args("cargo", ["src/lib.rs::tests::b"]) == ["--", "tests::b"]
    assert filter_args("cargo", ["--nocapture", "src/lib.rs::-q"]) == []
    assert filter_args("rspec", ["--require evil"]) == ["--example=--require evil"]


# --- the report --------------------------------------------------------------------------


def _runs(name: str, outcomes: list[bool]) -> list[TestRun]:
    return [
        TestRun(test_name=name, passed=ok, run_id=str(i))
        for i, ok in enumerate(outcomes)
    ]


def test_outcomes_count_runs_and_failures() -> None:
    assert outcomes_of(_runs("a", [True, False, False])) == {"a": (3, 2)}


def test_the_report_says_where_why_and_since_when(project: Path) -> None:
    # A git hook exports GIT_* variables (index, author): the test's own repo ignores them.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(
        GIT_AUTHOR_NAME="Ana",
        GIT_AUTHOR_EMAIL="ana@example.com",
        GIT_COMMITTER_NAME="Ana",
        GIT_COMMITTER_EMAIL="ana@example.com",
    )
    for argv in (["init", "-q"], ["add", "."], ["commit", "-qm", "tests"]):
        subprocess.run(["git", *argv], cwd=project, check=True, env=env)
    entry = {
        "testName": "tests.test_cart::test_adds",
        "flakinessRate": 0.4,
        "probableCause": "unknown",
    }

    enrich_report(
        project,
        [entry],
        _runs("tests.test_cart::test_adds", [True, False, True, False, True]),
        [],
        keep_history=True,
    )

    assert entry["verdict"] == "flaky"
    assert (entry["file"], entry["line"], entry["stack"]) == (
        "tests/test_cart.py",
        8,
        "pytest",
    )
    assert entry["probableCause"] == "timing" and entry["suggestedFix"]
    assert entry["lastAuthor"] == "Ana"
    assert entry["history"]["trend"] == "new" and entry["history"]["observations"] == 1


def test_a_scan_reads_the_history_without_adding_to_it(project: Path) -> None:
    entry = {"testName": "x::y", "flakinessRate": 0.5, "probableCause": "unknown"}

    enrich_report(
        project, [entry], _runs("x::y", [True, False]), [], keep_history=False
    )

    assert load_history(project) == {}
    assert entry["file"] == "" and entry["sourceCauses"] == []


def test_the_runner_refuses_a_bad_list_of_suspects(tmp_path: Path) -> None:
    run = subprocess.run(
        [sys.executable, str(_BACKEND / "runners" / "flaky_tests_runner.py"), "--project-path", str(tmp_path),
         "--mode", "run", "--only", '{"a": 1}'],
        capture_output=True, text=True, timeout=60, check=False,
    )  # fmt: skip

    assert run.returncode == 1
    assert json.loads(run.stdout.split("FLAKY_ERROR:", 1)[1]).startswith("bad_only")


def test_a_server_run_takes_the_suspects_as_one_argument() -> None:
    from pydantic import ValidationError
    from shared_features.analyses import FlakyOptions, _flaky_args

    args = _flaky_args(
        FlakyOptions(mode="run", only=["tests.a::test_x", "--rootdir=/"])
    )

    assert args[-2:] == ["--only", json.dumps(["tests.a::test_x", "--rootdir=/"])]
    assert "--only" not in _flaky_args(FlakyOptions(only=["a"]))  # a scan runs nothing
    with pytest.raises(ValidationError):
        FlakyOptions(mode="run", only=["x"] * 51)
