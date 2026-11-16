"""
Replay API — FastAPI endpoints for the Agent Replay & Debug Mode.

Provides endpoints for:
- Listing, loading, and deleting replay sessions
- Getting session details with full timeline
- File heatmap data
- Breakpoint management
- A/B session comparison
"""

import base64
import binascii
import logging
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import bookmarks as bookmark_store
from .bundle import (
    MAX_BUNDLE_BYTES,
    BundleError,
    ExportOptions,
    build_bundle,
    decode,
    encode,
    file_name,
    session_from_bundle,
)
from .recorder import get_replay_recorder
from .time_travel import get_time_travel_engine
from .viewer import render_viewer

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/replay", tags=["replay"])

SESSION_NOT_FOUND = "Replay session not found"
CHECKPOINT_NOT_FOUND = "Checkpoint not found"
FORK_NOT_FOUND = "Fork not found"


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class AddBreakpointRequest(BaseModel):
    breakpoint_type: str  # tool_call, file_change, decision, error, token_threshold, step_index, pattern_match
    condition: str = ""
    description: str = ""


class CompareSessionsRequest(BaseModel):
    session_a_id: str
    session_b_id: str


class DeleteSessionsRequest(BaseModel):
    session_ids: list[str]


class ExportSessionRequest(BaseModel):
    format: Literal["wpreplay", "html"] = "wpreplay"
    strip_reasoning: bool = False
    strip_tokens: bool = False
    include_file_contents: bool = False
    language: Literal["en", "fr"] = "en"


class ImportSessionRequest(BaseModel):
    # base64 of the file: 4 characters for every 3 bytes, plus padding
    content_base64: str = Field(max_length=(MAX_BUNDLE_BYTES // 3 + 1) * 4)


class AddBookmarkRequest(BaseModel):
    step_index: int = Field(ge=0)
    note: str = Field(default="", max_length=4000)
    author: str = Field(default="", max_length=100)


class AddCheckpointRequest(BaseModel):
    step_index: int
    label: str = ""
    description: str = ""


class ForkSessionRequest(BaseModel):
    checkpoint_id: str
    modified_prompt: str = ""
    additional_instructions: str = ""
    fork_provider: str = ""
    fork_model: str = ""
    fork_base_url: str = ""


# ---------------------------------------------------------------------------
# Session list / CRUD
# ---------------------------------------------------------------------------


@router.get("/sessions")
async def list_sessions():
    """List all saved replay sessions (summaries)."""
    recorder = get_replay_recorder()
    sessions = recorder.list_sessions()
    return {"success": True, "sessions": sessions, "count": len(sessions)}


@router.get(
    "/sessions/{session_id}",
    responses={404: {"description": "Replay session not found"}},
)
async def get_session(session_id: str):
    """Get a complete replay session with all steps."""
    recorder = get_replay_recorder()
    session = recorder.load_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=SESSION_NOT_FOUND)
    return {"success": True, "session": session.to_dict()}


@router.delete(
    "/sessions/{session_id}",
    responses={404: {"description": "Replay session not found"}},
)
async def delete_session(session_id: str):
    """Delete a replay session."""
    recorder = get_replay_recorder()
    deleted = recorder.delete_session(session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=SESSION_NOT_FOUND)
    return {"success": True}


@router.post("/sessions/bulk-delete")
async def bulk_delete_sessions(req: DeleteSessionsRequest):
    """Delete multiple replay sessions at once."""
    recorder = get_replay_recorder()
    deleted_count = 0
    for sid in req.session_ids:
        if recorder.delete_session(sid):
            deleted_count += 1
    return {"success": True, "deleted": deleted_count}


# ---------------------------------------------------------------------------
# Session details
# ---------------------------------------------------------------------------


@router.get(
    "/sessions/{session_id}/steps",
    responses={404: {"description": "Replay session not found"}},
)
async def get_session_steps(
    session_id: str,
    offset: int = 0,
    limit: int = 100,
    step_type: str | None = None,
):
    """Get steps for a session with optional filtering and pagination."""
    recorder = get_replay_recorder()
    session = recorder.load_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=SESSION_NOT_FOUND)

    steps = session.steps
    if step_type:
        steps = [s for s in steps if s.step_type.value == step_type]

    total = len(steps)
    steps = steps[offset : offset + limit]

    return {
        "success": True,
        "steps": [s.to_dict() for s in steps],
        "total": total,
        "offset": offset,
        "limit": limit,
    }


