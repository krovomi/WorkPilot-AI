"""Sprints of a server project's board, shared by its members.

The desktop app keeps a local project's sprints in its
``.workpilot/sprints.json`` (``apps/frontend/src/main/sprints/``); a server
project's live in the same file of its clone, written here and nowhere else.
The rules are the app's (``shared/utils/sprints.ts``,
``main/sprints/sprint-book.ts``): a name of 80 characters at most, an
optional goal and calendar days, one active sprint at a time, a closed sprint
no longer changes, only a planned one is deleted. A card names its sprint in
``task_metadata.json`` (``sprintId``, ``shared_board.settings``).

The commitment a sprint starts with and the report it closes with are the
numbers the app counted on the board, bounded here; they describe the
sprint, they decide nothing.

Every route takes a ``project_id``, never a path; the mount gives the reads
``task.read`` and the changes ``task.write``, and a change needs a project
role of ``member`` or more (``_require_writer``).

Design: ``docs/architecture/kanban-sprints.md``.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi import Path as PathParam
from pydantic import BaseModel, Field, ValidationError, model_validator
from server.authz.principal import get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.services.events import emit_board_event
from shared_board.cards import _require_writer

router = APIRouter(prefix="/api/board", tags=["board"])

MAX_SPRINTS = 200
MAX_COUNT = 100_000
SPRINT_ID_PATTERN = r"^sp-[0-9a-f]{8}$"
#: One line of text without a control character.
NAME_PATTERN = r"^[^\x00-\x1f\x7f]+$"
#: Several lines are fine in a goal, still no other control character.
GOAL_PATTERN = r"^[^\x00-\x09\x0b-\x1f\x7f]*$"
DAY_PATTERN = r"^\d{4}-\d{2}-\d{2}$"

SprintId = Annotated[str, Field(pattern=SPRINT_ID_PATTERN)]
SprintInPath = Annotated[str, PathParam(pattern=SPRINT_ID_PATTERN)]
Day = Annotated[str, Field(pattern=DAY_PATTERN)]
Count = Annotated[int, Field(ge=0, le=MAX_COUNT)]

_locks: dict[str, asyncio.Lock] = {}


def _check_day(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError as e:
        raise ValueError(f"not a calendar day: {value!r}") from e
    return value


class SprintDraft(BaseModel):
    """What a person edits on a sprint; no ``id`` creates one."""

    id: SprintId | None = None
    name: str = Field(min_length=1, max_length=80, pattern=NAME_PATTERN)
    goal: str | None = Field(default=None, max_length=500, pattern=GOAL_PATTERN)
    startDate: Day | None = None
    endDate: Day | None = None

    @model_validator(mode="after")
    def _days(self) -> SprintDraft:
        self.name = self.name.strip()
        if not self.name:
            raise ValueError("a sprint needs a name")
        self.goal = (self.goal or "").strip() or None
        _check_day(self.startDate)
        _check_day(self.endDate)
        if self.startDate and self.endDate and self.endDate < self.startDate:
            raise ValueError("a sprint cannot end before it starts")
        return self


class Commitment(BaseModel):
    cards: Count
    points: Count


class Report(BaseModel):
    done: Count
    donePoints: Count
    carried: Count
    carriedPoints: Count
    carriedTo: SprintId | None = None


class Sprint(SprintDraft):
    id: SprintId
    state: Literal["planned", "active", "closed"]
    createdAt: str = Field(max_length=40)
    startedAt: str | None = Field(default=None, max_length=40)
    closedAt: str | None = Field(default=None, max_length=40)
    committed: Commitment | None = None
    report: Report | None = None


class StartBody(BaseModel):
    committed: Commitment


class CompleteBody(BaseModel):
    report: Report


def sprints_file(root: Path) -> Path:
    return root / ".workpilot" / "sprints.json"


def read_sprints(root: Path) -> list[Sprint]:
    """The project's sprints; a malformed entry or file is left out."""
    path = sprints_file(root)
    try:
        if path.is_symlink():
            return []
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    items = raw.get("sprints") if isinstance(raw, dict) else None
    sprints: list[Sprint] = []
    seen: set[str] = set()
    for item in (items if isinstance(items, list) else [])[:MAX_SPRINTS]:
        try:
            sprint = Sprint.model_validate(item)
        except ValidationError:
            continue
        if sprint.id not in seen:
            seen.add(sprint.id)
            sprints.append(sprint)
    return sprints


