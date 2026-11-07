#!/usr/bin/env python3
"""Changelog fragments: one file per change, folded into CHANGELOG.md at release.

Every PR used to append to the same "Unreleased" lines of CHANGELOG.md, so two
PRs open at once always conflicted. A change is now a file of ``changelog.d/``:

    ---
    section: 🐛 Corrections
    ---
    - **What changed, for the user** (F122). One or two sentences.

    python scripts/changelog.py check                 validate the fragments
    python scripts/changelog.py preview               print the next release's notes
    python scripts/changelog.py release X.Y.Z "Title" write them into CHANGELOG.md, remove the fragments

The release workflows still read CHANGELOG.md only (``## X.Y.Z - Title``).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
FRAGMENTS = ROOT / "changelog.d"
CHANGELOG = ROOT / "CHANGELOG.md"

SECTIONS = (
    "⚠️ Changement incompatible",
    "✨ Nouveautés",
    "🐛 Corrections",
    "🔒 Sécurité",
    "🛠️ Qualité",
    "🧪 Filets de test",
    "📚 Documentation",
    "🧹 Maintenance",
)
"""Release-note sections, in the order they are printed."""

VERSION = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$")
INTRO_PLACEHOLDER = (
    "<!-- Une ou deux phrases : ce que cette version change pour l'utilisateur. -->"
)


class FragmentError(ValueError):
    pass


def fragment_files(directory: Path = FRAGMENTS) -> list[Path]:
    return sorted(p for p in directory.glob("*.md") if p.name != "README.md")


def read_fragment(path: Path) -> tuple[str, str]:
    """The section and the Markdown body of one fragment, validated."""
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n") or "\n---\n" not in text[3:]:
        raise FragmentError(f"{path.name}: starts with a frontmatter (section: …)")
    end = text.index("\n---\n", 3)
    meta = yaml.safe_load(text[4:end]) or {}
    section = meta.get("section") if isinstance(meta, dict) else None
    if section not in SECTIONS:
        raise FragmentError(
            f"{path.name}: section must be one of: {', '.join(SECTIONS)}"
        )
    body = text[end + len("\n---\n") :].strip()
    if not body.startswith("- "):
        raise FragmentError(f"{path.name}: the body is one or more list items (- …)")
    if re.search(r"(?m)^#", body):
        raise FragmentError(
            f"{path.name}: no heading in a fragment; the section is set above"
        )
    return section, body


def notes(directory: Path = FRAGMENTS) -> str:
    """The sections of the next release, in SECTIONS order, fragments by file name."""
    grouped: dict[str, list[str]] = {}
    for path in fragment_files(directory):
        section, body = read_fragment(path)
        grouped.setdefault(section, []).append(body)
    return "\n\n".join(
        f"### {section}\n\n" + "\n".join(grouped[section])
        for section in SECTIONS
        if section in grouped
    )


def release(
    version: str, title: str, directory: Path = FRAGMENTS, changelog: Path = CHANGELOG
) -> None:
    if not VERSION.match(version):
        raise FragmentError(f"{version!r} is not a version (X.Y.Z)")
    if not title.strip():
        raise FragmentError("a release has a title")
    text = changelog.read_text(encoding="utf-8")
    if re.search(rf"(?m)^## {re.escape(version)}(\s|$)", text):
        raise FragmentError(f"CHANGELOG.md already has {version}")
    body = notes(directory)
    if not body:
        raise FragmentError(f"no fragment in {directory.name}/: nothing to release")
    first = re.search(r"(?m)^## ", text)
    at = first.start() if first else len(text)
    entry = (
        f"## {version} - {title.strip()}\n\n{INTRO_PLACEHOLDER}\n\n{body}\n\n---\n\n"
    )
    changelog.write_text(text[:at] + entry + text[at:], encoding="utf-8", newline="\n")
    for path in fragment_files(directory):
        path.unlink()


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else "check"
    try:
        if command == "check":
            for path in fragment_files():
                read_fragment(path)
            return 0
        if command == "preview":
            print(notes() or f"(no fragment in {FRAGMENTS.name}/)")
            return 0
        if command == "release" and len(argv) == 4:
            release(argv[2], argv[3])
            print(
                f"CHANGELOG.md: {argv[2]} written; replace the intro comment, then commit."
            )
            return 0
    except FragmentError as error:
        print(error, file=sys.stderr)
        return 1
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
