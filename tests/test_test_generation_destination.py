"""Where the test-generation runner writes the file it produced.

The generation itself is covered elsewhere; what these tests pin down is the
step after it — the one that put ``ProgramTests.cs`` at the top of a .NET
repository, beside the solution file, because the model's path had nowhere else
to be resolved against.
"""

import importlib.util
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "test_generation_runner.py"


def _load_runner():
    """Import the runner module by path — it is a script, not a package."""
    if str(BACKEND) not in sys.path:
        sys.path.insert(0, str(BACKEND))
    spec = importlib.util.spec_from_file_location("tg_runner_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@dataclass
class _Result:
    """The subset of ``TestGenerationResult`` the writer touches."""

    source_file: str
    test_file_content: str
    test_file_path: str


def _dotnet_project(root: Path, *, with_tests: bool) -> Path:
    (root / ".git").mkdir(parents=True)
    (root / "src").mkdir()
    (root / "src" / "App.csproj").write_text("<Project />", encoding="utf-8")
    source = root / "src" / "Program.cs"
    source.write_text("class Program {}", encoding="utf-8")
    if with_tests:
        (root / "tests").mkdir()
    return source


class TestWriteDestination:
    def test_tests_dir_beside_src_wins_over_the_model_path(self, tmp_path: Path):
        runner = _load_runner()
        source = _dotnet_project(tmp_path, with_tests=True)
        result = _Result(str(source), "// tests", "ProgramTests.cs")

        runner._write_test_file(result, str(tmp_path), str(source))

        assert Path(result.test_file_path) == tmp_path / "tests" / "ProgramTests.cs"
        assert (tmp_path / "tests" / "ProgramTests.cs").read_text() == "// tests"
        assert not (tmp_path / "ProgramTests.cs").exists()

    def test_the_chosen_directory_is_used_and_created(self, tmp_path: Path):
        runner = _load_runner()
        source = _dotnet_project(tmp_path, with_tests=False)
        chosen = tmp_path / "tests" / "App.UnitTests"
        result = _Result(str(source), "// tests", "ProgramTests.cs")

        runner._write_test_file(result, str(tmp_path), str(source), str(chosen))

        assert Path(result.test_file_path) == chosen / "ProgramTests.cs"
        assert (chosen / "ProgramTests.cs").is_file()

    def test_without_a_choice_it_never_falls_back_to_the_project_root(
        self, tmp_path: Path
    ):
        runner = _load_runner()
        source = _dotnet_project(tmp_path, with_tests=False)
        result = _Result(str(source), "// tests", "ProgramTests.cs")

        runner._write_test_file(result, str(tmp_path), str(source))

        assert Path(result.test_file_path) == tmp_path / "tests" / "ProgramTests.cs"
        assert not (tmp_path / "ProgramTests.cs").exists()

    def test_e2e_keeps_its_own_convention(self, tmp_path: Path):
        """E2E covers a scenario, not a source file — ``e2e/`` is the answer."""
        runner = _load_runner()
        _dotnet_project(tmp_path, with_tests=True)
        result = _Result("", "// spec", "e2e/test_checkout.py")

        runner._write_test_file(
            result, str(tmp_path), str(tmp_path / "src"), None, use_layout=False
        )

        assert Path(result.test_file_path) == tmp_path / "e2e" / "test_checkout.py"


class TestResolveDestinationAction:
    """The pre-flight the UI runs before it starts a generation."""

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

    def test_it_asks_when_no_test_directory_exists(self, tmp_path: Path):
        source = _dotnet_project(tmp_path, with_tests=False)

        payload = self._run(
            "--action",
            "resolve-destination",
            "--file-path",
            str(source),
            "--project-path",
            str(tmp_path),
        )

        destination = payload["destination"]
        assert payload["success"] is True
        assert destination["status"] == "needs_choice"
        assert destination["file_name"] == "ProgramTests.cs"
        assert destination["language"] == "csharp"
        assert destination["candidates"][0]["exists"] is False
        assert Path(destination["candidates"][0]["path"]) == tmp_path / "tests"

    def test_it_answers_without_asking_when_the_directory_is_there(
        self, tmp_path: Path
    ):
        source = _dotnet_project(tmp_path, with_tests=True)

        destination = self._run(
            "--action",
            "resolve-destination",
            "--file-path",
            str(source),
            "--project-path",
            str(tmp_path),
        )["destination"]

        assert destination["status"] == "resolved"
        assert destination["reason"] == "existing_tests_dir"
        assert Path(destination["directory"]) == tmp_path / "tests"

    def test_it_needs_no_provider(self, tmp_path: Path):
        """No API key, no network: the answer is path arithmetic."""
        source = _dotnet_project(tmp_path, with_tests=True)
        proc = subprocess.run(
            [
                sys.executable,
                str(RUNNER),
                "--action",
                "resolve-destination",
                "--file-path",
                str(source),
                "--project-path",
                str(tmp_path),
            ],
            capture_output=True,
            text=True,
            cwd=str(BACKEND),
            env={"PATH": "/usr/bin:/bin", "PYTHONPATH": str(BACKEND)},
        )
        assert proc.returncode == 0
        assert "__TG_ERROR__" not in proc.stdout
