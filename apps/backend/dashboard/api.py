"""Session History endpoint.

Extracted from provider_api.py. Mounted via app.include_router(router).

Frontend traffic: GET /api/sessions/{projectId}, from the replay IPC handler
for SessionHistory.tsx. Path/method/response shape are preserved verbatim to
avoid breaking that caller. The dashboard itself is built by the desktop main
process from the project's ledgers (``workspace-ledgers.ts``), not here.

This route reads the replay store of the home directory: it answers only in
local mode. A server project's workspace views are
``shared_features.workspace``, by project.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from foundation.api_safety import safe_error, server_mode_roots

logger = logging.getLogger(__name__)


def _desktop_only() -> None:
    if server_mode_roots() is not None:
        raise HTTPException(status_code=404, detail="Not served in server mode")


router = APIRouter(dependencies=[Depends(_desktop_only)])


# --- Session History ---
def _epoch_to_iso(ts: float | int | None) -> str | None:
    """Convert an epoch-seconds timestamp to an ISO-8601 (UTC) string.

    SessionHistory.tsx feeds these straight into `new Date(...)`, so raw epoch
    floats must become ISO strings here or the dates render as "Invalid Date".
    """
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(float(ts), tz=UTC).isoformat()
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
        from replay.recorder import get_replay_recorder

        summaries = get_replay_recorder().list_sessions()
        return {
            "success": True,
            "sessions": [_replay_summary_to_session_entry(s) for s in summaries],
        }
    except Exception as e:
        return {"success": False, "error": safe_error(e, logger, "Session history")}
