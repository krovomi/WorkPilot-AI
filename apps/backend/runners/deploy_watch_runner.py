#!/usr/bin/env python3
"""Watch a deployment WorkPilot triggered, or roll it back (#366).

Usage:
    python deploy_watch_runner.py --action watch --project /path --run-id <id>
    python deploy_watch_runner.py --action rollback --project /path --run-id <id>

The run id names a record of `.workpilot/cicd_runs.json`; the endpoints and
tokens come from the environment the app builds from the project's CI/CD
settings. Prints the watch state as JSON.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    from deploy_watch.watch import WatchError, run_rollback, run_watch

    parser = argparse.ArgumentParser(description="Deployment watch runner")
    parser.add_argument("--action", choices=["watch", "rollback"], required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args(argv)

    project = Path(args.project).resolve()
    if not project.is_dir():
        print(json.dumps({"error": "project not found"}), file=sys.stderr)
        return 1
    env = dict(os.environ)
    try:
        if args.action == "watch":
            state = run_watch(project, args.run_id, env)
        else:
            state = run_rollback(project, args.run_id, env)
    except WatchError as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 1
    print(json.dumps(state, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    # Launched without PYTHONPATH: put the backend on the path.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    sys.exit(main())
