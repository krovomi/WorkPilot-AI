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
``/etc/wsl.conf``'s automount root, without a subprocess), and a folder of a
mounted Windows drive is the person's own (`windows_folder_verdict`).

Not only the profile: a vault kept at ``C:\\Repository\\Perso\\Vault`` is as
much the person's as one under ``C:\\Users\\<name>``, and on Windows that is
where people keep repositories. What stays refused is what the rule exists
for — a page open in a browser having the backend create a git repository
wherever it names: the drive's root, the system folders (``Windows``,
``Program Files``, ``ProgramData``…), and ``Users`` outside a user's own
folder.
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
    "windows_folder_verdict",
    "browse_root",
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
                # one line of kernel text; bounded all the same
                if "microsoft" in handle.read(4096).lower():
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


_SYSTEM_FOLDERS = frozenset(
    name.casefold()
    for name in (
        "Windows",
        "Program Files",
        "Program Files (x86)",
        "ProgramData",
        "$Recycle.Bin",
        "$WinREAgent",
        "$Windows.~BT",
        "$Windows.~WS",
        "System Volume Information",
        "Recovery",
        "Boot",
        "PerfLogs",
        "Config.Msi",
        "MSOCache",
        "Documents and Settings",
    )
)
"""Top-level folders of a drive that belong to Windows, not to the person."""

_SHARED_PROFILES = frozenset(
    name.casefold() for name in ("Default", "Default User", "All Users", "Public")
)
"""Folders of ``Users`` that are nobody's own profile."""

_MOUNTED = re.compile(r"^(?P<drive>[a-z])(?:/(?P<rest>.*))?$", re.I)


def windows_folder_verdict(path: str) -> str | None:
    """Whether *path*, already absolute, is a folder of a Windows drive a person owns.

    ``None`` when *path* is not on a mounted Windows drive (or this is not
    WSL): the caller's own rule applies. Otherwise ``"ok"``, or the reason it
    is refused: ``"drive-root"`` for ``C:\\`` itself, ``"windows-system"`` for
    a system folder or ``Users`` outside one person's own folder (the profile
    itself included, for the reason the Linux home is refused: a brain whose
    notes are every Markdown file a person owns is chosen by nobody).
    """
    if not is_wsl():
        return None
    rest = _under_mount(path)
    if rest is None:
        return None
    match = _MOUNTED.match(rest)
    if not match:
        return None
    parts = [part for part in (match.group("rest") or "").split("/") if part]
    if not parts:
        return "drive-root"
    top = parts[0].casefold()
    if top in _SYSTEM_FOLDERS:
        return "windows-system"
    if top == "users":
        if len(parts) < 3 or parts[1].casefold() in _SHARED_PROFILES:
            return "windows-system"
        # Only the person's own profile, and only when the machine says whose
        # it is: without that answer, ``Users\\<anyone>`` would be accepted.
        profile = windows_home()
        if not profile or not any(
            path.casefold().startswith(own.casefold().rstrip("/") + "/")
            for own in {profile, os.path.realpath(profile)}
        ):
            return "windows-system"
    return "ok"


def _under_mount(path: str) -> str | None:
    """*path* relative to the drive mount root, or ``None`` when it is elsewhere.

    The root is tried as configured and resolved, so a path already passed
    through ``realpath`` is judged by the same rule as the one typed.
    """
    root = automount_root()
    for candidate in dict.fromkeys((root, os.path.realpath(root).rstrip("/") + "/")):
        if path.startswith(candidate):
            return path[len(candidate) :]
    return None


def browse_root() -> str | None:
    """Where a folder picker should open under WSL: the profile, else drive C.

    A GTK dialog started from WSL opens on the Linux home and lists no Windows
    drive, so a vault kept on ``C:`` looks unreachable from it.
    """
    if not is_wsl():
        return None
    profile = windows_home()
    if profile:
        return profile
    drive = automount_root() + "c"
    return drive if os.path.isdir(drive) else None
