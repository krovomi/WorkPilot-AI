"""Pydantic request/response schemas for the server-mode API."""

from __future__ import annotations

from datetime import datetime

from pydantic import (
    BaseModel,
    EmailStr,
    Field,
    computed_field,
    field_validator,
    model_validator,
)

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
    new_password: str = Field(min_length=12)


# ---------------------------------------------------------------------------
# Invitations (invitation-only self-service signup)
# ---------------------------------------------------------------------------


class CreateInvitationRequest(BaseModel):
    email: EmailStr
    role: str = "member"
    project_id: str | None = None
    project_role: str | None = None


class InvitationPublic(BaseModel):
    id: str
    email: str
    role: str
    project_id: str | None = None
    project_role: str | None = None
    expires_at: datetime
    created_at: datetime

    model_config = {"from_attributes": True}


class CreateInvitationResponse(InvitationPublic):
    # The acceptance link (carries the one-time token). Returned once, to the
    # admin, so it can be delivered manually if email is disabled or fails.
    invite_link: str
    email_sent: bool


class InvitationLookupRequest(BaseModel):
    # POST (not GET) so the token never lands in a URL / proxy access log.
    token: str = Field(min_length=16)


class InvitationLookupResponse(BaseModel):
    email: str
    role: str


class AcceptInvitationRequest(BaseModel):
    token: str = Field(min_length=16)
    display_name: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=12)


# ---------------------------------------------------------------------------
# Organizations / roles / permissions
# ---------------------------------------------------------------------------


class OrganizationPublic(BaseModel):
    id: str
    name: str
    slug: str
    is_active: bool
    created_at: datetime
    my_role: str | None = None

    model_config = {"from_attributes": True}


class CreateOrganizationRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    slug: str = Field(min_length=2, max_length=100, pattern=r"^[a-z0-9][a-z0-9-]*$")


class UpdateOrganizationRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    is_active: bool | None = None
    disabled_permissions: list[str] | None = None


class RolePublic(BaseModel):
    id: str
    org_id: str | None
    slug: str
    name: str
    description: str
    is_system: bool
    scope: str
    permissions: list[str]

    model_config = {"from_attributes": True}


class CreateRoleRequest(BaseModel):
    slug: str = Field(min_length=2, max_length=60, pattern=r"^[a-z0-9][a-z0-9-]*$")
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    scope: str = "org"
    permissions: list[str] = Field(default_factory=list)


class UpdateRoleRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = None
    permissions: list[str] | None = None


class PermissionPublic(BaseModel):
    key: str
    domain: str
    action: str
    labelKey: str
    descriptionKey: str
    privileged: bool


class MyPermissionsResponse(BaseModel):
    """What the caller may do right now, and where.

    The desktop app uses this to hide what would 403 anyway. It is a
    convenience, never the control: the backend re-checks every request.
    """

    user_id: str
    platform_role: str
    is_platform_admin: bool
    org_id: str | None
    org_role: str | None
    permissions: list[str]
    organizations: list[OrganizationPublic]


class SwitchOrgRequest(BaseModel):
    org_id: str


class OrgMemberPublic(BaseModel):
    user_id: str
    email: str
    display_name: str
    avatar_url: str | None = None
    role_id: str
    role_slug: str
    role_name: str
    is_active: bool
    created_at: datetime


class AddOrgMemberRequest(BaseModel):
    user_id: str
    role_slug: str = "contributor"


class UpdateOrgMemberRequest(BaseModel):
    role_slug: str


class QuotaPublic(BaseModel):
    org_id: str
    max_users: int | None = None
    max_projects: int | None = None
    max_concurrent_runs: int | None = None
    monthly_token_budget: int | None = None
    enforce_hard_stop: bool = False
    # Live counters, so the console can show "7 of 25 seats".
    used_users: int = 0
    used_projects: int = 0
    used_concurrent_runs: int = 0

    model_config = {"from_attributes": True}


class UpdateQuotaRequest(BaseModel):
    max_users: int | None = None
    max_projects: int | None = None
    max_concurrent_runs: int | None = None
    monthly_token_budget: int | None = None
    enforce_hard_stop: bool | None = None


class AuditEntryPublic(BaseModel):
    id: str
    user_id: str | None
    user_email: str | None = None
    org_id: str | None
    project_id: str | None
    action: str
    payload: dict | None
    ip: str | None
    created_at: datetime


class SessionPublic(BaseModel):
    id: str
    user_id: str
    user_email: str | None = None
    user_agent: str | None
    ip: str | None
    created_at: datetime
    expires_at: datetime


class AdminOverviewResponse(BaseModel):
    """The control dashboard's aggregate, for one organization."""

    org_id: str
    org_name: str
    users_total: int
    users_active: int
    projects_total: int
    specs_total: int
    runs_active: int
    runs_queued: int
    runs_24h: int
    runs_failed_24h: int
    run_success_rate_7d: float
    quota: QuotaPublic
    runs_by_day: list[dict]
    runs_by_status: dict[str, int]
    top_users: list[dict]
    recent_failures: list[dict]


# ---------------------------------------------------------------------------
# Projects / members
# ---------------------------------------------------------------------------


class CreateProjectRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    repo_url: str = Field(min_length=1, max_length=2000)
    default_branch: str = "main"


class ProjectPublic(BaseModel):
    id: str
    org_id: str | None = None
    name: str
    repo_url: str
    default_branch: str
    created_by: str | None
    created_at: datetime
    my_role: str | None = None

    model_config = {"from_attributes": True}

    @computed_field  # type: ignore[prop-decorator]
    @property
    def forge(self) -> str | None:
        """``github`` or ``gitlab`` when the app can show that forge's views."""
        from server.forges import forge_of

        return forge_of(self.repo_url)


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


class PullRequestOptions(BaseModel):
    """What the PR dialog lets a person edit before the server opens the PR.

    Sent only with ``phase="pr"``; each field becomes an argument of
    ``run.py --create-pr`` (the body through a file, never argv).
    """

    title: str | None = Field(default=None, min_length=1, max_length=256)
    body: str | None = Field(default=None, max_length=65_536)
    draft: bool = False
    target_branch: str | None = Field(
        default=None, max_length=255, pattern=r"^[A-Za-z0-9_][A-Za-z0-9._/-]*$"
    )
    # Create the PR although the cross review disagrees: the person's choice.
    ignore_cross_review: bool = False

    @field_validator("title")
    @classmethod
    def _one_line(cls, value: str | None) -> str | None:
        if value is not None and ("\n" in value or "\r" in value or "\0" in value):
            raise ValueError("the title must be one line")
        return value.strip() if value is not None else None


class StartRunRequest(BaseModel):
    phase: str = "build"  # spec / build / qa / merge / pr
    model: str | None = None
    pr: PullRequestOptions | None = None

    @model_validator(mode="after")
    def _pr_only_for_pr(self) -> StartRunRequest:
        if self.pr is not None and self.phase != "pr":
            raise ValueError("pr options go with phase 'pr' only")
        return self


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
    #: Checked by the route, not here: a validation error quotes the input,
    #: and this input is a token.
    value: str


class SecretKindsResponse(BaseModel):
    kinds: list[str]
