"""Who may open which streaming channel, in server mode.

The streaming WebSocket server (``streaming/websocket_server.py``) fans events
out by channel. In local mode there is one user and every channel is theirs.
On a shared server a channel belongs to a tenant, so a valid token is not
enough: the token has to be entitled to *that* channel, and what it may send
there depends on who it is.

Two channel families exist in server mode, and nothing else is opened:

- ``project:<project_id>``: the board of a project (specs, claims, runs).
  The API publishes there; members of the project read.
- ``run:<run_id>``: the live feed of one agent run. The run publishes there
  with the token its run manager minted for it, which names that run and
  nothing else; members of the run's project read.

A user reads a channel when they have a role on its project in the
organization they act in, exactly as the REST routes decide
(:func:`server.auth.deps.get_project_role`); a project of another tenant
answers like a missing one. A user may chat and pause on a channel when their
project role is ``member`` or higher. Only service tokens publish events.
"""

from __future__ import annotations

from dataclasses import dataclass

from server.auth.deps import _PROJECT_ROLE_RANK, CurrentUser, get_project_role
from server.db.models import AgentRun, GlobalRole, ProjectRole, SpecIndex, User
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

PROJECT_PREFIX = "project:"
RUN_PREFIX = "run:"

#: The API's own token, minted per board event (``server.services.events``).
SERVICE_API = "service:api"
#: The token a run manager mints for one run (``server.services.run_manager``).
SERVICE_AGENT = "service:agent"


@dataclass(frozen=True)
class ChannelGrant:
    """What a connection may do on the one channel it was authorized for."""

    channel: str
    can_publish: bool = False
    can_interact: bool = False


def project_channel(project_id: str) -> str:
    return f"{PROJECT_PREFIX}{project_id}"


def run_channel(run_id: str) -> str:
    return f"{RUN_PREFIX}{run_id}"


def _split(channel: str) -> tuple[str, str] | None:
    for prefix in (PROJECT_PREFIX, RUN_PREFIX):
        if channel.startswith(prefix):
            ident = channel[len(prefix) :]
            # Ids are uuids: anything with a separator or a second prefix is
            # not one of ours.
            if ident and ":" not in ident and "/" not in ident:
                return prefix, ident
    return None


async def _project_of_run(db: AsyncSession, run_id: str) -> str | None:
    return await db.scalar(
        select(SpecIndex.project_id)
        .join(AgentRun, AgentRun.spec_id == SpecIndex.id)
        .where(AgentRun.id == run_id)
    )


async def authorize_channel(
    db: AsyncSession,
    claims: dict,
    channel: str,
    *,
    org_hint: str | None = None,
) -> ChannelGrant | None:
    """The grant for this token on this channel, or ``None`` to refuse it.

    `claims` are already signature-checked (``decode_access_token``).
    `org_hint` is the organization the client says it acts in; it only counts
    when the user belongs to it, as for the ``X-WorkPilot-Org`` header.
    """
    parsed = _split(channel)
    if parsed is None:
        return None
    prefix, ident = parsed
    subject = str(claims.get("sub") or "")

    if subject == SERVICE_API:
        return ChannelGrant(channel, can_publish=True)
    if subject == SERVICE_AGENT:
        # A run's token names its run; it opens that run's channel only.
        if prefix == RUN_PREFIX and claims.get("run") == ident:
            return ChannelGrant(channel, can_publish=True)
        return None
    if subject.startswith("service:") or not subject:
        return None

    user_row = await db.get(User, subject)
    if user_row is None or not user_row.is_active:
        return None

    from server.authz.tenancy import resolve_org_id

    platform_role = claims.get("role", GlobalRole.MEMBER.value)
    org_id = await resolve_org_id(
        db,
        user_id=subject,
        platform_role=platform_role,
        header_value=org_hint,
        claim_value=claims.get("org"),
    )
    user = CurrentUser(
        id=subject,
        email=claims.get("email", ""),
        display_name=claims.get("name", ""),
        role=platform_role,
    )
    if org_id is None and not user.is_admin:
        return None

    project_id = ident if prefix == PROJECT_PREFIX else await _project_of_run(db, ident)
    if project_id is None:
        return None
    role = await get_project_role(db, user, project_id, org_id=org_id)
    if role is None:
        return None
    interact = (
        _PROJECT_ROLE_RANK.get(role, -1) >= _PROJECT_ROLE_RANK[ProjectRole.MEMBER.value]
    )
    return ChannelGrant(channel, can_interact=interact)
