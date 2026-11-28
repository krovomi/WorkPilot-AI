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

**What an agent recalls** (`recalled`, the one filter the recall paths share:
`ProjectMemory.search`, the ``workpilot-brain`` tools, ``mem_search``, and the
learning loop's patterns through `PatternStorage.recall_patterns`):

| Scope | Recalled for |
|---|---|
| none, or a module | every build |
| ``branch:<name>`` | a build whose git branch is that one, or under it at a ``/`` (`covers`); never when the branch is unknown |
| ``team:<name>`` | locally, every build; on a server, a run started by a member of the group of that name |

A person's reading surfaces (the Memories tab, the lifecycle tab, its
history) show every note with its scope: only recall is filtered. The filter
is about relevance, not secrecy: a run can read its project's brain on disk.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

__all__ = [
    "BRANCH_ENV",
    "MAX_SCOPE",
    "PREFIXES",
    "TEAMS_ENV",
    "Audience",
    "audience",
    "branch_of",
    "covers",
    "key",
    "kind",
    "normalise",
    "recalled",
    "teams_from",
]

BRANCH_ENV = "WORKPILOT_BRAIN_BRANCH"
"""The branch of the build a ``workpilot-brain`` server was started for
(`runtime.mcp_server_config`); empty when it could not be read. Absent, the
server reads the branch of the folder it runs in."""

TEAMS_ENV = "WORKPILOT_RECALL_TEAMS"
"""On a server, the groups of the person who started the run, as a JSON list
of names (``server.services.run_manager``); ``[]`` for none. Absent means a
desktop or CLI build, where ``team:`` notes are recalled for everyone."""

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


@dataclass(frozen=True)
class Audience:
    """Who an agent recalls for: the build's branch and, on a server, the
    groups of the person who started the run.

    ``branch`` is ``None`` when it is unknown (no repository, a detached
    HEAD); ``teams`` is ``None`` outside server mode.
    """

    branch: str | None = None
    teams: frozenset[str] | None = None


def recalled(applies_to: object, audience: Audience) -> bool:
    """Whether an agent recalling for *audience* gets a note scoped to *applies_to*."""
    scope = key(str(applies_to or ""))
    found = kind(scope)
    if found == "branch":
        return audience.branch is not None and covers(
            scope, f"branch:{audience.branch}"
        )
    if found == "team":
        return audience.teams is None or scope in audience.teams
    return True


def teams_from(environ: Mapping[str, str]) -> frozenset[str] | None:
    """The run's teams as scope keys (``team:<name>``), from `TEAMS_ENV`.

    ``None`` when the variable is absent (not a server run). A value that is
    not a JSON list of names counts as no team: a server run never falls back
    to recalling every team's notes.
    """
    raw = environ.get(TEAMS_ENV)
    if raw is None:
        return None
    try:
        names = json.loads(raw)
    except ValueError:
        return frozenset()
    if not isinstance(names, list):
        return frozenset()
    return frozenset(
        key(f"team:{name}") for name in names if isinstance(name, str) and name.strip()
    )


def branch_of(directory: Path | str | None) -> str | None:
    """The git branch checked out in *directory*, or ``None`` when there is
    none to read (not a repository, a detached HEAD, git missing)."""
    if directory is None or not Path(directory).is_dir():
        return None
    from foundation.git_executable import run_git

    result = run_git(
        ["symbolic-ref", "--quiet", "--short", "HEAD"], cwd=directory, timeout=10
    )
    name = result.stdout.strip() if result.returncode == 0 else ""
    return name if name and _valid_branch(name) else None


def audience(
    directory: Path | str | None, *, environ: Mapping[str, str] | None = None
) -> Audience:
    """The audience of a build working in *directory* (its worktree).

    Its branch is the one WorkPilot named for this process (`BRANCH_ENV`, a
    ``workpilot-brain`` server), else the one checked out in *directory*.
    """
    env = os.environ if environ is None else environ
    if BRANCH_ENV in env:
        named = env[BRANCH_ENV].strip()
        branch = named if named and _valid_branch(named) else None
    else:
        branch = branch_of(directory)
    return Audience(branch=branch, teams=teams_from(env))
