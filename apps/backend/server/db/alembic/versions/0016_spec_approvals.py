"""Spec approvals: a card's criticality, who approved it, and lent approvals.

Revision ID: 0016_spec_approvals
Revises: 0015_user_menu_layouts
Create Date: 2026-11-21

Three new tables, nothing changed in the existing ones: the criticality a
person gave a card, each approval of a card's spec (several people approve a
critical card), and an approver's right lent to a colleague for a while. Like
``0015``, each step inspects first: revision ``0001`` runs ``create_all``, so
a database created by a newer build may already have them.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0016_spec_approvals"
down_revision = "0015_user_menu_layouts"
branch_labels = None
depends_on = None

_TABLES = ("approval_delegations", "spec_approvals", "spec_criticality")


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if not _has_table("spec_criticality"):
        op.create_table(
            "spec_criticality",
            sa.Column("project_id", sa.String(length=36), nullable=False),
            sa.Column("spec_name", sa.String(length=300), nullable=False),
            sa.Column("criticality", sa.String(length=10), nullable=False),
            sa.Column("set_by", sa.String(length=36), nullable=True),
            sa.Column("set_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(
                ["project_id"], ["projects.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(["set_by"], ["users.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("project_id", "spec_name"),
        )
    if not _has_table("spec_approvals"):
        op.create_table(
            "spec_approvals",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("project_id", sa.String(length=36), nullable=False),
            sa.Column("spec_name", sa.String(length=300), nullable=False),
            sa.Column("content_hash", sa.String(length=64), nullable=False),
            sa.Column("user_id", sa.String(length=36), nullable=True),
            sa.Column("slot_id", sa.String(length=36), nullable=False),
            sa.Column("acting_for", sa.String(length=36), nullable=True),
            sa.Column("criticality", sa.String(length=10), nullable=False),
            sa.Column("roles", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(
                ["project_id"], ["projects.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint(
                "project_id",
                "spec_name",
                "content_hash",
                "slot_id",
                name="uq_spec_approval",
            ),
        )
        op.create_index(
            "ix_spec_approvals_card", "spec_approvals", ["project_id", "spec_name"]
        )
    if not _has_table("approval_delegations"):
        op.create_table(
            "approval_delegations",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("org_id", sa.String(length=36), nullable=False),
            sa.Column("project_id", sa.String(length=36), nullable=False),
            sa.Column("from_user_id", sa.String(length=36), nullable=False),
            sa.Column("to_user_id", sa.String(length=36), nullable=False),
            sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
            sa.ForeignKeyConstraint(
                ["org_id"], ["organizations.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(
                ["project_id"], ["projects.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(["from_user_id"], ["users.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["to_user_id"], ["users.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            "ix_delegations_to_user", "approval_delegations", ["to_user_id", "ends_at"]
        )
        op.create_index(
            "ix_approval_delegations_project_id", "approval_delegations", ["project_id"]
        )


def downgrade() -> None:
    for name in _TABLES:
        if _has_table(name):
            op.drop_table(name)
