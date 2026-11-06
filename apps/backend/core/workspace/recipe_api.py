"""The worktree recipe for the desktop app: show it, approve it, save the detected one.

Desktop only, like the other routes that read a project's files by the path
the main process validated (`validated_dir`); not mounted in server mode
(`LOCAL_ONLY_FEATURES`).
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter
from foundation.api_safety import server_mode_roots, validated_dir
from pydantic import BaseModel

from .recipe import RECIPE_FILE, detect_recipe, load_recipe
from .recipe_run import approve_recipe, is_approved

router = APIRouter(prefix="/api/worktree-recipe", tags=["worktree-recipe"])

_DESKTOP_ONLY = {
    "success": False,
    "error": "the worktree recipe is a desktop feature",
    "reason": "server-mode",
}


class RecipeRequest(BaseModel):
    project_dir: str = ""


def _project(project_dir: str) -> Path | None:
    try:
        return validated_dir(project_dir, "project_dir")
    except ValueError:
        return None


def _state(project: Path) -> dict:
    declared = load_recipe(project)
    detected = detect_recipe(project)
    active = declared or detected
    return {
        "success": True,
        "recipe": active.as_dict(),
        "detected": detected.as_dict(),
        "hasFile": declared is not None,
        "approved": is_approved(project, active),
    }


@router.get("")
def get_recipe(project_dir: str = "") -> dict:
    """The recipe a new worktree of this project runs, and whether it may."""
    if server_mode_roots() is not None:
        return _DESKTOP_ONLY
    project = _project(project_dir)
    if project is None:
        return {"success": False, "error": "project_dir is required"}
    return _state(project)


@router.post("/approve")
def approve(request: RecipeRequest) -> dict:
    """The person approves `.workpilot/worktree.toml` as it is now."""
    if server_mode_roots() is not None:
        return _DESKTOP_ONLY
    project = _project(request.project_dir)
    if project is None:
        return {"success": False, "error": "project_dir is required"}
    try:
        approve_recipe(project)
    except ValueError:
        # The errors themselves are in the state the section already shows.
        return {
            "success": False,
            "error": "the recipe is invalid and cannot be approved",
        }
    return _state(project)


@router.post("/save-detected")
def save_detected(request: RecipeRequest) -> dict:
    """Write the detected recipe as `.workpilot/worktree.toml`, approved: the person wrote it."""
    if server_mode_roots() is not None:
        return _DESKTOP_ONLY
    project = _project(request.project_dir)
    if project is None:
        return {"success": False, "error": "project_dir is required"}
    path = project / ".workpilot" / RECIPE_FILE
    if path.exists():
        return {"success": False, "error": f"{RECIPE_FILE} already exists"}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_toml(detect_recipe(project).setup), encoding="utf-8")
    approve_recipe(project)
    return _state(project)


def _toml_list(command: tuple[str, ...]) -> str:
    import json

    return "[" + ", ".join(json.dumps(a) for a in command) + "]"


def render_toml(commands: tuple[tuple[str, ...], ...]) -> str:
    body = ",\n".join(f"  {_toml_list(c)}" for c in commands)
    return (
        "# What WorkPilot runs in each new worktree, before the first session.\n"
        "# Each command is a list of arguments; no shell. See\n"
        "# docs/architecture/worktree-recipe.md.\n\n"
        "[setup]\n"
        f"commands = [\n{body}\n]\n"
        "copy = []\n"
        "timeout_seconds = 900\n\n"
        "[ports]\n"
        "count = 0\n\n"
        "[teardown]\n"
        "commands = []\n"
    )
