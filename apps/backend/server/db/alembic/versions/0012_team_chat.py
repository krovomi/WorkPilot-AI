"""Team chat: the messages of each server project's chat.

Revision ID: 0012_team_chat
Revises: 0011_needs_you_channels
Create Date: 2026-11-02

One new table, nothing changed in the existing ones. Like ``0005``, the step
inspects first: revision ``0001`` runs ``create_all``, so a database created
by a newer build may already have it.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0012_team_chat"
down_revision = "0011_needs_you_channels"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if _has_table("team_chat_messages"):
        return
    op.create_table(
        "team_chat_messages",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=True),
        sa.Column("author_name", sa.String(length=200), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("reply_to", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_team_chat_project_time",
        "team_chat_messages",
        ["project_id", "created_at"],
    )


def downgrade() -> None:
    if _has_table("team_chat_messages"):
        op.drop_index("ix_team_chat_project_time", table_name="team_chat_messages")
        op.drop_table("team_chat_messages")
