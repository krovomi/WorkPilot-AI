"""Project jobs: a feature's runner launched on a project's clone.

Revision ID: 0005_project_jobs
Revises: 0004_user_groups
Create Date: 2026-10-31

One new table, nothing changed in the existing ones. Like ``0004``, the step
inspects first: revision ``0001`` runs ``create_all``, so a database created
by a newer build may already have it.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0005_project_jobs"
down_revision = "0004_user_groups"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if _has_table("project_jobs"):
        return
    op.create_table(
        "project_jobs",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("feature", sa.String(length=40), nullable=False),
        sa.Column("started_by", sa.String(length=36), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["started_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_project_jobs_project_id", "project_jobs", ["project_id"])


def downgrade() -> None:
    if _has_table("project_jobs"):
        op.drop_index("ix_project_jobs_project_id", table_name="project_jobs")
        op.drop_table("project_jobs")
