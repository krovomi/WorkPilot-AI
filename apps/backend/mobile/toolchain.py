"""Finding the mobile toolchains, without hard-coding anyone's install path.

`foundation.platform.find_executable` already searches PATH and the usual per-OS
locations. What it does not know is that the Android tools are not on PATH on a
default install — they live under the SDK root, which is named by `ANDROID_HOME`
or `ANDROID_SDK_ROOT` and otherwise sits in a different place on each OS. This
module adds exactly that, and nothing else.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from foundation.platform import find_executable, is_macos, is_windows

__all__ = ["android_sdk_root", "find_tool", "clear_cache"]

# Where the SDK lands when nobody said. Android Studio's defaults, per OS.
_SDK_DEFAULTS = {
    "windows": ("~/AppData/Local/Android/Sdk",),
    "macos": ("~/Library/Android/sdk",),
    "linux": ("~/Android/Sdk", "~/android-sdk", "/usr/lib/android-sdk"),
}

# Subdirectories of the SDK root that hold executables, most useful first.
_SDK_BIN_DIRS = ("platform-tools", "emulator", "cmdline-tools/latest/bin", "tools/bin")


def _current_os() -> str:
    """The key of `_SDK_DEFAULTS` for this machine.

    Not `str(get_current_os())`: that is the enum's name (``"OS.LINUX"``), which
    matched no key, so the SDK's default install folders were never searched
    and an SDK installed by Android Studio without ``ANDROID_HOME`` went unseen.
    """
    if is_windows():
        return "windows"
    if is_macos():
        return "macos"
    return "linux"


@lru_cache(maxsize=1)
def android_sdk_root() -> str:
    """The Android SDK root, or "" when there is none to be found."""
    for var in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        value = os.environ.get(var, "").strip()
        if value and Path(value).is_dir():
            return value
    for candidate in _SDK_DEFAULTS.get(_current_os(), ()):  # pragma: no branch
        path = Path(candidate).expanduser()
        if path.is_dir():
            return str(path)
    return ""


@lru_cache(maxsize=32)
def find_tool(name: str) -> str:
    """Absolute path to a mobile toolchain executable, or "" when absent.

    Cached: a build asks for `adb` once per phase, and the answer does not
    change while the process lives. `clear_cache()` exists for the tests, which
    do change it.
    """
    sdk_paths = []
    root = android_sdk_root()
    if root:
        sdk_paths = [str(Path(root) / sub) for sub in _SDK_BIN_DIRS]

    found = find_executable(name, sdk_paths or None)
    if found:
        return found

    # `find_executable` declined: look under the SDK ourselves, with the
    # suffixes a Windows SDK ships its tools under.
    suffixes = (".exe", ".bat", ".cmd", "") if _current_os() == "windows" else ("",)
    for directory in sdk_paths:
        for suffix in suffixes:
            candidate = Path(directory) / f"{name}{suffix}"
            if candidate.is_file():
                return str(candidate)
    return ""


def clear_cache() -> None:
    """Forget what was found. For tests, and for a settings change mid-session."""
    android_sdk_root.cache_clear()
    find_tool.cache_clear()
