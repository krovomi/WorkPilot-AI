"""The icon-name suffix pattern of the fixer stays linear (CodeQL ReDoS alert)."""

from __future__ import annotations

import time

from accessibility_agent.fixer import ICON_SUFFIX


def test_suffixes_and_digits_are_stripped():
    assert ICON_SUFFIX.sub("", "TrashIcon") == "Trash"
    assert ICON_SUFFIX.sub("", "ArrowLeft24Outline") == "ArrowLeft"
    assert ICON_SUFFIX.sub("", "Search") == "Search"


def test_a_long_run_of_digits_does_not_backtrack():
    name = "Close" + "0" * 5000 + "x"
    start = time.perf_counter()
    assert ICON_SUFFIX.sub("", name) == name
    assert time.perf_counter() - start < 2.0
