"""What an action caused, and where its element lives, are recorded with it.

A request the action started, the page it led to and an element that
appeared after it become the step's waits; an iframe or an open shadow root
around the element becomes its frames and shadow hosts. All of it is page
data: bounded, checked, dropped when it does not fit.
"""

from __future__ import annotations

import asyncio

from browser_agent.recorder import (
    REQUEST_WINDOW_S,
    Recorder,
    record_session,
    shadow_hosts,
)
from browser_agent.recording import MAX_FRAMES, MAX_SHADOW, MAX_STEPS, RequestWait
from playwright.async_api import Error as BrowserError

PAGE = "http://localhost:3000/shop"
SAVE = {"tag": "button", "role": "button", "name": "Save", "text": "Save"}
CARD = {"tag": "input", "placeholder": "Card", "path": "input"}
HOST = {"tag": "x-card", "path": "x-card"}


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def test_the_request_an_action_started_is_what_it_waits_for() -> None:
    clock = Clock()
    rec = Recorder(clock)
    assert rec.on_request("POST", "http://localhost:3000/api", PAGE) is None
    click = rec.on_page_event({"kind": "click", "target": SAVE})
    for method, url, page in (
        ("TRACE", "http://localhost:3000/api", PAGE),
        ("POST", None, PAGE),
        ("POST", "http://localhost:3000/api", None),
        ("POST", "https://analytics.test/collect", PAGE),
        ("POST", "http://localhost:3000/api/ghp_" + "a" * 36, PAGE),
        ("POST", "http://localhost:3000/a b", PAGE),
    ):
        assert rec.on_request(method, url, page) is None
    clock.now += REQUEST_WINDOW_S - 0.1
    step = rec.on_request("POST", "http://localhost:3000/api/save?draft=1", PAGE)
    assert step is click and click.wait_request == RequestWait("POST", "/api/save")
    # The first one only.
    assert rec.on_request("GET", "http://localhost:3000/api/other", PAGE) is None
    later = rec.on_page_event({"kind": "click", "target": SAVE})
    clock.now += REQUEST_WINDOW_S + 0.1
    assert rec.on_request("GET", "http://localhost:3000/api/late", PAGE) is None
    assert later is not None and later.wait_request is None


def test_an_assertion_is_no_action_and_a_full_recording_causes_nothing() -> None:
    clock = Clock()
    rec = Recorder(clock)
    rec.on_page_event({"kind": "assert_text", "target": SAVE, "text": "Save"})
    assert rec.on_request("GET", "http://localhost:3000/api", PAGE) is None
    for _ in range(MAX_STEPS):
        rec.on_page_event({"kind": "click", "target": SAVE})
    assert rec.on_page_event({"kind": "click", "target": SAVE}) is None
    # The action was not recorded: there is no step to wait.
    assert rec.on_navigation("http://localhost:3000/next") is None
    assert rec.on_request("GET", "http://localhost:3000/api", PAGE) is None


def test_an_element_that_appeared_is_waited_for_and_keeps_its_place() -> None:
    rec = Recorder()
    target = {**CARD, "shadow": [HOST], "appeared": True}
    first = rec.on_page_event(
        {"kind": "fill", "target": target, "value": "4"}, ['iframe[name="pay"]']
    )
    assert first is not None and first.wait_visible
    assert first.frames == ['iframe[name="pay"]'] and first.shadow == ["x-card"]
    # The next keystroke reports the element as old: the step keeps its wait.
    again = rec.on_page_event(
        {"kind": "fill", "target": {**target, "appeared": False}, "value": "42"},
        ['iframe[name="pay"]'],
    )
    assert again is first and first.value == "42" and first.wait_visible
    # The same field in another frame is another element.
    other = rec.on_page_event({"kind": "fill", "target": target, "value": "1"}, [])
    assert other is not first and len(rec.steps) == 2
    assert rec.on_page_event({"kind": "click", "target": SAVE}).wait_visible is False


