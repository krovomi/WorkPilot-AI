"""What every docintel reader shares about a task's files: where they are, and
whether one may be read, written or trusted.

A leaf module on purpose. `preflight` runs the readers (`spec_drafts`,
`whiteboard`, `tables`), and the readers need these same answers — which
attachment is the task's, which path stays inside the spec directory, what
`injection_guard` makes of a text. Kept in `preflight`, each reader had to
import it back: a cycle. Here, everyone imports them and they import nobody.
"""

from __future__ import annotations

import json
from pathlib import Path

RESULT_DIR = "docintel"
MAX_FILES = 25
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"}


def inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def attachment_paths(spec_dir: Path) -> list[Path]:
    """Every file attached to this task, each once, never outside the spec.

    Two sources, because the frontend writes both and they can disagree: the
    `attachments/` directory (what is on disk) and `attached_images` in
    `requirements.json` (what the task says it carries). A path in the latter
    that leaves the spec directory is ignored rather than followed.
    """
    found: list[Path] = []
    attachments = spec_dir / "attachments"
    if attachments.is_dir():
        # A symlink is never followed: `attachments/` is the task's own copy of
        # what was attached, and a link inside it pointing at `~/.ssh` would
        # otherwise be read into a prompt.
        found.extend(
            sorted(
                p
                for p in attachments.rglob("*")
                if p.is_file() and not p.is_symlink() and inside(p, spec_dir)
            )
        )

    try:
        requirements = json.loads(
            (spec_dir / "requirements.json").read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        requirements = {}
    for entry in requirements.get("attached_images") or []:
        relative = entry.get("path") if isinstance(entry, dict) else None
        if not relative:
            continue
        candidate = spec_dir / str(relative)
        if (
            candidate.is_file()
            and not candidate.is_symlink()
            and inside(candidate, spec_dir)
        ):
            found.append(candidate)

    unique: list[Path] = []
    seen: set[Path] = set()
    for path in found:
        key = path.resolve()
        if key not in seen and not inside(path, spec_dir / RESULT_DIR):
            seen.add(key)
            unique.append(path)
    return unique[:MAX_FILES]


def writable(target: Path, spec_dir: Path) -> bool:
    """Whether `target` can be written without leaving the spec directory.

    Nothing on the way to it may be a symlink — `docintel/`, `extracted/` or
    the file itself: a spec directory copied from somewhere else, or edited by
    hand, could carry one pointing at a file the build must never overwrite.
    """
    current = target
    while current != spec_dir and spec_dir in current.parents:
        if current.is_symlink():
            return False
        current = current.parent
    return inside(target.parent, spec_dir) if target.parent.exists() else True


def threat(text: str, source: str) -> str:
    try:
        from injection_guard import InjectionScanner

        return InjectionScanner().scan(text, source=source).threat_level.value
    except Exception:  # noqa: BLE001 - a scanner failure is not a verdict
        return "safe"


def clean(text: str) -> str:
    try:
        from watermarks.clean import clean_generated

        return clean_generated(text).text
    except Exception:  # noqa: BLE001 - a cosmetic pass never blocks the read
        return text
