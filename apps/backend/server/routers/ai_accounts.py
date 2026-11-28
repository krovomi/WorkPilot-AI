"""A person's AI accounts: ``/users/me/ai-accounts``.

- ``GET``: the caller's accounts (never a key), the default of each provider
  and the providers the server knows (``settings.account.read``);
- ``POST``: save a new account; the first of its provider becomes its
  default (``settings.account.write``);
- ``PATCH /{account_id}``: rename it or replace its key;
- ``DELETE /{account_id}``: delete it; a deleted default leaves the provider
  on the deployment's own credentials;
- ``PUT /defaults/{provider}``: the account (or none) whose key the caller's
  runs get for that provider.

Each route acts on the caller's own accounts only: another person's id answers
404, as an id that does not exist. A key arrives once and never comes back.
Each change is written to the audit log, by account id and provider, never by
key. Design: ``docs/architecture/ai-accounts.md``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel, Field
from server.auth.deps import CurrentUser, get_current_user
from server.authz.deps import require_permission
from server.db.engine import get_db
from server.services import ai_accounts, audit
from server.services.ai_accounts import (
    MAX_KEY_LENGTH,
    MAX_NAME_LENGTH,
    AiAccountError,
    UnknownAccount,
)
from server.services.secrets import SecretsVaultError
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/users/me/ai-accounts", tags=["users"])

_READ = [Depends(require_permission("settings.account.read"))]
_WRITE = [Depends(require_permission("settings.account.write"))]

# Bounded before the store sees them, so a huge value is refused by the schema.
AccountId = Annotated[str, Path(min_length=1, max_length=36)]
ProviderName = Annotated[str, Path(min_length=1, max_length=32)]


class AccountCreate(BaseModel):
    provider: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH * 2)
    key: str = Field(min_length=1, max_length=MAX_KEY_LENGTH * 2)


class AccountUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=MAX_NAME_LENGTH * 2)
    key: str | None = Field(default=None, max_length=MAX_KEY_LENGTH * 2)


class DefaultChoice(BaseModel):
    account_id: str | None = Field(default=None, min_length=1, max_length=36)


class AccountPublic(BaseModel):
    id: str
    provider: str
    name: str
    is_default: bool
    has_key: bool
    created_at: datetime
    key_set_at: datetime


class AccountsPublic(BaseModel):
    accounts: list[AccountPublic]
    #: Provider → id of its default account.
    defaults: dict[str, str]
    #: The providers an account may be saved for.
    providers: list[str]


def _refused(error: Exception) -> HTTPException:
    if isinstance(error, UnknownAccount):
        return HTTPException(status_code=404, detail="Account not found")
    if isinstance(error, SecretsVaultError):
        # The vault's message names the missing setting, never a value.
        return HTTPException(status_code=500, detail=str(error))
    return HTTPException(status_code=400, detail=str(error))


async def _audit(
    db: AsyncSession, request: Request, user: CurrentUser, action: str, payload: dict
) -> None:
    await audit.record(
        db,
        action=f"ai_account.{action}",
        actor_id=user.id,
        org_id=getattr(request.state, "org_id", None),
        payload=payload,
        request=request,
        commit=True,
    )


@router.get("", response_model=AccountsPublic, dependencies=_READ)
async def my_accounts(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    accounts = await ai_accounts.list_accounts(db, user.id)
    return {
        "accounts": [a.payload() for a in accounts],
        "defaults": ai_accounts.defaults_of(accounts),
        "providers": list(ai_accounts.PROVIDERS),
    }


@router.post("", response_model=AccountPublic, status_code=201, dependencies=_WRITE)
async def add_account(
    body: AccountCreate,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        view = await ai_accounts.create_account(
            db, user.id, body.provider, body.name, body.key
        )
    except (AiAccountError, SecretsVaultError) as e:
        raise _refused(e) from None
    await _audit(
        db, request, user, "created", {"account_id": view.id, "provider": view.provider}
    )
    return view.payload()


@router.patch("/{account_id}", response_model=AccountPublic, dependencies=_WRITE)
async def change_account(
    body: AccountUpdate,
    request: Request,
    account_id: AccountId,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if body.name is None and body.key is None:
        raise HTTPException(status_code=400, detail="Nothing to change")
    try:
        view = await ai_accounts.update_account(
            db, user.id, account_id, name=body.name, key=body.key
        )
    except (AiAccountError, UnknownAccount, SecretsVaultError) as e:
        raise _refused(e) from None
    await _audit(
        db,
        request,
        user,
        "updated",
        {
            "account_id": view.id,
            "provider": view.provider,
            "key_replaced": body.key is not None,
        },
    )
    return view.payload()


@router.delete("/{account_id}", dependencies=_WRITE)
async def remove_account(
    request: Request,
    account_id: AccountId,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        view = await ai_accounts.delete_account(db, user.id, account_id)
    except UnknownAccount as e:
        raise _refused(e) from None
    await _audit(
        db, request, user, "deleted", {"account_id": view.id, "provider": view.provider}
    )
    return {"deleted": True, "was_default": view.is_default}


@router.put("/defaults/{provider}", dependencies=_WRITE)
async def choose_default(
    body: DefaultChoice,
    request: Request,
    provider: ProviderName,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        chosen = await ai_accounts.set_default(db, user.id, provider, body.account_id)
    except (AiAccountError, UnknownAccount) as e:
        raise _refused(e) from None
    clean = ai_accounts.clean_provider(provider)
    await _audit(
        db, request, user, "default", {"provider": clean, "account_id": chosen}
    )
    return {"provider": clean, "account_id": chosen}
