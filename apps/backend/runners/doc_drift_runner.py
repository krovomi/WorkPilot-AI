"""
Doc Drift Runner

Scans a project for documentation that drifts from the actual code
(`doc_drift_detector/project.py`), or, with ``--fix``, makes the simple fixes
named by a previous scan in the folder given (a review card's worktree).

Output protocol (one JSON object per line, prefixed):
    DOC_DRIFT_EVENT:{"type": "progress", "data": {"status": "..."}}
    DOC_DRIFT_RESULT:{...full report dict...}
    DOC_DRIFT_FIX:{"applied": [...], "missing": [...]}
    DOC_DRIFT_ERROR:<message>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from doc_drift_detector.autosync import MAX_FIXES, apply_fixes  # noqa: E402
from doc_drift_detector.project import scan_project  # noqa: E402

MAX_FIX_FILE_BYTES = 400_000


def _emit(prefix: str, payload: Any) -> None:
    print(f"{prefix}:{json.dumps(payload, default=str)}", flush=True)


def _emit_event(event_type: str, data: dict[str, Any]) -> None:
    _emit("DOC_DRIFT_EVENT", {"type": event_type, "data": data})


def run_scan(project_path: Path) -> dict[str, Any]:
    _emit_event("start", {"status": "Discovering documentation files..."})
    result = scan_project(
        project_path, progress=lambda s: _emit_event("progress", {"status": s})
    )
    _emit_event(
        "complete",
        {"issues": len(result["issues"]), "docsScanned": result["docsScanned"]},
    )
    return result


def _fix_ids(list_file: Path) -> list[str]:
    if list_file.stat().st_size > MAX_FIX_FILE_BYTES:
        raise ValueError("the fix list is too large")
    data = json.loads(list_file.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("the fix list must be a JSON list")
    return [i for i in data if isinstance(i, str)][:MAX_FIXES]


def main() -> None:
    parser = argparse.ArgumentParser(description="Doc Drift Runner")
    parser.add_argument("--project-path", required=True, help="Project root path")
    parser.add_argument("--fix", type=Path, help="JSON list of fix ids to make")
    args = parser.parse_args()

    project_path = Path(args.project_path)
    if not project_path.is_dir():
        _emit("DOC_DRIFT_ERROR", f"Project path does not exist: {project_path}")
        sys.exit(1)

    try:
        if args.fix:
            outcome = apply_fixes(project_path, _fix_ids(args.fix))
            _emit(
                "DOC_DRIFT_FIX",
                {"applied": outcome.applied, "missing": outcome.missing},
            )
            return
        _emit("DOC_DRIFT_RESULT", run_scan(project_path))
    except Exception as exc:  # noqa: BLE001
        _emit("DOC_DRIFT_ERROR", str(exc))
        sys.exit(1)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
