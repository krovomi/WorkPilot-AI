"""Insights on a server project: each person's conversations, read by the team.

On the desktop, Insights is a chat whose sessions are files of the person's
checkout and whose answers come from the insights runner started there. On a
shared server a conversation is a row (``InsightSession``) of the project:
its owner writes it (asks, renames, deletes), every member of the project
reads it. Each question is answered by a project job running the insights
runner on the clone (``server.services.project_jobs``), one at a time per
conversation; the server, not the client, builds the history the runner
reads, from the conversation as stored. The answer is saved when the job
ends, passed through ``redact_text`` like the job's output.

Every route takes a ``project_id``, never a path (``resolve_project_scope``).
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from functools import partial
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from server.authz.principal import Principal, get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db, get_session_factory
from server.db.models import InsightSession, ProjectJob, User
from server.services.events import emit_board_event
from server.services.project_jobs import INPUT, get_project_jobs
from server.services.run_manager import RunManagerError
from shared_board.cards import _require_writer
from shared_features.api import job_public
from shared_features.registry import MODEL_PATTERN, ThinkingLevel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/features/insights", tags=["features"])

FEATURE = "insights"
RUNNER = "insights_runner.py"
MAX_MESSAGE = 20_000
MAX_MESSAGES = 400
#: The most of a conversation the runner reads back, newest first.
HISTORY_CHARS = 400_000
ANSWER_CHARS = 200_000
TITLE_CHARS = 50

ExplanationLevel = Literal["beginner", "intermediate", "advanced", "expert"]


class ModelSettings(BaseModel):
    """The model a conversation answers with, as the app's picker gives it."""

    model_config = ConfigDict(extra="forbid")

    profileId: str = Field(default="balanced", pattern=r"^[A-Za-z0-9_-]{1,40}$")
    model: str = Field(pattern=MODEL_PATTERN)
    thinkingLevel: ThinkingLevel = "medium"


class SessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=200)
    modelConfig: ModelSettings | None = None


class SessionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=200)
    modelConfig: ModelSettings | None = None
    #: Empty the conversation (the app's "clear").
    clear: bool = False


class Question(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str = Field(min_length=1, max_length=MAX_MESSAGE)
    model: str | None = Field(default=None, pattern=MODEL_PATTERN)
    thinking_level: ThinkingLevel | None = None
    learning_mode: bool = False
    explanation_level: ExplanationLevel = "intermediate"


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _slot(session_id: str) -> str:
    return f"{FEATURE}:{session_id}"


def _messages(row: InsightSession) -> list[dict[str, Any]]:
    try:
        value = json.loads(row.messages or "[]")
    except ValueError:
        return []
    return [m for m in value if isinstance(m, dict)] if isinstance(value, list) else []


def _settings(row: InsightSession) -> dict[str, Any] | None:
    try:
        value = json.loads(row.model_settings) if row.model_settings else None
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def title_from(message: str) -> str:
    """A conversation's title from its first question, as the app makes it."""
    text = " ".join(message.strip().split("\n"))
    title = text[:TITLE_CHARS]
    return f"{title}..." if len(title) < len(text) else title


def _redact(text: str) -> str:
    from foundation.log_redaction import redact_text

    return redact_text(text)


def answer_from(lines: list[str]) -> dict[str, Any]:
    """The assistant message from the runner's output: its text, the task it
    suggests, the tools it used. Markers the app reads the same way
    (``main/insights/insights-executor.ts``)."""
    content: list[str] = []
    suggested: dict[str, Any] | None = None
    tools: list[dict[str, Any]] = []
    for line in lines:
        if line.startswith("__TASK_SUGGESTION__:"):
            try:
                value = json.loads(line.removeprefix("__TASK_SUGGESTION__:"))
            except ValueError:
                continue
            if isinstance(value, dict) and isinstance(value.get("title"), str):
                suggested = {
                    "title": _redact(value["title"])[:200],
                    "description": _redact(str(value.get("description") or ""))[
                        :20_000
                    ],
                    **(
                        {"metadata": value["metadata"]}
                        if isinstance(value.get("metadata"), dict)
                        else {}
                    ),
                }
        elif line.startswith("__TOOL_START__:"):
            try:
                value = json.loads(line.removeprefix("__TOOL_START__:"))
            except ValueError:
                continue
            if isinstance(value, dict) and isinstance(value.get("name"), str):
                tools.append(
                    {
                        "name": value["name"][:100],
                        "input": _redact(str(value.get("input") or ""))[:500],
                        "timestamp": _now().isoformat(),
                    }
                )
        elif line.startswith(("__TOOL_END__:", "__EXPLANATION__:")):
            continue
        elif line.strip():
            content.append(line)
    message: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "role": "assistant",
        "content": _redact("\n".join(content).strip())[:ANSWER_CHARS],
        "timestamp": _now().isoformat(),
    }
    if suggested:
        message["suggestedTask"] = suggested
    if tools:
        message["toolsUsed"] = tools[:200]
    return message


