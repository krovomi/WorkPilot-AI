"""The documentation every agent reads before its first question stays small and true.

`CLAUDE.md` imports `AGENTS.md`, `docs/CLAUDE.md` and `docs/rules/security.md`, and
the Claude Agent SDK loads the project's `CLAUDE.md` through `setting_sources`:
every Claude Code session on this repository, WorkPilot building itself included,
pays for those files before it reads anything else. `docs/CLAUDE.md` had grown to
272 KB (~68k tokens) by mixing a page of rules with the design rationale of every
feature, which now lives in `docs/architecture/`, one file per feature (audit F23).
The rules themselves are split by theme under `docs/rules/`.

Two families of harness read these files. Claude Code reads `CLAUDE.md` and follows
its `@imports`; every other harness (Codex, Copilot, Cursor, Gemini, OpenCode…)
reads `AGENTS.md` and nothing else. So each `AGENTS.md` index carries a sibling
`CLAUDE.md` that imports it, and no `AGENTS.md` relies on an import it cannot follow.

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
DOCS = ROOT / "docs"
CLAUDE_MD = DOCS / "CLAUDE.md"
ARCHITECTURE = DOCS / "architecture"
RULES = DOCS / "rules"

# Fails above this, to leave room under the 20 KB target without a PR per line.
MAX_CLAUDE_MD_BYTES = 25 * 1024

# An instruction file longer than this is split by theme, not grown.
MAX_INSTRUCTION_LINES = 200

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
IMPORT = re.compile(r"^@(\S+)\s*$")


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


def _tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout
    return out.splitlines()


def _tracked_named(name: str) -> list[Path]:
    return sorted(
        ROOT / p
        for p in _tracked_files()
        if Path(p).name == name and (ROOT / p).is_file()
    )


def _agents_indexes() -> list[Path]:
    return _tracked_named("AGENTS.md")


def _claude_files() -> list[Path]:
    return _tracked_named("CLAUDE.md")


def _documents() -> list[Path]:
    """Every tracked page under `docs/`, the READMEs a reader starts from, and the indexes."""
    tracked = _tracked_files()
    return sorted(
        {
            *(ROOT / p for p in tracked if p.startswith("docs/") and p.endswith(".md")),
            ROOT / "README.md",
            ROOT / "apps" / "backend" / "README.md",
            ROOT / "apps" / "frontend" / "README.md",
            *_agents_indexes(),
            *_claude_files(),
        }
    )


def _instruction_files() -> list[Path]:
    return sorted({*_agents_indexes(), *_claude_files(), *RULES.glob("*.md")})


def _rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def test_claude_md_stays_small():
    size = CLAUDE_MD.stat().st_size
    assert size <= MAX_CLAUDE_MD_BYTES, (
        f"docs/CLAUDE.md is {size} bytes: design rationale goes in "
        "docs/architecture/<feature>.md, with one row in the table"
    )


@pytest.mark.parametrize("document", _instruction_files(), ids=_rel)
def test_instruction_files_stay_short(document: Path):
    lines = len(document.read_text(encoding="utf-8").splitlines())
    assert lines <= MAX_INSTRUCTION_LINES, (
        f"{_rel(document)} has {lines} lines: split it by theme "
        "(docs/rules/<theme>.md) or move rationale to docs/architecture/"
    )


def test_every_architecture_file_is_indexed():
    claude_md = CLAUDE_MD.read_text(encoding="utf-8")
    missing = [
        p.name
        for p in sorted(ARCHITECTURE.glob("*.md"))
        if f"](architecture/{p.name})" not in claude_md
    ]
    assert missing == [], "not listed in docs/CLAUDE.md's design-rationale table"


def test_every_rules_file_is_indexed():
    claude_md = CLAUDE_MD.read_text(encoding="utf-8")
    missing = [
        p.name
        for p in sorted(RULES.glob("*.md"))
        if f"](rules/{p.name})" not in claude_md
    ]
    assert missing == [], "not listed in docs/CLAUDE.md's rules table"


@pytest.mark.parametrize("document", _documents(), ids=_rel)
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
    assert broken == [], _rel(document)


@pytest.mark.parametrize("claude", _claude_files(), ids=_rel)
def test_claude_imports_resolve(claude: Path):
    """An `@import` that resolves to nothing is silently dropped by Claude Code."""
    broken = [
        f"{number}: @{m.group(1)}"
        for number, line in _outside_fences(claude.read_text(encoding="utf-8"))
        if (m := IMPORT.match(line)) and not (claude.parent / m.group(1)).is_file()
    ]
    assert broken == [], _rel(claude)


def test_root_claude_md_imports_the_always_loaded_files():
    imports = {
        m.group(1)
        for _, line in _outside_fences((ROOT / "CLAUDE.md").read_text(encoding="utf-8"))
        if (m := IMPORT.match(line))
    }
    assert {"AGENTS.md", "docs/CLAUDE.md", "docs/rules/security.md"} <= imports


@pytest.mark.parametrize("index", _agents_indexes(), ids=_rel)
def test_every_agents_index_reaches_claude_code(index: Path):
    """Claude Code does not read AGENTS.md: a sibling CLAUDE.md must import it."""
    sibling = index.parent / "CLAUDE.md"
    assert sibling.is_file(), f"{_rel(index)} has no sibling CLAUDE.md"
    imports = [
        m.group(1)
        for _, line in _outside_fences(sibling.read_text(encoding="utf-8"))
        if (m := IMPORT.match(line))
    ]
    assert "AGENTS.md" in imports, f"{_rel(sibling)} does not import @AGENTS.md"


@pytest.mark.parametrize("index", _agents_indexes(), ids=_rel)
def test_agents_indexes_stay_harness_agnostic(index: Path):
    """Other harnesses read AGENTS.md verbatim: a Claude-only import is a dead line."""
    imports = [
        f"{number}: {line}"
        for number, line in _outside_fences(index.read_text(encoding="utf-8"))
        if IMPORT.match(line)
    ]
    assert imports == [], f"{_rel(index)} uses @imports only Claude Code follows"


def test_every_local_index_is_listed_at_the_root():
    root_index = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
    missing = [
        _rel(index)
        for index in _agents_indexes()
        if index != ROOT / "AGENTS.md" and f"]({_rel(index)})" not in root_index
    ]
    assert missing == [], "not listed in AGENTS.md's local-index table"


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
                missing.append(f"{_rel(index)}:{number}: {cited}")
    assert missing == [], "cited by an AGENTS.md, tracked nowhere"
