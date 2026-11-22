"""
Recording what a person does on a page the Browser Agent opened.

The browser is the existing one (``BrowserController``), launched with a
window. ``recorder_script.js`` runs in the page and reports each click, typed
value, choice in a list, Enter or Escape, and each Alt+click (an assertion on
the element's visible text) through a binding. :class:`Recorder` turns those
reports into typed, bounded steps:

- a report is page data, never trusted: anything outside the closed lists of
  ``recording.py`` is dropped, every string is cut to its bound;
- a report from an iframe carries the chain of ``<iframe>`` elements down to
  it, each described by its parent frame and named by one CSS selector; a
  report from inside open shadow roots carries their hosts the same way;
- successive values typed into one field make one step, updated in place;
- a navigation is a step only when no action just caused it (a link, a
  submitted form), so replaying the actions replays the navigation; when an
  action caused it, the page it led to is that action's ``wait_url``;
- the first same-origin ``fetch`` or XHR an action started within
  :data:`REQUEST_WINDOW_S` is that action's ``wait_request`` (method and path
  only: never the query, never a path that holds a key); an element the page
  inserted after the previous action is waited for (``wait_visible``);
- a loading indicator that showed after an action and then went away is
  what that action's replay waits to see gone (``wait_hidden``), named by a
  selector built here from a closed set of patterns (:func:`loader_css`);
- a status, an alert or a heading that showed up just after an action is a
  proposed check (an ``assert_text`` step whose ``after`` names the action):
  at most :data:`SUGGESTIONS_PER_ACTION` per action, never part of the
  recording until the person keeps it in the desktop app;
- a hover is reported by the page only when it showed something (a menu, a
  tooltip); successive scrolls of one target make one step, updated in
  place; a drag names the element dropped onto, in the same root;
- a dialog the action opened (``alert``, ``confirm``, ``prompt``) is answered
  by the person in the desktop app (:func:`record_session` asks through
  ``ask_dialog``), and that answer is kept on the action, for the replay to
  give it again;
- at :data:`~browser_agent.recording.MAX_STEPS` the recording stops growing
  and says it was truncated;
- a secret is never kept (``selector_builder.is_secret_field``), and a URL
  with a key in its query string is kept without its query.

:func:`record_session` wires a recorder to a launched page and waits for the
person to stop it or close the window. No model is called anywhere.
"""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from foundation.log_redaction import redact_text
from playwright.async_api import Error as BrowserError

from .codegen_text import css_string
from .recording import (
    ACTION_KINDS,
    DIALOG_TYPES,
    DRAG_MODES,
    HTTP_METHODS,
    KEYS,
    MAX_FRAMES,
    MAX_SHADOW,
    MAX_STEPS,
    MAX_TEXT,
    MAX_URL,
    MAX_VALUES,
    DialogAnswer,
    RecordedStep,
    Recording,
    RequestWait,
    clean_line,
    clean_request_path,
    clean_value,
    is_scroll,
    is_web_url,
    loader_selector,
    page_url,
)
from .selector_builder import (
    build_selectors,
    css_selector,
    is_secret_field,
    looks_generated,
    secret_env_name,
)

#: A navigation this soon after an action is that action's doing.
NAVIGATION_WINDOW_S = 2.5
#: A request this soon after an action is that action's doing.
REQUEST_WINDOW_S = 1.0
#: A loading indicator gone this soon after an action was that action's doing.
SETTLE_WINDOW_S = 15.0
#: A check proposed this soon after an action follows that action.
SUGGEST_WINDOW_S = 5.0
#: A dialog this soon after an action was opened by that action.
DIALOG_WINDOW_S = 5.0
SUGGESTIONS_PER_ACTION = 3
MAX_SUGGESTIONS = 100
_LOADER_CLASS = re.compile(r"^[A-Za-z_-][A-Za-z0-9_-]{0,60}$", re.ASCII)
_LOADER_WORD = re.compile(r"spin|load|skeleton|progress", re.IGNORECASE)
#: The parent frame's script describes an ``<iframe>`` element.
DESCRIBE_FRAME = (
    "el => (typeof window.__workpilotDescribe === 'function' "
    "? window.__workpilotDescribe(el) : null)"
)
BINDING = "__workpilotRecord"
SCRIPT = Path(__file__).with_name("recorder_script.js")


def safe_url(raw: object) -> str:
    """A web URL to navigate to, without a query that carries a secret."""
    url = clean_line(raw, MAX_URL)
    if not is_web_url(url):
        return ""
    if redact_text(url) != url:
        url = url.split("?", 1)[0].split("#", 1)[0]
    return url