def test_an_element_whose_place_cannot_be_named_is_not_recorded() -> None:
    rec = Recorder()
    unnamed = {"tag": "x-card", "role": "tab", "name": "Card"}
    for target in (
        {**SAVE, "shadow": "x-card"},
        {**SAVE, "shadow": [HOST] * (MAX_SHADOW + 1)},
        {**SAVE, "shadow": [unnamed]},
    ):
        assert rec.on_page_event({"kind": "click", "target": target}) is None
    deep = ["iframe"] * (MAX_FRAMES + 1)
    assert rec.on_page_event({"kind": "click", "target": SAVE}, deep) is None
    assert shadow_hosts(None) == [] and shadow_hosts([HOST]) == ["x-card"]
    assert rec.steps == []


# --- the session, with frames and requests ------------------------------------------


class Element:
    def __init__(self, described: object = None, fails: bool = False) -> None:
        self.described = described
        self.fails = fails

    async def evaluate(self, script: str) -> object:
        assert "__workpilotDescribe" in script
        if self.fails:
            raise BrowserError("Frame was detached")
        return self.described


class Frame:
    def __init__(
        self, parent: Frame | None = None, element: Element | None = None
    ) -> None:
        self.url = ""
        self.parent_frame = parent
        self.element = element
        self.asked = 0

    async def frame_element(self) -> Element:
        self.asked += 1
        assert self.element is not None
        return self.element


class Request:
    def __init__(self, resource_type: str, url: str) -> None:
        self.resource_type = resource_type
        self.method = "POST"
        self.url = url


class Page:
    def __init__(self) -> None:
        self.main_frame = Frame()
        self.handlers: dict[str, object] = {}
        self.binding = None

    async def expose_binding(self, _name, callback) -> None:
        self.binding = callback

    async def add_init_script(self, script: str) -> None:
        assert script

    def on(self, event: str, handler) -> None:
        self.handlers[event] = handler

    async def goto(self, url: str, wait_until: str, timeout: int) -> None:
        self.main_frame.url = url


def _iframe(name: str, **extra: object) -> Element:
    return Element(
        {
            "tag": "iframe",
            "nameAttr": name,
            "nameUnique": True,
            "path": "iframe",
            **extra,
        }
    )


async def test_a_session_records_inside_frames_and_waits_for_requests() -> None:
    page = Page()
    pay = Frame(page.main_frame, _iframe("pay"))
    inner = Frame(pay, _iframe("inner"))
    gone = Frame(page.main_frame, Element(fails=True))
    blank = Frame(page.main_frame, Element(None))
    in_shadow = Frame(page.main_frame, _iframe("s", shadow=[HOST]))
    deep = page.main_frame
    for depth in range(MAX_FRAMES + 1):
        deep = Frame(deep, _iframe(f"d{depth}"))
    stop = asyncio.get_running_loop().create_future()
    emitted = []
    click = {"kind": "click", "target": SAVE}

    async def drive() -> None:
        await asyncio.sleep(0)
        await page.binding({"frame": inner}, click)
        page.handlers["request"](Request("document", PAGE))
        page.handlers["request"](Request("fetch", "http://localhost:3000/api/pay"))
        await page.binding({"frame": inner}, click)
        for frame in (gone, blank, in_shadow, deep):
            await page.binding({"frame": frame}, click)
        page.handlers["framedetached"](inner)
        page.handlers["framedetached"](Frame())
        stop.set_result(None)

    driver = asyncio.ensure_future(drive())
    recording, _reason = await record_session(page, PAGE, stop, emitted.append)
    await asyncio.wait_for(driver, timeout=5)
    first, second, shadowed = recording.steps[1:]
    assert first.frames == ['iframe[name="pay"]', 'iframe[name="inner"]']
    assert first.wait_request == RequestWait("POST", "/api/pay")
    assert second.frames == first.frames and first.frame_shadow == []
    # An iframe inside a shadow root names its host too.
    assert shadowed.frames == ['iframe[name="s"]']
    assert shadowed.frame_shadow == [["x-card"]]
    # Each frame is described once, then remembered until it is detached.
    assert inner.asked == 1 and pay.asked == 1
    assert emitted[2] is first
