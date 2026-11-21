"""A sign-in: its refresh session, its tokens and its line in the audit log.

Each sign-in gets an id (``jwt_tokens.new_login``) that every access token and
refresh session issued from it carries, and that every audit entry written
under it names (``services/audit.py``). Its own line is written in the
organization the tokens act in, so that organization's history
(``GET /admin/audit``) shows who signed in, how and from where, then what was
done in that session.
"""

from __future__ import annotations

from server.auth.jwt_tokens import TokenPair, issue_token_pair, new_login
from server.db.models import AuditLog, User
from sqlalchemy.ext.asyncio import AsyncSession


async def signed_in(
    db: AsyncSession,
    user: User,
    *,
    method: str,
    user_agent: str | None,
    ip: str | None,
) -> TokenPair:
    """Open a new sign-in by ``method`` (``jwt_tokens.LOGIN_METHODS``)."""
    login = new_login(method)
    pair = await issue_token_pair(db, user, user_agent=user_agent, ip=ip, login=login)
    db.add(
        AuditLog(
            user_id=user.id,
            org_id=pair.org_id,
            action=f"auth.login.{method}",
            ip=(ip or "")[:64] or None,
            user_agent=(user_agent or "")[:400] or None,
            login_id=login.id,
            login_method=method,
        )
    )
    await db.commit()
    return pair
