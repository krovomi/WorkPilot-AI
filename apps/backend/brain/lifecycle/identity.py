"""Who decided: the person at this machine, as the vault's commits name them.

A team asks "who chose this?" of a consensus (the issue's vote history), and
a maintainer must be told apart from a teammate. The vault is a git
repository whose commits already carry ``user.name`` and ``user.email``; the
journal names a person's decision with that name (``by``), and the e-mail is
only compared with the project's maintainers (`maintainers.py`), never
written.

This is a team rule, not an access control: whoever writes to the vault can
set another name. The journal is there so that it shows.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

__all__ = ["person"]

_MAX_NAME = 80
_MAX_EMAIL = 120


def person(root: Path) -> dict[str, str]:
    """``{"name", "email"}`` of the vault's git identity; empty strings when none."""
    from ..sync import _git, git_available

    if not git_available():
        return {"name": "", "email": ""}
    try:
        name = _git(root, "config", "user.name").stdout.strip()
        email = _git(root, "config", "user.email").stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return {"name": "", "email": ""}
    return {"name": name[:_MAX_NAME], "email": email[:_MAX_EMAIL]}
