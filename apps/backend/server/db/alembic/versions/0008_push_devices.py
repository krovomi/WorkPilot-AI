"""Push devices: the phones that receive a person's notifications.

Revision ID: 0008_push_devices
Revises: 0007_deployment_markers
Create Date: 2026-11-01

One new table, nothing changed in the existing ones. Like ``0005``, the step
inspects first: revision ``0001`` runs ``create_all``, so a database created
by a newer build may already have it.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0008_push_devices"
down_revision = "0007_deployment_markers"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if _has_table("push_devices"):
        return
    op.create_table(
        "push_devices",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("token", sa.String(length=200), nullable=False),
        sa.Column("platform", sa.String(length=10), nullable=False),
        sa.Column("locale", sa.String(length=8), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token"),
    )
    op.create_index("ix_push_devices_user_id", "push_devices", ["user_id"])


def downgrade() -> None:
    if _has_table("push_devices"):
        op.drop_index("ix_push_devices_user_id", table_name="push_devices")
        op.drop_table("push_devices")
