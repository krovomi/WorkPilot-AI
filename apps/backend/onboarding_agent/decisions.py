"""What the team decided, and where it is written (#349).

Three sources, each read as it is, none invented:

- **architecture decision records** in the repository: ``docs/adr/``,
  ``doc/adr/``, ``docs/decisions/``, ``docs/architecture/decisions/``,
  ``adr/``, and files named ``adr-*.md`` / ``ADR-*.md``. The title is the
  first heading, the status the MADR / Nygard ``Status:`` line, the date its
  ``Date:`` line;
- **breaking commits** of the last two years: a Conventional Commit with
  ``!`` (``refactor!: …``) or a ``BREAKING CHANGE:`` footer;
- **the project's memory** in the WorkPilot Brain (the vault every agent
  writes to; it replaced Graphiti): the gotchas and patterns builds learned.

A repository with none of them gets an empty list, and the tour says so.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from foundation.git_executable import run_git

__all__ = ["Decision", "adr_files", "read_decisions"]

logger = logging.getLogger(__name__)

_ADR_DIRS = re.compile(
    r"(?:^|/)(?:docs?/adrs?|docs?/decisions|docs?/architecture/decisions|adrs?|architecture/decisions|"
    r"decisions)/[^/]+\.(?:md|markdown|rst|adoc|txt)$",
    re.I,
)
_ADR_NAME = re.compile(
    r"(?:^|/)(?:adr|ADR)[-_]?\d*[-_][^/]*\.(?:md|markdown|rst|adoc)$"
)
_HEADING = re.compile(r"^\s*(?:#+\s*|=+\s*)(.+?)\s*#*\s*$", re.M)
_STATUS = re.compile(
    r"^\s*(?:\*\*)?(?:status|statut)(?:\*\*)?\s*[:=]\s*\**\s*([A-Za-zÀ-ÿ\- ]{3,30})",
    re.I | re.M,
)
_STATUS_SECTION = re.compile(
    r"^#+\s*(?:status|statut)\s*\n+\s*([A-Za-zÀ-ÿ\- ]{3,30})", re.I | re.M
)
_DATE = re.compile(
    r"^\s*(?:\*\*)?date(?:\*\*)?\s*[:=]\s*\**\s*(\d{4}-\d{2}-\d{2})", re.I | re.M
)
_BREAKING = re.compile(r"^(?P<type>\w+)(?:\([^)]*\))?!:\s*(?P<subject>.+)$")
_MAX_TEXT = 300


@dataclass(frozen=True)
class Decision:
    source: str
    """``adr``, ``commit`` or ``memory``."""
    title: str
    path: str = ""
    status: str = ""
    date: str = ""
    ref: str = ""
    """The commit, for a breaking commit."""

    def to_dict(self) -> dict[str, str]:
        return {
            "source": self.source,
            "title": self.title,
            "path": self.path,
            "status": self.status,
            "date": self.date,
            "ref": self.ref,
        }


def _clean(value: str) -> str:
    return " ".join(value.replace("`", "").split())[:_MAX_TEXT]


def adr_files(files: list[str]) -> list[str]:
    """The decision records among ``files``, in their numbering order."""
    return sorted(f for f in files if _ADR_DIRS.search(f) or _ADR_NAME.search(f))


def _adr(path: str, source: str) -> Decision | None:
    heading = _HEADING.search(source)
    title = (
        _clean(heading.group(1))
        if heading
        else PurePosixPath(path).stem.replace("-", " ")
    )
    title = re.sub(r"^(?:ADR[-\s]?)?\d+[.:\s-]+", "", title, flags=re.I) or title
    if PurePosixPath(path).name.lower() in {
        "readme.md",
        "index.md",
        "template.md",
        "0000-template.md",
    }:
        return None
    status = _STATUS.search(source) or _STATUS_SECTION.search(source)
    date = _DATE.search(source)
    return Decision(
        source="adr",
        title=title,
        path=path,
        status=_clean(status.group(1)).lower() if status else "",
        date=date.group(1) if date else "",
    )


def _breaking_commits(root: Path, limit: int) -> list[Decision]:
    result = run_git(
        [
            "log",
            "--since=730.days",
            "--no-merges",
            "--format=%h%x1f%ad%x1f%s%x1f%b%x1e",
            "--date=short",
            "-n2000",
        ],
        cwd=root,
        timeout=30,
    )
    if result.returncode != 0:
        return []
    found: list[Decision] = []
    for record in result.stdout.split("\x1e"):
        parts = record.strip("\n").split("\x1f")
        if len(parts) < 4:
            continue
        ref, date, subject, body = parts[0].strip(), parts[1], parts[2], parts[3]
        match = _BREAKING.match(subject)
        if match or "BREAKING CHANGE:" in body or "BREAKING-CHANGE:" in body:
            found.append(
                Decision(source="commit", title=_clean(subject), date=date, ref=ref)
            )
            if len(found) >= limit:
                break
    return found


def _memory(root: Path, limit: int) -> list[Decision]:
    try:
        from brain.project_memory import ProjectMemory

        memory = ProjectMemory(project_dir=root)
        if not memory.is_enabled:
            return []
        notes = [("gotcha", g) for g in memory.load_gotchas()] + [
            ("pattern", p) for p in memory.load_patterns()
        ]
    except (ImportError, OSError, ValueError, RuntimeError) as exc:
        logger.debug("No project memory for the tour: %s", type(exc).__name__)
        return []
    return [
        Decision(source="memory", title=_clean(body), status=kind)
        for kind, body in notes[-limit:]
        if body.strip()
    ]


def read_decisions(
    root: Path, files: list[str], read: object, limit: int = 12
) -> list[Decision]:
    """The decisions of the project at ``root``: records first, then commits, then memory."""
    decisions: list[Decision] = []
    for path in adr_files(files)[:50]:
        decision = _adr(path, read(path))  # type: ignore[operator]
        if decision:
            decisions.append(decision)
    decisions = decisions[-limit:]
    decisions.extend(_breaking_commits(root, max(3, limit // 2)))
    decisions.extend(_memory(root, max(3, limit // 2)))
    return decisions
