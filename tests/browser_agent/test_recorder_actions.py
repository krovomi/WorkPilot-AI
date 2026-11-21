"""Hovers, scrolls, drags, multiple lists and dialogs become bounded steps too."""

from __future__ import annotations

import asyncio

from browser_agent.recorder import DIALOG_WINDOW_S, Recorder, picked, record_session
from browser_agent.recording import (
    MAX_SCROLL,
    MAX_VALUES,
    DialogAnswer,
    RecordedStep,
    Recording,
    Selector,
)

MENU = {"tag": "a", "role": "link", "name": "Products", "text": "Products"}
LIST = {"tag": "div", "id": "list", "idUnique": True, "text": "a b c"}
CARD = {"tag": "div", "testId": "card", "testIdUnique": True}
DONE = {"tag": "div", "id": "done", "idUnique": True}
TAGS = {"tag": "select", "id": "tags", "idUnique": True}
HOST = {"tag": "x-panel", "path": "x-panel"}


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def test_a_hover_is_one_step_until_the_pointer_goes_elsewhere() -> None:
    rec = Recorder()
    first = rec.on_page_event({"kind": "hover", "target": MENU})
    assert first is not None and first.kind == "hover"
    assert first.selectors[0] == Selector("role", "Products", "link")
    assert rec.on_page_event({"kind": "hover", "target": MENU}) is None
    rec.on_page_event({"kind": "click", "target": CARD})
    assert rec.on_page_event({"kind": "hover", "target": MENU}) is not None
    assert [s.kind for s in rec.steps] == ["hover", "click", "hover"]


def test_successive_scrolls_of_one_target_make_one_step() -> None:
    rec = Recorder()
    window = rec.on_page_event({"kind": "scroll", "target": None, "x": 0, "y": 300})
    assert window is not None and window.selectors == []
    again = rec.on_page_event({"kind": "scroll", "target": None, "x": 0, "y": 900})
    assert again is window and window.scroll_y == 900
    box = rec.on_page_event({"kind": "scroll", "target": LIST, "x": 5, "y": 40})
    # A scrolled box is never named by its text: that is all of its list.
    assert box is not None and [s.strategy for s in box.selectors] == ["css"]
    assert len(rec.steps) == 2
    for bad in (
        {"kind": "scroll", "target": None, "x": -1, "y": 0},
        {"kind": "scroll", "target": None, "x": 0, "y": MAX_SCROLL + 1},
        {"kind": "scroll", "target": None, "x": 1.5, "y": 0},
        {
            "kind": "scroll",
            "target": {"tag": "div", "text": "only text"},
            "x": 0,
            "y": 1,
        },
    ):
        assert rec.on_page_event(bad) is None
    # The window of an iframe is not one place to scroll.
    framed = {"kind": "scroll", "target": None, "x": 0, "y": 1}
    assert rec.on_page_event(framed, ["iframe"]) is None
    assert len(rec.steps) == 2


def test_a_drag_names_where_it_dropped_in_the_same_root() -> None:
    rec = Recorder()
    drag = rec.on_page_event(
        {"kind": "drag", "target": CARD, "drop": DONE, "mode": "html5"}
    )
    assert drag is not None and drag.drag_mode == "html5"
    assert drag.drop == [Selector("css", "#done")]
    for bad in (
        {"kind": "drag", "target": CARD, "drop": DONE, "mode": "touch"},
        {"kind": "drag", "target": CARD, "drop": "#done", "mode": "pointer"},
        {"kind": "drag", "target": CARD, "drop": CARD, "mode": "pointer"},
        {"kind": "drag", "target": CARD, "drop": {"tag": "div"}, "mode": "pointer"},
        {
            "kind": "drag",
            "target": CARD,
            "drop": {**DONE, "shadow": [HOST]},
            "mode": "pointer",
        },
    ):
        assert rec.on_page_event(bad) is None
    assert len(rec.steps) == 1


