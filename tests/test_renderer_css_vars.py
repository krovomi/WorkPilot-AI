"""Every CSS variable the desktop renderer reads must be defined by a theme.

Classes such as ``text-[var(--text-secondary)]`` compile to
``color: var(--text-secondary)``. When no stylesheet defines the variable the
declaration is invalid at computed-value time: the text falls back to the
inherited color, the background and the border disappear. 635 such classes in
24 views (API Explorer, Self-Healing, Browser Agent...) rendered that way until
F145 mapped them to the theme tokens (``text-muted-foreground``, ``bg-card``,
``border-border``...), along with 320 more written in the Tailwind v4
shorthand ``text-(--text-secondary)``. This test keeps new ones out.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RENDERER = ROOT / "apps" / "frontend" / "src" / "renderer"

#: ``var(--name`` in a class, a style object or a CSS string, and the
#: Tailwind v4 shorthand ``bg-(--name)``, which compiles to the same ``var()``.
VAR_USE = re.compile(r"(?:var\(\s*|-\()(--[A-Za-z0-9-]+)")
#: ``--name:`` in a stylesheet, or ``"--name":`` / ``setProperty("--name"`` in code.
VAR_DEF = re.compile(r"""(--[A-Za-z0-9-]+)["']?\s*[:,]""")

#: Set at runtime by libraries or by inline ``style={{"--x": ...}}`` props
#: (those are caught by VAR_DEF when written in the renderer).
RUNTIME_PREFIXES = ("--radix-", "--tw-")


def _sources(*suffixes: str) -> list[Path]:
    return [
        p
        for p in RENDERER.rglob("*")
        if p.suffix in suffixes and "node_modules" not in p.parts
    ]


def _defined() -> set[str]:
    names: set[str] = set()
    for path in _sources(".css", ".ts", ".tsx", ".html"):
        names.update(VAR_DEF.findall(path.read_text(encoding="utf-8")))
    return names


def test_renderer_reads_only_defined_css_variables() -> None:
    defined = _defined()
    missing: dict[str, list[str]] = {}
    for path in _sources(".ts", ".tsx"):
        if ".test." in path.name:
            continue
        text = path.read_text(encoding="utf-8")
        for match in VAR_USE.finditer(text):
            name = match.group(1)
            if name in defined or name.startswith(RUNTIME_PREFIXES):
                continue
            line = text.count("\n", 0, match.start()) + 1
            rel = path.relative_to(ROOT).as_posix()
            missing.setdefault(name, []).append(f"{rel}:{line}")
    assert not missing, (
        "CSS variables read by the renderer but defined by no theme "
        "(use a token such as text-muted-foreground, bg-card, border-border):\n"
        + "\n".join(
            f"  {name}: {', '.join(where[:3])}" for name, where in missing.items()
        )
    )
