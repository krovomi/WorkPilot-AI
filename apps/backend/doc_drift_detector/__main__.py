"""``python -m doc_drift_detector check``: the drift a branch adds, for a CI step (#354).

Compares the working tree with the merge base of ``--target`` (default
``origin/develop``, then ``origin/main``) and reports the doc comments, the
documents and the examples the change set left behind. On GitHub Actions each
problem is an annotation on its line (``::warning``).

Exit code: 0, also when drift is found (the check warns); 1 with ``--strict``
when a high problem is found; 2 when the comparison could not be made (no git,
an unknown target, no merge base).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

from foundation.git_executable import run_git

from .project import scan_project

_REF = re.compile(r"^[\w][\w./@{}^~+-]{0,200}$")


def _changed(root: Path, target: str) -> set[str] | None:
    if not _REF.match(target) or ".." in target:
        return None
    base = run_git(["merge-base", target, "HEAD"], cwd=root, timeout=20)
    if base.returncode != 0:
        return None
    prefix = run_git(
        ["rev-parse", "--show-prefix"], cwd=root, timeout=10
    ).stdout.strip()
    diff = run_git(
        [
            "-c",
            "core.quotePath=false",
            "diff",
            "--name-only",
            base.stdout.strip(),
            "--",
            ".",
        ],
        cwd=root,
        timeout=30,
    )
    if diff.returncode != 0:
        return None
    files = set()
    for line in diff.stdout.splitlines():
        rel = line.strip()
        if prefix and rel.startswith(prefix):
            rel = rel[len(prefix) :]
        if rel:
            files.add(rel)
    return files


def _annotation(issue: dict) -> str:
    message = (
        issue["message"].replace("%", "%25").replace("\r", "").replace("\n", "%0A")
    )
    path = issue["docFile"].replace(",", "%2C").replace(":", "%3A")
    return f"::warning file={path},line={issue['docLine']}::{message}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m doc_drift_detector")
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check", help="the drift the current branch adds")
    check.add_argument("--project", type=Path, default=Path.cwd())
    check.add_argument("--target", default="")
    check.add_argument("--strict", action="store_true")
    check.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    root = args.project.resolve()
    targets = [args.target] if args.target else ["origin/develop", "origin/main"]
    changed = next(
        (c for c in (_changed(root, t) for t in targets) if c is not None), None
    )
    if changed is None:
        print("doc drift: the change set could not be computed", file=sys.stderr)
        return 2
    report = scan_project(root, changed=changed, use_git=False)
    issues = report["issues"]
    if args.json:
        print(json.dumps(report, indent=2, default=str))
    elif os.environ.get("GITHUB_ACTIONS") == "true":
        for issue in issues:
            print(_annotation(issue))
    else:
        for issue in issues:
            print(
                f"{issue['severity']:>6}  {issue['docFile']}:{issue['docLine']}  {issue['message']}"
            )
        print(f"doc drift: {len(issues)} problem(s) in {len(changed)} changed file(s)")
    high = any(i["severity"] == "high" for i in issues)
    return 1 if args.strict and high else 0


if __name__ == "__main__":
    sys.exit(main())
