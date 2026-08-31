"""Multi-tenancy: organizations, roles, per-org quotas.

Revision ID: 0003_multi_tenant
Revises: 0002_invitations
Create Date: 2026-08-31

Defensive by construction. Revision ``0001`` delegates to
``Base.metadata.create_all``, so a database upgraded through it may already
carry columns a later ORM change introduced — ``create_all`` adds whatever the
models declared at the time it ran. Every step here therefore inspects before
it acts, which also makes the revision safe to re-run after a partial failure.

Order matters: tables, then seed, then backfill, then constraints. Making
``projects.org_id`` NOT NULL before the backfill would fail on any deployment
that already has projects.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0003_multi_tenant"
down_revision = "0002_invitations"
branch_labels = None
depends_on = None


def _inspector():
    return sa.inspect(op.get_bind())


def _has_table(name: str) -> bool:
    return name in _inspector().get_table_names()


def _has_column(table: str, column: str) -> bool:
    if not _has_table(table):
        return False
    return column in {c["name"] for c in _inspector().get_columns(table)}


def _has_index(table: str, index: str) -> bool:
    if not _has_table(table):
        return False
    return index in {i["name"] for i in _inspector().get_indexes(table)}


def upgrade() -> None:
    # ---------------------------------------------------------------- tables
    if not _has_table("organizations"):
        op.create_table(
            "organizations",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("name", sa.String(length=200), nullable=False),
            sa.Column("slug", sa.String(length=100), nullable=False),
            sa.Column(
                "is_active", sa.Boolean(), nullable=False, server_default=sa.true()
            ),
            sa.Column("settings", sa.JSON(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("slug", name="uq_organizations_slug"),
        )
        op.create_index("ix_organizations_slug", "organizations", ["slug"])

    if not _has_table("roles"):
        op.create_table(
            "roles",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("org_id", sa.String(length=36), nullable=True),
            sa.Column("slug", sa.String(length=60), nullable=False),
            sa.Column("name", sa.String(length=120), nullable=False),
            sa.Column("description", sa.Text(), nullable=False, server_default=""),
            sa.Column(
                "is_system", sa.Boolean(), nullable=False, server_default=sa.false()
            ),
            sa.Column(
                "scope", sa.String(length=20), nullable=False, server_default="org"
            ),
            sa.Column("permissions", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(
                ["org_id"], ["organizations.id"], ondelete="CASCADE"
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("org_id", "slug", name="uq_role_org_slug"),
        )
        op.create_index("ix_roles_org", "roles", ["org_id"])

    if not _has_table("org_members"):
        op.create_table(
            "org_members",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("org_id", sa.String(length=36), nullable=False),
            sa.Column("user_id", sa.String(length=36), nullable=False),
            sa.Column("role_id", sa.String(length=36), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(
                ["org_id"], ["organizations.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["role_id"], ["roles.id"], ondelete="RESTRICT"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("org_id", "user_id", name="uq_org_member"),
        )
        op.create_index("ix_org_members_org_id", "org_members", ["org_id"])
        op.create_index("ix_org_members_user_id", "org_members", ["user_id"])

    if not _has_table("org_quotas"):
        op.create_table(
            "org_quotas",
            sa.Column("org_id", sa.String(length=36), nullable=False),
            sa.Column("max_users", sa.Integer(), nullable=True),
            sa.Column("max_projects", sa.Integer(), nullable=True),
            sa.Column("max_concurrent_runs", sa.Integer(), nullable=True),
            sa.Column("monthly_token_budget", sa.Integer(), nullable=True),
            sa.Column(
                "enforce_hard_stop",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(
                ["org_id"], ["organizations.id"], ondelete="CASCADE"
            ),
            sa.PrimaryKeyConstraint("org_id"),
        )

    # ------------------------------------------------------- new FK columns
    # Added nullable so the backfill below has something to fill.
    if not _has_column("projects", "org_id"):
        op.add_column(
            "projects", sa.Column("org_id", sa.String(length=36), nullable=True)
        )
    if not _has_index("projects", "ix_projects_org_id"):
        op.create_index("ix_projects_org_id", "projects", ["org_id"])

    if not _has_column("project_members", "role_id"):
        op.add_column(
            "project_members", sa.Column("role_id", sa.String(length=36), nullable=True)
        )

    if not _has_column("invitations", "org_id"):
        op.add_column(
            "invitations", sa.Column("org_id", sa.String(length=36), nullable=True)
        )
    if not _has_index("invitations", "ix_invitations_org_id"):
        op.create_index("ix_invitations_org_id", "invitations", ["org_id"])
    if not _has_column("invitations", "org_role_id"):
        op.add_column(
            "invitations", sa.Column("org_role_id", sa.String(length=36), nullable=True)
        )

    for column, type_ in (
        ("org_id", sa.String(length=36)),
        ("ip", sa.String(length=64)),
        ("user_agent", sa.String(length=400)),
    ):
        if not _has_column("audit_log", column):
            op.add_column("audit_log", sa.Column(column, type_, nullable=True))
    if not _has_index("audit_log", "ix_audit_org_time"):
        op.create_index("ix_audit_org_time", "audit_log", ["org_id", "created_at"])

    # ------------------------------------------------- seed, then backfill
    from server.db.seed import backfill_existing_deployment

    backfill_existing_deployment(op.get_bind())

    # --------------------------------------------------------- constraints
    # Only now can org_id be required. SQLite cannot ALTER a column in place,
    # so this goes through batch mode, which rebuilds the table.
    with op.batch_alter_table("projects") as batch:
        batch.alter_column(
            "org_id", existing_type=sa.String(length=36), nullable=False
        )


def downgrade() -> None:
    with op.batch_alter_table("projects") as batch:
        batch.alter_column("org_id", existing_type=sa.String(length=36), nullable=True)

    if _has_index("audit_log", "ix_audit_org_time"):
        op.drop_index("ix_audit_org_time", table_name="audit_log")
    for column in ("user_agent", "ip", "org_id"):
        if _has_column("audit_log", column):
            op.drop_column("audit_log", column)

    if _has_column("invitations", "org_role_id"):
        op.drop_column("invitations", "org_role_id")
    if _has_index("invitations", "ix_invitations_org_id"):
        op.drop_index("ix_invitations_org_id", table_name="invitations")
    if _has_column("invitations", "org_id"):
        op.drop_column("invitations", "org_id")

    if _has_column("project_members", "role_id"):
        op.drop_column("project_members", "role_id")

    if _has_index("projects", "ix_projects_org_id"):
        op.drop_index("ix_projects_org_id", table_name="projects")
    if _has_column("projects", "org_id"):
        op.drop_column("projects", "org_id")

    for table in ("org_quotas", "org_members", "roles", "organizations"):
        if _has_table(table):
            op.drop_table(table)
