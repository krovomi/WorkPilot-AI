"""Seeding the built-in roles and the default organization.

Written against a plain SQLAlchemy ``Connection`` rather than the async ORM
session, so the Alembic revision and the runtime bootstrap can share one
implementation. Both are idempotent: running them against an already-seeded
database updates the built-in roles' permission lists (an upgrade that adds a
permission to ``admin`` must reach existing tenants) and leaves everything else
alone.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import Connection, MetaData, Table, select
from sqlalchemy import insert as sa_insert
from sqlalchemy import update as sa_update

logger = logging.getLogger(__name__)

DEFAULT_ORG_SLUG = "default"
DEFAULT_ORG_NAME = "Default organization"


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


def backfill_existing_deployment(conn: Connection, slug: str = DEFAULT_ORG_SLUG) -> str:
    """Move a pre-multi-tenant deployment into one organization.

    Every existing user becomes a member of it, with the org role their old
    global role maps onto, and every existing project is attributed to it.
    Nobody loses access across the upgrade, and nothing is silently promoted:
    ``users.role`` keeps its value and now means the platform role.
    """
    from server.authz.roles import DEFAULT_ORG_ROLE, LEGACY_ROLE_MAP

    role_ids = seed_system_roles(conn)
    org_id = ensure_default_org(conn, slug)

    users = _table(conn, "users")
    org_members = _table(conn, "org_members")
    projects = _table(conn, "projects")

    already = {
        row.user_id
        for row in conn.execute(
            select(org_members.c.user_id).where(org_members.c.org_id == org_id)
        )
    }

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

    conn.execute(
        sa_update(projects)
        .where(projects.c.org_id.is_(None))
        .values(org_id=org_id)
    )

    return org_id
