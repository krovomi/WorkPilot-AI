"""Colour contrast as WCAG 2.2 computes it (1.4.3 AA, 1.4.6 AAA), with no browser (#391).

The ratio is the one of the standard: relative luminance of sRGB colours,
``(L1 + 0.05) / (L2 + 0.05)``. The colours come from the source:

- a CSS rule (``.css``, ``.scss``, ``.sass``, ``.less``, ``.styl`` and the
  ``<style>`` blocks of HTML, Vue, Svelte, Astro, Angular) that sets both a
  text colour and a background;
- an inline ``style`` that sets both;
- class names, through a token map: the design system's names
  (``text-gray-500``, ``--brand``) are not standard, so the person maps them
  to colours in ``.workpilot/a11y-tokens.json``
  (``{"tokens": {"text-muted": "#6b7280"}}``). Tailwind's arbitrary values
  (``text-[#777]``, ``bg-[#fff]``) need no map.

CSS custom properties (``var(--x, fallback)``), SCSS ``$x`` and Less ``@x``
variables declared in the same file or the token map are resolved. A colour
that is not known (an expression, ``currentColor``, a gradient) is never
guessed: no pair, no finding.
"""

from __future__ import annotations

import colorsys
import json
import re
from dataclasses import dataclass
from pathlib import Path

__all__ = [
    "ContrastPair",
    "Tokens",
    "contrast_ratio",
    "load_tokens",
    "pairs_in_css",
    "pairs_in_style",
    "pairs_in_classes",
    "parse_color",
    "required_ratio",
]

TOKENS_FILE = Path(".workpilot") / "a11y-tokens.json"
MAX_TOKENS = 2000

_NAMED = {
    "black": "#000000", "white": "#ffffff", "red": "#ff0000", "green": "#008000",
    "blue": "#0000ff", "yellow": "#ffff00", "gray": "#808080", "grey": "#808080",
    "silver": "#c0c0c0", "maroon": "#800000", "navy": "#000080", "purple": "#800080",
    "teal": "#008080", "olive": "#808000", "orange": "#ffa500", "lime": "#00ff00",
    "aqua": "#00ffff", "cyan": "#00ffff", "fuchsia": "#ff00ff", "magenta": "#ff00ff",
    "lightgray": "#d3d3d3", "lightgrey": "#d3d3d3", "darkgray": "#a9a9a9",
    "darkgrey": "#a9a9a9", "dimgray": "#696969", "whitesmoke": "#f5f5f5",
    "gainsboro": "#dcdcdc", "pink": "#ffc0cb", "gold": "#ffd700", "beige": "#f5f5dc",
    "ivory": "#fffff0", "khaki": "#f0e68c", "lightyellow": "#ffffe0",
    "lightblue": "#add8e6", "skyblue": "#87ceeb", "darkblue": "#00008b",
    "darkred": "#8b0000", "darkgreen": "#006400", "tomato": "#ff6347",
    "coral": "#ff7f50", "salmon": "#fa8072", "crimson": "#dc143c",
    "indigo": "#4b0082", "violet": "#ee82ee", "brown": "#a52a2a", "tan": "#d2b48c",
}  # fmt: skip

RGBA = tuple[float, float, float, float]


def _hex(value: str) -> RGBA | None:
    digits = value.lstrip("#")
    if len(digits) in (3, 4):
        digits = "".join(c * 2 for c in digits)
    if len(digits) not in (6, 8) or not re.fullmatch(r"[0-9a-fA-F]+", digits):
        return None
    r, g, b = (int(digits[k : k + 2], 16) for k in (0, 2, 4))
    a = int(digits[6:8], 16) / 255 if len(digits) == 8 else 1.0
    return r, g, b, a


def _channel(token: str, scale: float = 255) -> float:
    token = token.strip()
    if token.endswith("%"):
        return float(token[:-1]) / 100 * scale
    return float(token)


