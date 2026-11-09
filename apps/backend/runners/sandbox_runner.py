"""
Sandbox Runner

Two modes, one ``SimulationResult``:

* without ``--spec-dir``: the uncommitted changes of the working tree, diffed
  against ``HEAD`` (``mode = "changes"``), to preview them before a commit;
* with ``--spec-dir``: a rehearsal of the spec's implementation plan over the
  files of ``--base-ref`` (``mode = "plan"``, see :mod:`simulation`), free and
  offline, to catch a broken plan before the build spends any token.

Output protocol (one JSON object per line, prefixed):
    SANDBOX_EVENT:{"type": "progress", "data": {"status": "..."}}
    SANDBOX_RESULT:{"result": {...}}
    SANDBOX_ERROR:<message>
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def _emit(prefix: str, payload: Any) -> None:
    print(f"{prefix}:{json.dumps(payload, default=str)}", flush=True)


def _emit_event(event_type: str, data: dict[str, Any]) -> None:
    _emit("SANDBOX_EVENT", {"type": event_type, "data": data})


def _run_git(project_path: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=str(project_path),
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


HUNK_HEADER = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def _parse_diff(diff_text: str) -> list[dict[str, Any]]:
    files: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    current_hunk: dict[str, Any] | None = None
    pending_lines: list[str] = []

    def flush_hunk() -> None:
        nonlocal current_hunk, pending_lines
        if current_hunk is not None and current is not None:
            current_hunk["content"] = "\n".join(pending_lines)
            current["hunks"].append(current_hunk)
        current_hunk = None
        pending_lines = []

    def flush_file() -> None:
        nonlocal current
        flush_hunk()
        if current is not None:
            files.append(current)
        current = None

    lines = diff_text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("diff --git"):
            flush_file()
            match = re.search(r" a/(.+) b/(.+)$", line)
            path = match.group(2) if match else ""
            current = {
                "filePath": path,
                "changeType": "modified",
                "additions": 0,
                "deletions": 0,
                "hunks": [],
            }
        elif current is not None and line.startswith("new file"):
            current["changeType"] = "added"
        elif current is not None and line.startswith("deleted file"):
            current["changeType"] = "deleted"
        elif current is not None and line.startswith("rename "):
            current["changeType"] = "renamed"
        elif line.startswith("@@"):
            flush_hunk()
            m = HUNK_HEADER.match(line)
            if m and current is not None:
                current_hunk = {
                    "oldStart": int(m.group(1)),
                    "oldCount": int(m.group(2) or 1),
                    "newStart": int(m.group(3)),
                    "newCount": int(m.group(4) or 1),
                    "content": "",
                }
                pending_lines = []
        elif current_hunk is not None and current is not None:
            pending_lines.append(line)
            if line.startswith("+") and not line.startswith("+++"):
                current["additions"] += 1
            elif line.startswith("-") and not line.startswith("---"):
                current["deletions"] += 1
        i += 1

    flush_file()
    return files


def run_scan(project_path: Path, spec_id: str) -> dict[str, Any]:
    _emit_event("start", {"status": "Checking git status..."})

    if not (project_path / ".git").exists():
        raise RuntimeError("Project is not a git repository")

    start = time.time()
    _emit_event("progress", {"status": "Running git diff against HEAD..."})
    diff_text = _run_git(project_path, "diff", "HEAD")
    diffs = _parse_diff(diff_text)

    total_additions = sum(d["additions"] for d in diffs)
    total_deletions = sum(d["deletions"] for d in diffs)
    duration_ms = int((time.time() - start) * 1000)

    result = {
        "id": str(uuid.uuid4()),
        "specId": spec_id,
        "mode": "changes",
        "phase": "awaiting_approval" if diffs else "complete",
        "steps": [],
        "diffs": diffs,
        "totalTokensUsed": 0,
        "estimatedCostUsd": 0.0,
        "estimatedRealCostUsd": 0.0,
        "durationMs": duration_ms,
        "successCount": 0,
        "warningCount": 0,
        "errorCount": 0,
        "createdAt": datetime.now(tz=UTC).isoformat(),
    }

    _emit_event(
        "complete",
        {
            "files": len(diffs),
            "additions": total_additions,
            "deletions": total_deletions,
        },
    )
    return {"result": result}


SPEC_ROOTS = (".workpilot", ".autonomousbuild")


def resolve_spec_dir(project_path: Path, raw: str) -> Path:
    """``raw`` resolved, provided it is a spec folder of this project."""
    spec_dir = Path(raw).resolve()
    for root in SPEC_ROOTS:
        specs = (project_path / root / "specs").resolve()
        if spec_dir.parent == specs and spec_dir.is_dir():
            return spec_dir
    raise RuntimeError("The spec folder is not a spec of this project")


def run_plan(
    project_path: Path, spec_dir: Path, base_ref: str, timeout_s: float
) -> dict[str, Any]:
    from simulation import rehearse_spec

    _emit_event("start", {"status": "Preparing the plan rehearsal..."})
    result = rehearse_spec(
        project_path,
        spec_dir,
        ref=base_ref,
        timeout_s=timeout_s,
        emit=lambda status: _emit_event("progress", {"status": status}),
    )
    _emit_event(
        "complete",
        {"files": len(result["diffs"]), "steps": len(result["steps"])},
    )
    return {"result": result}


def main() -> None:
    parser = argparse.ArgumentParser(description="Sandbox Runner")
    parser.add_argument("--project-path", required=True, help="Project root path")
    parser.add_argument("--spec-id", default="dry-run", help="Spec identifier label")
    parser.add_argument("--spec-dir", help="Rehearse this spec's implementation plan")
    parser.add_argument(
        "--base-ref", default="HEAD", help="Ref the build would start from"
    )
    parser.add_argument(
        "--timeout", type=float, default=60.0, help="Rehearsal budget in seconds"
    )
    args = parser.parse_args()

    project_path = Path(args.project_path).resolve()
    if not project_path.exists():
        _emit("SANDBOX_ERROR", f"Project path does not exist: {project_path}")
        sys.exit(1)

    try:
        if args.spec_dir:
            spec_dir = resolve_spec_dir(project_path, args.spec_dir)
            timeout_s = min(max(args.timeout, 1.0), 600.0)
            result = run_plan(project_path, spec_dir, args.base_ref, timeout_s)
        else:
            result = run_scan(project_path, args.spec_id)
        _emit("SANDBOX_RESULT", result)
    except Exception as exc:  # noqa: BLE001
        _emit("SANDBOX_ERROR", str(exc))
        sys.exit(1)


if __name__ == "__main__":
    # Launched without PYTHONPATH: put the backend on the path for core.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
