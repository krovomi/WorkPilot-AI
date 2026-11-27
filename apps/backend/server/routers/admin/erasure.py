"""Erase an account (platform administrators): ``POST /admin/users/{id}/erase``.

An account spans organizations, so only the deployment's administrators
erase one, and only by typing its address back (``confirm_email``): there is
no undo. What goes and what stays without a name: ``services/account_erasure``.
The audit keeps that an account was erased, by whom and when, never which.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from server.authz.deps import require_platform_admin
from server.authz.principal import Principal
from server.db.engine import get_db
from server.db.models import User
from server.services.account_erasure import erase
from server.services.audit import record
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/admin", tags=["admin:users"])


class EraseIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirm_email: str = Field(min_length=3, max_length=320)


@router.post("/users/{user_id}/erase")
async def erase_account(
    user_id: str,
    body: EraseIn,
    request: Request,
    actor: Principal = Depends(require_platform_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if user_id == actor.id:
        raise HTTPException(status_code=400, detail="You cannot erase your own account")
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if body.confirm_email.strip().lower() != user.email.lower():
        raise HTTPException(
            status_code=400, detail="The address does not match the account"
        )
    done = await erase(db, user)
    await record(
        db,
        action="user.erased",
        actor_id=actor.id,
        payload=done,
        request=request,
    )
    await db.commit()
    return {"erased": True, **done}
