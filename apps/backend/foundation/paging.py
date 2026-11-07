"""Truncation at source: a tool returns a page and says how to read the next.

Cutting a long result after the fact (``truncate_tool_result`` keeps a head
and a tail) loses the middle for good: the model knows something is missing
and has no way to ask for it. A tool that pages its own output never loses
anything; it returns what fits, the position, and the argument that reads on.

Pure, table-tested in ``tests/harness/test_paging.py``.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

# Room kept under the character cap for the line that says how to read on.
FOOTER_RESERVE = 200


@dataclass(frozen=True)
class LinePage:
    """A run of lines from a text, and where it sits in it."""

    text: str
    first_line: int  # 1-based; 0 when the page is empty
    last_line: int  # 0 when the page is empty
    total_lines: int
    clipped_line: bool = False  # a single line longer than the page was cut

    @property
    def complete(self) -> bool:
        """The page is the whole text."""
        return (
            self.first_line in (0, 1)
            and self.last_line == self.total_lines
            and not self.clipped_line
        )


def page_lines(
    text: str, *, offset: int = 1, limit: int | None = None, max_chars: int
) -> LinePage:
    """Lines ``offset``… of ``text``, at most ``limit`` of them and ``max_chars`` long.

    The page always holds at least one line when there is one to give: a line
    longer than the page is cut rather than skipped, and says so.
    """
    lines = text.splitlines(keepends=True)
    total = len(lines)
    start = max(1, offset)
    if start > total:
        return LinePage("", 0, 0, total)
    budget = max(1, max_chars)
    taken: list[str] = []
    used = 0
    clipped = False
    for line in lines[start - 1 :]:
        if limit is not None and len(taken) >= max(1, limit):
            break
        if used + len(line) > budget:
            if not taken:
                taken.append(line[:budget])
                clipped = True
            break
        taken.append(line)
        used += len(line)
    return LinePage("".join(taken), start, start + len(taken) - 1, total, clipped)


def render_page(page: LinePage, *, what: str = "lines") -> str:
    """The page as the model reads it: the text, then where it is and how to go on.

    A complete page is returned as is, exactly as the whole text was before
    paging existed.
    """
    if page.complete:
        return page.text
    if page.first_line == 0:
        return f"[no {what} from that offset: the text has {page.total_lines} {what}]"
    note = f"[{what} {page.first_line}–{page.last_line} of {page.total_lines}"
    if page.clipped_line:
        note += f"; line {page.last_line} was cut to fit"
    if page.last_line < page.total_lines:
        note += f". To read on, call again with offset={page.last_line + 1}"
    note += "]"
    body = page.text if page.text.endswith("\n") else page.text + "\n"
    return body + note


def page_items(
    items: Iterable[str], *, offset: int = 0, max_items: int, max_chars: int
) -> tuple[list[str], int | None]:
    """Up to ``max_items`` items after the first ``offset``, within ``max_chars``.

    Returns the page and the offset of the next page, or None when the items
    ran out. Items are consumed lazily, so a search stops scanning once its
    page is full.
    """
    page: list[str] = []
    used = 0
    position = 0
    skip = max(0, offset)
    for item in items:
        if position < skip:
            position += 1
            continue
        cost = len(item) + 1
        if len(page) >= max(1, max_items) or (page and used + cost > max_chars):
            return page, position
        page.append(item)
        used += cost
        position += 1
    return page, None


def spill_excerpt(text: str, *, max_chars: int, location: str) -> str:
    """What the model reads of an output written whole to ``location``.

    A command's output cannot be paged by asking for it again: running the
    command twice may not give the same output, and may cost minutes. So the
    whole output goes to a file, and the result says so first — where the file
    is, how long it is — then shows its head and its tail in whole lines, with
    the exact ``offset`` at which the part not shown begins. A build puts its
    first error near the start and its verdict at the end; the middle is one
    ``read_file`` away instead of lost.

    The note comes first so that a client that cuts the result afterwards,
    keeping its head, keeps the way to the rest.
    """
    lines = text.splitlines(keepends=True)
    total = len(lines)
    note = (
        f"[output of {len(text)} characters, {total} lines; all of it is in "
        f"{location}: read the part not shown with read_file and offset]\n"
    )
    gap_reserve = len(location) + 120
    budget = max(0, max_chars - len(note) - gap_reserve)
    head: list[str] = []
    used = 0
    for line in lines:
        if used + len(line) > budget // 2:
            break
        head.append(line)
        used += len(line)
    tail: list[str] = []
    for line in reversed(lines[len(head) :]):
        if used + len(line) > budget:
            break
        tail.append(line)
        used += len(line)
    tail.reverse()
    first_hidden = len(head) + 1
    last_hidden = total - len(tail)
    if last_hidden < first_hidden:
        return note + text
    head_text = "".join(head)
    if head_text and not head_text.endswith("\n"):
        head_text += "\n"
    gap = (
        f"... [lines {first_hidden}–{last_hidden} not shown: "
        f"read_file {location} with offset={first_hidden}] ...\n"
    )
    return note + head_text + gap + "".join(tail)
