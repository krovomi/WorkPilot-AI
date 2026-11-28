"""Readers of generated string literals, as each target language reads them."""

from __future__ import annotations

import re


def java_decode(source: str) -> str:
    """What javac reads from ``source``, a Java string literal (JLS 3.3, 3.10.5)."""
    # 3.3: a \\u escape is decoded first, when its backslash is preceded by an
    # even number of backslashes.
    out: list[str] = []
    i = 0
    while i < len(source):
        ch = source[i]
        if ch == "\\":
            run = 0
            j = i - 1
            while j >= 0 and source[j] == "\\":
                run += 1
                j -= 1
            match = re.match(r"\\u+([0-9a-fA-F]{4})", source[i:])
            if run % 2 == 0 and match:
                out.append(chr(int(match.group(1), 16)))
                i += match.end()
                continue
        out.append(ch)
        i += 1
    text = "".join(out)
    # A string literal: no raw quote, backslash escape or line break inside.
    assert text[0] == '"' and text[-1] == '"'
    body = text[1:-1]
    assert "\n" not in body and "\r" not in body
    escapes = {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f"}
    escapes.update({'"': '"', "\\": "\\", "'": "'"})
    decoded: list[str] = []
    i = 0
    while i < len(body):
        if body[i] == '"':
            raise AssertionError(f"raw quote at {i}: the literal ends early")
        if body[i] == "\\":
            decoded.append(escapes[body[i + 1]])
            i += 2
        else:
            decoded.append(body[i])
            i += 1
    units = "".join(decoded).encode("utf-16-be", "surrogatepass")
    return units.decode("utf-16-be", "surrogatepass")


def xpath_decode(expr: str) -> str:
    """The string an XPath 1.0 string expression (literal or ``concat``) yields."""
    if expr.startswith("concat("):
        parts = re.findall(r'"([^"]*)"|\'([^\']*)\'', expr[len("concat(") : -1])
        return "".join(a or b for a, b in parts)
    assert expr[0] == expr[-1] and expr[0] in "\"'"
    assert expr[0] not in expr[1:-1]
    return expr[1:-1]


def _body(source: str) -> str:
    assert source[0] == '"' and source[-1] == '"'
    body = source[1:-1]
    assert "\n" not in body and "\r" not in body
    return body


def cs_decode(source: str) -> str:
    """What the C# compiler reads from ``source``, a regular string literal."""
    escapes = {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "0": "\0"}
    escapes.update({'"': '"', "\\": "\\", "'": "'"})
    body = _body(source)
    units: list[str] = []
    i = 0
    while i < len(body):
        if body[i] == '"':
            raise AssertionError(f"raw quote at {i}: the literal ends early")
        if body[i] == "\\" and body[i + 1] == "u":
            units.append(chr(int(body[i + 2 : i + 6], 16)))
            i += 6
        elif body[i] == "\\":
            units.append(escapes[body[i + 1]])
            i += 2
        else:
            units.append(body[i])
            i += 1
    raw = "".join(units).encode("utf-16-be", "surrogatepass")
    return raw.decode("utf-16-be", "surrogatepass")


def ruby_decode(source: str) -> str:
    """What Ruby reads from ``source``, a double-quoted string literal."""
    escapes = {"n": "\n", "r": "\r", "t": "\t", '"': '"', "\\": "\\", "#": "#"}
    body = _body(source)
    out: list[str] = []
    i = 0
    while i < len(body):
        ch = body[i]
        if ch == '"':
            raise AssertionError(f"raw quote at {i}: the literal ends early")
        if ch == "#" and i + 1 < len(body) and body[i + 1] in "{@$":
            raise AssertionError(f"interpolation at {i}")
        if ch == "\\" and body[i + 1] == "u":
            end = body.index("}", i)
            out.append(chr(int(body[i + 3 : end], 16)))
            i = end + 1
        elif ch == "\\":
            out.append(escapes[body[i + 1]])
            i += 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)
