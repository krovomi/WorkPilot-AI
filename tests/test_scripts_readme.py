"""``scripts/README.md`` lists every file and folder of ``scripts/``.

The audit of 17 October found the README describing 9 of 53 scripts, and 26
that nothing called. A script without a line is one nobody can tell is still
used; a line without a script is a promise the folder no longer keeps.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = REPO_ROOT / "scripts"


def _entries() -> set[str]:
    tracked = subprocess.run(
        ["git", "ls-files", "scripts"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    entries = set()
    for path in tracked:
        parts = Path(path).parts[1:]
        if parts == ("README.md",):
            continue
        entries.add(parts[0] + "/" if len(parts) > 1 else parts[0])
    return entries


def _listed() -> set[str]:
    listed = set()
    for line in (SCRIPTS / "README.md").read_text(encoding="utf-8").splitlines():
        if line.startswith("| `"):
            first_cell = line.split("|")[1]
            listed.update(re.findall(r"`([^`]+)`", first_cell))
    return listed


def test_the_tracked_scripts_are_read():
    entries = _entries()
    assert "skills_cli.py" in entries
    assert "wiki/" in entries


def test_every_script_has_a_line():
    missing = sorted(_entries() - _listed())
    assert missing == [], f"add a line to scripts/README.md for: {missing}"


def test_every_line_names_a_script():
    gone = sorted(_listed() - _entries())
    assert gone == [], f"scripts/README.md lists what is not there: {gone}"
