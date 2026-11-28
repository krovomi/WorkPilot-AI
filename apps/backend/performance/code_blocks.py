"""The blocks of source the profiler looks into: a loop's body, a function's body.

The profiler's rules ("a query inside a loop", "a blocking read inside an async
function") only hold when the second pattern sits *inside* the first one's
block. Matching both with one regex across the file reports a ``.get(`` fifty
lines after a loop has ended. These helpers cut the block out first:

- Python blocks end at the first non-blank line indented no deeper than the
  header;
- brace languages (JS/TS, C#, Java, Kotlin, Go, Rust, C/C++, Swift, PHP, Dart,
  Scala) end at the brace that closes the header's opening brace.

They are heuristics over text, not parsers: strings or comments holding braces
can shift a block, which is acceptable for hints a person reviews.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass

PYTHON_FOR = re.compile(r"^([ \t]*)(?:async[ \t]+)?for[ \t]+[^\n]+?[ \t]in[ \t][^\n]*:")
PYTHON_DEF = re.compile(
    r"^([ \t]*)(?:async[ \t]+)?def[ \t]+(\w+)[ \t]*\(", re.MULTILINE
)
PYTHON_ASYNC_DEF = re.compile(r"^([ \t]*)async[ \t]+def[ \t]+\w+[ \t]*\(", re.MULTILINE)

# for (...) {, foreach (...) {, Go's `for i := range xs {`, Rust's `for x in xs {`.
BRACE_LOOP = re.compile(r"\b(?:for|foreach)\b[ \t]*(?:\([^)]*\)|[^;{}\n]*)[ \t]*\{")
# async function f(...) {, async (...) => {, C#'s `async Task<int> F(...) {`.
BRACE_ASYNC = re.compile(r"\basync\b[^;{}\n]*\)[^;{}\n]*\{")


@dataclass(frozen=True)
class Block:
    """A header and its body, with 1-based line numbers."""

    start: int
    end: int
    header: str
    body: str


def _line_of(content: str, offset: int) -> int:
    return content.count("\n", 0, offset) + 1


def python_block(content: str, match: re.Match[str], header_from: int = -1) -> Block:
    """The body of the Python statement whose header ``match`` found.

    ``match`` must start at the header's line, with group 1 its indentation.
    The header ends at the end of the line holding ``header_from`` (default:
    the end of the match), so a signature spread over several lines stays in
    the header.
    """
    indent = len(match.group(1).expandtabs())
    header_end = content.find("\n", max(match.end(), header_from))
    header_end = len(content) if header_end == -1 else header_end
    header = content[match.start() : header_end]
    code = header.split("#", 1)[0]
    inline = code.rsplit(":", 1)[1] if ":" in code else ""
    body_lines = [inline] if inline.strip() else []
    line_number = _line_of(content, header_end)
    last = line_number
    position = header_end + 1
    while position < len(content):
        next_break = content.find("\n", position)
        next_break = len(content) if next_break == -1 else next_break
        line = content[position:next_break].expandtabs()
        line_number += 1
        if line.strip():
            if len(line) - len(line.lstrip()) <= indent:
                break
            last = line_number
        body_lines.append(line)
        position = next_break + 1
    return Block(
        start=_line_of(content, match.start()),
        end=last,
        header=header.strip(),
        body="\n".join(body_lines),
    )


def _closing_paren(content: str, open_paren: int) -> int:
    """The offset of the ``)`` matching the ``(`` at ``open_paren``."""
    depth = 0
    for position in range(open_paren, len(content)):
        if content[position] == "(":
            depth += 1
        elif content[position] == ")":
            depth -= 1
            if depth == 0:
                return position
    return len(content)


def python_loops(content: str) -> Iterator[Block]:
    """Every ``for`` statement of a Python file, outer loops first."""
    for match in re.finditer(PYTHON_FOR.pattern, content, re.MULTILINE):
        yield python_block(content, match)


def python_functions(content: str) -> Iterator[tuple[str, Block]]:
    """Every ``def`` of a Python file, with the function's name."""
    for match in PYTHON_DEF.finditer(content):
        signature_end = _closing_paren(content, match.end() - 1)
        yield match.group(2), python_block(content, match, signature_end)


def python_async_functions(content: str) -> Iterator[Block]:
    """Every ``async def`` of a Python file."""
    for match in PYTHON_ASYNC_DEF.finditer(content):
        yield python_block(content, match, _closing_paren(content, match.end() - 1))


def decorators_above(content: str, line: int) -> list[str]:
    """The decorator lines directly above 1-based ``line``."""
    lines = content.splitlines()
    found: list[str] = []
    index = line - 2
    while index >= 0 and lines[index].strip().startswith("@"):
        found.append(lines[index].strip())
        index -= 1
    return found


def brace_block(content: str, open_brace: int) -> tuple[str, int]:
    """The text between the ``{`` at ``open_brace`` and its matching ``}``.

    Returns the body and the offset just past the closing brace (the end of
    the content when it never closes).
    """
    depth = 0
    for position in range(open_brace, len(content)):
        char = content[position]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return content[open_brace + 1 : position], position + 1
    return content[open_brace + 1 :], len(content)


def _brace_blocks(content: str, header: re.Pattern[str]) -> Iterator[Block]:
    for match in header.finditer(content):
        body, end = brace_block(content, match.end() - 1)
        yield Block(
            start=_line_of(content, match.start()),
            end=_line_of(content, end - 1),
            header=match.group(0).strip(),
            body=body,
        )


def brace_loops(content: str) -> Iterator[Block]:
    """Every ``for`` / ``foreach`` loop with a braced body."""
    return _brace_blocks(content, BRACE_LOOP)


def brace_async_functions(content: str) -> Iterator[Block]:
    """Every ``async`` function or method with a braced body."""
    return _brace_blocks(content, BRACE_ASYNC)


def outermost(blocks: Iterator[Block]) -> Iterator[Block]:
    """Drop the blocks that sit inside a block already yielded."""
    covered_until = 0
    for block in sorted(blocks, key=lambda b: b.start):
        if block.start <= covered_until:
            continue
        covered_until = block.end
        yield block
