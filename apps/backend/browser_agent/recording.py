"""
A recorded browser session, as typed and bounded data.

A person drives a page the Browser Agent opened; each thing they do becomes a
:class:`RecordedStep` (click, fill, select, key press, navigation, visible-text
assertion) that names its element by a list of :class:`Selector`, the most
robust first. What the page said (texts, labels, URLs, typed values) is
external content: it is kept here as plain strings, cut to a length, and only
ever written into a generated test as an escaped string literal
(``codegen.py``). A value typed into a password field, a field named like a
secret, or a value shaped like a key is never kept: the step carries the name
of the environment variable the generated test reads instead.

A step also says where its element lives and what to wait for, both observed
during the session, never guessed: the chain of ``<iframe>`` elements from the
top page down to the element's frame (``frames``) and the open shadow roots it
sits in (``shadow``), each a CSS selector; and the transition the action
caused (``wait_url``: the page it led to, without query or fragment;
``wait_request``: the method and path of the first same-origin ``fetch`` or
XHR it started; ``wait_visible``: the element itself appeared after the
previous action; ``wait_hidden``: a loading indicator it showed went away,
named by a CSS selector this package builds from a closed set of patterns).
An export turns those into explicit waits, never a pause.

Beyond clicks, typing and lists, a step may hover an element (when that showed
something), scroll the page or an element to a position (``scroll_x``,
``scroll_y``; no selector means the window), drag an element onto another
(``drop``, with how the page listened: ``html5`` drag events or ``pointer``
events), pick several options of a list (``values``), and carry the answer
the person gave, from the desktop app, to the dialog the action opened
(``dialog``: ``alert``, ``confirm``, ``prompt`` or ``beforeunload``, accepted
or dismissed, with the text typed into a prompt). An ``<iframe>`` inside open
shadow roots names those hosts too (``frame_shadow``, one list per frame).

A selector that matches several elements on the page carries the element's
place among them (``nth``, counted by the page in document order); a unique
one never does. A check the recorder proposes after an action (a status, an
alert or a heading that showed up) is an ``assert_text`` step with ``after``
set to that action's id: it is only a suggestion until the person keeps it.

``Recording.from_dict`` is the one way back in from JSON (the desktop app
sends the steps it kept to ``export``): every field is checked against the
closed lists and the bounds below, and anything else is dropped.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

MAX_STEPS = 300
MAX_TEXT = 200
MAX_VALUE = 1000
MAX_URL = 2048
MAX_SELECTORS = 6
MAX_SELECTOR_VALUE = 300
#: Nested iframes, nested shadow roots: deeper than this is not recorded.
MAX_FRAMES = 8
MAX_SHADOW = 8
#: Options picked in one multiple-choice list.
MAX_VALUES = 20
#: A scroll position, in CSS pixels, on either axis.
MAX_SCROLL = 10_000_000
MAX_PATH = 300
#: A selector matching more elements than this is not kept, even with ``nth``.
MAX_MATCHES = 20

STEP_KINDS = (
    "navigate",
    "click",
    "fill",
    "select",
    "press",
    "assert_text",
    "hover",
    "scroll",
    "drag",
)
STRATEGIES = ("testid", "role", "label", "placeholder", "text", "css")
#: Keys whose press is recorded: they submit, close or confirm.
KEYS = ("Enter", "Escape")
#: The HTTP methods a request wait may name.
HTTP_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")
#: The kinds of step that cause a transition (navigation, request, dialog).
ACTION_KINDS = ("click", "fill", "select", "press", "hover", "scroll", "drag")
#: How the page listened to a drag: drag events, or pointer and mouse events.
DRAG_MODES = ("html5", "pointer")
DIALOG_TYPES = ("alert", "confirm", "prompt", "beforeunload")
#: ARIA roles a selector may name; ``getByRole`` takes nothing else.
ROLES = frozenset(
    {
        "button",
        "checkbox",
        "combobox",
        "heading",
        "img",
        "link",
        "listbox",
        "menuitem",
        "option",
        "radio",
        "searchbox",
        "spinbutton",
        "switch",
        "tab",
        "textbox",
    }
)

ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_STEP_ID = re.compile(r"^s[0-9]{1,6}$")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_SPACES = re.compile(r"\s+")
_REQUEST_PATH = re.compile(r"^/[^\s?#]*$")
#: The selectors a loading indicator may be waited for by (``loader_selector``).
_LOADER = re.compile(
    r'^(?:\[data-testid="(?:[^"\\]|\\.)+"\]|#[A-Za-z][A-Za-z0-9_-]*'
    r'|\[role="progressbar"\]|\[aria-busy="true"\]|\.[A-Za-z_-][A-Za-z0-9_-]*)$'
)


def clean_line(raw: object, limit: int = MAX_TEXT) -> str:
    """One line of page text: a string, spaces collapsed, cut to ``limit``."""
    if not isinstance(raw, str):
        return ""
    return _SPACES.sub(" ", _CONTROL.sub("", raw)).strip()[:limit]


def clean_value(raw: object, limit: int = MAX_VALUE) -> str:
    """A typed value: line breaks kept (a textarea), control characters dropped."""
    if not isinstance(raw, str):
        return ""
    return _CONTROL.sub("", raw)[:limit]


@dataclass(frozen=True)
class Selector:
    """One way to find the element: a strategy and what it matches."""

    strategy: str
    value: str
    #: The ARIA role, for the ``role`` strategy (``value`` is then its name).
    role: str = ""
    #: The element's place among those the selector matches, when not unique.
    nth: int | None = None

    def to_dict(self) -> dict[str, object]:
        data: dict[str, object] = {"strategy": self.strategy, "value": self.value}
        if self.role:
            data["role"] = self.role
        if self.nth is not None:
            data["nth"] = self.nth
        return data

    @classmethod
    def from_dict(cls, raw: object) -> Selector | None:
        if not isinstance(raw, dict):
            return None
        strategy = raw.get("strategy")
        value = clean_line(raw.get("value"), MAX_SELECTOR_VALUE)
        if strategy not in STRATEGIES or not value:
            return None
        nth = raw.get("nth")
        if nth is not None and not is_place(nth):
            return None
        role = raw.get("role", "")
        if strategy == "role":
            if role not in ROLES:
                return None
            return cls(strategy, value, role, nth)
        return cls(strategy, value, nth=nth)


def is_place(raw: object) -> bool:
    """A place among the matches of a selector: ``0`` to ``MAX_MATCHES - 1``."""
    return type(raw) is int and 0 <= raw < MAX_MATCHES


def loader_selector(raw: object) -> str:
    """A loading indicator's selector, when it is one ``loader_selector`` builds."""
    css = clean_line(raw, MAX_SELECTOR_VALUE + 1)
    return css if len(css) <= MAX_SELECTOR_VALUE and _LOADER.match(css) else ""


