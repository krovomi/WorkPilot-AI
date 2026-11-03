"""Success, warning and error colours come from the theme, not from the palette.

Views wrote them straight from the Tailwind palette: ``text-red-400``,
``bg-green-500/10``, ``text-amber-600 dark:text-amber-400``... about 1,800
classes in 230 files. Those shades ignore the selected theme, so the same
warning was yellow on one screen and olive on the next, and many fell under
the AA contrast the theme tokens were tuned for (F149). They now read the
``destructive``, ``success`` and ``warning`` tokens, which every theme defines
with its own contrast-checked value; this test keeps new ones out.

Gradients and shadows (``from-``, ``to-``, ``via-``, ``shadow-``) stay free:
they decorate, they do not carry a status.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RENDERER = ROOT / "apps" / "frontend" / "src" / "renderer"

RAW_STATUS = re.compile(
    r"(?<![\w/-])(?:[a-z0-9\-\[\].]+:)*"
    r"(?:text|bg|border(?:-[lrtbxy])?|ring|fill|stroke|accent|caret|decoration"
    r"|placeholder|divide|outline)-(?:red|green|emerald|amber|yellow)-\d{2,3}\b"
)


def test_status_colours_use_theme_tokens() -> None:
    offenders = []
    for path in RENDERER.rglob("*"):
        if path.suffix not in (".ts", ".tsx") or "node_modules" in path.parts:
            continue
        if ".test." in path.name:
            # Tests may assert a provider's brand colour, which stays raw.
            continue
        text = path.read_text(encoding="utf-8")
        for match in RAW_STATUS.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            rel = path.relative_to(ROOT).as_posix()
            offenders.append(f"{rel}:{line}: {match.group(0)}")
    assert not offenders, (
        "Use text-destructive / text-success / text-warning (and bg-, border-) "
        "instead of palette shades:\n" + "\n".join(offenders[:50])
    )
