"""
Robust selectors for a recorded element, the most stable first.

The page describes the element it saw (``recorder_script.js``): its
``data-testid``, its ARIA role and accessible name, its label, placeholder and
text, its id and ``name`` attribute (and whether each is unique on the page),
and a short CSS path as a last resort. This module ranks them the way the
Playwright and Testing Library guides do:

1. ``data-testid`` (or another test attribute: ``data-test``, ``data-cy``,
   ``data-qa``) when it is unique;
2. the ARIA role with its accessible name;
3. the label of a form field;
4. its placeholder;
5. its visible text (not for a form field, whose text is what was typed);
6. a short CSS selector: a stable unique id, a unique ``name``, or the path.

An id that looks generated (``btn-a1b2c3``, ``:r1:``, ``ember123``) is never
used: it changes with the next build. Each candidate is page text, kept as a
bounded string; it becomes code only through ``codegen.py``, as a literal.

The same descriptor says whether the field holds a secret: a password field,
a field whose name, id, label or autocomplete names a secret, or a value shaped
like a key or a token (``foundation.log_redaction``). Its value is then never
kept, and the step names an environment variable instead (``secret_env_name``).
"""

from __future__ import annotations

import re

from foundation.log_redaction import redact_text

from .recording import (
    MAX_SELECTOR_VALUE,
    MAX_SELECTORS,
    ROLES,
    Selector,
    clean_line,
)

#: Form fields: their "text" is their value, never a selector.
_FIELDS = frozenset({"input", "textarea", "select"})
_TEST_ATTRS = ("data-test", "data-cy", "data-qa")
_MAX_NAME = 120
_MAX_TEXT_SELECTOR = 80

_PLAIN_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")
# Build-time ids: a digit run, a hash, React's `:r1:`, a dashed suffix with a digit.
_GENERATED_ID = re.compile(
    r"\d{3,}|[0-9a-f]{8,}|^:|[-_](?=[a-z0-9]*\d)[a-z0-9]{2,}$", re.IGNORECASE
)
_SECRET_WORDS = re.compile(
    r"(?:^|[^a-z])(?:pass(?:word|wd|phrase|code)?|pwd|secret|token|api[-_ ]?key"
    r"|otp|cvc|cvv|pin|mot[-_ ]de[-_ ]passe)(?:[^a-z]|$)"
    r"|password|passwd",
    re.IGNORECASE,
)
_SECRET_AUTOCOMPLETE = re.compile(
    r"current-password|new-password|one-time-code|cc-number|cc-csc", re.IGNORECASE
)


def _css_string(value: str) -> str:
    """``value`` inside a double-quoted CSS attribute value."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def looks_generated(element_id: str) -> bool:
    """Whether an id looks made by a build or a framework, not by a person."""
    return not _PLAIN_ID.match(element_id) or bool(_GENERATED_ID.search(element_id))


def build_selectors(target: dict[str, object]) -> list[Selector]:
    """The element's selectors, most robust first; empty when none holds."""
    tag = clean_line(target.get("tag"), 20).lower()
    found: list[Selector] = []

    def add(strategy: str, value: str, role: str = "") -> None:
        if value and len(value) <= MAX_SELECTOR_VALUE:
            candidate = Selector(strategy, value, role)
            if candidate not in found:
                found.append(candidate)

    test_id = clean_line(target.get("testId"), MAX_SELECTOR_VALUE)
    if test_id and target.get("testIdUnique") is True:
        add("testid", test_id)
    attr = target.get("testAttr")
    if isinstance(attr, dict) and attr.get("unique") is True:
        name = attr.get("name")
        value = clean_line(attr.get("value"), MAX_SELECTOR_VALUE)
        if name in _TEST_ATTRS and value:
            add("css", f'[{name}="{_css_string(value)}"]')

    role = clean_line(target.get("role"), 20)
    accessible_name = clean_line(target.get("name"), _MAX_NAME)
    if role in ROLES and accessible_name:
        add("role", accessible_name, role)
    add("label", clean_line(target.get("label"), _MAX_NAME))
    add("placeholder", clean_line(target.get("placeholder"), _MAX_NAME))
    if tag not in _FIELDS:
        text = clean_line(target.get("text"), _MAX_TEXT_SELECTOR + 1)
        if len(text) <= _MAX_TEXT_SELECTOR:
            add("text", text)

    element_id = clean_line(target.get("id"), 100)
    if (
        element_id
        and target.get("idUnique") is True
        and not looks_generated(element_id)
    ):
        add("css", f"#{element_id}")
    field_name = clean_line(target.get("nameAttr"), 100)
    if field_name and target.get("nameUnique") is True and re.match(r"^[a-z]+$", tag):
        add("css", f'{tag}[name="{_css_string(field_name)}"]')
    add("css", clean_line(target.get("path"), MAX_SELECTOR_VALUE + 1))
    return found[:MAX_SELECTORS]


def is_secret_field(target: dict[str, object], value: str = "") -> bool:
    """Whether what is typed into this field must never be recorded."""
    if target.get("secret") is True:
        return True
    if clean_line(target.get("type"), 20).lower() == "password":
        return True
    if _SECRET_AUTOCOMPLETE.search(clean_line(target.get("autocomplete"), 100)):
        return True
    for key in ("nameAttr", "id", "label", "placeholder", "testId", "name"):
        if _SECRET_WORDS.search(clean_line(target.get(key), _MAX_NAME)):
            return True
    return bool(value) and redact_text(value) != value


def secret_env_name(target: dict[str, object]) -> str:
    """The environment variable a generated test reads this field's value from."""
    for key in ("nameAttr", "id", "label", "placeholder"):
        words = re.sub(r"[^A-Z0-9]+", "_", clean_line(target.get(key), 60).upper())
        words = words.strip("_")
        if words and not words[0].isdigit():
            return f"E2E_{words}"[:64].rstrip("_")
    return "E2E_SECRET"
