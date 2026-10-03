"""The verification loop from a command line (`verify/`).

    python runners/verify_runner.py --action detect --project-dir .
    python runners/verify_runner.py --action run    --project-dir . [--spec-dir …] [--effort low]
    python runners/verify_runner.py --action replay --project-dir . --spec-dir …
    python runners/verify_runner.py --action status --project-dir . [--spec-dir …]

`detect` and `status` read files only. `run` launches the app and, unless
``--effort low``, runs fixer/verifier sessions on the task's QA provider.
The answer is printed as one line, ``__VERIFY_RESULT__:{json}``, after the
progress lines, so a caller can parse it the way it parses the other runners.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

MARKER = "__VERIFY_RESULT__:"


def _emit(payload: dict) -> None:
    print(MARKER + json.dumps(payload, ensure_ascii=False, default=str), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--action", choices=("detect", "run", "replay", "status"), required=True
    )
    parser.add_argument("--project-dir", default=".")
    parser.add_argument("--spec-dir", default=None)
    parser.add_argument("--effort", default="medium")
    parser.add_argument(
        "--no-agent", action="store_true", help="deterministic steps only"
    )
    args = parser.parse_args()

    project = Path(args.project_dir).resolve()
    spec = Path(args.spec_dir).resolve() if args.spec_dir else None
    if not project.is_dir():
        _emit({"success": False, "error": f"no such directory: {project}"})
        return 1

    if args.action == "detect":
        from verify.detect import detect_targets
        from verify.git import changed_files

        _emit(
            {
                "success": True,
                **detect_targets(project, changed_files(project)).to_dict(),
            }
        )
        return 0

    if args.action == "status":
        from verify.record import load_record
        from verify.settings import load_settings
        from verify.state import work_dir

        record = load_record(work_dir(project, spec))
        _emit(
            {
                "success": True,
                "record": record,
                "settings": load_settings(project).to_dict(),
            }
        )
        return 0

    if args.action == "replay":
        if spec is None:
            _emit({"success": False, "error": "--spec-dir is required for a replay"})
            return 1
        from verify.replay import run_replay

        _emit({"success": True, "replay": asyncio.run(run_replay(project, spec))})
        return 0

    from verify.git import changed_files
    from verify.loop import LoopOptions, run_verify_loop

    runner = None
    provider = ""
    skill_body = ""
    if not args.no_agent and spec is not None:
        from verify.phase import make_agent_runner
        from workflows.runner import find_skill_body, phase_provider

        explicit, provider = phase_provider(spec, "qa")
        found = find_skill_body(
            Path(__file__).resolve().parents[3], "tooling", "verify", provider
        )
        skill_body = found[0] if found else ""
        runner = make_agent_runner(project, spec, model="", provider=explicit)

    record = asyncio.run(
        run_verify_loop(
            project,
            spec,
            runner,
            LoopOptions(
                provider=provider or "",
                effort=args.effort,
                changed_files=changed_files(project),
                skill_body=skill_body,
                log=lambda message: print(message, flush=True),
            ),
        )
    )
    _emit({"success": True, "record": record})
    return 0 if record.get("status") != "fail" else 2


if __name__ == "__main__":
    sys.exit(main())
