"""A command output too long for one result goes to a file, not under the knife.

Every WorkPilot-run loop (OpenAI and the compatible providers, Ollama/LM Studio,
Copilot, Windsurf) runs commands through ToolExecutor, and every one of them
cut a long output to a head and a tail afterwards: the middle of a build log
could not be read at all. The output is now written under the spec directory,
masked for secrets, and the model reads its head, its tail and the offset of
the rest.
"""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

import pytest
from core.runtimes.tool_executor import SPILL_DIR, ToolExecutor

FAKE_KEY = "AKIAIOSFODNN7EXAMPLE"  # pragma: allowlist secret
LONG = "".join(
    f"line {n} {FAKE_KEY}\n" if n == 500 else f"line {n}\n" for n in range(1, 3001)
)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / ".workpilot" / "specs" / "001-task").mkdir(parents=True)
    return tmp_path


def _executor(project: Path, spec_dir: Path | None = None) -> ToolExecutor:
    executor = ToolExecutor(
        str(project),
        spec_dir=spec_dir or project / ".workpilot" / "specs" / "001-task",
        agent_type="coder",
    )
    executor.result_max_chars = 2_000
    return executor


def _spilled(project: Path) -> list[Path]:
    directory = project / ".workpilot" / "specs" / "001-task" / SPILL_DIR
    return sorted(directory.glob("*.txt")) if directory.is_dir() else []


def _read_on(executor: ToolExecutor, path: str, offset: int) -> str:
    return asyncio.run(
        executor.execute("read_file", {"path": path, "offset": offset, "limit": 1})
    )


def test_a_short_output_comes_back_whole_and_nothing_is_written(project):
    assert _executor(project)._fit_output("ok\n") == "ok\n"
    assert _spilled(project) == []


def test_a_long_output_is_written_whole_and_the_model_reads_an_excerpt(project):
    executor = _executor(project)
    excerpt = executor._fit_output(LONG)
    assert len(excerpt) <= 2_000
    [written] = _spilled(project)
    location = excerpt.split("all of it is in ")[1].split(":")[0]
    assert (project / location).resolve() == written.resolve()
    assert written.read_text(encoding="utf-8").splitlines()[999] == "line 1000"


def test_every_hidden_line_is_one_read_file_away(project):
    executor = _executor(project)
    excerpt = executor._fit_output(LONG)
    location = excerpt.split("all of it is in ")[1].split(":")[0]
    offset = int(excerpt.split("offset=")[1].split("]")[0])
    assert _read_on(executor, location, offset).startswith(f"line {offset}\n")


def test_the_file_is_masked_for_secrets(project):
    _executor(project)._fit_output(LONG)
    [written] = _spilled(project)
    text = written.read_text(encoding="utf-8")
    assert FAKE_KEY not in text
    assert "line 500 [REDACTED:" in text


def test_without_the_secret_table_nothing_is_written(project, monkeypatch):
    import docintel.redact as redact

    def unavailable(_text):
        raise redact.ScannerUnavailable("no table")

    monkeypatch.setattr(redact, "redact_text", unavailable)
    assert _executor(project)._fit_output(LONG) == LONG
    assert _spilled(project) == []


def test_without_a_spec_directory_the_output_is_returned_as_before(project):
    executor = ToolExecutor(str(project), agent_type="coder")
    executor.result_max_chars = 2_000
    assert executor._fit_output(LONG) == LONG


def test_a_spec_directory_outside_the_project_is_not_written_to(
    project, tmp_path_factory
):
    outside = tmp_path_factory.mktemp("elsewhere")
    assert _executor(project, spec_dir=outside)._fit_output(LONG) == LONG
    assert not (outside / SPILL_DIR).exists()


def test_a_spill_directory_linked_out_of_the_project_is_not_written_through(
    project, tmp_path_factory
):
    outside = tmp_path_factory.mktemp("elsewhere")
    link = project / ".workpilot" / "specs" / "001-task" / SPILL_DIR
    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks need privileges on this platform")
    assert _executor(project)._fit_output(LONG) == LONG
    assert list(outside.iterdir()) == []


def test_run_command_spills_a_long_output(project):
    executor = _executor(project)
    executor.result_max_chars = 600
    result = asyncio.run(executor.execute("run_command", {"command": "git --help"}))
    assert len(result) <= 600
    assert result.startswith("[output of ")
    assert len(_spilled(project)) == 1


def test_a_failing_command_spills_its_output_too(project):
    subprocess.run(["git", "init", "-q"], cwd=project, check=True)
    executor = _executor(project)
    executor.result_max_chars = 600
    with pytest.raises(RuntimeError) as failure:
        asyncio.run(
            executor.execute("run_command", {"command": "git status --bogus-flag"})
        )
    assert "Command failed with code" in str(failure.value)
    assert "[output of " in str(failure.value)
    assert len(_spilled(project)) == 1
