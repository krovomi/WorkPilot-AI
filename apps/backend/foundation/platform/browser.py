"""The Chromium binary a headless browser runs on, found the same way everywhere.

The verification drives it (``verify.devtools``), Import Design renders with
it, and a replay is recorded as a video in it (``replay.video``). The search
lives here, below all of them, so that a unit the agents import (the replay)
can find the browser without importing the verification, which imports
``core``.
"""

from __future__ import annotations

import glob
import os
import shutil
from pathlib import Path

__all__ = ["chrome_executable"]

_LAYOUTS = (
    "chromium-*/chrome-linux/chrome",
    "chromium-*/chrome-linux64/chrome",
    "chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chromium-*/chrome-win/chrome.exe",
)
_NAMES = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser")


def chrome_executable(explicit: str = "") -> str:
    """A Chromium/Chrome binary to drive, or "" to let the tool find its own."""
    for candidate in (explicit, os.environ.get("CHROME_PATH", "")):
        if candidate and Path(candidate).is_file():
            return candidate
    roots = [
        os.environ.get("PLAYWRIGHT_BROWSERS_PATH", ""),
        "/opt/pw-browsers",
        str(Path.home() / ".cache" / "ms-playwright"),
    ]
    for root in roots:
        if not root:
            continue
        for layout in _LAYOUTS:
            found = sorted(glob.glob(os.path.join(root, layout)), reverse=True)
            if found:
                return found[0]
    for name in _NAMES:
        path = shutil.which(name)
        if path:
            return path
    return ""
