"""Writing administrative events to the audit log.

Distinct from ``audit_trail/`` on the filesystem, which is the tamper-evident
hash-chained record of *agent* activity. This one answers the other question —
who changed a role, revoked a session, deleted a project — and is scoped per
organization so a tenant admin reads their own history and nobody else's.

Every mutating admin endpoint calls :func:`record`. It never raises: an audit
write that fails must not roll back the action it describes, because losing the
action *and* the record is worse than losing the record.
"""

from __future__ import annotations

import logging

from fastapi import Request
from server.db.models import AuditLog
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


def client_meta(request: Request | None) -> tuple[str | None, str | None]:
    if request is None:
        return None, None
    ua = request.headers.get("user-agent")
    ip = request.client.host if request.client else None
    return (ua or None), (ip or None)


async def record(
    db: AsyncSession,
    *,
    action: str,
    actor_id: str | None,
    org_id: str | None = None,
    project_id: str | None = None,
    payload: dict | None = None,
    request: Request | None = None,
    commit: bool = False,
) -> None:
    """Append one administrative event.

    ``commit=False`` by default so the entry joins the caller's transaction and
    a rolled-back change leaves no record of having happened.
    """
    ua, ip = client_meta(request)
    try:
        db.add(
            AuditLog(
                user_id=actor_id,
                org_id=org_id,
                project_id=project_id,
                action=action,
                payload=payload,
                ip=(ip or "")[:64] or None,
                user_agent=(ua or "")[:400] or None,
            )
        )
        if commit:
            await db.commit()
    except Exception:
        logger.exception("Failed to write audit entry for action %s", action)
