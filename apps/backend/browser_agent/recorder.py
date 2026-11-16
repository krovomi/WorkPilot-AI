"""
Recording what a person does on a page the Browser Agent opened.

The browser is the existing one (``BrowserController``), launched with a
window. ``recorder_script.js`` runs in the page and reports each click, typed
value, choice in a list, Enter or Escape, and each Alt+click (an assertion on
the element's visible text) through a binding. :class:`Recorder` turns those
reports into typed, bounded steps:

- a report is page data, never trusted: anything outside the closed lists of
  ``recording.py`` is dropped, every string is cut to its bound;
- only the main frame is recorded (an iframe is a later lot);
- successive values typed into one field make one step, updated in place;
- a navigation is a step only when no action just caused it (a link, a
  submitted form), so replaying the actions replays the navigation;
- at :data:`~browser_agent.recording.MAX_STEPS` the recording stops growing
  and says it was truncated;
- a secret is never kept (``selector_builder.is_secret_field``), and a URL
  with a key in its query string is kept without its query.

:func:`record_session` wires a recorder to a launched page and waits for the
person to stop it or close the window. No model is called anywhere.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from foundation.log_redaction import redact_text

from .recording import (
    KEYS,
    MAX_STEPS,
    MAX_URL,
    RecordedStep,
    Recording,
    clean_line,
    clean_value,
    is_web_url,
)
from .selector_builder import build_selectors, is_secret_field, secret_env_name

#: A navigation this soon after an action is that action's doing.
NAVIGATION_WINDOW_S = 2.5
BINDING = "__workpilotRecord"
SCRIPT = Path(__file__).with_name("recorder_script.js")

_ACTIONS = ("click", "fill", "select", "press")


def safe_url(raw: object) -> str:
    """A web URL to navigate to, without a query that carries a secret."""
    url = clean_line(raw, MAX_URL)
    if not is_web_url(url):
        return ""
    if redact_text(url) != url:
        url = url.split("?", 1)[0].split("#", 1)[0]
    return url


class Recorder:
    """The steps of one session, built from the page's reports."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.recording = Recording()
        self._clock = clock
        self._next = 1
        self._url = ""
        self._initial = False
        self._last_action_at = float("-inf")

    @property
    def steps(self) -> list[RecordedStep]:
        return self.recording.steps

    def _add(self, step: RecordedStep) -> RecordedStep | None:
        if len(self.steps) >= MAX_STEPS:
            self.recording.truncated = True
            return None
        self.steps.append(step)
        return step

    def _new(self, kind: str) -> RecordedStep:
        step = RecordedStep(id=f"s{self._next}", kind=kind)
        self._next += 1
        return step

    def start(self, url: str) -> RecordedStep | None:
        """The first step: open the page the recording starts on."""
        step = self._new("navigate")
        step.url = safe_url(url)
        if not step.url:
            return None
        self._initial = True
        return self._add(step)

    def on_navigation(self, url: str) -> RecordedStep | None:
        """The main frame now shows ``url``: a step when nothing caused it."""
        url = safe_url(url)
        if not url or url == self._url:
            return None
        self._url = url
        if self._initial:
            # The page `start` asked for, as the browser spells it.
            self._initial = False
            return None
        if self._clock() - self._last_action_at <= NAVIGATION_WINDOW_S:
            return None
        step = self._new("navigate")
        step.url = url
        return self._add(step)

    def on_page_event(self, payload: object) -> RecordedStep | None:
        """A report from the page: the step it adds or updates, or None."""
        if not isinstance(payload, dict):
            return None
        kind = payload.get("kind")
        target = payload.get("target")
        if kind not in (*_ACTIONS, "assert_text") or not isinstance(target, dict):
            return None
        selectors = build_selectors(target)
        if not selectors:
            return None
        if kind in _ACTIONS:
            self._last_action_at = self._clock()

        if kind in ("fill", "select"):
            value = "" if target.get("secret") is True else payload.get("value")
            value = clean_value(value)
            secret = is_secret_field(target, value)
            last = self.steps[-1] if self.steps else None
            if last and last.kind == kind and last.selectors == selectors:
                step = last
            else:
                step = self._new(kind)
                step.selectors = selectors
            step.secret_env = secret_env_name(target) if secret else ""
            step.value = "" if secret else value
            return step if step is last else self._add(step)

        step = self._new(kind)
        step.selectors = selectors
        if kind == "press":
            if payload.get("key") not in KEYS:
                return None
            step.key = str(payload.get("key"))
        elif kind == "assert_text":
            step.text = clean_line(payload.get("text"))
            # Nothing to assert, or page text holding a key: not recorded.
            if not step.text or redact_text(step.text) != step.text:
                return None
        return self._add(step)


Emit = Callable[[RecordedStep], None]


async def record_session(
    page: Any,
    url: str,
    stop: Awaitable[object],
    emit: Emit,
    recorder: Recorder | None = None,
) -> tuple[Recording, str]:
    """Record on ``page`` from ``url`` until ``stop`` resolves or the page closes.

    Returns the recording and why it ended: ``stopped`` or ``closed``.
    """
    recorder = recorder or Recorder()

    def report(step: RecordedStep | None) -> None:
        if step is not None:
            emit(step)

    def on_binding(source: dict[str, Any], payload: object) -> None:
        # Only the main frame: a frame of another origin is not recorded.
        if source.get("frame") is page.main_frame:
            report(recorder.on_page_event(payload))

    def on_frame(frame: Any) -> None:
        if frame is page.main_frame:
            report(recorder.on_navigation(frame.url))

    closed = asyncio.Event()
    await page.expose_binding(BINDING, on_binding)
    await page.add_init_script(script=SCRIPT.read_text(encoding="utf-8"))
    page.on("framenavigated", on_frame)
    page.on("close", lambda *_: closed.set())

    report(recorder.start(url))
    await page.goto(url, wait_until="domcontentloaded", timeout=30000)

    stop_task = asyncio.ensure_future(stop)
    closed_task = asyncio.ensure_future(closed.wait())
    done, pending = await asyncio.wait(
        {stop_task, closed_task}, return_when=asyncio.FIRST_COMPLETED
    )
    for task in pending:
        task.cancel()
    return recorder.recording, "closed" if closed_task in done else "stopped"