@router.get(
    "/sessions/{session_id}/step/{step_index}",
    responses={404: {"description": "Session or step not found"}},
)
async def get_step_detail(session_id: str, step_index: int):
    """Get detailed info for a specific step."""
    recorder = get_replay_recorder()
    session = recorder.load_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=SESSION_NOT_FOUND)

    if step_index < 0 or step_index >= len(session.steps):
        raise HTTPException(status_code=404, detail="Step not found")

    step = session.steps[step_index]
    return {"success": True, "step": step.to_dict()}


# ---------------------------------------------------------------------------
# Heatmap
# ---------------------------------------------------------------------------


@router.get(
    "/sessions/{session_id}/heatmap",
    responses={404: {"description": "Replay session not found"}},
)
async def get_file_heatmap(session_id: str):
    """Get file heatmap data — frequency of file touches by the agent."""
    recorder = get_replay_recorder()
    session = recorder.load_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=SESSION_NOT_FOUND)

    heatmap = session.file_heatmap()
    max_count = max(heatmap.values()) if heatmap else 1

    entries = [
        {
            "file_path": fp,
            "touch_count": count,
            "intensity": count / max_count,  # 0.0 to 1.0
        }
        for fp, count in heatmap.items()
    ]

    return {
        "success": True,
        "heatmap": entries,
        "total_files": len(entries),
        "max_touches": max_count,
    }


# ---------------------------------------------------------------------------
# Token timeline
# ---------------------------------------------------------------------------


@router.get(
    "/sessions/{session_id}/token-timeline",
    responses={404: {"description": "Replay session not found"}},
)
async def get_token_timeline(session_id: str):
    """Get token consumption over time for charting."""
    recorder = get_replay_recorder()
    session = recorder.load_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=SESSION_NOT_FOUND)

    return {
        "success": True,
        "timeline": session.token_timeline(),
        "total_tokens": session.total_tokens,
        "total_cost_usd": session.total_cost_usd,
    }


# ---------------------------------------------------------------------------
# Tool usage stats
# ---------------------------------------------------------------------------


@router.get(
    "/sessions/{session_id}/tool-stats",
    responses={404: {"description": "Replay session not found"}},
)
async def get_tool_stats(session_id: str):
    """Get tool usage statistics for a session."""
    recorder = get_replay_recorder()
    session = recorder.load_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=SESSION_NOT_FOUND)

    stats = session.tool_usage_stats()
    return {
        "success": True,
        "tool_stats": stats,
        "total_tool_calls": session.total_tool_calls,
    }


# ---------------------------------------------------------------------------
# Breakpoints
# ---------------------------------------------------------------------------


@router.get(
    "/sessions/{session_id}/breakpoints",
    responses={404: {"description": "Replay session not found"}},
)
async def get_breakpoints(session_id: str):
    """Get breakpoints for a session."""
    recorder = get_replay_recorder()
    session = recorder.load_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=SESSION_NOT_FOUND)

    return {
        "success": True,
        "breakpoints": [b.to_dict() for b in session.breakpoints],
    }


@router.post(
    "/sessions/{session_id}/breakpoints",
    responses={404: {"description": "Session not active or not found"}},
)
async def add_breakpoint(session_id: str, req: AddBreakpointRequest):
    """Add a breakpoint to an active session."""
    recorder = get_replay_recorder()
    bp = recorder.add_breakpoint(
        session_id,
        breakpoint_type=req.breakpoint_type,
        condition=req.condition,
        description=req.description,
    )
    if not bp:
        raise HTTPException(status_code=404, detail="Session not active or not found")
    return {"success": True, "breakpoint": bp.to_dict()}