def parse_color(value: str) -> RGBA | None:
    """``(r, g, b, alpha)`` in 0-255 / 0-1, or None for what is not a plain colour."""
    raw = value.strip().lower().removesuffix("!important").strip()
    if raw.startswith("#"):
        return _hex(raw)
    if raw in _NAMED:
        return _hex(_NAMED[raw])
    match = re.fullmatch(r"(rgba?|hsla?)\(\s*([^)]*)\)", raw)
    if not match:
        return None
    parts = [p for p in re.split(r"[\s,/]+", match.group(2)) if p]
    if len(parts) not in (3, 4):
        return None
    try:
        alpha = _channel(parts[3], 1) if len(parts) == 4 else 1.0
        if match.group(1).startswith("rgb"):
            r, g, b = (_channel(p) for p in parts[:3])
        else:
            h = float(parts[0].removesuffix("deg")) / 360
            s, l_ = _channel(parts[1], 1), _channel(parts[2], 1)
            rf, gf, bf = colorsys.hls_to_rgb(h % 1, l_, s)
            r, g, b = rf * 255, gf * 255, bf * 255
    except ValueError:
        return None
    clamp = lambda v, hi: max(0.0, min(hi, v))  # noqa: E731
    return clamp(r, 255), clamp(g, 255), clamp(b, 255), clamp(alpha, 1)


def _luminance(color: RGBA) -> float:
    def linear(c: float) -> float:
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b, _ = color
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)


def _over(top: RGBA, bottom: RGBA) -> RGBA:
    a = top[3]
    return (
        top[0] * a + bottom[0] * (1 - a),
        top[1] * a + bottom[1] * (1 - a),
        top[2] * a + bottom[2] * (1 - a),
        1.0,
    )


def contrast_ratio(foreground: RGBA, background: RGBA) -> float | None:
    """The WCAG ratio; None when the background is see-through (what is under it is unknown)."""
    if background[3] < 1:
        return None
    fg = _over(foreground, background) if foreground[3] < 1 else foreground
    hi, lo = sorted((_luminance(fg), _luminance(background)), reverse=True)
    return round((hi + 0.05) / (lo + 0.05), 2)


def required_ratio(level: str, large: bool) -> float:
    """4.5:1 (3:1 for large text) at AA, 7:1 (4.5:1) at AAA."""
    if level == "AAA":
        return 4.5 if large else 7.0
    return 3.0 if large else 4.5


@dataclass(frozen=True)
class ContrastPair:
    foreground: str
    background: str
    ratio: float
    large: bool
    line: int
    where: str
    """The selector, ``style`` or the class names it was read from."""


class Tokens:
    """Colour names the source uses: the person's map, then the file's own variables."""

    def __init__(self, mapping: dict[str, str] | None = None) -> None:
        self.mapping: dict[str, str] = dict(mapping or {})

    def with_variables(self, css: str) -> Tokens:
        found = dict(self.mapping)
        for match in re.finditer(r"(--[\w-]+|\$[\w-]+|@[\w-]+)\s*:\s*([^;{}\n]+)", css):
            found.setdefault(match.group(1), match.group(2).strip())
        return Tokens(found)

    def resolve(self, value: str, depth: int = 0) -> RGBA | None:
        value = value.strip().removesuffix("!important").strip()
        if depth > 8 or not value:
            return None
        var = re.fullmatch(r"var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)", value)
        if var:
            target = self.mapping.get(var.group(1))
            if target is not None:
                return self.resolve(target, depth + 1)
            return self.resolve(var.group(2), depth + 1) if var.group(2) else None
        if value[:1] in "$@" and value in self.mapping:
            return self.resolve(self.mapping[value], depth + 1)
        if value in self.mapping:
            return self.resolve(self.mapping[value], depth + 1)
        return parse_color(value)


def load_tokens(project: Path) -> Tokens:
    """The person's token map, or an empty one; a broken file maps nothing."""
    path = project / TOKENS_FILE
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 512 * 1024:
            return Tokens()
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return Tokens()
    entries = raw.get("tokens", raw) if isinstance(raw, dict) else {}
    if not isinstance(entries, dict):
        return Tokens()
    mapping = {
        str(k)[:120]: str(v)[:120]
        for k, v in list(entries.items())[:MAX_TOKENS]
        if isinstance(k, str) and isinstance(v, str) and parse_color(v)
    }
    return Tokens(mapping)


