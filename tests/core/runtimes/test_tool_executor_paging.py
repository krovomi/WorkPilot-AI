"""The executor's read and search tools page their output instead of losing its middle.

Every WorkPilot-run loop (OpenAI and the compatible providers, Ollama/LM Studio,
Copilot, Windsurf) reads files and searches through ToolExecutor, and every one
of them cut a long result to a head and a tail afterwards: the middle of a long
file could not be read at all.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from core.runtimes.tool_executor import ToolExecutor, get_tool_definitions


def _run(executor: ToolExecutor, tool: str, args: dict) -> str:
    return asyncio.run(executor.execute(tool, args))


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "big.py").write_text(
        "".join(f"value_{n} = {n}\n" for n in range(1, 3001)), encoding="utf-8"
    )
    (tmp_path / "small.py").write_text("x = 1\ny = 2\n", encoding="utf-8")
    return tmp_path


def test_a_small_file_reads_as_before(project):
    assert _run(ToolExecutor(str(project)), "read_file", {"path": "small.py"}) == (
        "x = 1\ny = 2\n"
    )


def test_a_large_file_reads_page_by_page_and_every_line_is_reachable(project):
    executor = ToolExecutor(str(project))
    executor.result_max_chars = 2_000
    seen: list[str] = []
    offset = 1
    for _ in range(1_000):
        result = _run(executor, "read_file", {"path": "big.py", "offset": offset})
        assert len(result) <= 2_000
        body, note = result.rsplit("\n", 1)
        seen.extend(body.splitlines())
        if "offset=" not in note:
            break
        offset = int(note.split("offset=")[1].rstrip("]"))
    assert seen == [f"value_{n} = {n}" for n in range(1, 3001)]


def test_offset_and_limit_accept_strings(project):
    result = _run(
        ToolExecutor(str(project)),
        "read_file",
        {"path": "big.py", "offset": "100", "limit": "2"},
    )
    assert result.startswith("value_100 = 100\nvalue_101 = 101\n")
    assert "[lines 100–101 of 3000. To read on, call again with offset=102]" in result


def test_search_pages_its_matches(project):
    executor = ToolExecutor(str(project))
    executor.result_max_chars = 1_000
    first = _run(executor, "search_files", {"pattern": r"value_\d+"})
    assert len(first) <= 1_000
    assert "call search_files again with offset=" in first
    next_offset = first.rsplit("offset=", 1)[1].split(",")[0]
    second = _run(
        executor, "search_files", {"pattern": r"value_\d+", "offset": next_offset}
    )
    first_matches = [line for line in first.splitlines() if line.startswith("big.py")]
    second_matches = [line for line in second.splitlines() if line.startswith("big.py")]
    assert first_matches and second_matches
    assert not set(first_matches) & set(second_matches)


def test_find_files_pages_too(project):
    for n in range(300):
        (project / f"mod_{n:03}.py").write_text("", encoding="utf-8")
    result = _run(ToolExecutor(str(project)), "find_files", {"pattern": "mod_*.py"})
    assert "call find_files again with offset=200" in result
    rest = _run(
        ToolExecutor(str(project)), "find_files", {"pattern": "mod_*.py", "offset": 200}
    )
    assert len([line for line in rest.splitlines() if line.endswith(".py")]) == 100


def test_the_offered_schemas_say_how_to_page():
    tools = {tool["name"]: tool for tool in get_tool_definitions("coder")}
    assert {"offset", "limit"} <= set(tools["read_file"]["parameters"]["properties"])
    assert "offset" in tools["search_files"]["parameters"]["properties"]
    assert "offset" in tools["find_files"]["parameters"]["properties"]


def test_a_page_still_stays_inside_the_project(project):
    with pytest.raises(ValueError, match="outside the project"):
        _run(
            ToolExecutor(str(project)),
            "read_file",
            {"path": "../outside.py", "offset": 2},
        )
