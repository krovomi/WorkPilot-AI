"""Every view of the app has a row in ``product-overview.md``, and every row a view.

``docs/CLAUDE.md`` presents ``product-overview.md`` as the complete list of
features. On 17 October it covered 26 of the 78 views the sidebar can show.
The identifiers are read from the ``SidebarView`` type, which every view must
belong to for ``App.tsx`` to render it.

The last column marks the views the sidebar badges as experimental (lot M8):
the same set as ``EXPERIMENTAL_VIEWS``, and none of them with a design file.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SIDEBAR = REPO_ROOT / "apps/frontend/src/renderer/components/Sidebar.tsx"
OVERVIEW = REPO_ROOT / "docs/architecture/product-overview.md"
EXPERIMENTAL = (
    REPO_ROOT / "apps/frontend/src/renderer/components/sidebar/experimental-views.ts"
)


def _sidebar_views() -> set[str]:
    source = SIDEBAR.read_text(encoding="utf-8")
    start = source.index("export type SidebarView")
    end = source.index(";", start)
    return set(re.findall(r'\|\s*"([a-z0-9-]+)"', source[start:end]))


def _overview_rows() -> list[str]:
    text = OVERVIEW.read_text(encoding="utf-8")
    section = text[text.index("\n## Views\n") :]
    return re.findall(r"^\| `([a-z0-9-]+)` \|", section, flags=re.MULTILINE)


def _overview_table() -> dict[str, list[str]]:
    text = OVERVIEW.read_text(encoding="utf-8")
    section = text[text.index("\n## Views\n") :]
    table: dict[str, list[str]] = {}
    for line in section.splitlines():
        match = re.match(r"^\| `([a-z0-9-]+)` \|", line)
        if match:
            table[match.group(1)] = [c.strip() for c in line.strip("|").split("|")]
    return table


def _experimental_in_code() -> set[str]:
    source = EXPERIMENTAL.read_text(encoding="utf-8")
    start = source.index("EXPERIMENTAL_VIEWS")
    return set(re.findall(r'"([a-z0-9-]+)"', source[start:]))


def test_both_lists_are_read():
    assert len(_sidebar_views()) > 70
    assert len(_overview_rows()) > 70


def test_every_view_has_a_row():
    missing = sorted(_sidebar_views() - set(_overview_rows()))
    assert missing == [], f"add a row to product-overview.md for: {missing}"


def test_every_row_is_a_view():
    unknown = sorted(set(_overview_rows()) - _sidebar_views())
    assert unknown == [], f"no such view in SidebarView: {unknown}"


def test_each_view_has_one_row():
    rows = _overview_rows()
    assert sorted({r for r in rows if rows.count(r) > 1}) == []


def test_the_experimental_column_matches_the_code():
    marked = {view for view, cells in _overview_table().items() if cells[4] == "yes"}
    code = _experimental_in_code()
    assert len(code) > 0
    assert sorted(marked ^ code) == [], (
        "product-overview.md and EXPERIMENTAL_VIEWS disagree on: "
        f"{sorted(marked ^ code)}"
    )


def test_no_experimental_view_has_a_design_file():
    designed = sorted(
        view
        for view, cells in _overview_table().items()
        if cells[4] == "yes" and cells[3] != "—"
    )
    assert designed == [], (
        f"a design file makes these views not experimental: {designed}"
    )
