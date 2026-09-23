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

import logging
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

logger = logging.getLogger(__name__)

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


def _home_path(raw: str) -> tuple[Path | None, str | None]:
    """*raw* as an absolute folder under the home directory, or an error code.

    Normalised, then prefix-checked against the home directory plus a
    separator, in one condition: the home directory itself is refused too — a
    brain whose notes are every Markdown file a person owns is not a choice
    anyone makes on purpose.
    """
    home = os.path.normpath(os.path.abspath(os.path.expanduser("~")))
    full = os.path.normpath(os.path.abspath(os.path.expanduser(raw.strip())))
    if not full.startswith(home + os.sep):
        return None, "outside-home"
    if os.path.isfile(full):
        return None, "is-file"
    return Path(full), None


def _checked_remote(value: str | None) -> tuple[str | None, str | None]:
    if not value:
        return None, None
    try:
        return normalize_remote(value), None
    except ValueError:
        return None, "invalid-remote"


def _clone_error(text: str) -> str:
    """What went wrong with a clone, as a code the UI translates.

    git's own message is English, carries URLs and paths, and changes between
    versions; the response carries a code instead, and the message stays in
    the backend's log.
    """
    low = (text or "").lower()
    if any(
        k in low
        for k in (
            "permission denied",
            "authentication",
            "could not read username",
            "403",
        )
    ):
        return "auth"
    if any(
        k in low
        for k in (
            "not found",
            "does not exist",
            "not a git repository",
            "does not appear to be a git repository",
            "could not read from remote repository",
        )
    ):
        return "not-found"
    if "timed out" in low:
        return "timeout"
    if any(
        k in low
        for k in ("could not resolve", "unable to access", "connection", "network")
    ):
        return "network"
    if "no such file" in low or "not recognized" in low:
        return "git-missing"
    return "failed"


def _refusal(code: str) -> dict:
    return {"success": False, "error": code, "code": code, "settings": settings_view()}


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
        return _refusal("env-locked")
    remote, code = _checked_remote(request.remote)
    if code:
        return _refusal(code)
    if request.path is not None:
        if request.path.strip():
            target, code = _home_path(request.path)
            if code or target is None:
                return _refusal(code or "outside-home")
            write_config(path=None if target == default_brain_dir() else str(target))
        else:
            write_config(path=None)
    if request.enabled is not None:
        write_config(enabled=request.enabled)

    summary = None
    if request.connect and (request.path is not None or remote):
        result = Brain(brain_dir()).init(remote=remote)
        if result.get("error"):
            code = _clone_error(str(result["error"]))
            # The code only: git's message quotes the remote a request supplied.
            logger.warning("brain: clone failed (%s)", code)
            return _refusal(code)
        summary = {
            "cloned": result.get("cloned") is True,
            "adopted": result.get("adopted") is True,
            "obsidianVault": result.get("obsidianVault") is True,
        }
    return {"success": True, "result": summary, "settings": settings_view()}


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
    if request.status not in ("active", "retired"):
        return {"success": False, "error": "invalid-status", "code": "invalid-status"}
    try:
        changed = Brain().set_instruction_status(request.path, request.status)
    except (ValueError, OSError) as exc:
        logger.info("brain: instruction status not changed: %s", type(exc).__name__)
        return {"success": False, "error": "invalid-path", "code": "invalid-path"}
    return {"success": True, "path": str(changed["path"]), "status": request.status}


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
    if result.error:
        logger.warning("brain: sync failed")
    return {
        "success": result.error is None,
        "committed": result.committed,
        "pulled": result.pulled,
        "pushed": result.pushed,
        "remote": result.remote,
        "conflicts": list(result.conflicts),
        "skipped": result.skipped,
        "error": "sync-failed" if result.error else None,
    }


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
