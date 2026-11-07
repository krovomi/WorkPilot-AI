"""Server mode: review a card's work from the app.

The app's review panel reads a card's changes from its build workspace and
can send the work back with a request for changes. On a server project the
workspace is the server's (``.workpilot/worktrees/tasks/<card>`` in the
clone), so these routes read and write it there, by ``project_id``: the app
never gets a path, and git runs with an argument list, never a shell.

The handlers are mounted on the board's router by ``shared_board.api``
(``GET /api/board/cards/{id}/changes``, ``POST .../request-changes``).
Merging and opening the pull request are run phases (``merge``, ``pr``),
started by the run route with their own permissions.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, Field
from server.authz.principal import get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from server.db.models import Project
from server.services.events import emit_board_event
from shared_board.attachments import (
    MAX_IMAGES,
    ImageUpload,
    decode_images,
    store_images,
)
from shared_board.cards import _card_or_404, _index_row, _require_writer
from sqlalchemy.ext.asyncio import AsyncSession

MAX_FILES = 300
MAX_PATCH = 200_000
MAX_FEEDBACK = 20_000
_STATUS = {"A": "added", "M": "modified", "D": "deleted", "R": "renamed"}
_SPECS = Path(".workpilot") / "specs"
# A branch name as git takes it, never an option: the base comes from the
# project's row, and git reads it as an argument.
_BRANCH = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$")


class ChangeRequest(BaseModel):
    feedback: str = Field(min_length=1, max_length=MAX_FEEDBACK)
    # Screenshots of what is wrong, as the review panel attaches them.
    images: list[ImageUpload] = Field(default_factory=list, max_length=MAX_IMAGES)


def _within(root: Path, *parts: str) -> Path | None:
    """``root/parts`` resolved (links followed), or None when it leaves root.

    The card id was already checked by ``_card_or_404``; resolving again
    here keeps every path this module writes inside the place it names.
    """
    base = os.path.realpath(root)
    candidate = os.path.realpath(os.path.join(base, *parts))
    if not candidate.startswith(base + os.sep):
        return None
    return Path(candidate)


def _workspace(scope: ProjectScope, card_id: str) -> Path | None:
    """The card's build workspace, if it exists inside the clone."""
    path = _within(scope.path, ".workpilot", "worktrees", "tasks", card_id)
    return path if path is not None and path.is_dir() else None


def _changes(project_dir: Path, base: str, card_id: str) -> dict[str, Any]:
    from core.worktree import WorktreeManager
    from foundation.git_executable import run_git

    manager = WorktreeManager(project_dir, base_branch=base)
    info = manager.get_worktree_info(card_id)
    if info is None:
        return {"exists": False, "files": [], "summary": ""}
    cwd = info.path
    span = f"{base}...HEAD"
    counts: dict[str, tuple[int, int]] = {}
    for line in run_git(["diff", "--numstat", span], cwd=cwd).stdout.splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            added, removed, name = parts
            counts[name] = (
                int(added) if added.isdigit() else 0,
                int(removed) if removed.isdigit() else 0,
            )
    files: list[dict[str, Any]] = []
    status_lines = run_git(["diff", "--name-status", span], cwd=cwd).stdout
    for line in status_lines.splitlines()[:MAX_FILES]:
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        name = parts[-1]
        patch = run_git(["diff", span, "--", name], cwd=cwd).stdout
        added, removed = counts.get(name, (0, 0))
        files.append(
            {
                "path": name,
                "status": _STATUS.get(parts[0][:1], "modified"),
                "additions": added,
                "deletions": removed,
                "patch": patch if len(patch) <= MAX_PATCH else None,
            }
        )
    return {
        "exists": True,
        "branch": info.branch,
        "baseBranch": info.base_branch,
        "commitCount": info.commit_count,
        "filesChanged": info.files_changed,
        "additions": info.additions,
        "deletions": info.deletions,
        "files": files,
        "summary": f"{len(files)} files changed",
    }


