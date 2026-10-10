"""Local command tools must not wait on interactive input or run indefinitely."""

import asyncio
import os
import shlex
import subprocess
import sys

import pytest
from core.runtimes.tool_executor import ToolExecutor


def command(script):
    args = [sys.executable, "-c", script]
    return subprocess.list2cmdline(args) if os.name == "nt" else shlex.join(args)


def python_project(path):
    """A Python project, so its command allowlist lets `python` run.

    The executor holds commands to the project's allowlist, as the SDK's
    `bash_security_hook` does; in an empty directory `python` is refused.
    """
    (path / "pyproject.toml").write_text("[project]\nname = 'x'\n", encoding="utf-8")
    return str(path)


@pytest.mark.asyncio
async def test_command_receives_eof_instead_of_inheriting_input(tmp_path):
    executor = ToolExecutor(python_project(tmp_path))
    output = await asyncio.wait_for(
        executor.execute(
            "run_command",
            {
                "command": command("import sys; print(repr(sys.stdin.read()))"),
            },
        ),
        5,
    )
    assert output.strip() == "''"


@pytest.mark.asyncio
async def test_command_timeout_terminates_shell_and_child(tmp_path):
    executor = ToolExecutor(python_project(tmp_path))
    executor.command_timeout = 0.2
    with pytest.raises(RuntimeError, match="exceeded"):
        await asyncio.wait_for(
            executor.execute(
                "run_command",
                {
                    "command": command("import time; time.sleep(60)"),
                },
            ),
            10,
        )


@pytest.mark.asyncio
async def test_read_file_handles_spaces_and_standalone_dashes(tmp_path):
    directory = tmp_path / "IA - LLM - RAG"
    directory.mkdir()
    target = directory / "complexity_assessment.json"
    target.write_text('{"complexity":"simple"}', encoding="utf-8")
    executor = ToolExecutor(str(tmp_path))
    assert (
        await executor.execute("read_file", {"path": str(target)})
        == '{"complexity":"simple"}'
    )


@pytest.mark.asyncio
async def test_cancelled_command_is_reaped(tmp_path):
    executor = ToolExecutor(python_project(tmp_path))
    task = asyncio.create_task(
        executor.execute(
            "run_command",
            {
                "command": command("import time; time.sleep(60)"),
            },
        )
    )
    await asyncio.sleep(0.2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 10)


@pytest.mark.skipif(os.name == "nt", reason="Regression for POSIX cat operands")
@pytest.mark.asyncio
async def test_unquoted_path_with_dash_cannot_wait_on_stdin(tmp_path):
    directory = tmp_path / "IA - LLM - RAG"
    directory.mkdir()
    target = directory / "context.json"
    target.write_text("{}", encoding="utf-8")
    executor = ToolExecutor(str(tmp_path))
    with pytest.raises(RuntimeError, match="Command failed"):
        await asyncio.wait_for(
            executor.execute("run_command", {"command": f"cat {target}"}), 5
        )