@router.delete(
    "/sessions/{session_id}/breakpoints/{breakpoint_id}",
    responses={404: {"description": "Session or breakpoint not found"}},
)
async def remove_breakpoint(session_id: str, breakpoint_id: str):
    """Remove a breakpoint from a session."""
    recorder = get_replay_recorder()
    removed = recorder.remove_breakpoint(session_id, breakpoint_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Session or breakpoint not found")
    return {"success": True}


# ---------------------------------------------------------------------------
# Sharing: export, import, bookmarks (#347)
# ---------------------------------------------------------------------------

_BOOKMARK_REFUSALS = {
    "recording": (409, "The session is still recording"),
    "not_found": (404, SESSION_NOT_FOUND),
    "no_such_step": (422, "The session has no such step"),
    "too_many": (422, "The session has too many bookmarks"),
}


@router.post(
    "/sessions/{session_id}/export",
    responses={404: {"description": SESSION_NOT_FOUND}},
)
async def export_session(session_id: str, req: ExportSessionRequest):
    """The session as a `.wpreplay` bundle or a standalone page, masked."""
    session = get_replay_recorder().load_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=SESSION_NOT_FOUND)
    options = ExportOptions(
        strip_reasoning=req.strip_reasoning,
        strip_tokens=req.strip_tokens,
        include_file_contents=req.include_file_contents,
    )
    bundle = build_bundle(session, options)
    if req.format == "html":
        content = render_viewer(bundle, req.language).encode("utf-8")
        name = file_name(session, ".html")
    else:
        content = encode(bundle)
        name = file_name(session)
    return {
        "success": True,
        "file_name": name,
        "content_base64": base64.b64encode(content).decode("ascii"),
    }


@router.post("/import", responses={422: {"description": "Not a readable bundle"}})
async def import_session(req: ImportSessionRequest):
    """Store the session of a `.wpreplay` bundle as a new local session."""
    try:
        data = base64.b64decode(req.content_base64, validate=True)
        session = session_from_bundle(decode(data))
    except (binascii.Error, BundleError) as error:
        code = error.args[0] if isinstance(error, BundleError) else "unreadable"
        raise HTTPException(status_code=422, detail=code) from error
    recorder = get_replay_recorder()
    recorder.save_session(session)
    return {"success": True, "session": session.to_summary()}


@router.post(
    "/sessions/{session_id}/bookmarks",
    responses={404: {"description": SESSION_NOT_FOUND}},
)
async def add_bookmark(session_id: str, req: AddBookmarkRequest):
    """Mark a step of a saved session with a note."""
    try:
        bookmark = bookmark_store.add_bookmark(
            get_replay_recorder(), session_id, req.step_index, req.note, req.author
        )
    except bookmark_store.BookmarkError as error:
        status, detail = _BOOKMARK_REFUSALS[error.code]
        raise HTTPException(status_code=status, detail=detail) from error
    return {"success": True, "bookmark": bookmark.to_dict()}


@router.delete(
    "/sessions/{session_id}/bookmarks/{bookmark_id}",
    responses={404: {"description": "Bookmark not found"}},
)
async def remove_bookmark(session_id: str, bookmark_id: str):
    """Remove a bookmark from a saved session."""
    if not bookmark_store.remove_bookmark(
        get_replay_recorder(), session_id, bookmark_id
    ):
        raise HTTPException(status_code=404, detail="Bookmark not found")
    return {"success": True}


# ---------------------------------------------------------------------------
# A/B Comparison
# ---------------------------------------------------------------------------


