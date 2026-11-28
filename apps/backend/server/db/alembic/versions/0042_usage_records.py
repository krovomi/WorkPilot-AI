"""Usage records: the tokens each session of a server run or job used.

Revision ID: 0042_usage_records
Revises: 0041_mcp_server_reviews
Create Date: 2026-11-22

One new table, nothing changed in the existing ones. Like ``0041``, the step
inspects first: revision ``0001`` runs ``create_all``, so a database created
by a newer build may already have it.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0042_usage_records"
down_revision = "0041_mcp_server_reviews"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if _has_table("usage_records"):
        return
    op.create_table(
        "usage_records",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("org_id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=True),
        sa.Column("user_id", sa.String(length=36), nullable=True),
        sa.Column("run_id", sa.String(length=36), nullable=True),
        sa.Column("job_id", sa.String(length=36), nullable=True),
        sa.Column("phase", sa.String(length=40), nullable=False),
        sa.Column("agent_type", sa.String(length=40), nullable=False),
        sa.Column("provider", sa.String(length=40), nullable=False),
        sa.Column("model", sa.String(length=120), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=False),
        sa.Column("output_tokens", sa.Integer(), nullable=False),
        sa.Column("cache_write_tokens", sa.Integer(), nullable=False),
        sa.Column("cache_read_tokens", sa.Integer(), nullable=False),
        sa.Column("cost_micro_usd", sa.Integer(), nullable=False),
        sa.Column("estimated", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["run_id"], ["agent_runs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["job_id"], ["project_jobs.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_usage_org_time", "usage_records", ["org_id", "created_at"])
    op.create_index("ix_usage_user_time", "usage_records", ["user_id", "created_at"])
    op.create_index("ix_usage_records_run_id", "usage_records", ["run_id"])
    op.create_index("ix_usage_records_job_id", "usage_records", ["job_id"])


def downgrade() -> None:
    if _has_table("usage_records"):
        for name in (
            "ix_usage_records_job_id",
            "ix_usage_records_run_id",
            "ix_usage_user_time",
            "ix_usage_org_time",
        ):
            op.drop_index(name, table_name="usage_records")
        op.drop_table("usage_records")
