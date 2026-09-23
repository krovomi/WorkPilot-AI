"""``/api/brain`` — the desktop app's view of the shared brain.

Refused in server mode, like `hermes/api.py`: the brain lives in the home
directory of the machine running the backend, which on a shared deployment is
the server's and not the tenant's.

| Route | Answers |
|---|---|
| ``GET /settings`` | where the brain is, who chose it, its remote, whether it is an Obsidian vault |
| ``POST /settings`` | plug a folder (an Obsidian vault or a new one) and/or a git remote (GitHub) |
| ``GET /task`` | what the brain learned on one Kanban task — the task panel's card |
| ``POST /instruction`` | activate or turn down an instruction an agent proposed |
| ``POST /sync``, ``POST /recall``, ``POST /learn``, ``GET /status`` | the rest |

**The folder chosen here stays under the user's home directory.** The backend
listens on localhost, and a page open in a browser can send it a request: an
endpoint that creates a git repository wherever it is told is an endpoint that
writes into ``/etc`` for whoever asks. ``WORKPILOT_BRAIN_DIR`` still puts the
brain anywhere, for the person who sets it themselves.
"""

from __future__ import annotations

import os
from pathlib import Path

from core.api_safety import server_mode_roots
from fastapi import APIRouter
from pydantic import BaseModel

from .home import (
    BRAIN_ENV,
    brain_dir,
    brain_source,
    config_path,
    default_brain_dir,
    write_config,
)
from .memories import discover
from .notes import iter_notes
from .sync import git_available, normalize_remote, remote_url
from .vault import Brain

router = APIRouter(prefix="/api/brain", tags=["brain"])

_DESKTOP_ONLY = {
    "success": False,
    "error": "the shared brain is a desktop feature",
    "reason": "server-mode",
}


class SyncRequest(BaseModel):
    message: str = "brain: sync"


class LearnRequest(BaseModel):
    surface: str
    """One of `brain.learn.SURFACES`: which feature is reporting."""
    title: str
    body: str
    project: str | None = None
    tags: list[str] = []


class RecallRequest(BaseModel):
    query: str
    limit: int = 5


class SettingsRequest(BaseModel):
    path: str | None = None
    """A folder under the home directory; ``""`` goes back to the default."""
    remote: str | None = None
    """A git remote, or GitHub's ``owner/repo``. ``None`` leaves it as it is."""
    enabled: bool | None = None
    connect: bool = True
    """Create, clone or adopt the brain at the chosen folder now."""


class InstructionRequest(BaseModel):
    path: str
    status: str
    """``active`` or ``retired``."""


def _refused() -> bool:
    return server_mode_roots() is not None


def _home_path(raw: str) -> Path:
    """*raw* as an absolute folder under the home directory, or ``ValueError``."""
    home = os.path.normpath(os.path.abspath(os.path.expanduser("~")))
    full = os.path.normpath(os.path.abspath(os.path.expanduser(raw.strip())))
    if full != home and not full.startswith(home + os.sep):
        raise ValueError("the brain folder must be inside your home directory")
    if os.path.isfile(full):
        raise ValueError("the brain folder is a file")
    return Path(full)


def settings_view() -> dict:
    from .runtime import enabled

    brain = Brain()
    exists = brain.exists
    return {
        "path": str(brain.root),
        "defaultPath": str(default_brain_dir()),
        "source": brain_source(),
        "envVariable": BRAIN_ENV,
        "configPath": str(config_path()),
        "enabled": enabled(),
        "active": enabled() and exists,
        "exists": exists,
        "folderExists": brain.root.is_dir(),
        "git": (brain.root / ".git").exists(),
        "gitAvailable": git_available(),
        "remote": remote_url(brain.root) if exists else None,
        "obsidianVault": brain.is_obsidian_vault,
        "notes": sum(1 for _ in iter_notes(brain.root)) if exists else 0,
        "proposals": len(brain.proposals()) if exists else 0,
    }


@router.get("/settings")
def get_settings() -> dict:
    if _refused():
        return _DESKTOP_ONLY
    return {"success": True, "settings": settings_view()}


@router.post("/settings")
def save_settings(request: SettingsRequest) -> dict:
    """Plug a folder and/or a remote, then create, clone or adopt the brain there."""
    if _refused():
        return _DESKTOP_ONLY
    if request.path is not None and brain_source() == "env":
        return {
            "success": False,
            "error": f"{BRAIN_ENV} is set: the brain folder is chosen by that variable",
            "settings": settings_view(),
        }
    try:
        remote = normalize_remote(request.remote) if request.remote else None
        if request.path is not None:
            if request.path.strip():
                target = _home_path(request.path)
                keep = None if target == default_brain_dir() else str(target)
                write_config(path=keep)
            else:
                write_config(path=None)
        if request.enabled is not None:
            write_config(enabled=request.enabled)
    except ValueError as exc:
        return {"success": False, "error": str(exc), "settings": settings_view()}

    result = None
    if request.connect and (request.path is not None or remote):
        result = Brain(brain_dir()).init(remote=remote)
        if result.get("error"):
            return {
                "success": False,
                "error": result["error"],
                "result": result,
                "settings": settings_view(),
            }
    return {"success": True, "result": result, "settings": settings_view()}


@router.get("/task")
def task(project_dir: str = "", spec_id: str = "") -> dict:
    """What the brain learned on one Kanban task (`learn.task_learning`)."""
    if _refused():
        return _DESKTOP_ONLY
    from .learn import project_name_from, task_learning

    project = project_name_from(project_dir)
    if not project or not spec_id.strip():
        return {"success": False, "error": "project_dir and spec_id are required"}
    return {"success": True, "learning": task_learning(project, spec_id.strip())}


@router.post("/instruction")
def instruction(request: InstructionRequest) -> dict:
    """A person activates, or turns down, an instruction an agent proposed."""
    if _refused():
        return _DESKTOP_ONLY
    try:
        return {
            "success": True,
            **Brain().set_instruction_status(request.path, request.status),
        }
    except (ValueError, OSError) as exc:
        return {"success": False, "error": str(exc)}


@router.get("/status")
def status() -> dict:
    if _refused():
        return _DESKTOP_ONLY
    brain = Brain()
    return {
        "success": True,
        **brain.status(),
        "memories": [m.to_dict() for m in discover() if m.exists],
    }


@router.post("/sync")
def sync(request: SyncRequest) -> dict:
    if _refused():
        return _DESKTOP_ONLY
    result = Brain().sync(request.message)
    return {"success": result.error is None, **result.to_dict()}


@router.post("/recall")
def recall(request: RecallRequest) -> dict:
    if _refused():
        return _DESKTOP_ONLY
    return {"success": True, **Brain().recall(request.query, limit=request.limit)}


@router.post("/learn")
def learn(request: LearnRequest) -> dict:
    """A feature reports something it knows; filed under its surface and project."""
    if _refused():
        return _DESKTOP_ONLY
    from .learn import SURFACES, record

    if request.surface not in SURFACES:
        return {
            "success": False,
            "error": "unknown surface",
            "surfaces": sorted(SURFACES),
        }
    rel = record(
        request.surface,
        request.title,
        request.body,
        project=request.project,
        tags=request.tags,
    )
    return {"success": rel is not None, "path": rel}
