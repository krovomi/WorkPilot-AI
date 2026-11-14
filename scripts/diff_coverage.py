#!/usr/bin/env python3
"""Every line a pull request adds or changes is run by a test.

The coverage floors (``--fail-under`` in ci.yml, Vitest ``thresholds``, Jest
``coverageThreshold``) hold the whole suite where it is; this gate holds each
change at 100 %: a changed line the report measures and no test ran fails, and
so does a branch that starts on a changed line and was never taken. Lines the
report does not measure (tests, configuration, files outside the measured
roots, lines marked ``pragma: no cover`` or ``v8 ignore``) are not counted, so
an exclusion stays visible in the diff, where review sees it.

Reports read, with the standard library only:

- Cobertura XML (``coverage xml``, pytest-cov), lines and, when measured, branches;
- Istanbul JSON (``coverage-final.json``: Vitest ``json`` reporter, Jest ``json``),
  statements and branches.

Usage, from anywhere in the repository::

    python scripts/diff_coverage.py --base origin/develop --cobertura apps/backend/coverage.xml
    python scripts/diff_coverage.py --base origin/develop --istanbul apps/frontend/coverage/coverage-final.json

``--base`` is compared with ``HEAD`` through their merge base (``base...HEAD``);
on a pull request's merge commit, ``HEAD^1`` is the base branch's tip. Exit 1
when a changed line is not covered; each one is also printed as a GitHub
annotation.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import xml.etree.ElementTree as ET  # noqa: S405 - reports this job wrote, see read_cobertura
from dataclasses import dataclass, field
from pathlib import Path

HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


@dataclass
class Gaps:
    """What a report says about one file: measured lines, and the ones no test reached."""

    measured: set[int] = field(default_factory=set)
    missed: set[int] = field(default_factory=set)
    #: Line -> how many paths of the branches that start there were never taken.
    branches: dict[int, int] = field(default_factory=dict)

    def merge(self, other: Gaps) -> None:
        self.measured |= other.measured
        self.missed |= other.missed
        for line, count in other.branches.items():
            self.branches[line] = self.branches.get(line, 0) + count


def repo_root() -> Path:
    out = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return Path(out.strip()).resolve()


def changed_lines(base: str, root: Path) -> dict[str, set[int]]:
    """Repository-relative path -> the lines ``HEAD`` adds or changes since ``base``."""
    diff = subprocess.run(
        [
            "git",
            "diff",
            "--unified=0",
            "--no-color",
            "--no-ext-diff",
            "--diff-filter=AMR",
            f"{base}...HEAD",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=True,
        cwd=root,
    ).stdout
    return parse_diff(diff)


def parse_diff(diff: str) -> dict[str, set[int]]:
    changed: dict[str, set[int]] = {}
    current: set[int] | None = None
    for line in diff.splitlines():
        if line.startswith("+++ "):
            target = line[4:]
            current = (
                changed.setdefault(target[2:], set())
                if target.startswith("b/")
                else None
            )
            continue
        match = HUNK.match(line)
        if match and current is not None:
            start, count = int(match.group(1)), int(match.group(2) or "1")
            current.update(range(start, start + count))
    return {path: lines for path, lines in changed.items() if lines}


def _relative(path: Path, root: Path) -> str | None:
    try:
        return path.resolve().relative_to(root).as_posix()
    except ValueError:
        return None


def read_cobertura(report: Path, root: Path) -> dict[str, Gaps]:
    # A report the CI job itself wrote, never external input; Python 3.12+ expat
    # resolves no external entity and caps entity expansion.
    tree = ET.parse(report)  # noqa: S314
    sources = [
        Path(s.text.strip()) for s in tree.iter("source") if s.text and s.text.strip()
    ]
    if not sources:
        sources = [report.parent]
    files: dict[str, Gaps] = {}
    for cls in tree.iter("class"):
        name = cls.get("filename")
        if not name:
            continue
        candidates = (
            [Path(name)] if Path(name).is_absolute() else [s / name for s in sources]
        )
        path = next((p for p in candidates if p.exists()), candidates[0])
        rel = _relative(path, root)
        if rel is None:
            continue
        gaps = Gaps()
        for line in cls.iter("line"):
            number = int(line.get("number", "0"))
            gaps.measured.add(number)
            if line.get("hits", "0") == "0":
                gaps.missed.add(number)
            elif line.get("branch") == "true":
                # "50% (1/2)": paths taken over paths.
                taken = re.search(
                    r"\((\d+)/(\d+)\)", line.get("condition-coverage", "")
                )
                if taken and int(taken.group(1)) < int(taken.group(2)):
                    gaps.branches[number] = int(taken.group(2)) - int(taken.group(1))
        files.setdefault(rel, Gaps()).merge(gaps)
    return files


def read_istanbul(report: Path, root: Path) -> dict[str, Gaps]:
    data = json.loads(report.read_text(encoding="utf-8"))
    files: dict[str, Gaps] = {}
    for key, entry in data.items():
        rel = _relative(Path(entry.get("path", key)), root)
        if rel is None:
            continue
        gaps = Gaps()
        for sid, where in entry.get("statementMap", {}).items():
            first, last = where["start"]["line"], where["end"]["line"]
            lines = set(range(first, last + 1))
            gaps.measured |= lines
            if entry.get("s", {}).get(sid, 0) == 0:
                gaps.missed.add(first)
        for bid, branch in entry.get("branchMap", {}).items():
            counts = entry.get("b", {}).get(bid, [])
            locations = branch.get("locations") or []
            for i, count in enumerate(counts):
                if count:
                    continue
                where = (
                    locations[i]
                    if i < len(locations) and locations[i].get("start", {}).get("line")
                    else branch["loc"]
                )
                line = where["start"]["line"]
                gaps.measured.add(line)
                gaps.branches[line] = gaps.branches.get(line, 0) + 1
        files.setdefault(rel, Gaps()).merge(gaps)
    return files


@dataclass
class Finding:
    path: str
    line: int
    what: str


def compare(
    changed: dict[str, set[int]], measured: dict[str, Gaps]
) -> tuple[list[Finding], int]:
    """(each changed line no test reached, how many changed lines the reports measure)."""
    findings: list[Finding] = []
    counted = 0
    for path in sorted(changed):
        gaps = measured.get(path)
        if gaps is None:
            continue
        lines = changed[path]
        counted += len(lines & gaps.measured)
        for line in sorted(lines & gaps.missed):
            findings.append(Finding(path, line, "never run by a test"))
        for line in sorted(lines & set(gaps.branches)):
            if line in gaps.missed:
                continue
            paths = gaps.branches[line]
            findings.append(
                Finding(
                    path,
                    line,
                    f"{paths} branch path{'s' if paths > 1 else ''} never taken",
                )
            )
    return findings, counted


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--base",
        required=True,
        help="the branch the change goes into, e.g. origin/develop",
    )
    parser.add_argument(
        "--cobertura",
        action="append",
        default=[],
        type=Path,
        help="Cobertura XML report",
    )
    parser.add_argument(
        "--istanbul",
        action="append",
        default=[],
        type=Path,
        help="Istanbul coverage-final.json",
    )
    args = parser.parse_args(argv)
    if not args.cobertura and not args.istanbul:
        parser.error("give at least one report")

    root = repo_root()
    measured: dict[str, Gaps] = {}
    for reader, reports in (
        (read_cobertura, args.cobertura),
        (read_istanbul, args.istanbul),
    ):
        for report in reports:
            for path, gaps in reader(report.resolve(), root).items():
                measured.setdefault(path, Gaps()).merge(gaps)

    findings, counted = compare(changed_lines(args.base, root), measured)
    for f in findings:
        print(
            f"::error file={f.path},line={f.line},title=diff coverage::{f.path}:{f.line} {f.what}"
        )
    if findings:
        print(
            f"{len(findings)} changed line(s) not covered, out of {counted} measured: add a test that runs them."
        )
        return 1
    print(f"Every changed line is covered ({counted} measured).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
