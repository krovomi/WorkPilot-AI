"""
Estimation Calibration Runner

The two writes the Smart Estimation dialog asks for on a repository's
calibration (``estimation_calibration``): keep a person's own complexity
score against the estimator's ("Adjust estimate"), and forget everything
learned after a redesign ("Reset calibration"). Prints one
``ESTIMATION_CALIBRATION_RESULT:`` line, or ``ESTIMATION_CALIBRATION_ERROR:``.

Every argument is checked again here (closed category list, scores 1-13),
whatever the Electron main already checked.
"""

import argparse
import json
import sys
from pathlib import Path

# Add the apps/backend directory to the Python path
backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from estimation_calibration import CATEGORIES, load, record_adjustment, reset

RESULT_PREFIX = "ESTIMATION_CALIBRATION_RESULT:"
ERROR_PREFIX = "ESTIMATION_CALIBRATION_ERROR:"


def _fail(message: str) -> int:
    print(f"{ERROR_PREFIX}{message}", flush=True)
    return 1


def run(argv: list[str] | None = None) -> int:
    """Apply one action; returns the exit code."""
    parser = argparse.ArgumentParser(description="Estimation calibration")
    parser.add_argument("--project-path", required=True)
    parser.add_argument("--action", required=True, choices=["adjust", "reset"])
    parser.add_argument("--category", choices=CATEGORIES)
    parser.add_argument("--base-score", type=int)
    parser.add_argument("--adjusted-score", type=int)
    args = parser.parse_args(argv)

    root = Path(args.project_path)
    if not root.is_dir():
        return _fail("project path not found")
    if args.action == "adjust":
        scores = (args.base_score, args.adjusted_score)
        if args.category is None or not all(
            s is not None and 1 <= s <= 13 for s in scores
        ):
            return _fail("adjust needs a category and two scores between 1 and 13")
        written = record_adjustment(
            root, args.category, args.base_score, args.adjusted_score
        )
    else:
        written = reset(root)
    if written is None:
        return _fail("the calibration folder is a symbolic link")
    data = load(root)
    summary = {
        "samples": len(data["samples"]),
        "adjustments": len(data["adjustments"]),
        "reset_at": data["reset_at"],
    }
    print(f"{RESULT_PREFIX}{json.dumps(summary)}", flush=True)
    return 0


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    sys.exit(run())
