"""Erase an account: the person goes, the organization's totals stay right.

Deleting the ``users`` row does most of it through the foreign keys: what is
only theirs goes with it (sign-ins, sessions, devices, secrets, preferences,
memberships: ``CASCADE``), and what the organization counts keeps its numbers
without a name (usage, presence, page counts, runs, jobs, cards, audit
entries: ``SET NULL``). Before that, :func:`erase` removes what would still
point back to the person:

- the address and browser of the audit entries they made;
- their id and address wherever an audit payload names them (another
  administrator's "added X to the group"), replaced by :data:`ERASED`;
- the invitations sent to their address.

Files a project's clone holds (cards, memories) are the team's work, not
usage data: they stay as they are.
"""

from __future__ import annotations

from server.db.models import AuditLog, Invitation, User
from sqlalchemy import String, cast, delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

ERASED = "erased"


def _scrub(value: object, marks: tuple[str, ...]) -> object:
    if isinstance(value, str):
        for mark in marks:
            if mark and mark.lower() in value.lower():
                return ERASED
        return value
    if isinstance(value, list):
        return [_scrub(v, marks) for v in value]
    if isinstance(value, dict):
        return {k: _scrub(v, marks) for k, v in value.items()}
    return value


async def erase(db: AsyncSession, user: User) -> dict[str, int]:
    """Erase ``user``; how many rows each step changed. The caller commits."""
    marks = (user.id, user.email)
    cleared = await db.execute(
        update(AuditLog)
        .where(AuditLog.user_id == user.id)
        .values(ip=None, user_agent=None)
    )
    text = func.lower(cast(AuditLog.payload, String))
    named = await db.scalars(
        select(AuditLog).where(
            AuditLog.payload.is_not(None),
            or_(*(text.contains(mark.lower()) for mark in marks)),
        )
    )
    scrubbed = 0
    for entry in named:
        clean = _scrub(entry.payload, marks)
        if clean != entry.payload:
            entry.payload = clean
            scrubbed += 1
    invitations = await db.execute(
        delete(Invitation).where(func.lower(Invitation.email) == user.email.lower())
    )
    await db.delete(user)
    await db.flush()
    return {
        "audit_entries_cleared": cleared.rowcount or 0,
        "audit_payloads_scrubbed": scrubbed,
        "invitations_deleted": invitations.rowcount or 0,
    }
