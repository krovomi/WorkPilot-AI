"""Two passes on the version the loop kept, when the person asks for them.

* **Responsive**: the page at three widths (``BREAKPOINTS``). The breakpoint
  whose range holds the design's width is rendered at the design's own size
  and compared with it; the two others have no design to be compared with, and
  are checked on their own: a page wider than the screen, text its box cuts,
  elements laid over one another.
* **States**: the first interactive elements of the page (``MAX_STATE_ELEMENTS``),
  hovered with the mouse and focused with the Tab key, each state captured and
  compared with the element at rest. An element whose state changes nothing on
  the screen has no style for it; a focus with no visible style is also an
  accessibility failure (WCAG 2.4.7).

Both open the page through ``Renderer.open_page``, with the loop's guards:
JavaScript off (the probes below are WorkPilot's, evaluated by Playwright; the
page's own scripts never run, so they cannot change what a probe reads), the
network offline, ``file:`` URLs under the version's folder only. What a probe
returns came from generated markup: it is trimmed and typed here before it
reaches the report.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image

from .diff import Box, Region, compare, load_image, thumbnail
from .render import Renderer


@dataclass(frozen=True)
class Breakpoint:
    name: str
    width: int
    height: int
    #: The widest design this breakpoint stands for (None: no limit).
    max_width: int | None


#: The three widths of the responsive pass, in CSS pixels.
BREAKPOINTS: tuple[Breakpoint, ...] = (
    Breakpoint("mobile", 390, 844, 599),
    Breakpoint("tablet", 768, 1024, 1023),
    Breakpoint("desktop", 1440, 900, None),
)
#: Interactive elements captured in their states, at most.
MAX_STATE_ELEMENTS = 6
#: Findings of one kind kept per breakpoint.
_MAX_FINDINGS = 8
_LABEL = 60
#: Channel distance under which a pixel of a state is the pixel at rest.
_STATE_TOLERANCE = 12
_CROP_PAD = 4
_CROP_WIDTH = 240

_LABEL_JS = """(el) => {
  const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt')
    || el.getAttribute('placeholder') || el.getAttribute('value') || '').replace(/\\s+/g, ' ').trim();
  return el.tagName.toLowerCase() + (text ? ' "' + text.slice(0, 40) + '"' : '');
}"""

#: Width overflow, cut text and overlapping elements, over the whole document.
_LAYOUT_PROBE = (
    """(limit) => {
  const label = """
    + _LABEL_JS
    + """;
  const width = document.documentElement.clientWidth;
  const out = { overflow_px: Math.max(0, document.documentElement.scrollWidth - width),
    overflowing: [], clipped: [], overlaps: [] };
  const leaves = [];
  const media = new Set(['IMG', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'VIDEO', 'svg']);
  for (const el of Array.from(document.body ? document.body.querySelectorAll('*') : []).slice(0, 2000)) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (r.right > width + 1 && out.overflowing.length < limit) out.overflowing.push(label(el));
    const text = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
    if (text && !cs.display.startsWith('inline') && out.clipped.length < limit) {
      const cutX = el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible';
      const cutY = el.scrollHeight > el.clientHeight + 1 && cs.overflowY !== 'visible';
      if (cutX || cutY) out.clipped.push(label(el));
    }
    if ((text || media.has(el.tagName)) && leaves.length < 300) leaves.push([el, r]);
  }
  for (let i = 0; i < leaves.length && out.overlaps.length < limit; i++) {
    for (let j = i + 1; j < leaves.length && out.overlaps.length < limit; j++) {
      const [a, ra] = leaves[i];
      const [b, rb] = leaves[j];
      if (a.contains(b) || b.contains(a)) continue;
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w <= 0 || h <= 0) continue;
      const smaller = Math.min(ra.width * ra.height, rb.width * rb.height);
      if (w * h >= 16 && w * h >= 0.25 * smaller) out.overlaps.push([label(a), label(b)]);
    }
  }
  return out;
}"""
)

_PICK_JS = """(max) => {
  const selector = 'a[href], button, input:not([type=hidden]), select, textarea, summary,'
    + ' [role=button], [role=link], [tabindex]:not([tabindex="-1"])';
  const picked = [];
  for (const el of document.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    if (el.disabled || r.width < 2 || r.height < 2) continue;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
    picked.push(el);
    if (picked.length >= max) break;
  }
  return picked;
}"""

#: The interactive elements in view, with their boxes.
_STATE_TARGETS = (
    "(max) => { const label = "
    + _LABEL_JS
    + "; return ("
    + _PICK_JS
    + ")(max).map((el) => { const r = el.getBoundingClientRect();"
    + " return { label: label(el), x: r.x, y: r.y, w: r.width, h: r.height }; }); }"
)
#: Which of them holds the focus: its index, -1 for none, -2 once the page scrolled.
_ACTIVE_INDEX = (
    "(max) => (scrollX || scrollY) ? -2 : ("
    + _PICK_JS
    + ")(max).indexOf(document.activeElement)"
)


def breakpoint_for(width: int) -> str:
    """The name of the breakpoint whose range holds a design ``width`` px wide."""
    for point in BREAKPOINTS[:-1]:
        if point.max_width is not None and width <= point.max_width:
            return point.name
    return BREAKPOINTS[-1].name


def _data_url(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def _label(value: object) -> str:
    return " ".join(str(value).split())[:_LABEL]


def _labels(values: object) -> list[str]:
    return (
        [_label(v) for v in values][:_MAX_FINDINGS] if isinstance(values, list) else []
    )


def clean_layout(raw: object) -> dict:
    """The layout probe's answer, typed and bounded."""
    data = raw if isinstance(raw, dict) else {}
    overflow = data.get("overflow_px")
    overlaps = data.get("overlaps") if isinstance(data.get("overlaps"), list) else []
    return {
        "overflow_px": int(overflow)
        if isinstance(overflow, int | float) and overflow > 0
        else 0,
        "overflowing": _labels(data.get("overflowing")),
        "clipped": _labels(data.get("clipped")),
        "overlaps": [
            [_label(pair[0]), _label(pair[1])]
            for pair in overlaps
            if isinstance(pair, list) and len(pair) == 2
        ][:_MAX_FINDINGS],
    }


