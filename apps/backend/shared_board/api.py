"""Cards of a shared board, in server mode: create, read, edit, delete, approve.

A server-mode project is a clone on the server, and its board is that clone's
``.workpilot/specs/``, the same files the desktop app and the agents read. The
server's own routes (``server/routers/specs.py``) index those cards, claim them
and start runs on them; these routes change the cards themselves, with the
writers the pipeline already uses: the board's card writer
(``board_mcp.server.write_card``, numbered under the board's lock) and the
review state the build checks before it starts (``review.state.ReviewState``).
The server package imports nothing from the backend, so they live here.

Every route takes a ``project_id``, never a path, and resolves it through
``server.authz.scope.resolve_project_scope``: the project must be the
caller's tenant's, and the caller one of its members. On top of the
permission the mount derives (``task.read`` / ``task.write``, ``task.delete``
and ``review.approve`` for the two routes raised in ``ROUTE_OVERRIDES``),
changing a card needs a project role of ``member`` or more; a ``viewer`` reads.

A card's text is what a person wrote. It is stored and shown as such; the
agents that later read it get it through the pipeline's own handling of the
task description, never as an instruction to this server.
"""

from __future__ import annotations

import json
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from server.authz.principal import get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from server.db.models import ProjectRole
from server.services import push
from server.services.events import emit_board_event
from shared_board import attachments as card_images
from shared_board import listing, review
from shared_board import settings as card_settings
from shared_board.cards import _card_or_404, _index_row, _require_writer
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/board", tags=["board"])

MAX_TITLE = 200
MAX_DESCRIPTION = 20_000
SPEC_TEXT_LIMIT = 100_000

#: The files of a card the desktop app reads to draw it (``project-store.ts``,
#: ``createTaskFromSpec``), with the most of each it receives. A snapshot sends
#: these and nothing else: no log, no attachment, no file an agent wrote.
SNAPSHOT_FILES: dict[str, int] = {
    "implementation_plan.json": 1_000_000,
    "task_metadata.json": 200_000,
    "requirements.json": 200_000,
    "pause_state.json": 50_000,
    "review_state.json": 50_000,
    "spec.md": 300_000,
    "qa_report.md": 300_000,
}
MAX_SNAPSHOT_CARDS = 500


class CardCreate(BaseModel):
    title: str = Field(min_length=1, max_length=MAX_TITLE)
    description: str = Field(default="", max_length=MAX_DESCRIPTION)
    kind: str | None = None
    # As on the desktop card: when true, the build waits for someone to
    # approve the spec and plan; when false, spec creation approves them.
    require_review: bool = True
    # Engine, priority, category and goal, as the desktop card carries them.
    settings: card_settings.CardSettings | None = None
    # Images from the New Task dialog, stored in the card's attachments/.
    attachments: list[card_images.ImageUpload] = Field(
        default_factory=list, max_length=card_images.MAX_IMAGES
    )


class CardUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=MAX_TITLE)
    description: str | None = Field(default=None, max_length=MAX_DESCRIPTION)


def _started(scope: ProjectScope, directory: Path) -> bool:
    """Whether work began: a spec was written or a build workspace exists."""
    worktree = scope.path / ".workpilot" / "worktrees" / "tasks" / directory.name
    return (directory / "spec.md").exists() or worktree.exists()


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")


def _card_files(directory: Path) -> dict[str, str]:
    files: dict[str, str] = {}
    for name, limit in SNAPSHOT_FILES.items():
        path = directory / name
        try:
            if (
                path.is_file()
                and not path.is_symlink()
                and path.stat().st_size <= limit
            ):
                files[name] = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
    return files


@router.get("/stream")
async def board_stream() -> dict[str, str | None]:
    """Where the app opens a board's live stream, when the server says so
    (``WORKPILOT_PUBLIC_STREAM_URL``); otherwise the app uses the API's host
    on the stream's port."""
    from server.config import get_settings

    return {"url": get_settings().public_stream_url or None}