def loader_css(raw: object) -> str:
    """The CSS a replay waits on for a loading indicator, or ``""``.

    The page only says what the indicator has (a test id, an id, the
    progressbar role, ``aria-busy``, a class); the selector is built here,
    from those patterns only, and never from a CSS path: once the indicator
    is gone, a path would name whatever took its place.
    """
    if not isinstance(raw, dict):
        return ""
    test_id = clean_line(raw.get("testId"), 100)
    if test_id:
        return loader_selector(f'[data-testid="{css_string(test_id)}"]')
    element_id = clean_line(raw.get("id"), 100)
    if element_id and not looks_generated(element_id):
        return loader_selector(f"#{element_id}")
    if raw.get("role") == "progressbar":
        return '[role="progressbar"]'
    if raw.get("busy") is True:
        return '[aria-busy="true"]'
    for name in clean_line(raw.get("className"), 300).split(" "):
        if _LOADER_CLASS.match(name) and _LOADER_WORD.search(name):
            return f".{name}"
    return ""


def picked(raw: object) -> list[str]:
    """The options picked in a multiple-choice list, when more than one."""
    if not isinstance(raw, list) or not 1 < len(raw) <= MAX_VALUES:
        return []
    return [clean_value(v, MAX_TEXT) for v in raw if isinstance(v, str)]


def _origin(url: str) -> tuple[str, str]:
    parts = urlsplit(url)
    return parts.scheme.lower(), parts.netloc.lower()


def shadow_hosts(raw: object) -> list[str] | None:
    """The CSS of each shadow host, outermost first; None when one has none."""
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_SHADOW:
        return None
    hosts = [css_selector(item) for item in raw]
    return hosts if all(hosts) else None


