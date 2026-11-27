"""What each executor tool does with what a model sends, on a real project.

Every provider that is not the Claude SDK (OpenAI and the compatible APIs,
Ollama, LM Studio, Copilot, Windsurf) reads, writes, searches and runs commands
through `ToolExecutor`. Each test builds a project in a temporary folder and
calls `execute` the way such a client does; commands are real processes. The OS
sandbox, which this machine may not have, is a stand-in with its two calls.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import pytest
from core.runtimes import tool_executor
from core.runtimes.tool_executor import SPILL_DIR, ToolExecutor


def run(executor: ToolExecutor, tool: str, arguments: dict):
    return asyncio.run(executor.execute(tool, arguments))


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    (root / "src").mkdir(parents=True)
    (root / "src" / "cart.py").write_text("def total():\n    return 0\n", "utf-8")
    (root / "README.md").write_text("# Shop\n", encoding="utf-8")
    return root


@pytest.fixture
def executor(project: Path) -> ToolExecutor:
    return ToolExecutor(str(project))


def symlink(link: Path, target: Path) -> None:
    try:
        link.symlink_to(target, target_is_directory=target.is_dir())
    except OSError:
        pytest.skip("symlinks need privileges on this platform")


class TestWhereItWorks:
    def test_a_working_directory_inside_the_project(self, project):
        executor = ToolExecutor(str(project), working_directory="src")

        assert run(executor, "list_files", {}) == ["cart.py"]

    def test_a_working_directory_that_does_not_exist_is_refused(self, project):
        with pytest.raises(ValueError, match="does not exist"):
            ToolExecutor(str(project), working_directory="nowhere")

    def test_a_working_directory_outside_the_project_is_refused(self, project):
        with pytest.raises(ValueError, match="outside the project"):
            ToolExecutor(str(project), working_directory="..")

    def test_an_unknown_tool_is_an_error(self, executor):
        with pytest.raises(ValueError, match="Unknown tool: rm_rf"):
            run(executor, "rm_rf", {})


class TestReading:
    def test_a_path_is_required(self, executor):
        with pytest.raises(ValueError, match="Path is required"):
            run(executor, "read_file", {})

    def test_a_missing_file(self, executor):
        with pytest.raises(FileNotFoundError, match="nope.py"):
            run(executor, "read_file", {"path": "nope.py"})

    def test_a_file_that_is_not_text(self, project, executor):
        (project / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n\xff\xfe\xfd")

        with pytest.raises(RuntimeError, match="Error reading file logo.png"):
            run(executor, "read_file", {"path": "logo.png"})

    def test_a_folder_given_as_a_file(self, executor):
        with pytest.raises(RuntimeError, match="Error reading file src"):
            run(executor, "read_file", {"path": "src"})

    @pytest.mark.parametrize("offset", ["2", 2.0, True, "two", [2]])
    def test_a_line_number_sent_as_text_or_float_is_read(self, executor, offset):
        page = run(executor, "read_file", {"path": "src/cart.py", "offset": offset})

        # A readable number starts at line 2; anything else starts at line 1
        starts_at_two = offset in ("2", 2.0)
        assert ("def total" in page) is not starts_at_two
        assert "return 0" in page


class TestWriting:
    def test_a_path_is_required(self, executor):
        with pytest.raises(ValueError, match="Path is required for write_file"):
            run(executor, "write_file", {"content": "x"})

    def test_parents_are_created_and_the_content_written(self, project, executor):
        assert run(
            executor, "write_file", {"path": "src/api/routes.py", "content": "ok\n"}
        ) == ("Successfully wrote to src/api/routes.py")

        assert (project / "src/api/routes.py").read_text("utf-8") == "ok\n"

    @pytest.mark.parametrize(
        "arguments",
        [
            {"path": "src/cart.py"},
            {"path": "src/cart.py", "content": "x", "empty": "1"},
        ],
    )
    def test_no_content_or_an_empty_file_writes_an_empty_file(
        self, project, executor, arguments
    ):
        run(executor, "write_file", arguments)

        assert (project / "src" / "cart.py").read_text("utf-8") == ""

    def test_a_file_that_cannot_be_written(self, project, executor):
        (project / "build.log").mkdir()

        with pytest.raises(RuntimeError, match="Error writing file build.log"):
            run(executor, "write_file", {"path": "build.log", "content": "x"})

    def test_a_write_outside_the_project_is_refused(self, project, executor):
        with pytest.raises(ValueError, match="outside the project"):
            run(executor, "write_file", {"path": "../evil.py", "content": "x"})

        assert not (project.parent / "evil.py").exists()

    def test_an_empty_plan_is_refused_and_the_old_one_kept(self, project, executor):
        plan = project / "implementation_plan.json"
        plan.write_text(json.dumps({"phases": []}), encoding="utf-8")

        with pytest.raises(ValueError, match="cannot be written empty"):
            run(
                executor,
                "write_file",
                {"path": "implementation_plan.json", "empty_file": True},
            )

        assert json.loads(plan.read_text("utf-8")) == {"phases": []}


class TestDirectories:
    def test_a_listing_names_folders_with_a_slash(self, project, executor):
        (project / "docs").mkdir()

        assert run(executor, "list_files", {}) == ["README.md", "docs/", "src/"]

    def test_a_missing_folder(self, executor):
        with pytest.raises(FileNotFoundError, match="Directory not found: lib"):
            run(executor, "list_files", {"directory": "lib"})

    def test_a_file_given_as_a_folder(self, executor):
        with pytest.raises(RuntimeError, match="Error listing files in README.md"):
            run(executor, "list_files", {"directory": "README.md"})

    def test_a_folder_is_created_with_its_parents(self, project, executor):
        assert run(executor, "create_directory", {"path": "src/a/b"}) == (
            "Successfully created directory src/a/b"
        )
        assert (project / "src" / "a" / "b").is_dir()

    def test_a_folder_needs_a_path(self, executor):
        with pytest.raises(ValueError, match="Path is required for create_directory"):
            run(executor, "create_directory", {})

    def test_a_folder_where_a_file_is(self, executor):
        with pytest.raises(RuntimeError, match="Error creating directory README.md"):
            run(executor, "create_directory", {"path": "README.md"})


class TestSearching:
    def test_a_search_needs_a_valid_pattern(self, executor):
        with pytest.raises(ValueError, match="pattern is required"):
            run(executor, "search_files", {})
        with pytest.raises(ValueError, match="Invalid regular expression"):
            run(executor, "search_files", {"pattern": "def ("})

    def test_a_search_in_a_file_rather_than_a_folder(self, executor):
        with pytest.raises(FileNotFoundError, match="Directory not found"):
            run(executor, "search_files", {"pattern": "x", "directory": "README.md"})

    def test_big_binary_and_linked_files_are_not_searched(
        self, project, executor, monkeypatch, tmp_path
    ):
        monkeypatch.setattr(tool_executor, "_SEARCH_MAX_FILE_BYTES", 100)
        (project / "big.py").write_text("def total():\n" + "#" * 200, "utf-8")
        (project / "blob.bin").write_bytes(b"def total\0")
        outside = tmp_path / "secret.py"
        outside.write_text("def total(): pass\n", encoding="utf-8")
        symlink(project / "linked.py", outside)

        found = run(executor, "search_files", {"pattern": "def total"})

        assert found == "src/cart.py:1: def total():"

    def test_a_file_that_vanishes_mid_search_is_passed_over(
        self, project, executor, monkeypatch
    ):
        real_stat = Path.stat

        def stat(path, *args, **kwargs):
            # Gone between the walk and the read (a lstat still sees it)
            if path.name == "README.md" and kwargs.get("follow_symlinks", True):
                raise FileNotFoundError(path)
            return real_stat(path, *args, **kwargs)

        monkeypatch.setattr(Path, "stat", stat)

        assert run(executor, "search_files", {"pattern": "."}).startswith("src/cart.py")

    def test_find_files_needs_a_pattern(self, executor):
        with pytest.raises(ValueError, match="pattern is required for find_files"):
            run(executor, "find_files", {})

    def test_find_files_says_how_to_read_on(self, project, executor, monkeypatch):
        monkeypatch.setattr(tool_executor, "_SEARCH_MAX_RESULTS", 1)
        (project / "src" / "order.py").write_text("", encoding="utf-8")

        found = run(executor, "find_files", {"pattern": "*.py"}).splitlines()

        assert found[0] == "src/cart.py"
        assert "call find_files again with offset=1" in found[1]
        assert run(executor, "find_files", {"pattern": "*.py", "offset": 1}) == (
            "src/order.py"
        )
        assert run(executor, "find_files", {"pattern": "*.py", "offset": 5}) == (
            "(no more files)"
        )


class TestCommands:
    def test_a_failure_shows_what_it_printed_on_both_streams(self, project, executor):
        with pytest.raises(RuntimeError) as failure:
            run(
                executor,
                "run_command",
                {"command": "echo checking && git rev-parse --verify no-such-ref"},
            )

        message = str(failure.value)
        assert "Command failed with code 128" in message
        assert "checking" in message
        assert "fatal" in message  # git's own stderr

    def test_exit_one_without_output_reads_as_no_matches(self, project, executor):
        (project / "a.txt").write_text("a\n", encoding="utf-8")
        (project / "b.txt").write_text("b\n", encoding="utf-8")

        assert run(
            executor,
            "run_command",
            {"command": "git diff --no-index --quiet a.txt b.txt"},
        ) == ("(no matches found)")

    def test_a_cwd_outside_the_project_is_refused(self, executor):
        with pytest.raises(ValueError, match="outside the project"):
            run(executor, "run_command", {"command": "echo hi", "cwd": ".."})


class StandInSandbox:
    """An isolated session: launches through `wrap`, reports refused hosts."""

    isolated = True

    def __init__(self, refused: list[str]):
        self.refused = refused
        self.wrapped: list[list[str]] = []

    def wrap(self, argv, env, *, cwd):
        self.wrapped.append(list(argv))
        # The wrapper runs the shell line it was given, as bubblewrap would
        script = (
            "import subprocess, sys; "
            "sys.exit(subprocess.run(sys.argv[1], shell=True).returncode)"
        )
        return [sys.executable, "-c", script, argv[-1]], env

    def refused_hosts(self, since):
        return self.refused


class TestTheSandbox:
    def test_a_command_runs_through_the_sandbox_and_hears_what_was_refused(
        self, executor
    ):
        sandbox = StandInSandbox(["registry.example:443"])
        executor._sandbox = sandbox

        out = run(executor, "run_command", {"command": "echo sandboxed"})

        assert sandbox.wrapped == [["/bin/sh", "-c", "echo sandboxed"]]
        assert "sandboxed" in out
        assert "network refused: registry.example:443" in out

    def test_a_failed_command_hears_it_in_its_error(self, executor):
        executor._sandbox = StandInSandbox(["pypi.example:443"])

        with pytest.raises(RuntimeError) as failure:
            run(executor, "run_command", {"command": "git rev-parse --verify nope"})

        assert "network refused: pypi.example:443" in str(failure.value)

    def test_a_refused_host_is_kept_for_the_approval_tier(self, executor, tmp_path):
        from os_sandbox.evidence import read_evidence

        spec = tmp_path / "spec-k1"
        spec.mkdir()
        executor.spec_dir = spec
        executor._sandbox = StandInSandbox(["registry.example:443"])

        run(executor, "run_command", {"command": "echo sandboxed"})

        assert read_evidence(spec)[1] == ["registry.example:443"]

    def test_nothing_refused_adds_nothing(self, executor):
        executor._sandbox = StandInSandbox([])

        assert "network refused" not in run(
            executor, "run_command", {"command": "echo fine"}
        )


class TestStoppingACommand:
    @staticmethod
    async def sleeper():
        return await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            "import time; time.sleep(60)",
            start_new_session=True,
        )

    def test_a_command_that_already_ended_is_simply_reaped(self, executor):
        async def scenario():
            process = await asyncio.create_subprocess_exec(sys.executable, "-c", "")
            await process.wait()
            await executor._stop_command(process)
            return process.returncode

        assert asyncio.run(scenario()) == 0

    def test_windows_kills_the_whole_tree_with_taskkill(
        self, executor, monkeypatch, tmp_path
    ):
        """`taskkill /PID <pid> /T /F`; here a stand-in that does what it does."""
        monkeypatch.setattr(tool_executor, "is_windows", lambda: True)
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        asked = tmp_path / "taskkill.args"
        fake = bin_dir / "taskkill"
        fake.write_text(
            f"#!{sys.executable}\n"
            "import os, signal, sys\n"
            f"open({str(asked)!r}, 'w', encoding='utf-8').write(' '.join(sys.argv[1:]))\n"
            "os.kill(int(sys.argv[2]), signal.SIGKILL)\n",
            encoding="utf-8",
        )
        fake.chmod(0o755)
        monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")

        async def scenario():
            process = await self.sleeper()
            await asyncio.wait_for(executor._stop_command(process), timeout=20)
            return process

        process = asyncio.run(scenario())

        assert process.returncode is not None
        if asked.exists():  # the stand-in ran (the real taskkill on Windows)
            assert asked.read_text("utf-8") == f"/PID {process.pid} /T /F"

    def test_a_running_command_is_killed(self, executor):
        """The platform's own way: its process group, or taskkill on Windows."""

        async def scenario():
            process = await self.sleeper()
            await asyncio.wait_for(executor._stop_command(process), timeout=20)
            return process.returncode

        assert asyncio.run(scenario()) not in (None, 0)


