"""The UI charter and the node-graph screens wear the active colour theme.

The first charter (2026-11-07) gave every module its own warm orange accent
and fixed status tones, and remapped ``--color-primary`` to that orange inside
every stage: on Ocean, Forest or Neo the sidebar was blue, green or magenta
and the module next to it orange. Import Design, the test studio and the
Visual-to-Code canvas also painted their own stone surfaces whatever the
theme (F172). The accent now is ``--primary``, the status tones the theme's
semantic tokens, the surfaces ``--background`` / ``--card`` / ``--foreground``.
These checks keep a hex value from coming back in those places. Category
hues no theme defines (violet, orange, pink, the test modes, the import
steps, syntax colours) stay free.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMPONENTS = ROOT / "apps" / "frontend" / "src" / "renderer" / "components"
CHARTER = COMPONENTS / "charter" / "charter.css"

HEX = re.compile(r"#[0-9a-fA-F]{3,8}\b")


def _declarations(path: Path, names: tuple[str, ...]) -> list[tuple[str, str]]:
    text = path.read_text(encoding="utf-8")
    found = []
    for name in names:
        for match in re.finditer(rf"(?<![\w-]){re.escape(name)}\s*:\s*([^;]+);", text):
            found.append((name, match.group(1).strip()))
    return found


def test_charter_accent_and_status_tones_come_from_the_theme() -> None:
    expected = {
        "--wp-accent": "var(--primary)",
        "--wp-accent-fg": "var(--primary-foreground)",
        "--wp-green": "var(--success)",
        "--wp-amber": "var(--warning)",
        "--wp-red": "var(--destructive)",
        "--wp-blue": "var(--info)",
    }
    declared = _declarations(CHARTER, tuple(expected))
    assert declared, "charter.css no longer declares its accent and tones"
    wrong = [f"{name}: {value}" for name, value in declared if value != expected[name]]
    assert not wrong, "the charter must read the theme, not fix its own colour:\n" + "\n".join(wrong)
    assert {name for name, _ in declared} == set(expected)


def test_charter_does_not_remap_the_tailwind_colour_tokens() -> None:
    text = CHARTER.read_text(encoding="utf-8")
    remaps = re.findall(r"--color-[a-z-]+\s*:", text)
    assert not remaps, (
        "charter.css remaps Tailwind colour tokens inside a stage; ui/ components "
        f"must keep the theme's colours: {remaps}"
    )


def test_charter_surfaces_and_text_have_no_hex() -> None:
    names = (
        "--wp-bg",
        "--wp-card",
        "--wp-card-solid",
        "--wp-border",
        "--wp-title",
        "--wp-muted",
        "--wp-faint",
        "--wp-ambient",
        "--wp-accent-ink",
    )
    offenders = [f"{n}: {v}" for n, v in _declarations(CHARTER, names) if HEX.search(v)]
    assert not offenders, "\n".join(offenders)


def test_node_graph_screens_take_surfaces_and_wires_from_the_theme() -> None:
    sheets = {
        COMPONENTS / "visual-to-code" / "flow-canvas.css": (
            "--vtc-bg",
            "--vtc-grid",
            "--vtc-card",
            "--vtc-card-solid",
            "--vtc-card-border",
            "--vtc-title",
            "--vtc-flow",
        ),
        COMPONENTS / "visual-to-code" / "design-import" / "design-import.css": (
            "--di-bg",
            "--di-grid",
            "--di-card",
            "--di-card-solid",
            "--di-border",
            "--di-title",
            "--di-flow",
            "--di-code-bg",
            "--di-danger",
        ),
        COMPONENTS / "test-generation" / "studio" / "test-studio.css": (
            "--tg-bg",
            "--tg-grid",
            "--tg-card",
            "--tg-card-solid",
            "--tg-border",
            "--tg-title",
            "--tg-flow",
            "--tg-code-bg",
            "--tg-danger",
            "--tg-ok",
        ),
    }
    offenders = []
    for path, names in sheets.items():
        declared = _declarations(path, names)
        missing = set(names) - {name for name, _ in declared}
        assert not missing, f"{path.name} no longer declares {sorted(missing)}"
        offenders += [
            f"{path.name} {name}: {value}" for name, value in declared if HEX.search(value)
        ]
    assert not offenders, "a fixed colour where the theme should show:\n" + "\n".join(offenders)
