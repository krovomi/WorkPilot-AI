"""Telling a project's maintainers that a rejection waits for them (#361).

On a server, a member's rejection of a review finding is held until a
maintainer approves or discards it (``forge_review_feedback``). The held list
is in the PR view's panel; a maintainer who does not open it would never
know. So when a rejection starts a project's wait (the held list was empty),
its maintainers hear of it on their own "needs you" channels
(``server.services.needs_you``, the moment ``review_feedback_held``): ntfy,
Telegram or Teams, each in their language, unless they muted it. One message
per wait, not one per rejection: the next comes once the list was cleared.

Who is a maintainer is the rule of ``is_maintainer``: whose role on the
project, their own or a group's, is owner; or, with no role on it, an
organization administrator (``project.member.write``). The person who
rejected is never told. What leaves is what every "needs you" message
carries: the project's name and the pull request's number, never the
finding, its note or who rejected it. Sending is off unless the operator
turned it on, runs in the background and never fails the verdict.
"""

from __future__ import annotations

import asyncio
import logging

import httpx
from server.authz.engine import resolve_permissions
from server.authz.groups import group_project_role, highest_role
from server.config import get_settings
from server.db.engine import get_session_factory
from server.db.models import OrgMember, Project, ProjectMember, ProjectRole, User
from server.services import needs_you
from server.services import needs_you_send as channels
from server.services.secrets import SecretsVaultError
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

EVENT = "review_feedback_held"
#: Members of an organization looked at, and maintainers told of one wait.
MAX_MEMBERS = 500
MAX_RECIPIENTS = 20

_background: set[asyncio.Task] = set()


async def maintainers(
    db: AsyncSession, project: Project, exclude: str | None = None
) -> list[str]:
    """The active maintainers of ``project``, by id, at most ``MAX_RECIPIENTS``."""
    members = await db.scalars(
        select(OrgMember.user_id)
        .where(OrgMember.org_id == project.org_id)
        .order_by(OrgMember.user_id)
        .limit(MAX_MEMBERS)
    )
    found: list[str] = []
    for user_id in members:
        person = await db.get(User, user_id)
        if user_id == exclude or person is None or not person.is_active:
            continue
        own = await db.scalar(
            select(ProjectMember.role).where(
                ProjectMember.project_id == project.id,
                ProjectMember.user_id == user_id,
            )
        )
        role = highest_role(own, await group_project_role(db, user_id, project.id))
        if role is None:
            permissions, _ = await resolve_permissions(
                db,
                user_id=user_id,
                platform_role=person.role,
                org_id=project.org_id,
                project_id=project.id,
            )
            maintains = "project.member.write" in permissions
        else:
            maintains = role == ProjectRole.OWNER.value
        if maintains:
            found.append(user_id)
            if len(found) >= MAX_RECIPIENTS:
                break
    return found


async def tell_maintainers(
    project_id: str,
    pr_number: int,
    rejecter: str | None,
    client: httpx.AsyncClient | None = None,
    resolver: channels.Resolver = channels.system_resolver,
) -> int:
    """Tell the project's maintainers a rejection waits; how many were told."""
    async with get_session_factory()() as db:
        project = await db.get(Project, project_id)
        if project is None:
            return 0
        people = await maintainers(db, project, exclude=rejecter)
        return await needs_you.notify_people(
            db, people, EVENT, project.name, str(pr_number), client, resolver
        )


def schedule(project_id: str, pr_number: int, rejecter: str | None) -> None:
    """:func:`tell_maintainers` in the background, if sending is on."""
    if not get_settings().needs_you_enabled:
        return

    async def run() -> None:
        try:
            await tell_maintainers(project_id, pr_number, rejecter)
        # Never fail a verdict over a notification. The type only: a message
        # could carry a destination.
        except (
            httpx.HTTPError,
            SQLAlchemyError,
            SecretsVaultError,
            ValueError,
            OSError,
        ) as error:
            logger.warning(
                "Held-rejection notification not sent: %s", type(error).__name__
            )

    task = asyncio.get_running_loop().create_task(run())
    _background.add(task)
    task.add_done_callback(_background.discard)
