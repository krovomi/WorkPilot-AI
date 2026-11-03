"""Text sizes in the desktop renderer follow the UI scale setting.

The UI scale setting scales the whole interface from 75 % to 200 % by changing
the root font size, so every size written in ``rem`` follows it. Sizes written
in pixels do not: 690 classes such as ``text-[10px]`` and ``text-[11px]`` in
169 files (badges, counters, timestamps, the project tabs) stayed at the same
size whatever the setting, so the smallest text stayed tiny for someone who
had asked for 150 %. F150 moved them to the ``text-3xs`` (0.625rem) and
``text-2xs`` (0.6875rem) steps defined in ``styles/globals.css``; this test
keeps new pixel sizes out.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RENDERER = ROOT / "apps" / "frontend" / "src" / "renderer"
GLOBALS = RENDERER / "styles" / "globals.css"

PX_TEXT = re.compile(r"(?<![\w-])(?:[a-z0-9\-\[\].]+:)*text-\[\d+(?:\.\d+)?px\]")


def test_text_sizes_are_not_written_in_pixels() -> None:
    offenders = []
    for path in RENDERER.rglob("*"):
        if path.suffix not in (".ts", ".tsx") or "node_modules" in path.parts:
            continue
        text = path.read_text(encoding="utf-8")
        for match in PX_TEXT.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            rel = path.relative_to(ROOT).as_posix()
            offenders.append(f"{rel}:{line}: {match.group(0)}")
    assert not offenders, (
        "Use text-3xs, text-2xs, text-xs... (rem, follows the UI scale) "
        "instead of a pixel size:\n" + "\n".join(offenders[:50])
    )


def test_small_type_steps_are_defined_in_rem() -> None:
    css = GLOBALS.read_text(encoding="utf-8")
    assert re.search(r"--text-3xs:\s*0\.625rem;", css)
    assert re.search(r"--text-2xs:\s*0\.6875rem;", css)
