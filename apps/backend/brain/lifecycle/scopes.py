"""Where a memory applies (``applies_to``): a module, a team or a git branch.

The issue's "memory branches": "on ``auth/`` we do it this way, on
``payments/`` the other way". A note's ``applies_to`` is one of

| Form | Example | Means |
|---|---|---|
| a module | ``apps/billing/`` | a part of the code (any text, as before) |
| ``team:<name>`` | ``team:payments`` | the way one team works |
| ``branch:<name>`` | ``branch:release/2.0`` | a git branch, a release line |

Empty means everywhere. Two notes with different scopes never contradict each
other (`contradictions.compare`), and a maintainers' section covers the
scopes it is a prefix of (`maintainers.py`).

The prefix is written in lower case, without a space after the colon, so
``Team: Payments`` and ``team:payments`` are one scope; the detector compares
scopes case-insensitively. A branch name follows git's rules for a ref (no
space, no ``..``, none of ``~^:?*[\\``), which is how a typo like
``branch:main feature`` is caught before it silently scopes nothing.
"""

from __future__ import annotations

import re

__all__ = ["MAX_SCOPE", "PREFIXES", "covers", "key", "kind", "normalise"]

MAX_SCOPE = 200
PREFIXES = ("team", "branch")

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_PREFIXED = re.compile(r"^(team|branch)\s*:\s*(.*)$", re.IGNORECASE)
_BAD_REF = re.compile(r"[\s~^:?*\[\\]|\.\.|@\{|//")


def _valid_branch(name: str) -> bool:
    return not (
        _BAD_REF.search(name)
        or name.startswith(("-", "/", "."))
        or name.endswith(("/", ".", ".lock"))
    )


def normalise(value: str | None) -> str | None:
    """The scope as stored: ``""`` (everywhere), ``team:<name>``,
    ``branch:<name>`` or a module; ``None`` when it is not a scope."""
    text = str(value or "").strip()
    if len(text) > MAX_SCOPE or _CONTROL.search(text):
        return None
    match = _PREFIXED.match(text)
    if not match:
        return text
    prefix, name = match.group(1).lower(), match.group(2).strip()
    if not name or (prefix == "branch" and not _valid_branch(name)):
        return None
    return f"{prefix}:{name}"


def kind(scope: str) -> str:
    """``team``, ``branch``, ``module``, or ``""`` for everywhere."""
    if not scope:
        return ""
    head, sep, _ = scope.partition(":")
    return head if sep and head in PREFIXES else "module"


def key(value: str | None) -> str:
    """What two scopes are compared by: normalised, in lower case.

    A value a hand edit left unreadable as a scope is compared as written,
    so that it still keeps its note apart from the others.
    """
    found = normalise(value)
    return (str(value or "").strip() if found is None else found).lower()


def covers(section: str, scope: str) -> bool:
    """Whether a section written for *section* covers a pair scoped to *scope*.

    The same scope, or a parent of it at a ``/``: ``apps/`` covers
    ``apps/billing/``, ``branch:release/`` covers ``branch:release/2.0``;
    ``team:pay`` does not cover ``team:payments``.
    """
    section, scope = key(section), key(scope)
    if not section or not scope or kind(section) != kind(scope):
        return False
    if scope == section:
        return True
    return scope.startswith(section) and (
        section.endswith("/") or scope[len(section)] == "/"
    )