async def responsive_pass(
    renderer: Renderer,
    files: dict[str, str],
    page: str,
    *,
    target: Image.Image,
    regions: list[Region],
    masks: list[Box],
    tolerance: int,
    threshold: float,
) -> dict:
    """The page at each breakpoint; ``RenderError`` when one cannot be opened."""
    design = renderer.viewport
    matching = breakpoint_for(design[0])
    points: list[dict] = []
    for point in BREAKPOINTS:
        compared = point.name == matching
        viewport = design if compared else (point.width, point.height, 1)
        async with renderer.open_page(files, page, viewport) as tab:
            layout = clean_layout(await tab.evaluate(_LAYOUT_PROBE, _MAX_FINDINGS))
            image = load_image(await tab.screenshot(type="png"))
        entry: dict[str, Any] = {
            "name": point.name,
            "width": viewport[0],
            "height": viewport[1],
            "compared": compared,
            "render_image": _data_url(thumbnail(image)),
            **layout,
        }
        if compared:
            report = compare(
                target,
                image,
                regions,
                masks=masks,
                tolerance=tolerance,
                threshold=threshold,
            )
            entry["score"] = report.score
            entry["passed"] = report.score >= threshold
            entry["issues"] = [
                {"region": region.name, **issue}
                for region in report.regions
                for issue in region.issues
            ][:_MAX_FINDINGS]
        points.append(entry)
    return {"status": "done", "breakpoints": points}


@dataclass(frozen=True)
class _Target:
    label: str
    box: tuple[float, float, float, float]


def _targets(raw: object, limit: int) -> list[_Target]:
    found: list[_Target] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        values = [item.get(k) for k in ("x", "y", "w", "h")]
        if all(isinstance(v, int | float) for v in values):
            x, y, w, h = (float(v) for v in values)
            found.append(_Target(_label(item.get("label", "")), (x, y, w, h)))
    return found[:limit]


def _crop(
    image: Image.Image, box: tuple[float, float, float, float], scale: int
) -> Image.Image:
    x, y, w, h = box
    left = max(0, int((x - _CROP_PAD) * scale))
    top = max(0, int((y - _CROP_PAD) * scale))
    right = min(image.width, int((x + w + _CROP_PAD) * scale) + 1)
    bottom = min(image.height, int((y + h + _CROP_PAD) * scale) + 1)
    return image.crop((left, top, max(left + 1, right), max(top + 1, bottom)))


def changed(rest: Image.Image, state: Image.Image) -> bool:
    """Whether a state shows on the screen: enough pixels moved past the tolerance."""
    a = np.asarray(rest, dtype=np.int16)
    b = np.asarray(state, dtype=np.int16)
    moved = int((np.abs(a - b).max(axis=2) > _STATE_TOLERANCE).sum())
    return moved >= max(3, round(0.002 * a.shape[0] * a.shape[1]))


def _state(rest: Image.Image, shot: Image.Image, target: _Target, scale: int) -> dict:
    before, after = _crop(rest, target.box, scale), _crop(shot, target.box, scale)
    return {
        "changed": changed(before, after),
        "image": _data_url(thumbnail(after, _CROP_WIDTH)),
    }


async def states_pass(
    renderer: Renderer,
    files: dict[str, str],
    page: str,
    *,
    limit: int = MAX_STATE_ELEMENTS,
) -> dict:
    """Hover and focus of the first ``limit`` interactive elements in view."""
    width, height, scale = renderer.viewport
    async with renderer.open_page(files, page) as tab:
        rest = load_image(await tab.screenshot(type="png", animations="disabled"))
        targets = _targets(await tab.evaluate(_STATE_TARGETS, limit), limit)
        elements: list[dict[str, Any]] = [
            {
                "id": index,
                "label": t.label,
                "rest_image": _data_url(
                    thumbnail(_crop(rest, t.box, scale), _CROP_WIDTH)
                ),
                "hover": None,
                "focus": None,
            }
            for index, t in enumerate(targets)
        ]
        for index, t in enumerate(targets):
            x, y, w, h = t.box
            await tab.mouse.move(x + w / 2, y + h / 2)
            shot = load_image(await tab.screenshot(type="png", animations="disabled"))
            elements[index]["hover"] = _state(rest, shot, t, scale)
        # Off every element, then through the page with the keyboard, as a
        # person who does not use a mouse would.
        await tab.mouse.move(width - 1, height - 1)
        for _ in range(len(targets) * 3):
            await tab.keyboard.press("Tab")
            index = await tab.evaluate(_ACTIVE_INDEX, limit)
            if not isinstance(index, int) or index == -2:
                break
            if 0 <= index < len(targets) and elements[index]["focus"] is None:
                shot = load_image(
                    await tab.screenshot(type="png", animations="disabled")
                )
                elements[index]["focus"] = _state(rest, shot, targets[index], scale)
            if all(e["focus"] is not None for e in elements):
                break
    return {
        "status": "done",
        "limit": limit,
        "elements": elements,
        "without_hover": sum(1 for e in elements if not e["hover"]["changed"]),
        "without_focus": sum(
            1 for e in elements if e["focus"] is not None and not e["focus"]["changed"]
        ),
        "unreached": sum(1 for e in elements if e["focus"] is None),
    }
