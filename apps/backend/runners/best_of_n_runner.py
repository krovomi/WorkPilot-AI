"""
Best-of-N runner — spawned by the Electron main process for one task.

The builds themselves are ordinary ``run.py`` processes started by the main
process, one per variant. This runner does what comes before and after them,
one command per call, and prints one JSON line:

  {"state": {...best_of_n.json...}}      or      {"error": "..."}

Usage::

    python best_of_n_runner.py prepare --project-dir <root> --spec-dir <spec> \\
        --variants '[{"provider": "...", "model": "...", "effort": "..."}, ...]'
    python best_of_n_runner.py rank    --project-dir <root> --spec-dir <spec>
    python best_of_n_runner.py adopt   --project-dir <root> --spec-dir <spec> \\
        --variant <spec-id>
    python best_of_n_runner.py discard --project-dir <root> --spec-dir <spec>
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from best_of_n import (  # noqa: E402
    BestOfNError,
    adopt,
    discard,
    parse_variants,
    prepare,
    rank,
)

_SPEC_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
MAX_VARIANTS_JSON = 8192


def _emit(payload: dict) -> None:
    print(json.dumps(payload), flush=True)


def _resolve(args: argparse.Namespace) -> tuple[Path, Path]:
    """project and parent spec directories, resolved and contained."""
    project = Path(args.project_dir).resolve(strict=True)
    spec = Path(args.spec_dir).resolve(strict=True)
    if not _SPEC_NAME.match(spec.name):
        raise BestOfNError("invalid spec name")
    if spec == project or not spec.is_relative_to(project):
        raise BestOfNError("the spec directory is outside the project")
    return project, spec


def _run(args: argparse.Namespace) -> dict:
    project, spec = _resolve(args)
    if args.command == "prepare":
        if len(args.variants) > MAX_VARIANTS_JSON:
            raise BestOfNError("variants is too long")
        try:
            raw = json.loads(args.variants)
        except ValueError as exc:
            raise BestOfNError("variants is not JSON") from exc
        return prepare(project, spec, parse_variants(raw))
    if args.command == "rank":
        return rank(project, spec)
    if args.command == "adopt":
        if not _SPEC_NAME.match(args.variant or ""):
            raise BestOfNError("invalid variant name")
        return adopt(project, spec, args.variant)
    return discard(project, spec)


def main() -> None:
    parser = argparse.ArgumentParser(description="Best-of-N for one task")
    parser.add_argument("command", choices=("prepare", "rank", "adopt", "discard"))
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--spec-dir", required=True)
    parser.add_argument("--variants", default="[]")
    parser.add_argument("--variant", default=None)
    args = parser.parse_args()
    try:
        _emit({"state": _run(args)})
    except BestOfNError as exc:
        _emit({"error": str(exc)})
        sys.exit(2)
    except Exception as exc:  # noqa: BLE001
        _emit({"error": f"{type(exc).__name__}: {exc}"})
        sys.exit(1)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
