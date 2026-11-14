"""The test generation runner, run as the Test Generation Studio runs it.

The questions answered without a model (where the file goes, which
libraries, what to install) run as the app's child process. A generation runs
the real generator, layout and writer in process; only the provider's one-shot
completion is a stand-in, answering as a provider does.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "test_generation_runner.py"
RESULT = "__TEST_GENERATION_RESULT__:"
DETAIL = "__TG_ERROR__:"
PLAIN = "__TEST_GENERATION_ERROR__:"
EVENT = "__TG_EVENT__:"


def _process(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(RUNNER), *args],
        cwd=BACKEND,
        # As the app starts it (pythonRunnerEnv): UTF-8 whatever the code page.
        env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )


def _lines(out: str, prefix: str) -> list[str]:
    return [x[len(prefix) :] for x in out.splitlines() if x.startswith(prefix)]


def _result(out: str) -> dict:
    [line] = _lines(out, RESULT)
    return json.loads(line)


def _failure(out: str) -> dict:
    [detail] = _lines(out, DETAIL)
    [plain] = _lines(out, PLAIN)
    payload = json.loads(detail)
    # Every failure is said twice: structured, then the message alone.
    assert plain == payload["message"]
    return payload


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    (root / "src").mkdir(parents=True)
    (root / "tests").mkdir()
    (root / "pyproject.toml").write_text(
        '[project]\nname = "shop"\n[project.optional-dependencies]\ntest = ["pytest"]\n',
        encoding="utf-8",
    )
    (root / "src" / "cart.py").write_text(
        "def total(prices):\n    return sum(prices)\n", encoding="utf-8"
    )
    return root


# --- Answered without a model ---------------------------------------------------------


def test_where_the_test_file_goes_is_asked_before_generating(project: Path) -> None:
    done = _process(
        "--action",
        "resolve-destination",
        "--file-path",
        str(project / "src" / "cart.py"),
        "--project-path",
        str(project),
    )

    assert done.returncode == 0, done.stderr
    destination = _result(done.stdout)["destination"]
    assert destination["language"] == "python"
    assert destination["test_framework"] == "pytest"
    assert Path(destination["path"]).parent == project / "tests"


def test_a_project_alone_gets_its_own_language(project: Path) -> None:
    done = _process("--action", "resolve-destination", "--project-path", str(project))

    destination = _result(done.stdout)["destination"]
    assert destination["language"] == "python"
    assert "test_framework" not in destination


def test_the_libraries_follow_the_project_or_the_choice(project: Path) -> None:
    source = str(project / "src" / "cart.py")
    found = _process(
        "--action",
        "resolve-libraries",
        "--file-path",
        source,
        "--project-path",
        str(project),
    )
    chosen = _process(
        "--action",
        "resolve-libraries",
        "--project-path",
        str(project),
        "--language",
        "python",
        "--test-libraries",
        "pytest,hypothesis",
    )

    libraries = _result(found.stdout)["libraries"]
    assert libraries["language"] == "python"
    assert "pytest" in libraries["installed"]
    picked = _result(chosen.stdout)["libraries"]
    assert set(picked["selected"]) == {"pytest", "hypothesis"}


def test_adding_packages_reports_the_commands_it_will_not_run(project: Path) -> None:
    done = _process(
        "--action",
        "add-packages",
        "--project-path",
        str(project),
        "--language",
        "python",
        "--test-libraries",
        "pytest,pytest-mock",
    )

    assert done.returncode == 0, done.stderr
    install = _result(done.stdout)["install"]
    # PyPI packages are named as a command for the person, never installed.
    assert any("pytest-mock" in c for c in install["manual_commands"])
    assert "Adding 2 package(s) to the test project..." in done.stdout


@pytest.mark.parametrize(
    ("args", "message"),
    [
        (["--action", "resolve-destination"], "no test directory could be resolved"),
        (["--action", "resolve-libraries"], "no test libraries could be resolved"),
        (["--action", "add-packages"], "nothing to add the packages to"),
        (["--action", "analyze-coverage"], "No source file was selected"),
        (["--action", "generate-unit"], "No source file was selected"),
        (["--action", "generate-e2e", "--target-module", "cart"], "No user story"),
        (["--action", "generate-e2e", "--user-story", "Pay"], "No target module"),
        (["--action", "generate-tdd"], "No description was provided"),
    ],
)
def test_a_request_missing_its_input_is_refused(args: list[str], message: str) -> None:
    done = _process(*args)

    assert done.returncode == 1
    failure = _failure(done.stdout)
    assert message in failure["message"]
    assert failure["code"] == "invalid_input"


def test_adding_nothing_is_refused(project: Path) -> None:
    done = _process("--action", "add-packages", "--project-path", str(project))

    assert done.returncode == 1
    assert "No test libraries were selected" in _failure(done.stdout)["message"]


def test_a_windev_source_or_project_is_refused(tmp_path: Path) -> None:
    (tmp_path / "Shop.wdp").write_text("", encoding="utf-8")

    by_source = _process(
        "--action", "generate-unit", "--file-path", str(tmp_path / "Main.wdw")
    )
    by_project = _process(
        "--action", "resolve-libraries", "--project-path", str(tmp_path)
    )
    named = _process(
        "--action",
        "resolve-libraries",
        "--project-path",
        str(tmp_path),
        "--language",
        "python",
    )

    for done in (by_source, by_project):
        assert done.returncode == 1
        failure = _failure(done.stdout)
        assert failure["code"] == "unsupported_stack"
        assert "WinDev editor" in failure["message"]
    # A language the person names is theirs to ask for.
    assert named.returncode == 0, named.stdout


# --- A generation, in process ---------------------------------------------------------


@pytest.fixture
def runner(monkeypatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("test_generation_runner_t", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def model(monkeypatch):
    """The provider's one-shot completion; returns what it was asked."""
    import core.oneshot

    seen: dict = {"prompts": [], "answer": None, "failure": None}

    async def oneshot(prompt, *, on_delta=None, on_error=None, **_options):
        seen["prompts"].append(prompt)
        if seen["failure"]:
            on_error(seen["failure"])
            return ""
        answer = seen["answer"]
        text = answer if isinstance(answer, str) else json.dumps(answer)
        if on_delta is not None:
            half = len(text) // 2
            on_delta(text[:half])
            on_delta(text[half:])
        return text

    monkeypatch.setattr(core.oneshot, "oneshot_completion", oneshot)
    return seen


