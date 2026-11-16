"""The one directory under the system temp root a build may write to.

Its own module so that the write guard (``path_guard``) and the sandbox
(``sandbox``), which both exempt it, share it without importing each other.
"""

from __future__ import annotations

import tempfile
from pathlib import Path


def workpilot_scratch_dir() -> Path:
    """The one directory under the system temp root a build may write to.

    Kept narrow deliberately: `tempfile.gettempdir()` is shared with every
    process on the machine, and naming it as a root would also re-open a
    worktree that happens to sit under it.
    """
    return Path(tempfile.gettempdir()) / "workpilot"


__all__ = ["workpilot_scratch_dir"]
