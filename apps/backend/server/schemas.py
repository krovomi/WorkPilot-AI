"""Pydantic request/response schemas for the server-mode API."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, EmailStr, Field

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class OidcExchangeRequest(BaseModel):
    id_token: str


class RefreshRequest(BaseModel):
    refresh_token: str


class LogoutRequest(BaseModel):
    refresh_token: str


class UserPublic(BaseModel):
    id: str
    email: str
    display_name: str
    avatar_url: str | None = None
    role: str

    model_config = {"from_attributes": True}


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserPublic


class CreateUserRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10)
    display_name: str = Field(min_length=1, max_length=200)
    role: str = "member"


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=10)


# ---------------------------------------------------------------------------
# Projects / members
# ---------------------------------------------------------------------------


class CreateProjectRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    repo_url: str = Field(min_length=1, max_length=2000)
    default_branch: str = "main"


class ProjectPublic(BaseModel):
    id: str
    name: str
    repo_url: str
    default_branch: str
    created_by: str | None
    created_at: datetime
    my_role: str | None = None

    model_config = {"from_attributes": True}


class AddMemberRequest(BaseModel):
    user_id: str
    role: str = "member"


class MemberPublic(BaseModel):
    user_id: str
    email: str
    display_name: str
    avatar_url: str | None = None
    role: str


# ---------------------------------------------------------------------------
# Specs / runs
# ---------------------------------------------------------------------------


class SpecPublic(BaseModel):
    id: str
    project_id: str
    spec_name: str
    status: str
    claimed_by: str | None
    claimed_by_name: str | None = None
    created_by: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ClaimRequest(BaseModel):
    # Force-release someone else's claim (owner/admin only).
    force: bool = False


class StartRunRequest(BaseModel):
    phase: str = "build"  # build / qa / merge
    model: str | None = None


class AgentRunPublic(BaseModel):
    id: str
    spec_id: str
    phase: str
    started_by: str | None
    provider: str | None
    model: str | None
    status: str
    started_at: datetime
    finished_at: datetime | None
    error: str | None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# User secrets
# ---------------------------------------------------------------------------


class SetSecretRequest(BaseModel):
    kind: str
    value: str = Field(min_length=1)


class SecretKindsResponse(BaseModel):
    kinds: list[str]