@dataclass(frozen=True)
class RequestWait:
    """A request the action started: what the replay waits to see answered."""

    method: str
    path: str

    def to_dict(self) -> dict[str, str]:
        return {"method": self.method, "path": self.path}

    @classmethod
    def from_dict(cls, raw: object) -> RequestWait | None:
        if not isinstance(raw, dict):
            return None
        method = raw.get("method")
        path = clean_request_path(raw.get("path"))
        if method not in HTTP_METHODS or not path:
            return None
        return cls(str(method), path)


def clean_request_path(raw: object) -> str:
    """A URL path (``/api/x``): no query, no fragment, no space, bounded."""
    path = clean_line(raw, MAX_PATH + 1)
    return path if len(path) <= MAX_PATH and _REQUEST_PATH.match(path) else ""


def page_url(raw: object) -> str:
    """A web URL without its query and fragment: the page an action led to."""
    url = clean_line(raw, MAX_URL).split("#", 1)[0].split("?", 1)[0]
    return url if is_web_url(url) else ""


@dataclass(frozen=True)
class DialogAnswer:
    """What the person answered to the dialog an action opened."""

    type: str
    accept: bool
    #: The text typed into a ``prompt`` (accepted only).
    text: str = ""
    #: The dialog's message, page text: shown in the app, never exported.
    message: str = ""

    def to_dict(self) -> dict[str, object]:
        data: dict[str, object] = {"type": self.type, "accept": self.accept}
        if self.text:
            data["text"] = self.text
        if self.message:
            data["message"] = self.message
        return data

    @classmethod
    def from_dict(cls, raw: object) -> DialogAnswer | None:
        if not isinstance(raw, dict) or raw.get("type") not in DIALOG_TYPES:
            return None
        accept = raw.get("accept")
        if not isinstance(accept, bool):
            return None
        kind = str(raw.get("type"))
        text = clean_value(raw.get("text")) if accept and kind == "prompt" else ""
        return cls(kind, accept, text, clean_line(raw.get("message")))


