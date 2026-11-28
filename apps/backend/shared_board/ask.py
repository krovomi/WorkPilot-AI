"""« Interroger le tableau » for a server project, asked from the phone app.

The desktop app answers a board question on the person's computer, the
server's cards included (lot 4b of ``docs/architecture/board-ask.md``). The
phone runs no model, so the server answers: a question starts a project job
running ``runners/board_ask_runner.py`` on the project's clone, with the
project's provider (``server.services.project_jobs``), and the answer is
read back from the job.

Asking reads the board, so it is the board's read right (``task.read``,
``ROUTE_OVERRIDES``): who may see the cards may ask about them. The answer
is the asker's own: the job's result is served to who started it only, and
kept in this process's memory for the most recent jobs, never written to
the database or the clone. One question at a time per person and project.

Every route takes a ``project_id``, never a path (``resolve_project_scope``).
The question and the conversation are the person's text; the runner quotes
them, with the tickets, as data in its prompts.
"""

from __future__ import annotations

import json
from collections import OrderedDict
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from server.authz.principal import get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from server.db.models import ProjectJob
from server.services.project_jobs import INPUT, get_project_jobs
from server.services.run_manager import RunManagerError
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/board/ask", tags=["board"])

FEATURE = "board_ask"
RUNNER = "board_ask_runner.py"
MARKER = "__BOARD_ASK__:"
#: Answers kept for their asker, the most recent ones.
KEPT_RESULTS = 100
MAX_QUESTION = 1000
MAX_TURN = 4000

_results: OrderedDict[str, dict[str, Any]] = OrderedDict()


class Turn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(max_length=MAX_TURN)
    answer: str = Field(max_length=MAX_TURN)


class Question(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1, max_length=MAX_QUESTION)
    language: str = Field(default="en", pattern=r"^[a-z]{2}$")
    history: list[Turn] = Field(default_factory=list, max_length=4)


def _slot(user_id: str) -> str:
    return f"{FEATURE}:{user_id}"


def result_from(lines: list[str]) -> dict[str, Any] | None:
    """The runner's answer, from its marker line; None when it printed none."""
    for line in reversed(lines):
        if not line.startswith(MARKER):
            continue
        try:
            value = json.loads(line.removeprefix(MARKER))
        except ValueError:
            return None
        return value if isinstance(value, dict) else None
    return None


async def _keep_result(job_id: str, status: str, lines: list[str]) -> None:
    """Called when the job ends: its answer is kept for the asker."""
    result = result_from(lines) if status == "succeeded" else None
    if result is None:
        return
    from foundation.log_redaction import redact_text

    # What the model wrote passes the same redaction as any job's output.
    _results[job_id] = json.loads(redact_text(json.dumps(result, ensure_ascii=False)))
    while len(_results) > KEPT_RESULTS:
        _results.popitem(last=False)


def _public(job: ProjectJob) -> dict[str, Any]:
    from shared_features.api import job_public

    return job_public(job)


@router.post("", status_code=202)
async def ask(
    body: Question,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    principal = get_principal(request)
    jobs = get_project_jobs()
    history = [turn.model_dump() for turn in body.history]
    # One argument each, `--name=value`: a question that starts with a dash
    # stays the question.
    args = [
        f"--question={body.question}",
        f"--language={body.language}",
        "--history-file",
        f"{INPUT}history.json",
    ]
    # The job's id is known once ``start`` returns, before the job can end:
    # it runs on the event loop, which this request holds until then.
    started: list[str] = []

    async def keep(status: str, lines: list[str]) -> None:
        await _keep_result(started[0], status, lines)

    try:
        job = await jobs.start(
            project_id=scope.project_id,
            org_id=scope.org_id,
            server_path=str(scope.path),
            feature=FEATURE,
            runner=RUNNER,
            args=args,
            user_id=principal.id,
            slot=_slot(principal.id),
            project_flag="--project-dir",
            inputs={"history.json": json.dumps(history, ensure_ascii=False)},
            on_finish=keep,
        )
    except RunManagerError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    started.append(job.id)
    return {"job": _public(job)}


async def _own_job(
    db: AsyncSession, scope: ProjectScope, job_id: str, user_id: str
) -> ProjectJob:
    job = await db.get(ProjectJob, job_id)
    if (
        job is None
        or job.project_id != scope.project_id
        or job.feature != FEATURE
        or job.started_by != user_id
    ):
        raise HTTPException(status_code=404, detail="Question not found")
    return job


@router.get("/jobs/{job_id}")
async def get_answer(
    job_id: str,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Where the question stands, and its answer once it has one."""
    principal = get_principal(request)
    jobs = get_project_jobs()
    job = await _own_job(db, scope, job_id, principal.id)
    if job.status in ("queued", "running") and not jobs.is_tracked(job.id):
        await jobs.settle_orphans(scope.project_id)
        await db.refresh(job)
    return {"job": _public(job), "result": _results.get(job.id)}


@router.post("/jobs/{job_id}/cancel")
async def cancel(
    job_id: str,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    principal = get_principal(request)
    job = await _own_job(db, scope, job_id, principal.id)
    return {"cancelled": await get_project_jobs().cancel(job.id)}
