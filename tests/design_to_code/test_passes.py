"""The responsive and states passes, on a page drawn by a fake browser."""

from __future__ import annotations

import asyncio
import io
from contextlib import asynccontextmanager

import numpy as np
import pytest
from design_to_code import passes
from design_to_code.diff import Box, Region
from design_to_code.passes import (
    BREAKPOINTS,
    breakpoint_for,
    changed,
    clean_layout,
    responsive_pass,
    states_pass,
)
from PIL import Image

#: Two buttons: the first has a hover and a focus style, the second neither.
BUTTONS = [
    {"label": "button  \n Go", "x": 10, "y": 10, "w": 40, "h": 20, "hover": True},
    {"label": "a Quiet", "x": 70, "y": 10, "w": 40, "h": 20, "hover": False},
]


def _png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class FakeMouse:
    def __init__(self, tab: FakeTab) -> None:
        self.tab = tab

    async def move(self, x: float, y: float) -> None:
        self.tab.mouse_at = (x, y)


class FakeKeyboard:
    def __init__(self, tab: FakeTab) -> None:
        self.tab = tab

    async def press(self, key: str) -> None:
        assert key == "Tab"
        self.tab.presses += 1


class FakeTab:
    def __init__(self, world: dict, viewport: tuple[int, int, int]) -> None:
        self.world = world
        self.viewport = viewport
        self.mouse_at: tuple[float, float] | None = None
        self.presses = 0
        self.mouse = FakeMouse(self)
        self.keyboard = FakeKeyboard(self)

    def _focused(self) -> int:
        order = self.world.get("tab_order", [0, 1])
        return order[self.presses - 1] if 0 < self.presses <= len(order) else -1

    async def evaluate(self, script: str, arg) -> object:
        self.world.setdefault("scripts", []).append(script)
        if script == passes._LAYOUT_PROBE:
            assert arg == passes._MAX_FINDINGS
            return self.world["layout"](self.viewport)
        if script == passes._STATE_TARGETS:
            return self.world.get("targets", BUTTONS)
        assert script == passes._ACTIVE_INDEX
        return self._focused()

    async def screenshot(self, **options) -> bytes:
        self.world.setdefault("shots", []).append(options)
        width, height, scale = self.viewport
        pixels = np.full((height * scale, width * scale, 3), 255, dtype=np.uint8)
        for index, button in enumerate(BUTTONS):
            x, y, w, h = (int(button[k] * scale) for k in ("x", "y", "w", "h"))
            pixels[y : y + h, x : x + w] = (200, 200, 200)
            if self.mouse_at and button["hover"]:
                mx, my = self.mouse_at
                if (
                    button["x"] <= mx <= button["x"] + button["w"]
                    and button["y"] <= my <= button["y"] + button["h"]
                ):
                    pixels[y : y + h, x : x + w] = (230, 57, 70)
            if index == self._focused() and button["hover"]:
                pixels[y - 2 * scale : y, x : x + w] = (240, 128, 48)
        return _png(Image.fromarray(pixels))


class FakeRenderer:
    def __init__(self, world: dict, viewport=(400, 300, 1)) -> None:
        self.world = world
        self.viewport = viewport

    @asynccontextmanager
    async def open_page(self, files, page, viewport=None):
        self.world.setdefault("opened", []).append((page, viewport))
        if self.world.get("fail"):
            raise self.world["fail"]
        yield FakeTab(self.world, viewport or self.viewport)


def _layout(viewport) -> dict:
    width = viewport[0]
    return {
        "overflow_px": max(0, 1000 - width),
        "overflowing": ["div"] if width < 1000 else [],
        "clipped": ['p   "a very long sentence"'] * 20,
        "overlaps": [["span a", "span b"], ["lonely"], "x"],
    }


@pytest.mark.parametrize(
    ("width", "name"),
    [
        (320, "mobile"),
        (599, "mobile"),
        (600, "tablet"),
        (1023, "tablet"),
        (1024, "desktop"),
        (2880, "desktop"),
    ],
)
def test_a_design_width_falls_in_one_breakpoint(width, name) -> None:
    assert breakpoint_for(width) == name


def test_the_breakpoints_are_mobile_tablet_desktop() -> None:
    assert [(b.name, b.width) for b in BREAKPOINTS] == [
        ("mobile", 390),
        ("tablet", 768),
        ("desktop", 1440),
    ]