def is_scroll(raw: object) -> bool:
    """A scroll position: a whole number of pixels, from 0 to :data:`MAX_SCROLL`."""
    return type(raw) is int and 0 <= raw <= MAX_SCROLL


def _selectors(raw: object) -> list[Selector]:
    return [
        s
        for s in (
            Selector.from_dict(item) for item in (raw if isinstance(raw, list) else [])
        )
        if s is not None
    ][:MAX_SELECTORS]


def _frame_shadow(raw: object, frames: int) -> list[list[str]] | None:
    """The shadow hosts above each iframe: one list per frame, or None."""
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) != frames:
        return None
    chains = [_css_chain(item, MAX_SHADOW) for item in raw]
    if any(c is None for c in chains):
        return None
    return [c for c in chains if c is not None] if any(chains) else []


def _css_chain(raw: object, limit: int) -> list[str] | None:
    """A list of CSS selectors (frames, shadow hosts), or None when malformed."""
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > limit:
        return None
    chain = [clean_line(item, MAX_SELECTOR_VALUE + 1) for item in raw]
    if any(not c or len(c) > MAX_SELECTOR_VALUE for c in chain):
        return None
    return chain


@dataclass
class RecordedStep:
    """One thing the person did on the page."""

    id: str
    kind: str
    selectors: list[Selector] = field(default_factory=list)
    url: str = ""
    value: str = ""
    #: Set instead of ``value`` when the typed value is a secret.
    secret_env: str = ""
    key: str = ""
    text: str = ""
    #: CSS selectors of the ``<iframe>`` elements down to the element's frame.
    frames: list[str] = field(default_factory=list)
    #: CSS selectors of the shadow hosts down to the element, in its frame.
    shadow: list[str] = field(default_factory=list)
    #: The element appeared after the previous action: wait until it shows.
    wait_visible: bool = False
    #: The page the action led to (no query, no fragment).
    wait_url: str = ""
    wait_request: RequestWait | None = None
    #: A loading indicator the action showed: wait until none is visible.
    wait_hidden: str = ""
    #: A proposed check: the id of the action it follows (``assert_text`` only).
    after: str = ""
    #: The options picked in a multiple-choice list (``select``).
    values: list[str] = field(default_factory=list)
    #: Where a ``scroll`` step scrolls to; without a selector, the window.
    scroll_x: int = 0
    scroll_y: int = 0
    #: The element a ``drag`` step drops onto, in the same frame and shadow roots.
    drop: list[Selector] = field(default_factory=list)
    drag_mode: str = ""
    dialog: DialogAnswer | None = None
    #: The shadow hosts above each of ``frames``: empty, or one list per frame.
    frame_shadow: list[list[str]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind,
            "selectors": [s.to_dict() for s in self.selectors],
        }
        for name, value in (
            ("url", self.url),
            ("value", self.value),
            ("secretEnv", self.secret_env),
            ("key", self.key),
            ("text", self.text),
            ("frames", self.frames),
            ("shadow", self.shadow),
            ("waitVisible", self.wait_visible),
            ("waitUrl", self.wait_url),
            ("waitHidden", self.wait_hidden),
            ("after", self.after),
            ("values", self.values),
            ("dragMode", self.drag_mode),
            ("frameShadow", self.frame_shadow),
        ):
            if value:
                data[name] = value
        if self.wait_request:
            data["waitRequest"] = self.wait_request.to_dict()
        if self.kind == "scroll":
            data["scrollX"], data["scrollY"] = self.scroll_x, self.scroll_y
        if self.drop:
            data["drop"] = [s.to_dict() for s in self.drop]
        if self.dialog:
            data["dialog"] = self.dialog.to_dict()
        return data

    @classmethod
    def from_dict(cls, raw: object) -> RecordedStep | None:
        """A step read back from JSON, or None when it is not a valid one."""
        if not isinstance(raw, dict):
            return None
        step_id, kind = raw.get("id"), raw.get("kind")
        if not isinstance(step_id, str) or not _STEP_ID.match(step_id):
            return None
        if kind not in STEP_KINDS:
            return None
        selectors = _selectors(raw.get("selectors"))
        step = cls(id=step_id, kind=kind, selectors=selectors)
        if kind == "navigate":
            step.url = clean_line(raw.get("url"), MAX_URL)
            return step if is_web_url(step.url) else None
        frames = _css_chain(raw.get("frames"), MAX_FRAMES)
        shadow = _css_chain(raw.get("shadow"), MAX_SHADOW)
        frame_shadow = _frame_shadow(raw.get("frameShadow"), len(frames or []))
        if frames is None or shadow is None or frame_shadow is None:
            return None
        # Only a scroll of the top window has no element to name.
        if not selectors and (kind != "scroll" or frames or shadow):
            return None
        step.frames, step.shadow, step.frame_shadow = frames, shadow, frame_shadow
        step.wait_visible = raw.get("waitVisible") is True
        if kind in ACTION_KINDS:
            step.wait_url = page_url(raw.get("waitUrl"))
            step.wait_request = RequestWait.from_dict(raw.get("waitRequest"))
            step.wait_hidden = loader_selector(raw.get("waitHidden"))
            step.dialog = DialogAnswer.from_dict(raw.get("dialog"))
        if kind == "scroll":
            x, y = raw.get("scrollX"), raw.get("scrollY")
            if not (isinstance(x, int) and isinstance(y, int)):
                return None
            if not (is_scroll(x) and is_scroll(y)):
                return None
            step.scroll_x, step.scroll_y = x, y
        elif kind == "drag":
            step.drop = _selectors(raw.get("drop"))
            if not step.drop or raw.get("dragMode") not in DRAG_MODES:
                return None
            step.drag_mode = str(raw.get("dragMode"))
        if kind == "select":
            values = raw.get("values")
            if isinstance(values, list) and 1 < len(values) <= MAX_VALUES:
                step.values = [clean_value(v, MAX_TEXT) for v in values]
        if kind in ("fill", "select"):
            secret = raw.get("secretEnv", "")
            if isinstance(secret, str) and ENV_NAME.match(secret):
                step.secret_env = secret
            else:
                step.value = clean_value(raw.get("value"))
        elif kind == "press":
            if raw.get("key") not in KEYS:
                return None
            step.key = str(raw.get("key"))
        elif kind == "assert_text":
            step.text = clean_line(raw.get("text"))
            if not step.text:
                return None
        return step


@dataclass
class Recording:
    """The steps of one session, at most :data:`MAX_STEPS` of them."""

    steps: list[RecordedStep] = field(default_factory=list)
    truncated: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "steps": [s.to_dict() for s in self.steps],
            "truncated": self.truncated,
        }

    @classmethod
    def from_dict(cls, raw: object) -> Recording:
        """The valid steps of ``raw``; an id seen twice keeps its first step."""
        items = raw.get("steps") if isinstance(raw, dict) else None
        steps: list[RecordedStep] = []
        seen: set[str] = set()
        for item in items if isinstance(items, list) else []:
            step = RecordedStep.from_dict(item)
            if step is None or step.id in seen:
                continue
            seen.add(step.id)
            steps.append(step)
        return cls(steps=steps[:MAX_STEPS], truncated=len(steps) > MAX_STEPS)


def is_web_url(url: str) -> bool:
    """An absolute ``http(s)`` URL, the only kind a recording navigates to."""
    return bool(re.match(r"^https?://[^\s/?#]+", url))