def _write(root: Path, sprints: list[Sprint]) -> None:
    path = sprints_file(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or not path.parent.resolve().is_relative_to(root.resolve()):
        raise HTTPException(
            status_code=409, detail="The sprints file is not the project's"
        )
    data = {
        "version": 1,
        "sprints": [s.model_dump(exclude_none=True) for s in sprints],
    }
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    # A file left there (or a link planted in the clone) is removed, never followed.
    temporary.unlink(missing_ok=True)
    with open(temporary, "x", encoding="utf-8") as out:
        out.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(path)


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _find(sprints: list[Sprint], sprint_id: str) -> Sprint:
    for sprint in sprints:
        if sprint.id == sprint_id:
            return sprint
    raise HTTPException(status_code=404, detail="Sprint not found")


def _shown(sprints: list[Sprint]) -> dict[str, Any]:
    return {"sprints": [s.model_dump(exclude_none=True) for s in sprints]}


async def _change(scope: ProjectScope, request: Request, apply: Any) -> dict[str, Any]:
    """Read, change and write the sprints, one change at a time per project."""
    principal = get_principal(request)
    _require_writer(scope, principal)
    root = scope.path.resolve()
    lock = _locks.setdefault(str(scope.project_id), asyncio.Lock())
    async with lock:
        sprints = read_sprints(root)
        sprints = apply(sprints)
        _write(root, sprints)
    emit_board_event(scope.project_id, "sprints_updated", {"by": principal.id})
    return _shown(sprints)


@router.get("/sprints")
async def list_sprints(
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    return _shown(read_sprints(scope.path.resolve()))


@router.post("/sprints")
async def save_sprint(
    body: SprintDraft,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    """Create a planned sprint, or change the name, goal and days of one not closed."""

    def apply(sprints: list[Sprint]) -> list[Sprint]:
        fields = body.model_dump(exclude={"id"})
        if body.id is None:
            if len(sprints) >= MAX_SPRINTS:
                raise HTTPException(status_code=409, detail="Too many sprints")
            sprint_id = f"sp-{secrets.token_hex(4)}"
            return [
                *sprints,
                Sprint(id=sprint_id, state="planned", createdAt=_now(), **fields),
            ]
        current = _find(sprints, body.id)
        if current.state == "closed":
            raise HTTPException(
                status_code=409, detail="A closed sprint no longer changes"
            )
        changed = current.model_copy(update=fields)
        return [changed if s.id == current.id else s for s in sprints]

    return await _change(scope, request, apply)


@router.post("/sprints/{sprint_id}/start")
async def start_sprint(
    sprint_id: SprintInPath,
    body: StartBody,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    """Start a planned sprint; one sprint is active at a time."""

    def apply(sprints: list[Sprint]) -> list[Sprint]:
        current = _find(sprints, sprint_id)
        if current.state != "planned":
            raise HTTPException(status_code=409, detail="Only a planned sprint starts")
        if any(s.state == "active" for s in sprints):
            raise HTTPException(status_code=409, detail="Another sprint is active")
        started = current.model_copy(
            update={"state": "active", "startedAt": _now(), "committed": body.committed}
        )
        return [started if s.id == current.id else s for s in sprints]

    return await _change(scope, request, apply)


@router.post("/sprints/{sprint_id}/complete")
async def complete_sprint(
    sprint_id: SprintInPath,
    body: CompleteBody,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    """Close the active sprint with what it did."""

    def apply(sprints: list[Sprint]) -> list[Sprint]:
        current = _find(sprints, sprint_id)
        if current.state != "active":
            raise HTTPException(status_code=409, detail="Only the active sprint closes")
        target = body.report.carriedTo
        if target is not None and _find(sprints, target).state != "planned":
            raise HTTPException(
                status_code=409, detail="Unfinished cards go to a planned sprint"
            )
        closed = current.model_copy(
            update={"state": "closed", "closedAt": _now(), "report": body.report}
        )
        return [closed if s.id == current.id else s for s in sprints]

    return await _change(scope, request, apply)


@router.delete("/sprints/{sprint_id}")
async def delete_sprint(
    sprint_id: SprintInPath,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    """Delete a planned sprint; the app sends its cards back to the backlog."""

    def apply(sprints: list[Sprint]) -> list[Sprint]:
        current = _find(sprints, sprint_id)
        if current.state != "planned":
            raise HTTPException(
                status_code=409, detail="Only a planned sprint is deleted"
            )
        return [s for s in sprints if s.id != sprint_id]

    return await _change(scope, request, apply)
