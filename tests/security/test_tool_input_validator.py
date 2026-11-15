"""`get_safe_tool_input`: a tool call's input, or an empty dict, never None."""

from types import SimpleNamespace

from security.tool_input_validator import get_safe_tool_input


def test_a_dict_input_is_returned_as_is():
    data = {"command": "ls"}
    assert get_safe_tool_input(SimpleNamespace(input=data)) is data


def test_anything_else_becomes_the_default():
    assert get_safe_tool_input(object()) == {}
    assert get_safe_tool_input(SimpleNamespace(input=None)) == {}
    assert get_safe_tool_input(SimpleNamespace(input="ls")) == {}
    fallback = {"x": 1}
    assert get_safe_tool_input(SimpleNamespace(input=None), fallback) is fallback
