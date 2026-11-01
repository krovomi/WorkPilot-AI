"""Seeding the built-in roles and the default organization.

Written against a plain SQLAlchemy ``Connection`` rather than the async ORM
session, so the Alembic revision and the runtime bootstrap can share one
implementation. Both are idempotent: running them against an already-seeded
database updates the built-in roles' permission lists (an upgrade that adds a
permission to ``admin`` must reach existing tenants) and leaves everything else
alone.

Moving the users of a single-tenant deployment into the default organization
is different: it is a one-time upgrade step, recorded in
``deployment_markers`` once taken. :func:`bootstrap_deployment`, which runs on
every start, skips it from then on, so a person who joins later belongs only to
the organizations they were added to.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import Connection, MetaData, Table, inspect, select
from sqlalchemy import insert as sa_insert
from sqlalchemy import update as sa_update

logger = logging.getLogger(__name__)

DEFAULT_ORG_SLUG = "default"
DEFAULT_ORG_NAME = "Default organization"

# The ``deployment_markers`` key recorded once the users of a single-tenant
# deployment have been moved into the default organization.
PRE_MULTI_TENANT_BACKFILL = "pre_multi_tenant_backfill"


def _now() -> datetime:
    return datetime.now(UTC)


def _table(conn: Connection, name: str) -> Table:
    meta = MetaData()
    return Table(name, meta, autoload_with=conn)


def seed_system_roles(conn: Connection) -> dict[str, str]:
    """Insert or refresh the built-in roles. Returns ``{slug: role_id}``."""
    from server.authz.roles import SYSTEM_ROLES

    roles = _table(conn, "roles")
    existing = {
        row.slug: row.id
        for row in conn.execute(
            select(roles.c.slug, roles.c.id).where(roles.c.org_id.is_(None))
        )
    }

    ids: dict[str, str] = {}
    for role in SYSTEM_ROLES:
        # A plain list: the column is ``sa.JSON``, which serializes for every
        # dialect. Encoding it here as well would store a JSON *string* inside
        # a JSON column, and it would read back as a string.
        permissions = sorted(role.permissions)
        if role.slug in existing:
            role_id = existing[role.slug]
            # Refresh: an upgrade that grants a new permission to a built-in
            # role must apply to tenants that already exist.
            conn.execute(
                sa_update(roles)
                .where(roles.c.id == role_id)
                .values(
                    name=role.name,
                    description=role.description,
                    scope=role.scope,
                    permissions=permissions,
                    is_system=True,
                )
            )
        else:
            role_id = str(uuid.uuid4())
            conn.execute(
                sa_insert(roles).values(
                    id=role_id,
                    org_id=None,
                    slug=role.slug,
                    name=role.name,
                    description=role.description,
                    is_system=True,
                    scope=role.scope,
                    permissions=permissions,
                    created_at=_now(),
                )
            )
        ids[role.slug] = role_id
    return ids


def ensure_default_org(conn: Connection, slug: str = DEFAULT_ORG_SLUG) -> str:
    """The organization an upgraded single-tenant deployment lands in."""
    orgs = _table(conn, "organizations")
    existing = conn.execute(
        select(orgs.c.id).where(orgs.c.slug == slug)
    ).scalar_one_or_none()
    if existing:
        return existing

    org_id = str(uuid.uuid4())
    conn.execute(
        sa_insert(orgs).values(
            id=org_id,
            name=DEFAULT_ORG_NAME,
            slug=slug,
            is_active=True,
            settings=None,
            created_at=_now(),
        )
    )
    return org_id


def has_marker(conn: Connection, key: str) -> bool:
    """Whether this deployment already took the one-time step ``key``."""
    if not inspect(conn).has_table("deployment_markers"):
        return False
    markers = _table(conn, "deployment_markers")
    found = conn.execute(
        select(markers.c.key).where(markers.c.key == key)
    ).scalar_one_or_none()
    return found is not None


def record_marker(conn: Connection, key: str) -> None:
    """Record the one-time step ``key``, if the table exists yet.

    Revision ``0003`` runs the backfill before revision ``0007`` creates the
    table on an upgraded database; ``0007`` records the marker itself then.
    """
    if not inspect(conn).has_table("deployment_markers") or has_marker(conn, key):
        return
    markers = _table(conn, "deployment_markers")
    conn.execute(sa_insert(markers).values(key=key, created_at=_now()))


def _attribute_unowned_projects(conn: Connection, org_id: str) -> None:
    projects = _table(conn, "projects")
    conn.execute(
        sa_update(projects).where(projects.c.org_id.is_(None)).values(org_id=org_id)
    )


def backfill_existing_deployment(conn: Connection, slug: str = DEFAULT_ORG_SLUG) -> str:
    """Move a pre-multi-tenant deployment into one organization.

    Every user who belongs to no organization yet becomes a member of it, with
    the org role their old global role maps onto, and every project without an
    organization is attributed to it. Nobody loses access across the upgrade,
    and nothing is silently promoted: ``users.role`` keeps its value and now
    means the platform role. A user who already belongs to an organization is
    left where they are.

    Records :data:`PRE_MULTI_TENANT_BACKFILL`, so that
    :func:`bootstrap_deployment` does not run it again.
    """
    from server.authz.roles import DEFAULT_ORG_ROLE, LEGACY_ROLE_MAP

    role_ids = seed_system_roles(conn)
    org_id = ensure_default_org(conn, slug)

    users = _table(conn, "users")
    org_members = _table(conn, "org_members")

    # Members of any organization, not only of this one.
    already = {row.user_id for row in conn.execute(select(org_members.c.user_id))}

    for row in conn.execute(select(users.c.id, users.c.role)):
        if row.id in already:
            continue
        slug_for_user = LEGACY_ROLE_MAP.get(row.role or "", DEFAULT_ORG_ROLE)
        conn.execute(
            sa_insert(org_members).values(
                id=str(uuid.uuid4()),
                org_id=org_id,
                user_id=row.id,
                role_id=role_ids[slug_for_user],
                created_at=_now(),
            )
        )

    _attribute_unowned_projects(conn, org_id)
    record_marker(conn, PRE_MULTI_TENANT_BACKFILL)

    return org_id


def bootstrap_deployment(conn: Connection, slug: str = DEFAULT_ORG_SLUG) -> str:
    """What every server start runs: roles, default org, the one-time backfill.

    The built-in roles are refreshed and the default organization ensured on
    every start. The user backfill runs only while
    :data:`PRE_MULTI_TENANT_BACKFILL` is not recorded: on a database that
    revision ``0003`` already upgraded, never; on a database ``create_all``
    just built, once. Projects without an organization are still attributed to
    the default one.
    """
    if not has_marker(conn, PRE_MULTI_TENANT_BACKFILL):
        return backfill_existing_deployment(conn, slug)

    seed_system_roles(conn)
    org_id = ensure_default_org(conn, slug)
    _attribute_unowned_projects(conn, org_id)
    return org_id
