"""Docs the code moved past: git says the code changed after the doc (#354).

A document is linked to the code it is about: the files it cites, the files
declaring the functions it cites (when at most three do), and, for a README
inside a folder, the code of that folder. When one of them was committed after
the document's own last commit, the document is **probably stale**, since the
first such commit. Nothing is said about a document git does not track, nor
about a project without git.

The freshness score of a document starts at 100 and loses 20 per high, 10 per
medium and 5 per low problem, and 10 plus 5 per month of staleness (40 at
most); it never goes below 0.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import PurePosixPath

from foundation.git_executable import run_git

__all__ = [
    "DocFreshness",
    "GitHistory",
    "freshness_score",
    "git_history",
    "stale_docs",
]

_HISTORY_DAYS = 730
_MAX_FOLDER_FILES = 200
_SEVERITY_COST = {"high": 20, "medium": 10, "low": 5}


@dataclass
class GitHistory:
    """When each project file was committed (seconds since the epoch, newest first)."""

    __test__ = False

    times: dict[str, list[int]] = field(default_factory=dict)
    now: int = 0

    def last(self, rel: str) -> int | None:
        times = self.times.get(rel)
        return times[0] if times else None

    def first_after(self, rel: str, moment: int) -> int | None:
        after = [t for t in self.times.get(rel, ()) if t > moment]
        return min(after) if after else None


@dataclass
class DocFreshness:
    doc: str
    score: int
    last_updated: int | None = None
    stale_since: int | None = None
    changed_files: list[str] = field(default_factory=list)


def git_history(root, now: int) -> GitHistory | None:
    """The commit times of every file under ``root``; None without git."""
    prefix = run_git(["rev-parse", "--show-prefix"], cwd=root, timeout=10)
    if prefix.returncode != 0:
        return None
    strip = prefix.stdout.strip()
    log = run_git(
        [
            "-c",
            "core.quotePath=false",
            "log",
            f"--since={_HISTORY_DAYS}.days",
            "--format=\x1e%ct",
            "--name-only",
            "--no-renames",
            "--",
            ".",
        ],
        cwd=root,
        timeout=60,
    )
    if log.returncode != 0:
        return None
    history = GitHistory(now=now)
    for chunk in log.stdout.split("\x1e"):
        lines = [line for line in chunk.splitlines() if line.strip()]
        if not lines or not lines[0].strip().isdigit():
            continue
        moment = int(lines[0].strip())
        for name in lines[1:]:
            rel = name.strip()
            if strip and rel.startswith(strip):
                rel = rel[len(strip) :]
            history.times.setdefault(rel, []).append(moment)
    return history


def linked_code(
    doc: str,
    cited_files: set[str],
    cited_symbols: set[str],
    symbol_files: dict[str, set[str]],
    source_files: set[str],
) -> set[str]:
    """The source files a document is about."""
    linked = {f for f in cited_files if f in source_files}
    for name in cited_symbols:
        files = symbol_files.get(name, set())
        if 0 < len(files) <= 3:
            linked |= files
    path = PurePosixPath(doc)
    if path.stem.lower() == "readme" and str(path.parent) not in {"", "."}:
        folder = str(path.parent) + "/"
        inside = sorted(f for f in source_files if f.startswith(folder))
        linked.update(inside[:_MAX_FOLDER_FILES])
    return linked


def stale_docs(
    links: dict[str, set[str]], history: GitHistory | None
) -> dict[str, tuple[int, list[str]]]:
    """For each stale document: since when, and the files committed after it."""
    if history is None:
        return {}
    out: dict[str, tuple[int, list[str]]] = {}
    for doc, files in links.items():
        doc_time = history.last(doc)
        if doc_time is None:
            continue
        after = []
        for rel in files:
            first = history.first_after(rel, doc_time)
            if first is not None:
                after.append((first, rel))
        if after:
            after.sort()
            out[doc] = (after[0][0], [rel for _, rel in after])
    return out


def freshness_score(severities: list[str], stale_days: int | None) -> int:
    score = 100 - sum(_SEVERITY_COST.get(s, 0) for s in severities)
    if stale_days is not None:
        score -= min(40, 10 + 5 * (stale_days // 30))
    return max(0, score)
