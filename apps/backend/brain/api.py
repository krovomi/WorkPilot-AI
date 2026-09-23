"""``/api/brain`` — the desktop app's view of the shared brain.

Refused in server mode, like `hermes/api.py`: the brain lives in the home
directory of the machine running the backend, which on a shared deployment is
the server's and not the tenant's.
"""

from __future__ import annotations

from core.api_safety import server_mode_roots
from fastapi import APIRouter
from pydantic import BaseModel

from .memories import discover
from .vault import Brain

router = APIRouter(prefix="/api/brain", tags=["brain"])

_DESKTOP_ONLY = {
    "success": False,
    "error": "the shared brain is a desktop feature",
    "reason": "server-mode",
}


class SyncRequest(BaseModel):
    message: str = "brain: sync"


class RecallRequest(BaseModel):
    query: str
    limit: int = 5


@router.get("/status")
def status() -> dict:
    if server_mode_roots() is not None:
        return _DESKTOP_ONLY
    brain = Brain()
    return {
        "success": True,
        **brain.status(),
        "memories": [m.to_dict() for m in discover() if m.exists],
    }


@router.post("/sync")
def sync(request: SyncRequest) -> dict:
    if server_mode_roots() is not None:
        return _DESKTOP_ONLY
    result = Brain().sync(request.message)
    return {"success": result.error is None, **result.to_dict()}


@router.post("/recall")
def recall(request: RecallRequest) -> dict:
    if server_mode_roots() is not None:
        return _DESKTOP_ONLY
    return {"success": True, **Brain().recall(request.query, limit=request.limit)}
