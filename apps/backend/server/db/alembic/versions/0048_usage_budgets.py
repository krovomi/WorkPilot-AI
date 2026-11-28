"""Monthly token budgets per person, group or project, and their alerts.

Revision ID: 0048_usage_budgets
Revises: 0047_usage_report_sends
Create Date: 2026-11-28

Two new tables, nothing changed in the existing ones. Like ``0047``, each
step inspects first: revision ``0001`` runs ``create_all``, so a database
created by a newer build may already have them.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0048_usage_budgets"
down_revision = "0047_usage_report_sends"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if not _has_table("usage_budgets"):
        op.create_table(
            "usage_budgets",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("org_id", sa.String(length=36), nullable=False),
            sa.Column("scope", sa.String(length=10), nullable=False),
            sa.Column("target_id", sa.String(length=36), nullable=False),
            sa.Column("monthly_tokens", sa.BigInteger(), nullable=False),
            sa.Column("block", sa.Boolean(), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(
                ["org_id"], ["organizations.id"], ondelete="CASCADE"
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("org_id", "scope", "target_id", name="uq_usage_budget"),
        )
        op.create_index("ix_usage_budgets_org_id", "usage_budgets", ["org_id"])
    if not _has_table("usage_budget_alerts"):
        op.create_table(
            "usage_budget_alerts",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("org_id", sa.String(length=36), nullable=False),
            sa.Column("budget_key", sa.String(length=36), nullable=False),
            sa.Column("scope", sa.String(length=10), nullable=False),
            sa.Column("month", sa.Date(), nullable=False),
            sa.Column("threshold", sa.Integer(), nullable=False),
            sa.Column("percent", sa.Float(), nullable=False),
            sa.Column("recipients", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(
                ["org_id"], ["organizations.id"], ondelete="CASCADE"
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint(
                "org_id",
                "budget_key",
                "month",
                "threshold",
                name="uq_usage_budget_alert",
            ),
        )
        op.create_index(
            "ix_usage_budget_alerts_org_id", "usage_budget_alerts", ["org_id"]
        )


def downgrade() -> None:
    if _has_table("usage_budget_alerts"):
        op.drop_table("usage_budget_alerts")
    if _has_table("usage_budgets"):
        op.drop_table("usage_budgets")