def _main(runner, monkeypatch, *args: str) -> int | None:
    monkeypatch.setattr(sys, "argv", ["test_generation_runner.py", *args])
    try:
        runner.main()
    except SystemExit as stop:
        return stop.code
    return None


UNIT = {
    "test_file_path": "test_cart.py",
    "test_file_content": "from cart import total\n\n\ndef test_total():\n    assert total([1, 2]) == 3\n",
    "tests_generated": 1,
    "functions_analyzed": 1,
    "generated_tests": [{"test_name": "test_total", "description": "sums"}],
}


def test_unit_tests_are_written_where_the_layout_says(
    runner, model, monkeypatch, project, capsys
) -> None:
    model["answer"] = UNIT

    code = _main(
        runner,
        monkeypatch,
        "--action",
        "generate-unit",
        "--file-path",
        str(project / "src" / "cart.py"),
        "--project-path",
        str(project),
        "--coverage-target",
        "90",
    )

    out = capsys.readouterr().out
    assert code is None, out
    written = project / "tests" / "test_cart.py"
    assert written.read_text(encoding="utf-8") == UNIT["test_file_content"]
    result = _result(out)["result"]
    assert result["test_file_path"] == str(written)
    assert result["generated_tests"][0]["test_name"] == "test_total"
    events = [json.loads(e) for e in _lines(out, EVENT)]
    assert any(e["type"] == "code" for e in events)
    assert events[-1] == {
        "type": "stage",
        "stage": "done",
        "status": "done",
        "path": str(written),
        "tests": 1,
    }
    assert "def total(prices)" in model["prompts"][0]


def test_coverage_gaps_come_back_highest_first(
    runner, model, monkeypatch, project, capsys
) -> None:
    model["answer"] = {
        "gaps": [
            {"name": "total", "priority": "low", "reason": "edge"},
            {"name": "total", "priority": "high", "reason": "empty list"},
        ]
    }

    code = _main(
        runner,
        monkeypatch,
        "--action",
        "analyze-coverage",
        "--file-path",
        str(project / "src" / "cart.py"),
        "--project-path",
        str(project),
    )

    out = capsys.readouterr().out
    assert code is None, out
    gaps = _result(out)["gaps"]
    assert [g["priority"] for g in gaps] == ["high", "low"]
    assert "Found 2 coverage gap(s)" in out


