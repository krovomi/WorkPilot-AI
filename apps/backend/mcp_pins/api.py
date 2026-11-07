"""The pins of a project for the desktop app: list them, approve a server.

Desktop only: the routes read and write a file of the project's checkout,
named by the path the main process validated (`validated_dir`). In server
mode the feature is not mounted (`LOCAL_ONLY_FEATURES`).
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter
from foundation.api_safety import server_mode_roots, validated_dir
from pydantic import BaseModel, Field

from .store import PinError, approve, server_states

router = APIRouter(prefix="/api/mcp-pins", tags=["mcp-pins"])

_DESKTOP_ONLY = {
    "success": False,
    "error": "MCP tool pins are a desktop feature",
    "reason": "server-mode",
}


class ApproveRequest(BaseModel):
    project_dir: str = ""
    server_id: str = Field(default="", max_length=200)
    confirm_suspicious: bool = False


def _project(project_dir: str) -> Path | None:
    if server_mode_roots() is not None:
        return None
    try:
        return validated_dir(project_dir, "project_dir")
    except ValueError:
        return None


@router.get("")
def list_pins(project_dir: str = "") -> dict:
    """Every pinned server, and what waits for an approval, with its diff."""
    if server_mode_roots() is not None:
        return _DESKTOP_ONLY
    project = _project(project_dir)
    if project is None:
        return {"success": False, "error": "project_dir is required"}
    try:
        return {"success": True, "servers": server_states(project)}
    except PinError as exc:
        return {"success": False, "error": str(exc)}


@router.post("/approve")
def approve_server(request: ApproveRequest) -> dict:
    """The person approves what the last probe of a server listed."""
    if server_mode_roots() is not None:
        return _DESKTOP_ONLY
    project = _project(request.project_dir)
    if project is None or not request.server_id:
        return {"success": False, "error": "project_dir and server_id are required"}
    try:
        approve(
            project,
            request.server_id,
            by="the person",
            confirm_suspicious=request.confirm_suspicious,
        )
    except PinError as exc:
        return {
            "success": False,
            "error": str(exc),
            "suspicious": "poisoned" in str(exc),
        }
    return {"success": True, "servers": server_states(project)}
