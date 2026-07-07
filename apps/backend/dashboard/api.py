"""Dashboard + Session History endpoints.

Extracted from provider_api.py. Mounted via app.include_router(router).

Frontend traffic: GET /api/sessions/{projectId} is called by
SessionHistory.tsx. Path/method/response shape are preserved verbatim
to avoid breaking that caller.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter

try:
    from provider_api import _safe_error_message
except ImportError:
    from apps.backend.provider_api import _safe_error_message  # type: ignore[no-redef]

router = APIRouter()


def _load_dashboard_snapshot(project_id: str) -> dict:
    """Load dashboard_snapshot.json written by core.usage_tracker.

    project_id is the project path (URL-decoded by FastAPI).
    """
    base_dir = Path.cwd().resolve()
    try:
        project_path = (base_dir / project_id).resolve()
        project_path.relative_to(base_dir)
    except Exception:
        return {}

    if not project_path.is_dir():
        return {}
    snap_path = project_path / ".workpilot" / "dashboard_snapshot.json"
    if snap_path.is_file() and str(snap_path.resolve()).startswith(str(project_path)):
        try:
            return json.loads(snap_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {
        "tasks_by_status": {},
        "avg_completion_by_complexity": {},
        "qa_first_pass_rate": 0.0,
        "qa_avg_score": 0.0,
        "total_tokens": 0,
        "tokens_by_provider": {},
        "total_cost": 0.0,
        "cost_by_model": {},
        "merge_auto_count": 0,
        "merge_manual_count": 0,
    }


@router.get("/api/dashboard/snapshot/{project_id:path}")
def get_dashboard_snapshot(project_id: str):
    try:
        snap = _load_dashboard_snapshot(project_id)
        auto = snap.get("merge_auto_count", 0)
        manual = snap.get("merge_manual_count", 0)
        total_merges = auto + manual
        merge_rate = (auto / total_merges * 100) if total_merges > 0 else 0.0
        snap["merge_auto_rate"] = merge_rate
        avg_compl = {}
        for k, v in snap.get("avg_completion_by_complexity", {}).items():
            if isinstance(v, list) and v:
                avg_compl[k] = sum(v) / len(v)
            else:
                avg_compl[k] = v or 0.0
        snap["avg_completion_by_complexity"] = avg_compl
        return {"success": True, "snapshot": snap}
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


@router.get("/api/dashboard/stats")
def get_dashboard_stats():
    return {"success": True, "stats": {}}


@router.get("/api/dashboard/export/{project_id:path}")
def export_dashboard(project_id: str, fmt: str = "json"):
    try:
        snap = _load_dashboard_snapshot(project_id)
        if fmt == "csv":
            buf = io.StringIO()
            writer = csv.writer(buf)
            writer.writerow(["metric", "value"])
            for k, v in snap.items():
                if not k.startswith("_"):
                    writer.writerow([k, v])
            return {"success": True, "report": buf.getvalue(), "format": "csv"}
        return {"success": True, "report": snap, "format": "json"}
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


# --- Session History ---
def _epoch_to_iso(ts: float | int | None) -> str | None:
    """Convert an epoch-seconds timestamp to an ISO-8601 (UTC) string.

    SessionHistory.tsx feeds these straight into `new Date(...)`, so raw epoch
    floats must become ISO strings here or the dates render as "Invalid Date".
    """
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat()
    except (ValueError, OSError, TypeError, OverflowError):
        return None


def _replay_summary_to_session_entry(summary: dict) -> dict:
    """Map a ReplaySession summary onto the shape SessionHistory.tsx expects.

    The frontend `SessionEntry` uses different key names (task_title,
    tokens_used, files_changed, cost) and ISO date strings.
    """
    raw_status = str(summary.get("status", "")).lower()
    # "recording" == still in flight → surface as "running" for the UI icon/tab.
    status = "running" if raw_status == "recording" else (raw_status or "completed")
    duration = summary.get("duration_seconds")
    return {
        "session_id": summary.get("session_id", ""),
        "task_title": (
            summary.get("task_description")
            or summary.get("agent_name")
            or summary.get("session_id", "")
        ),
        "status": status,
        "started_at": _epoch_to_iso(summary.get("start_time")),
        "ended_at": _epoch_to_iso(summary.get("end_time")),
        "duration_seconds": (
            int(duration) if isinstance(duration, (int, float)) else None
        ),
        "tokens_used": summary.get("total_tokens"),
        "cost": summary.get("total_cost_usd"),
        "files_changed": summary.get("total_file_changes"),
        "project_path": summary.get("project_path", ""),
    }


@router.get("/api/sessions/{project_id}")
def get_sessions(project_id: str):
    """Agent session history for the Session History panel.

    Frontend caller: SessionHistory.tsx — response shape ({success, sessions})
    preserved verbatim.

    Source is the persisted replay store (~/.workpilot/replays/), written by
    every real agent run via replay.recorder. The previous implementation built
    a fresh in-memory agents.session_history.SessionRecorder per request — a
    stub nothing ever populated — so the panel was structurally always empty.

    `project_id` here is the frontend's internal project *id* (e.g.
    "project-001"), which does not map to the filesystem `project_path` stored
    on a session, and the replay store is global rather than project-scoped. So
    we return all sessions (matching GET /replay/sessions) instead of filtering
    on an incompatible key and showing nothing.
    """
    try:
        try:
            from replay.recorder import get_replay_recorder
        except ImportError:
            from apps.backend.replay.recorder import (  # type: ignore[no-redef]
                get_replay_recorder,
            )

        summaries = get_replay_recorder().list_sessions()
        return {
            "success": True,
            "sessions": [_replay_summary_to_session_entry(s) for s in summaries],
        }
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}
