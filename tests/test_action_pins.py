"""Every external GitHub Action is pinned by commit SHA (plan of 29 October, T4).

A tag is mutable: whoever controls the action's repository can move `v4` to
another commit, and the next run executes it with the workflow's token. A
40-hex SHA cannot move. The version stays readable in a trailing comment,
which Dependabot rewrites with the SHA (`.github/dependabot.yml` lists both
the workflows and the composite actions).
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GITHUB = ROOT / ".github"

_USES = re.compile(r"^\s*(?:-\s*)?uses:\s*(?P<ref>\S+)(?P<rest>[^\n]*)$", re.M)
_SHA = re.compile(r"@[0-9a-f]{40}$")


def _workflow_files() -> list[Path]:
    return sorted(
        p
        for p in GITHUB.rglob("*")
        if p.suffix in {".yml", ".yaml"} and p.name != "dependabot.yml"
    )


def _external_uses() -> list[tuple[str, str, str]]:
    found = []
    for path in _workflow_files():
        text = path.read_text(encoding="utf-8")
        for match in _USES.finditer(text):
            ref = match.group("ref")
            if ref.startswith("./") or ref.startswith("docker://"):
                continue
            found.append((str(path.relative_to(ROOT)), ref, match.group("rest")))
    return found


def test_there_are_actions_to_check():
    assert len(_external_uses()) > 50


def test_every_external_action_is_pinned_by_sha():
    unpinned = [
        f"{path}: {ref}" for path, ref, _ in _external_uses() if not _SHA.search(ref)
    ]
    assert not unpinned, "pin by commit SHA, version in a comment:\n" + "\n".join(
        unpinned
    )


def test_every_pin_says_which_version_it_is():
    silent = [
        f"{path}: {ref}" for path, ref, rest in _external_uses() if "#" not in rest
    ]
    assert not silent, "add `# vX.Y.Z` after the SHA:\n" + "\n".join(silent)


def test_dependabot_watches_the_composite_actions():
    config = (GITHUB / "dependabot.yml").read_text(encoding="utf-8")
    block = config[config.index("package-ecosystem: github-actions") :]
    assert "/.github/actions/*" in block