def test_a_multiple_list_keeps_every_option_picked() -> None:
    rec = Recorder()
    step = rec.on_page_event(
        {"kind": "select", "target": TAGS, "value": "red", "values": ["red", "blue"]}
    )
    assert step is not None and step.values == ["red", "blue"]
    assert picked(["one"]) == [] and picked("red") == []
    assert picked(["a"] * (MAX_VALUES + 1)) == []
    assert picked(["a", 2, "b"]) == ["a", "b"]
    secret = {**TAGS, "secret": True}
    hidden = rec.on_page_event(
        {"kind": "select", "target": secret, "values": ["a", "b"]}
    )
    assert hidden is not None and hidden.values == [] and hidden.secret_env


def test_the_answer_to_a_dialog_stays_on_the_action_that_opened_it() -> None:
    clock = Clock()
    rec = Recorder(clock)
    assert rec.on_dialog("confirm", "Sure?", True) is None  # no action yet
    click = rec.on_page_event({"kind": "click", "target": CARD})
    answered = rec.on_dialog("prompt", "New name?", True, "Neo")
    assert answered is click
    assert click.dialog == DialogAnswer("prompt", True, "Neo", "New name?")
    # One dialog per action; a second one is not replayed.
    assert rec.on_dialog("alert", "again", True) is None
    other = rec.on_page_event({"kind": "click", "target": DONE})
    assert rec.on_dialog("evil", "x", True) is None
    # A key in the message or in the text typed is not kept.
    key = "sk-ant-api03-" + "a" * 40  # pragma: allowlist secret
    rec.on_dialog("prompt", key, True, key)
    assert other.dialog == DialogAnswer("prompt", True, "", "")
    late = rec.on_page_event({"kind": "click", "target": MENU})
    clock.now += DIALOG_WINDOW_S + 1
    assert rec.on_dialog("confirm", "late", False) is None and late.dialog is None
    answered = DialogAnswer("prompt", True, "Neo", "Name?")
    assert DialogAnswer.from_dict(answered.to_dict()) == answered
    assert DialogAnswer("confirm", False).to_dict() == {
        "type": "confirm",
        "accept": False,
    }
    # A dismissed prompt keeps no text.
    assert DialogAnswer.from_dict(
        {"type": "prompt", "accept": False, "text": "x"}
    ) == DialogAnswer("prompt", False)


def test_new_kinds_round_trip_and_anything_else_is_dropped() -> None:
    steps = [
        {
            "id": "s1",
            "kind": "hover",
            "selectors": [{"strategy": "css", "value": "#m"}],
        },
        {"id": "s2", "kind": "scroll", "selectors": [], "scrollX": 0, "scrollY": 9},
        {
            "id": "s3",
            "kind": "drag",
            "selectors": [{"strategy": "css", "value": "#a"}],
            "drop": [{"strategy": "css", "value": "#b"}],
            "dragMode": "pointer",
        },
        {
            "id": "s4",
            "kind": "select",
            "selectors": [{"strategy": "css", "value": "#t"}],
            "value": "a",
            "values": ["a", "b"],
        },
        {
            "id": "s5",
            "kind": "click",
            "selectors": [{"strategy": "css", "value": "#go"}],
            "frames": ["#inner"],
            "frameShadow": [["x-panel"]],
            "dialog": {"type": "confirm", "accept": False, "message": "Sure?"},
        },
    ]
    recording = Recording.from_dict({"steps": steps})
    assert [s.to_dict() for s in recording.steps] == steps
    css = [{"strategy": "css", "value": "#a"}]
    bad = [
        {"id": "s1", "kind": "scroll", "selectors": [], "scrollX": 0},
        {"id": "s1", "kind": "scroll", "selectors": [], "scrollX": "0", "scrollY": 0},
        {"id": "s1", "kind": "scroll", "selectors": [], "scrollX": -4, "scrollY": 0},
        {"id": "s1", "kind": "scroll", "frames": ["#f"], "scrollX": 0, "scrollY": 0},
        {"id": "s1", "kind": "hover", "selectors": []},
        {"id": "s1", "kind": "drag", "selectors": css, "dragMode": "html5"},
        {"id": "s1", "kind": "drag", "selectors": css, "drop": css, "dragMode": "x"},
        {"id": "s1", "kind": "click", "selectors": css, "frameShadow": [["x"]]},
        {
            "id": "s1",
            "kind": "click",
            "selectors": css,
            "frames": ["#f"],
            "frameShadow": [[""]],
        },
        {
            "id": "s1",
            "kind": "click",
            "selectors": css,
            "frames": ["#f"],
            "frameShadow": "x",
        },
    ]
    assert all(RecordedStep.from_dict(item) is None for item in bad)
    # A dialog of another kind, or with no answer, is dropped from the step.
    loose = RecordedStep.from_dict(
        {"id": "s1", "kind": "click", "selectors": css, "dialog": {"type": "x"}}
    )
    assert loose is not None and loose.dialog is None
    assert DialogAnswer.from_dict({"type": "alert", "accept": "yes"}) is None
    # Frames with no shadow host above any of them keep no frameShadow.
    plain = RecordedStep.from_dict(
        {
            "id": "s1",
            "kind": "click",
            "selectors": css,
            "frames": ["#f"],
            "frameShadow": [[]],
        }
    )
    assert plain is not None and plain.frame_shadow == []
    one = RecordedStep.from_dict(
        {"id": "s1", "kind": "select", "selectors": css, "values": ["a"], "value": "a"}
    )
    assert one is not None and one.values == []