def history_for(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    """What the runner reads back: the conversation's turns, newest kept."""
    turns: list[dict[str, str]] = []
    total = 0
    for message in reversed(messages):
        role = message.get("role")
        content = message.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str):
            continue
        total += len(content)
        if total > HISTORY_CHARS:
            break
        turns.append({"role": role, "content": content})
    return list(reversed(turns))


async def _owners(db: AsyncSession, rows: list[InsightSession]) -> dict[str, str]:
    ids = {row.owner_id for row in rows if row.owner_id}
    if not ids:
        return {}
    users = await db.scalars(select(User).where(User.id.in_(ids)))
    return {user.id: user.display_name or user.email for user in users}


def _summary(
    row: InsightSession, owners: dict[str, str], principal: Principal
) -> dict[str, Any]:
    return {
        "id": row.id,
        "projectId": row.project_id,
        "title": row.title or "New Conversation",
        "messageCount": len(_messages(row)),
        "modelConfig": _settings(row),
        "createdAt": _iso(row.created_at),
        "updatedAt": _iso(row.updated_at),
        "ownerId": row.owner_id,
        "ownerName": owners.get(row.owner_id or ""),
        "mine": row.owner_id == principal.id,
    }


def _session(
    row: InsightSession, owners: dict[str, str], principal: Principal
) -> dict[str, Any]:
    running = get_project_jobs().running_job(row.project_id, _slot(row.id))
    return {
        **_summary(row, owners, principal),
        "messages": _messages(row),
        "jobId": running,
    }


async def _row(
    db: AsyncSession, scope: ProjectScope, session_id: str
) -> InsightSession:
    row = await db.get(InsightSession, session_id)
    if row is None or row.project_id != scope.project_id:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return row


def _require_owner(row: InsightSession, principal: Principal) -> None:
    if row.owner_id != principal.id:
        raise HTTPException(
            status_code=403, detail="Only its author can change this conversation"
        )


def _manages(scope: ProjectScope, principal: Principal) -> bool:
    """The project's owner, or an organization administrator who reaches it
    without a membership row: they answer for what the project keeps."""
    if scope.project_role is None:
        return principal.is_platform_admin or principal.has("project.member.write")
    return scope.project_role == "owner"


def _announce(project_id: str, session_id: str, by: str, deleted: bool = False) -> None:
    emit_board_event(
        project_id,
        "insights_updated",
        {"session_id": session_id, "by": by, "deleted": deleted},
    )


