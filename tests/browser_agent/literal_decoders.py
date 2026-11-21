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
