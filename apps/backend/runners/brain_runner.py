"""Brain Runner — the CLI's and the desktop app's window onto `brain/`.

Output: ``__BRAIN_RESULT__:{json}`` — the convention the other runners use.

    python runners/brain_runner.py --action init [--remote git@github.com:me/brain.git]
    python runners/brain_runner.py --action status
    python runners/brain_runner.py --action sync            # commit + pull + push
    python runners/brain_runner.py --action pull            # alias of sync, kept for muscle memory
    python runners/brain_runner.py --action push
    python runners/brain_runner.py --action recall --query "auth"
    python runners/brain_runner.py --action read --path knowledge/auth.md
    python runners/brain_runner.py --action remember --text "Toujours répondre en français" --agent codex
    python runners/brain_runner.py --action proposals       # instructions WorkPilot agents proposed
    python runners/brain_runner.py --action promote --path instructions/x.md
    python runners/brain_runner.py --action reject  --path instructions/x.md
    python runners/brain_runner.py --action discover [--project-dir .]
    python runners/brain_runner.py --action ingest [--project-dir .] [--agent claude-code]
    python runners/brain_runner.py --action bridge [--agent codex] [--apply]
    python runners/brain_runner.py --action connect [--agent hermes] [--apply]
    python runners/brain_runner.py --action watch [--interval 30]
    python runners/brain_runner.py --action serve           # the MCP server, on stdio

``bridge`` and ``connect`` write into other tools' files, so they only preview
unless ``--apply`` is given.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from brain import Brain  # noqa: E402
from brain.agents import AGENTS  # noqa: E402
from brain.connect import connect_all  # noqa: E402
from brain.memories import bridge, discover, ingest  # noqa: E402

RESULT_MARKER = "__BRAIN_RESULT__:"

ACTIONS = (
    "init",
    "status",
    "sync",
    "pull",
    "push",
    "recall",
    "read",
    "remember",
    "proposals",
    "promote",
    "reject",
    "discover",
    "ingest",
    "bridge",
    "connect",
    "watch",
    "serve",
)


def _names(args: argparse.Namespace) -> list[str] | None:
    return [args.agent] if args.agent else None


def run(args: argparse.Namespace) -> dict:
    brain = Brain(args.brain_dir)
    action = args.action
    if action == "init":
        return {"success": True, **brain.init(remote=args.remote)}
    if action == "status":
        return {"success": True, **brain.status()}
    if action in ("sync", "pull", "push"):
        result = brain.sync(args.message or f"brain: {action}")
        return {"success": result.error is None, **result.to_dict()}
    if action == "recall":
        return {"success": True, **brain.recall(args.query or "", limit=args.limit)}
    if action == "read":
        return {"success": True, **brain.read(args.path)}
    if action == "remember":
        return {
            "success": True,
            **brain.remember(args.text, agent=args.agent or "brain"),
        }
    if action == "proposals":
        return {"success": True, "proposals": brain.proposals()}
    if action in ("promote", "reject"):
        if not args.path:
            raise ValueError("--path is required")
        status = "active" if action == "promote" else "retired"
        return {"success": True, **brain.set_instruction_status(args.path, status)}
    project = Path(args.project_dir).resolve() if args.project_dir else None
    if action == "discover":
        return {
            "success": True,
            "memories": [m.to_dict() for m in discover(project, _names(args))],
        }
    if action == "ingest":
        if not brain.exists:
            brain.init()
        report = ingest(brain.root, project, _names(args))
        result = brain.after_write("brain: ingest agent memories")
        return {"success": True, **report.to_dict(), "sync": result.to_dict()}
    if action in ("bridge", "connect") and not brain.exists:
        raise ValueError(f"no brain at {brain.root} — run --action init first")
    if action == "bridge":
        names = _names(args) or [a.name for a in AGENTS if a.bridge_file]
        return {
            "success": True,
            "bridges": [
                bridge(brain.root, n, apply=args.apply).to_dict() for n in names
            ],
        }
    if action == "connect":
        results = connect_all(brain.root, apply=args.apply, names=_names(args))
        return {"success": True, "connections": [r.to_dict() for r in results]}
    raise ValueError(f"unknown action {action}")


def watch(brain: Brain, interval: float) -> None:
    """Keep the brain in step with its remote while a person edits it in Obsidian.

    A sync every *interval* seconds: local edits are committed and pushed,
    remote ones pulled. Nothing to do costs one ``git status`` and one fetch.
    """
    print(
        f"watching {brain.root} every {interval:.0f}s — Ctrl+C to stop", file=sys.stderr
    )
    while True:
        result = brain.sync("brain: edits")
        if result.committed or result.pulled or result.conflicts or result.error:
            print(
                RESULT_MARKER + json.dumps(result.to_dict(), ensure_ascii=False),
                flush=True,
            )
        time.sleep(interval)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="WorkPilot Brain")
    parser.add_argument("--action", choices=ACTIONS, default="status")
    parser.add_argument(
        "--brain-dir",
        default=None,
        help="defaults to WORKPILOT_BRAIN_DIR or ~/.workpilot/brain",
    )
    parser.add_argument("--remote", default=None)
    parser.add_argument("--query", default=None)
    parser.add_argument("--path", default=None)
    parser.add_argument("--text", default=None)
    parser.add_argument("--agent", default=None)
    parser.add_argument("--project-dir", default=None)
    parser.add_argument("--message", default=None)
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--interval", type=float, default=30.0)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)

    if args.action == "serve":
        from brain.mcp_server import serve

        serve(Brain(args.brain_dir))
        return 0
    if args.action == "watch":
        try:
            watch(Brain(args.brain_dir), max(5.0, args.interval))
        except KeyboardInterrupt:
            return 0
    try:
        payload = run(args)
    except (ValueError, KeyError, OSError, TypeError) as exc:
        payload = {"success": False, "error": str(exc)}
    print(RESULT_MARKER + json.dumps(payload, ensure_ascii=False, default=str))
    return 0 if payload.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())
