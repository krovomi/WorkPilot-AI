"""A Windows path, typed into an application that runs under WSL.

WorkPilot launched from WSL is a Linux process: its home directory is
``/home/<user>``, and an Obsidian vault kept by the Windows Obsidian app lives
at ``C:\\Users\\<name>\\…`` — which that process reaches as
``/mnt/c/Users/<name>/…``. Two things went wrong with the brain folder there:

- ``C:\\Users\\…`` is not an absolute path on Linux, so ``os.path.abspath``
  glued it to the working directory and the check answered for a folder that
  does not exist;
- ``/mnt/c/Users/<name>/…`` is absolute, and outside ``/home/<user>``, so the
  "stays under the home directory" rule refused the one folder the person
  actually meant.

This module answers both, and only under WSL: a Windows spelling is converted
to the path this process can open (the same answer ``wslpath -u`` gives, from
``/etc/wsl.conf``'s automount root, without a subprocess), and the Windows
user profile counts as a home directory — it *is* the same person's home, on
the same machine. Nothing else under ``/mnt`` does: the rule exists so that a
page open in a browser cannot have the backend create a git repository
wherever it names, and ``/mnt/c/Windows`` is exactly such a place.
"""

from __future__ import annotations

import configparser
import functools
import os
import re
import subprocess
import sys

__all__ = [
    "is_wsl",
    "automount_root",
    "to_wsl_path",
    "windows_home",
    "home_roots",
]

_DRIVE = re.compile(r"^(?P<drive>[A-Za-z]):(?:[\\/](?P<rest>.*))?$")
_UNC = re.compile(
    r"^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/](?P<distro>[^\\/]+)(?:[\\/](?P<rest>.*))?$",
    re.I,
)


@functools.lru_cache(maxsize=1)
def is_wsl() -> bool:
    """Whether this process is a Linux one running under WSL (1 or 2)."""
    if not sys.platform.startswith("linux"):
        return False
    if os.environ.get("WSL_DISTRO_NAME") or os.environ.get("WSL_INTEROP"):
        return True
    for probe in ("/proc/sys/kernel/osrelease", "/proc/version"):
        try:
            with open(probe, encoding="utf-8", errors="replace") as handle:
                if "microsoft" in handle.read().lower():
                    return True
        except OSError:
            continue
    return False


@functools.lru_cache(maxsize=1)
def automount_root() -> str:
    """Where Windows drives are mounted: ``[automount] root``, else ``/mnt/``."""
    parser = configparser.ConfigParser(interpolation=None, strict=False)
    try:
        parser.read("/etc/wsl.conf", encoding="utf-8")
        root = parser.get("automount", "root", fallback="").strip().strip("\"'")
    except (configparser.Error, OSError, UnicodeDecodeError):
        root = ""
    root = root or "/mnt/"
    return root if root.endswith("/") else root + "/"


def to_wsl_path(raw: str) -> str:
    """*raw* as this process can open it; unchanged when it is not Windows-shaped.

    ``C:\\Users\\x`` and ``C:/Users/x`` become ``<root>c/Users/x``;
    ``\\\\wsl$\\<distro>\\home\\x`` and ``\\\\wsl.localhost\\…`` become
    ``/home/x`` when *distro* is this one — another distribution's files are
    not reachable at that path, and guessing would point somewhere else.
    Outside WSL nothing is converted: on Windows the spelling is native, and
    on Linux or macOS a backslash is an ordinary character in a name.
    """
    text = raw.strip()
    if not text or not is_wsl():
        return raw
    match = _DRIVE.match(text)
    if match:
        rest = (match.group("rest") or "").replace("\\", "/").strip("/")
        base = automount_root() + match.group("drive").lower()
        return f"{base}/{rest}" if rest else base
    match = _UNC.match(text)
    if match:
        current = os.environ.get("WSL_DISTRO_NAME", "")
        if current and match.group("distro").casefold() != current.casefold():
            return raw
        rest = (match.group("rest") or "").replace("\\", "/").strip("/")
        return "/" + rest
    return raw


def _profile_from_windows() -> str:
    """``%USERPROFILE%`` as Windows spells it, or ``""``.

    ``USERPROFILE`` reaches a WSL process only when ``WSLENV`` shares it, so
    Windows is asked through interop — from a drive directory, because
    ``cmd.exe`` started in a ``\\\\wsl$`` working directory prints a warning
    before anything else. Interop can be switched off; that is an answer too.
    """
    shared = os.environ.get("USERPROFILE", "").strip()
    if _DRIVE.match(shared):
        return shared
    try:
        done = subprocess.run(
            ["cmd.exe", "/d", "/c", "echo", "%USERPROFILE%"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=automount_root() + "c",
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    lines = [line.strip() for line in (done.stdout or "").splitlines()]
    value = next((line for line in lines if _DRIVE.match(line)), "")
    return value


@functools.lru_cache(maxsize=1)
def windows_home() -> str | None:
    """The Windows user profile as a WSL path, when there is one to find."""
    if not is_wsl():
        return None
    profile = _profile_from_windows()
    if not profile:
        return None
    path = os.path.normpath(to_wsl_path(profile))
    return path if os.path.isdir(path) else None


def home_roots() -> list[str]:
    """Every folder that counts as "the home directory" for this process.

    The Linux home always; under WSL, the Windows profile too.
    """
    roots = [os.path.normpath(os.path.abspath(os.path.expanduser("~")))]
    extra = windows_home()
    if extra and extra not in roots:
        roots.append(extra)
    return roots
