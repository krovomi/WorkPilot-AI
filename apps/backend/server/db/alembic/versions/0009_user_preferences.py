"""User preferences: a person's interface theme, kept for every device.

Revision ID: 0009_user_preferences
Revises: 0008_push_devices
Create Date: 2026-11-01

One new table, nothing changed in the existing ones. Like ``0008``, the step
inspects first: revision ``0001`` runs ``create_all``, so a database created
by a newer build may already have it.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0009_user_preferences"
down_revision = "0008_push_devices"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if _has_table("user_preferences"):
        return
    op.create_table(
        "user_preferences",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("theme", sa.String(length=10), nullable=False),
        sa.Column("color_theme", sa.String(length=20), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )


def downgrade() -> None:
    if _has_table("user_preferences"):
        op.drop_table("user_preferences")
