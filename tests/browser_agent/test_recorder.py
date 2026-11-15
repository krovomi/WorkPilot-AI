"""What a person does on a page becomes typed, bounded steps; secrets stay out."""

from __future__ import annotations

import asyncio

from browser_agent import recorder as recorder_module
from browser_agent.recorder import (
    BINDING,
    NAVIGATION_WINDOW_S,
    SCRIPT,
    Recorder,
    record_session,
    safe_url,
)
from browser_agent.recording import MAX_STEPS

SAVE = {"tag": "button", "role": "button", "name": "Save", "text": "Save"}
EMAIL = {"tag": "input", "label": "Email", "nameAttr": "email"}
PASSWORD = {"tag": "input", "label": "Password", "type": "password", "secret": True}


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def test_the_first_step_opens_the_page_and_its_echo_is_not_a_step() -> None:
    rec = Recorder()
    first = rec.start("http://localhost:3000")
    assert first is not None and first.to_dict() == {
        "id": "s1",
        "kind": "navigate",
        "selectors": [],
        "url": "http://localhost:3000",
    }
    assert rec.on_navigation("http://localhost:3000/") is None
    assert rec.on_navigation("http://localhost:3000/") is None
    assert Recorder().start("javascript:alert(1)") is None


def test_a_navigation_an_action_caused_is_not_a_step() -> None:
    clock = Clock()
    rec = Recorder(clock)
    rec.start("http://localhost:3000/")
    rec.on_navigation("http://localhost:3000/")
    rec.on_page_event({"kind": "click", "target": SAVE})
    clock.now += NAVIGATION_WINDOW_S - 0.5
    assert rec.on_navigation("http://localhost:3000/saved") is None
    clock.now += NAVIGATION_WINDOW_S + 1
    typed = rec.on_navigation("http://localhost:3000/settings")
    assert typed is not None and typed.kind == "navigate" and typed.id == "s3"
    assert rec.on_navigation("ftp://x") is None


def test_successive_values_in_one_field_make_one_step() -> None:
    rec = Recorder()
    first = rec.on_page_event({"kind": "fill", "target": EMAIL, "value": "a"})
    again = rec.on_page_event({"kind": "fill", "target": EMAIL, "value": "ada@x.io"})
    assert first is again and again.value == "ada@x.io" and len(rec.steps) == 1
    choice = rec.on_page_event(
        {"kind": "select", "target": {"tag": "select", "label": "Lang"}, "value": "fr"}
    )
    assert choice is not None and choice.kind == "select" and len(rec.steps) == 2


def test_a_secret_value_is_never_kept() -> None:
    rec = Recorder()
    step = rec.on_page_event({"kind": "fill", "target": PASSWORD, "value": "hunter2"})
    assert step is not None and step.value == "" and step.secret_env == "E2E_PASSWORD"
    assert "hunter2" not in str(step.to_dict())
    token = "ghp_" + "b" * 36
    shaped = rec.on_page_event({"kind": "fill", "target": EMAIL, "value": token})
    assert (
        shaped is not None and shaped.value == "" and shaped.secret_env == "E2E_EMAIL"
    )
    plain = rec.on_page_event({"kind": "fill", "target": EMAIL, "value": "ada"})
    assert plain is shaped and plain.value == "ada" and plain.secret_env == ""


def test_keys_and_assertions() -> None:
    rec = Recorder()
    enter = rec.on_page_event({"kind": "press", "target": EMAIL, "key": "Enter"})
    assert enter is not None and enter.key == "Enter"
    assert rec.on_page_event({"kind": "press", "target": EMAIL, "key": "a"}) is None
    seen = rec.on_page_event({"kind": "assert_text", "target": SAVE, "text": " Saved "})
    assert seen is not None and seen.text == "Saved"
    assert (
        rec.on_page_event({"kind": "assert_text", "target": SAVE, "text": ""}) is None
    )
    key = "token=" + "c" * 20
    assert (
        rec.on_page_event({"kind": "assert_text", "target": SAVE, "text": key}) is None
    )


def test_reports_that_are_not_steps_are_dropped() -> None:
    rec = Recorder()
    for payload in (
        "click",
        {"kind": "eval", "target": SAVE},
        {"kind": "click", "target": "button"},
        {"kind": "click", "target": {"tag": "div"}},
    ):
        assert rec.on_page_event(payload) is None
    assert rec.steps == []


def test_the_recording_stops_growing_at_its_cap() -> None:
    rec = Recorder()
    for _ in range(MAX_STEPS):
        rec.on_page_event({"kind": "click", "target": SAVE})
    assert rec.on_page_event({"kind": "click", "target": SAVE}) is None
    assert len(rec.steps) == MAX_STEPS and rec.recording.truncated is True


def test_a_url_with_a_key_loses_its_query() -> None:
    assert safe_url("https://a.test/cb?token=" + "d" * 20 + "#x") == "https://a.test/cb"
    assert safe_url("https://a.test/search?q=shoes") == "https://a.test/search?q=shoes"
    assert safe_url(None) == ""


# --- the session, on a stand-in page ----------------------------------------------


class Frame:
    def __init__(self, url: str = "") -> None:
        self.url = url


class Page:
    def __init__(self) -> None:
        self.main_frame = Frame()
        self.handlers: dict[str, object] = {}
        self.binding = None
        self.script = ""
        self.visited: list[tuple[str, str]] = []

    async def expose_binding(self, name, callback) -> None:
        assert name == BINDING
        self.binding = callback

    async def add_init_script(self, script: str) -> None:
        self.script = script

    def on(self, event: str, handler) -> None:
        self.handlers[event] = handler

    async def goto(self, url: str, wait_until: str, timeout: int) -> None:
        self.visited.append((url, wait_until))
        self.main_frame.url = url + "/"
        self.handlers["framenavigated"](self.main_frame)


async def test_a_session_records_main_frame_reports_until_stopped() -> None:
    page = Page()
    stop = asyncio.get_running_loop().create_future()
    emitted = []

    async def drive() -> None:
        await asyncio.sleep(0)
        page.binding({"frame": page.main_frame}, {"kind": "click", "target": SAVE})
        page.binding({"frame": Frame()}, {"kind": "click", "target": SAVE})
        page.handlers["framenavigated"](Frame("https://ads.test/"))
        stop.set_result(None)

    driver = asyncio.ensure_future(drive())
    recording, reason = await record_session(
        page, "http://localhost:5173", stop, emitted.append
    )
    await driver
    assert reason == "stopped"
    assert page.visited == [("http://localhost:5173", "domcontentloaded")]
    assert page.script == SCRIPT.read_text(encoding="utf-8")
    assert [s.kind for s in recording.steps] == ["navigate", "click"]
    assert emitted == recording.steps


async def test_a_session_ends_when_the_window_closes() -> None:
    page = Page()

    async def close() -> None:
        await asyncio.sleep(0)
        page.handlers["close"](page)

    closer = asyncio.ensure_future(close())
    never = asyncio.get_running_loop().create_future()
    recording, reason = await record_session(
        page, "http://localhost:5173", never, lambda _s: None, Recorder()
    )
    await closer
    assert reason == "closed" and len(recording.steps) == 1
    assert never.cancelled()


def test_the_page_script_ships_with_the_package() -> None:
    text = recorder_module.SCRIPT.read_text(encoding="utf-8")
    assert BINDING in text and "secret: true" in text
