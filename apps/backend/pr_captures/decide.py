"""Does this task need captures? Answered from its changed files, never by a model.

The question "is this file part of an interface?" has one answer in the
backend, `uiux.surface` (web, Razor and Blazor, XAML, SwiftUI, Flutter,
Android layouts); this module only adds what a capture needs on top of it:

- the screens a capture can show that the design-system phase does not
  style: a server template (Jinja, Twig, ERB, Blade, EJS, Handlebars, Go
  templates, Thymeleaf pages are `.html` already) and a WinDev window, page,
  report or template (`.wdw`, `.wwh`, `.wde`, `.wdt`). They stay out of
  `UI_GLOBS` on purpose: that list also decides when the UI/UX phase runs;
- a test, a story or a fixture is not a screen anybody will see, even as a
  `.tsx` (`Button.test.tsx`, `Card.stories.tsx`);
- the team's setting, then the card's, can force the answer either way.

The reason is a stable code the app translates, not a sentence.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field

from uiux.surface import ui_paths

from .settings import CaptureSettings

__all__ = ["CaptureDecision", "decide", "screen_files"]

#: The interface files a capture would show at most: the list is evidence for
#: the panel, not an inventory of the diff.
MAX_LISTED = 20

#: Screens a capture shows beyond `uiux.surface` (see the module's docstring).
CAPTURE_SUFFIXES: tuple[str, ...] = (
    ".jinja",
    ".jinja2",
    ".j2",
    ".twig",
    ".erb",
    ".blade.php",
    ".ejs",
    ".hbs",
    ".handlebars",
    ".mustache",
    ".pug",
    ".gohtml",
    ".tmpl",
    ".wdw",
    ".wwh",
    ".wde",
    ".wdt",
)

_NOT_A_SCREEN = re.compile(
    r"(?:^|/)(?:tests?|__tests__|__mocks__|spec|e2e|fixtures?|stories|storybook|mocks?)/|"
    r"\.(?:test|spec|stories|story|e2e|cy)\.\w+$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class CaptureDecision:
    needed: bool
    #: ``forced`` (setting or card: always), ``turned-off`` (never),
    #: ``ui-files`` (the diff touches a screen), ``no-ui-files``,
    #: ``no-changed-files``.
    reason: str
    decided_by: str = "default"
    ui_files: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "needed": self.needed,
            "reason": self.reason,
            "decidedBy": self.decided_by,
            "uiFiles": list(self.ui_files),
        }


def screen_files(changed_files: Iterable[str]) -> list[str]:
    """The changed files a person would see on screen, tests and stories left out."""
    normalised = [str(p).replace("\\", "/") for p in changed_files if p]
    surface = set(ui_paths(normalised))
    return [
        p
        for p in normalised
        if (p in surface or p.lower().endswith(CAPTURE_SUFFIXES))
        and not _NOT_A_SCREEN.search(p)
    ]


def decide(
    settings: CaptureSettings, changed_files: Iterable[str] | None
) -> CaptureDecision:
    """The verdict for one task. Never raises."""
    files = screen_files(changed_files or [])
    listed = files[:MAX_LISTED]
    if settings.mode == "never":
        return CaptureDecision(False, "turned-off", settings.decided_by, listed)
    if settings.mode == "always":
        return CaptureDecision(True, "forced", settings.decided_by, listed)
    if files:
        return CaptureDecision(True, "ui-files", settings.decided_by, listed)
    if not changed_files:
        return CaptureDecision(False, "no-changed-files", settings.decided_by)
    return CaptureDecision(False, "no-ui-files", settings.decided_by)
