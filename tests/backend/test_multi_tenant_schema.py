"""The multi-tenant schema, its seed, and the upgrade path of a live deployment.

The interesting case is not a fresh database — it is an existing single-tenant
deployment with users and projects already in it. Nobody may lose access across
the upgrade, and no project may end up unattributed, because ``projects.org_id``
becomes NOT NULL at the end of the migration.
"""

from __future__ import annotations

import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import create_engine, insert, select, text

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server.authz.roles import SYSTEM_ROLE_SLUGS, system_role  # noqa: E402
from server.db import seed  # noqa: E402
from server.db.models import Base  # noqa: E402


def _now():
    return datetime.now(UTC)


@pytest.fixture()
def conn(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'schema.sqlite3'}")
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        yield connection
    engine.dispose()


@pytest.fixture()
def legacy_conn(tmp_path):
    """A database in the state revision 0003 actually finds.

    ``create_all`` builds today's schema, where ``projects.org_id`` is already
    NOT NULL — so it cannot represent a project that predates multi-tenancy,
    which is the only case the backfill exists for. The migration adds the
    column nullable, backfills, and tightens it last; this fixture reproduces
    that intermediate state so the backfill is exercised against real
    unattributed rows.
    """
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.sqlite3'}")
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(text("ALTER TABLE projects RENAME TO projects_new"))
        connection.execute(
            text(
                """
                CREATE TABLE projects (
                    id VARCHAR(36) NOT NULL PRIMARY KEY,
                    org_id VARCHAR(36),
                    name VARCHAR(200) NOT NULL,
                    repo_url VARCHAR(2000) NOT NULL,
                    default_branch VARCHAR(200) NOT NULL,
                    server_path VARCHAR(2000) NOT NULL,
                    created_by VARCHAR(36),
                    created_at DATETIME NOT NULL
                )
                """
            )
        )
        connection.execute(text("DROP TABLE projects_new"))
    with engine.begin() as connection:
        yield connection
    engine.dispose()


def _add_user(conn, email: str, role: str) -> str:
    users = seed._table(conn, "users")
    user_id = str(uuid.uuid4())
    conn.execute(
        insert(users).values(
            id=user_id,
            email=email,
            display_name=email.split("@")[0],
            role=role,
            is_active=True,
            created_at=_now(),
        )
    )
    return user_id


def _add_project(conn, name: str, org_id: str | None = None) -> str:
    projects = seed._table(conn, "projects")
    project_id = str(uuid.uuid4())
    conn.execute(
        insert(projects).values(
            id=project_id,
            org_id=org_id,
            name=name,
            repo_url=f"https://example.com/{name}.git",
            default_branch="main",
            server_path=f"/srv/repos/{project_id}",
            created_at=_now(),
        )
    )
    return project_id


class TestSeedSystemRoles:
    def test_seeds_every_built_in_role(self, conn):
        ids = seed.seed_system_roles(conn)
        assert set(ids) == SYSTEM_ROLE_SLUGS

        roles = seed._table(conn, "roles")
        rows = conn.execute(select(roles.c.slug, roles.c.is_system, roles.c.org_id))
        for row in rows:
            assert row.is_system
            assert row.org_id is None, "built-in roles are shared by every tenant"

    def test_is_idempotent(self, conn):
        first = seed.seed_system_roles(conn)
        second = seed.seed_system_roles(conn)
        assert first == second, "re-seeding must not duplicate or renumber roles"

        roles = seed._table(conn, "roles")
        count = conn.execute(
            select(roles.c.id).where(roles.c.org_id.is_(None))
        ).fetchall()
        assert len(count) == len(SYSTEM_ROLE_SLUGS)

    def test_refreshes_permissions_of_an_existing_role(self, conn):
        """An upgrade granting a new permission must reach existing tenants."""
        ids = seed.seed_system_roles(conn)
        roles = seed._table(conn, "roles")
        conn.execute(
            roles.update().where(roles.c.id == ids["viewer"]).values(permissions=[])
        )

        seed.seed_system_roles(conn)

        stored = conn.execute(
            select(roles.c.permissions).where(roles.c.id == ids["viewer"])
        ).scalar_one()
        assert set(stored) == set(system_role("viewer").permissions)

    def test_stored_permissions_are_valid_catalog_keys(self, conn):
        from server.authz.catalog import validate_keys

        seed.seed_system_roles(conn)
        roles = seed._table(conn, "roles")
        for row in conn.execute(select(roles.c.slug, roles.c.permissions)):
            validate_keys(row.permissions)  # raises if any key is unknown


