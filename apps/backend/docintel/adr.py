"""Architecture Decision Records: where a project keeps them, and what they say.

An ADR is the one document in a repository that says *why the code is shaped
the way it is* — and the one no agent was reading. A planner that has not seen
"ADR-0007: the Domain layer references no infrastructure package" will plan a
repository injected into an entity, and QA, judging against conventions it
inferred from the code, will pass it.

Three layouts are recognised, because three are in use:

| Layout | Status is written as |
|---|---|
| Nygard / adr-tools (`.adr-dir`, `doc/adr`) | a `## Status` section |
| MADR 2 | a `* Status: accepted` bullet |
| MADR 3+ / log4brains | `status:` in YAML frontmatter |

French headings and statuses (`## Statut`, `Accepté`) are read too: the product
ships in French, and so do a good share of the projects it builds.

Only files are read; nothing here needs a model or the network, so the prompt
section can be recomputed on every phase rather than cached into staleness.
"""

from __future__ import annotations

import re
from pathlib import Path

from .models import AdrRecord

#: Where ADRs live in practice, most specific first.
CANDIDATE_DIRS = (
    "docs/adr",
    "docs/adrs",
    "docs/decisions",
    "docs/architecture/decisions",
    "docs/architecture/adr",
    "doc/adr",
    "doc/adrs",
    "doc/decisions",
    "doc/architecture/decisions",
    "architecture/decisions",
    "adr",
    "adrs",
    "decisions",
)
MAX_FILES = 200
MAX_BYTES = 64 * 1024

_SKIP_NAMES = {"readme.md", "index.md", "template.md", "adr-template.md", "_sidebar.md"}
_NUMBER = re.compile(r"^(\d{1,5})")
_TITLE_PREFIX = re.compile(
    r"^(?:adr[\s_-]*)?\d{1,5}\s*[.:)\-–—]?\s*[:\-–—]?\s*", re.IGNORECASE
)
_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_FRONTMATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.S)
_STATUS_BULLET = re.compile(
    r"^\s*[*-]?\s*\**(?:status|statut)\**\s*:\s*(.+)$", re.IGNORECASE | re.M
)
_SUPERSEDED = re.compile(
    r"(?:superseded|replaced|remplac[ée]e?)\s+(?:by|par)\s*:?\s*(.+)", re.IGNORECASE
)
_LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")

_STATUS_WORDS = {
    "accepted": "accepted",
    "accepté": "accepted",
    "acceptée": "accepted",
    "approved": "accepted",
    "adopted": "accepted",
    "proposed": "proposed",
    "proposé": "proposed",
    "proposée": "proposed",
    "draft": "proposed",
    "brouillon": "proposed",
    "deprecated": "deprecated",
    "déprécié": "deprecated",
    "dépréciée": "deprecated",
    "obsolète": "deprecated",
    "superseded": "superseded",
    "remplacé": "superseded",
    "remplacée": "superseded",
    "rejected": "rejected",
    "rejeté": "rejected",
    "rejetée": "rejected",
}
_STATUS_HEADINGS = ("status", "statut")
_DECISION_HEADINGS = (
    "decision",
    "decision outcome",
    "décision",
    "décision prise",
    "resultat de la décision",
    "résultat de la décision",
)


def find_adr_dir(project_dir: Path) -> Path | None:
    """The directory holding this project's ADRs, or None.

    adr-tools records its choice in `.adr-dir`, and that answer wins over any
    guess: a project that told its own tooling where the records are has told
    us too.
    """
    marker = project_dir / ".adr-dir"
    try:
        declared = marker.read_text(encoding="utf-8").strip()
    except OSError:
        declared = ""
    if declared:
        candidate = (project_dir / declared).resolve()
        if _inside(candidate, project_dir) and candidate.is_dir():
            return candidate
    for relative in CANDIDATE_DIRS:
        candidate = project_dir / relative
        if candidate.is_dir() and any(_adr_files(candidate)):
            return candidate
    return None


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root.resolve())
    except ValueError:
        return False
    return True


