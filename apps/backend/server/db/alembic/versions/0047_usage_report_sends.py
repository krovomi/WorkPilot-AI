"""Usage reports sent: one row per organization, kind and period.

Revision ID: 0047_usage_report_sends
Revises: 0046_page_visits
Create Date: 2026-11-27

One new table, nothing changed in the existing ones. Like ``0046``, the step
inspects first: revision ``0001`` runs ``create_all``, so a database created
by a newer build may already have it.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0047_usage_report_sends"
down_revision = "0046_page_visits"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if _has_table("usage_report_sends"):
        return
    op.create_table(
        "usage_report_sends",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("org_id", sa.String(length=36), nullable=False),
        sa.Column("kind", sa.String(length=10), nullable=False),
        sa.Column("period", sa.Date(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("recipients", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "kind", "period", name="uq_usage_report_send"),
    )


def downgrade() -> None:
    if _has_table("usage_report_sends"):
        op.drop_table("usage_report_sends")
