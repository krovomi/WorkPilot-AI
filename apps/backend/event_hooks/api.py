"""Event-Driven Hooks System API.

CRUD + execution endpoints for the user-defined hook system (services/hooks/).
Extracted from provider_api.py; mounted via app.include_router(router).

Module is named `event_hooks` (not `hooks`) because `apps/backend/hooks/`
already exists for git pre-commit infrastructure, and `webhooks` would
suggest outbound HTTP callbacks rather than internal event reactions.

Frontend traffic — every call originates from
apps/frontend/src/renderer/stores/hooks-store.ts. URL / method / body /
response shape preserved verbatim:

  GET    /api/hooks                       (list, optional ?project_id=)
  GET    /api/hooks/stats
  GET    /api/hooks/templates
  GET    /api/hooks/executions/history    (NOTE: must register before
                                           /api/hooks/{hook_id} below so
                                           "executions" isn't matched
                                           as a hook_id path param)
  GET    /api/hooks/{hook_id}
  POST   /api/hooks                       (create)
  POST   /api/hooks/emit                  (registered before
                                           /api/hooks/{hook_id}/... routes)
  POST   /api/hooks/from-template
  POST   /api/hooks/{hook_id}/toggle
  POST   /api/hooks/{hook_id}/duplicate
  PUT    /api/hooks/{hook_id}
  DELETE /api/hooks/{hook_id}

Route ordering matters: literal-path routes must be declared BEFORE
templated routes that could shadow them.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Annotated, Any

from fastapi import APIRouter, Body, HTTPException, Path, Query
from foundation.api_safety import safe_error

if TYPE_CHECKING:
    from services.hooks.hook_service import HookService

logger = logging.getLogger(__name__)

HOOK_NOT_FOUND = "Hook not found"
TEMPLATE_NOT_FOUND = "Template not found"


def _safe_error_message(e: Exception) -> str:
    """What the caller sees of a failure: its kind, never its text."""
    return safe_error(e, logger, "Hooks")


def _service() -> HookService:
    from services.hooks.hook_service import HookService

    return HookService.get_instance()


router = APIRouter()


# ── Literal-path GETs first (must precede /api/hooks/{hook_id}) ────────


@router.get("/api/hooks")
def list_hooks(project_id: Annotated[str | None, Query()] = None):
    """List all hooks, optionally filtered by project."""
    try:
        svc = _service()
        hooks = svc.list_hooks(project_id)
        return {"success": True, "hooks": hooks}
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


@router.get("/api/hooks/stats")
def get_hooks_stats():
    """Get overall hook system statistics."""
    try:
        svc = _service()
        stats = svc.get_stats()
        return {"success": True, "stats": stats}
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


@router.get("/api/hooks/templates")
def get_hook_templates():
    """Get all available hook templates."""
    try:
        svc = _service()
        templates = svc.get_templates()
        return {"success": True, "templates": templates}
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


@router.get("/api/hooks/executions/history")
def get_hook_executions(
    hook_id: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query()] = 50,
):
    """Get execution history for hooks."""
    try:
        svc = _service()
        executions = svc.get_executions(hook_id, limit)
        return {"success": True, "executions": executions}
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


# ── Literal POSTs ─────────────────────────────────────────────────────


@router.post("/api/hooks")
def create_hook(body: Annotated[dict[str, Any], Body(...)]):
    """Create a new hook."""
    try:
        svc = _service()
        hook = svc.create_hook(body)
        return {"success": True, "hook": hook}
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


@router.post("/api/hooks/emit")
async def emit_hook_event(body: Annotated[dict[str, Any], Body(...)]):
    """Emit an event to trigger matching hooks."""
    try:
        from services.hooks.models import HookEvent, TriggerType

        svc = _service()
        event = HookEvent(
            type=TriggerType(body.get("type", "manual")),
            data=body.get("data", {}),
            project_id=body.get("project_id"),
            source=body.get("source", "api"),
        )
        results = await svc.emit_event(event)
        return {
            "success": True,
            "executions": results,
            "hooks_triggered": len(results),
        }
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


@router.post(
    "/api/hooks/from-template",
    responses={404: {"description": TEMPLATE_NOT_FOUND}},
)
def create_hook_from_template(body: Annotated[dict[str, Any], Body(...)]):
    """Create a hook from a template."""
    try:
        svc = _service()
        template_id = body.get("template_id", "")
        project_id = body.get("project_id")
        hook = svc.create_from_template(template_id, project_id)
        if not hook:
            raise HTTPException(status_code=404, detail=TEMPLATE_NOT_FOUND)
        return {"success": True, "hook": hook}
    except HTTPException:
        raise
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


# ── Templated routes (must come AFTER all literal /api/hooks/* paths) ──


@router.get(
    "/api/hooks/{hook_id}",
    responses={404: {"description": HOOK_NOT_FOUND}},
)
def get_hook(hook_id: Annotated[str, Path(...)]):
    """Get a single hook by ID."""
    try:
        svc = _service()
        hook = svc.get_hook(hook_id)
        if not hook:
            raise HTTPException(status_code=404, detail=HOOK_NOT_FOUND)
        return {"success": True, "hook": hook}
    except HTTPException:
        raise
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


@router.put(
    "/api/hooks/{hook_id}",
    responses={404: {"description": HOOK_NOT_FOUND}},
)
def update_hook(
    hook_id: Annotated[str, Path(...)],
    body: Annotated[dict[str, Any], Body(...)],
):
    """Update an existing hook."""
    try:
        svc = _service()
        hook = svc.update_hook(hook_id, body)
        if not hook:
            raise HTTPException(status_code=404, detail=HOOK_NOT_FOUND)
        return {"success": True, "hook": hook}
    except HTTPException:
        raise
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


@router.delete(
    "/api/hooks/{hook_id}",
    responses={404: {"description": HOOK_NOT_FOUND}},
)
def delete_hook(hook_id: Annotated[str, Path(...)]):
    """Delete a hook."""
    try:
        svc = _service()
        deleted = svc.delete_hook(hook_id)
        if not deleted:
            raise HTTPException(status_code=404, detail=HOOK_NOT_FOUND)
        return {"success": True}
    except HTTPException:
        raise
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


@router.post(
    "/api/hooks/{hook_id}/toggle",
    responses={404: {"description": HOOK_NOT_FOUND}},
)
def toggle_hook(hook_id: Annotated[str, Path(...)]):
    """Toggle a hook between active and paused."""
    try:
        svc = _service()
        hook = svc.toggle_hook(hook_id)
        if not hook:
            raise HTTPException(status_code=404, detail=HOOK_NOT_FOUND)
        return {"success": True, "hook": hook}
    except HTTPException:
        raise
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}


@router.post(
    "/api/hooks/{hook_id}/duplicate",
    responses={404: {"description": HOOK_NOT_FOUND}},
)
def duplicate_hook(hook_id: Annotated[str, Path(...)]):
    """Duplicate an existing hook."""
    try:
        svc = _service()
        hook = svc.duplicate_hook(hook_id)
        if not hook:
            raise HTTPException(status_code=404, detail=HOOK_NOT_FOUND)
        return {"success": True, "hook": hook}
    except HTTPException:
        raise
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}
