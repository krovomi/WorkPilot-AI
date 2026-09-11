"""Hermes Runner — the desktop app's and the CLI's window onto `hermes/`.

Whether hermes-agent can learn from this checkout, what it has authored since
the last look, and whether the persona this repository offers is installed. No
LLM and no network: every answer comes from files on disk, which is why the
Kanban can call it on every task panel open.

Output: ``__HERMES_RESULT__:{json}`` — the same convention `mobile_runner`
uses, so the Electron side parses it with code it already has.

    python runners/hermes_runner.py --action doctor
    python runners/hermes_runner.py --action status
    python runners/hermes_runner.py --action cycle --surface kanban
    python runners/hermes_runner.py --action cycle --dry-run
    python runners/hermes_runner.py --action install-soul
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hermes import doctor, install_soul, run_cycle, soul_status  # noqa: E402
from hermes.loop import SURFACES  # noqa: E402

RESULT_MARKER = "__HERMES_RESULT__:"

_REPO_ROOT = Path(__file__).resolve().parents[3]


def _pending(repo_root: Path) -> list[str]:
    try:
        from learning_loop.skill_proposer import proposal_dir

        return sorted(p.name for p in proposal_dir(repo_root).glob("hermes--*.md"))
    except Exception:  # noqa: BLE001 - an unreadable queue is not an outage
        return []


def _doctor(repo_root: Path) -> dict:
    return {"success": True, "readiness": doctor(repo_root).to_dict()}


def _status(repo_root: Path) -> dict:
    return {
        "success": True,
        "readiness": doctor(repo_root).to_dict(),
        "soul": soul_status(repo_root).to_dict(),
        "pending": _pending(repo_root),
        "surfaces": [{"id": k, "description": v} for k, v in SURFACES.items()],
    }


def _cycle(repo_root: Path, surface: str, dry_run: bool) -> dict:
    result = run_cycle(repo_root, surface=surface, write=not dry_run)
    payload = result.to_dict()
    payload["pending"] = _pending(repo_root)
    return {"success": True, "cycle": payload}


def _install_soul(repo_root: Path, overwrite: bool) -> dict:
    changed, message = install_soul(repo_root, overwrite=overwrite)
    return {
        "success": True,
        "changed": changed,
        "message": message,
        "soul": soul_status(repo_root).to_dict(),
    }


def _summary(payload: dict, repo_root: Path) -> str:
    """The line a person reads, from the payload that was already computed.

    Re-running the doctor to print it would answer a second time; the two
    answers could differ, and one of them would be the one nobody saw.
    """
    cycle = payload.get("cycle")
    if cycle and cycle.get("ran"):
        ingest = cycle.get("ingest") or {}
        return (
            f"hermes [{cycle['surface']}]: {ingest.get('found', 0)} authored skill(s) seen, "
            f"{ingest.get('proposed', 0)} proposed, {ingest.get('unchanged', 0)} already pending"
        )
    if "soul" in payload and "readiness" not in payload:
        return f"hermes SOUL.md: {payload.get('message', '')}"
    readiness = (cycle or payload).get("readiness") or {}
    lines = [f"hermes: {readiness.get('state', 'unknown')}"]
    for check in readiness.get("checks", []):
        if check.get("ok"):
            continue
        lines.append(f"  {check['name']}: {check.get('detail') or 'missing'}")
        if check.get("remedy"):
            lines.append(f"    -> {check['remedy']}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="hermes-agent readiness and learning cycle"
    )
    parser.add_argument(
        "--action",
        default="status",
        choices=("doctor", "status", "cycle", "install-soul"),
    )
    parser.add_argument(
        "--surface",
        default="cli",
        help=f"which feature is asking; one of {', '.join(SURFACES)}",
    )
    parser.add_argument("--dry-run", action="store_true", help="report, write nothing")
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="install-soul: replace a different persona (the old one is backed up)",
    )
    parser.add_argument(
        "--repo-root",
        default=str(_REPO_ROOT),
        help="the WorkPilot checkout to answer for (default: this one)",
    )
    parser.add_argument(
        "--quiet", action="store_true", help="emit only the JSON marker"
    )
    args = parser.parse_args()

    repo_root = Path(args.repo_root).expanduser().resolve()

    if args.action == "doctor":
        payload = _doctor(repo_root)
    elif args.action == "status":
        payload = _status(repo_root)
    elif args.action == "cycle":
        payload = _cycle(repo_root, args.surface, args.dry_run)
    else:
        payload = _install_soul(repo_root, args.overwrite)

    if not args.quiet:
        # The human-readable half. A JSON blob is what the UI parses; a person
        # running this in a terminal wants the sentence that names what to fix.
        print(_summary(payload, repo_root))

    print(RESULT_MARKER + json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
