"""Reshoot: a recording replayed without a window says, step by step, which
selectors still find their element, and proposes new ones where only a later
selector does."""

from __future__ import annotations

import pytest
from browser_agent import recorder_replay
from browser_agent.recorder_replay import ShotStep, find, locator, reshoot
from browser_agent.recording import Recording, Selector
from playwright.async_api import Error as BrowserError


class Locator:
    def __init__(self, page: Page, key: tuple, nth: int | None = None) -> None:
        self.page, self.key, self._nth = page, key, nth

    def nth(self, n: int) -> Locator:
        return Locator(self.page, self.key, n)

    async def count(self) -> int:
        if self.key in self.page.broken:
            raise BrowserError("detached")
        count = self.page.elements.get(self.key, 0)
        return int(count > self._nth) if self._nth is not None else count

    async def evaluate(self, script: str, arg: object = None) -> object:
        if "__workpilotDescribe" in script:
            if self.page.describe_fails:
                raise BrowserError("gone")
            return self.page.description
        self.page.done.append(("scroll", self.key, arg))
        return None

    async def _do(self, what: str, *args: object, **_kw: object) -> None:
        if self.key in self.page.failing:
            raise BrowserError("not clickable")
        self.page.done.append((what, self.key, *args))

    async def click(self, **kw: object) -> None:
        await self._do("click", **kw)

    async def hover(self, **kw: object) -> None:
        await self._do("hover", **kw)

    async def fill(self, value: str, **kw: object) -> None:
        await self._do("fill", value, **kw)

    async def select_option(self, value: object, **kw: object) -> None:
        await self._do("select", value, **kw)

    async def press(self, key: str, **kw: object) -> None:
        await self._do("press", key, **kw)

    async def drag_to(self, target: Locator, **kw: object) -> None:
        await self._do("drag", target.key, **kw)


class Page:
    def __init__(self, elements: dict[tuple, int]) -> None:
        self.elements = elements
        self.broken: set[tuple] = set()
        self.failing: set[tuple] = set()
        self.done: list[tuple] = []
        self.frames: list[str] = []
        self.description: object = None
        self.describe_fails = False
        self.handlers: dict[str, object] = {}
        self.goto_fails = False
        self.load_fails = False

    def frame_locator(self, css: str) -> Page:
        self.frames.append(css)
        return self

    def get_by_test_id(self, value: str) -> Locator:
        return Locator(self, ("testid", value))

    def get_by_role(self, role: str, name: str, exact: bool) -> Locator:
        return Locator(self, ("role", role, name))

    def get_by_label(self, value: str, exact: bool) -> Locator:
        return Locator(self, ("label", value))

    def get_by_placeholder(self, value: str, exact: bool) -> Locator:
        return Locator(self, ("placeholder", value))

    def get_by_text(self, value: str, exact: bool) -> Locator:
        return Locator(self, ("text", value))

    def locator(self, value: str) -> Locator:
        return Locator(self, ("css", value))

    async def goto(self, url: str, **_kw: object) -> None:
        if self.goto_fails:
            raise BrowserError("net::ERR_CONNECTION_REFUSED")
        self.done.append(("goto", url))

    async def evaluate(self, script: str, arg: object) -> None:
        self.done.append(("window", arg))

    async def wait_for_load_state(self, *_a: object, **_kw: object) -> None:
        if self.load_fails:
            raise BrowserError("timeout")

    async def expose_binding(self, name: str, callback: object) -> None:
        assert callback() is None

    async def add_init_script(self, script: str) -> None:
        assert "__workpilotDescribe" in script

    def on(self, event: str, handler: object) -> None:
        self.handlers[event] = handler


class Dialog:
    def __init__(self, fail: bool = False) -> None:
        self.answers: list[object] = []
        self.fail = fail

    async def accept(self, text: str | None = None) -> None:
        if self.fail:
            raise BrowserError("closed")
        self.answers.append(("accept", text))

    async def dismiss(self) -> None:
        self.answers.append("dismiss")


