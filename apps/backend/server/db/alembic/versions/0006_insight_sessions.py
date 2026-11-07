"""Insights sessions: one person's conversation on a server project.

Revision ID: 0006_insight_sessions
Revises: 0005_project_jobs
Create Date: 2026-10-31

One new table, nothing changed in the existing ones. Like ``0005``, the step
inspects first: revision ``0001`` runs ``create_all``, so a database created
by a newer build may already have it.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0006_insight_sessions"
down_revision = "0005_project_jobs"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if _has_table("insight_sessions"):
        return
    op.create_table(
        "insight_sessions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("owner_id", sa.String(length=36), nullable=True),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("messages", sa.Text(), nullable=False),
        sa.Column("model_settings", sa.Text(), nullable=True),
        sa.Column("job_id", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_insight_sessions_project_id", "insight_sessions", ["project_id"]
    )


def downgrade() -> None:
    if _has_table("insight_sessions"):
        op.drop_index("ix_insight_sessions_project_id", table_name="insight_sessions")
        op.drop_table("insight_sessions")
