"""Run a command confined by Landlock to the paths its policy names.

Usage: ``confined_run.py --policy <file.json> -- <command> [args...]``

The policy is ``{"read_only": [...], "read_write": [...], "list_only": [...]}``:
absolute paths the command may read (and execute), read and write, or only
list. Everything else on the
filesystem is out of its reach, for it and for every process it starts. The
server writes the policy (`server.services.run_isolation`) and starts each
run through this script; nothing a run does can widen it afterwards.

When the machine cannot enforce it, the command is **not** started: the
script exits with status 78 and says why on stderr, which the server records
as the run's error.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

EX_CONFIG = 78


def _paths(value: object) -> list[str]:
    if not isinstance(value, list) or not all(
        isinstance(p, str) and os.path.isabs(p) for p in value
    ):
        raise ValueError("a policy lists absolute paths")
    return value


def main(argv: list[str] | None = None) -> int:
    from foundation.landlock import (
        LandlockUnavailable,
        Rule,
        abi_version,
        restrict_self,
    )

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--policy", type=Path)
    parser.add_argument(
        "--probe", action="store_true", help="print the Landlock ABI and exit"
    )
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)

    if args.probe:
        try:
            print(abi_version())
        except LandlockUnavailable as exc:
            print(f"run isolation unavailable: {exc}", file=sys.stderr)
            return EX_CONFIG
        return 0

    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if args.policy is None or not command:
        parser.error("--policy and a command are required")
    try:
        policy = json.loads(args.policy.read_text(encoding="utf-8"))
        rules = [Rule(p, "read") for p in _paths(policy.get("read_only"))]
        rules += [Rule(p, "write") for p in _paths(policy.get("read_write"))]
        rules += [Rule(p, "list") for p in _paths(policy.get("list_only", []))]
    except (OSError, ValueError, AttributeError) as exc:
        print(f"run isolation: unreadable policy ({exc})", file=sys.stderr)
        return EX_CONFIG
    try:
        restrict_self(rules)
    except (LandlockUnavailable, OSError) as exc:
        print(f"run isolation unavailable: {exc}", file=sys.stderr)
        return EX_CONFIG
    os.execv(command[0], command)
    return 0  # not reached


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    sys.exit(main())
