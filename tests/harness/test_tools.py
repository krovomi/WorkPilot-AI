"""harness.domain.tools: one order, one serialization and one weight per tool set."""

from __future__ import annotations

import json

import pytest
from harness.domain.tools import (
    ToolSet,
    ToolSetChanged,
    canonical_tool,
    canonical_tools,
    hold,
    serialize,
)

READ = {
    "name": "read_file",
    "description": "Read a file.",
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Path"},
            "offset": {"type": "integer", "description": "First line"},
        },
        "required": ["path"],
    },
}
# The same tool, its keys in another order at every depth.
READ_SHUFFLED = {
    "parameters": {
        "required": ["path"],
        "properties": {
            "offset": {"description": "First line", "type": "integer"},
            "path": {"description": "Path", "type": "string"},
        },
        "type": "object",
    },
    "name": "read_file",
    "description": "Read a file.",
}
WRITE = {"name": "write_file", "description": "Write a file.", "parameters": {}}
BRAIN = {"name": "brain_recall", "description": "Recall.", "parameters": {}}


@pytest.mark.parametrize(
    "tools",
    [
        [READ, WRITE, BRAIN],
        [BRAIN, WRITE, READ],
        [WRITE, READ_SHUFFLED, BRAIN],
    ],
)
def test_one_set_in_any_order_serializes_one_way(tools):
    assert serialize(tools) == serialize([READ, WRITE, BRAIN])
    assert ToolSet.of(tools).names == ("brain_recall", "read_file", "write_file")


def test_every_object_has_its_keys_sorted_at_every_depth():
    tool = canonical_tool(READ_SHUFFLED)
    assert list(tool) == ["description", "name", "parameters"]
    assert list(tool["parameters"]) == ["properties", "required", "type"]
    assert list(tool["parameters"]["properties"]) == ["offset", "path"]
    assert list(tool["parameters"]["properties"]["path"]) == ["description", "type"]


def test_the_order_of_a_list_is_data_and_stays():
    tool = {
        "name": "pick",
        "parameters": {"properties": {"mode": {"enum": ["fast", "safe"]}}},
    }
    assert canonical_tool(tool)["parameters"]["properties"]["mode"]["enum"] == [
        "fast",
        "safe",
    ]
    reordered = {
        "name": "pick",
        "parameters": {"properties": {"mode": {"enum": ["safe", "fast"]}}},
    }
    assert ToolSet.of([tool]).fingerprint != ToolSet.of([reordered]).fingerprint


def test_an_absent_field_is_the_value_every_loop_sends():
    """The loops send ``td.get("description", "")`` and an empty object schema."""
    explicit = {
        "name": "t",
        "description": "",
        "parameters": {"type": "object", "properties": {}},
    }
    assert canonical_tool({"name": "t"}) == canonical_tool(explicit)
    assert ToolSet.of([{"name": "t"}]).fingerprint == ToolSet.of([explicit]).fingerprint


@pytest.mark.parametrize(
    "changed",
    [
        {**READ, "description": "Read a file, a page at a time."},
        {**READ, "parameters": {**READ["parameters"], "required": []}},
        {**READ, "name": "read"},
    ],
)
def test_any_change_in_a_definition_changes_the_fingerprint(changed):
    assert ToolSet.of([changed]).fingerprint != ToolSet.of([READ]).fingerprint


def test_two_definitions_under_one_name_keep_a_fixed_order():
    other = {**WRITE, "description": "Another writer."}
    first = canonical_tools([WRITE, other])
    second = canonical_tools([other, WRITE])
    assert first == second


def test_the_size_is_that_of_the_one_serialization():
    tool_set = ToolSet.of([READ, WRITE])
    assert tool_set.chars == len(serialize([READ, WRITE]))
    assert json.loads(serialize([READ, WRITE])) == list(tool_set.tools)


@pytest.mark.parametrize(
    ("chars", "ratio", "tokens"),
    [(0, 4, 0), (1, 4, 1), (4, 4, 1), (5, 4, 2), (4_001, 4, 1_001), (9, 3, 3)],
)
def test_the_weight_is_rounded_up(chars, ratio, tokens):
    assert ToolSet((), "x", chars).tokens(ratio) == tokens


def test_an_empty_set_weighs_its_brackets():
    assert ToolSet.of([]).names == ()
    assert ToolSet.of([]).chars == len("[]")


# --- hold: within a session, the fingerprint does not change ---


def test_a_session_without_tools_takes_the_offered_set():
    offered = ToolSet.of([READ])
    assert hold(None, offered) is offered


def test_the_same_tools_in_another_order_are_the_set_already_held():
    held = ToolSet.of([READ, WRITE])
    assert hold(held, ToolSet.of([WRITE, READ_SHUFFLED])) is held


@pytest.mark.parametrize(
    ("offered", "message"),
    [
        ([READ, WRITE, BRAIN], r"added \['brain_recall'\], removed none"),
        ([READ], r"added none, removed \['write_file'\]"),
        ([BRAIN, READ], r"added \['brain_recall'\], removed \['write_file'\]"),
        (
            [{**READ, "description": "Another description."}, WRITE],
            "same names, other schemas",
        ),
    ],
)
def test_another_set_is_refused(offered, message):
    with pytest.raises(ToolSetChanged, match=message):
        hold(ToolSet.of([READ, WRITE]), ToolSet.of(offered))