def test_an_e2e_suite_keeps_the_project_relative_path(
    runner, model, monkeypatch, project, capsys
) -> None:
    model["answer"] = {
        "test_file_path": "e2e/checkout.spec.py",
        "test_file_content": "def test_checkout():\n    pass\n",
        "tests_generated": 1,
    }

    code = _main(
        runner,
        monkeypatch,
        "--action",
        "generate-e2e",
        "--user-story",
        "As a buyer I pay my cart",
        "--target-module",
        "checkout",
        "--project-path",
        str(project),
    )

    out = capsys.readouterr().out
    assert code is None, out
    assert (project / "e2e" / "checkout.spec.py").is_file()
    assert "As a buyer I pay my cart" in model["prompts"][0]


def test_tdd_tests_go_to_the_chosen_folder(
    runner, model, monkeypatch, project, tmp_path, capsys
) -> None:
    model["answer"] = {**UNIT, "test_file_path": "test_discount.py"}
    chosen = tmp_path / "spec-tests"

    code = _main(
        runner,
        monkeypatch,
        "--action",
        "generate-tdd",
        "--description",
        "A discount never makes a total negative",
        "--project-path",
        str(project),
        "--test-dir",
        str(chosen),
    )

    out = capsys.readouterr().out
    assert code is None, out
    assert (chosen / "test_discount.py").is_file()
    assert "Generated 1 TDD test(s)" in out


def test_tests_that_cannot_be_written_say_they_were_generated(
    runner, model, monkeypatch, project, capsys
) -> None:
    model["answer"] = UNIT
    blocked = project / "blocked"
    blocked.write_text("a file, not a folder", encoding="utf-8")

    code = _main(
        runner,
        monkeypatch,
        "--action",
        "generate-unit",
        "--file-path",
        str(project / "src" / "cart.py"),
        "--project-path",
        str(project),
        "--test-dir",
        str(blocked),
    )

    out = capsys.readouterr().out
    assert code == 1
    failure = _failure(out)
    assert failure["code"] == "write_failed" and failure["stage"] == "write"
    assert failure["message"].startswith(
        "The tests were generated but could not be written"
    )
    assert {"type": "stage", "stage": "write", "status": "failed"} in [
        json.loads(e) for e in _lines(out, EVENT)
    ]


def test_a_provider_failure_is_forwarded_with_the_step_it_stopped(
    runner, model, monkeypatch, project, capsys
) -> None:
    model["failure"] = {
        "message": "The provider refused the key.",
        "code": "auth_failed",
        "provider": "openai",
        "model": "model-x",
    }

    code = _main(
        runner,
        monkeypatch,
        "--action",
        "generate-unit",
        "--file-path",
        str(project / "src" / "cart.py"),
        "--project-path",
        str(project),
    )

    assert code == 1
    failure = _failure(capsys.readouterr().out)
    assert failure["message"] == "The provider refused the key."
    assert failure["code"] == "auth_failed" and failure["stage"] == "generate"
    assert failure["provider"] == "openai"


def test_an_unexpected_crash_names_the_step_and_keeps_the_traceback(
    runner, model, monkeypatch, project, capsys
) -> None:
    from test_generation.generator import TestGeneratorAgent

    def crash(self, spec, **kwargs):
        kwargs["on_event"]({"type": "stage", "stage": "detect"})
        raise KeyError("snippet_type")

    monkeypatch.setattr(TestGeneratorAgent, "generate_tdd_tests", crash)

    code = _main(
        runner,
        monkeypatch,
        "--action",
        "generate-tdd",
        "--description",
        "anything",
        "--project-path",
        str(project),
    )

    assert code == 1
    failure = _failure(capsys.readouterr().out)
    assert failure["stage"] == "detect"
    assert "KeyError" in failure["details"]


def test_a_failed_install_is_reported_on_the_write_step(
    runner, monkeypatch, project, capsys
) -> None:
    import test_generation.package_install

    def broken(*_args):
        raise PermissionError("tests.csproj is read-only")

    monkeypatch.setattr(test_generation.package_install, "install_missing", broken)

    code = _main(
        runner,
        monkeypatch,
        "--action",
        "add-packages",
        "--project-path",
        str(project),
        "--test-libraries",
        "pytest-mock",
    )

    assert code == 1
    failure = _failure(capsys.readouterr().out)
    assert failure["stage"] == "write"
    assert failure["message"] == "tests.csproj is read-only"


