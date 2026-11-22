"""Presence: the days each person used the server, per organization.

Revision ID: 0045_presence_days
Revises: 0044_password_resets
Create Date: 2026-11-22

One new table, nothing changed in the existing ones. Like ``0042``, the step
inspects first: revision ``0001`` runs ``create_all``, so a database created
by a newer build may already have it.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0045_presence_days"
down_revision = "0044_password_resets"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if _has_table("presence_days"):
        return
    op.create_table(
        "presence_days",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=True),
        sa.Column("org_id", sa.String(length=36), nullable=True),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id", "org_id", "day", name="uq_presence_user_org_day"
        ),
    )
    op.create_index("ix_presence_org_day", "presence_days", ["org_id", "day"])


def downgrade() -> None:
    if _has_table("presence_days"):
        op.drop_index("ix_presence_org_day", table_name="presence_days")
        op.drop_table("presence_days")
