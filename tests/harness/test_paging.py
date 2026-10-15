"""harness.domain.paging: a page and the way to the next one, never a cut middle."""

from __future__ import annotations

import pytest
from harness.domain.paging import LinePage, page_items, page_lines, render_page

TEXT = "".join(f"line {n}\n" for n in range(1, 101))  # 100 lines, 8-9 chars each


def test_a_text_that_fits_comes_back_unchanged():
    page = page_lines("a\nb\n", max_chars=1_000)
    assert page.complete
    assert render_page(page) == "a\nb\n"


def test_a_long_text_returns_its_first_page_and_the_offset_that_reads_on():
    rendered = render_page(page_lines(TEXT, max_chars=100))
    body, note = rendered.rsplit("\n", 1)
    assert body.startswith("line 1\nline 2\n")
    assert len(body) <= 100
    assert note.startswith("[lines 1–")
    assert "of 100" in note and "offset=" in note


def test_reading_on_from_the_offset_loses_nothing():
    seen: list[str] = []
    offset = 1
    for _ in range(100):
        page = page_lines(TEXT, offset=offset, max_chars=64)
        seen.extend(page.text.splitlines())
        if page.last_line >= page.total_lines:
            break
        offset = page.last_line + 1
    assert seen == [f"line {n}" for n in range(1, 101)]


@pytest.mark.parametrize(
    ("offset", "limit", "first", "last"),
    [
        (1, 10, 1, 10),
        (95, None, 95, 100),
        (0, 3, 1, 3),  # an offset below 1 starts at the top
        (50, 1, 50, 50),
    ],
)
def test_offset_and_limit(offset, limit, first, last):
    page = page_lines(TEXT, offset=offset, limit=limit, max_chars=10_000)
    assert (page.first_line, page.last_line) == (first, last)


def test_an_offset_past_the_end_says_how_long_the_text_is():
    page = page_lines(TEXT, offset=500, max_chars=1_000)
    assert page == LinePage("", 0, 0, 100)
    assert "100 lines" in render_page(page)


def test_a_line_longer_than_the_page_is_cut_not_skipped():
    page = page_lines("x" * 500 + "\nnext\n", max_chars=100)
    assert page.clipped_line and page.text == "x" * 100
    assert "cut to fit" in render_page(page)


def test_page_items_stops_scanning_once_the_page_is_full():
    consumed: list[int] = []

    def items():
        for n in range(1_000):
            consumed.append(n)
            yield f"match {n}"

    page, next_offset = page_items(items(), max_items=5, max_chars=10_000)
    assert page == [f"match {n}" for n in range(5)]
    assert next_offset == 5
    assert len(consumed) == 6  # the sixth item proved there is more


@pytest.mark.parametrize(
    ("offset", "max_items", "max_chars", "expected", "next_offset"),
    [
        (0, 10, 10_000, ["a", "bb", "ccc"], None),
        (1, 10, 10_000, ["bb", "ccc"], None),
        (0, 2, 10_000, ["a", "bb"], 2),
        # The character budget ends the page too, after at least one item.
        (0, 10, 5, ["a", "bb"], 2),
        (0, 10, 1, ["a"], 1),
        (3, 10, 10_000, [], None),
    ],
)
def test_page_items(offset, max_items, max_chars, expected, next_offset):
    page = page_items(
        ["a", "bb", "ccc"], offset=offset, max_items=max_items, max_chars=max_chars
    )
    assert page == (expected, next_offset)