class TestSpilling:
    LONG = "".join(f"line {n}\n" for n in range(1, 2001))

    @pytest.fixture
    def spilling(self, project):
        spec = project / ".workpilot" / "specs" / "001-shop"
        spec.mkdir(parents=True)
        executor = ToolExecutor(str(project), spec_dir=spec)
        executor.result_max_chars = 1_000
        return executor, spec / SPILL_DIR

    def test_a_spill_folder_that_cannot_be_made_returns_the_output(self, spilling):
        executor, spill = spilling
        spill.write_text("a file where the folder goes", encoding="utf-8")

        assert executor._fit_output(self.LONG) == self.LONG

    def test_a_spill_file_linked_out_of_the_project_is_not_written_through(
        self, spilling, tmp_path
    ):
        executor, spill = spilling
        executor._fit_output(self.LONG)
        (written,) = spill.glob("*.txt")
        outside = tmp_path / "elsewhere.txt"
        outside.write_text("", encoding="utf-8")
        written.unlink()
        symlink(written, outside)

        assert executor._fit_output(self.LONG) == self.LONG
        assert outside.read_text("utf-8") == ""


class TestInProcessTools:
    def test_a_ui_tool_answers_through_the_executor(self, executor):
        assert run(executor, "uiux_search", {}) == "Error: missing argument 'query'"

    def test_a_verify_tool_answers_through_the_executor(self, executor):
        answer = json.loads(run(executor, "verify_detect", {}))

        assert answer["applicable"] is False
        assert answer["targets"] == []


def test_the_shell_line_runs_in_its_own_session_off_windows(executor, monkeypatch):
    seen = {}
    real = asyncio.create_subprocess_shell

    async def shell(command, **kwargs):
        seen.update(kwargs)
        return await real(command, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_shell", shell)
    monkeypatch.setattr(tool_executor, "is_windows", lambda: False)

    run(executor, "run_command", {"command": "echo hi"})

    assert seen["start_new_session"] is True