@router.post(
    "/compare",
    responses={
        404: {"description": "Session A or B not found"},
        500: {"description": "Failed to compare sessions"},
    },
)
async def compare_sessions(req: CompareSessionsRequest):
    """Compare two replay sessions side by side (A/B comparison)."""
    recorder = get_replay_recorder()

    session_a = recorder.load_session(req.session_a_id)
    session_b = recorder.load_session(req.session_b_id)

    if not session_a:
        raise HTTPException(
            status_code=404, detail=f"Session A not found: {req.session_a_id}"
        )
    if not session_b:
        raise HTTPException(
            status_code=404, detail=f"Session B not found: {req.session_b_id}"
        )

    comparison = recorder.compare_sessions(req.session_a_id, req.session_b_id)
    if not comparison:
        raise HTTPException(status_code=500, detail="Failed to compare sessions")

    return {
        "success": True,
        "comparison": comparison.to_dict(),
        "session_a": session_a.to_summary(),
        "session_b": session_b.to_summary(),
    }


# ---------------------------------------------------------------------------
# Time Travel - Checkpoints
# ---------------------------------------------------------------------------


@router.post(
    "/sessions/{session_id}/checkpoints/generate",
    responses={404: {"description": "Replay session not found"}},
)
async def generate_checkpoints(session_id: str):
    """Generate checkpoints for all decision points in a session."""
    recorder = get_replay_recorder()
    session = recorder.load_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=SESSION_NOT_FOUND)
    engine = get_time_travel_engine()
    checkpoints = engine.create_checkpoints_for_session(session_id)
    return {
        "success": True,
        "checkpoints": [cp.to_dict() for cp in checkpoints],
        "count": len(checkpoints),
    }


@router.get("/sessions/{session_id}/checkpoints")
async def get_checkpoints(session_id: str):
    """Get all checkpoints for a session."""
    engine = get_time_travel_engine()
    checkpoints = engine.get_checkpoints(session_id)
    return {
        "success": True,
        "checkpoints": [cp.to_dict() for cp in checkpoints],
        "count": len(checkpoints),
    }


@router.get(
    "/sessions/{session_id}/checkpoints/{checkpoint_id}",
    responses={404: {"description": "Checkpoint not found"}},
)
async def get_checkpoint(session_id: str, checkpoint_id: str):
    """Get a specific checkpoint with full conversation history."""
    engine = get_time_travel_engine()
    checkpoint = engine.get_checkpoint(session_id, checkpoint_id)
    if not checkpoint:
        raise HTTPException(status_code=404, detail=CHECKPOINT_NOT_FOUND)
    return {"success": True, "checkpoint": checkpoint.to_dict()}


@router.post(
    "/sessions/{session_id}/checkpoints",
    responses={404: {"description": "Replay session not found"}},
)
async def add_manual_checkpoint(session_id: str, req: AddCheckpointRequest):
    """Add a manual checkpoint at a specific step index."""
    engine = get_time_travel_engine()
    checkpoint = engine.add_manual_checkpoint(
        session_id,
        step_index=req.step_index,
        label=req.label,
        description=req.description,
    )
    if not checkpoint:
        raise HTTPException(status_code=404, detail=SESSION_NOT_FOUND)
    return {"success": True, "checkpoint": checkpoint.to_dict()}


@router.delete(
    "/sessions/{session_id}/checkpoints/{checkpoint_id}",
    responses={404: {"description": "Checkpoint not found"}},
)
async def delete_checkpoint(session_id: str, checkpoint_id: str):
    """Delete a checkpoint."""
    engine = get_time_travel_engine()
    deleted = engine.delete_checkpoint(session_id, checkpoint_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=CHECKPOINT_NOT_FOUND)
    return {"success": True}


# ---------------------------------------------------------------------------
# Time Travel - Fork & Re-execute
# ---------------------------------------------------------------------------


