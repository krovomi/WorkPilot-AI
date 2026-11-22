"""Page text becomes a string literal of each target language, and stays one.

A recorded value can hold anything: quotes, a backslash, a line break,
``${…}``, characters outside the BMP. Each literal must read back, in its own
language, as exactly that value; nothing in it may end the string early.
"""

from __future__ import annotations

import ast
import json

import pytest
from browser_agent.codegen import FORMATS, export_recording
from browser_agent.codegen_text import (
    css_string,
    java_literal,
    literal,
    pascal,
    py_literal,
    slug,
    xpath_string,
)
from browser_agent.recording import RecordedStep, Recording, Selector

from tests.browser_agent.literal_decoders import java_decode, xpath_decode

HOSTILE = (
    'a"b\'c\\d\ne\rf\tg ${process.env.HOME} `tick` \\u0022 \\" '
    "\x01\x7f\b\f é ✓ \U0001f600   \ud800 end"
)


def test_javascript_and_typescript_literal_reads_back_exactly() -> None:
    encoded = literal(HOSTILE)
    assert json.loads(encoded) == HOSTILE
    # One line of ASCII, never a template string: `${…}` stays text.
    assert encoded.isascii() and "\n" not in encoded and " " not in encoded
    assert encoded.startswith('"') and "`" not in encoded.replace("`tick`", "")


def test_python_literal_reads_back_exactly() -> None:
    encoded = py_literal(HOSTILE)
    assert ast.literal_eval(encoded) == HOSTILE
    assert encoded.isascii() and "\n" not in encoded
    # One character outside the BMP stays one character (no surrogate pair).
    assert ast.literal_eval(py_literal("\U0001f600")) == "\U0001f600"
    assert py_literal("Log in") == '"Log in"'


def test_java_literal_reads_back_exactly() -> None:
    encoded = java_literal(HOSTILE)
    assert java_decode(encoded) == HOSTILE
    assert encoded.isascii() and "\n" not in encoded
    assert java_literal("\U0001f600") == '"\\ud83d\\ude00"'
    assert java_literal("Log in") == '"Log in"'


@pytest.mark.parametrize(
    "value", ["plain", 'say "hi"', "it's", "both \" and ' here", '""', ""]
)
def test_xpath_strings_hold_any_quote(value: str) -> None:
    assert xpath_decode(xpath_string(value)) == value


def test_css_strings_slugs_and_class_names() -> None:
    assert css_string('a"b\\c') == 'a\\"b\\\\c'
    assert slug("Log in!", "-") == "log-in" and slug("é", "_") == "recorded_flow"
    assert pascal("log in") == "LogIn" and pascal("3 steps") == "Recorded3Steps"
    assert pascal("class") == "Class"


def _typed(value: str) -> Recording:
    return Recording(
        steps=[RecordedStep("s1", "fill", [Selector("label", "Note")], value=value)]
    )


@pytest.mark.parametrize("fmt", FORMATS)
def test_a_typed_value_reads_back_exactly_from_the_test_data(fmt: str) -> None:
    """The data file is JSON literals, in every language: the code never holds the value."""
    test = export_recording(_typed(HOSTILE), fmt)
    assert "${process" not in test.code and "`tick`" not in test.code
    assert test.data_code is not None and test.data_code.isascii()
    assert json.loads(test.data_code) == {"note": HOSTILE}
