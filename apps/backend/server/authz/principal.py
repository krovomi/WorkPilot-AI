"""The authenticated principal and its permission set.

One type covers both deployment modes, which is the point: authorization code
written once behaves correctly in local mode without a branch at every call
site.

* **Server mode** — the principal is built from ``request.state``, which the
  auth middleware has already populated from the verified access token. It
  carries the caller's effective permissions for the active organization,
  resolved once per request by :mod:`server.authz.engine`.
* **Local mode** — :data:`LOCAL_PRINCIPAL` is returned instead: a single
  implicit owner holding every permission. ``require_permission`` therefore
  passes unconditionally and the historical single-user behaviour is exact.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from fastapi import Request
from server.authz.catalog import ALL_PERMISSION_KEYS

LOCAL_USER_ID = "local"
LOCAL_ORG_ID = "local"


@dataclass(frozen=True, slots=True)
class Principal:
    """Who is calling, and what they may do."""

    id: str
    email: str = ""
    display_name: str = ""
    # Platform-level role, from ``users.role``. "admin" is the super-admin who
    # operates the deployment across tenants.
    platform_role: str = "member"
    org_id: str | None = None
    org_role_slug: str | None = None
    permissions: frozenset[str] = field(default_factory=frozenset)
    is_local: bool = False
    # Elevation granted by a recent step-up authentication, if any.
    elevated: bool = False
    # ``(project_id, approver_id)``: the approvals lent to this person now
    # (``server/authz/delegation.py``). Only the review routes honour them.
    delegations: tuple[tuple[str, str], ...] = ()

    @property
    def is_platform_admin(self) -> bool:
        return self.platform_role == "admin"

    def has(self, permission: str) -> bool:
        return self.is_local or self.is_platform_admin or permission in self.permissions

    def has_any(self, *permissions: str) -> bool:
        return any(self.has(p) for p in permissions)

    def has_all(self, *permissions: str) -> bool:
        return all(self.has(p) for p in permissions)

    def acting_for(self, project_id: str | None) -> str | None:
        """The approver whose approval this person holds on that project."""
        return next((by for pid, by in self.delegations if pid == project_id), None)

    def approval_slot(self, project_id: str | None) -> str | None:
        """Whose approval this person gives on that project: their own, the
        approver's they stand in for, or nobody's."""
        if self.has("review.approve"):
            return self.id
        return self.acting_for(project_id)


LOCAL_PRINCIPAL = Principal(
    id=LOCAL_USER_ID,
    email="",
    display_name="Local user",
    platform_role="admin",
    org_id=LOCAL_ORG_ID,
    org_role_slug="owner",
    permissions=frozenset(ALL_PERMISSION_KEYS),
    is_local=True,
    elevated=True,
)


def get_principal(request: Request) -> Principal:
    """The principal for this request.

    Reads what the auth middleware already resolved rather than re-decoding the
    access token, so a route guarded by several permissions does not pay for
    several signature verifications.

    Falls back to :data:`LOCAL_PRINCIPAL` **only** in local mode. In server mode
    an absent principal means the middleware did not run — a routing or
    ordering bug — and the one thing this must not do is treat that as the
    all-permissions local user. It raises instead, so the failure surfaces as a
    500 on one request rather than as a silently open deployment.
    """
    principal = getattr(request.state, "principal", None)
    if principal is not None:
        return principal

    from server.config import get_settings

    if get_settings().server_mode:
        raise RuntimeError(
            "No principal on the request in server mode: the auth middleware "
            "did not run for this route. Refusing to fall back to the local "
            "all-permissions principal."
        )
    return LOCAL_PRINCIPAL
