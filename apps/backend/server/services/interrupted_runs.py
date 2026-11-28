"""The runs a server restart interrupted, offered to be resumed.

When the server stops while a card's agent is queued or running, the next
start settles that run as ``interrupted`` (``RunManager.settle_orphans``)
instead of failed. The desktop app in server mode and the phone app then ask
the person, as the desktop does after closing in the middle of a build
(``docs/architecture/pause-resume.md``), which of them to resume.

What is offered, and to whom:

- only a run of a phase that resumes where it stopped (``RESUMABLE_PHASES``):
  the spec is written again, a build re-enters its plan at the first subtask
  not done (``core.progress.reopen_interrupted_subtasks`` reopens the one the
  dead process was on), QA runs again. A merge, a pull request or a captures
  sync stopped half-way is for a person to look at, not to replay;
- only the card's latest run: a card started again since is not offered;
- only until someone answers: resumed or set aside (« Later »), the run
  records ``resume_answered_at`` and is not offered again; its card keeps its
  Start, which resumes the build the same way;
- to the person who started the run, and to an owner of its project (an
  administrator of the organization is one), who sees the project's.

Nothing here is new personal data: the run's row already says who started it
and when; this reads the card's own files for its title and progress.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from server.db.models import AgentRun, Project, ProjectRole, SpecIndex, User
from server.services.run_manager import INTERRUPTED_STATUS, SPEC_PHASE
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

#: Phases a resume re-enters where they stopped.
RESUMABLE_PHASES: tuple[str, ...] = (SPEC_PHASE, "build", "qa")

#: As many runs as a person is offered at once (the desktop dialog's own cap).
MAX_OFFERED = 200

MAX_TITLE = 200
MAX_SUBTASK = 300
_PLAN = "implementation_plan.json"
_SPECS = Path(".workpilot") / "specs"


@dataclass(frozen=True)
class CardProgress:
    """What a card's files say about where its work stopped."""

    title: str
    phase: str  # spec / planning / coding / qa_review
    subtasks_done: int
    subtasks_total: int
    next_subtask: str | None
    spec_missing: bool


def _json(path: Path) -> dict[str, Any]:
    try:
        with open(path, encoding="utf-8") as f:
            value = json.load(f)
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _clip(value: Any, limit: int) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def card_dir(root: Path, spec_name: str) -> Path:
    """The copy of the card a build writes: its workspace's when it has one.

    As the board reads it (``shared_board.listing.card_source``): while a
    build runs, its plan is written in the build workspace. A workspace copy
    that resolves outside the clone (a link planted on the way) is not read.
    """
    root = root.resolve()
    workspace = root / ".workpilot" / "worktrees" / "tasks" / spec_name
    copy = workspace / _SPECS / spec_name
    if copy.is_dir() and copy.resolve().is_relative_to(root):
        return copy
    return root / _SPECS / spec_name


def _subtasks(plan: dict[str, Any]) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for phase in plan.get("phases") or []:
        if not isinstance(phase, dict):
            continue
        for subtask in phase.get("subtasks", phase.get("chunks", [])) or []:
            if isinstance(subtask, dict):
                found.append(subtask)
    return found


def card_progress(root: Path, spec_name: str, run_phase: str) -> CardProgress:
    """Title and progress of a card, from its plan, for the run that stopped."""
    directory = card_dir(root, spec_name)
    plan = _json(directory / _PLAN)
    requirements = _json(directory / "requirements.json")
    title = _clip(
        plan.get("feature")
        or plan.get("title")
        or requirements.get("task_description")
        or spec_name,
        MAX_TITLE,
    )
    subtasks = _subtasks(plan)
    done = [s for s in subtasks if s.get("status") == "completed"]
    pending = [s for s in subtasks if s.get("status") != "completed"]
    if run_phase == SPEC_PHASE:
        phase = "spec"
    elif run_phase == "qa" or (subtasks and not pending):
        phase = "qa_review"
    elif subtasks:
        phase = "coding"
    else:
        phase = "planning"
    following = pending[0] if pending and phase == "coding" else None
    next_subtask = (
        _clip(following.get("title") or following.get("description"), MAX_SUBTASK)
        if following
        else None
    )
    return CardProgress(
        title=title,
        phase=phase,
        subtasks_done=len(done),
        subtasks_total=len(subtasks),
        next_subtask=next_subtask or None,
        spec_missing=not (root.resolve() / _SPECS / spec_name).is_dir(),
    )