def test_an_install_names_each_step_it_ran(
    runner, monkeypatch, project, capsys
) -> None:
    import test_generation.package_install

    report = SimpleNamespace(
        steps=[
            SimpleNamespace(ok=True, command=["dotnet", "add", "package", "Moq"]),
            SimpleNamespace(ok=False, command=["npm", "install", "-D", "vitest"]),
        ],
        to_dict=lambda: {"ok": False},
    )
    monkeypatch.setattr(
        test_generation.package_install, "install_missing", lambda *_a: report
    )

    _main(
        runner,
        monkeypatch,
        "--action",
        "add-packages",
        "--project-path",
        str(project),
        "--test-libraries",
        "pytest-mock",
    )

    out = capsys.readouterr().out
    assert "ok: dotnet add package Moq" in out
    assert "failed: npm install -D vitest" in out


def test_a_backend_that_cannot_load_says_so(
    runner, monkeypatch, project, capsys
) -> None:
    monkeypatch.setitem(sys.modules, "test_generation.generator", None)

    code = _main(
        runner,
        monkeypatch,
        "--action",
        "analyze-coverage",
        "--file-path",
        str(project / "src" / "cart.py"),
    )

    assert code == 1
    failure = _failure(capsys.readouterr().out)
    assert failure["code"] == "provider_unavailable"
    assert failure["message"].startswith(
        "The test-generation backend could not be loaded"
    )


# --- The writer and the reporting, on their own ---------------------------------------


def test_nothing_is_written_without_content(runner, tmp_path: Path) -> None:
    result = SimpleNamespace(test_file_content="", test_file_path="test_x.py")

    runner._write_test_file(result, str(tmp_path))

    assert list(tmp_path.iterdir()) == []


def test_without_a_known_test_folder_the_first_candidate_is_used_and_said(
    runner, tmp_path: Path, capsys
) -> None:
    (tmp_path / "cart.py").write_text("x = 1\n", encoding="utf-8")
    result = SimpleNamespace(test_file_content="t\n", test_file_path="test_cart.py")

    runner._write_test_file(result, str(tmp_path), str(tmp_path / "cart.py"))

    assert "No test directory found in this project" in capsys.readouterr().out
    assert Path(result.test_file_path).read_text(encoding="utf-8") == "t\n"


@pytest.mark.parametrize("anchor", ["source", "nothing"])
def test_a_model_path_without_a_project_is_anchored_to_what_there_is(
    runner, tmp_path: Path, monkeypatch, anchor: str
) -> None:
    monkeypatch.chdir(tmp_path)
    source = tmp_path / "app" / "flow.py"
    result = SimpleNamespace(test_file_content="t\n", test_file_path="e2e/flow.spec.py")

    runner._write_test_file(
        result, None, str(source) if anchor == "source" else None, use_layout=False
    )

    base = source.parent if anchor == "source" else tmp_path
    assert Path(result.test_file_path) == (base / "e2e" / "flow.spec.py").resolve()
    assert Path(result.test_file_path).is_file()


def test_reporting_never_aborts_on_a_value_it_cannot_encode(runner, capsys) -> None:
    runner._emit_event({"type": "code", "delta": object()})
    runner._print_error_detail({"message": "plain still arrives", "extra": object()})

    out = capsys.readouterr().out
    assert _lines(out, EVENT) == [] and _lines(out, DETAIL) == []
    assert _lines(out, PLAIN) == ["plain still arrives"]


def test_a_language_named_by_the_caller_wins(runner, tmp_path: Path) -> None:
    args = SimpleNamespace(language="go", project_path=str(tmp_path))
    unknown = SimpleNamespace(language=None, project_path=str(tmp_path))

    assert runner._resolve_language(args, "cart.py") == "go"
    assert runner._resolve_language(unknown, "notes.txt") == "python"


def test_a_source_that_cannot_be_read_stops_on_the_read_step(
    runner, model, monkeypatch, project, capsys
) -> None:
    code = _main(
        runner,
        monkeypatch,
        "--action",
        "analyze-coverage",
        "--file-path",
        str(project / "src" / "gone.py"),
        "--project-path",
        str(project),
    )

    assert code == 1
    failure = _failure(capsys.readouterr().out)
    assert failure["code"] == "file_not_found" and failure["stage"] == "read"
    assert model["prompts"] == []


def test_a_failure_without_a_step_is_put_on_the_one_in_flight(
    runner, monkeypatch, project, capsys
) -> None:
    import agent_runtime

    monkeypatch.setattr(agent_runtime, "current", lambda: None)

    code = _main(
        runner,
        monkeypatch,
        "--action",
        "generate-e2e",
        "--user-story",
        "As a buyer I pay",
        "--target-module",
        "checkout",
        "--project-path",
        str(project),
    )

    assert code == 1
    failure = _failure(capsys.readouterr().out)
    assert failure["message"].startswith("No agent runtime is installed")
    assert failure["stage"] == "generate"
