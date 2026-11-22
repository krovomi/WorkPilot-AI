"""Leaderboard consents: who agreed to show by name on Pixel Office's board.

Revision ID: 0023_leaderboard_consents
Revises: 0020_replay_share_bookmarks
Create Date: 2026-11-22

One new table, nothing changed in the existing ones. Like ``0015``, the step
inspects first: revision ``0001`` runs ``create_all``, so a database created
by a newer build may already have it.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0023_leaderboard_consents"
down_revision = "0020_replay_share_bookmarks"
branch_labels = None
depends_on = None

TABLE = "leaderboard_consents"


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if _has_table(TABLE):
        return
    op.create_table(
        TABLE,
        sa.Column("org_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("visible", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("org_id", "user_id"),
    )


def downgrade() -> None:
    if _has_table(TABLE):
        op.drop_table(TABLE)
