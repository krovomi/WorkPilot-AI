"""The documentation every agent reads before its first question stays small and true.

Every agent pays for its instruction files before it reads anything else. Claude
Code reads `CLAUDE.md` and follows its `@imports`; Codex, Copilot, Cursor, Gemini
CLI (through `.gemini/settings.json`), OpenCode, pi… read `AGENTS.md`, from the
root down to the folder they work in. So the root `AGENTS.md` carries the rules
that hold everywhere, once, and the root `CLAUDE.md` imports it and little else:
`docs/CLAUDE.md` once reached 272 KB (~68k tokens) and, with `docs/rules/security.md`,
was imported into every Claude session (audit F23). Theme rules load per folder
(each `AGENTS.md` index has a sibling `CLAUDE.md` that imports it), design
rationale lives in `docs/architecture/`, one file per feature
(`docs/architecture/agent-instructions.md`).

The `AGENTS.md` indexes are read the same way, and a path they name that no
longer exists sends an agent looking for a file that was deleted
(`agents/kanban_subagents.py` was cited months after the subagent registry
replaced it — audit F18).
"""

from __future__ import annotations

import json
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

# What every Claude Code session loads (root CLAUDE.md and its imports), and the
# root AGENTS.md every other agent loads: ~2k tokens, down from ~11k.
MAX_ALWAYS_LOADED_BYTES = 8 * 1024
MAX_ROOT_AGENTS_BYTES = 7 * 1024
MAX_COPILOT_INSTRUCTIONS_BYTES = 2 * 1024

# Codex's default `project_doc_max_bytes`.
CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024

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


def _imports(path: Path) -> list[Path]:
    return [
        (path.parent / m.group(1)).resolve()
        for _, line in _outside_fences(path.read_text(encoding="utf-8"))
        if (m := IMPORT.match(line))
    ]


def _loaded_with(path: Path, seen: set[Path] | None = None) -> set[Path]:
    """`path` and everything its `@imports` pull in, as Claude Code expands them."""
    seen = set() if seen is None else seen
    seen.add(path.resolve())
    for target in _imports(path):
        if target not in seen and target.is_file():
            _loaded_with(target, seen)
    return seen


def test_root_claude_md_imports_agents_md():
    assert (ROOT / "AGENTS.md").resolve() in _imports(ROOT / "CLAUDE.md")


def test_what_every_claude_session_pays_stays_small():
    """Root CLAUDE.md and its imports load in every session, before any question."""
    loaded = _loaded_with(ROOT / "CLAUDE.md")
    size = sum(p.stat().st_size for p in loaded)
    assert size <= MAX_ALWAYS_LOADED_BYTES, (
        f"every Claude Code session loads {size} bytes "
        f"({', '.join(sorted(_rel(p) for p in loaded))}): import theme rules from "
        "the CLAUDE.md of the folder they govern, not from the root"
    )


def test_root_agents_md_stays_small():
    size = (ROOT / "AGENTS.md").stat().st_size
    assert size <= MAX_ROOT_AGENTS_BYTES, (
        f"AGENTS.md is {size} bytes and every agent pays for it in every session: "
        "move what holds for one folder to that folder's AGENTS.md"
    )


@pytest.mark.parametrize("index", _agents_indexes(), ids=_rel)
def test_an_agents_chain_fits_codex(index: Path):
    """Codex concatenates AGENTS.md from the root down, and stops at 32 KiB."""
    chain = [
        parent / "AGENTS.md"
        for parent in [index.parent, *index.parent.parents]
        if (parent / "AGENTS.md").is_file() and parent.is_relative_to(ROOT)
    ]
    size = sum(p.stat().st_size for p in chain)
    assert size <= CODEX_PROJECT_DOC_MAX_BYTES, (
        f"{_rel(index)}: the AGENTS.md chain is {size} bytes, Codex drops the rest"
    )


def test_gemini_cli_reads_agents_md():
    """Gemini CLI reads GEMINI.md unless told otherwise; one file, not two."""
    settings = json.loads(
        (ROOT / ".gemini" / "settings.json").read_text(encoding="utf-8")
    )
    assert "AGENTS.md" in settings["context"]["fileName"]
    assert not (ROOT / "GEMINI.md").exists(), "GEMINI.md would duplicate AGENTS.md"


def test_copilot_instructions_point_to_agents_md():
    """Copilot loads it on every request: a pointer, not a second copy of the rules."""
    path = ROOT / ".github" / "copilot-instructions.md"
    text = path.read_text(encoding="utf-8")
    assert "AGENTS.md" in text
    assert path.stat().st_size <= MAX_COPILOT_INSTRUCTIONS_BYTES


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
