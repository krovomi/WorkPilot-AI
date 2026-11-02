"""Status colours of every desktop theme stay readable as text.

`text-success`, `text-warning`, `text-info`, `text-destructive` and
`text-muted-foreground` print statuses, errors and hints on the page
background and on cards, in every theme, light and dark. Each has to reach
the WCAG AA ratio for normal text (4.5:1) against both, and a status used as
a fill has to carry its `-foreground` text at the same ratio. The default
light theme had a yellow warning at 1.4:1 on its background.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

GLOBALS = (
    Path(__file__).resolve().parents[1]
    / "apps"
    / "frontend"
    / "src"
    / "renderer"
    / "styles"
    / "globals.css"
)
TEXT_TOKENS = ("success", "warning", "info", "destructive", "muted-foreground")
FILL_TOKENS = ("success", "warning", "info", "destructive")
AA = 4.5


def _luminance(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    channels = [int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    r, g, b = (
        c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels
    )
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _ratio(a: str, b: str) -> float:
    hi, lo = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def _themes() -> dict[str, dict[str, str]]:
    css = GLOBALS.read_text(encoding="utf-8")
    themes = {}
    for selector, body in re.findall(r"(^[^\n{}]*)\{([^{}]*)\}", css, re.M):
        selector = selector.strip()
        if not selector.startswith((":root", ".dark", "[data-theme")):
            continue
        values = dict(re.findall(r"--([\w-]+):\s*(#[0-9A-Fa-f]{6})\s*;", body))
        if "background" in values and "card" in values:
            themes[selector] = values
    return themes


THEMES = _themes()


def test_every_theme_is_read():
    # :root, .dark and both modes of the six named themes.
    assert len(THEMES) == 14, sorted(THEMES)


@pytest.mark.parametrize("selector", sorted(THEMES))
def test_status_text_is_readable_on_the_page_and_on_cards(selector):
    theme = THEMES[selector]
    low = {
        token: round(
            min(_ratio(theme[token], theme[s]) for s in ("background", "card")), 2
        )
        for token in TEXT_TOKENS
    }
    assert {t: r for t, r in low.items() if r < AA} == {}


@pytest.mark.parametrize("selector", sorted(THEMES))
def test_a_status_fill_carries_its_text(selector):
    theme = THEMES[selector]
    low = {
        token: round(_ratio(theme[token], theme[f"{token}-foreground"]), 2)
        for token in FILL_TOKENS
    }
    assert {t: r for t, r in low.items() if r < AA} == {}
