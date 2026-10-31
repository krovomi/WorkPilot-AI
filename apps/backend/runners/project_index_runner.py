#!/usr/bin/env python3
"""Rebuild a project's index: ``<project>/.workpilot/project_index.json``.

The Context view's "refresh" on a server project (`shared_features.context`):
the same analyzer the desktop app runs (`analysis.analyzer`), started as a job
on the server's clone. It runs no model. The file is replaced at once, so a
member reading the index while it is rebuilt sees the old one or the new one.

Usage:
    cd apps/backend
    python runners/project_index_runner.py --project /path/to/project
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

INDEX = Path(".workpilot") / "project_index.json"


def write_index(project: Path) -> Path:
    from analysis.analyzers import analyze_project

    results = analyze_project(project)
    target = project / INDEX
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".project_index.", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(results, handle, indent=2)
        os.replace(tmp, target)
    finally:
        Path(tmp).unlink(missing_ok=True)
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description="Rebuild a project's index")
    parser.add_argument("--project", type=Path, required=True)
    args = parser.parse_args()
    project = args.project.resolve()
    if not project.is_dir():
        print(f"Not a directory: {project}", file=sys.stderr)
        sys.exit(2)
    print("Analyzing the project...", flush=True)
    write_index(project)
    print("Project index updated.", flush=True)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