class Dialog:
    def __init__(self, kind: str, fail: bool = False) -> None:
        self.type = kind
        self.message = "Sure?"
        self.default_value = ""
        self.fail = fail
        self.answers: list[object] = []

    async def accept(self, text: str | None = None) -> None:
        if self.fail:
            from playwright.async_api import Error

            raise Error("Target closed")
        self.answers.append(("accept", text))

    async def dismiss(self) -> None:
        self.answers.append("dismiss")


class Frame:
    url = ""


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


async def test_a_session_asks_the_person_to_answer_each_dialog() -> None:
    page = Page()
    stop = asyncio.get_running_loop().create_future()
    asked: list[dict[str, str]] = []
    answers = iter([(True, "Neo"), (False, ""), None, (True, "")])

    async def ask(dialog: dict[str, str]) -> tuple[bool, str] | None:
        asked.append(dialog)
        return next(answers)

    prompt, confirm, alert, gone = (
        Dialog("prompt"),
        Dialog("confirm"),
        Dialog("unknown"),
        Dialog("alert", fail=True),
    )

    async def drive() -> None:
        await asyncio.sleep(0)
        await page.binding(
            {"frame": page.main_frame}, {"kind": "click", "target": CARD}
        )
        await page.handlers["dialog"](prompt)
        await page.binding(
            {"frame": page.main_frame}, {"kind": "click", "target": DONE}
        )
        await page.handlers["dialog"](confirm)
        await page.handlers["dialog"](alert)
        await page.handlers["dialog"](gone)
        stop.set_result(None)

    driver = asyncio.ensure_future(drive())
    recording, _ = await record_session(
        page, "http://localhost:3000/", stop, lambda _s: None, ask_dialog=ask
    )
    await driver
    assert prompt.answers == [("accept", "Neo")] and confirm.answers == ["dismiss"]
    assert alert.answers == ["dismiss"] and gone.answers == []
    assert asked[2]["type"] == "alert"  # an unknown kind is shown as an alert
    first, second = recording.steps[1:]
    assert first.dialog == DialogAnswer("prompt", True, "Neo", "Sure?")
    assert second.dialog == DialogAnswer("confirm", False, "", "Sure?")


async def test_without_the_app_a_dialog_is_dismissed_and_not_recorded() -> None:
    page = Page()
    stop = asyncio.get_running_loop().create_future()
    dialog = Dialog("confirm")

    async def drive() -> None:
        await asyncio.sleep(0)
        await page.binding(
            {"frame": page.main_frame}, {"kind": "click", "target": CARD}
        )
        await page.handlers["dialog"](dialog)
        stop.set_result(None)

    driver = asyncio.ensure_future(drive())
    recording, _ = await record_session(
        page, "http://localhost:3000/", stop, lambda _s: None
    )
    await driver
    assert dialog.answers == ["dismiss"] and recording.steps[1].dialog is None
