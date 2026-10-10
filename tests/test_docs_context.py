"""The documentation every agent reads before its first question stays small and true.

`CLAUDE.md` imports `docs/CLAUDE.md`, and the Claude Agent SDK loads the
project's `CLAUDE.md` through `setting_sources`: every Claude Code session on
this repository, WorkPilot building itself included, pays for that file before
it reads anything else. It had grown to 272 KB (~68k tokens) by mixing a page of
rules with the design rationale of every feature, which now lives in
`shared_docs/architecture/`, one file per feature (audit F23).

The `AGENTS.md` indexes are read the same way, and a path they name that no
longer exists sends an agent looking for a file that was deleted
(`agents/kanban_subagents.py` was cited months after the subagent registry
replaced it — audit F18).
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
CLAUDE_MD = ROOT / "docs" / "CLAUDE.md"
ARCHITECTURE = ROOT / "shared_docs" / "architecture"

# Fails above this, to leave room under the 20 KB target without a PR per line.
MAX_CLAUDE_MD_BYTES = 25 * 1024

# Paths an index may name although they are not tracked: generated outputs that
# are not emitted by default, and git-ignored working directories.
NOT_TRACKED = {
    ".claude/skills/": "harness mirror, not emitted by default",
    ".github/skills/": "harness mirror, not emitted by default",
    ".cursor/skills/": "harness mirror, not emitted by default",
    ".github/agents/": "harness output, not emitted by default",
    ".codex/agents/": "harness output, not emitted by default",
    "skills/_proposed/": "hermes candidate queue, git-ignored",
}

LINK = re.compile(r"\]\(([^)\s]+)\)")
HEADING = re.compile(r"^#{1,6} (.*)$")


def _slug(title: str) -> str:
    """GitHub's anchor for a heading."""
    return re.sub(r"[^\w\- ]", "", title.strip().lower()).replace(" ", "-")


def _outside_fences(text: str):
    fence = False
    for number, line in enumerate(text.split("\n"), 1):
        if line.startswith("```"):
            fence = not fence
            continue
        if not fence:
            yield number, line


def _anchors(path: Path) -> set[str]:
    return {
        _slug(m.group(1))
        for _, line in _outside_fences(path.read_text(encoding="utf-8"))
        if (m := HEADING.match(line))
    }


def _documents() -> list[Path]:
    return [CLAUDE_MD, *sorted(ARCHITECTURE.glob("*.md"))]


def test_claude_md_stays_small():
    size = CLAUDE_MD.stat().st_size
    assert size <= MAX_CLAUDE_MD_BYTES, (
        f"docs/CLAUDE.md is {size} bytes: design rationale goes in "
        "shared_docs/architecture/<feature>.md, with one row in the table"
    )


def test_every_architecture_file_is_indexed():
    claude_md = CLAUDE_MD.read_text(encoding="utf-8")
    missing = [
        p.name
        for p in sorted(ARCHITECTURE.glob("*.md"))
        if f"shared_docs/architecture/{p.name})" not in claude_md
    ]
    assert missing == [], "not listed in docs/CLAUDE.md's design-rationale table"


@pytest.mark.parametrize("document", _documents(), ids=lambda p: p.name)
def test_relative_links_resolve(document: Path):
    broken = []
    for number, line in _outside_fences(document.read_text(encoding="utf-8")):
        for target in LINK.findall(re.sub(r"`[^`]*`", "", line)):
            if re.match(r"^[a-z][a-z0-9+.-]*:", target):
                continue
            path, _, fragment = target.partition("#")
            resolved = (document.parent / path).resolve() if path else document
            if not resolved.exists():
                broken.append(f"{number}: {target}")
            elif fragment and resolved.suffix == ".md":
                if fragment not in _anchors(resolved):
                    broken.append(f"{number}: {target} (no such heading)")
    assert broken == [], f"{document.relative_to(ROOT)}"


def _tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout
    return out.splitlines()


def _agents_indexes() -> list[Path]:
    return sorted(ROOT / p for p in _tracked_files() if Path(p).name == "AGENTS.md")


def _names_something(cited: str, tracked: list[str]) -> bool:
    """True when a tracked path is `cited`, or ends with it after a `/`.

    Indexes cite paths relative to whatever they are about (`mobile/readiness.py`
    in the root index means `apps/backend/mobile/readiness.py`), so a suffix match
    is the rule. A file that no longer exists anywhere matches nothing.
    """
    if cited.endswith("/"):
        return any(p.startswith(cited) or f"/{cited}" in p for p in tracked)
    return any(p == cited or p.endswith(f"/{cited}") for p in tracked)


def test_agents_indexes_name_files_that_exist():
    tracked = _tracked_files()
    missing = []
    for index in _agents_indexes():
        text = index.read_text(encoding="utf-8")
        for number, line in _outside_fences(text):
            for cited in re.findall(r"`([^`\s]+)`", line):
                if not re.search(r"(\.py|\.ts|\.tsx|\.md|/)$", cited):
                    continue
                if any(c in cited for c in "*<>{}$|"):
                    continue  # a pattern, not a path
                if cited.startswith("."):
                    local = (index.parent / cited).resolve()
                    if local.exists():
                        continue
                if cited in NOT_TRACKED or _names_something(cited, tracked):
                    continue
                missing.append(f"{index.relative_to(ROOT)}:{number}: {cited}")
    assert missing == [], "cited by an AGENTS.md, tracked nowhere"
