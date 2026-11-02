"""
Quality Score Runner

Scores the files a pull request changes, as they are in the project's
working tree, with the static checks of ``review.quality_scorer`` (syntax,
hardcoded secrets, unsafe calls, complexity). No model is called.

Usage:
    python quality_score_runner.py --project-dir <dir> --files a.py b.ts

Output: one line, ``QUALITY_RESULT:{...}`` (``QualityScore.to_dict()``), or
``QUALITY_ERROR:<message>``. A file outside the project directory, or one
that does not exist there, is skipped rather than read.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from review.quality_scorer import QualityScorer  # noqa: E402

MAX_FILES = 500


def files_inside(project_dir: Path, files: list[str]) -> list[str]:
    """The files, relative to the project, that resolve inside it."""
    root = project_dir.resolve()
    kept: list[str] = []
    for name in files[:MAX_FILES]:
        candidate = (root / name).resolve()
        if candidate.is_relative_to(root) and candidate.is_file():
            kept.append(candidate.relative_to(root).as_posix())
    return kept


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--files", nargs="*", default=[])
    args = parser.parse_args(argv)

    project_dir = Path(args.project_dir)
    if not project_dir.is_dir():
        print("QUALITY_ERROR:Project directory not found", flush=True)
        return 1
    scorer = QualityScorer(project_dir.resolve())
    score = scorer.score_pr(changed_files=files_inside(project_dir, args.files))
    print("QUALITY_RESULT:" + json.dumps(score.to_dict()), flush=True)
    return 0


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    sys.exit(main())