@router.get("/snapshot")
async def board_snapshot(
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    """The board's cards as files, for the app to draw them as it draws its own.

    ``cards`` are the project's specs; ``worktrees`` the same cards as their
    build workspace has them, which the app prefers while a build runs. Only
    :data:`SNAPSHOT_FILES`, each under its size limit; a symlink is skipped.
    """
    from board_mcp.server import CARD_ID, SPECS

    root = scope.path.resolve()

    def collect(specs: Path) -> dict[str, dict[str, str]]:
        out: dict[str, dict[str, str]] = {}
        if not specs.is_dir():
            return out
        for entry in sorted(specs.iterdir(), reverse=True):
            if len(out) >= MAX_SNAPSHOT_CARDS:
                break
            if (
                CARD_ID.match(entry.name)
                and entry.is_dir()
                and entry.resolve().is_relative_to(root)
            ):
                out[entry.name] = _card_files(entry)
        return out

    cards = collect(scope.path / SPECS)
    worktrees: dict[str, dict[str, str]] = {}
    tasks_dir = scope.path / ".workpilot" / "worktrees" / "tasks"
    for card_id in cards:
        directory = tasks_dir / card_id / SPECS / card_id
        # A build writes in its worktree: resolve the whole chain, so a link
        # planted on the way cannot point the snapshot outside the checkout.
        if directory.is_dir() and directory.resolve().is_relative_to(root):
            worktrees[card_id] = _card_files(directory)
    return {"cards": cards, "worktrees": worktrees}


@router.post("/cards", status_code=201)
async def create_card(
    body: CardCreate,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    from board_mcp.server import KINDS, summary, write_card
    from core.workspace.models import SpecNumberLockError

    principal = get_principal(request)
    _require_writer(scope, principal)
    if body.kind is not None and body.kind not in KINDS:
        raise HTTPException(status_code=422, detail=f"kind must be one of {KINDS}")

    title = " ".join(body.title.split())
    metadata: dict[str, Any] = {
        "sourceType": "server",
        "createdBy": principal.id,
        "requireReviewBeforeCoding": body.require_review,
    }
    if body.kind:
        metadata.update(kind=body.kind, kindSource="user", kindConfidence=1)
    if body.settings is not None:
        card_settings.checked_goal(body.settings)  # 422 before the card exists
    images = card_images.decode_images(body.attachments)
    try:
        directory = write_card(
            scope.path, title, body.description.strip() or title, metadata
        )
    except SpecNumberLockError as e:
        raise HTTPException(status_code=409, detail="Board busy, try again") from e

    if body.settings is not None:
        card_settings.apply_settings(scope.path.resolve(), directory, body.settings)
    if images:
        _attach(directory, card_images.store_images(directory / "attachments", images))
    row = await _index_row(db, scope, directory.name)
    if row is not None and row.created_by is None:
        row.created_by = principal.id
        await db.commit()
    card = summary(directory)
    emit_board_event(
        scope.project_id, "spec_created", {"spec": directory.name, "by": principal.id}
    )
    return {**card, "specId": row.id if row else None}


def _attach(directory: Path, stored: list[dict[str, Any]]) -> None:
    """Record stored images where the desktop card and the agents look for them."""
    metadata_path = directory / "task_metadata.json"
    metadata = _read_json(metadata_path)
    metadata["attachedImages"] = stored
    _write_json(metadata_path, metadata)
    requirements_path = directory / "requirements.json"
    requirements = _read_json(requirements_path)
    requirements["attached_images"] = [
        {"filename": image["filename"], "path": image["path"], "description": ""}
        for image in stored
    ]
    _write_json(requirements_path, requirements)


@router.get("/cards/{card_id}")
async def get_card(
    card_id: str,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    from board_mcp.server import details
    from review.state import ReviewState

    directory = _card_or_404(scope, card_id)
    # While a build runs, its workspace holds the live plan and the QA report.
    source = listing.card_source(scope.path.resolve(), directory)
    card = details(source)
    card["id"] = directory.name
    files = _card_files(source)
    card["spec"] = files["spec.md"][:SPEC_TEXT_LIMIT] if "spec.md" in files else None
    card["qaReport"] = files.get("qa_report.md")
    review = ReviewState.load(directory)
    card["approval"] = {
        "approved": review.is_approval_valid(directory),
        "approvedBy": review.approved_by or None,
        "approvedAt": review.approved_at or None,
    }
    card["requireReview"] = bool(
        _read_json(directory / "task_metadata.json").get(
            "requireReviewBeforeCoding", True
        )
    )
    card["settings"] = card_settings.read_settings(scope.path.resolve(), directory)
    return card


@router.get("/cards/{card_id}/logs")
async def get_card_logs(
    card_id: str,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    """The card's build log (``shared_board/logs.py``): what the agent did, for
    every member who may read the card, whoever started the run."""
    from shared_board.logs import card_logs

    directory = _card_or_404(scope, card_id)
    return {"logs": card_logs(scope.path, directory)}


@router.patch("/cards/{card_id}")
async def update_card(
    card_id: str,
    body: CardUpdate,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    from board_mcp.server import summary

    principal = get_principal(request)
    _require_writer(scope, principal)
    directory = _card_or_404(scope, card_id)
    if _started(scope, directory):
        # The spec and the plan were written from this text; editing it now
        # would leave the card saying one thing and the build doing another.
        raise HTTPException(
            status_code=409, detail="Work has started on this card; it cannot be edited"
        )

    plan_path = directory / "implementation_plan.json"
    requirements_path = directory / "requirements.json"
    plan = _read_json(plan_path)
    requirements = _read_json(requirements_path)
    if body.title is not None:
        plan["feature"] = " ".join(body.title.split())
    if body.description is not None:
        text = body.description.strip() or plan.get("feature") or card_id
        plan["description"] = text
        requirements["task_description"] = text
    plan["updated_at"] = datetime.now(UTC).isoformat()
    _write_json(plan_path, plan)
    _write_json(requirements_path, requirements)

    emit_board_event(
        scope.project_id, "spec_updated", {"spec": card_id, "by": principal.id}
    )
    return summary(directory)


@router.patch("/cards/{card_id}/settings")
async def update_card_settings(
    card_id: str,
    body: card_settings.CardSettings,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Change the card's engine, priority, category or goal.

    Unlike its text, these may change once work has started, as on the
    desktop; not while a run reads them.
    """
    from server.services.run_manager import get_run_manager

    principal = get_principal(request)
    _require_writer(scope, principal)
    directory = _card_or_404(scope, card_id)
    row = await _index_row(db, scope, card_id)
    if row is not None and get_run_manager().is_running(row.id):
        raise HTTPException(status_code=409, detail="A run is active on this card")
    root = scope.path.resolve()
    card_settings.apply_settings(root, directory, body)
    emit_board_event(
        scope.project_id, "spec_updated", {"spec": card_id, "by": principal.id}
    )
    return card_settings.read_settings(root, directory)


@router.delete("/cards/{card_id}")
async def delete_card(
    card_id: str,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    from server.services.run_manager import get_run_manager

    principal = get_principal(request)
    _require_writer(scope, principal)
    directory = _card_or_404(scope, card_id)
    row = await _index_row(db, scope, card_id)
    if row is not None:
        if get_run_manager().is_running(row.id):
            raise HTTPException(status_code=409, detail="A run is active on this card")
        if (
            row.claimed_by
            and row.claimed_by != principal.id
            and scope.project_role != ProjectRole.OWNER.value
            and not principal.is_platform_admin
        ):
            raise HTTPException(status_code=409, detail="Claimed by someone else")
    worktree = scope.path / ".workpilot" / "worktrees" / "tasks" / card_id
    if worktree.exists():
        raise HTTPException(
            status_code=409, detail="Discard the card's build workspace first"
        )

    shutil.rmtree(directory)
    await _index_row(db, scope, card_id)
    emit_board_event(
        scope.project_id, "spec_deleted", {"spec": card_id, "by": principal.id}
    )
    return {"deleted": card_id}


@router.post("/cards/{card_id}/approve")
async def approve_card(
    card_id: str,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    """Approve the card's spec and plan, so a build may start on them.

    The approval is the one the build checks (``review_state.json``, with the
    hash of ``spec.md`` and the plan): editing either afterwards voids it.
    """
    from review.state import ReviewState

    principal = get_principal(request)
    _require_writer(scope, principal)
    directory = _card_or_404(scope, card_id)
    if not (directory / "spec.md").is_file():
        raise HTTPException(status_code=409, detail="No spec to approve yet")

    review = ReviewState.load(directory)
    review.approve(directory, approved_by=principal.email or principal.id)
    emit_board_event(
        scope.project_id, "spec_approved", {"spec": card_id, "by": principal.id}
    )
    return {"approved": True, "approvedBy": review.approved_by}


def _approval_pending(directory: Path) -> bool:
    """The plan of this spec folder is not (or no longer) approved."""
    from review.state import ReviewState

    return not ReviewState.load(directory).is_approval_valid(directory)


# A finished spec waiting for this approval is notified as a plan to approve.
push.set_approval_check(_approval_pending)

# The board as a list of summarised cards, for the phone app: its own module.
router.add_api_route("/cards", listing.list_board_cards, methods=["GET"])

# Reviewing a card's work from the app (its changes, a request for changes):
# its own module, on this router.
router.add_api_route("/cards/{card_id}/changes", review.card_changes, methods=["GET"])
router.add_api_route(
    "/cards/{card_id}/request-changes", review.request_changes, methods=["POST"]
)
