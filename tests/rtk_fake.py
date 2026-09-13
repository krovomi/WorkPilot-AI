"""A stand-in rtk binary, on whichever platform the suite is running.

The rtk tests need a binary that answers `--version` and `rewrite` with a
chosen exit code and a chosen line of stdout. Writing that as a shell script
with a shebang is the obvious thing, and it is wrong on one of the three
platforms this repository supports: Windows has no `#!`, so the fake was found
where it was put, failed to launch, and the integration correctly failed open —
which reads as "rtk did not condense this" and failed an assertion that said it
should have. The product was right and the test was not portable.

So the fake is described here by what it *answers*, never by shell text, and
the script is emitted in the dialect of the platform running the test. The call
sites stop carrying shell code, and the thing that actually matters — an exit
code and one line of stdout — is written once.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

__all__ = ["IDENTITY", "PREFIX", "write_fake_rtk"]

#: Answer `rewrite` with the command prefixed by `rtk`, the way the real binary
#: does for a command it has a filter for.
PREFIX = "<prefix>"

#: Answer `rewrite` with the command unchanged — what rtk prints when the
#: command was already going through it.
IDENTITY = "<identity>"


def write_fake_rtk(
    directory: Path,
    *,
    version: str | None = "rtk 0.48.0",
    rewrite: str | None = PREFIX,
    exit_code: int = 0,
) -> Path:
    """Write an executable fake rtk and return its path.

    `rewrite` is `PREFIX`, `IDENTITY`, a literal line to print, or None to
    print nothing. `exit_code` is what `rewrite` exits with — the four codes
    rtk documents (0, 1, 2, 3) and whatever else a test wants to prove is
    handled. `version` of None makes `--version` unanswerable, which is how a
    build whose version line cannot be parsed is reproduced.
    """
    if os.name == "nt":
        return _write_cmd(directory, version, rewrite, exit_code)
    return _write_sh(directory, version, rewrite, exit_code)


def _echoed(rewrite: str, argument: str) -> str:
    if rewrite == PREFIX:
        return f"rtk {argument}"
    if rewrite == IDENTITY:
        return argument
    return rewrite


def _write_sh(
    directory: Path, version: str | None, rewrite: str | None, exit_code: int
) -> Path:
    script = directory / "rtk"
    lines = ["#!/usr/bin/env sh"]
    if version is not None:
        lines.append(f'if [ "$1" = "--version" ]; then echo "{version}"; exit 0; fi')
    if rewrite is None:
        lines.append(f'if [ "$1" = "rewrite" ]; then exit {exit_code}; fi')
    else:
        line = _echoed(rewrite, "$2")
        lines.append(
            f'if [ "$1" = "rewrite" ]; then echo "{line}"; exit {exit_code}; fi'
        )
    lines.append("exit 1")
    script.write_text("\n".join(lines) + "\n", encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


#: What `cmd.exe` reads as syntax inside an `echo`. A literal rewrite such as
#: `rtk ls | head -1` — the one that proves a rewrite needing a shell is
#: discarded — would otherwise be executed as a pipe by the fake itself.
_CMD_SPECIAL = "^&|<>()"


def _cmd_escape(text: str) -> str:
    for char in _CMD_SPECIAL:
        text = text.replace(char, "^" + char)
    return text


def _write_cmd(
    directory: Path, version: str | None, rewrite: str | None, exit_code: int
) -> Path:
    """The same fake as a batch file.

    Labels rather than parenthesised blocks: `echo x & exit /b 0` on one line
    echoes the space before the `&`, and a trailing space is exactly the kind
    of difference that makes a rewrite compare unequal to the command it was
    derived from.
    """
    script = directory / "rtk.cmd"
    lines = ["@echo off"]
    if version is not None:
        lines.append('if "%~1"=="--version" goto version')
    lines.append('if "%~1"=="rewrite" goto rewrite')
    lines.append("exit /b 1")
    if version is not None:
        lines += [":version", f"echo {_cmd_escape(version)}", "exit /b 0"]
    lines.append(":rewrite")
    if rewrite is not None:
        lines.append(f"echo {_cmd_escape(_echoed(rewrite, '%~2'))}")
    lines.append(f"exit /b {exit_code}")
    script.write_text("\r\n".join(lines) + "\r\n", encoding="utf-8")
    return script