@router.get("/sessions")
async def list_sessions(
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    principal = get_principal(request)
    rows = list(
        await db.scalars(
            select(InsightSession)
            .where(InsightSession.project_id == scope.project_id)
            .order_by(InsightSession.updated_at.desc())
            .limit(500)
        )
    )
    owners = await _owners(db, rows)
    return [_summary(row, owners, principal) for row in rows]


@router.post("/sessions", status_code=201)
async def create_session(
    body: SessionCreate,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    principal = get_principal(request)
    _require_writer(scope, principal)
    now = _now()
    row = InsightSession(
        project_id=scope.project_id,
        owner_id=principal.id,
        title=(body.title or "").strip(),
        messages="[]",
        model_settings=body.modelConfig.model_dump_json() if body.modelConfig else None,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    _announce(scope.project_id, row.id, principal.id)
    return _session(row, await _owners(db, [row]), principal)


@router.get("/sessions/{session_id}")
async def get_session(
    session_id: str,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    row = await _row(db, scope, session_id)
    return _session(row, await _owners(db, [row]), get_principal(request))


@router.patch("/sessions/{session_id}")
async def update_session(
    session_id: str,
    body: SessionUpdate,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    principal = get_principal(request)
    _require_writer(scope, principal)
    row = await _row(db, scope, session_id)
    _require_owner(row, principal)
    if body.clear and get_project_jobs().running_job(scope.project_id, _slot(row.id)):
        raise HTTPException(status_code=409, detail="An answer is being written")
    if body.title is not None:
        row.title = body.title.strip()
    if body.modelConfig is not None:
        row.model_settings = body.modelConfig.model_dump_json()
    if body.clear:
        row.messages = "[]"
        row.title = ""
    row.updated_at = _now()
    await db.commit()
    _announce(scope.project_id, row.id, principal.id)
    return _session(row, await _owners(db, [row]), principal)


@router.delete("/sessions/{session_id}")
async def delete_session(
    session_id: str,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    principal = get_principal(request)
    _require_writer(scope, principal)
    row = await _row(db, scope, session_id)
    # Its author deletes it; so does the project's owner, who answers for
    # what the project keeps.
    if not _manages(scope, principal):
        _require_owner(row, principal)
    running = get_project_jobs().running_job(scope.project_id, _slot(row.id))
    if running:
        await get_project_jobs().cancel(running)
    await db.delete(row)
    await db.commit()
    _announce(scope.project_id, session_id, principal.id, deleted=True)
    return {"deleted": True}


async def _save_answer(
    project_id: str, session_id: str, by: str, status: str, lines: list[str]
) -> None:
    """Called when the job ends: the answer joins the conversation."""
    if status != "succeeded":
        return
    answer = answer_from(lines)
    async with get_session_factory()() as db:
        row = await db.get(InsightSession, session_id)
        if row is None:
            return  # deleted while it was answered
        messages = _messages(row)
        messages.append(answer)
        row.messages = json.dumps(messages[-MAX_MESSAGES:], ensure_ascii=False)
        row.updated_at = _now()
        await db.commit()
    _announce(project_id, session_id, by)


@router.post("/sessions/{session_id}/messages", status_code=202)
async def ask(
    session_id: str,
    body: Question,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    principal = get_principal(request)
    _require_writer(scope, principal)
    row = await _row(db, scope, session_id)
    _require_owner(row, principal)
    jobs = get_project_jobs()
    if jobs.running_job(scope.project_id, _slot(row.id)):
        raise HTTPException(status_code=409, detail="An answer is being written")

    before = _messages(row)
    message = {
        "id": str(uuid.uuid4()),
        "role": "user",
        "content": body.message,
        "timestamp": _now().isoformat(),
    }
    # The question included: the runner reads it as the last turn and leaves
    # it out of the context, as the app sends it.
    history = history_for([*before, message])
    row.messages = json.dumps([*before, message][-MAX_MESSAGES:], ensure_ascii=False)
    if not row.title:
        row.title = title_from(body.message)
    row.updated_at = _now()
    await db.commit()

    settings = _settings(row) or {}
    model = body.model or settings.get("model")
    thinking = body.thinking_level or settings.get("thinkingLevel")
    # One argument each, `--name=value`: a question that starts with a dash
    # stays the question.
    args = [f"--message={body.message}", "--history-file", f"{INPUT}history.json"]
    if isinstance(model, str) and model:
        args.append(f"--model={model}")
    if thinking in ("none", "low", "medium", "high", "ultrathink"):
        args.append(f"--thinking-level={thinking}")
    if body.learning_mode:
        args += ["--learning-mode", f"--explanation-level={body.explanation_level}"]
    try:
        job = await jobs.start(
            project_id=scope.project_id,
            org_id=scope.org_id,
            server_path=str(scope.path),
            feature=FEATURE,
            runner=RUNNER,
            args=args,
            user_id=principal.id,
            slot=_slot(row.id),
            project_flag="--project-dir",
            inputs={"history.json": json.dumps(history, ensure_ascii=False)},
            on_finish=partial(_save_answer, scope.project_id, row.id, principal.id),
        )
    except RunManagerError as e:
        # Not asked after all: the conversation is as it was.
        row.messages = json.dumps(before, ensure_ascii=False)
        await db.commit()
        raise HTTPException(status_code=409, detail=str(e)) from e
    row.job_id = job.id
    await db.commit()
    _announce(scope.project_id, row.id, principal.id)
    return {
        "job": job_public(job),
        "session": _session(row, await _owners(db, [row]), principal),
    }


async def _own_job(db: AsyncSession, scope: ProjectScope, job_id: str) -> ProjectJob:
    job = await db.get(ProjectJob, job_id)
    if job is None or job.project_id != scope.project_id or job.feature != FEATURE:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.get("/jobs/{job_id}")
async def get_job(
    job_id: str,
    after: int = Query(default=0, ge=0),
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    jobs = get_project_jobs()
    job = await _own_job(db, scope, job_id)
    if job.status in ("queued", "running") and not jobs.is_tracked(job.id):
        await jobs.settle_orphans(scope.project_id)
        await db.refresh(job)
    lines, following = jobs.output(job.id, after)
    return {
        **job_public(job),
        "lines": [_redact(line) for line in lines],
        "next": following,
    }


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(
    job_id: str,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    principal = get_principal(request)
    _require_writer(scope, principal)
    job = await _own_job(db, scope, job_id)
    if job.started_by != principal.id and not _manages(scope, principal):
        raise HTTPException(status_code=403, detail="Only who asked can stop it")
    return {"cancelled": await get_project_jobs().cancel(job.id)}
