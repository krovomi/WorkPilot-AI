#!/usr/bin/env python3
"""Keep a release's notes under the size GitHub accepts.

GitHub refuses a release whose text is over 125 000 characters, and the
``## X.Y.Z`` section of ``CHANGELOG.md`` can be longer (1.6.0 folded 469
fragments, about 300 000). ``release.yml`` runs this on the extracted section
before it creates the release: a section within the budget is left as it is;
a longer one keeps whole entries (a cut only falls before a heading or a
``- `` bullet) and ends with a link to the full section in ``CHANGELOG.md``.

    python scripts/release_notes_cap.py changelog-body.md 1.6.0 owner/repo
"""

from __future__ import annotations

import sys
from pathlib import Path

#: Room left for what release.yml adds around the notes (signing note, links,
#: the VirusTotal results appended after the release).
BUDGET = 100_000


def note(version: str, repo: str) -> str:
    return (
        f"\n\n_La suite des notes de la {version} est dans le "
        f"[CHANGELOG](https://github.com/{repo}/blob/main/CHANGELOG.md) : "
        "GitHub limite la taille du texte d'une release._\n"
    )


def cap(text: str, version: str, repo: str, budget: int = BUDGET) -> str:
    if len(text) <= budget:
        return text
    room = budget - len(note(version, repo))
    lines = text.splitlines(keepends=True)
    size, cut = 0, 0
    for index, line in enumerate(lines):
        if line.startswith(("- ", "#")):
            cut = index
        if size + len(line) > room:
            break
        size += len(line)
    else:
        cut = len(lines)
    return "".join(lines[:cut]).rstrip() + note(version, repo)


def main(argv: list[str]) -> int:
    path, version, repo = Path(argv[0]), argv[1], argv[2]
    text = path.read_text(encoding="utf-8")
    capped = cap(text, version, repo)
    if capped != text:
        path.write_text(capped, encoding="utf-8")
        print(f"Release notes cut from {len(text)} to {len(capped)} characters.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
