"""The dependencies a task added, checked against their registries, and the record.

What blocks, and only that: a package added by the task (absent from the
manifest at the merge base) that its public registry answered 404 for, in a
project that names no other source for that ecosystem and does not already
have it on disk. Everything that is not that is either fine, a warning (a
package first published recently, a name one keystroke from a popular one) or
``unknown`` (the registry did not answer, strict offline mode, a private feed
that may serve it, too many new packages to look up). Unknown never turns
green and never blocks (rule 12).

The record (`<spec>/dependency_guard.json`) is what the hard gate `deps-exist`
reads, so the QA loop and the end-of-build report say the same thing.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from foundation.git_executable import run_git

from .manifests import Package, is_manifest, parse_manifest
from .registries import FOUND, NOT_FOUND, Fetch, Lookup, lookup
from .sources import installed_locally, private_sources
from .typos import near_miss

__all__ = [
    "BLOCKED",
    "OK",
    "RECORD_FILE",
    "UNKNOWN",
    "WARN",
    "Added",
    "Finding",
    "GuardReport",
    "added_packages",
    "check",
    "display_name",
    "load_record",
    "write_record",
]

OK = "ok"
WARN = "warn"
BLOCKED = "blocked"
UNKNOWN = "unknown"

RECORD_FILE = "dependency_guard.json"

#: Above this many new packages in one task, the rest is reported unchecked.
MAX_LOOKUPS = 40
#: A package first published less than this many days ago gets a warning.
RECENT_DAYS = 30
#: A name one keystroke from a popular package warns, unless its registry
#: document is too large to read (`registries.MAX_BODY`): a long history of
#: releases, which `preact` has and a squatted `expresss` does not.
_WORKERS = 8

#: What a name may hold to be shown as is; anything else is shown escaped.
_PLAIN_NAME = re.compile(r"^[\w@./:+~-]{1,214}$")


def display_name(name: str) -> str:
    """A package name fit for a prompt or a log: plain, or escaped and cut."""
    if _PLAIN_NAME.match(name):
        return name
    return json.dumps(name[:80])[1:-1]


@dataclass(frozen=True)
class Added:
    """The packages a task added, and the manifests that could not be read."""

    packages: tuple[Package, ...] = ()
    unreadable: tuple[str, ...] = ()


@dataclass(frozen=True)
class Finding:
    ecosystem: str
    name: str
    manifest: str
    verdict: str
    reason: str
    url: str = ""
    suggestion: str = ""


@dataclass
class GuardReport:
    base: str = ""
    findings: list[Finding] = field(default_factory=list)
    unreadable: list[str] = field(default_factory=list)
    #: Why nothing could be checked at all (gate disabled, change set unknown).
    unchecked: str = ""

    def of(self, verdict: str) -> list[Finding]:
        return [f for f in self.findings if f.verdict == verdict]

    @property
    def status(self) -> str:
        """``blocked`` over ``unknown`` over ``pass``; warnings never decide."""
        if self.of(BLOCKED):
            return BLOCKED
        if self.of(UNKNOWN) or self.unreadable or self.unchecked:
            return UNKNOWN
        return "pass"


def _git_text(project_dir: Path, base: str, path: str) -> str | None:
    """The file at ``base``, or None when it did not exist there."""
    result = run_git(["show", f"{base}:{path}"], cwd=project_dir, timeout=30)
    return result.stdout if result.returncode == 0 else None


def added_packages(project_dir: Path, base: str, files: Iterable[str]) -> Added:
    """Packages declared in the worktree's manifests and not at ``base``.

    A manifest the task deleted adds nothing. A manifest unreadable at the
    base counts as empty there (every package in it is checked, which costs
    lookups, never a false block). One unreadable in the worktree is reported:
    what it adds is not known.
    """
    project_dir = Path(project_dir)
    seen: dict[tuple[str, str], Package] = {}
    unreadable: list[str] = []
    for path in sorted({f for f in files if is_manifest(f)}):
        current = project_dir / path
        if not current.is_file():
            continue
        try:
            now = parse_manifest(path, current.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, ValueError):
            unreadable.append(path)
            continue
        before_text = _git_text(project_dir, base, path)
        try:
            before = parse_manifest(path, before_text) if before_text else set()
        except ValueError:
            before = set()
        before_keys = {p.key for p in before}
        for package in sorted(now):
            if package.key not in before_keys:
                seen.setdefault(package.key, package)
    return Added(tuple(seen.values()), tuple(unreadable))


def _age_days(created: datetime | None, now: datetime) -> int | None:
    return None if created is None else max(0, (now - created).days)


def _judge(
    project_dir: Path,
    package: Package,
    found: Lookup,
    sources: list[str],
    now: datetime,
) -> Finding:
    name = display_name(package.name)
    common = {
        "ecosystem": package.ecosystem,
        "name": name,
        "manifest": package.manifest,
        "url": found.url,
    }
    typo = near_miss(package.ecosystem, package.name) or ""
    if found.presence == NOT_FOUND:
        if sources:
            return Finding(
                **common,
                verdict=UNKNOWN,
                reason="not on the public registry, and the project also gets "
                f"{package.ecosystem} packages from {'; '.join(sources)}",
            )
        if installed_locally(project_dir, package.ecosystem, package.name):
            return Finding(
                **common,
                verdict=UNKNOWN,
                reason="not on the public registry, but already installed here",
            )
        return Finding(
            **common,
            verdict=BLOCKED,
            reason=f"the public registry does not know it ({found.detail})",
            suggestion=typo,
        )
    if found.presence != FOUND:
        return Finding(**common, verdict=UNKNOWN, reason=found.detail)
    age = _age_days(found.created, now)
    if typo and not found.extra.get("large"):
        return Finding(
            **common,
            verdict=WARN,
            reason=f"one keystroke from the popular `{typo}`",
            suggestion=typo,
        )
    if age is not None and age < RECENT_DAYS:
        return Finding(
            **common, verdict=WARN, reason=f"first published {age} day(s) ago"
        )
    return Finding(**common, verdict=OK, reason="found on its registry")


def check(
    project_dir: Path,
    added: Added,
    *,
    fetch: Fetch,
    offline: bool = False,
    base: str = "",
    now: datetime | None = None,
    max_lookups: int = MAX_LOOKUPS,
) -> GuardReport:
    """Ask the registries about the added packages; never raises on a network error.

    ``offline`` (strict offline mode, rule S7) makes no call at all: every
    package is ``unknown``.
    """
    project_dir = Path(project_dir)
    now = now or datetime.now(UTC)
    report = GuardReport(base=base, unreadable=list(added.unreadable))
    packages = list(added.packages)
    if offline:
        report.findings = [
            Finding(
                p.ecosystem,
                display_name(p.name),
                p.manifest,
                UNKNOWN,
                "strict offline mode: no registry was asked",
            )
            for p in packages
        ]
        return report
    asked, skipped = packages[:max_lookups], packages[max_lookups:]
    with ThreadPoolExecutor(max_workers=_WORKERS) as pool:
        answers = list(pool.map(lambda p: lookup(p, fetch), asked))
    sources = {
        eco: private_sources(project_dir, eco) for eco in {p.ecosystem for p in asked}
    }
    report.findings = [
        _judge(project_dir, p, a, sources[p.ecosystem], now)
        for p, a in zip(asked, answers, strict=True)
    ]
    report.findings += [
        Finding(
            p.ecosystem,
            display_name(p.name),
            p.manifest,
            UNKNOWN,
            f"not checked: the task added more than {max_lookups} packages",
        )
        for p in skipped
    ]
    return report


def write_record(spec_dir: Path, report: GuardReport) -> Path:
    path = Path(spec_dir) / RECORD_FILE
    payload = {
        "version": 1,
        "checked_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "base": report.base,
        "status": report.status,
        "unreadable": report.unreadable,
        "unchecked": report.unchecked,
        "findings": [asdict(f) for f in report.findings],
    }
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    return path


def load_record(spec_dir: Path) -> dict | None:
    """The last check's record, or None when there is none or it is unreadable."""
    try:
        data = json.loads((Path(spec_dir) / RECORD_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None
