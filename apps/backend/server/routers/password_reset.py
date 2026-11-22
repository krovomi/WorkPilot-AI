"""Forgotten password: ask for a link, read it, set a new password.

Mounted under ``/auth/password-reset``; the three routes are public (listed
in ``PUBLIC_PATHS``) and rate-limited, as sign-in is. ``request`` always
answers 202 with the same body, whether or not the address has an account,
and the email leaves after the answer: neither the answer nor its timing
tells which addresses exist. A platform admin issues a link for an account
with ``POST /admin/users/{id}/password-reset`` (``routers/admin/users.py``).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from server.auth.local import LocalAuthError
from server.auth.password_reset import (
    PasswordResetError,
    build_reset_link,
    confirm_reset,
    lookup_reset,
    request_reset,
    ttl,
)
from server.config import get_settings
from server.db.engine import get_db
from server.ratelimit import limiter
from server.schemas import (
    PasswordResetConfirm,
    PasswordResetLookup,
    PasswordResetRequest,
)
from server.services.email import EmailError, send_password_reset_email
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth/password-reset", tags=["auth"])

#: The one answer of ``request``, whatever happened.
REQUESTED = {"requested": True}


def _ip(request: Request) -> str | None:
    return request.client.host if request.client else None


async def _send(to_email: str, link: str, minutes: int) -> None:
    try:
        await send_password_reset_email(to_email, link, minutes)
    except EmailError:
        # Logged by the sender, without the link; the answer was already given.
        pass


@router.post("/request", status_code=202)
@limiter.limit("5/minute")
async def request_password_reset(
    request: Request,
    body: PasswordResetRequest,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> dict:
    if not get_settings().email_enabled:
        # Nothing could reach the person: an administrator issues the link.
        return REQUESTED
    issued = await request_reset(db, str(body.email), ip=_ip(request))
    if issued is not None:
        minutes = int(ttl().total_seconds() // 60)
        background.add_task(
            _send, issued.user.email, build_reset_link(issued.token), minutes
        )
    return REQUESTED


@router.post("/lookup")
@limiter.limit("10/minute")
async def lookup_password_reset(
    request: Request,
    body: PasswordResetLookup,
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        email = await lookup_reset(db, body.token)
    except PasswordResetError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"email": email}


@router.post("/confirm")
@limiter.limit("5/minute")
async def confirm_password_reset(
    request: Request,
    body: PasswordResetConfirm,
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        await confirm_reset(db, body.token, body.new_password, ip=_ip(request))
    except PasswordResetError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except LocalAuthError as e:
        # The password policy: the link stays usable for another try.
        raise HTTPException(status_code=400, detail=str(e))
    return {"reset": True}
