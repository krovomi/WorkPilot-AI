"""Approval escalations: cards whose plan waited too long for its approvals.

Revision ID: 0018_approval_escalations
Revises: 0017_replay_shares
Create Date: 2026-11-21

One new table, nothing changed in the existing ones. Like ``0017``, the step
inspects first: revision ``0001`` runs ``create_all``, so a database created
by a newer build may already have it.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0018_approval_escalations"
down_revision = "0017_replay_shares"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if _has_table("approval_escalations"):
        return
    op.create_table(
        "approval_escalations",
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("spec_name", sa.String(length=300), nullable=False),
        sa.Column("criticality", sa.String(length=10), nullable=False),
        sa.Column("notified", sa.Integer(), nullable=False),
        sa.Column("escalated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["run_id"], ["agent_runs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("run_id"),
    )
    op.create_index(
        "ix_approval_escalations_project_id",
        "approval_escalations",
        ["project_id"],
    )


def downgrade() -> None:
    if _has_table("approval_escalations"):
        op.drop_index(
            "ix_approval_escalations_project_id", table_name="approval_escalations"
        )
        op.drop_table("approval_escalations")
