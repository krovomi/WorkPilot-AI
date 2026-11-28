"""WinDev / WebDev / WinDev Mobile overlay (WLangage).

No command runs the tests of a WinDev project outside the editor: the
automated test scenarios are binary and the WLangage compiler lives in the
WinDev IDE. So the overlay gives the test runner no command at all, only what
to report instead of a red or green it cannot obtain.
"""

from __future__ import annotations

from . import LanguageOverlay

OVERLAY = LanguageOverlay(
    language="windev",
    notes=(
        "WinDev has no test runner or compiler outside the WinDev editor. Do not "
        "invent a command: report compilation and automated tests as not "
        "verified (to run in the editor), unless the project declares its own "
        "command in .workpilot/worktree.toml [proofs]. Read code only in the "
        "`code : |1+` blocks of text-format elements (.wdw, .wdc, .wdg, .wdp, "
        ".wde, .wwh); binary elements cannot be read."
    ),
)
