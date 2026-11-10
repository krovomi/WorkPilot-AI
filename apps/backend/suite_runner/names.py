"""The parts of a test's name as its report gives it (#351).

``tests.test_x::test_y[1]`` (JUnit from pytest), ``Shop.Tests.CartTests.Adds(qty: 2)``
(TRX), ``src/cart.test.ts::Cart > adds`` (vitest), ``com.shop.CartTest::adds``
(Surefire), ``TestCart/empty`` (go): the container (module, class or file) and
the test itself, without its parameters.
"""

from __future__ import annotations

import re

__all__ = ["parse_test_name"]

_PARAMS = re.compile(r"\s*[\[(].*$")


def parse_test_name(name: str) -> tuple[str, str]:
    """``(container, leaf)``: the module, class or file, then the test itself.

    The leaf keeps its words for a titled test (``adds an item``) and loses its
    parameters (``test_x[1]``, ``Adds(qty: 2)``).
    """
    raw = name.strip()
    if "::" in raw:
        container, leaf = raw.split("::", 1)
    else:
        head = raw.split("(", 1)[0]
        if "." in head and " " not in head:
            container, _, leaf = head.rpartition(".")
        else:
            container, leaf = "", raw
    # vitest and jest name a test by its describe blocks: keep the test's own title.
    leaf = leaf.split(" > ")[-1].split(" › ")[-1].strip()
    if re.fullmatch(r"[\w$]+(?:[\[(].*)?", leaf):
        leaf = _PARAMS.sub("", leaf)
    return container.strip(), leaf
