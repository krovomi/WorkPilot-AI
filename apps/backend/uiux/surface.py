"""The one answer to "is this file part of an interface?".

Every reader asks here: relevance (does this task touch the UI), the prompt
(does this subtask), and the workflow's ``&ui_surface`` anchor, which
`scripts/sync_surface_globs.py` writes from `UI_GLOBS` and `tests/test_uiux.py`
holds equal to it. This tuple is the source because it ships in every build,
where the repository's `workflows/` does not. Two copies of "what counts as UI"
drifting apart is how a phase runs on a task its prompt section then skips.

Globs rather than extensions because a few surfaces are named, not typed
(`Info.plist`, a `.xcodeproj` directory). `.ts` and `.js` are deliberately not
here: on their own they say nothing — an Express route and a React hook share
the extension — and a task whose only UI file is a `.ts` still touches a
`.tsx`, `.vue` or stylesheet somewhere.
"""

from __future__ import annotations

import fnmatch
from collections.abc import Iterable
from pathlib import PurePosixPath

__all__ = ["UI_GLOBS", "is_ui_path", "ui_paths"]

UI_GLOBS: tuple[str, ...] = (
    # Web
    "**/*.tsx",
    "**/*.jsx",
    "**/*.vue",
    "**/*.svelte",
    "**/*.astro",
    "**/*.html",
    "**/*.css",
    "**/*.scss",
    "**/*.sass",
    "**/*.less",
    # .NET: Blazor and Razor pages, then XAML (WPF, WinUI, UWP, MAUI, Uno) and
    # Avalonia's AXAML.
    "**/*.razor",
    "**/*.cshtml",
    "**/*.xaml",
    "**/*.axaml",
    # Phone and desktop toolkits whose screens are code.
    "**/*.swift",
    "**/*.dart",
    "**/*.fxml",
    "**/res/layout/**",
    "**/res/values/**",
)


def _match(path: str, pattern: str) -> bool:
    if fnmatch.fnmatch(path, pattern):
        return True
    # `**/x` also names `x` at the root: fnmatch's `*` needs a separator.
    if pattern.startswith("**/") and fnmatch.fnmatch(path, pattern[3:]):
        return True
    return False


def is_ui_path(path: str) -> bool:
    normalised = str(path).replace("\\", "/").lstrip("./")
    if not normalised:
        return False
    name = PurePosixPath(normalised).name
    return any(_match(normalised, g) or _match(name, g) for g in UI_GLOBS)


def ui_paths(paths: Iterable[str]) -> list[str]:
    return [p for p in paths if is_ui_path(p)]