class TestDefaultOrg:
    def test_creates_once(self, conn):
        first = seed.ensure_default_org(conn)
        second = seed.ensure_default_org(conn)
        assert first == second


class TestUpgradeOfAnExistingDeployment:
    def test_existing_users_become_members_with_mapped_roles(self, conn):
        admin = _add_user(conn, "admin@example.com", "admin")
        member = _add_user(conn, "dev@example.com", "member")
        viewer = _add_user(conn, "read@example.com", "viewer")

        org_id = seed.backfill_existing_deployment(conn)

        org_members = seed._table(conn, "org_members")
        roles = seed._table(conn, "roles")
        rows = conn.execute(
            select(org_members.c.user_id, roles.c.slug).join(
                roles, roles.c.id == org_members.c.role_id
            )
        ).all()
        mapping = {user_id: slug for user_id, slug in rows}

        assert mapping[admin] == "admin"
        assert mapping[member] == "contributor"
        assert mapping[viewer] == "viewer"
        assert all(m == org_id for m in [org_id])

    def test_existing_projects_are_attributed_to_the_default_org(self, legacy_conn):
        _add_user(legacy_conn, "dev@example.com", "member")
        p1 = _add_project(legacy_conn, "alpha")
        p2 = _add_project(legacy_conn, "beta")

        org_id = seed.backfill_existing_deployment(legacy_conn)

        projects = seed._table(legacy_conn, "projects")
        for project_id in (p1, p2):
            got = legacy_conn.execute(
                select(projects.c.org_id).where(projects.c.id == project_id)
            ).scalar_one()
            assert got == org_id

    def test_no_project_is_left_unattributed(self, legacy_conn):
        """``projects.org_id`` goes NOT NULL right after this runs."""
        _add_project(legacy_conn, "alpha")
        seed.backfill_existing_deployment(legacy_conn)

        orphans = legacy_conn.execute(
            text("SELECT COUNT(*) FROM projects WHERE org_id IS NULL")
        ).scalar_one()
        assert orphans == 0

    def test_users_role_is_untouched(self, conn):
        """``users.role`` is now the platform role; the upgrade must not rewrite it."""
        admin = _add_user(conn, "admin@example.com", "admin")
        seed.backfill_existing_deployment(conn)

        users = seed._table(conn, "users")
        role = conn.execute(
            select(users.c.role).where(users.c.id == admin)
        ).scalar_one()
        assert role == "admin"

    def test_is_idempotent(self, legacy_conn):
        _add_user(legacy_conn, "dev@example.com", "member")
        _add_project(legacy_conn, "alpha")

        first = seed.backfill_existing_deployment(legacy_conn)
        second = seed.backfill_existing_deployment(legacy_conn)
        assert first == second

        org_members = seed._table(legacy_conn, "org_members")
        rows = legacy_conn.execute(select(org_members.c.id)).fetchall()
        assert len(rows) == 1, "re-running must not duplicate memberships"

    def test_a_project_already_in_another_org_is_not_reassigned(self, legacy_conn):
        other = seed.ensure_default_org(legacy_conn, slug="other-tenant")
        kept = _add_project(legacy_conn, "theirs", org_id=other)

        seed.backfill_existing_deployment(legacy_conn)

        projects = seed._table(legacy_conn, "projects")
        got = legacy_conn.execute(
            select(projects.c.org_id).where(projects.c.id == kept)
        ).scalar_one()
        assert got == other
