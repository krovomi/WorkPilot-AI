"""Needs-you channels: each person's own ntfy, Telegram or Teams.

Revision ID: 0010_needs_you_channels
Revises: 0009_user_preferences
Create Date: 2026-11-02

Two new tables, nothing changed in the existing ones. Like ``0005``, the step
inspects first: revision ``0001`` runs ``create_all``, so a database created
by a newer build may already have them.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0010_needs_you_channels"
down_revision = "0009_user_preferences"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if not _has_table("needs_you_channels"):
        op.create_table(
            "needs_you_channels",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("user_id", sa.String(length=36), nullable=False),
            sa.Column("channel", sa.String(length=20), nullable=False),
            sa.Column("enabled", sa.Boolean(), nullable=False),
            sa.Column("settings", sa.Text(), nullable=False),
            sa.Column("encrypted_secrets", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("user_id", "channel", name="uq_needs_you_channel"),
        )
        op.create_index(
            "ix_needs_you_channels_user_id", "needs_you_channels", ["user_id"]
        )
    if not _has_table("needs_you_preferences"):
        op.create_table(
            "needs_you_preferences",
            sa.Column("user_id", sa.String(length=36), nullable=False),
            sa.Column("muted_events", sa.Text(), nullable=False),
            sa.Column("locale", sa.String(length=8), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("user_id"),
        )


def downgrade() -> None:
    if _has_table("needs_you_preferences"):
        op.drop_table("needs_you_preferences")
    if _has_table("needs_you_channels"):
        op.drop_index("ix_needs_you_channels_user_id", table_name="needs_you_channels")
        op.drop_table("needs_you_channels")
