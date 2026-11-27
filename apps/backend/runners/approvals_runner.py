"""
Approval tier runner: the tier of a task's pull request, as one JSON line.

Spawned by the Electron main (and usable from a terminal or a CI job). Reads
the committed change set of the worktree from the merge base of
``--base-branch`` to ``--head``, the policy of the main checkout, and the
facts the caller measured (CI state, cross-review verdict, trust score).
Decides nothing about merging by itself: it prints the decision, and the
caller merges only when ``decision.merges`` is true.

Output::

  {"decision": {...Decision.to_dict()...}}      or      {"error": "..."}

Usage::

    python approvals_runner.py --project-dir <root> [--worktree-dir <wt>] \\
        --base-branch develop [--head HEAD] --title "fix(api): …" \\
        [--kind bug_fix] [--label x]… [--ci green] [--review agree] [--trust 90]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from approvals import (  # noqa: E402
    build_facts,
    changed_files,
    clean_layers_touched,
    decide,
    load_approval_policy,
)
from approvals.model import CI_STATES, REVIEW_STATES  # noqa: E402
from security.guardrail_policy import main_project  # noqa: E402

MAX_TITLE_CHARS = 300


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Approval tier of a pull request")
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--worktree-dir")
    parser.add_argument("--base-branch", required=True)
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--title", default="")
    parser.add_argument("--kind")
    parser.add_argument("--label", action="append", default=[])
    parser.add_argument("--ci", choices=CI_STATES, default="unknown")
    parser.add_argument("--review", choices=REVIEW_STATES, default="none")
    parser.add_argument("--trust", type=int)
    return parser


def run(argv: list[str]) -> dict:
    args = _parser().parse_args(argv)
    project = Path(args.project_dir).resolve(strict=True)
    worktree = (
        Path(args.worktree_dir).resolve(strict=True) if args.worktree_dir else project
    )
    if main_project(worktree) != main_project(project):
        raise ValueError("the worktree does not belong to the project")
    files = changed_files(worktree, args.base_branch, args.head)
    if files is None:
        raise ValueError("git could not list the change set")
    paths = [f.path for f in files]
    facts = build_facts(
        files,
        title=(args.title or "")[:MAX_TITLE_CHARS],
        kind=args.kind,
        # A remote-tracking ref (the stack autopilot's ``origin/develop``) is
        # judged as the branch it tracks, so a rule on ``pr/base`` reads one name.
        base=args.base_branch.removeprefix("origin/"),
        labels=args.label,
        ci=args.ci,
        review=args.review,
        trust=args.trust,
        layers=clean_layers_touched(main_project(project), paths),
    )
    return decide(facts, load_approval_policy(project)).to_dict()


def main() -> int:
    try:
        decision = run(sys.argv[1:])
    except (OSError, ValueError) as exc:
        print(json.dumps({"error": str(exc)}), flush=True)
        return 1
    print(json.dumps({"decision": decision}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
