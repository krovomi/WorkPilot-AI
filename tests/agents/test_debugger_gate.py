"""A breakpoint pauses the providers whose tools WorkPilot runs itself.

Breakpoints only lived in the Claude SDK's PreToolUse hook: OpenAI, Copilot,
Windsurf, Gemini, Mistral, Ollama… run their tools through ``ToolExecutor``,
which never asked the debugger, so a breakpoint never stopped them.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from agents import debugger_gate, debugger_store
from core.runtimes.tool_executor import ToolExecutor


@pytest.fixture
def executor(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ToolExecutor:
    monkeypatch.setenv(
        "WORKPILOT_AGENT_DEBUGGER_STATE", str(tmp_path / "debugger" / "state.json")
    )
    monkeypatch.setattr(debugger_gate, "_hooks", {})
    project = tmp_path / "project"
    spec = project / ".workpilot" / "specs" / "001-login"
    spec.mkdir(parents=True)
    return ToolExecutor(str(project), spec_dir=spec, agent_type="coder")


async def _paused_frame() -> dict:
    for _ in range(100):
        frames = debugger_store.list_frames("001-login")
        if frames:
            return frames[0]
        await asyncio.sleep(0.05)
    raise AssertionError("the tool call never paused")


@pytest.mark.asyncio
async def test_a_command_waits_at_its_breakpoint_and_can_be_skipped(
    executor: ToolExecutor,
) -> None:
    debugger_store.add_breakpoint(
        "001-login", {"id": "no-rm", "tool": "Bash", "command_pattern": "rm "}
    )
    marker = executor.project_dir / "keep.txt"
    marker.write_text("x", encoding="utf-8")

    call = asyncio.create_task(executor.execute("run_command", {"cmd": "rm keep.txt"}))
    frame = await _paused_frame()
    assert frame["tool_name"] == "Bash"
    assert frame["tool_input"] == {"command": "rm keep.txt"}
    assert not call.done()

    debugger_store.resume("001-login", frame["frame_id"], {"action": "skip"})
    result = await asyncio.wait_for(call, timeout=10)

    assert "skipped by the person debugging this run" in result
    assert marker.exists()


@pytest.mark.asyncio
async def test_a_write_continues_once_resumed(executor: ToolExecutor) -> None:
    debugger_store.add_breakpoint(
        "001-login", {"id": "src", "tool": "Write", "path_pattern": "^src/"}
    )

    call = asyncio.create_task(
        executor.execute(
            "write_file", {"file_path": "src/a.ts", "content": "export {}"}
        )
    )
    frame = await _paused_frame()
    assert frame["tool_input"] == {"file_path": "src/a.ts", "content": "export {}"}

    debugger_store.resume("001-login", frame["frame_id"], {"action": "continue"})
    await asyncio.wait_for(call, timeout=10)

    assert (executor.project_dir / "src" / "a.ts").read_text(
        encoding="utf-8"
    ) == "export {}"


@pytest.mark.asyncio
async def test_a_modified_write_lands_where_the_person_said(
    executor: ToolExecutor,
) -> None:
    debugger_store.add_breakpoint("001-login", {"id": "any", "tool": "Write"})

    call = asyncio.create_task(
        executor.execute("write_file", {"path": "a.txt", "content": "old"})
    )
    frame = await _paused_frame()
    debugger_store.resume(
        "001-login",
        frame["frame_id"],
        {"action": "modify", "tool_input": {"file_path": "b.txt", "content": "new"}},
    )
    await asyncio.wait_for(call, timeout=10)

    assert not (executor.project_dir / "a.txt").exists()
    assert (executor.project_dir / "b.txt").read_text(encoding="utf-8") == "new"


@pytest.mark.asyncio
async def test_without_breakpoints_a_tool_runs_straight_away(
    executor: ToolExecutor,
) -> None:
    await asyncio.wait_for(
        executor.execute("write_file", {"path": "a.txt", "content": "x"}), timeout=5
    )

    assert (executor.project_dir / "a.txt").exists()
    assert debugger_store.list_sessions() == []
