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
    python best_of_n_runner.py arbitrate --project-dir <root> --spec-dir <spec> \\
        [--provider <id> --model <id>]
    python best_of_n_runner.py challenge --project-dir <root> --spec-dir <spec> \\
        --question <text> [--provider <id> --model <id>]
    python best_of_n_runner.py arbiter-metrics --project-dir <root> --spec-dir <spec>

``arbitrate`` and ``challenge`` call the model through ``core.oneshot``, with
the engine main passes for the arbiter (its "Arbiter" model setting).
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
    arbitrate,
    challenge,
    discard,
    parse_variants,
    prepare,
    rank,
)

_SPEC_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_ENGINE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,127}$")
MAX_VARIANTS_JSON = 8192
MAX_QUESTION = 1000


def _engine(args: argparse.Namespace) -> dict[str, str]:
    engine = {}
    for name in ("provider", "model"):
        value = getattr(args, name) or ""
        if value and not _ENGINE_ID.match(value):
            raise BestOfNError(f"invalid {name}")
        if value:
            engine[name] = value
    return engine


def _ask(project: Path, engine: dict[str, str]):
    import asyncio

    from core.oneshot import oneshot_completion

    def ask(system: str, prompt: str) -> str:
        return asyncio.run(
            oneshot_completion(
                prompt,
                system_prompt=system,
                provider=engine.get("provider"),
                model=engine.get("model"),
                project_dir=str(project),
                max_turns=1,
            )
        )

    return ask


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
    if args.command == "arbitrate":
        engine = _engine(args)
        return arbitrate(project, spec, _ask(project, engine), engine)
    if args.command == "challenge":
        question = args.question or ""
        if not question.strip() or len(question) > MAX_QUESTION:
            raise BestOfNError("the question must be 1 to 1000 characters")
        return challenge(project, spec, question, _ask(project, _engine(args)))
    if args.command == "adopt":
        if not _SPEC_NAME.match(args.variant or ""):
            raise BestOfNError("invalid variant name")
        return adopt(project, spec, args.variant)
    return discard(project, spec)


def main() -> None:
    parser = argparse.ArgumentParser(description="Best-of-N for one task")
    parser.add_argument(
        "command",
        choices=(
            "prepare",
            "rank",
            "adopt",
            "discard",
            "arbitrate",
            "challenge",
            "arbiter-metrics",
        ),
    )
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--spec-dir", required=True)
    parser.add_argument("--variants", default="[]")
    parser.add_argument("--variant", default=None)
    parser.add_argument("--provider", default="")
    parser.add_argument("--model", default="")
    parser.add_argument("--question", default="")
    args = parser.parse_args()
    if args.command == "arbiter-metrics":
        from best_of_n.arbiter import metrics

        try:
            project, _spec = _resolve(args)
            _emit({"metrics": metrics(project)})
        except (BestOfNError, OSError) as exc:
            _emit({"error": str(exc)})
            sys.exit(2)
        return
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