@router.post(
    "/sessions/{session_id}/fork",
    responses={404: {"description": "Checkpoint not found"}},
)
async def fork_session(session_id: str, req: ForkSessionRequest):
    """Fork a session at a checkpoint for re-execution with any LLM."""
    from .models import ForkRequest as ForkRequestModel

    engine = get_time_travel_engine()
    checkpoint = engine.get_checkpoint(session_id, req.checkpoint_id)
    if not checkpoint:
        raise HTTPException(status_code=404, detail=CHECKPOINT_NOT_FOUND)

    fork_request = ForkRequestModel(
        checkpoint_id=req.checkpoint_id,
        session_id=session_id,
        modified_prompt=req.modified_prompt,
        additional_instructions=req.additional_instructions,
        fork_provider=req.fork_provider,
        fork_model=req.fork_model,
        fork_base_url=req.fork_base_url,
    )
    fork = engine.create_fork(fork_request)
    return {"success": True, "fork": fork.to_dict()}


@router.get("/forks")
async def list_all_forks(session_id: str | None = None):
    """List all forks, optionally filtered by session."""
    engine = get_time_travel_engine()
    forks = engine.list_forks(session_id)
    return {"success": True, "forks": [f.to_dict() for f in forks], "count": len(forks)}


@router.get(
    "/forks/{fork_id}",
    responses={404: {"description": "Fork not found"}},
)
async def get_fork(fork_id: str):
    """Get a specific fork."""
    engine = get_time_travel_engine()
    fork = engine.get_fork(fork_id)
    if not fork:
        raise HTTPException(status_code=404, detail=FORK_NOT_FOUND)
    return {"success": True, "fork": fork.to_dict()}


@router.get(
    "/forks/{fork_id}/context",
    responses={404: {"description": "Fork not found"}},
)
async def get_fork_context(fork_id: str):
    """Get the provider-agnostic re-execution context for a fork."""
    engine = get_time_travel_engine()
    context = engine.get_fork_context(fork_id)
    if not context:
        raise HTTPException(status_code=404, detail=FORK_NOT_FOUND)
    return {"success": True, "context": context}


@router.patch(
    "/forks/{fork_id}/status",
    responses={404: {"description": "Fork not found"}},
)
async def update_fork_status(fork_id: str, status: str):
    """Update the status of a fork."""
    engine = get_time_travel_engine()
    updated = engine.update_fork_status(fork_id, status)
    if not updated:
        raise HTTPException(status_code=404, detail=FORK_NOT_FOUND)
    return {"success": True}


@router.delete(
    "/forks/{fork_id}",
    responses={404: {"description": "Fork not found"}},
)
async def delete_fork(fork_id: str):
    """Delete a fork."""
    engine = get_time_travel_engine()
    deleted = engine.delete_fork(fork_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=FORK_NOT_FOUND)
    return {"success": True}


# ---------------------------------------------------------------------------
# Time Travel - Decision Scoring & Heatmap
# ---------------------------------------------------------------------------


@router.post(
    "/sessions/{session_id}/decisions/score",
    responses={404: {"description": "Replay session not found"}},
)
async def score_decisions(session_id: str):
    """Analyze and score all decision points in a session."""
    recorder = get_replay_recorder()
    session = recorder.load_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=SESSION_NOT_FOUND)
    engine = get_time_travel_engine()
    scores = engine.score_decisions(session_id)
    return {
        "success": True,
        "scores": [s.to_dict() for s in scores],
        "count": len(scores),
        "critical_count": sum(1 for s in scores if s.is_critical),
    }


@router.get("/sessions/{session_id}/decisions/scores")
async def get_decision_scores(session_id: str):
    """Get previously computed decision scores."""
    engine = get_time_travel_engine()
    scores = engine.get_decision_scores(session_id)
    return {
        "success": True,
        "scores": [s.to_dict() for s in scores],
        "count": len(scores),
    }


@router.get(
    "/sessions/{session_id}/decisions/heatmap",
    responses={404: {"description": "Replay session not found"}},
)
async def get_decision_heatmap(session_id: str):
    """Get the decision heatmap for a session."""
    engine = get_time_travel_engine()
    heatmap = engine.get_decision_heatmap(session_id)
    if not heatmap:
        raise HTTPException(status_code=404, detail=SESSION_NOT_FOUND)
    return {"success": True, "heatmap": heatmap}