def may_answer(run: AgentRun, user_id: str, project_role: str | None) -> bool:
    """Whether this person may resume this run, or set it aside."""
    return run.started_by == user_id or project_role == ProjectRole.OWNER.value


def _latest_runs():
    """Each card's latest run, by when it started."""
    return (
        select(AgentRun.spec_id, func.max(AgentRun.started_at).label("last"))
        .group_by(AgentRun.spec_id)
        .subquery()
    )


def _offered_query(project_ids: list[str]):
    latest = _latest_runs()
    return (
        select(AgentRun, SpecIndex, Project)
        .join(
            latest,
            (latest.c.spec_id == AgentRun.spec_id)
            & (latest.c.last == AgentRun.started_at),
        )
        .join(SpecIndex, SpecIndex.id == AgentRun.spec_id)
        .join(Project, Project.id == SpecIndex.project_id)
        .where(
            Project.id.in_(project_ids),
            AgentRun.status == INTERRUPTED_STATUS,
            AgentRun.resume_answered_at.is_(None),
            AgentRun.phase.in_(RESUMABLE_PHASES),
        )
        .order_by(AgentRun.finished_at.desc(), AgentRun.id)
        .limit(MAX_OFFERED)
    )


async def is_offered(db: AsyncSession, run: AgentRun) -> bool:
    """Whether this run still waits for an answer: interrupted, resumable,
    unanswered, and its card's latest run."""
    if (
        run.status != INTERRUPTED_STATUS
        or run.resume_answered_at is not None
        or run.phase not in RESUMABLE_PHASES
    ):
        return False
    newer = await db.scalar(
        select(func.count(AgentRun.id)).where(
            AgentRun.spec_id == run.spec_id,
            AgentRun.started_at > run.started_at,
        )
    )
    return not newer


async def offered_runs(
    db: AsyncSession, user_id: str, roles: dict[str, str | None]
) -> list[tuple[AgentRun, SpecIndex, Project]]:
    """The interrupted runs offered to this person, among the projects of
    ``roles`` (project id → their role on it), newest interruption first."""
    if not roles:
        return []
    rows = (await db.execute(_offered_query(list(roles)))).all()
    return [
        (run, spec, project)
        for run, spec, project in rows
        if may_answer(run, user_id, roles.get(project.id))
    ]


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.isoformat()


async def describe(
    db: AsyncSession, user_id: str, rows: list[tuple[AgentRun, SpecIndex, Project]]
) -> list[dict[str, Any]]:
    """Each offered run as the clients draw it (one row of the dialog)."""
    starters = {run.started_by for run, _, _ in rows if run.started_by}
    names: dict[str, str] = {}
    if starters - {user_id}:
        result = await db.execute(
            select(User.id, User.display_name).where(User.id.in_(starters))
        )
        names = {uid: name for uid, name in result.all()}
    offered: list[dict[str, Any]] = []
    for run, spec, project in rows:
        progress = card_progress(Path(project.server_path), spec.spec_name, run.phase)
        mine = run.started_by == user_id
        offered.append(
            {
                "run_id": run.id,
                "spec_id": spec.id,
                "card_id": spec.spec_name,
                "project_id": project.id,
                "project_name": project.name,
                "title": progress.title,
                "run_phase": run.phase,
                "phase": progress.phase,
                "subtasks_done": progress.subtasks_done,
                "subtasks_total": progress.subtasks_total,
                "next_subtask": progress.next_subtask,
                "model": run.model,
                "interrupted_at": _iso(run.finished_at or run.started_at),
                "mine": mine,
                # A teammate's run an owner sees: their name, as the board
                # shows who holds a card.
                "started_by_name": None
                if mine
                else names.get(run.started_by or "") or None,
                "blocker": "spec_missing" if progress.spec_missing else None,
            }
        )
    return offered


async def set_aside(
    db: AsyncSession,
    user_id: str,
    roles: dict[str, str | None],
    run_ids: list[str],
) -> list[str]:
    """« Later »: these runs are no longer offered. Only the runs this person
    is offered count; the ids set aside."""
    wanted = set(run_ids)
    now = datetime.now(UTC)
    done: list[str] = []
    for run, _, _ in await offered_runs(db, user_id, roles):
        if run.id in wanted:
            run.resume_answered_at = now
            done.append(run.id)
    if done:
        await db.commit()
    return done
