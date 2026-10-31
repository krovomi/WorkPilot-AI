"""User groups: people grouped in an organization, with inherited roles.

Revision ID: 0004_user_groups
Revises: 0003_multi_tenant
Create Date: 2026-10-31

Three new tables, nothing changed in the existing ones. Like ``0003``, every
step inspects first: revision ``0001`` runs ``create_all``, so a database
created by a newer build may already have these tables.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0004_user_groups"
down_revision = "0003_multi_tenant"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if not _has_table("user_groups"):
        op.create_table(
            "user_groups",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("org_id", sa.String(length=36), nullable=False),
            sa.Column("name", sa.String(length=120), nullable=False),
            sa.Column("description", sa.Text(), nullable=False, server_default=""),
            sa.Column("role_id", sa.String(length=36), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(
                ["org_id"], ["organizations.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(["role_id"], ["roles.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("org_id", "name", name="uq_group_org_name"),
        )
        op.create_index("ix_user_groups_org_id", "user_groups", ["org_id"])

    if not _has_table("group_members"):
        op.create_table(
            "group_members",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("group_id", sa.String(length=36), nullable=False),
            sa.Column("user_id", sa.String(length=36), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(
                ["group_id"], ["user_groups.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("group_id", "user_id", name="uq_group_member"),
        )
        op.create_index("ix_group_members_group_id", "group_members", ["group_id"])
        op.create_index("ix_group_members_user_id", "group_members", ["user_id"])

    if not _has_table("project_groups"):
        op.create_table(
            "project_groups",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("project_id", sa.String(length=36), nullable=False),
            sa.Column("group_id", sa.String(length=36), nullable=False),
            sa.Column(
                "role", sa.String(length=20), nullable=False, server_default="member"
            ),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(
                ["project_id"], ["projects.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(
                ["group_id"], ["user_groups.id"], ondelete="CASCADE"
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("project_id", "group_id", name="uq_project_group"),
        )
        op.create_index(
            "ix_project_groups_project_id", "project_groups", ["project_id"]
        )
        op.create_index("ix_project_groups_group_id", "project_groups", ["group_id"])


def downgrade() -> None:
    for table in ("project_groups", "group_members", "user_groups"):
        if _has_table(table):
            op.drop_table(table)
