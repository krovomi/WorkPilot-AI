"""Who decided: the person at this machine, as the vault's commits name them.

A team asks "who chose this?" of a consensus (the issue's vote history), and
a maintainer must be told apart from a teammate. The vault is a git
repository whose commits already carry ``user.name`` and ``user.email``; the
journal names a person's decision with that name (``by``), and the e-mail is
only compared with the project's maintainers (`maintainers.py`), never
written.

This is a team rule, not an access control: whoever writes to the vault can
set another name. The journal is there so that it shows.

On a shared server the person is the one signed in, not a git identity: the
server's routes say who acts (`acting_as`), and no git command is run in a
brain that a project's runs write to.
"""

from __future__ import annotations

import subprocess
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

__all__ = ["acting_as", "person"]

_MAX_NAME = 80
_MAX_EMAIL = 120

_ACTING: ContextVar[dict[str, str] | None] = ContextVar("brain_acting", default=None)


@contextmanager
def acting_as(name: str, email: str) -> Iterator[None]:
    """Within the block, the person who decides is *name* / *email*."""
    token = _ACTING.set({"name": name[:_MAX_NAME], "email": email[:_MAX_EMAIL]})
    try:
        yield
    finally:
        _ACTING.reset(token)


def person(root: Path) -> dict[str, str]:
    """``{"name", "email"}`` of the person deciding: the one `acting_as` names,
    else the vault's git identity; empty strings when none."""
    acting = _ACTING.get()
    if acting is not None:
        return dict(acting)
    from ..sync import _git, git_available

    if not git_available():
        return {"name": "", "email": ""}
    try:
        name = _git(root, "config", "user.name").stdout.strip()
        email = _git(root, "config", "user.email").stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return {"name": "", "email": ""}
    return {"name": name[:_MAX_NAME], "email": email[:_MAX_EMAIL]}