def test_a_probe_answer_is_typed_and_bounded() -> None:
    clean = clean_layout(_layout((390, 844, 1)))
    assert clean["overflow_px"] == 610 and clean["overflowing"] == ["div"]
    assert (
        len(clean["clipped"]) == 8 and clean["clipped"][0] == 'p "a very long sentence"'
    )
    assert clean["overlaps"] == [["span a", "span b"]]
    assert clean_layout("garbage") == {
        "overflow_px": 0,
        "overflowing": [],
        "clipped": [],
        "overlaps": [],
    }
    assert clean_layout({"overflow_px": "9", "overlaps": "no"})["overflow_px"] == 0
    assert clean_layout({"overflow_px": -3})["overflow_px"] == 0
    assert len(clean_layout({"clipped": ["x" * 500]})["clipped"][0]) == 60


def test_the_responsive_pass_compares_the_design_width_and_checks_the_others() -> None:
    world: dict = {"layout": _layout}
    renderer = FakeRenderer(world, viewport=(800, 600, 1))
    target = Image.new("RGB", (800, 600), (255, 255, 255))
    report = asyncio.run(
        responsive_pass(
            renderer,
            {"index.html": "x"},
            "index.html",
            target=target,
            regions=[Region("Top", Box(0, 0, 800, 100))],
            masks=[],
            tolerance=12,
            threshold=0.999,
        )
    )
    assert report["status"] == "done"
    mobile, tablet, desktop = report["breakpoints"]
    # The 800 px design is a tablet: that one is rendered at its size and compared.
    assert tablet["compared"] and (tablet["width"], tablet["height"]) == (800, 600)
    assert 0 < tablet["score"] < 1 and tablet["passed"] is False
    assert tablet["issues"] and tablet["issues"][0]["region"] == "Top"
    assert not mobile["compared"] and "score" not in mobile
    assert (mobile["width"], mobile["overflow_px"]) == (390, 610)
    assert desktop["overflow_px"] == 0 and desktop["overflowing"] == []
    assert mobile["render_image"].startswith("data:image/png;base64,")
    assert world["opened"] == [
        ("index.html", (390, 844, 1)),
        ("index.html", (800, 600, 1)),
        ("index.html", (1440, 900, 1)),
    ]


def test_the_states_pass_says_which_element_has_no_visible_state() -> None:
    world: dict = {}
    report = asyncio.run(
        states_pass(
            FakeRenderer(world, viewport=(200, 100, 2)), {"i.html": ""}, "i.html"
        )
    )
    go, quiet = report["elements"]
    assert (go["id"], go["label"], quiet["id"]) == (0, "button Go", 1)
    assert go["hover"]["changed"] and go["focus"]["changed"]
    assert not quiet["hover"]["changed"] and not quiet["focus"]["changed"]
    assert go["rest_image"].startswith("data:image/png;base64,")
    assert (report["without_hover"], report["without_focus"], report["unreached"]) == (
        1,
        1,
        0,
    )
    assert report["limit"] == passes.MAX_STATE_ELEMENTS
    assert all(shot.get("animations") == "disabled" for shot in world["shots"])


@pytest.mark.parametrize(
    ("order", "presses"),
    [
        # The page scrolled: the keyboard went past the elements in view.
        ([-2], 1),
        # The probe answered nonsense.
        (["x"], 1),
        # Focus never reaches them, nor anything: three tries per element.
        ([-1] * 10, 6),
        # Focus comes back to the first one, then reaches the second.
        ([0, 0, 1], 3),
    ],
)
def test_the_keyboard_walk_stops_where_it_should(order, presses) -> None:
    world: dict = {"tab_order": order}
    report = asyncio.run(states_pass(FakeRenderer(world), {"i.html": ""}, "i.html"))
    actives = [s for s in world["scripts"] if s == passes._ACTIVE_INDEX]
    assert len(actives) == presses
    reached = sum(1 for e in report["elements"] if e["focus"] is not None)
    assert report["unreached"] == 2 - reached


def test_unreadable_targets_are_dropped() -> None:
    world: dict = {
        "targets": ["x", {"label": "a", "x": "1", "y": 0, "w": 1, "h": 1}, BUTTONS[0]]
    }
    report = asyncio.run(
        states_pass(FakeRenderer(world), {"i.html": ""}, "i.html", limit=1)
    )
    assert [e["label"] for e in report["elements"]] == ["button Go"]


def test_a_change_of_a_few_pixels_is_not_a_style() -> None:
    rest = Image.new("RGB", (100, 100), (255, 255, 255))
    state = rest.copy()
    state.putpixel((1, 1), (0, 0, 0))
    assert not changed(rest, state)
    for x in range(30):
        state.putpixel((x, 5), (0, 0, 0))
    assert changed(rest, state)