async def card_changes(
    card_id: str,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """What the card's build changed against the project's main branch."""
    _card_or_404(scope, card_id)
    if _workspace(scope, card_id) is None:
        return {"exists": False, "files": [], "summary": ""}
    project = await db.get(Project, scope.project_id)
    base = project.default_branch if project and project.default_branch else "main"
    if not _BRANCH.match(base) or ".." in base:
        raise HTTPException(status_code=409, detail="Invalid base branch")
    return await asyncio.to_thread(_changes, scope.path, base, card_id)


def _reopen_plan(plan_path: Path, subtask: dict[str, Any]) -> None:
    """As the app does on a request for changes: a traced subtask, failed
    subtasks retried, completed ones kept, QA to run again."""
    try:
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(plan, dict):
        return
    phases = plan.setdefault("phases", [])
    if not isinstance(phases, list):
        return
    implementation = next(
        (
            p
            for p in phases
            if isinstance(p, dict) and p.get("name") == "Implementation"
        ),
        None,
    )
    if implementation is None:
        implementation = {"name": "Implementation", "subtasks": []}
        phases.append(implementation)
    for phase in phases:
        for item in phase.get("subtasks") or [] if isinstance(phase, dict) else []:
            if isinstance(item, dict) and item.get("status") == "failed":
                item["status"] = "pending"
    implementation.setdefault("subtasks", []).append(subtask)
    if isinstance(plan.get("qa_signoff"), dict):
        plan["qa_signoff"]["status"] = "pending"
    plan["status"] = "in_progress"
    plan["planStatus"] = "in_progress"
    plan["updated_at"] = datetime.now(UTC).isoformat()
    plan_path.write_text(json.dumps(plan, indent=2), encoding="utf-8")


async def request_changes(
    card_id: str,
    body: ChangeRequest,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Send the card's work back with what to change.

    Writes the request where the build reads it (``QA_FIX_REQUEST.md`` in the
    workspace) and reopens the plan; the app then starts a ``build`` run. The
    feedback is a person's text, written to a file, never to argv.
    """
    from server.services.run_manager import get_run_manager

    principal = get_principal(request)
    _require_writer(scope, principal)
    feedback = body.feedback.strip()
    if not feedback:
        raise HTTPException(status_code=422, detail="Say what to change")
    images = decode_images(body.images)
    directory = _card_or_404(scope, card_id)
    workspace = _workspace(scope, card_id)
    if workspace is None:
        raise HTTPException(status_code=409, detail="Nothing to review yet")
    row = await _index_row(db, scope, card_id)
    if row is not None and get_run_manager().is_running(row.id):
        raise HTTPException(status_code=409, detail="A run is working on this card")

    now = datetime.now(UTC).isoformat()
    workspace_spec = _within(workspace, str(_SPECS), card_id)
    if workspace_spec is None:
        raise HTTPException(status_code=404, detail="Card not found")
    workspace_spec.mkdir(parents=True, exist_ok=True)
    # As the desktop review panel does: images in feedback_images/, listed
    # under the feedback for the QA fixer to open.
    stored = store_images(workspace_spec / "feedback_images", images)
    references = "\n\n".join(f"![Feedback Image]({image['path']})" for image in stored)
    if references:
        references = f"## Reference Images\n\n{references}\n\n"
    (workspace_spec / "QA_FIX_REQUEST.md").write_text(
        f"# QA Fix Request\n\nStatus: REJECTED\n\n## Feedback\n\n{feedback}\n\n"
        f"{references}Created at: {now}\n",
        encoding="utf-8",
    )
    first_line = feedback.splitlines()[0][:120]
    subtask = {
        "id": f"change-request-{int(datetime.now(UTC).timestamp() * 1000)}",
        "title": first_line,
        "description": feedback,
        "status": "pending",
        "files": [],
        "origin": "change_request",
        "requested_at": now,
    }
    for spec_dir in (directory, workspace_spec):
        plan = spec_dir / "implementation_plan.json"
        if plan.is_file():
            _reopen_plan(plan, dict(subtask))
    emit_board_event(
        scope.project_id, "spec_updated", {"spec": card_id, "by": principal.id}
    )
    return {"requested": True}