@pytest.fixture(autouse=True)
def quick(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(recorder_replay, "FIND_TIMEOUT_S", 0.05)
    monkeypatch.setattr(recorder_replay, "_POLL_S", 0.01)


def _recording(*steps: dict) -> Recording:
    return Recording.from_dict({"steps": list(steps)})


GO = {"strategy": "role", "role": "button", "value": "Go"}
CSS = {"strategy": "css", "value": "#go"}


async def test_each_step_is_tried_with_its_selectors_in_order(monkeypatch) -> None:
    monkeypatch.setenv("E2E_PASSWORD", "pw")
    page = Page(
        {
            ("css", "#go"): 1,
            ("label", "Name"): 1,
            ("css", "#pw"): 1,
            ("css", "#tags"): 1,
            ("text", "Hi"): 2,
            ("css", "#k"): 1,
            ("testid", "menu"): 1,
            ("css", "#list"): 1,
            ("placeholder", "Drop"): 3,
        }
    )
    page.description = {"tag": "button", "id": "go2", "idUnique": True}
    recording = _recording(
        {"id": "s1", "kind": "navigate", "url": "http://localhost:3000/"},
        # Its role is gone: only the CSS finds it, so its selectors changed.
        {"id": "s2", "kind": "click", "selectors": [GO, CSS], "frames": ["#f"]},
        {
            "id": "s3",
            "kind": "fill",
            "selectors": [{"strategy": "label", "value": "Name"}],
            "value": "Ada",
        },
        {
            "id": "s4",
            "kind": "fill",
            "selectors": [{"strategy": "css", "value": "#pw"}],
            "secretEnv": "E2E_PASSWORD",
        },
        {
            "id": "s5",
            "kind": "select",
            "selectors": [{"strategy": "css", "value": "#tags"}],
            "value": "a",
            "values": ["a", "b"],
        },
        {
            "id": "s6",
            "kind": "assert_text",
            "selectors": [{"strategy": "text", "value": "Hi", "nth": 1}],
            "text": "Hi",
        },
        {
            "id": "s7",
            "kind": "press",
            "selectors": [{"strategy": "css", "value": "#k"}],
            "key": "Enter",
        },
        {
            "id": "s8",
            "kind": "hover",
            "selectors": [{"strategy": "testid", "value": "menu"}],
        },
        {
            "id": "s9",
            "kind": "scroll",
            "selectors": [{"strategy": "css", "value": "#list"}],
            "scrollX": 0,
            "scrollY": 40,
        },
        {"id": "s10", "kind": "scroll", "selectors": [], "scrollX": 0, "scrollY": 9},
        {
            "id": "s11",
            "kind": "drag",
            "selectors": [{"strategy": "css", "value": "#k"}],
            "drop": [{"strategy": "placeholder", "value": "Drop", "nth": 2}],
            "dragMode": "pointer",
        },
    )
    shots = await reshoot(page, recording)
    assert [s.status for s in shots] == ["ok"] + ["changed"] + ["ok"] * 9
    assert shots[1].selectors == [Selector("css", "#go2")]
    assert shots[1].to_dict() == {
        "id": "s2",
        "status": "changed",
        "selectors": [{"strategy": "css", "value": "#go2"}],
    }
    assert page.frames == ["#f"] * 2
    assert ("fill", ("label", "Name"), "Ada") in page.done
    assert ("fill", ("css", "#pw"), "pw") in page.done
    assert ("select", ("css", "#tags"), ["a", "b"]) in page.done
    assert ("press", ("css", "#k"), "Enter") in page.done
    assert ("scroll", ("css", "#list"), [0, 40]) in page.done
    assert ("window", [0, 9]) in page.done
    assert ("drag", ("css", "#k"), ("placeholder", "Drop")) in page.done


async def test_a_missing_element_stops_the_replay() -> None:
    page = Page({("css", "#go"): 2, ("css", "#bad"): 1})
    page.broken.add(("css", "#bad"))
    recording = _recording(
        # Two elements match and no place says which: not found.
        {"id": "s1", "kind": "click", "selectors": [CSS]},
        {"id": "s2", "kind": "click", "selectors": [CSS]},
    )
    shots = await reshoot(page, recording)
    assert [s.status for s in shots] == ["missing", "not-reached"]
    assert await find(page, recording.steps[0], [Selector("css", "#bad")], 0) is None


async def test_a_failed_action_or_page_stops_it_too() -> None:
    page = Page({("css", "#go"): 1, ("css", "#k"): 1})
    page.failing.add(("css", "#go"))
    page.load_fails = True
    shots = await reshoot(
        page,
        _recording(
            {
                "id": "s1",
                "kind": "click",
                "selectors": [{"strategy": "css", "value": "#k"}],
            },
            {"id": "s2", "kind": "click", "selectors": [CSS]},
            {"id": "s3", "kind": "click", "selectors": [CSS]},
        ),
    )
    assert [s.status for s in shots] == ["ok", "failed", "not-reached"]
    page = Page({})
    page.goto_fails = True
    shots = await reshoot(
        page, _recording({"id": "s1", "kind": "navigate", "url": "http://localhost/"})
    )
    assert shots == [ShotStep("s1", "failed")]


async def test_a_drag_without_its_drop_is_missing() -> None:
    page = Page({("css", "#go"): 1})
    drag = {
        "id": "s1",
        "kind": "drag",
        "selectors": [CSS],
        "drop": [{"strategy": "css", "value": "#gone"}],
        "dragMode": "html5",
    }
    assert [s.status for s in await reshoot(page, _recording(drag))] == ["missing"]


async def test_a_changed_element_the_page_cannot_describe_keeps_what_works() -> None:
    page = Page({("css", "#go"): 1})
    page.describe_fails = True
    [shot] = await reshoot(
        page, _recording({"id": "s1", "kind": "click", "selectors": [GO, CSS]})
    )
    assert shot.status == "changed" and shot.selectors == [Selector("css", "#go")]
    page = Page({("css", "#go"): 1})
    page.description = "not an element"
    [shot] = await reshoot(
        page, _recording({"id": "s1", "kind": "click", "selectors": [GO, CSS]})
    )
    assert shot.selectors == [Selector("css", "#go")]


async def test_dialogs_are_answered_as_recorded() -> None:
    page = Page({("css", "#go"): 1})
    recording = _recording(
        {
            "id": "s1",
            "kind": "click",
            "selectors": [CSS],
            "dialog": {"type": "prompt", "accept": True, "text": "Neo"},
        },
    )
    early = Dialog()
    await reshoot(page, Recording())
    await page.handlers["dialog"](early)
    assert early.answers == ["dismiss"]
    await reshoot(page, recording)
    accepted, closed = Dialog(), Dialog(fail=True)
    await page.handlers["dialog"](accepted)
    await page.handlers["dialog"](closed)
    assert accepted.answers == [("accept", "Neo")] and closed.answers == []


def test_each_strategy_has_its_locator() -> None:
    page = Page({})
    step = _recording({"id": "s1", "kind": "click", "selectors": [CSS]}).steps[0]
    assert locator(page, step, Selector("testid", "a")).key == ("testid", "a")
    assert locator(page, step, Selector("css", "#a", nth=2))._nth == 2
