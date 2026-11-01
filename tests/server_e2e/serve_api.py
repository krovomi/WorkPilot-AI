"""Start the server's API as ``deploy/server-entrypoint.sh`` does, with the
fake agent in place of the model.

``python -m uvicorn provider_api:app`` is what the image runs. This is the
same app under the same server, with one change made before it is imported:
the directory a run starts its agent from (``run_manager.BACKEND_DIR``,
``run.py`` and ``runners/spec_runner.py``) is ``fake_backend/``. Everything
around the agent stays the server's own: the queue, the confinement, the
run's environment and stream token, the project jobs (which keep the real
runners).

Usage: ``serve_api.py --port <port>``, from ``apps/backend``.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[1] / "apps" / "backend"
FAKE_BACKEND = HERE / "fake_backend"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()

    sys.path.insert(0, str(BACKEND))
    # project_jobs takes its own copy of BACKEND_DIR when imported: import it
    # first so that the feature jobs keep the real runners.
    from server.services import project_jobs, run_manager

    real = run_manager.BACKEND_DIR
    run_manager.BACKEND_DIR = FAKE_BACKEND
    if project_jobs.BACKEND_DIR != real:
        raise SystemExit("project jobs would start the fake agent too")

    import uvicorn

    uvicorn.run(
        "provider_api:app", host="127.0.0.1", port=args.port, log_level="warning"
    )


if __name__ == "__main__":
    main()
