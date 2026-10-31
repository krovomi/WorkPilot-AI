"""
Repo bench runner — spawned by the Electron main process.

The builds are ordinary ``run.py`` processes started by the main process in
each copy. This runner does what comes before and after them, one command per
call, and prints one JSON line: ``{"data": ...}`` or ``{"error": "..."}``.

Usage::

    python bench_runner.py discover --project-dir <root> --specs '["001-x", ...]' \\
        [--commits '{"001-x": "<sha>"}']
    python bench_runner.py prepare  --project-dir <root> --specs '[...]' \\
        --engines '[{"provider": "...", "model": "...", "effort": "..."}]' \\
        [--commits '{...}'] [--run-id <id>]
    python bench_runner.py judge    --project-dir <root> --run-id <id> --build b3 \\
        --outcome ended|not-started|interrupted [--exit-code N] \\
        [--started-at <iso>] [--ended-at <iso>]
    python bench_runner.py discard  --project-dir <root> --run-id <id>
    python bench_runner.py table    --project-dir <root>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from bench import (  # noqa: E402
    MAX_CANDIDATES,
    BenchError,
    discard,
    discover,
    judge_build,
    parse_commits,
    parse_engines,
    parse_specs,
    prepare,
    table,
)

MAX_JSON = 16384


def _emit(payload: dict) -> None:
    print(json.dumps(payload), flush=True)


def _json(value: str | None, name: str):
    if value in (None, ""):
        return None
    if len(value) > MAX_JSON:
        raise BenchError(f"{name} is too long")
    try:
        return json.loads(value)
    except ValueError as exc:
        raise BenchError(f"{name} is not JSON") from exc


def _project(args: argparse.Namespace) -> Path:
    project = Path(args.project_dir).resolve(strict=True)
    if not (project / ".git").exists():
        raise BenchError("the project is not a git repository")
    return project


def _run(args: argparse.Namespace):
    project = _project(args)
    if args.command == "table":
        return {"table": table(project)}
    if args.command == "discover":
        specs = parse_specs(_json(args.specs, "specs"), limit=MAX_CANDIDATES)
        return {
            "cases": discover(
                project, specs, parse_commits(_json(args.commits, "commits"))
            )
        }
    if args.command == "prepare":
        return prepare(
            project,
            parse_specs(_json(args.specs, "specs")),
            parse_engines(_json(args.engines, "engines")),
            parse_commits(_json(args.commits, "commits")),
            run_id=args.run_id,
        )
    if not args.run_id:
        raise BenchError("--run-id is required")
    if args.command == "judge":
        return judge_build(
            project,
            args.run_id,
            args.build or "",
            args.outcome or "",
            exit_code=args.exit_code,
            started_at=args.started_at,
            ended_at=args.ended_at,
        )
    return discard(project, args.run_id)


def main() -> None:
    parser = argparse.ArgumentParser(description="Repo bench")
    parser.add_argument(
        "command", choices=("discover", "prepare", "judge", "discard", "table")
    )
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--specs", default=None)
    parser.add_argument("--engines", default=None)
    parser.add_argument("--commits", default=None)
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--build", default=None)
    parser.add_argument("--outcome", default=None)
    parser.add_argument("--exit-code", type=int, default=None)
    parser.add_argument("--started-at", default=None)
    parser.add_argument("--ended-at", default=None)
    args = parser.parse_args()
    try:
        _emit({"data": _run(args)})
    except (BenchError, FileNotFoundError) as exc:
        _emit({"error": str(exc)})
        sys.exit(2)
    except Exception as exc:  # noqa: BLE001
        _emit({"error": f"{type(exc).__name__}: {exc}"})
        sys.exit(1)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
