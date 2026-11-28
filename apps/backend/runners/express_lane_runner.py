"""
Express lane runner: a project's Dependabot and Renovate PRs, merged by
themselves when their approval tier is N0 and the app enforces the tiers.

Spawned by the Electron main on a timer (``main/express-lane.ts``), for one
local project at a time. One JSON line per bot PR it looked at, then::

  {"result": {"seen": 2, "merged": 1}}      or      {"error": "..."}

Usage::

    python express_lane_runner.py --project-dir <root>
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from pr_followup.express import run_lane  # noqa: E402
from pr_followup.forge import subprocess_gh  # noqa: E402
from security.guardrail_policy import main_project  # noqa: E402


def _emit(payload: dict) -> None:
    print(json.dumps(payload), flush=True)


def run(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Express lane for dependency PRs")
    parser.add_argument("--project-dir", required=True)
    args = parser.parse_args(argv)
    try:
        project = Path(args.project_dir).resolve(strict=True)
        if main_project(project) != project:
            raise ValueError("the express lane runs on a project, not a worktree")
        result = asyncio.run(run_lane(project, subprocess_gh(project), _emit))
    except (OSError, ValueError) as exc:
        _emit({"error": str(exc)[:300]})
        return 1
    _emit({"result": result})
    return 0


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    sys.exit(run(sys.argv[1:]))
