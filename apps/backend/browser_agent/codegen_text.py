"""
Page text as code: one string literal per target language, and the selector
syntaxes (CSS, XPath) that page text is quoted inside.

Everything a recording holds (URL, label, text, typed value, CSS) is page
content. It enters a generated test only through one of these functions, and
each returns a literal that its language reads back as exactly the input,
whatever the input holds: a quote, a backslash, a line break, ``${…}``,
``{enter}``, a non-ASCII character. No generator uses a template string, an
f-string, string interpolation or a text block, so ``${…}`` stays text.

- :func:`literal` (JavaScript, TypeScript): the JSON form of the string, every
  non-ASCII character escaped (U+2028 and U+2029 included).
- :func:`py_literal` (Python): double-quoted, ``\\x``/``\\u``/``\\U`` escapes, so a
  character outside the BMP stays one character (JSON's surrogate pairs would
  read back as two lone surrogates in Python).
- :func:`java_literal` (Java): ``\\"``, ``\\\\``, ``\\n``, ``\\r``, ``\\t``, ``\\b`` and
  ``\\f`` for the characters Java must not see raw, ``\\uXXXX`` (UTF-16) for any
  other character outside printable ASCII. Java decodes ``\\uXXXX`` before it
  reads the source (JLS 3.3), so that escape is never used for a quote, a
  backslash or a line break, which would end the literal.
- :func:`cs_literal` (C#): a regular (not verbatim, not interpolated) string,
  the same escapes as Java plus ``\\0``, and ``\\uXXXX`` for the rest; C#
  decodes ``\\u`` inside the literal only, so it never ends one.
- :func:`ruby_literal` (Ruby): double-quoted, with ``\\#`` before ``{``, ``@`` and ``$``,
  so that ``#{…}``, ``#@x`` and ``#$x`` stay text, and ``\\u{…}`` for any character outside
  printable ASCII.
"""

from __future__ import annotations

import json
import re

_PY_ESCAPES = {'"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t"}
_JAVA_ESCAPES = {**_PY_ESCAPES, "\b": "\\b", "\f": "\\f"}


def literal(text: str) -> str:
    """``text`` as a double-quoted JavaScript or TypeScript string literal."""
    return json.dumps(text, ensure_ascii=True)


def _printable(ch: str) -> bool:
    return " " <= ch <= "~"


def py_literal(text: str) -> str:
    """``text`` as a double-quoted Python string literal."""
    out: list[str] = []
    for ch in text:
        code = ord(ch)
        if ch in _PY_ESCAPES:
            out.append(_PY_ESCAPES[ch])
        elif _printable(ch):
            out.append(ch)
        elif code <= 0xFF:
            out.append(f"\\x{code:02x}")
        elif code <= 0xFFFF:
            out.append(f"\\u{code:04x}")
        else:
            out.append(f"\\U{code:08x}")
    return '"' + "".join(out) + '"'


def java_literal(text: str) -> str:
    """``text`` as a double-quoted Java string literal."""
    out: list[str] = []
    for ch in text:
        if ch in _JAVA_ESCAPES:
            out.append(_JAVA_ESCAPES[ch])
        elif _printable(ch):
            out.append(ch)
        else:
            units = ch.encode("utf-16-be", "surrogatepass")
            out.extend(
                f"\\u{int.from_bytes(units[i : i + 2], 'big'):04x}"
                for i in range(0, len(units), 2)
            )
    return '"' + "".join(out) + '"'


def cs_literal(text: str) -> str:
    """``text`` as a double-quoted C# string literal."""
    out: list[str] = []
    for ch in text:
        if ch in _JAVA_ESCAPES:
            out.append(_JAVA_ESCAPES[ch])
        elif ch == "\0":
            out.append("\\0")
        elif _printable(ch):
            out.append(ch)
        else:
            units = ch.encode("utf-16-be", "surrogatepass")
            out.extend(
                f"\\u{int.from_bytes(units[i : i + 2], 'big'):04x}"
                for i in range(0, len(units), 2)
            )
    return '"' + "".join(out) + '"'


def ruby_literal(text: str) -> str:
    """``text`` as a double-quoted Ruby string literal, never interpolated."""
    out: list[str] = []
    for i, ch in enumerate(text):
        if ch in _PY_ESCAPES:
            out.append(_PY_ESCAPES[ch])
        elif ch == "#" and text[i + 1 : i + 2] in ("{", "@", "$"):
            out.append("\\#")
        elif _printable(ch):
            out.append(ch)
        else:
            out.append(f"\\u{{{ord(ch):x}}}")
    return '"' + "".join(out) + '"'


def css_string(value: str) -> str:
    """``value`` inside a double-quoted CSS attribute value."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def xpath_string(value: str) -> str:
    """``value`` as an XPath 1.0 string expression (XPath has no escape)."""
    if '"' not in value:
        return f'"{value}"'
    if "'" not in value:
        return f"'{value}'"
    return "concat(" + ", '\"', ".join(f'"{part}"' for part in value.split('"')) + ")"


def slug(name: str, sep: str) -> str:
    """``name`` as lowercase ASCII words joined by ``sep``, for paths and identifiers."""
    words = re.findall(r"[a-z0-9]+", name.lower())
    return sep.join(words)[:60].strip(sep) or sep.join(["recorded", "flow"])


def pascal(name: str) -> str:
    """``name`` as a Java class name: ASCII words, capitalised, never a digit first."""
    word = "".join(part.capitalize() for part in slug(name, " ").split())
    return word if word[0].isalpha() else "Recorded" + word