class Recorder:
    """The steps of one session, built from the page's reports."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.recording = Recording()
        self._clock = clock
        self._next = 1
        self._url = ""
        self._initial = False
        self._last_action_at = float("-inf")
        self._last_action: RecordedStep | None = None
        #: Proposed checks, by the action they follow: their texts.
        self._suggested: dict[str, list[str]] = {}
        self.suggestions = 0

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
            # The action led there: its replay waits for this page.
            step, target = self._last_action, page_url(url)
            if step is None or not target or step.wait_url == target:
                return None
            step.wait_url = target
            return step
        step = self._new("navigate")
        step.url = url
        return self._add(step)

    def on_request(
        self, method: object, url: object, page: object
    ) -> RecordedStep | None:
        """A ``fetch`` or XHR left: the action it belongs to, now waiting for it."""
        step = self._last_action
        if step is None or step.wait_request is not None:
            return None
        if self._clock() - self._last_action_at > REQUEST_WINDOW_S:
            return None
        if method not in HTTP_METHODS or not isinstance(url, str):
            return None
        if not isinstance(page, str) or _origin(url) != _origin(page):
            return None  # another site's request (analytics, a CDN)
        path = clean_request_path(urlsplit(url).path)
        if not path or redact_text(path) != path:
            return None
        step.wait_request = RequestWait(str(method), path)
        return step

    def _recent_action(self, window: float) -> RecordedStep | None:
        """The last action, when it happened within ``window`` seconds."""
        if self._clock() - self._last_action_at > window:
            return None
        return self._last_action

    def on_settled(self, payload: object, frames: list[str]) -> RecordedStep | None:
        """A loading indicator went away: the last action waits for that."""
        step = self._recent_action(SETTLE_WINDOW_S)
        if frames or step is None or step.wait_hidden or not isinstance(payload, dict):
            return None
        step.wait_hidden = loader_css(payload.get("loader"))
        return step if step.wait_hidden else None

    def _suggest(self, step: RecordedStep) -> RecordedStep | None:
        """``step`` (a text check) proposed after the last action, or None."""
        action = self._recent_action(SUGGEST_WINDOW_S)
        if action is None or self.suggestions >= MAX_SUGGESTIONS:
            return None
        texts = self._suggested.setdefault(action.id, [])
        if len(texts) >= SUGGESTIONS_PER_ACTION or step.text in texts:
            return None
        texts.append(step.text)
        self.suggestions += 1
        step.after = action.id
        return step

    def on_page_event(
        self,
        payload: object,
        frames: list[str] | None = None,
        frame_shadow: list[list[str]] | None = None,
    ) -> RecordedStep | None:
        """A report from the page (inside ``frames``): the step it adds or updates.

        ``frame_shadow`` names, for each of ``frames``, the open shadow hosts
        its ``<iframe>`` sits in (empty when none does).
        """
        step = self._on_page_event(payload, frames)
        if step is not None and step.frames and any(frame_shadow or []):
            step.frame_shadow = [list(hosts) for hosts in frame_shadow or []]
        return step

    def _on_page_event(
        self, payload: object, frames: list[str] | None
    ) -> RecordedStep | None:
        if not isinstance(payload, dict):
            return None
        kind = payload.get("kind")
        if kind == "settled":
            return self.on_settled(payload, list(frames or []))
        target = payload.get("target")
        if kind not in (*ACTION_KINDS, "assert_text", "suggest"):
            return None
        frames = list(frames or [])
        if kind == "scroll" and target is None and not frames:
            return self._scrolled(payload, [], [])
        if not isinstance(target, dict):
            return None
        selectors = build_selectors(target)
        shadow = shadow_hosts(target.get("shadow"))
        if not selectors or shadow is None or len(frames) > MAX_FRAMES:
            return None
        if kind == "scroll":
            # A scrolled box holds a list: its text is all of it, never a name.
            boxed = [s for s in selectors if s.strategy != "text"]
            return self._scrolled(payload, boxed, shadow, frames) if boxed else None
        if kind == "drag":
            return self._dragged(payload, selectors, shadow, frames)
        appeared = target.get("appeared") is True

        def located(step: RecordedStep) -> RecordedStep:
            step.selectors, step.frames, step.shadow = selectors, frames, shadow
            step.wait_visible = step.wait_visible or appeared
            return step

        if kind == "hover":
            last = self.steps[-1] if self.steps else None
            if last and last.kind == "hover" and last.selectors == selectors:
                return None  # the pointer came back to it: one hover
            return self._acted(self._add(located(self._new(kind))))

        if kind in ("fill", "select"):
            value = "" if target.get("secret") is True else payload.get("value")
            value = clean_value(value)
            secret = is_secret_field(target, value)
            last = self.steps[-1] if self.steps else None
            if (
                last
                and last.kind == kind
                and (last.selectors, last.frames, last.shadow)
                == (selectors, frames, shadow)
            ):
                step = located(last)
            else:
                step = located(self._new(kind))
            step.secret_env = secret_env_name(target) if secret else ""
            step.value = "" if secret else value
            step.values = [] if secret else picked(payload.get("values"))
            return self._acted(step if step is last else self._add(step))

        step = located(self._new(kind))
        if kind == "press":
            if payload.get("key") not in KEYS:
                return None
            step.key = str(payload.get("key"))
            return self._acted(self._add(step))
        if kind in ("assert_text", "suggest"):
            step.kind = "assert_text"
            step.text = clean_line(payload.get("text"))
            # Nothing to assert, or page text holding a key: not recorded.
            if not step.text or redact_text(step.text) != step.text:
                return None
            return self._suggest(step) if kind == "suggest" else self._add(step)
        return self._acted(self._add(step))

    def _scrolled(
        self,
        payload: dict[str, Any],
        selectors: list[Any],
        shadow: list[str],
        frames: list[str] | None = None,
    ) -> RecordedStep | None:
        """A scroll: successive ones of the same target make one step."""
        x, y = payload.get("x"), payload.get("y")
        if not (isinstance(x, int) and isinstance(y, int)):
            return None
        if not (is_scroll(x) and is_scroll(y)):
            return None
        frames = frames or []
        last = self.steps[-1] if self.steps else None
        if (
            last
            and last.kind == "scroll"
            and (
                last.selectors,
                last.frames,
                last.shadow,
            )
            == (selectors, frames, shadow)
        ):
            last.scroll_x, last.scroll_y = x, y
            return self._acted(last)
        step = self._new("scroll")
        step.selectors, step.frames, step.shadow = selectors, frames, shadow
        step.scroll_x, step.scroll_y = x, y
        return self._acted(self._add(step))

    def _dragged(
        self,
        payload: dict[str, Any],
        selectors: list[Any],
        shadow: list[str],
        frames: list[str],
    ) -> RecordedStep | None:
        """A drag onto another element, in the same frame and shadow roots."""
        drop = payload.get("drop")
        mode = payload.get("mode")
        if not isinstance(drop, dict) or mode not in DRAG_MODES:
            return None
        if shadow_hosts(drop.get("shadow")) != shadow:
            return None  # dropped into another root: not one place to replay
        drop_selectors = build_selectors(drop)
        if not drop_selectors or drop_selectors == selectors:
            return None
        step = self._new("drag")
        step.selectors, step.frames, step.shadow = selectors, frames, shadow
        step.drop, step.drag_mode = drop_selectors, str(mode)
        return self._acted(self._add(step))

    def on_dialog(
        self, kind: object, message: object, accept: bool, text: object = ""
    ) -> RecordedStep | None:
        """The person answered a dialog: the action that opened it gives that answer."""
        step = self._recent_action(DIALOG_WINDOW_S)
        if step is None or step.dialog is not None or kind not in DIALOG_TYPES:
            return None
        shown = clean_line(message)
        if redact_text(shown) != shown:
            shown = ""  # a key in the message: not kept
        typed = clean_value(text) if accept and kind == "prompt" else ""
        if typed and redact_text(typed) != typed:
            typed = ""
        step.dialog = DialogAnswer(str(kind), accept, typed, shown)
        return step

    def _acted(self, step: RecordedStep | None) -> RecordedStep | None:
        """An action happened: what follows soon after is its doing."""
        self._last_action_at = self._clock()
        self._last_action = step
        return step


Emit = Callable[[RecordedStep], None]
#: Shows a dialog to the person; resolves with (accept, text), or None.
AskDialog = Callable[[dict[str, str]], Awaitable[tuple[bool, str] | None]]
FramePath = tuple[list[str], list[list[str]]]


async def record_session(
    page: Any,
    url: str,
    stop: Awaitable[object],
    emit: Emit,
    recorder: Recorder | None = None,
    ask_dialog: AskDialog | None = None,
) -> tuple[Recording, str]:
    """Record on ``page`` from ``url`` until ``stop`` resolves or the page closes.

    ``ask_dialog`` shows a dialog the page opened to the person and resolves
    with their answer (accept, text), or None to dismiss it; without it every
    dialog is dismissed and nothing is recorded of it.

    Returns the recording and why it ended: ``stopped`` or ``closed``.
    """
    recorder = recorder or Recorder()
    # Reports are handled one at a time, in the order they came: describing a
    # frame awaits the browser, and a later report must not overtake it.
    lock = asyncio.Lock()
    paths: dict[Any, FramePath | None] = {}

    def report(step: RecordedStep | None) -> None:
        if step is not None:
            emit(step)

    async def frame_path(frame: Any) -> FramePath | None:
        """The CSS of each ``<iframe>`` from the top page down to ``frame``,
        and of the shadow hosts each of them sits in."""
        chain: list[str] = []
        hosts: list[list[str]] = []
        while frame is not page.main_frame:
            parent = frame.parent_frame
            if parent is None or len(chain) == MAX_FRAMES:
                return None
            element = await frame.frame_element()
            described = await element.evaluate(DESCRIBE_FRAME)
            css = css_selector(described)
            above = shadow_hosts(
                described.get("shadow") if isinstance(described, dict) else None
            )
            if not css or above is None:
                return None
            chain.insert(0, css)
            hosts.insert(0, above)
            frame = parent
        return chain, hosts

    async def on_binding(source: dict[str, Any], payload: object) -> None:
        frame = source.get("frame")
        async with lock:
            if frame is page.main_frame:
                report(recorder.on_page_event(payload))
                return
            if frame not in paths:
                try:
                    paths[frame] = await frame_path(frame)
                except BrowserError:
                    paths[frame] = None  # the frame went away meanwhile
            found = paths[frame]
            if found is not None:
                report(recorder.on_page_event(payload, found[0], found[1]))

    async def on_dialog(dialog: Any) -> None:
        """The page opened a dialog: the person answers it in the desktop app."""
        kind, message = dialog.type, dialog.message
        answer = None
        if ask_dialog is not None:
            answer = await ask_dialog(
                {
                    "type": kind if kind in DIALOG_TYPES else "alert",
                    "message": clean_line(message),
                    "defaultValue": clean_line(dialog.default_value),
                }
            )
        try:
            if answer is None:
                await dialog.dismiss()
                return
            accept, text = answer
            if accept:
                await (dialog.accept(text) if kind == "prompt" else dialog.accept())
            else:
                await dialog.dismiss()
        except BrowserError:
            return  # the page went away meanwhile
        async with lock:
            report(recorder.on_dialog(kind, message, accept, text))

    def on_frame(frame: Any) -> None:
        if frame is page.main_frame:
            report(recorder.on_navigation(frame.url))

    def on_request(request: Any) -> None:
        if request.resource_type in ("fetch", "xhr"):
            report(
                recorder.on_request(request.method, request.url, page.main_frame.url)
            )

    closed = asyncio.Event()
    await page.expose_binding(BINDING, on_binding)
    await page.add_init_script(script=SCRIPT.read_text(encoding="utf-8"))
    page.on("framenavigated", on_frame)
    # A listener keeps Playwright from closing the dialog itself.
    page.on("dialog", on_dialog)
    page.on("framedetached", lambda frame: paths.pop(frame, None))
    page.on("request", on_request)
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
