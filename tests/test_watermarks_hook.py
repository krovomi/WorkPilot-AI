"""The PreToolUse hook: what it rewrites, what it refuses to touch, and the ledger.

The assertion that matters most here is `old_string`. `Edit` locates its target
by matching that field against the file as it is on disk, so cleaning the needle
turns a working edit into "string not found" — and the cleaning is not even lost
by leaving it alone, because `new_string` is what lands.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from watermarks import LEDGER_NAME, read_entries  # noqa: E402
from watermarks.hook import CLEANED_TOOLS, make_watermarks_hook  # noqa: E402

ZWSP = "​"


def _updated(result: dict) -> dict | None:
    output = result.get("hookSpecificOutput")
    return output.get("updatedInput") if output else None


async def test_write_content_is_cleaned_before_it_reaches_disk(tmp_path):
    hook = make_watermarks_hook(tmp_path)
    result = await hook(
        {
            "tool_name": "Write",
            "tool_input": {"file_path": "src/a.ts", "content": f"const a ={ZWSP} 1;"},
        }
    )
    updated = _updated(result)
    assert updated is not None
    assert updated["content"] == "const a = 1;"
    assert updated["file_path"] == "src/a.ts"
    assert result["hookSpecificOutput"]["hookEventName"] == "PreToolUse"


async def test_edit_cleans_new_string_and_never_old_string(tmp_path):
    hook = make_watermarks_hook(tmp_path)
    dirty_needle = f"const a ={ZWSP} 1;"
    result = await hook(
        {
            "tool_name": "Edit",
            "tool_input": {
                "file_path": "src/a.ts",
                "old_string": dirty_needle,
                "new_string": f"const a ={ZWSP} 2;",
            },
        }
    )
    updated = _updated(result)
    assert updated is not None
    assert updated["new_string"] == "const a = 2;"
    assert updated["old_string"] == dirty_needle, (
        "cleaning the needle is how a working edit becomes 'string not found'"
    )


async def test_multiedit_cleans_every_replacement_and_keeps_the_rest(tmp_path):
    hook = make_watermarks_hook(tmp_path)
    result = await hook(
        {
            "tool_name": "MultiEdit",
            "tool_input": {
                "file_path": "src/a.ts",
                "edits": [
                    {"old_string": "a", "new_string": f"x{ZWSP}1"},
                    {"old_string": f"b{ZWSP}", "new_string": "clean"},
                    {"old_string": "c", "new_string": f"y{ZWSP}2"},
                ],
            },
        }
    )
    updated = _updated(result)
    assert updated is not None
    assert [e["new_string"] for e in updated["edits"]] == ["x1", "clean", "y2"]
    assert [e["old_string"] for e in updated["edits"]] == ["a", f"b{ZWSP}", "c"]


async def test_notebook_edit_cleans_the_cell_source(tmp_path):
    hook = make_watermarks_hook(tmp_path)
    result = await hook(
        {
            "tool_name": "NotebookEdit",
            "tool_input": {
                "notebook_path": "nb.ipynb",
                "new_source": f"print({ZWSP}1)",
            },
        }
    )
    updated = _updated(result)
    assert updated is not None
    assert updated["new_source"] == "print(1)"


async def test_clean_content_produces_no_opinion(tmp_path):
    hook = make_watermarks_hook(tmp_path)
    result = await hook(
        {
            "tool_name": "Write",
            "tool_input": {"file_path": "a.py", "content": "print('ok')\n"},
        }
    )
    assert result == {}


@pytest.mark.parametrize("tool_name", ["Bash", "Read", "Glob", "WebFetch", None])
async def test_other_tools_are_left_entirely_alone(tmp_path, tool_name):
    hook = make_watermarks_hook(tmp_path)
    result = await hook(
        {"tool_name": tool_name, "tool_input": {"content": f"a{ZWSP}b"}}
    )
    assert result == {}


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"tool_name": "Write"},
        {"tool_name": "Write", "tool_input": None},
        {"tool_name": "Write", "tool_input": "not a dict"},
        {"tool_name": "Write", "tool_input": {"content": None}},
        {"tool_name": "Edit", "tool_input": {"new_string": 42}},
        {"tool_name": "MultiEdit", "tool_input": {"edits": "not a list"}},
        {"tool_name": "MultiEdit", "tool_input": {"edits": [None, 7]}},
    ],
)
async def test_a_malformed_call_never_raises_and_never_votes(tmp_path, payload):
    """A hook that throws takes the tool call with it."""
    hook = make_watermarks_hook(tmp_path)
    assert await hook(payload) == {}


async def test_every_cleaned_tool_is_actually_handled(tmp_path):
    """`CLEANED_TOOLS` is what `core.client` registers; a name it lists and the
    hook ignores is a matcher that costs a call and does nothing."""
    hook = make_watermarks_hook(tmp_path)
    payloads = {
        "Write": {"file_path": "a", "content": f"a{ZWSP}b"},
        "Edit": {"file_path": "a", "old_string": "a", "new_string": f"a{ZWSP}b"},
        "MultiEdit": {
            "file_path": "a",
            "edits": [{"old_string": "a", "new_string": f"a{ZWSP}b"}],
        },
        "NotebookEdit": {"notebook_path": "a", "new_source": f"a{ZWSP}b"},
    }
    assert set(payloads) == set(CLEANED_TOOLS)
    for tool_name, tool_input in payloads.items():
        result = await hook({"tool_name": tool_name, "tool_input": tool_input})
        assert _updated(result) is not None, f"{tool_name} was not cleaned"


async def test_the_ledger_records_what_was_silently_removed(tmp_path):
    hook = make_watermarks_hook(tmp_path)
    await hook(
        {
            "tool_name": "Write",
            "tool_input": {"file_path": "src/a.ts", "content": f"a{ZWSP}b"},
        }
    )
    entries = read_entries(tmp_path)
    assert len(entries) == 1
    assert entries[0]["file"] == "src/a.ts"
    assert entries[0]["tool"] == "Write"
    assert entries[0]["removed_count"] == 1
    assert any("200B" in label for label in entries[0]["removed"])


async def test_nothing_is_written_when_nothing_changed(tmp_path):
    hook = make_watermarks_hook(tmp_path)
    await hook(
        {"tool_name": "Write", "tool_input": {"file_path": "a.py", "content": "ok"}}
    )
    assert not (tmp_path / LEDGER_NAME).exists()
    assert read_entries(tmp_path) == []


async def test_a_missing_spec_directory_costs_the_record_and_not_the_cleaning():
    hook = make_watermarks_hook(None)
    result = await hook(
        {
            "tool_name": "Write",
            "tool_input": {"file_path": "a.ts", "content": f"a{ZWSP}b"},
        }
    )
    assert _updated(result)["content"] == "ab"


def test_a_truncated_ledger_line_is_skipped_rather_than_raised_on(tmp_path):
    (tmp_path / LEDGER_NAME).write_text(
        json.dumps({"file": "a", "removed_count": 1})
        + "\n"
        + '{"file": "b", "removed_c\n'
        + json.dumps({"file": "c", "removed_count": 2})
        + "\n",
        encoding="utf-8",
    )
    entries = read_entries(tmp_path)
    assert [e["file"] for e in entries] == ["a", "c"]
