"""Replay shares: a recorded agent session shared with a project's team.

Revision ID: 0017_replay_shares
Revises: 0016_spec_approvals
Create Date: 2026-11-21

One new table, nothing changed in the existing ones. Like ``0016``, the step
inspects first: revision ``0001`` runs ``create_all``, so a database created
by a newer build may already have it.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0017_replay_shares"
down_revision = "0016_spec_approvals"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if _has_table("replay_shares"):
        return
    op.create_table(
        "replay_shares",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("created_by", sa.String(length=36), nullable=True),
        sa.Column("created_by_name", sa.String(length=200), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("steps", sa.Integer(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("bundle", sa.LargeBinary(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("open_count", sa.Integer(), nullable=False),
        sa.Column("last_opened_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash"),
    )
    op.create_index(
        "ix_replay_shares_project", "replay_shares", ["project_id", "created_at"]
    )


def downgrade() -> None:
    if _has_table("replay_shares"):
        op.drop_index("ix_replay_shares_project", table_name="replay_shares")
        op.drop_table("replay_shares")