def _is_large(declarations: dict[str, str]) -> bool:
    size = declarations.get("font-size", "")
    weight = declarations.get("font-weight", "")
    bold = weight in ("bold", "bolder") or (weight.isdigit() and int(weight) >= 700)
    match = re.fullmatch(r"([\d.]+)(px|pt|rem|em)", size.strip())
    if not match:
        return False
    px = (
        float(match.group(1))
        * {"px": 1, "pt": 4 / 3, "rem": 16, "em": 16}[match.group(2)]
    )
    return px >= 24 or (bold and px >= 18.66)


def _declarations(block: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for part in block.split(";"):
        if ":" in part:
            key, _, value = part.partition(":")
            found[key.strip().lower()] = value.strip()
    return found


def _background(declarations: dict[str, str]) -> str | None:
    if "background-color" in declarations:
        return declarations["background-color"]
    background = declarations.get("background", "")
    if not background or "gradient" in background or "url(" in background:
        return None
    first = (
        background.split()[0]
        if not background.startswith(("rgb", "hsl", "var("))
        else background
    )
    return first


def _pair(
    declarations: dict[str, str], tokens: Tokens, line: int, where: str
) -> ContrastPair | None:
    fg_raw, bg_raw = declarations.get("color"), _background(declarations)
    if not fg_raw or not bg_raw:
        return None
    fg, bg = tokens.resolve(fg_raw), tokens.resolve(bg_raw)
    if fg is None or bg is None:
        return None
    ratio = contrast_ratio(fg, bg)
    if ratio is None:
        return None
    return ContrastPair(fg_raw, bg_raw, ratio, _is_large(declarations), line, where)


_RULE = re.compile(r"([^{}@;]+)\{([^{}]*)\}")


def pairs_in_css(css: str, tokens: Tokens, first_line: int = 1) -> list[ContrastPair]:
    """Each rule of ``css`` that sets both colours, with its ratio."""
    css = re.sub(
        r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), css, flags=re.S
    )
    local = tokens.with_variables(css)
    pairs = []
    for match in _RULE.finditer(css):
        selector = " ".join(match.group(1).split())
        line = first_line + css.count("\n", 0, match.start(2))
        pair = _pair(_declarations(match.group(2)), local, line, selector[:120])
        if pair:
            pairs.append(pair)
    return pairs


def pairs_in_style(style: str, tokens: Tokens, line: int) -> ContrastPair | None:
    return _pair(_declarations(style), tokens, line, "style")


_ARBITRARY = re.compile(r"^(text|bg)-\[(.+)\]$")


def pairs_in_classes(classes: str, tokens: Tokens, line: int) -> ContrastPair | None:
    """``text-*`` and ``bg-*`` classes resolved by arbitrary value or the token map."""
    fg = bg = None
    for name in classes.split():
        if ":" in name:  # hover:, dark:, md: — another state than the one shown
            continue
        arbitrary = _ARBITRARY.match(name)
        if arbitrary:
            value = arbitrary.group(2).replace("_", " ")
            if arbitrary.group(1) == "text" and parse_color(value):
                fg = (name, value)
            elif arbitrary.group(1) == "bg" and parse_color(value):
                bg = (name, value)
        elif name in tokens.mapping:
            if name.startswith(("text-", "color-", "fg-")):
                fg = (name, tokens.mapping[name])
            elif name.startswith(("bg-", "background-")):
                bg = (name, tokens.mapping[name])
    if not fg or not bg:
        return None
    declarations = {"color": fg[1], "background-color": bg[1]}
    pair = _pair(declarations, tokens, line, f"{fg[0]} {bg[0]}")
    if pair is None:
        return None
    return ContrastPair(fg[0], bg[0], pair.ratio, pair.large, line, pair.where)