def _adr_files(directory: Path) -> list[Path]:
    files = [
        p
        for p in sorted(directory.glob("*.md")) + sorted(directory.glob("*.markdown"))
        if p.is_file()
        and p.name.lower() not in _SKIP_NAMES
        and "template" not in p.name.lower()
    ]
    return files[:MAX_FILES]


def _sections(body: str) -> tuple[str, dict[str, str]]:
    """The first heading, and every heading's text keyed by lower-cased title."""
    title = ""
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for line in body.splitlines():
        match = _HEADING.match(line)
        if match:
            text = match.group(2).strip()
            if not title:
                title = text
            current = text.lower().strip(" :")
            sections.setdefault(current, [])
            continue
        if current is not None:
            sections[current].append(line)
    return title, {k: "\n".join(v).strip() for k, v in sections.items()}


def _first_paragraph(text: str, limit: int = 400) -> str:
    for block in re.split(r"\n\s*\n", text.strip()):
        block = " ".join(line.strip() for line in block.splitlines()).strip()
        if block:
            return block if len(block) <= limit else block[: limit - 1].rstrip() + "…"
    return ""


def _normalise_status(raw: str) -> tuple[str, str]:
    """(status, superseded_by) from whatever the file wrote."""
    text = _LINK.sub(lambda m: f"{m.group(1)} ({m.group(2)})", raw.strip())
    superseded_by = ""
    if match := _SUPERSEDED.search(text):
        superseded_by = match.group(1).strip()
    word = re.sub(r"[^\wÀ-ÿ]", " ", text.lower()).split()
    status = _STATUS_WORDS.get(word[0], "unknown") if word else "unknown"
    if superseded_by:
        status = "superseded"
    return status, superseded_by


def _frontmatter(text: str) -> tuple[dict[str, str], str]:
    match = _FRONTMATTER.match(text)
    if not match:
        return {}, text
    values: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" in line and not line.startswith((" ", "\t", "-")):
            key, value = line.split(":", 1)
            values[key.strip().lower()] = value.strip().strip("\"'")
    return values, text[match.end() :]


def parse_adr(path: Path, project_dir: Path) -> AdrRecord | None:
    try:
        raw = path.read_bytes()[:MAX_BYTES].decode("utf-8", errors="replace")
    except OSError:
        return None

    meta, body = _frontmatter(raw)
    title, sections = _sections(body)
    title = meta.get("title") or title or path.stem

    status_text = meta.get("status", "")
    if not status_text:
        for heading in _STATUS_HEADINGS:
            if sections.get(heading):
                status_text = _first_paragraph(sections[heading])
                break
    if not status_text and (bullet := _STATUS_BULLET.search(body)):
        status_text = bullet.group(1)
    status, superseded_by = _normalise_status(status_text)
    if meta.get("superseded-by") or meta.get("superseded_by"):
        superseded_by = meta.get("superseded-by") or meta.get("superseded_by", "")
        status = "superseded"

    decision = ""
    for heading in _DECISION_HEADINGS:
        if sections.get(heading):
            decision = _first_paragraph(sections[heading])
            break

    number = _NUMBER.match(path.stem)
    adr_id = f"ADR-{number.group(1)}" if number else path.stem
    clean_title = _TITLE_PREFIX.sub("", title).strip() or title
    try:
        relative = path.relative_to(project_dir).as_posix()
    except ValueError:
        relative = path.name
    return AdrRecord(
        id=adr_id,
        title=clean_title,
        status=status,
        path=relative,
        decision=decision,
        superseded_by=superseded_by,
    )


def collect_adrs(project_dir: Path) -> list[AdrRecord]:
    """Every ADR the project keeps, in file order. Never raises."""
    try:
        directory = find_adr_dir(project_dir)
        if directory is None:
            return []
        records = [parse_adr(p, project_dir) for p in _adr_files(directory)]
    except OSError:
        return []
    return [r for r in records if r is not None]
