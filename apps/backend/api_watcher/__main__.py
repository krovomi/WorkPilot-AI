"""``python -m api_watcher check``: the contract watcher as a CI gate (#389).

Run from ``apps/backend`` (or with it on ``PYTHONPATH``)::

    python -m api_watcher check --project /path/to/repo --target develop
    python -m api_watcher check --project . --fail-on potentially --summary "$GITHUB_STEP_SUMMARY"

Prints the migration guide (Markdown, or the report as JSON with ``--json``)
and exits 1 when a change at or above ``--fail-on`` is not acknowledged in
the contract (``x-breaking-acknowledged``): ``breaking`` (the default),
``potentially``, or ``never`` to report only. Exit 2 when nothing could be
compared (no git, no target branch), so a misconfigured job is not green.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .breaking_change_detector import ChangeCategory
from .compare import compare, valid_ref
from .guide import render

_FAIL_ON = ("breaking", "potentially", "never")


def _failing(report, level: str) -> int:
    if level == "never":
        return 0
    wanted = {ChangeCategory.BREAKING}
    if level == "potentially":
        wanted.add(ChangeCategory.POTENTIALLY_BREAKING)
    return sum(1 for c in report.changes if c.category in wanted and not c.acknowledged)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m api_watcher")
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser(
        "check", help="compare the contracts with the target branch"
    )
    check.add_argument("--project", default=".", help="repository root (default: .)")
    check.add_argument("--target", default="", help="target branch (default: detected)")
    check.add_argument("--base", default="", help="compare with this commit instead")
    check.add_argument("--fail-on", choices=_FAIL_ON, default="breaking")
    check.add_argument("--json", action="store_true", help="print the report as JSON")
    check.add_argument(
        "--summary", default="", help="also append the guide to this file"
    )
    check.add_argument(
        "--no-consumers", action="store_true", help="skip the consumer search"
    )
    args = parser.parse_args(argv)

    for value in (args.target, args.base):
        if value and not valid_ref(value):
            print(f"invalid ref: {value[:60]}", file=sys.stderr)
            return 2
    report = compare(
        Path(args.project),
        target=args.target,
        base=args.base,
        consumers=not args.no_consumers,
    )
    guide = render(report)
    print(json.dumps(report.to_dict(), indent=2) if args.json else guide)
    if args.summary:
        try:
            with open(args.summary, "a", encoding="utf-8") as handle:
                handle.write(guide + "\n")
        except OSError as exc:
            print(f"summary not written: {exc}", file=sys.stderr)
    if report.unchecked:
        return 2
    return 1 if _failing(report, args.fail_on) else 0


if __name__ == "__main__":
    sys.exit(main())
